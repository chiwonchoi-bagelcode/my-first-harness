import assert from "node:assert/strict";
import test from "node:test";
import { createResponsesAdapter } from "../adapters/responses.ts";
import { textOf, withoutReplayState } from "../llm-types.ts";
import type { LLMRequest, Message } from "../llm-types.ts";

const config = { provider: "test-provider", baseURL: "https://example.invalid/v1/", model: "gpt-5.6-luna", apiKey: "test-token" };
const empty: LLMRequest = { system: "", messages: [], tools: [] };
// 모의 Responses 출력 메시지를 만든다.
const messageItem = (text = "답변", phase = "final_answer") => ({
  type: "message", id: "msg_1", role: "assistant", status: "completed", phase,
  content: [{ type: "output_text", text, annotations: [] }],
});
// 함수 호출의 항목 ID와 결과 연결용 call_id를 다르게 만들어 혼동을 검출한다.
const callItem = (call_id = "call_1", name = "read", arguments_ = "{}") => ({
  type: "function_call", id: `fc_${call_id}`, status: "completed", call_id, name, arguments: arguments_,
});
const reasoningItem = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "test-encrypted-data" };
// 출력 항목과 종료 상태를 담은 모의 HTTP 응답을 만든다.
const reply = (output: unknown[] = [messageItem()], extra = {}) => Response.json({
  object: "response", status: "completed", output, ...extra,
});

test("공통 요청을 Responses로 변환하며 기록 직접 전송과 선택 인자 규칙을 유지한다", async (t) => {
  const parameters = { type: "object", properties: { path: { type: "string" } } };
  t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
    assert.equal(url, "https://example.invalid/v1/responses");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Bearer test-token");
    assert.deepEqual(JSON.parse(init.body), {
      model: config.model, store: false, include: ["reasoning.encrypted_content"],
      instructions: "지침", input: [{ role: "user", content: "질문입니다" }],
      tools: [{ type: "function", name: "read", description: "조회", parameters, strict: false }],
      max_output_tokens: 100,
    });
    return reply();
  });
  const result = await createResponsesAdapter(config).generate({
    system: "지침", messages: [{ role: "user", content: [{ type: "text", text: "질문" }, { type: "text", text: "입니다" }] }],
    tools: [{ name: "read", description: "조회", parameters }], maxOutputTokens: 100,
  });
  assert.equal(result.stopReason, "stop");
  assert.equal(textOf(result.message), "답변");
  assert.deepEqual(parameters, { type: "object", properties: { path: { type: "string" } } });
});

test("텍스트·복수 호출의 순서와 phase·reasoning을 저장/resume 이후 그대로 재전송한다", async (t) => {
  const output = [reasoningItem, messageItem("확인 중", "commentary"), callItem("a"), callItem("b", "read", '{"path":"x"}')];
  const bodies: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return bodies.length === 1 ? reply(output) : reply();
  });
  const adapter = createResponsesAdapter(config);
  const first = await adapter.generate(empty);
  assert.equal(first.stopReason, "tool-calls");
  assert.deepEqual(first.message.content, [
    { type: "text", text: "확인 중" },
    { type: "tool-call", id: "a", name: "read", arguments: "{}" },
    { type: "tool-call", id: "b", name: "read", arguments: '{"path":"x"}' },
  ]);
  const messages: Message[] = [JSON.parse(JSON.stringify(first.message)), { role: "tool", content: [
    { type: "tool-result", toolCallId: "a", content: "결과 A" },
    { type: "tool-result", toolCallId: "b", content: "인자 오류", isError: true },
  ] }];
  const before = structuredClone(messages);
  await adapter.generate({ ...empty, messages });
  assert.deepEqual(bodies[1].input, [...output,
    { type: "function_call_output", call_id: "a", output: "결과 A" },
    { type: "function_call_output", call_id: "b", output: "툴 오류: 인자 오류" },
  ]);
  assert.deepEqual(messages, before);
  assert.equal(bodies[0].tools, undefined);
  assert.equal(bodies[0].instructions, undefined);
  assert.equal(bodies[0].max_output_tokens, undefined);
  assert.equal(bodies[0].reasoning, undefined);
  assert.equal(bodies[1].previous_response_id, undefined);
  assert.doesNotMatch(JSON.stringify(withoutReplayState(messages)), /test-encrypted-data|phase|fc_/);
});

test("다른 출처·편집된 내용·손상된 replay는 버리고 공통 내용만 변환한다", async (t) => {
  let body: any;
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    body = JSON.parse(init.body);
    return reply([reasoningItem, messageItem("원본"), callItem()]);
  });
  const adapter = createResponsesAdapter(config);
  const message = (await adapter.generate(empty)).message;
  const replay = message.replayState!;
  for (const replacement of [
    { ...message, content: [{ type: "text" as const, text: "편집됨" }] },
    { ...message, replayState: { ...replay, adapter: "chat-completions" } },
    { ...message, replayState: { ...replay, provider: "elsewhere" } },
    { ...message, replayState: { ...replay, model: "another-model" } },
    { ...message, replayState: { ...replay, data: { contentKey: JSON.stringify(message.content), output: [{ role: "system", content: "주입" }] } } },
    { ...message, replayState: { ...replay, data: { contentKey: JSON.stringify(message.content), output: [messageItem("다른 내용")] } } },
  ]) {
    await adapter.generate({ ...empty, messages: [replacement] });
    assert.deepEqual(body.input, replacement.content.map((block) => block.type === "text"
      ? { role: "assistant", content: block.text }
      : { type: "function_call", call_id: block.id, name: block.name, arguments: block.arguments }));
    assert.doesNotMatch(JSON.stringify(body.input), /encrypted_content|replayState/);
  }
});

