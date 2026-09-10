import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createModelAdapter } from "../model-config.ts";
import { textOf } from "../llm-types.ts";
import type { LLMRequest } from "../llm-types.ts";
import { validateToolArguments } from "../tool-schema.ts";

// Farm에 네 번 요청해 텍스트·툴 인자·결과·다음 턴을 검증하며 개인 파일과 세션은 보내지 않는다.
async function main() {
  const key = process.env.BCF_API_KEY;
  assert.ok(key, ".env의 BCF_API_KEY를 설정하세요.");
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let replayedReasoning = 0;
  // 승인된 Farm 주소에만 요청하며 키와 요청·응답 원문 대신 HTTP 상태만 출력한다.
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://bakery-codex-farm.bagelcode.ai/v1/responses");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.stream, true);
    assert.equal(body.previous_response_id, undefined);
    assert.equal(body.max_output_tokens, undefined);
    replayedReasoning += body.input.filter((item: any) => item.type === "reasoning" && item.encrypted_content).length;
    const response = await originalFetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    console.log(JSON.stringify({ request: ++requests, http: response.status, contentType: response.headers.get("content-type") }));
    // Farm의 Content-Type이 text/plain이어도 실제 SSE 파싱과 완료 응답 검증으로 판정한다.
    return response;
  };
  try {
    const adapter = createModelAdapter("farm", key);
    const request: LLMRequest = { system: "Follow the user's request. Keep answers short.", tools: [], messages: [
      { role: "user", content: [{ type: "text", text: "Reply with exactly pong." }] },
    ] };
    // 텍스트 조각이 도착 순서대로 콜백에 오고 합치면 완성본과 같은지 확인한다.
    const deltas: string[] = [];
    const first = await adapter.generate(request, { async onRequest() {}, async onResponse() {}, onTextDelta: (text) => { deltas.push(text); } });
    assert.equal(first.stopReason, "stop");
    assert.match(textOf(first.message), /pong/i);
    assert.ok(deltas.length > 0, "SSE 텍스트 조각이 onTextDelta로 전달되어야 합니다.");
    assert.equal(deltas.join(""), textOf(first.message), "조각을 합친 결과가 완성 텍스트와 같아야 합니다.");
    console.log(`PASS: 텍스트 응답 (스트리밍 조각 ${deltas.length}개, 합친 결과가 완성본과 일치)`);
    const parameters = { type: "object", properties: { label: { type: "string" } }, required: ["label"] };
    request.tools = [{ name: "readProbe", description: "Read a fresh verification value for the given label.", parameters }];
    request.messages.push(first.message, { role: "user", content: [{ type: "text", text:
      "Call readProbe once with label farm-smoke. Then report the exact returned value. Do not invent it." }] });
    request.messages = JSON.parse(JSON.stringify(request.messages));
    const second = await adapter.generate(request);
    assert.equal(second.stopReason, "tool-calls");
    const calls = second.message.content.filter((block) => block.type === "tool-call");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "readProbe");
    const args = JSON.parse(calls[0].arguments);
    assert.equal(validateToolArguments(parameters, args), undefined);
    assert.equal(args.label, "farm-smoke");
    console.log("PASS: 인자가 있는 툴 요청");
    const value = randomUUID();
    request.messages.push(second.message, { role: "tool", content: [{ type: "tool-result", toolCallId: calls[0].id, content: value }] });
    request.messages = JSON.parse(JSON.stringify(request.messages));
    const third = await adapter.generate(request);
    assert.equal(third.stopReason, "stop");
    assert.ok(textOf(third.message).includes(value), "최종 답변에 실제 툴 결과가 있어야 합니다.");
    console.log("PASS: 툴 결과와 reasoning 재전송 후 최종 답변");
    request.messages.push(third.message, { role: "user", content: [{ type: "text", text: "What exact value did that tool return? Reply with that value only." }] });
    request.messages = JSON.parse(JSON.stringify(request.messages));
    request.tools = [];
    const fourth = await adapter.generate(request);
    assert.equal(fourth.stopReason, "stop");
    assert.ok(textOf(fourth.message).includes(value));
    assert.equal(requests, 4);
    console.log(`PASS: 다음 턴까지 대화 유지 (${requests} HTTP 요청, reasoning 항목 ${replayedReasoning}회 재전송)`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// 실패 진단에도 인증 키가 포함되지 않도록 치환하고 종료 코드를 남긴다.
await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(process.env.BCF_API_KEY ? message.replaceAll(process.env.BCF_API_KEY, "[REDACTED]") : message);
  process.exitCode = 1;
});
