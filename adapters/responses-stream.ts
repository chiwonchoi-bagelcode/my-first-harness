import { readSseEvents } from "./sse.ts";

// JSON 이벤트가 필드 조회 가능한 객체인지 확인한다.
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// 완료된 SSE 응답을 JSON 응답과 같은 형태로 반환한다. delta만으로 툴을 실행하지 않는다.
export async function readResponsesStream(
  response: Response,
  onEvent?: (event: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const items = new Map<number, unknown>();
  for await (const event of readSseEvents(response, "Responses SSE")) {
    onEvent?.(event);
    if (event.type === "error") {
      throw new Error(typeof event.message === "string" ? event.message : "Responses SSE 오류가 발생했습니다.");
    }
    if (event.type === "response.output_item.done") {
      const index = event.output_index;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || !isObject(event.item)
        || items.has(index)) throw new Error("Responses SSE 출력 항목이 잘못되었습니다.");
      items.set(index, event.item);
    }
    if (["response.completed", "response.incomplete", "response.failed"].includes(event.type as string)) {
      const result = event.response;
      if (!isObject(result) || event.type !== `response.${result.status}`) {
        throw new Error("Responses SSE 종료 이벤트와 응답 상태가 일치하지 않습니다.");
      }
      if (result.status === "failed") {
        throw new Error(isObject(result.error) && typeof result.error.message === "string"
          ? result.error.message : "Responses 생성이 실패했습니다.");
      }
      if (!Array.isArray(result.output)) throw new Error("Responses output이 배열이 아닙니다.");
      // 최종 output이 비어 있는 서버 응답은 완료 항목들을 원래 순서대로 사용한다.
      if (result.output.length === 0 && items.size) {
        const ordered = [...items].sort(([a], [b]) => a - b);
        if (ordered.some(([index], position) => index !== position)) {
          throw new Error("Responses SSE 출력 항목이 누락되었습니다.");
        }
        return { ...result, output: ordered.map(([, item]) => item) };
      }
      return result;
    }
  }
  throw new Error("Responses SSE가 완료 이벤트 없이 끝났습니다.");
}
