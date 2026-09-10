# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**`AGENTS.md` holds the binding collaboration rules for this repo and takes precedence over this file — read it first.** `docs/codex-dev-log/YYYY-MM-DD-topic.md` records the decision and verification behind each change and is the best source of *why* a design looks the way it does.

## Commands

Node runs the `.ts` files directly (type stripping), so there is **no build step for development**. Imports carry `.ts` extensions on purpose.

```bash
pnpm install                          # pnpm 11.25.0, Node >= 24 (developed on v26)
cp .env.example .env                  # then fill AIPROXY_TOKEN and BCF_API_KEY

node my-first-harness.ts              # CLI, default model = farm (Bakery Farm Luna)
node my-first-harness.ts haiku        # or luna / farm — selects adapter + connection
node my-first-harness.ts haiku --tui  # Ink TUI; `pnpm tui` = farm + --tui

pnpm test                             # node --test tests/*.test.ts — mocks only, no network
node --test tests/permissions.test.ts # a single test file
pnpm exec tsc --noEmit                # typecheck all .ts (non-strict, tsconfig.json)
pnpm build                            # strict emit of the my-first-harness.ts graph into dist/
```

`pnpm test` never calls a real API. The `test:*` scripts do, cost money, and must be run deliberately:

```bash
pnpm test:prompts [haiku|luna|farm] [skill,background,plan,evidence,summary,opinion,repair] [before|after|both]
pnpm test:responses [--reasoning]     # Responses adapter against the live endpoint
pnpm test:anthropic [--mcp]           # Anthropic Messages adapter
pnpm test:farm                        # Bakery Farm SSE connection
pnpm test:mcp / test:playwright [--model farm|luna|haiku] / test:images [model]
pnpm test:history / test:package      # JSONL history, and packing + global install
```

Report mock-test results and real-API verification separately — passing `pnpm test` says nothing about a live model connection.

## Architecture

### Composition root

`my-first-harness.ts` is the only file that reads `process.argv`/`process.env`, picks a model adapter, builds the managers, and wires either `cli.ts` or `tui.ts`. Everything else receives its dependencies as arguments. `createAgent()` starts no terminal, no connection, and registers no tool of its own beyond `exit_plan_mode`.

### Provider abstraction

`llm-types.ts` defines the harness-internal message/request/result format. **Provider field names appear only inside `adapters/`.** Three adapters implement `LLMAdapter`: `responses.ts` (OpenAI Responses — both Farm Luna and AIProxy Luna), `chat-completions.ts`, `anthropic-messages.ts` (Haiku). `adapters/http.ts` performs the fetch and calls the observer hooks before interpreting anything. All three model connections (Farm, AIProxy Luna, Haiku) request `stream: true`: `sse.ts` does the API-agnostic framing (bytes → UTF-8 → `data:` lines → JSON events), then `responses-stream.ts` / `anthropic-stream.ts` rebuild the completed response object from the provider's own event names, so the adapters' post-processing is unchanged. Text chunks (`output_text.delta` / `text_delta`) go to the optional `LLMObserver.onTextDelta`, which `recordLLM` forwards only for `step` calls and the agent turns into `assistant-delta` events — tools, JSONL, and sessions still work from the completed response. The UI dedupes: the completed text is compared with what was streamed (`renderCliAnswer` / `showAnswer`). Chat Completions does not stream.

