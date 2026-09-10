import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createResponsesAdapter } from "../adapters/responses.ts";
import { textOf } from "../llm-types.ts";
import type { LLMRequest, Message } from "../llm-types.ts";
import { validateToolArguments } from "../tool-schema.ts";

// 명시적으로 실행할 때만 실제 API를 네 번 호출한다. 개인 파일·세션·MCP에는 접근하지 않는다.
async function main() {
  const checkReasoning = process.argv.includes("--reasoning");
  const token = process.env.AIPROXY_TOKEN;
  assert.ok(token, ".env의 AIPROXY_TOKEN을 설정하세요.");
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let encryptedItems = 0;
  let replayedEncryptedItems = 0;
  // 테스트 요청의 시간과 형태를 확인하고 키·원문·암호화 문자열 대신 상태만 출력한다.
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal(body.previous_response_id, undefined);
    replayedEncryptedItems += body.input.filter((item: any) => item.type === "reasoning" && item.encrypted_content).length;
    const response = await originalFetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    // 본문은 SSE다. 진단 출력용으로만 이벤트를 나눠 완료 응답과 조각 수를 읽는다. 어댑터는 원본 응답을 그대로 읽는다.
    const events = (await response.clone().text()).split(/\r?\n\r?\n/)
      .map((block) => block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n"))
      .filter((payload) => payload && payload !== "[DONE]").map((payload) => { try { return JSON.parse(payload); } catch { return {}; } });
    const data = events.find((event: any) => event.type === "response.completed")?.response ?? events.at(-1) ?? {};
    const encrypted = (data.output ?? []).filter((item: any) => item.type === "reasoning" && item.encrypted_content).length;
    encryptedItems += encrypted;
    console.log(JSON.stringify({ request: ++requests, http: response.status, contentType: response.headers.get("content-type"), status: data.status,
      model: data.model, effort: data.reasoning?.effort, outputTypes: (data.output ?? []).map((item: any) => item.type), encryptedItems: encrypted,
      textDeltaEvents: events.filter((event: any) => event.type === "response.output_text.delta").length }));
    if (response.ok) assert.match(data.model, /^gpt-5\.6-luna(?:-|$)/);
    return response;
  };
  try {
    // model-config.ts의 luna 연결과 같은 stream 설정으로 AIProxy가 SSE를 통과시키는지 확인한다.
    const adapter = createResponsesAdapter({
      provider: "bagel-openai", baseURL: "https://aiproxy-api.backoffice.bagelgames.com/openai/v1",
      model: "gpt-5.6-luna", apiKey: token, stream: true, reasoningEffort: checkReasoning ? "high" : undefined,
    });
    const request: LLMRequest = {
      system: "Follow the user's request. Keep answers short.",
      messages: [{ role: "user", content: [{ type: "text", text: checkReasoning
        ? "Find the smallest positive integer n such that n mod 97 = 31, n mod 89 = 17, and n mod 83 = 52. Reply with only the integer."
        : "Reply with exactly pong." }] }],
      tools: [], maxOutputTokens: 4096,
    };
    // 텍스트 조각이 도착 순서대로 콜백에 오고 합치면 완성본과 같은지 확인한다.
    const deltas: string[] = [];
    const first = await adapter.generate(request, { async onRequest() {}, async onResponse() {}, onTextDelta: (text) => { deltas.push(text); } });
    assert.equal(first.stopReason, "stop");
    assert.match(textOf(first.message), checkReasoning ? /213528/ : /pong/i);
    assert.ok(deltas.length > 0, "SSE 텍스트 조각이 onTextDelta로 전달되어야 합니다.");
    assert.equal(deltas.join(""), textOf(first.message), "조각을 합친 결과가 완성 텍스트와 같아야 합니다.");
    console.log(`PASS: 스트리밍 조각 ${deltas.length}개 수신, 합친 결과가 완성본과 일치`);

    const parameters = { type: "object", properties: { label: { type: "string" } }, required: ["label"] };
    request.tools = [{ name: "readProbe", description: "Read a fresh verification value for the given label.", parameters }];
    request.messages.push(first.message, { role: "user", content: [{ type: "text", text:
      "Call readProbe once with label adapter-smoke. Then report the exact value returned by that tool. Do not invent the value." }] });
    // 디스크 저장/resume과 같은 JSON 왕복 뒤에도 원본 출력 항목이 재전송되는지 확인한다.
    request.messages = JSON.parse(JSON.stringify(request.messages));
    const second = await adapter.generate(request);
    assert.equal(second.stopReason, "tool-calls");
    const calls = second.message.content.filter((block) => block.type === "tool-call");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "readProbe");
    const args = JSON.parse(calls[0].arguments);
    assert.equal(validateToolArguments(parameters, args), undefined);
    assert.equal(args.label, "adapter-smoke");
    const value = randomUUID();
    const toolResult: Message = { role: "tool", content: [{ type: "tool-result", toolCallId: calls[0].id, content: value }] };
    request.messages.push(second.message, toolResult);
    request.messages = JSON.parse(JSON.stringify(request.messages));
    const final = await adapter.generate(request);
    assert.equal(final.stopReason, "stop");
    assert.ok(textOf(final.message).includes(value), "최종 응답이 실제 툴 결과를 포함해야 합니다.");
    request.messages.push(final.message, { role: "user", content: [{ type: "text", text:
      "What exact value did the tool return in the previous turn? Reply with that value only." }] });
    request.messages = JSON.parse(JSON.stringify(request.messages));
    request.tools = [];
    const continued = await adapter.generate(request);
    assert.equal(continued.stopReason, "stop");
    assert.ok(textOf(continued.message).includes(value), "이전 턴의 툴 결과도 다시 사용할 수 있어야 합니다.");
    assert.equal(requests, 4);
    console.log(`encrypted reasoning: ${encryptedItems}개 수신, ${replayedEncryptedItems}개 재전송`);
    if (checkReasoning) assert.ok(replayedEncryptedItems > 0, "encrypted reasoning이 실제 다음 요청에 포함되어야 합니다.");
    else if (!replayedEncryptedItems) console.log("참고: reasoning 미생성. 실제 재전송 검증은 --reasoning 옵션으로 별도 실행하세요.");
    console.log(`PASS: 텍스트 → 인자 있는 툴 요청 → 실제 결과를 사용한 최종 응답 → 다음 턴 (${requests} HTTP 요청)`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

await main();
