import assert from "node:assert/strict";
import test from "node:test";
import { createAnthropicMessagesAdapter } from "../adapters/anthropic-messages.ts";
import { createModelAdapter } from "../model-config.ts";
import { textOf, withoutReplayState } from "../llm-types.ts";
import type { LLMRequest, Message } from "../llm-types.ts";
import { builtinToolDefinitions } from "./builtin-tool-definitions.ts";

const config = { provider: "test", baseURL: "https://example.invalid/v1/", model: "claude-haiku-4-5-20251001", apiKey: "test-key" };
const empty: LLMRequest = { system: "", messages: [], tools: [] };
// 모의 Messages 응답을 만든다.
const reply = (content: unknown[] = [{ type: "text", text: "답변" }], stop_reason = "end_turn") => Response.json({
  type: "message", role: "assistant", content, stop_reason,
});
// 모델의 객체 형태 인자를 가진 모의 tool_use 블록을 만든다.
const call = (id = "a", input: unknown = { amount: 3 }) => ({ type: "tool_use", id, name: "increase", input });
const thinking = { type: "thinking", thinking: "test reasoning", signature: "test-signature" };
// 모의 Messages SSE 응답을 만든다. model-config의 haiku는 stream을 켜므로 이벤트 순서대로 텍스트 블록 하나를 보낸다.
const sseReply = (text = "답변", stop_reason = "end_turn") => new Response([
  { type: "message_start", message: { type: "message", role: "assistant", model: config.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

test("실제 기본 툴 전체에 객체 스키마가 있으며 인자 없는 툴도 Anthropic 필수 type을 보낸다", async (t) => {
  const definitions = builtinToolDefinitions();
  assert.equal(definitions.length, 13);
  assert.ok(definitions.some((tool) => tool.name === "readImage"));
  assert.ok(definitions.some((tool) => tool.name === "editTextFile"));
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    for (const tool of body.tools) {
      assert.equal(tool.input_schema.type, "object", `${tool.name}: input_schema.type 누락`);
    }
    assert.deepEqual(body.tools.map((tool: any) => tool.name), definitions.map((tool) => tool.name));
    return reply();
  });
  for (const name of ["counterUP", "getCounterVal", "getCurrentTime", "listJobs"]) {
    assert.deepEqual(definitions.find((tool) => tool.name === name)?.parameters, { type: "object", properties: {} });
  }
  await createAnthropicMessagesAdapter(config).generate({ ...empty, tools: definitions });
});

test("system·input_schema·필수 max_tokens를 변환하고 프록시 Bearer 인증을 쓴다", async (t) => {
  const parameters = { type: "object", properties: { path: { type: "string" } } };
  t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
    assert.equal(url, "https://example.invalid/v1/messages");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Bearer test-key");
    assert.equal(init.headers["x-api-key"], undefined);
    assert.equal(init.headers["anthropic-version"], "2023-06-01");
    assert.deepEqual(JSON.parse(init.body), {
      model: config.model, system: "지침", max_tokens: 100,
      messages: [{ role: "user", content: [{ type: "text", text: "질문" }, { type: "text", text: "입니다" }] }],
      tools: [{ name: "read", description: "조회", input_schema: parameters }],
    });
    return reply();
  });
  const result = await createAnthropicMessagesAdapter({ ...config, auth: "bearer", maxOutputTokens: 500 }).generate({
    system: "지침", messages: [{ role: "user", content: [{ type: "text", text: "질문" }, { type: "text", text: "입니다" }] }],
    tools: [{ name: "read", description: "조회", parameters }], maxOutputTokens: 100,
  });
  assert.equal(result.stopReason, "stop");
  assert.equal(textOf(result.message), "답변");
  assert.equal("required" in parameters, false);
});

test("일반 API 키 인증과 출력 한도 기본값을 적용한다", async (t) => {
  let body: any;
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    assert.equal(init.headers["x-api-key"], "test-key");
    assert.equal(init.headers.Authorization, undefined);
    body = JSON.parse(init.body);
    return reply();
  });
  await createAnthropicMessagesAdapter(config).generate(empty);
  assert.equal(body.max_tokens, 4096);
  for (const absent of ["tools", "system", "store", "previous_response_id", "thinking"]) assert.equal(body[absent], undefined);
  await createAnthropicMessagesAdapter({ ...config, maxOutputTokens: 500 }).generate(empty);
  assert.equal(body.max_tokens, 500);
});

