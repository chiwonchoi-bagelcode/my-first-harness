import { createResponsesAdapter } from "./adapters/responses.ts";
import { createAnthropicMessagesAdapter } from "./adapters/anthropic-messages.ts";
import type { LLMAdapter } from "./llm-types.ts";

// 실행 시 고른 이름에 맞춰 AIProxy 또는 Bakery Farm 연결과 API 어댑터를 선택한다.
export function createModelAdapter(name: string, apiKey: string | undefined): LLMAdapter {
  const baseURL = "https://aiproxy-api.backoffice.bagelgames.com";
  if (name === "farm") return { ...createResponsesAdapter({
    provider: "bakery-farm", baseURL: "https://bakery-codex-farm.bagelcode.ai/v1",
    model: "gpt-5.6-luna", apiKey, stream: true, supportsMaxOutputTokens: false, supportsImages: true, webSearch: true,
  }), contextBudget: {
    // Farm 실효 한도는 공개되지 않아 200K를 운영 예산으로 선택한다. 출력 cap은 서버가 제거한다.
    contextWindow: 200_000, reservedOutputTokens: 32_000, safetyMarginTokens: 40_000, retainRatio: 0.16,
  } };
  if (name === "luna") return { ...createResponsesAdapter({
    // AIProxy도 SSE를 그대로 통과시켜 텍스트 조각을 화면에 흘릴 수 있다. 출력 한도는 Farm과 달리 그대로 보낸다.
    provider: "bagel-openai", baseURL: `${baseURL}/openai/v1`, model: "gpt-5.6-luna", apiKey, stream: true, supportsImages: true, webSearch: true,
  }), contextBudget: {
    // Luna 공개 모델 한도. 프록시가 더 낮은 한도를 적용하면 이 연결 설정을 낮춘다.
    contextWindow: 1_050_000, reservedOutputTokens: 128_000, safetyMarginTokens: 210_000, retainRatio: 0.16,
  } };
  if (name === "haiku") return { ...createAnthropicMessagesAdapter({
    provider: "bagel-anthropic", baseURL: `${baseURL}/anthropic/v1`,
    // Anthropic은 명시적 표시가 있어야 캐시한다. Haiku 4.5는 접두어가 4,096토큰 이상일 때만 캐시되므로 툴을 많이 끄면 tools+system 덩어리는 캐시되지 않을 수 있다.
    model: "claude-haiku-4-5-20251001", apiKey, auth: "bearer", supportsImages: true, stream: true, promptCache: true,
    // 제공자 실행 웹 검색. Haiku 4.5는 구형 툴 이름을 쓴다. 요청당 5회 상한.
    webSearch: { type: "web_search_20250305", maxUses: 5 },
    // 코딩용 기본 출력 한도. Haiku 4.5의 64K 상한 안에서 요청별 재정의가 가능하다.
    maxOutputTokens: 32_000,
  }), contextBudget: {
    contextWindow: 200_000, reservedOutputTokens: 32_000, safetyMarginTokens: 40_000, retainRatio: 0.16,
  } };
  if (name === "fable") return { ...createAnthropicMessagesAdapter({
    // Haiku와 같은 AIProxy Anthropic 경로로 Claude Fable 5.1을 연결한다. 실측(2026-09-11)에서 프록시가 이 모델 이름을 그대로 서빙했다.
    provider: "bagel-anthropic", baseURL: `${baseURL}/anthropic/v1`,
    model: "claude-fable-5-1", apiKey, auth: "bearer", supportsImages: true, stream: true, promptCache: true,
    // 제공자 실행 웹 검색(신형 툴 이름, 동적 필터링). 요청당 5회 상한.
    webSearch: { type: "web_search_20260209", maxUses: 5 },
    // 코딩용 기본 출력 한도. 확장 사고는 켜지 않는다(이 어댑터는 thinking 옵션을 보내지 않음).
    maxOutputTokens: 32_000,
  }), contextBudget: {
    // 프록시의 실효 한도를 확인하지 못해 Haiku와 같은 200K를 운영 예산으로 둔다.
    contextWindow: 200_000, reservedOutputTokens: 32_000, safetyMarginTokens: 40_000, retainRatio: 0.16,
  } };
  throw new Error(`지원하지 않는 모델 선택입니다: ${name}. luna, haiku, fable 또는 farm을 사용하세요.`);
}
