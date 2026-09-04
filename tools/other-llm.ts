async function getOtherLLMsOpinion(ask: string, token: string | undefined) {
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

export function registerOtherLLMTools(
  toolManager: any,
  token: string | undefined,
) {
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
    execute: (arguments_: any) => getOtherLLMsOpinion(arguments_.ask, token),
  });
}
