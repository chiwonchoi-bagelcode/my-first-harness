import { randomUUID } from "node:crypto";
import { summarize } from "./llm.ts";
import { recordLLM } from "./recorded-llm.ts";
import { textOf } from "./llm-types.ts";
import { checkImageInput } from "./image-content.ts";
import { archiveImages, projectRequestImages } from "./image-request.ts";
import { saveSession as persistSession } from "./session-store.ts";
import { compactSession, contextSize, pruneToolResults, recordMessage, shouldCompact } from "./context-manager.ts";
import { DEFAULT_CONTEXT_BUDGET, compactionThreshold, estimateRequestTokens, retentionTokens } from "./token-budget.ts";
import type { HistoryScope, HistorySink } from "./execution-history.ts";
import type { ImageBlock, LLMAdapter, LLMRequest, Message } from "./llm-types.ts";
import type { HarnessPaths } from "./harness-paths.ts";
import type { Session } from "./session.ts";
import type { ToolManager } from "./tool-manager.ts";
import type { SkillManager } from "./skill-manager.ts";
import type { PermissionPolicy, RequestApproval } from "./permissions.ts";
import { ALLOW_ALL, createSessionApprover, parsePermissionMode } from "./permissions.ts";
import type { PermissionMode } from "./permissions.ts";
import { modeInstructions, modePermissions, parseMode } from "./agent-mode.ts";
import type { AgentMode } from "./agent-mode.ts";
import { reviewPlan } from "./plan-review.ts";
import type { RequestPlanReview } from "./plan-review.ts";

// 화면에 표시할 진행 정보다. 원문 보존용 HistoryEvent와는 별개다.
export type AgentEvent =
  | { type: "mode-changed"; mode: AgentMode; reason: "plan-approved" | "user" }
  | { type: "assistant-text"; text: string }
  | { type: "tool-start"; name: string; arguments: string }
  | { type: "tool-end"; name: string; durationMs: number; content: import("./llm-types.ts").ToolContent; isError?: boolean }
  | { type: "turn-interrupt-requested" }
  | { type: "turn-interrupted" }
  | { type: "compaction-start" }
  | { type: "compaction-end"; beforeChars: number; afterChars: number }
  | { type: "compaction-empty" }
  | { type: "output-limit-recovery"; attempt: number; maxAttempts: number }
  | { type: "tool-results-pruned"; count: number; beforeChars: number; afterChars: number };

// 실행에 필요한 객체를 외부에서 받는다. 화면 알림은 동기 콜백이며 생략하면 출력하지 않는다.
export type AgentOptions = {
  adapter: LLMAdapter;
  toolManager: ToolManager;
  skillManager: SkillManager;
  history: HistorySink;
  paths: HarnessPaths;
  onEvent?: (event: AgentEvent) => void;
  saveSession?: typeof persistSession;
  permissions?: PermissionPolicy;
  requestApproval?: RequestApproval;
  requestPlanReview?: RequestPlanReview;
};

// CLI·TUI·웹에서 호출할 실행 API다. 같은 세션의 호출은 순서대로 기다려야 한다.
export interface Agent {
  // 현재 권한 우회 여부를 UI에 제공한다.
  getPermissionMode(): PermissionMode;
  // 권한 우회 설정을 즉시 변경한다. 턴 중이면 다음 툴 호출부터 적용되며 이미 열린 승인 질문은 그대로 남는다.
  setPermissionMode(mode: PermissionMode): void;
  // 현재 앱의 작업 모드를 조회한다.
  getMode(): AgentMode;
  // 턴 중에 요청돼 다음 스텝을 기다리는 모드다. 없으면 undefined.
  getPendingMode(): AgentMode | undefined;
  // 지침과 실행 정책에 사용할 모드를 바꾼다. 턴 중이면 다음 스텝 시작에 반영하고 queued를 돌려준다.
  setMode(mode: AgentMode): "applied" | "queued";
  // 실행 중인 턴에 중단을 요청한다. true는 요청 접수이며 완료는 이벤트로 알린다.
  interrupt(): boolean;
  // 사용자 입력 한 번에 대한 모델·툴 반복을 실행하고 최종 텍스트를 반환한다.
  turn(session: Session, input: string, images?: ImageBlock[]): Promise<string>;
  // 현재 대화를 요약하고 전후 스냅샷과 실행 기록을 저장한다.
  compact(session: Session): Promise<void>;
}

