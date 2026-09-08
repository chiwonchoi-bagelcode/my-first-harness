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
import { textOf } from "./llm-types.ts";
import type { LLMRequest, ToolDefinition } from "./llm-types.ts";
import type { Session } from "./session-store.ts";
import {
  compactSession,
  contextSize,
  pruneToolResults,
  recordMessage,
  shouldCompact,
} from "./context-manager.ts";

const paths = createHarnessPaths();
const token = process.env.AIPROXY_TOKEN;
// 인자를 생략하면 Luna, haiku를 붙이면 Anthropic Messages를 사용한다.
const adapter = createModelAdapter(process.argv[2] ?? "luna", token);

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
  async execute(name: string, argumentsJson: string) {
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
      return { content: String(await tool.execute(arguments_)) };
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
registerFilesystemTools(toolManager);
registerShellTools(toolManager);
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
async function compactAndSave(session: Session) {
  // 요약 API가 실패하더라도 지금까지의 원문을 resume할 수 있게 먼저 저장한다.
  await saveSession(session, paths);
  const before = contextSize(session);
  console.log("[context] 대화를 요약합니다...");
  const compacted = await compactSession(session, (conversation) =>
    summarize(adapter, conversation),
  );
  if (compacted) {
    await saveSession(session, paths);
    console.log(`[context] 압축 완료: ${before} → ${contextSize(session)}자`);
  } else {
    console.log("[context] 요약할 대화가 없습니다.");
  }
}

// 필요하면 컨텍스트를 줄이고 모델을 한 번 호출해 응답을 기록한다.
async function step(session: Session) {
  // console.log(session.messages);

  // turn()이 이전 step의 모든 툴 결과를 기록한 뒤 여기로 돌아온다.
  if (shouldCompact(session)) {
    const before = contextSize(session);
    const pruned = pruneToolResults(session);
    if (pruned > 0) {
      await saveSession(session, paths);
      console.log(`[context] 툴 결과 ${pruned}개 정리: ${before} → ${contextSize(session)}자`);
    }
    if (shouldCompact(session)) await compactAndSave(session);
  }
  const context = assembleContext(session);
  const result = await adapter.generate(context);
  recordMessage(session, result.message);

  return result;
}

// ================================ turn =================================
// 사용자 입력을 기록하고 모델 호출과 툴 실행을 반복해 최종 답변을 반환한다.
async function turn(session: Session, input: string) {
  recordMessage(session, {
    role: "user",
    content: [{ type: "text", text: input }],
  });

  while (true) {
    const output = await step(session);
    if (output.stopReason === "stop") {
      return textOf(output.message);
    }
    if (output.stopReason !== "tool-calls") {
      // 잘린 응답의 툴 인자를 실행하거나, 작업 완료로 취급하지 않는다.
      await saveSession(session, paths);
      throw new Error(`LLM 응답이 정상 완료되지 않았습니다: ${output.stopReason}`);
    }

    const text = textOf(output.message);
    if (text) console.log(text);

    for (const toolCall of output.message.content) {
      if (toolCall.type !== "tool-call") continue;
      console.log(`[tool] ${toolCall.name} ${toolCall.arguments}`);
      const toolResult = await toolManager.execute(
        toolCall.name,
        toolCall.arguments,
      );

      recordMessage(session, {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: toolCall.id, ...toolResult }],
      });
    }
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
    history: [],
    messages: [],
  };
}

let session = createSession();

// ========================= harness runtime =============================
const terminal = createInterface({ input: process.stdin, output: process.stdout });
terminal.on("SIGINT", () => {
  terminal.close();
  void closeMcpServers(mcpClients).finally(() => process.exit(130));
});
console.log(`session: ${session.id}`);

try {
  while (true) {
    const input = await terminal.question("> ");

    if (input.trim() === "/quit") {
      break;
    }

    if (input.trim() === "/new") {
      session = createSession();
      console.log(`new session: ${session.id}`);
      continue;
    }

    if (input.startsWith("/resume ")) {
      const id = input.slice("/resume ".length).trim();

      session = await loadSession(id, paths);

      console.log(`resumed session: ${session.id}`);
      continue;
    }

    if (input.trim() === "/compact") {
      await compactAndSave(session);
      continue;
    }

    let output = await turn(session, input);

    await saveSession(session, paths);

    // console.log(result.content)
    // console.log(response)

    console.log(output);
  }
} finally {
  terminal.close();
  await closeMcpServers(mcpClients);
}
