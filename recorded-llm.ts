import { randomUUID } from "node:crypto";
import type { CallPurpose, HistoryScope, HistorySink } from "./execution-history.ts";
import type { LLMAdapter } from "./llm-types.ts";

// 한 작업 범위에 어댑터를 묶어 일반·요약·중첩 호출 모두 같은 경로로 기록한다.
export function recordLLM(
  adapter: LLMAdapter,
  history: HistorySink,
  scope: HistoryScope,
  purpose: CallPurpose,
): LLMAdapter {
  return {
    supportsImages: adapter.supportsImages,
    contextBudget: adapter.contextBudget,
    // 호출별 ID로 실제 전송·수신·실패를 연결하며 재시도 정책은 변경하지 않는다.
    async generate(request) {
      const callId = randomUUID();
      const started = performance.now();
      await history.append(scope, { type: "model-start", callId, purpose, request });
      let result;
      try {
        result = await adapter.generate(request, {
          // 인증 헤더가 없는 실제 전송 본문을 요청 전에 기록한다.
          onRequest: (wire) => history.append(scope, { type: "model-request", callId, request: wire }),
          // 파싱·정규화 실패에도 응답과 사용량이 남도록 먼저 기록한다.
          onResponse: (wire) => history.append(scope, { type: "model-response", callId, response: wire }),
        });
      } catch (error) {
        await history.append(scope, {
          type: "model-error", callId, durationMs: performance.now() - started,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      await history.append(scope, {
        type: "model-end", callId, stopReason: result.stopReason, durationMs: performance.now() - started,
      });
      return result;
    },
  };
}