Prompt caching differs by provider. OpenAI-side prefix caching is automatic (Farm logs show ~69% cache reads with no code). Anthropic caches only with explicit `cache_control`: the adapter adds a marker on the single system block (covers tools + system), one on the first block of the first message (normally AGENTS.md, so the static prefix clears Haiku's 4,096-token minimum even with few tools and survives compaction), plus a top-level auto marker for the conversation tail — and only when the connection has `promptCache` **and** the request carries `LLMRequest.promptCache` — the agent sets that on `step` requests, never on one-shot compaction / other-llm calls (a write with no later read is a 1.25× surcharge). Haiku 4.5 silently ignores markers on prefixes under 4,096 tokens. Markers are added at send time and never stored in sessions or replay state.

`AssistantMessage.replayState` carries provider-native output items (e.g. Responses `reasoning.encrypted_content`) so the next request can re-send the original. It is reused only when adapter, provider, model, *and* a hash of the common content all match — otherwise the request is rebuilt from the common blocks.

`model-config.ts` maps a model name to `{adapter, baseURL, model, contextBudget, supportsImages}`. API protocol, model, and connected server are three separate things here; an OpenAI-compatible endpoint does not imply the same feature set.

### The agent loop

`agent.ts`. A **turn** is one user input; a **step** is one model call. `turn()` loops steps and dispatches on `stopReason`:

- `stop` → return the text, record `turn-end`.
- `tool-calls` → execute each call sequentially, append a tool result message per call, loop.
- `max-tokens` → the truncated response is logged but **not** added to the conversation; a Korean harness-feedback user message tells the model to split the work. Max 2 recoveries per turn.
- anything else → throw rather than treat as completion.

`assembleContext()` is the single place a request is built: system prompt + skill catalog + ToolSearch instructions + cwd + mode instructions, then `AGENTS.md` as a leading user message followed by the conversation (images projected), then the tool definitions visible to this session.

Interrupts use one `AbortController` per turn. On abort, **every unanswered tool call gets a synthetic error tool result** so the provider's tool-call protocol stays valid for the next user input.

### Context management

`context-manager.ts` + `token-budget.ts`, driven by the adapter's `contextBudget`. Before each step, if `estimateRequestTokens(request) >= compactionThreshold(budget)`:

1. Prune tool results over 8192 code points (keep first 4096 + last 1024).
2. Re-measure. Still over → compact: summarize the older span, keep the most recent `retainRatio` (16%) of the window verbatim, and cut **only at a boundary where every tool call has its result**.
3. Re-measure. Still over → throw, rather than summarize in a loop.

Compaction saves the session *before* summarizing so a failed summary API call still leaves a resumable snapshot, and refuses to apply a summary that grew rather than shrank or that raced with a new message.

### Two-tier persistence

Both live in `~/.my-first-harness/projects/<basename>-<sha256[0:12]>/` (per workspace path, see `harness-paths.ts`):

- `<session-id>.json` — the resumable `Session` snapshot (`version: 3`, strictly validated on load, no back-compat path).
- `<session-id>.jsonl` — append-only `ExecutionHistory`: every message, the real wire request/response bodies, tool start/end, turn boundaries, compaction snapshots. Known secrets and auth headers are redacted. In `model-request` bodies, image bytes are replaced by a `[image data omitted from log: <type>, <bytes>, sha256 …]` note (`adapters/wire-log.ts`), and `model-start` carries only a request summary (message count, image count, tool names, estimated tokens) — the bytes live once in the `message` event and in `attachments/<sha256>.<ext>`. **This log is evidence, never a state-restore mechanism.**

`recorded-llm.ts` wraps any adapter so ordinary steps, compaction summaries, and nested "ask another LLM" calls all record through one path, tagged by `HistoryScope` (`sessionId`/`turnId`/`step`/`parentToolCallId`).

### Tools, MCP, and progressive disclosure

`ToolManager` stores definitions plus execute functions, validates arguments with Ajv (draft-07 or 2020-12 depending on the schema's `$schema`), applies the permission gate, and converts failures into `{content, isError: true}` results instead of throwing — so the model sees and can react to its own mistakes.

Two things are deliberately *not* put in the context up front:

- **MCP tools** — only their names go into the system prompt. The model must call `ToolSearch` to load schemas, which appends to `session.discoveredTools` and makes them callable on the *next* request. `getModelDefinitions()` enforces this.
- **Skills** — only `{name, description, location}` from each `SKILL.md` frontmatter. The model must `readTextFile` the location to get the instructions. `skill-loader.ts` validates frontmatter and lets a project skill override or hide a same-named user skill.

### Extension lifecycle

`plugin-manager.ts` serializes enable/disable, gives each plugin an owner-scoped registrar (a plugin cannot claim another's tool name), and unwinds registrations plus cleanup on failure. `extension-runtime.ts` sits on top and joins the persisted `.my-first-harness/settings.json` toggles with actual runtime state — that split is why a failed MCP connection still appears in `/mcp` as "enabled but failed" and can be retried. `builtin-plugins.ts` wraps the `tools/` registrars (counter, time, other-llm, filesystem, shell) as toggleable plugins.

The counter's increment and read are two separate tools on purpose — it's an experiment in whether the model alternates calls. Don't merge them.

### Permissions and modes are orthogonal

- `AgentMode` (`plan` | `edit`, `agent-mode.ts`) swaps the mode instructions in the system prompt **and** layers deny rules onto the policy (plan denies `writeTextFile`/`editTextFile`).
- `PermissionMode` (`default` | `yolo`, `permissions.ts`) bypasses the gate entirely when `yolo`.
- `PermissionPolicy` rules match an exact `toolName` or an `ownerPrefix`, evaluated deny → ask → allow. `INTERACTIVE_PERMISSIONS` asks for `runCommand` and every `mcp:*` tool.
- Both can change while a turn is `active` (TUI: Shift+Tab works during execution and approval prompts). `PermissionMode` applies from the next tool call because the policy is computed per call; an approval prompt already open is never auto-answered. `AgentMode` is queued (`getPendingMode()`) and applied at the start of the next step, with a `[하네스 알림]` user message telling the model why, or at turn end if no step follows — the same boundary rule as plan approval. Re-selecting the current mode cancels the queue.
- `exit_plan_mode` is registered by the agent itself. Approval sets `pendingPlanExit`; the mode actually flips at the **start of the next step**, never mid tool batch — approving one tool call is not plan approval.

### UI layer

The core is UI-agnostic: it emits `AgentEvent`s and calls the injected `requestApproval` / `requestPlanReview`. `cli.ts` implements both over readline; `tui-session.ts` (all state and slash-command handling, `TUI_COMMANDS` is the source of truth) plus `tui.ts` / `tui-input.ts` implement them with Ink/React. Slash commands are handled in the UI layer, never in the agent.

## Conventions worth matching

- Error messages handed back to the model are Korean strings that tell it **what to do next** ("파일을 다시 읽어 확인하세요", "같은 요청을 임의로 우회하지 마세요"), not bare diagnostics. Keep that shape.
- Harness-injected conversation messages are labelled so the model can tell them from real user input (`[하네스 실행 피드백 ...]`, `[하네스 알림]`, `[프로젝트 지침 · AGENTS.md]`).
- `prompts.ts` holds every system prompt in one file so candidates can be compared; `tests/prompt-eval.ts` diffs a before/after fixture against a live model per probe.
- Don't force a tool order or a per-task procedure into the code. Letting the model choose tools, iterate, and report is the point of the experiment.
