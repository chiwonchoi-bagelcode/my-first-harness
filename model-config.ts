import { createResponsesAdapter } from "./adapters/responses.ts";
import { createAnthropicMessagesAdapter } from "./adapters/anthropic-messages.ts";
import type { LLMAdapter } from "./llm-types.ts";

// 실행 시 고른 이름에 맞춰 AIProxy 또는 Bakery Farm 연결과 API 어댑터를 선택한다.
export function createModelAdapter(name: string, apiKey: string | undefined): LLMAdapter {
  const baseURL = "https://aiproxy-api.backoffice.bagelgames.com";
  if (name === "farm") return { ...createResponsesAdapter({
    provider: "bakery-farm", baseURL: "https://bakery-codex-farm.bagelcode.ai/v1",
    model: "gpt-5.6-luna", apiKey, stream: true, supportsMaxOutputTokens: false, supportsImages: true,
  }), contextBudget: {
    // Farm 실효 한도는 공개되지 않아 200K를 운영 예산으로 선택한다. 출력 cap은 서버가 제거한다.
    contextWindow: 200_000, reservedOutputTokens: 32_000, safetyMarginTokens: 40_000, retainRatio: 0.16,
  } };
  if (name === "luna") return { ...createResponsesAdapter({
    // AIProxy도 SSE를 그대로 통과시켜 텍스트 조각을 화면에 흘릴 수 있다. 출력 한도는 Farm과 달리 그대로 보낸다.
    provider: "bagel-openai", baseURL: `${baseURL}/openai/v1`, model: "gpt-5.6-luna", apiKey, stream: true, supportsImages: true,
  }), contextBudget: {
    // Luna 공개 모델 한도. 프록시가 더 낮은 한도를 적용하면 이 연결 설정을 낮춘다.
    contextWindow: 1_050_000, reservedOutputTokens: 128_000, safetyMarginTokens: 210_000, retainRatio: 0.16,
  } };
  if (name === "haiku") return { ...createAnthropicMessagesAdapter({
    provider: "bagel-anthropic", baseURL: `${baseURL}/anthropic/v1`,
    model: "claude-haiku-4-5-20251001", apiKey, auth: "bearer", supportsImages: true, stream: true,
    // 코딩용 기본 출력 한도. Haiku 4.5의 64K 상한 안에서 요청별 재정의가 가능하다.
    maxOutputTokens: 32_000,
  }), contextBudget: {
    contextWindow: 200_000, reservedOutputTokens: 32_000, safetyMarginTokens: 40_000, retainRatio: 0.16,
  } };
  throw new Error(`지원하지 않는 모델 선택입니다: ${name}. luna, haiku 또는 farm을 사용하세요.`);
}
