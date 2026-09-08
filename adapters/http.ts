import type { LLMObserver, WireRequest } from "../llm-types.ts";
import { usageOf } from "./usage.ts";

// 인증 헤더는 전송에만 사용하고 요청 본문·응답·사용량은 해석 전에 관찰자에게 전달한다.
export async function requestJSON(
  request: WireRequest,
  headers: Record<string, string>,
  observer?: LLMObserver,
) {
  // 관찰자 대기 중 원래 객체가 바뀌어도 기록과 실제 전송 내용이 같도록 먼저 직렬화한다.
  const body = JSON.stringify(request.body);
  await observer?.onRequest({ ...request, body: JSON.parse(body) });
  const response = await fetch(request.url, { method: "POST", headers, body });
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
