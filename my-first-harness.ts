import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";

import { registerCounterFeature } from "./tools/counter.ts";
import { registerTimeTools } from "./tools/time.ts";
import { registerOtherLLMTools } from "./tools/other-llm.ts";
import { registerFilesystemTools } from "./tools/filesystem.ts";
import { registerShellTools } from "./tools/shell.ts";
import { loadSkills } from "./skill-loader.ts";
import { SkillManager } from "./skill-manager.ts";
import { loadSession, saveSession } from "./session-store.ts";
import { createHarnessPaths } from "./harness-paths.ts";
import { summarize } from "./llm.ts";
import { connectMcpServers, closeMcpServers } from "./mcp-client.ts";
import { createMcpServerConfigs } from "./mcp-servers.ts";
import { validateToolArguments } from "./tool-schema.ts";
import { createModelAdapter } from "./model-config.ts";
import { ExecutionHistory } from "./execution-history.ts";
import type { HistoryScope } from "./execution-history.ts";
import { recordLLM } from "./recorded-llm.ts";
import { textOf } from "./llm-types.ts";
import type { ImageBlock, LLMAdapter, LLMRequest, Message, ToolContent, ToolDefinition } from "./llm-types.ts";
import { attachmentPath, checkImageInput, loadImage } from "./image-content.ts";
import type { Session } from "./session-store.ts";
import {
  compactSession,
  contextSize,
  pruneToolResults,
  recordMessage,
  shouldCompact,
} from "./context-manager.ts";

const paths = createHarnessPaths();
// 기본은 Bakery Farm Luna이며 luna 또는 haiku를 지정하면 AIProxy 연결을 사용한다.
const modelChoice = process.argv[2] ?? "farm";
const token = modelChoice === "farm" ? process.env.BCF_API_KEY : process.env.AIPROXY_TOKEN;
const adapter = createModelAdapter(modelChoice, token);
const history = new ExecutionHistory(paths,
  [process.env.BCF_API_KEY, process.env.AIPROXY_TOKEN].filter((key): key is string => !!key));

// ================ tool manager ==================
// 툴 정의와 실행 함수를 보관하고 호출 인자 검증 및 실행을 담당한다.
class ToolManager {
  tools: any[] = [];

  // 툴의 정의와 실행 함수를 목록에 추가한다.
  register(tool: any) {
    this.tools.push(tool);
  }

