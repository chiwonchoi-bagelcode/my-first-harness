import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const token = process.env.AIPROXY_TOKEN;

const execAsync = promisify(exec);

// ================== utils =========================
const terminal = createInterface({
  input: process.stdin,
  output: process.stdout,
});

// ======================== tools ================

function getCurrentTime() {
  return new Date().toISOString();
}

async function getOtherLLMsOpinion(ask: string) {
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
        messages: [
          {
            role: "user",
            content: ask,
          },
        ],
      }),
    },
  );

  const result = await response.json();

  return result.choices[0].message.content;
}

let counter = 0;
function counterUP() {
  counter++;

  return "successfully increased counter";
}

function getCounterVal() {
  return counter;
}

async function listDirectory(path: string) {
  const files = await readdir(path);

  return files.join("\n");
}

async function writeTextFile(path: string, content: string) {
  await writeFile(path, content, "utf8");

  return `wrote ${path}`;
}

async function runCommand(command: string) {
  const result = await execAsync(command);

  return result.stdout + result.stderr;
}

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

toolManager.register({
  name: "getCurrentTime",
  description: "현재 시간을 받는다",
  parameters: {},
  execute: getCurrentTime,
});

toolManager.register({
  name: "counterUP",
  description: "counter값을 1 올린다.",
  parameters: {},
  execute: counterUP,
});

toolManager.register({
  name: "getCounterVal",
  description: "counter값을 받아온다.",
  parameters: {},
  execute: getCounterVal,
});

toolManager.register({
  name: "getOtherLLMsOpinion",
  description: "다른 LLM에게 질문하고 답을 받는다",
  parameters: {
    type: "object",
    properties: {
      ask: {
        type: "string",
        description: "다른 LLM에게 전달할 질문. 맥락과 질문을 모두 포함",
      },
    },
    required: ["ask"],
  },
  execute: (arguments_: any) => getOtherLLMsOpinion(arguments_.ask),
});

toolManager.register({
  name: "readTextFile",
  description: "텍스트 파일의 내용을 읽는다.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "읽을 파일 경로",
      },
    },
    required: ["path"],
  },
  execute: (arguments_: any) => readFile(arguments_.path, "utf8"),
});

toolManager.register({
  name: "listDirectory",
  description: "폴더 안의 파일과 폴더 목록을 확인한다.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "확인할 폴더 경로",
      },
    },
    required: ["path"],
  },
  execute: (arguments_: any) => listDirectory(arguments_.path),
});

toolManager.register({
  name: "writeTextFile",
  description: "텍스트 파일을 생성하거나 기존 내용을 덮어쓴다.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "작성할 파일 경로",
      },
      content: {
        type: "string",
        description: "파일에 작성할 전체 내용",
      },
    },
    required: ["path", "content"],
  },
  execute: (arguments_: any) =>
    writeTextFile(arguments_.path, arguments_.content),
});

toolManager.register({
  name: "runCommand",
  description: "현재 작업 디렉토리에서 터미널 명령을 실행한다.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "실행할 터미널 명령",
      },
    },
    required: ["command"],
  },
  execute: (arguments_: any) => runCommand(arguments_.command),
});

// ===================== skills ==============================
const counterCheck = {
  name: "counter-check",
  instructions:
    "카운터를 변경하기 전에 getCounterVal로 기존 값을 확인하고, 변경 후 다시 getCounterVal로 최종 값을 확인한다.",
};

const aggressiveGreeting = {
  name: "aggressive-greeting",
  instructions: "유저가 너에게 분노를 표현하면 더 강한 분노로 맞받아쳐라",
};

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

skillManager.register(counterCheck);
skillManager.register(aggressiveGreeting);

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