test("복수 툴 결과를 한 user 메시지에 모으고 오류와 ID 및 원본 블록 순서를 유지한다", async (t) => {
  const native = [thinking, { type: "redacted_thinking", data: "test-cipher" },
    { type: "text", text: "확인 중" }, call("a"), call("b", {})];
  const bodies: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return bodies.length === 1 ? reply(native, "tool_use") : reply();
  });
  const adapter = createAnthropicMessagesAdapter(config);
  const first = await adapter.generate(empty);
  assert.equal(first.stopReason, "tool-calls");
  assert.deepEqual(first.message.content, [{ type: "text", text: "확인 중" },
    { type: "tool-call", id: "a", name: "increase", arguments: '{"amount":3}' },
    { type: "tool-call", id: "b", name: "increase", arguments: "{}" }]);
  const messages: Message[] = [JSON.parse(JSON.stringify(first.message)),
    { role: "tool", content: [{ type: "tool-result", toolCallId: "a", content: "3" }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "b", content: "인자 오류", isError: true }] },
    { role: "user", content: [{ type: "text", text: "계속" }] }];
  const before = structuredClone(messages);
  await adapter.generate({ ...empty, messages });
  assert.deepEqual(bodies[1].messages, [{ role: "assistant", content: native }, { role: "user", content: [
    { type: "tool_result", tool_use_id: "a", content: "3" },
    { type: "tool_result", tool_use_id: "b", content: "인자 오류", is_error: true },
    { type: "text", text: "계속" },
  ] }]);
  assert.deepEqual(messages, before);
  assert.doesNotMatch(JSON.stringify(withoutReplayState(messages)), /signature|test reasoning|test-cipher/);
});

test("다른 출처·수정된 공통 내용·손상된 replay는 공통 블록으로 변환한다", async (t) => {
  let body: any;
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    body = JSON.parse(init.body);
    return reply([thinking, { type: "text", text: "원본" }, call()], "tool_use");
  });
  const adapter = createAnthropicMessagesAdapter(config);
  const message = (await adapter.generate(empty)).message;
  const replay = message.replayState!;
  for (const replacement of [
    { ...message, content: [{ type: "text" as const, text: "편집됨" }] },
    { ...message, replayState: { ...replay, adapter: "responses" } },
    { ...message, replayState: { ...replay, provider: "other" } },
    { ...message, replayState: { ...replay, model: "other" } },
    { ...message, replayState: { ...replay, data: { contentKey: JSON.stringify(message.content), content: [{ type: "system" }] } } },
    { ...message, replayState: { ...replay, data: { contentKey: JSON.stringify(message.content), content: [{ type: "text", text: "변조" }] } } },
  ]) {
    await adapter.generate({ ...empty, messages: [replacement] });
    assert.deepEqual(body.messages[0].content, replacement.content.map((block) => block.type === "text"
      ? { type: "text", text: block.text }
      : { type: "tool_use", id: block.id, name: block.name, input: JSON.parse(block.arguments) }));
    assert.doesNotMatch(JSON.stringify(body.messages), /signature|replayState|test reasoning/);
  }
});

test("잘못된 타입의 인자 값은 ToolManager의 기존 스키마 검증을 위해 보존한다", async (t) => {
  t.mock.method(globalThis, "fetch", async () => reply([call("a", { amount: "bad" })], "tool_use"));
  const result = await createAnthropicMessagesAdapter(config).generate(empty);
  assert.deepEqual(result.message.content, [{ type: "tool-call", id: "a", name: "increase", arguments: '{"amount":"bad"}' }]);
});

test("종료 이유를 구분하고 잘린 툴 호출·pause_turn·알 수 없는 사유는 실행하지 않는다", async (t) => {
  for (const [native, expected] of [["end_turn", "stop"], ["stop_sequence", "stop"], ["refusal", "stop"],
    ["max_tokens", "max-tokens"], ["pause_turn", "other"], ["model_context_window_exceeded", "other"], ["unknown", "other"]]) {
    const mock = t.mock.method(globalThis, "fetch", async () => reply([{ type: "text", text: "응답" }], native));
    assert.equal((await createAnthropicMessagesAdapter(config).generate(empty)).stopReason, expected);
    mock.mock.restore();
  }
  const mock = t.mock.method(globalThis, "fetch", async () => reply([call()], "max_tokens"));
  assert.equal((await createAnthropicMessagesAdapter(config).generate(empty)).stopReason, "max-tokens");
  mock.mock.restore();
  t.mock.method(globalThis, "fetch", async () => reply([]));
  assert.equal((await createAnthropicMessagesAdapter(config).generate(empty)).stopReason, "other");
});

test("HTTP·형식·호출 ID 오류와 모순된 종료 사유를 명시적으로 거부한다", async (t) => {
  const cases: [() => Response, RegExp][] = [
    [() => Response.json({ type: "error", error: { message: "인증 실패" } }, { status: 401 }), /인증 실패/],
    [() => new Response("gateway", { status: 502 }), /HTTP 502/],
    [() => Response.json({ type: "message", role: "user", content: [] }), /메시지 형식/],
    [() => Response.json(null), /LLM 요청 실패/],
    [() => reply([call("a", null)], "tool_use"), /블록 형식/],
    [() => reply([{ type: "server_tool_use" }]), /블록 형식/],
    [() => reply([{ type: "thinking", thinking: "x" }]), /블록 형식/],
    [() => reply([call(), call()], "tool_use"), /ID가 중복/],
    [() => reply([], "tool_use"), /호출 내용이 없습니다/],
    [() => reply([call()], "end_turn"), /정상 종료와 툴 호출/],
  ];
  for (const [response, pattern] of cases) {
    const mock = t.mock.method(globalThis, "fetch", async () => response());
    await assert.rejects(createAnthropicMessagesAdapter(config).generate(empty), pattern);
    mock.mock.restore();
  }
});

