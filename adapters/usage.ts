import type { LLMUsage, WireRequest } from "../llm-types.ts";

// 외부 사용량 값에서 유효한 음이 아닌 정수만 받아들인다.
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

// API별 사용량을 공통 단위로 바꾸고 원본 상세 내역은 wire 응답에 남긴다.
export function usageOf(api: WireRequest["api"], result: any): { usage?: LLMUsage } {
  const raw = result?.usage;
  if (!raw || typeof raw !== "object") return {};
  let usage: LLMUsage;
  if (api === "anthropic-messages") {
    const input = count(raw.input_tokens);
    const read = count(raw.cache_read_input_tokens);
    const write = count(raw.cache_creation_input_tokens);
    // Messages의 input_tokens는 캐시를 제외한다. 생략된 캐시 수치는 추측하지 않는다.
    usage = {
      inputTokens: input !== undefined && read !== undefined && write !== undefined ? input + read + write : undefined,
      outputTokens: count(raw.output_tokens),
      cachedInputTokens: read,
      cacheWriteInputTokens: write,
    };
  } else {
    const chat = api === "chat-completions";
    usage = {
      inputTokens: count(chat ? raw.prompt_tokens : raw.input_tokens),
      outputTokens: count(chat ? raw.completion_tokens : raw.output_tokens),
      cachedInputTokens: count((chat ? raw.prompt_tokens_details : raw.input_tokens_details)?.cached_tokens),
      cacheWriteInputTokens: chat ? undefined : count(raw.input_tokens_details?.cache_write_tokens),
      reasoningOutputTokens: count((chat ? raw.completion_tokens_details : raw.output_tokens_details)?.reasoning_tokens),
    };
  }
  const known = Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined));
  return Object.keys(known).length ? { usage: known } : {};
}
