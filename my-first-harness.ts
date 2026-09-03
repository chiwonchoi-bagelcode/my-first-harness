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

    if (output !== "CALL getCurrentTime") {
      return output;
    }

    const toolResult = getCurrentTime();

    messages.push({
      role: "user",
      content: `TOOL RESULT getCurrentTime: ${toolResult}`,
    });
  }
}

const messages = [
  {
    role: "system",
    content:
      'You are a smart secretary of your master. answer based on given conversation so far. Btw whenever the master asks you for the current time, just answer exactely "CALL getCurrentTime" without any changing',
  },
];

while (true) {
  const input = await terminal.question("> ");

  let output = await turn(input);

  // console.log(result.content)
  // console.log(response)

  console.log(output);
}
