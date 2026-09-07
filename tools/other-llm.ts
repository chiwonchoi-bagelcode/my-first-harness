import { textOf } from "../llm-types.ts";
import type { LLMAdapter } from "../llm-types.ts";

// 현재 대화와 분리된 질문을 같은 어댑터로 보내 정상 완료된 답변을 반환한다.
async function getOtherLLMsOpinion(ask: string, adapter: LLMAdapter) {
  const result = await adapter.generate({
    system: "",
    messages: [{ role: "user", content: [{ type: "text", text: ask }] }],
    tools: [],
  });
  if (result.stopReason !== "stop") throw new Error(`LLM 응답이 완료되지 않았습니다: ${result.stopReason}`);
  return textOf(result.message);
}

// 독립적인 LLM 질문·응답을 수행하는 툴을 ToolManager에 등록한다.
export function registerOtherLLMTools(
  toolManager: any,
  adapter: LLMAdapter,
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
    // 모델이 작성한 질문을 독립적인 LLM 호출에 전달한다.
    execute: (arguments_: any) => getOtherLLMsOpinion(arguments_.ask, adapter),
  });
}
