import { textOf } from "./llm-types.ts";
import { summaryContent } from "./image-content.ts";
import type { LLMAdapter, Message } from "./llm-types.ts";
import { SUMMARY_SYSTEM_PROMPT } from "./prompts.ts";

// 같은 어댑터에 대화 기록 요약을 요청하고 정상 완료된 요약문만 반환한다.
export async function summarize(adapter: LLMAdapter, conversation: Message[]) {
  const result = await adapter.generate({
    system: SUMMARY_SYSTEM_PROMPT,
    messages: [
      { role: "user", content: summaryContent(conversation) },
    ],
    tools: [],
    maxOutputTokens: 2048,
  });
  const text = textOf(result.message);
  if (result.stopReason !== "stop" || !text.trim()) {
    throw new Error("요약이 정상적으로 완료되지 않았습니다. 기존 대화를 유지합니다.");
  }
  return text;
}
