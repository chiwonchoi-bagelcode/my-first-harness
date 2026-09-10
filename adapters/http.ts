import type { LLMObserver, WireRequest } from "../llm-types.ts";
import { usageOf } from "./usage.ts";
import { readResponsesStream } from "./responses-stream.ts";
import { readAnthropicStream } from "./anthropic-stream.ts";
import { omitImageData } from "./wire-log.ts";

// JSON 이벤트가 필드 조회 가능한 객체인지 확인한다.
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// API별 스트리밍 이벤트에서 화면에 이어 쓸 텍스트 조각만 꺼낸다. 툴 인자·reasoning·thinking 조각은 완성본으로만 다룬다.
function textDeltaOf(api: WireRequest["api"], event: Record<string, unknown>): string | undefined {
  if (api === "responses") {
    return event.type === "response.output_text.delta" && typeof event.delta === "string" ? event.delta : undefined;
  }
  if (api === "anthropic-messages" && event.type === "content_block_delta" && isObject(event.delta)
    && event.delta.type === "text_delta" && typeof event.delta.text === "string") return event.delta.text;
  return undefined;
}

// SSE를 지원하는 API의 이벤트 조립 함수다. Chat Completions는 텍스트 전용 레거시라 스트리밍하지 않는다.
const STREAM_READERS = { responses: readResponsesStream, "anthropic-messages": readAnthropicStream } as const;

// 인증 헤더는 전송에만 사용하고 요청 본문·응답·사용량은 해석 전에 관찰자에게 전달한다.
export async function requestJSON(
  request: WireRequest,
  headers: Record<string, string>,
  observer?: LLMObserver,
  stream = false,
  signal?: AbortSignal,
) {
  // 관찰자 대기 중 원래 객체가 바뀌어도 기록이 실제 전송 내용을 따르도록 먼저 직렬화한다.
  const body = JSON.stringify(request.body);
  // 기록용 복사본에서만 이미지 바이트를 크기·해시 설명으로 바꾼다. 원본 바이트는 message 이벤트와 attachments 파일에 한 번 있고, 요청마다 반복 저장하지 않는다.
  const logged = omitImageData(request.api, JSON.parse(body));
  await observer?.onRequest({ ...request, body: logged.body,
    ...(logged.imageDataOmitted ? { imageDataOmitted: logged.imageDataOmitted } : {}) });
  signal?.throwIfAborted();
  const response = await fetch(request.url, { method: "POST", headers, body, signal });
  // stream을 요청했거나 서버가 SSE라고 답하면 이벤트로 읽는다. Farm의 text/plain SSE도 읽고, 실패 직전까지 파싱한 이벤트를 응답 기록에 남긴다.
  const readStream = request.api === "chat-completions" ? undefined : STREAM_READERS[request.api];
  if (readStream && response.ok
    && (stream || response.headers.get("content-type")?.split(";")[0].trim() === "text/event-stream")) {
    const events: Record<string, unknown>[] = [];
    let result: Record<string, unknown> | undefined;
    try {
      result = await readStream(response, observer ? (event) => {
        events.push(event);
        // 텍스트 조각은 도착 즉시 화면용 콜백에 넘긴다. 완성 응답은 아래 result로 한 번 더 만들어진다.
        const delta = textDeltaOf(request.api, event);
        if (delta !== undefined) observer.onTextDelta?.(delta);
      } : undefined);
    } finally {
      await observer?.onResponse({
        status: response.status,
        requestId: response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined,
        body: { events },
        // 조립에 실패한 Responses는 마지막 종료 이벤트의 응답에서 사용량을 건진다. Anthropic은 조립된 결과에만 사용량이 있다.
        ...usageOf(request.api, result ?? (request.api === "responses" ? events.at(-1)?.response : undefined)),
      });
    }
    return { response, result };
  }
  const text = await response.text();
  let result: any;
  let validJSON = true;
  try { result = JSON.parse(text); } catch { result = text; validJSON = false; }
  await observer?.onResponse({
    status: response.status,
    requestId: response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined,
    body: result,
    ...usageOf(request.api, result),
  });
  if (!validJSON) throw new Error(`LLM 요청 실패: HTTP ${response.status} (JSON 응답이 아닙니다.)`);
  return { response, result };
}
