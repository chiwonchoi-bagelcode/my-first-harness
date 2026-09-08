import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createResponsesAdapter } from "../adapters/responses.ts";
import { createModelAdapter } from "../model-config.ts";
import { textOf } from "../llm-types.ts";
import type { LLMRequest } from "../llm-types.ts";

const config = { provider: "stream-test", baseURL: "https://example.invalid/v1", model: "gpt-5.6-luna", apiKey: "test-key", stream: true };
const empty: LLMRequest = { system: "", messages: [], tools: [] };
const message = { type: "message", id: "msg_1", role: "assistant", status: "completed", phase: "final_answer",
  content: [{ type: "output_text", text: "안녕 🌞", annotations: [] }] };
const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "test-cipher" };
const call = { type: "function_call", id: "fc_1", status: "completed", call_id: "call_1", name: "probe", arguments: '{"label":"한글"}' };

// 공백 줄까지 포함한 SSE 이벤트를 만든다.
function frame(event: object, newline = "\n") {
  return `event: ${(event as any).type}${newline}data: ${JSON.stringify(event)}${newline}${newline}`;
}

// 완성된 Responses 응답을 담은 종료 이벤트를 만든다.
function completed(output: object[] = [message]) {
  return { type: "response.completed", response: { status: "completed", output } };
}

// 실제 바이트를 작은 청크로 쪼개 UTF-8 및 이벤트 경계가 네트워크 경계와 다르게 만든다.
function stream(text: string, chunkSize = 7, onCancel = () => {}) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    // 소비자가 읽을 때 다음 바이트 조각만 전달한다.
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset = Math.min(bytes.length, offset + chunkSize);
    },
    cancel: onCancel,
  }), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

test("SSE의 UTF-8 분할·LF/CRLF/CR·주석·여러 data 줄을 처리한다", async (t) => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    const payload = JSON.stringify(completed(), null, 2).split("\n").map((line) => `data: ${line}`).join(newline);
    const mock = t.mock.method(globalThis, "fetch", async () => stream(
      `: keepalive${newline}${newline}event: response.completed${newline}${payload}${newline}${newline}`, 1));
    const result = await createResponsesAdapter(config).generate(empty);
    assert.equal(result.stopReason, "stop");
    assert.equal(textOf(result.message), "안녕 🌞");
    mock.mock.restore();
  }
});

test("Farm은 전용 주소·키·SSE를 사용하고 출력 한도는 보내지 않는다", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
    assert.equal(url, "https://bakery-codex-farm.bagelcode.ai/v1/responses");
    assert.equal(init.headers.Authorization, "Bearer test-farm-key");
    const body = JSON.parse(init.body);
    assert.equal(body.model, "gpt-5.6-luna");
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    assert.equal(body.max_output_tokens, undefined);
    assert.equal(body.previous_response_id, undefined);
    assert.ok(Array.isArray(body.input));
    assert.equal(body.tools[0].strict, false);
    return stream(frame(completed()));
  });
  const result = await createModelAdapter("farm", "test-farm-key").generate({ ...empty, maxOutputTokens: 100,
    tools: [{ name: "probe", description: "테스트", parameters: { type: "object", properties: {} } }] });
  assert.equal(result.message.replayState?.provider, "bakery-farm");
  assert.equal(result.stopReason, "stop");
});

test("메인 선택 코드가 farm에 BCF 키를 쓰며 누락 시 AIProxy 키로 대체하지 않는다", async () => {
  const source = await readFile(new URL("../my-first-harness.ts", import.meta.url), "utf8");
  const selection = source.slice(source.indexOf("const modelChoice ="), source.indexOf("const history ="));
  const choose = new Function("process", "createModelAdapter", `${selection}\nreturn adapter;`);
  for (const choice of [undefined, "luna", "haiku", "farm"]) {
    const value = choose({ argv: ["node", "main.ts", choice], env: { AIPROXY_TOKEN: "proxy", BCF_API_KEY: "farm" } },
      (name: string, key: string) => ({ name, key }));
    assert.deepEqual(value, { name: choice ?? "farm", key: choice === undefined || choice === "farm" ? "farm" : "proxy" });
  }
  assert.equal(choose({ argv: ["node", "main.ts", "farm"], env: { AIPROXY_TOKEN: "proxy" } },
    (_name: string, key: string | undefined) => key), undefined);
  for (const [args, expected] of [
    [["--tui"], "farm"], [["--tui", "haiku"], "haiku"], [["luna", "--tui"], "luna"],
  ] as const) {
    assert.deepEqual(choose({ argv: ["node", "main.ts", ...args], env: { AIPROXY_TOKEN: "proxy", BCF_API_KEY: "farm" } },
      (name: string, key: string) => ({ name, key })), { name: expected, key: expected === "farm" ? "farm" : "proxy" });
  }
});

