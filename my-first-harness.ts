import "dotenv/config";
import { createInterface } from "node:readline/promises";

const token = process.env.AIPROXY_TOKEN;

const input = process.argv[2];

const terminal = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function getCurrentTime() {
  return new Date().toISOString();
}

async function getOtherLLMsOpinion(ask: string) {
  const response = await fetch(
    "https://aiproxy-api.backoffice.bagelgames.com/api/v1/chat/openai",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
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

  return result.content;
}

let counter = 0;
function counterUP() {
  counter++;

  return "successfully increased counter";
}

function getCounterVal() {
  return counter;
}

async function step() {
  console.log(messages);

  const response = await fetch(
    "https://aiproxy-api.backoffice.bagelgames.com/api/v1/chat/openai",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages,
      }),
    },
  );

  const result = await response.json();

  messages.push({
    role: "assistant",
    content: result.content,
  });

  return result.content;
}

async function turn(input: string) {
  messages.push({
    role: "user",
    content: input,
  });

  while (true) {
    const output = await step();

    if (
      output !== "CALL getCurrentTime" &&
      output !== "CALL getOtherLLMsOpinion" &&
      output !== "CALL counterUP" &&
      output !== "CALL getCounterVal"
    ) {
      return output;
    }

    const toolResult = await (async () => {
      switch (output) {
        case "CALL getOtherLLMsOpinion":
          return await getOtherLLMsOpinion(output);

        case "CALL getCurrentTime":
          return getCurrentTime();

        case "CALL counterUP":
          return counterUP();

        case "CALL getCounterVal":
          return getCounterVal();
      }
    })();

    messages.push({
      role: "user",
      content: `TOOL RESULT : ${toolResult}`,
    });
  }
}

const messages = [
  {
    role: "system",
    content: `너는 마스터를 돕는 비서다. 마스터의 요구를 만족하라. 
      - 사용할 수 있는 도구: getCurrentTime, getOtherLLMsOpinion, counterUP, getCounterVal
      - 도구 사용법: 어떠한 수정이나 다른 출력도 없이 오직 'CALL {도구이름}'으로 답하라. 예를 들면, 'CALL getCurrentTime'`,
  },
];

while (true) {
  const input = await terminal.question("> ");

  let output = await turn(input);

  // console.log(result.content)
  // console.log(response)

  console.log(output);
}
