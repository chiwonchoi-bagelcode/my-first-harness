import { randomUUID } from "node:crypto";
import type { CallPurpose, HistoryScope, HistorySink, RequestSummary } from "./execution-history.ts";
import type { LLMAdapter, LLMRequest } from "./llm-types.ts";
import { projectRequestImages } from "./image-request.ts";
import { checkImageInput, imagesOf } from "./image-content.ts";
import { estimateRequestTokens } from "./token-budget.ts";

// 요청 전체 대신 크기와 구성만 남긴다. 같은 대화가 스텝마다 반복 저장되지 않게 하며, 전송 본문은 model-request가 담당한다.
function summarizeRequest(request: LLMRequest): RequestSummary {
  return {
    systemChars: request.system.length, messageCount: request.messages.length,
    imageCount: imagesOf(request.messages).length, toolNames: request.tools.map((tool) => tool.name),
    estimatedTokens: estimateRequestTokens(request),
    ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
  };
}

// 기록과 무관하게 호출자가 함께 받을 수 있는 진행 콜백이다. 텍스트 조각은 화면 표시용이며 기록에는 넣지 않는다.
export type RecordOptions = { onTextDelta?: (text: string) => void };

// 한 작업 범위에 어댑터를 묶어 일반·요약·중첩 호출 모두 같은 경로로 기록한다.
export function recordLLM(
  adapter: LLMAdapter,
  history: HistorySink,
  scope: HistoryScope,
  purpose: CallPurpose,
  signal?: AbortSignal,
  options: RecordOptions = {},
): LLMAdapter {
  return {
    supportsImages: adapter.supportsImages,
    contextBudget: adapter.contextBudget,
    // 호출별 ID로 실제 전송·수신·실패를 연결하며 재시도 정책은 변경하지 않는다.
    async generate(request) {
      signal?.throwIfAborted();
      const callId = randomUUID();
      const started = performance.now();
      await history.append(scope, { type: "model-start", callId, purpose, request: summarizeRequest(request) });
      let result;
      try {
        checkImageInput(request.messages, adapter.supportsImages, false);
        const messages = await projectRequestImages(request.messages, { protectRecent: purpose === "step" });
        result = await adapter.generate({ ...request, messages }, {
          // 인증 헤더가 없는 실제 전송 본문을 요청 전에 기록한다.
          onRequest: (wire) => history.append(scope, { type: "model-request", callId, request: wire }),
          // 파싱·정규화 실패에도 응답과 사용량이 남도록 먼저 기록한다.
          onResponse: (wire) => history.append(scope, { type: "model-response", callId, response: wire }),
          // 스트리밍 텍스트 조각은 호출자가 원할 때만 전달한다. 요약·중첩 호출은 넘기지 않아 화면에 섞이지 않는다.
          ...(options.onTextDelta ? { onTextDelta: options.onTextDelta } : {}),
        }, signal);
        signal?.throwIfAborted();
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
