import "dotenv/config";
import { createInterface } from "node:readline/promises";

const token = process.env.AIPROXY_TOKEN;

const input = process.argv[2];

const terminal = createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function step(input: string) {
  messages.push({
    role: "user",
    content: input,
  });

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

const messages = [
  {
    role: "system",
    content:
      "You are a smart secretary of your master. answer based on given conversation so far",
  },
];

while (true) {
  const input = await terminal.question("> ");

  const output = await step(input);
  // console.log(result.content)
  // console.log(response)

  console.log(output);
}
