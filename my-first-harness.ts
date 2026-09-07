import "dotenv/config";
import { Ajv } from "ajv";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";

import { registerCounterFeature } from "./tools/counter.ts";
import { registerTimeTools } from "./tools/time.ts";
import { registerOtherLLMTools } from "./tools/other-llm.ts";
import { registerFilesystemTools } from "./tools/filesystem.ts";
import { registerShellTools } from "./tools/shell.ts";
import { loadSkills } from "./skill-loader.ts";
import { loadSession, saveSession } from "./session-store.ts";
import { createHarnessPaths } from "./harness-paths.ts";
import { callLLM, summarize } from "./llm.ts";
import {
  compactSession,
  contextSize,
  pruneToolResults,
  recordMessage,
  shouldCompact,
} from "./context-manager.ts";

const paths = createHarnessPaths();
const token = process.env.AIPROXY_TOKEN;

// ================== utils =========================
const terminal = createInterface({
  input: process.stdin,
  output: process.stdout,
});

// ================ tool manager ==================
class ToolManager {
  tools: any[] = [];
  ajv = new Ajv();

  register(tool: any) {
    this.tools.push(tool);
  }

  getDefinitions() {
    return this.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  async execute(name: string, argumentsJson: string) {
    const tool = this.tools.find((tool) => tool.name === name);

    if (!tool) {
      return `툴 요청 오류: 등록되지 않은 툴입니다: ${name}`;
    }

    let arguments_: any;
    try {
      arguments_ = JSON.parse(argumentsJson);
    } catch {
      return "툴 인자 오류: arguments는 올바른 JSON 문자열이어야 합니다.";
    }

    const valid = this.ajv.validate(tool.parameters, arguments_);
    if (!valid) {
      return `툴 인자 오류: ${this.ajv.errorsText()}`;
    }

    try {
      return await tool.execute(arguments_);
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : String(error);

      return `툴 실행 오류: ${message}`;
    }
  }
}

const toolManager = new ToolManager();

// ======================= skill manager =====================
class SkillManager {
  skills: any[] = [];

  register(skill: any) {
    this.skills.push(skill);
  }

  getMessages() {
    return this.skills.map((skill) => ({
      role: "system",
      content: `Skill: ${skill.name}\n${skill.instructions}`,
    }));
  }
}

const skillManager = new SkillManager();

// ===================== features ============================
registerCounterFeature(toolManager, skillManager);
registerTimeTools(toolManager);
registerOtherLLMTools(toolManager, token);
registerFilesystemTools(toolManager);
registerShellTools(toolManager);
await loadSkills(skillManager, paths);

// ===================== AssemblingContext ===================
function assembleContext(session: any) {
  const runtimeContext = {
    role: "system",
    content: `현재 작업 디렉토리: ${paths.workspaceDirectory}`,
  };

  return {
    messages: [
      session.messages[0],
      ...skillManager.getMessages(),
      ...session.messages.slice(1),
      runtimeContext,
    ],
    tools: toolManager.getDefinitions(),
  };
}

// ======================= step ==============================
async function compactAndSave(session: any) {
  // 요약 API가 실패하더라도 지금까지의 원문을 resume할 수 있게 먼저 저장한다.
  await saveSession(session, paths);
  const before = contextSize(session);
  console.log("[context] 대화를 요약합니다...");
  const compacted = await compactSession(session, (conversation) =>
    summarize(token, conversation),
  );
  if (compacted) {
    await saveSession(session, paths);
    console.log(`[context] 압축 완료: ${before} → ${contextSize(session)}자`);
  } else {
    console.log("[context] 요약할 대화가 없습니다.");
  }
}

async function step(session: any) {
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
  const result = await callLLM(token, context);

  const message = result.choices[0].message;

  recordMessage(session, {
    role: "assistant",
    content: message.content,
    tool_calls: message.tool_calls,
  });

  // console.dir(result, { depth: null });
  // console.log(result.choices[0].message.content);

  return result;
}

// ================================ turn =================================
async function turn(session: any, input: string) {
  recordMessage(session, {
    role: "user",
    content: input,
  });

  while (true) {
    const output = await step(session);
    const choice = output.choices[0];

    if (choice.finish_reason !== "tool_calls") {
      return choice.message.content;
    }

    if (choice.message.content) {
      console.log(choice.message.content);
    }

    // console.dir(output, { depth: null });

    for (const toolCall of choice.message.tool_calls) {
      const toolResult = await toolManager.execute(
        toolCall.function.name,
        toolCall.function.arguments,
      );

      recordMessage(session, {
        role: "tool",
        tool_call_id: toolCall.id,
        content: String(toolResult),
      });
    }
  }
}

// ============================== session ======================================
function createSession() {
  const messages: any[] = [
    {
      role: "system",
      content: `너는 마스터를 돕는 비서다. 마스터의 요구를 만족하라.

너는 여러 step에 걸쳐 작업할 수 있다.

- assistant content는 즉시 사용자에게 출력된다.
- tool_calls는 content가 출력된 다음 실행된다.
- 툴 결과는 다음 step에서 전달된다.
- 사용자가 중간 보고를 요청하면, 실제 툴 결과를 받은 뒤 다음 작업을 시작하기 전에 그 결과를 보고하라.
- 실행하지 않은 결과를 미리 보고하거나, 모든 작업이 끝난 뒤 실시간으로 보고한 것처럼 재구성하지 마라.

think deep, step by step.
`,
    },
  ];

  return {
    id: randomUUID(),
    workspaceDirectory: paths.workspaceDirectory,
    history: [...messages],
    messages,
  };
}

let session = createSession();

// ========================= harness runtime =============================
console.log(`session: ${session.id}`);

while (true) {
  const input = await terminal.question("> ");

  if (input.trim() === "/quit") {
    terminal.close();
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
