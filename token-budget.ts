import type { LLMRequest, Message } from "./llm-types.ts";

// 모델·연결별 운영 예산이다. 공개 한도보다 작은 값을 선택할 수도 있다.
export type ContextBudget = {
  contextWindow: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
  retainRatio: number;
};

// 한도가 없는 커스텀 어댑터의 보수적 운영 정책이며 모델의 공식 한도가 아니다.
export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  contextWindow: 200_000, reservedOutputTokens: 32_000,
  safetyMarginTokens: 40_000, retainRatio: 0.16,
};

// ASCII는 4자당 1, 비ASCII는 code point당 2토큰으로 넉넉히 추정한다.
export function estimateTextTokens(text: string): number {
  let tokens = 0;
  for (const char of text) tokens += char.codePointAt(0)! <= 127 ? 0.25 : 2;
  return Math.ceil(tokens);
}

// 이미지 원본 바이트 대신 장당 4,000토큰을 잡는다. 실제 시각 토큰 계산은 아니다.
export function estimateMessageTokens(message: Message): number {
  let imageTokens = 0;
  const content = JSON.stringify({ role: message.role, content: message.content }, (_key, value) => {
    if (value && typeof value === "object" && value.type === "image") {
      imageTokens += 4000;
      return { ...value, data: undefined };
    }
    return value;
  });
  const visible = estimateTextTokens(content) + imageTokens;
  // 같은 제공자의 원본 재전송은 공통 블록을 대체하므로 두 값을 합산하지 않는다.
  const replay = message.role === "assistant" && message.replayState
    ? estimateTextTokens(JSON.stringify(message.replayState.data)) : 0;
  return Math.max(visible, replay) + 16;
}

// 시스템·스킬·툴 정의와 대화·이미지를 합산한다. 네트워크와 usage 보정은 없다.
export function estimateRequestTokens(request: LLMRequest): number {
  return estimateTextTokens(request.system) + estimateTextTokens(JSON.stringify(request.tools))
    + request.messages.reduce((total, message) => total + estimateMessageTokens(message), 0) + 32;
}

// DSH처럼 컨텍스트 예산의 비율을 최근 원문 보존 토큰 수로 환산한다.
export function retentionTokens(budget: ContextBudget): number {
  return Math.floor(budget.contextWindow * budget.retainRatio);
}

// 출력 공간과 추정 오차 여유를 제외한 자동 압축 시작점을 계산한다.
export function compactionThreshold(budget: ContextBudget, maxOutputTokens?: number): number {
  const output = Math.max(budget.reservedOutputTokens, maxOutputTokens ?? 0);
  const threshold = budget.contextWindow - output - budget.safetyMarginTokens;
  if (!Object.values(budget).every((value) => Number.isFinite(value) && value >= 0)
    || threshold <= 0 || budget.retainRatio >= 1 || retentionTokens(budget) >= threshold) {
    throw new Error("컨텍스트 예산이 올바르지 않습니다: 출력·안전 여유·최근 기록 예산을 확인하세요.");
  }
  return threshold;
}
