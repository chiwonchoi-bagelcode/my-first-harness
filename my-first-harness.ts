import "dotenv/config";
import { createInterface } from "node:readline/promises";

import { registerCounterFeature } from "./tools/counter.ts";
import { registerTimeTools } from "./tools/time.ts";
import { registerOtherLLMTools } from "./tools/other-llm.ts";
import { registerFilesystemTools } from "./tools/filesystem.ts";
import { registerShellTools } from "./tools/shell.ts";
import { loadSkills } from "./skill-loader.ts";

const token = process.env.AIPROXY_TOKEN;

// ================== utils =========================
const terminal = createInterface({
  input: process.stdin,
  output: process.stdout,
});

// ================ tool manager ==================
class ToolManager {
  tools: any[] = [];

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

  async execute(name: string, arguments_: any) {
    const tool = this.tools.find((tool) => tool.name === name);

    return await tool.execute(arguments_);
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
await loadSkills(skillManager);

// ===================== AssemblingContext ===================
function assembleContext() {
  const runtimeContext = {
    role: "system",
    content: `현재 작업 디렉토리: ${process.cwd()}`,
  };

  return {
    messages: [
      messages[0],
      ...skillManager.getMessages(),
      ...messages.slice(1),
      runtimeContext,
    ],
    tools: toolManager.getDefinitions(),
  };
}

// ======================= step ==============================
async function step() {
  // console.log(messages);

  const context = assembleContext();

  const response = await fetch(
    "https://aiproxy-api.backoffice.bagelgames.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: context.messages,
        tools: context.tools,
      }),
    },
  );

  const result = await response.json();

  const message = result.choices[0].message;

  messages.push({
    role: "assistant",
    content: message.content,
    tool_calls: message.tool_calls,
  });

  // console.dir(result, { depth: null });
  // console.log(result.choices[0].message.content);

  return result;
}

// ================================ turn =================================
async function turn(input: string) {
  messages.push({
    role: "user",
    content: input,
  });

  while (true) {
    const output = await step();
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
        JSON.parse(toolCall.function.arguments),
      );

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: String(toolResult),
      });
    }
  }
}

// ========================== starting system prompt ============================
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

// ========================= harness runtime =============================
while (true) {
  const input = await terminal.question("> ");

  if (input.trim() === "/quit") {
    terminal.close();
    break;
  }

  let output = await turn(input);

  // console.log(result.content)
  // console.log(response)

  console.log(output);
}
