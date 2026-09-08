import { createResponsesAdapter } from "./adapters/responses.ts";
import { createAnthropicMessagesAdapter } from "./adapters/anthropic-messages.ts";
import type { LLMAdapter } from "./llm-types.ts";

// 실행 시 고른 이름에 맞춰 AIProxy 또는 Bakery Farm 연결과 API 어댑터를 선택한다.
export function createModelAdapter(name: string, apiKey: string | undefined): LLMAdapter {
  const baseURL = "https://aiproxy-api.backoffice.bagelgames.com";
  if (name === "farm") return createResponsesAdapter({
    provider: "bakery-farm", baseURL: "https://bakery-codex-farm.bagelcode.ai/v1",
    model: "gpt-5.6-luna", apiKey, stream: true, supportsMaxOutputTokens: false, supportsImages: true,
  });
  if (name === "luna") return createResponsesAdapter({
    provider: "bagel-openai", baseURL: `${baseURL}/openai/v1`, model: "gpt-5.6-luna", apiKey, supportsImages: true,
  });
  if (name === "haiku") return createAnthropicMessagesAdapter({
    provider: "bagel-anthropic", baseURL: `${baseURL}/anthropic/v1`,
    model: "claude-haiku-4-5-20251001", apiKey, auth: "bearer", supportsImages: true,
    // 코딩용 기본 출력 한도. Haiku 4.5의 64K 상한 안에서 요청별 재정의가 가능하다.
    maxOutputTokens: 32_000,
  });
  throw new Error(`지원하지 않는 모델 선택입니다: ${name}. luna, haiku 또는 farm을 사용하세요.`);
}