  // 모델에게 보낼 이름·설명·인자 규격만 꺼낸다.
  getDefinitions(): ToolDefinition[] {
    return this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  // 툴과 인자를 검증한 뒤 실행하고, 호출·실행 오류도 결과로 반환한다.
  async execute(name: string, argumentsJson: string, context?: { llm: LLMAdapter }) {
    const tool = this.tools.find((tool) => tool.name === name);

    if (!tool) {
      return { content: `툴 요청 오류: 등록되지 않은 툴입니다: ${name}`, isError: true };
    }

    let arguments_: any;
    try {
      arguments_ = JSON.parse(argumentsJson);
    } catch {
      return { content: "툴 인자 오류: arguments는 올바른 JSON 문자열이어야 합니다.", isError: true };
    }

    const validationError = validateToolArguments(tool.parameters, arguments_);
    if (validationError) return { content: validationError, isError: true };

    try {
      const value = await tool.execute(arguments_, context);
      const content: ToolContent = Array.isArray(value) ? value : String(value);
      return { content };
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : String(error);

      return { content: `툴 실행 오류: ${message}`, isError: true };
    }
  }
}

const toolManager = new ToolManager();

// ======================= skill manager =====================
const skillManager = new SkillManager();

// ===================== features ============================
registerCounterFeature(toolManager);
registerTimeTools(toolManager);
registerOtherLLMTools(toolManager, adapter);
registerFilesystemTools(toolManager, adapter.supportsImages);
const shellJobs = registerShellTools(toolManager, paths.workspaceDirectory);
await loadSkills(skillManager, paths);
const mcpClients = await connectMcpServers(toolManager, await createMcpServerConfigs(paths));

// ===================== AssemblingContext ===================
// 시스템 지침·스킬·작업 폴더와 현재 대화·툴 정의를 공통 요청으로 조립한다.
function assembleContext(session: Session): LLMRequest {
  return {
    system: [
      session.system,
      ...skillManager.getInstructions(),
      `현재 작업 디렉토리: ${paths.workspaceDirectory}`,
    ].join("\n\n"),
    messages: session.messages,
    tools: toolManager.getDefinitions(),
  };
}

// ======================= step ==============================
// 요약 실패에 대비해 세션을 먼저 저장하고 압축 성공 후 다시 저장한다.
async function compactAndSave(session: Session, scope: HistoryScope = { sessionId: session.id }) {
  // 요약 API가 실패해도 요약 직전 messages로 resume할 수 있게 먼저 저장한다.
  await saveSession(session, paths);
  const before = contextSize(session);
  console.log("[context] 대화를 요약합니다...");
  const compacted = await compactSession(session, (conversation) =>
    summarize(recordLLM(adapter, history, scope, "compaction"), conversation),
  );
  if (compacted) {
    await history.append(scope, { type: "context-update", reason: "compact", beforeChars: before,
      afterChars: contextSize(session), messages: session.messages });
    await saveSession(session, paths);
    console.log(`[context] 압축 완료: ${before} → ${contextSize(session)}자`);
  } else {
    console.log("[context] 요약할 대화가 없습니다.");
  }
}

// 원문을 JSONL에 먼저 보존한 뒤 모델에게 보낼 대화에 추가한다.
async function rememberMessage(session: Session, message: Message, scope: HistoryScope) {
  await history.append(scope, { type: "message", message });
  recordMessage(session, message);
}

// 필요하면 컨텍스트를 줄이고 모델을 한 번 호출해 응답을 기록한다.
async function step(session: Session, scope: HistoryScope) {
  // console.log(session.messages);

  // turn()이 이전 step의 모든 툴 결과를 기록한 뒤 여기로 돌아온다.
  if (shouldCompact(session)) {
    const before = contextSize(session);
    const pruned = pruneToolResults(session);
    if (pruned > 0) {
      await history.append(scope, { type: "context-update", reason: "prune", beforeChars: before,
        afterChars: contextSize(session), messages: session.messages });
      await saveSession(session, paths);
      console.log(`[context] 툴 결과 ${pruned}개 정리: ${before} → ${contextSize(session)}자`);
    }
    if (shouldCompact(session)) await compactAndSave(session, scope);
  }
  const context = assembleContext(session);
  const result = await recordLLM(adapter, history, scope, "step").generate(context);
  await rememberMessage(session, result.message, scope);

  return result;
}

// ================================ turn =================================
// 사용자 입력을 기록하고 모델 호출과 툴 실행을 반복해 최종 답변을 반환한다.
async function turn(session: Session, input: string, images: ImageBlock[] = []) {
  const turnScope = { sessionId: session.id, turnId: randomUUID() };
  await history.append(turnScope, { type: "turn-start" });
  await rememberMessage(session, {
    role: "user",
    content: [{ type: "text", text: input }, ...images],
  }, turnScope);

  try {
    for (let stepNumber = 1; ; stepNumber++) {
      const scope = { ...turnScope, step: stepNumber };
      const output = await step(session, scope);
      if (output.stopReason === "stop") {
        await history.append(scope, { type: "turn-end", outcome: "completed" });
        return textOf(output.message);
      }
      if (output.stopReason !== "tool-calls") {
        // 잘린 응답의 툴 인자를 실행하거나, 작업 완료로 취급하지 않는다.
        throw new Error(`LLM 응답이 정상 완료되지 않았습니다: ${output.stopReason}`);
      }

      const text = textOf(output.message);
      if (text) console.log(text);

      for (const toolCall of output.message.content) {
        if (toolCall.type !== "tool-call") continue;
        console.log(`[tool] ${toolCall.name} ${toolCall.arguments}`);
        await history.append(scope, { type: "tool-start", toolCallId: toolCall.id,
          name: toolCall.name, arguments: toolCall.arguments });
        const started = performance.now();
        let toolResult = await toolManager.execute(
          toolCall.name,
          toolCall.arguments,
          { llm: recordLLM(adapter, history, { ...scope, parentToolCallId: toolCall.id }, "other-llm") },
        );
        if (Array.isArray(toolResult.content)) {
          try {
            checkImageInput([...session.messages, { role: "tool", content: [
              { type: "tool-result", toolCallId: toolCall.id, ...toolResult },
            ] }], adapter.supportsImages);
          } catch (error) {
            toolResult = { content: error instanceof Error ? error.message : String(error), isError: true };
          }
        }
        await history.append(scope, { type: "tool-end", toolCallId: toolCall.id,
          durationMs: performance.now() - started, result: toolResult });

        await rememberMessage(session, {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: toolCall.id, ...toolResult }],
        }, scope);
      }
    }
  } catch (error) {
    await saveSession(session, paths);
    await history.append(turnScope, { type: "turn-end", outcome: "error",
      error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

// ============================== session ======================================
// 새 ID와 기본 시스템 지침을 가진 빈 세션을 만든다.
function createSession(): Session {
  return {
    id: randomUUID(),
    workspaceDirectory: paths.workspaceDirectory,
    // DSH text-turn 프롬프트에서 현재 하네스가 지원하는 역할·툴 안내만 가져온다.
    system: `You are an AI agent powered by My First Harness.

You are a coding assistant.

Verify your work by running the code or tests. Keep answers brief and factual.

Check the output and errors on every runCommand result; investigate failures before moving on.

Use the readTextFile tool — not shell commands like cat — to inspect text files.

Use the writeTextFile tool to create files or completely replace file contents. Existing files are overwritten, so read an existing file first.
`,
    messages: [],
  };
}

let session = createSession();
let pendingImages: ImageBlock[] = [];

// ========================= harness runtime =============================
const terminal = createInterface({ input: process.stdin, output: process.stdout });
let cleanupPromise: Promise<void> | undefined;
let interrupted = false;
// 정상 종료와 중단이 겹쳐도 셸 작업과 MCP 연결을 한 번만 정리하고 실패를 알린다.
function cleanupRuntime() {
  cleanupPromise ??= Promise.allSettled([shellJobs.dispose(), closeMcpServers(mcpClients)])
    .then(async (results) => {
      await history.append({ sessionId: session.id }, { type: "session-close", reason: interrupted ? "SIGINT" : "runtime-exit" });
      await history.flush();
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "런타임 정리 실패");
    });
  return cleanupPromise;
}
// 터미널 Ctrl+C와 운영체제 SIGINT 모두 같은 정리를 거쳐 종료한다.
function handleInterrupt() {
  interrupted = true;
  terminal.close();
  void cleanupRuntime().catch(console.error).finally(() => process.exit(130));
}
terminal.on("SIGINT", handleInterrupt);
process.once("SIGINT", handleInterrupt);
console.log(`session: ${session.id}`);

try {
  await history.append({ sessionId: session.id }, { type: "session-start",
    workspaceDirectory: session.workspaceDirectory, system: session.system });
  await saveSession(session, paths);
  while (true) {
    const input = await terminal.question("> ");
    if (input.trim().startsWith("/")) {
      await history.append({ sessionId: session.id }, { type: "command", input });
    }

    if (input.trim() === "/quit") {
      break;
    }

    if (input.trim() === "/attach" || input.startsWith("/attach ")) {
      try {
        if (!adapter.supportsImages) throw new Error("현재 모델 연결은 이미지 입력이 비활성화되어 있습니다.");
        const image = await loadImage(attachmentPath(input));
        checkImageInput([...session.messages, { role: "user", content: [...pendingImages, image] }], true);
        pendingImages.push(image);
        console.log(`[attach] ${image.path} (${image.width}×${image.height}) — 다음 메시지에 첨부합니다.`);
      } catch (error) {
        console.log(`[attach] ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }

    if (input.trim() === "/new") {
      session = createSession();
      pendingImages = [];
      await history.append({ sessionId: session.id }, { type: "session-start",
        workspaceDirectory: session.workspaceDirectory, system: session.system });
      await saveSession(session, paths);
      console.log(`new session: ${session.id}`);
      continue;
    }

    if (input.startsWith("/resume ")) {
      const id = input.slice("/resume ".length).trim();

      session = await loadSession(id, paths);
      pendingImages = [];
      await history.append({ sessionId: session.id }, { type: "session-resume", messageCount: session.messages.length });

      console.log(`resumed session: ${session.id}`);
      continue;
    }

    if (input.trim() === "/compact") {
      await compactAndSave(session);
      continue;
    }

    const images = pendingImages;
    pendingImages = [];
    let output = await turn(session, input, images);

    await saveSession(session, paths);

    // console.log(result.content)
    // console.log(response)

    console.log(output);
  }
} catch (error) {
  // Ctrl+C로 question 또는 실행 중 명령이 취소된 오류는 중단 처리에서 마무리한다.
  if (!interrupted) throw error;
} finally {
  terminal.close();
  await cleanupRuntime();
  process.removeListener("SIGINT", handleInterrupt);
}