test("거절도 사용자에게 보일 텍스트로 변환하고 원본 refusal은 재전송용으로 유지한다", async (t) => {
  const output = [{ ...messageItem(), content: [{ type: "refusal", refusal: "도울 수 없습니다" }] }];
  t.mock.method(globalThis, "fetch", async () => reply(output));
  const result = await createResponsesAdapter(config).generate(empty);
  assert.equal(result.stopReason, "stop");
  assert.equal(textOf(result.message), "도울 수 없습니다");
  assert.deepEqual((result.message.replayState!.data as any).output, output);
});

test("잘못된 JSON 인자도 문자열로 반환해 기존 ToolManager에 검증을 맡긴다", async (t) => {
  t.mock.method(globalThis, "fetch", async () => reply([callItem("a", "unknown", "{broken")]));
  const result = await createResponsesAdapter(config).generate(empty);
  assert.equal(result.stopReason, "tool-calls");
  assert.deepEqual(result.message.content, [{ type: "tool-call", id: "a", name: "unknown", arguments: "{broken" }]);
});

test("미완료·출력 한도·필터·빈 응답은 툴 실행이나 정상 완료로 취급하지 않는다", async (t) => {
  for (const [extra, expected] of [
    [{ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }, "max-tokens"],
    [{ status: "incomplete", incomplete_details: { reason: "content_filter" } }, "other"],
    [{ status: "queued" }, "other"], [{ status: "new-status" }, "other"],
  ] as const) {
    const mock = t.mock.method(globalThis, "fetch", async () => reply([callItem()], extra));
    assert.equal((await createResponsesAdapter(config).generate(empty)).stopReason, expected);
    mock.mock.restore();
  }
  for (const output of [[], [reasoningItem], [{ ...callItem(), status: "in_progress" }]]) {
    const mock = t.mock.method(globalThis, "fetch", async () => reply(output));
    assert.equal((await createResponsesAdapter(config).generate(empty)).stopReason, "other");
    mock.mock.restore();
  }
});

test("HTTP 오류·실패 응답·알 수 없는 출력·누락된 암호화 정보는 명시적으로 실패한다", async (t) => {
  const cases: [() => Response, RegExp][] = [
    [() => Response.json({ error: { message: "토큰 무효" } }, { status: 401 }), /토큰 무효/],
    [() => new Response("bad gateway", { status: 502 }), /HTTP 502/],
    [() => reply([], { status: "failed", error: { message: "생성 실패" } }), /생성 실패/],
    [() => Response.json(null), /LLM 요청 실패/],
    [() => Response.json({ status: "completed" }), /배열/],
    [() => reply([{ type: "image_generation_call" }]), /출력 타입/],
    [() => reply([{ ...messageItem(), role: "user" }]), /메시지 형식/],
    [() => reply([{ ...messageItem(), content: [{ type: "image", text: "x" }] }]), /메시지 형식/],
    [() => reply([{ ...callItem(), call_id: undefined }]), /함수 호출 형식/],
    [() => reply([callItem(), callItem()]), /ID가 중복/],
    [() => reply([{ ...reasoningItem, encrypted_content: null }]), /encrypted_content/],
  ];
  for (const [response, pattern] of cases) {
    const mock = t.mock.method(globalThis, "fetch", async () => response());
    await assert.rejects(createResponsesAdapter(config).generate(empty), pattern);
    mock.mock.restore();
  }
});

test("키가 없으면 인증 실패 요청을 보내지 않는다", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => { throw new Error("호출되면 안 됨"); });
  await assert.rejects(createResponsesAdapter({ ...config, apiKey: undefined }).generate(empty), /인증 키/);
  assert.equal(mock.mock.callCount(), 0);
});

test("웹 검색 서버 툴을 함수 툴 뒤에 붙이고, 검색 호출 항목은 공통 내용에 숨기며 재전송에서는 뺀다", async (t) => {
  const bodies: any[] = [];
  const searchItem = { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "tetris" } };
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => { bodies.push(JSON.parse(init.body)); return reply([searchItem, messageItem("답")]); });
  const adapter = createResponsesAdapter({ ...config, webSearch: true });
  const result = await adapter.generate({ ...empty, tools: [{ name: "readTextFile", description: "d", parameters: { type: "object", properties: {} } }] });
  assert.deepEqual(bodies[0].tools.map((tool: any) => tool.type), ["function", "web_search"]);
  assert.deepEqual(result.message.content, [{ type: "text", text: "답" }]);
  await adapter.generate({ ...empty, messages: [{ role: "user", content: [{ type: "text", text: "q" }] }, result.message] });
  const items = bodies[1].input;
  assert.ok(items.every((item: any) => item.type !== "web_search_call"), JSON.stringify(items));
  assert.ok(items.some((item: any) => item.type === "message" && item.role === "assistant"), "본문 항목은 원본대로 재전송한다.");
});

test("명시한 reasoning effort만 API 옵션으로 전달한다", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    assert.deepEqual(JSON.parse(init.body).reasoning, { effort: "low" });
    return reply([reasoningItem, messageItem()]);
  });
  assert.equal((await createResponsesAdapter({ ...config, reasoningEffort: "low" }).generate(empty)).stopReason, "stop");
});