test("완료 항목을 합쳐 복수 툴·reasoning을 보존하고 JSON 왕복 후 호출 ID별 결과를 재전송한다", async (t) => {
  const output = [reasoning, { ...message, phase: "commentary" }, call, { ...call, id: "fc_2", call_id: "call_2" }];
  let count = 0;
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    if (++count === 1) return stream(
      frame({ type: "response.created", response: { status: "in_progress" } })
      + frame({ type: "response.function_call_arguments.delta", delta: "{partial" })
      + output.map((item, output_index) => frame({ type: "response.output_item.done", output_index, item })).join("")
      + frame(completed([])));
    assert.deepEqual(body.input, [...output,
      { type: "function_call_output", call_id: "call_1", output: "結果 A" },
      { type: "function_call_output", call_id: "call_2", output: "툴 오류: B" }]);
    return stream(frame(completed()));
  });
  const adapter = createResponsesAdapter(config);
  const first = await adapter.generate(empty);
  assert.equal(first.stopReason, "tool-calls");
  assert.equal(first.message.content.filter((block) => block.type === "tool-call").length, 2);
  const result = await adapter.generate({ ...empty, messages: JSON.parse(JSON.stringify([
    first.message, { role: "tool", content: [
      { type: "tool-result", toolCallId: "call_1", content: "結果 A" },
      { type: "tool-result", toolCallId: "call_2", content: "B", isError: true },
    ] },
  ])) });
  assert.equal(result.stopReason, "stop");
});

test("SSE incomplete는 실행 가능한 툴 호출로 반환하지 않는다", async (t) => {
  t.mock.method(globalThis, "fetch", async () => stream(frame({ type: "response.incomplete", response: {
    status: "incomplete", output: [call], incomplete_details: { reason: "max_output_tokens" },
  } })));
  assert.equal((await createResponsesAdapter(config).generate(empty)).stopReason, "max-tokens");
});

test("Farm이 SSE 본문을 text/plain으로 반환해도 명시한 stream 설정으로 읽는다", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(frame(completed()), {
    headers: { "content-type": "text/plain; charset=UTF-8" },
  }));
  assert.equal((await createModelAdapter("farm", "test-key").generate(empty)).stopReason, "stop");
});

test("HTTP 오류와 HTTP 200 안의 SSE 오류·중간 단절·손상된 이벤트를 실패로 처리한다", async (t) => {
  const cases: [() => Response, RegExp][] = [
    [() => Response.json({ error: { message: "invalid key" } }, { status: 401 }), /invalid key/],
    [() => stream(frame({ type: "error", message: "overloaded" })), /overloaded/],
    [() => stream(frame({ type: "response.failed", response: { status: "failed", error: { message: "failed generation" } } })), /failed generation/],
    [() => stream(frame({ type: "response.output_item.done", output_index: 0, item: call })), /완료 이벤트 없이/],
    [() => stream("data: [DONE]\n\n"), /완료 이벤트 없이/],
    [() => stream("data: {broken}\n\n"), /올바른 JSON/],
    [() => stream("data: null\n\n"), /이벤트 형식/],
    [() => stream(frame(completed()).slice(0, -1)), /완료 이벤트 없이/],
    [() => stream(frame({ type: "response.completed", response: { status: "in_progress", output: [call] } })), /상태가 일치/],
    [() => stream(frame({ type: "response.output_item.done", output_index: 2, item: call }) + frame(completed([]))), /누락/],
  ];
  for (const [response, pattern] of cases) {
    const mock = t.mock.method(globalThis, "fetch", async () => response());
    await assert.rejects(createResponsesAdapter(config).generate(empty), pattern);
    mock.mock.restore();
  }
});

test("완료 이벤트가 오면 서버의 연결 종료를 더 기다리지 않고 reader를 정리한다", async (t) => {
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    // 서버가 완료 이벤트 뒤에도 연결을 열어 두는 상황이다.
    start(controller) { controller.enqueue(new TextEncoder().encode(frame(completed()))); },
    // 소비자가 읽기를 중단했는지 확인한다.
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "text/event-stream" } }));
  assert.equal((await createResponsesAdapter(config).generate(empty)).stopReason, "stop");
  assert.ok(cancelled);
});

test("Farm과 AIProxy 사이에서는 암호화된 replay를 재사용하지 않는다", async (t) => {
  let count = 0;
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    if (++count === 1) return stream(frame(completed([reasoning, message])));
    assert.doesNotMatch(JSON.stringify(JSON.parse(init.body).input), /test-cipher|encrypted_content/);
    return stream(frame(completed()));
  });
  const first = await createModelAdapter("farm", "test-key").generate(empty);
  await createModelAdapter("luna", "test-key").generate({ ...empty, messages: [first.message] });
});
