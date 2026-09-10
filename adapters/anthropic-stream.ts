import { readSseEvents } from "./sse.ts";

// JSON 이벤트가 필드 조회 가능한 객체인지 확인한다.
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// 조립 중인 content 블록이다. tool_use의 인자는 JSON 문자열 조각으로 오므로 블록이 끝날 때 한 번 파싱한다.
type Building = { block: Record<string, unknown>; partialJson?: string; unparsed?: boolean };

// 완료된 Anthropic SSE를 비스트리밍 Messages 응답과 같은 객체로 조립한다. 조각만으로 툴을 실행하지 않는다.
// 이벤트 순서: message_start → (content_block_start → content_block_delta… → content_block_stop)… → message_delta → message_stop. ping은 무시한다.
export async function readAnthropicStream(
  response: Response,
  onEvent?: (event: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  let message: Record<string, unknown> | undefined;
  const blocks = new Map<number, Building>();
  for await (const event of readSseEvents(response, "Anthropic SSE")) {
    onEvent?.(event);
    const type = event.type;
    if (type === "ping") continue;
    if (type === "error") {
      throw new Error(isObject(event.error) && typeof event.error.message === "string"
        ? event.error.message : "Anthropic SSE 오류가 발생했습니다.");
    }
    if (type === "message_start") {
      if (message || !isObject(event.message)) throw new Error("Anthropic SSE message_start가 잘못되었습니다.");
      // 모델·역할·입력 사용량은 여기에 있고 content는 비어 있다. 블록은 아래에서 채운다.
      message = { ...event.message, content: [] };
      continue;
    }
    if (!message) throw new Error("Anthropic SSE가 message_start 없이 시작했습니다.");
    const index = event.index;
    if (type === "content_block_start") {
      if (typeof index !== "number" || !isObject(event.content_block) || blocks.has(index)) {
        throw new Error("Anthropic SSE 블록 시작이 잘못되었습니다.");
      }
      const block = { ...event.content_block };
      blocks.set(index, block.type === "tool_use" ? { block, partialJson: "" } : { block });
      continue;
    }
    const building = typeof index === "number" ? blocks.get(index) : undefined;
    if (type === "content_block_delta") {
      if (!building || !isObject(event.delta)) throw new Error("Anthropic SSE 블록 조각이 잘못되었습니다.");
      const delta = event.delta;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        building.block.text = String(building.block.text ?? "") + delta.text;
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        building.partialJson = (building.partialJson ?? "") + delta.partial_json;
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        building.block.thinking = String(building.block.thinking ?? "") + delta.thinking;
      } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
        building.block.signature = String(building.block.signature ?? "") + delta.signature;
      } else {
        throw new Error(`지원하지 않는 Anthropic SSE 조각 형식입니다: ${delta.type}`);
      }
      continue;
    }
    if (type === "content_block_stop") {
      if (!building) throw new Error("Anthropic SSE 블록 종료가 잘못되었습니다.");
      if (building.partialJson !== undefined) {
        // 인자 없는 호출은 빈 문자열로 오므로 빈 객체다. 잘린 JSON은 종료 사유가 max_tokens일 때만 허용한다.
        try { building.block.input = building.partialJson ? JSON.parse(building.partialJson) : {}; }
        catch { building.unparsed = true; building.block.input = undefined; }
      }
      continue;
    }
    if (type === "message_delta") {
      if (isObject(event.delta)) {
        if ("stop_reason" in event.delta) message.stop_reason = event.delta.stop_reason;
        if ("stop_sequence" in event.delta) message.stop_sequence = event.delta.stop_sequence;
      }
      // 출력 토큰은 누적값으로 오므로 시작 때의 입력 사용량 위에 덧쓴다.
      if (isObject(event.usage)) message.usage = { ...(isObject(message.usage) ? message.usage : {}), ...event.usage };
      continue;
    }
    if (type === "message_stop") {
      const ordered = [...blocks].sort(([a], [b]) => a - b);
      if (ordered.some(([position], expected) => position !== expected)) throw new Error("Anthropic SSE 블록 순서가 누락되었습니다.");
      if (message.stop_reason !== "max_tokens" && ordered.some(([, entry]) => entry.unparsed)) {
        throw new Error("Anthropic tool_use 인자 JSON이 완성되지 않은 채 응답이 끝났습니다.");
      }
      return { ...message, content: ordered.map(([, entry]) => entry.block) };
    }
    // 알 수 없는 이벤트 종류는 기록에는 남고 조립에는 쓰지 않는다.
  }
  throw new Error("Anthropic SSE가 완료 이벤트 없이 끝났습니다.");
}
