// SSE(Server-Sent Events) 본문을 이벤트 단위로 읽는다. HTTP 본문 바이트 → UTF-8 문자열 → 줄 규칙(data 줄, 빈 줄이 이벤트 끝) → JSON 객체 순서다.
// 이 형식은 API 공통이고, 이벤트 이름과 내용의 해석은 API별 호출자(responses-stream, anthropic-stream)가 한다.

// JSON 이벤트가 필드 조회 가능한 객체인지 확인한다.
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// UTF-8 조각과 줄바꿈 경계를 합쳐 SSE의 data 필드만 이벤트 단위로 읽는다. event/id/retry 필드와 ':' 주석은 내용이 아니다.
export async function* readSseEvents(response: Response, label = "Responses SSE"): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) throw new Error(`${label} 본문이 없습니다.`);
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
        // CR 뒤에 LF가 이어질 수 있으므로 조각 끝의 CR은 다음 조각을 기다린다.
        if (end < 0 || (!done && buffer[end] === "\r" && end === buffer.length - 1)) break;
        const line = buffer.slice(0, end);
        const width = buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1;
        buffer = buffer.slice(end + width);
        if (line === "") {
          if (!data.length) continue;
          const payload = data.join("\n");
          data = [];
          // [DONE]은 SSE 규격이 아니라 OpenAI Chat Completions의 종료 표시다.
          if (payload === "[DONE]") return;
          let event: unknown;
          try { event = JSON.parse(payload); }
          catch { throw new Error(`${label} 이벤트가 올바른 JSON이 아닙니다.`); }
          if (!isObject(event) || typeof event.type !== "string") {
            throw new Error(`${label} 이벤트 형식이 잘못되었습니다.`);
          }
          yield event;
        } else if (line === "data" || line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
    }
  } finally {
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
