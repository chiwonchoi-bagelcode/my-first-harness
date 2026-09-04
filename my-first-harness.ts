import "dotenv/config";
import { createInterface } from "node:readline/promises";

const token = process.env.AIPROXY_TOKEN;

const input = process.argv[2];

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

// ======================= step ==============================
async function step() {
  console.log(messages);

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
        messages,
        tools: [
          {
            type: "function",
            function: {
              name: "getOtherLLMsOpinion",
              description: "다른 LLM에게 질문하고 답을 받는다",
              parameters: {
                type: "object",
                properties: {
                  ask: {
                    type: "string",
                    description:
                      "다른 LLM에게 전달할 질문. 맥락과 질문을 모두 포함",
                  },
                },
                required: ["ask"],
              },
            },
          },
          {
            type: "function",
            function: {
              name: "getCurrentTime",
              description: "현재 시간을 받는다",
              parameters: {},
            },
          },
          {
            type: "function",
            function: {
              name: "counterUP",
              description: "counter값을 1 올린다.",
              parameters: {},
            },
          },
          {
            type: "function",
            function: {
              name: "getCounterVal",
              description: "counter값을 받아온다.",
              parameters: {},
            },
          },
        ],
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

    const toolCall = choice.message.tool_calls[0];

    console.dir(output, { depth: null });

    const toolResult = await (async () => {
      switch (toolCall.function.name) {
        case "getOtherLLMsOpinion":
          return await getOtherLLMsOpinion(
            JSON.parse(toolCall.function.arguments).ask,
          );

        case "getCurrentTime":
          return getCurrentTime();

        case "counterUP":
          return counterUP();

        case "getCounterVal":
          return getCounterVal();
      }
    })();

    messages.push({
      role: "tool",
      tool_call_id: toolCall.id,
      content: String(toolResult),
    });
  }
}

// ========================== starting system prompt ============================
const messages: any[] = [
  {
    role: "system",
    content: `너는 마스터를 돕는 비서다. 마스터의 요구를 만족하라.`,
  },
];

// ========================= harness runtime =============================
while (true) {
  const input = await terminal.question("> ");

  let output = await turn(input);

  // console.log(result.content)
  // console.log(response)

  console.log(output);
}