// 터미널·모델 연결·툴 등록을 시작하지 않고 전달받은 구성으로 실행 함수를 만든다.
export function createAgent(options: AgentOptions): Agent {
  const { adapter, toolManager, skillManager, history, paths, onEvent, saveSession = persistSession } = options;
  const budget = adapter.contextBudget ?? DEFAULT_CONTEXT_BUDGET;
  compactionThreshold(budget);
  let active: AbortController | undefined;
  let mode: AgentMode = "edit";
  let pendingMode: AgentMode | undefined;
  let pendingPlanExit = false;
  let permissionMode: PermissionMode = "default";
  const approveForSession = createSessionApprover(options.requestApproval);

  // 권한은 툴 호출마다 그 순간의 값으로 계산하므로 턴 중 변경도 다음 툴 호출부터 적용된다. 이미 기다리는 승인 질문은 자동 통과시키지 않는다.
  function setPermissionMode(next: PermissionMode) {
    permissionMode = parsePermissionMode(next);
  }

  // 모드가 실제로 바뀔 때만 상태를 갱신한다. 코어가 스스로 반영한 경우(계획 승인, 대기 모드 적용)에만 화면에 알리고, UI의 직접 호출은 호출자가 이미 알고 있으므로 알리지 않는다.
  function applyMode(next: AgentMode, reason: "plan-approved" | "user", notify = true) {
    if (next === mode) return false;
    mode = next;
    if (notify) onEvent?.({ type: "mode-changed", mode, reason });
    return true;
  }

  // DSH처럼 계획 전문을 툴 인자로 받아 검토하며 모드 전환은 다음 스텝까지 미룬다.
  toolManager.register({
    name: "exit_plan_mode",
    description: "Use only in plan mode. Present your plan for the user's review and, on approval, leave plan mode. Send the COMPLETE plan as markdown, starting with a # heading that names it. The user may approve (carry out the plan from your next step) or keep planning — their feedback comes back in the tool result; revise and present again.",
    parameters: { type: "object", properties: { plan: { type: "string", pattern: "^\\s*#\\s+\\S", description: "The complete plan, as markdown, starting with a # heading that names it." } }, required: ["plan"], additionalProperties: false },
    // 승인은 같은 배치의 후속 툴 권한을 바꾸지 않고 다음 모델 호출에만 반영한다.
    async execute({ plan }: { plan: string }, context) {
      if (mode !== "plan") throw new Error("exit_plan_mode is only available in plan mode.");
      if (pendingPlanExit) throw new Error("이미 승인된 계획이 있습니다. 다음 스텝에서 실행하세요.");
      const answer = await reviewPlan(plan, options.requestPlanReview, context?.signal);
      context?.signal?.throwIfAborted();
      if (answer.decision === "cancel") {
        interrupt();
        throw new Error("사용자가 계획 검토를 닫았습니다. plan을 유지하고 다음 메시지를 기다리세요.");
      }
      if (answer.decision !== "approve") {
        throw new Error("The user chose to keep planning; revise the plan and present it again. Feedback: " + answer.feedback);
      }
      pendingPlanExit = true;
      return JSON.stringify({ approved: true, instruction: "Plan approved — carry out the plan starting with your next step. Tool permissions still apply." });
    },
  }, { owner: "harness:plan" });

  // 턴 중에는 요청 경계인 다음 스텝 시작까지 미룬다. 실행 중인 툴 배치의 지침·권한은 그대로 두고, 같은 모드를 다시 고르면 대기를 취소한다.
  function setMode(next: AgentMode): "applied" | "queued" {
    const target = parseMode(next);
    if (!active) {
      pendingMode = undefined;
      applyMode(target, "user", false);
      return "applied";
    }
    pendingMode = target === mode ? undefined : target;
    return pendingMode === undefined ? "applied" : "queued";
  }

  // 화면과 무관하게 현재 턴의 취소 신호를 발생시키며 중복 요청은 무시한다.
  function interrupt() {
    if (!active || active.signal.aborted) return false;
    active.abort(new Error("사용자가 턴 중단을 요청했습니다."));
    onEvent?.({ type: "turn-interrupt-requested" });
    return true;
  }

  // 시스템 지침·스킬·작업 폴더와 현재 대화·툴 정의를 공통 요청으로 조립한다.
  async function assembleContext(session: Session): Promise<LLMRequest> {
    return {
      system: [
        session.system,
        ...skillManager.getInstructions(),
        toolManager.getSearchInstructions(),
        `현재 작업 디렉토리: ${paths.workspaceDirectory}`,
        modeInstructions(mode),
      ].join("\n\n"),
      messages: [
        ...(session.projectInstructions ? [{ role: "user" as const, content: [{ type: "text" as const,
          text: `[프로젝트 지침 · AGENTS.md]\n${session.projectInstructions}` }] }] : []),
        ...await projectRequestImages(session.messages, { protectRecent: true }),
      ],
      tools: toolManager.getModelDefinitions(session.discoveredTools),
    };
  }

  // 요약 실패에 대비해 세션을 먼저 저장하고 압축 성공 후 다시 저장한다.
  async function compactAndSave(session: Session, scope: HistoryScope = { sessionId: session.id }) {
    // 요약 API가 실패해도 요약 직전 messages로 resume할 수 있게 먼저 저장한다.
    await saveSession(session, paths);
    const before = contextSize(session);
    onEvent?.({ type: "compaction-start" });
    const compacted = await compactSession(session, (conversation) =>
      summarize(recordLLM(adapter, history, scope, "compaction", active?.signal), conversation), retentionTokens(budget),
    );
    if (compacted) {
      await history.append(scope, { type: "context-update", reason: "compact", beforeChars: before,
        afterChars: contextSize(session), messages: session.messages });
      await saveSession(session, paths);
      onEvent?.({ type: "compaction-end", beforeChars: before, afterChars: contextSize(session) });
    } else {
      onEvent?.({ type: "compaction-empty" });
    }
  }

  // 원문을 JSONL에 먼저 보존한 뒤 모델에게 보낼 대화에 추가한다.
  async function rememberMessage(session: Session, message: Message, scope: HistoryScope, source?: "harness") {
    [message] = await archiveImages([message], paths.sessionDirectory);
    await history.append(scope, { type: "message", message, ...(source ? { source } : {}) });
    recordMessage(session, message);
  }

  // 필요하면 컨텍스트를 줄이고 모델을 한 번 호출해 응답을 기록한다.
  async function step(session: Session, scope: HistoryScope) {
    // turn()이 이전 step의 모든 툴 결과를 기록한 뒤 여기로 돌아온다.
    if (shouldCompact(await assembleContext(session), budget)) {
      const before = contextSize(session);
      const pruned = pruneToolResults(session);
      if (pruned > 0) {
        await history.append(scope, { type: "context-update", reason: "prune", beforeChars: before,
          afterChars: contextSize(session), messages: session.messages });
        await saveSession(session, paths);
        onEvent?.({ type: "tool-results-pruned", count: pruned, beforeChars: before, afterChars: contextSize(session) });
      }
      if (shouldCompact(await assembleContext(session), budget)) await compactAndSave(session, scope);
      // 고정 지침·툴 또는 보존할 최근 기록만으로 가득 찬 경우 요약을 반복하지 않는다.
      const measured = await assembleContext(session);
      if (shouldCompact(measured, budget)) {
        throw new Error(`컨텍스트가 압축 후에도 예산을 초과합니다 (추정 ${estimateRequestTokens(measured)} / ${compactionThreshold(budget)} 토큰). 툴·스킬 또는 입력 크기를 줄여주세요.`);
      }
    }
    const context = await assembleContext(session);
    const result = await recordLLM(adapter, history, scope, "step", active?.signal).generate(context);
    // 잘린 응답은 model-response 원본 로그에만 남기고 재전송용 대화에는 넣지 않는다.
    if (result.stopReason !== "max-tokens") await rememberMessage(session, result.message, scope);

    return result;
  }

  // 사용자 입력을 기록하고 모델 호출과 툴 실행을 반복해 최종 답변을 반환한다.
  async function turn(session: Session, input: string, images: ImageBlock[] = []) {
    if (active) throw new Error("이미 실행 중인 턴이 있습니다.");
    const controller = new AbortController();
    active = controller;
    const { signal } = controller;
    const turnScope = { sessionId: session.id, turnId: randomUUID() };
    let runningTool: { id: string; name: string; started: number; scope: HistoryScope } | undefined;
    try {
      await history.append(turnScope, { type: "turn-start" });
      await rememberMessage(session, {
        role: "user",
        content: [{ type: "text", text: input }, ...images],
      }, turnScope);

      // 정상 스텝이 끼어도 초기화하지 않아 한 턴의 복구 요청 수를 제한한다.
      let outputLimitRecoveries = 0;
      const maxOutputLimitRecoveries = 2;
      for (let stepNumber = 1; ; stepNumber++) {
        signal.throwIfAborted();
        const scope = { ...turnScope, step: stepNumber };
        if (pendingPlanExit) {
          pendingPlanExit = false;
          applyMode("edit", "plan-approved");
        }
        // 사용자가 턴 중에 고른 모드는 여기서 반영한다. 모델에게도 이유를 알려 거부된 툴을 오해하지 않게 한다.
        if (pendingMode !== undefined) {
          const next = pendingMode;
          pendingMode = undefined;
          if (applyMode(next, "user")) {
            await rememberMessage(session, { role: "user", content: [{ type: "text", text:
              `[하네스 알림] 사용자가 작업 모드를 ${next}로 전환했습니다. 이번 스텝부터 ${next} 모드의 지침과 툴 권한이 적용됩니다. 이 메시지는 새 사용자 요청이 아닙니다.` }] }, scope, "harness");
          }
        }
        const output = await step(session, scope);
        signal.throwIfAborted();
        if (output.stopReason === "max-tokens") {
          if (outputLimitRecoveries >= maxOutputLimitRecoveries) {
            throw new Error(`LLM 응답이 정상 완료되지 않았습니다: max-tokens (작업 분할 복구 ${maxOutputLimitRecoveries}회 소진)`);
          }
          outputLimitRecoveries++;
          await rememberMessage(session, { role: "user", content: [{ type: "text", text:
            `[하네스 실행 피드백 · 출력 한도 복구 ${outputLimitRecoveries}/${maxOutputLimitRecoveries}]\n` +
            "직전 모델 응답이 출력 토큰 한도에 도달해 잘렸습니다. 그 응답의 툴 호출은 하나도 실행되지 않았습니다.\n" +
            "이전 스텝에서 완료한 작업과 툴 결과는 그대로 유효합니다. 이미 성공한 작업을 반복하지 마세요.\n" +
            "한 번에 생성할 내용을 줄여 원래 요청을 계속 수행하세요. 파일이나 작업을 나누거나, 지원되는 부분 편집 도구로 작은 범위를 수정하세요.\n" +
            "파일 전체 덮어쓰기 도구에 일부 내용만 보내 기존 내용을 지우지 마세요. 설명도 간결하게 작성하세요.\n" +
            "이 메시지는 실제 사용자의 새 요청이 아니라 하네스가 제공하는 실행 피드백입니다."
          }] }, scope, "harness");
          onEvent?.({ type: "output-limit-recovery", attempt: outputLimitRecoveries, maxAttempts: maxOutputLimitRecoveries });
          continue;
        }
        if (output.stopReason === "stop") {
          await history.append(scope, { type: "turn-end", outcome: "completed" });
          return textOf(output.message);
        }
        if (output.stopReason !== "tool-calls") {
          // 잘린 응답의 툴 인자를 실행하거나, 작업 완료로 취급하지 않는다.
          throw new Error(`LLM 응답이 정상 완료되지 않았습니다: ${output.stopReason}`);
        }

        const text = textOf(output.message);
        if (text) onEvent?.({ type: "assistant-text", text });

        for (const toolCall of output.message.content) {
          if (toolCall.type !== "tool-call") continue;
          signal.throwIfAborted();
          await history.append(scope, { type: "tool-start", toolCallId: toolCall.id,
            name: toolCall.name, arguments: toolCall.arguments });
          onEvent?.({ type: "tool-start", name: toolCall.name, arguments: toolCall.arguments });
          const started = performance.now();
          runningTool = { id: toolCall.id, name: toolCall.name, started, scope };
          let toolResult = await toolManager.execute(
            toolCall.name,
            toolCall.arguments,
            { llm: recordLLM(adapter, history, { ...scope, parentToolCallId: toolCall.id }, "other-llm", signal),
              discoveredTools: session.discoveredTools, signal,
              permissions: permissionMode === "yolo" ? ALLOW_ALL : modePermissions(mode, options.permissions ?? ALLOW_ALL),
              requestApproval: (request, signal) => approveForSession(session.id, request, signal) },
          );
          if (Array.isArray(toolResult.content)) {
            try {
              checkImageInput([...session.messages, { role: "tool", content: [
                { type: "tool-result", toolCallId: toolCall.id, ...toolResult },
              ] }], adapter.supportsImages, false);
            } catch (error) {
              toolResult = { content: error instanceof Error ? error.message : String(error), isError: true };
            }
          }
          const durationMs = performance.now() - started;
          await history.append(scope, { type: "tool-end", toolCallId: toolCall.id,
            durationMs, result: toolResult });

          await rememberMessage(session, {
            role: "tool",
            content: [{ type: "tool-result", toolCallId: toolCall.id, ...toolResult }],
          }, scope);
          runningTool = undefined;
          onEvent?.({ type: "tool-end", name: toolCall.name, durationMs, ...toolResult });
        }
      }
    } catch (error) {
      if (signal.aborted) {
        // 호출마다 결과를 채워 다음 사용자 입력 때도 제공자 API의 툴 호출 규약을 지킨다.
        const lastAssistant = session.messages.findLastIndex((message) => message.role === "assistant");
        const assistant = session.messages[lastAssistant];
        const answered = new Set(session.messages.slice(lastAssistant + 1).flatMap((message) =>
          message.role === "tool" ? message.content.map((block) => block.toolCallId) : []));
        if (assistant?.role === "assistant") for (const call of assistant.content) {
          if (call.type !== "tool-call" || answered.has(call.id)) continue;
          const content = runningTool?.id === call.id
            ? "사용자 요청으로 실행 대기를 중단했습니다. 이미 발생한 변경은 되돌리지 않았습니다. MCP 등 원격 작업의 실제 종료 여부는 미확인일 수 있습니다. 재실행 전에 상태를 확인하세요.\n" +
              `중단 시 실행 상태: ${error instanceof Error ? error.message : String(error)}`
            : "사용자 요청으로 턴이 중단되어 이 도구는 실행하지 않았습니다.";
          const result = { content, isError: true };
          if (runningTool?.id === call.id) {
            const durationMs = performance.now() - runningTool.started;
            await history.append(runningTool.scope, { type: "tool-end", toolCallId: call.id, durationMs, result });
            onEvent?.({ type: "tool-end", name: call.name, durationMs, ...result });
          }
          await rememberMessage(session, { role: "tool", content: [{ type: "tool-result", toolCallId: call.id, ...result }] }, turnScope);
        }
        await rememberMessage(session, { role: "user", content: [{ type: "text", text:
          "[하네스 알림] 사용자가 이전 턴을 중단했습니다. 완료한 작업은 유지됩니다. 새 사용자 지시를 따르세요." }] }, turnScope, "harness");
        await saveSession(session, paths);
        await history.append(turnScope, { type: "turn-end", outcome: "interrupted" });
        onEvent?.({ type: "turn-interrupted" });
        return "";
      }
      await saveSession(session, paths);
      await history.append(turnScope, { type: "turn-end", outcome: "error",
        error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      pendingPlanExit = false;
      active = undefined;
      // 다음 스텝 없이 턴이 끝났으면 대기 중인 모드를 지금 반영한다.
      if (pendingMode !== undefined) {
        const next = pendingMode;
        pendingMode = undefined;
        applyMode(next, "user");
      }
    }
  }

  return { turn, compact: compactAndSave, interrupt, setMode, setPermissionMode,
    // 권한 우회 상태는 세션 파일에 저장하지 않는다.
    getPermissionMode: () => permissionMode,
    // UI가 "다음 스텝부터" 표시를 할 수 있게 대기 중인 모드를 반환한다.
    getPendingMode: () => pendingMode,
    // UI가 현재 선택한 모드를 표시하도록 반환한다.
    getMode: () => mode };
}
