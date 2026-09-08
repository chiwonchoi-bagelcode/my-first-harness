import { createResponsesAdapter } from "./adapters/responses.ts";
import { createAnthropicMessagesAdapter } from "./adapters/anthropic-messages.ts";
import type { LLMAdapter } from "./llm-types.ts";

// 실행 시 고른 모델 이름에 맞춰 AIProxy 연결과 API 어댑터를 선택한다.
export function createModelAdapter(name: string, apiKey: string | undefined): LLMAdapter {
  const baseURL = "https://aiproxy-api.backoffice.bagelgames.com";
  if (name === "luna") return createResponsesAdapter({
    provider: "bagel-openai", baseURL: `${baseURL}/openai/v1`, model: "gpt-5.6-luna", apiKey,
  });
  if (name === "haiku") return createAnthropicMessagesAdapter({
    provider: "bagel-anthropic", baseURL: `${baseURL}/anthropic/v1`,
    model: "claude-haiku-4-5-20251001", apiKey, auth: "bearer",
  });
  throw new Error(`지원하지 않는 모델 선택입니다: ${name}. luna 또는 haiku를 사용하세요.`);
}
