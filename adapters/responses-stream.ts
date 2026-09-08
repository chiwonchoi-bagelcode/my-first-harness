// JSON 이벤트가 필드 조회 가능한 객체인지 확인한다.
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// UTF-8 조각과 줄바꿈 경계를 합쳐 SSE의 data 필드만 이벤트 단위로 읽는다.
async function* readEvents(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) throw new Error("Responses SSE 본문이 없습니다.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let ended = false;
  try {
    while (!ended) {
      const { value, done } = await reader.read();
      ended = done;
      buffer += decoder.decode(value, { stream: !done });
      while (true) {
        const end = buffer.search(/[\r\n]/);
        if (end < 0 || (!done && buffer[end] === "\r" && end === buffer.length - 1)) break;
        const line = buffer.slice(0, end);
        const width = buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1;
        buffer = buffer.slice(end + width);
        if (line === "") {
          if (!data.length) continue;
          const payload = data.join("\n");
          data = [];
          if (payload === "[DONE]") return;
          let event: unknown;
          try { event = JSON.parse(payload); }
          catch { throw new Error("Responses SSE 이벤트가 올바른 JSON이 아닙니다."); }
          if (!isObject(event) || typeof event.type !== "string") {
            throw new Error("Responses SSE 이벤트 형식이 잘못되었습니다.");
          }
          yield event;
        } else if (line === "data" || line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
        // event/id/retry 필드와 ':'로 시작하는 keepalive 주석은 응답 내용이 아니다.
      }
    }
  } finally {
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// 완료된 SSE 응답을 JSON 응답과 같은 형태로 반환한다. delta만으로 툴을 실행하지 않는다.
export async function readResponsesStream(response: Response): Promise<Record<string, unknown>> {
  const items = new Map<number, unknown>();
  for await (const event of readEvents(response)) {
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