test("키 누락이나 변환할 수 없는 이전 호출 인자가 있으면 요청을 보내지 않는다", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => { throw new Error("호출되면 안 됨"); });
  await assert.rejects(createAnthropicMessagesAdapter({ ...config, apiKey: undefined }).generate(empty), /인증 키/);
  for (const args of ["broken", "null", "[]"]) {
    await assert.rejects(createAnthropicMessagesAdapter(config).generate({ ...empty, messages: [{ role: "assistant", content: [
      { type: "tool-call", id: "a", name: "read", arguments: args },
    ] }] }), /이전 툴 호출 인자/);
  }
  assert.equal(mock.mock.callCount(), 0);
});

test("모델 선택은 Luna/Haiku/Fable별 주소·모델·인증·기본 출력 한도를 적용한다", async (t) => {
  const urls: string[] = [];
  const models: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
    urls.push(url);
    const body = JSON.parse(init.body);
    models.push(body.model);
    assert.equal(init.headers.Authorization, "Bearer test-token");
    if (url.endsWith("/responses")) {
      assert.equal(body.model, "gpt-5.6-luna");
      assert.equal(body.max_output_tokens, undefined);
      // AIProxy Luna도 stream을 켜므로 완료 이벤트 하나짜리 SSE로 답한다.
      assert.equal(body.stream, true);
      const completed = { type: "response.completed", response: { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] } };
      return new Response(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    assert.equal(body.max_tokens, 32_000);
    assert.equal(body.stream, true);
    return sseReply();
  });
  await createModelAdapter("luna", "test-token").generate(empty);
  await createModelAdapter("haiku", "test-token").generate(empty);
  await createModelAdapter("fable", "test-token").generate(empty);
  assert.deepEqual(urls, ["https://aiproxy-api.backoffice.bagelgames.com/openai/v1/responses",
    "https://aiproxy-api.backoffice.bagelgames.com/anthropic/v1/messages",
    "https://aiproxy-api.backoffice.bagelgames.com/anthropic/v1/messages"]);
  assert.deepEqual(models, ["gpt-5.6-luna", config.model, "claude-fable-5-1"]);
  assert.throws(() => createModelAdapter("haik", "test-token"), /지원하지 않는 모델/);
});

test("웹 검색 서버 툴은 함수 툴 뒤에 붙고, 검색 블록은 공통 내용에 나타나지 않으며 재전송 정보와 사용량에 남는다", async (t) => {
  const bodies: any[] = [];
  const searchReply = () => Response.json({ type: "message", role: "assistant", stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 20, server_tool_use: { web_search_requests: 1 } },
    content: [
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "tetris heuristics" } },
      { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "https://example.com", title: "t" }] },
      { type: "text", text: "찾았다", citations: [{ type: "web_search_result_location", url: "https://example.com" }] },
    ] });
  const mock = t.mock.method(globalThis, "fetch", async (_url: any, init: any) => { bodies.push(JSON.parse(init.body)); return searchReply(); });
  const adapter = createAnthropicMessagesAdapter({ ...config, webSearch: { type: "web_search_20250305", maxUses: 5 } });
  const result = await adapter.generate({ ...empty, tools: [{ name: "readTextFile", description: "d", parameters: { type: "object", properties: {} } }] });
  assert.deepEqual(bodies[0].tools, [
    { name: "readTextFile", description: "d", input_schema: { type: "object", properties: {} } },
    { type: "web_search_20250305", name: "web_search", max_uses: 5 },
  ]);
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.message.content, [{ type: "text", text: "찾았다" }]);
  assert.equal((result.message.replayState?.data as any).content.length, 3, "검색 블록은 재전송 정보에 남는다.");
  assert.equal(result.usage?.webSearchRequests, 1);
  // 함수 툴이 없어도 검색 툴만으로 tools를 보낸다.
  await adapter.generate(empty);
  assert.deepEqual(bodies[1].tools, [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]);
  mock.mock.restore();
});

test("Haiku 기본 한도보다 요청별 한도를 우선하며 다음 요청의 기본값은 유지한다", async (t) => {
  const limits: number[] = [];
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    limits.push(JSON.parse(init.body).max_tokens);
    return sseReply();
  });
  const adapter = createModelAdapter("haiku", "test-token");
  await adapter.generate({ ...empty, maxOutputTokens: 2048 });
  await adapter.generate({ ...empty, maxOutputTokens: 64_000 });
  await adapter.generate(empty);
  assert.deepEqual(limits, [2048, 64_000, 32_000]);
});
