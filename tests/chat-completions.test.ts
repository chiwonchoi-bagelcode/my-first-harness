import assert from "node:assert/strict";
import test from "node:test";
import { createChatCompletionsAdapter } from "../adapters/chat-completions.ts";
import type { LLMRequest, Message } from "../llm-types.ts";

const config = { provider: "test-provider", baseURL: "https://example.invalid/v1/", model: "gpt-4o", apiKey: "test-token" };
const empty: LLMRequest = { system: "", messages: [], tools: [] };
// 텍스트·종료 이유·추가 필드로 모의 Chat Completions HTTP 응답을 만든다.
const reply = (content: string | null = "답변", finish_reason = "stop", extra = {}) => Response.json({
  choices: [{ finish_reason, message: { role: "assistant", content, ...extra } }],
});

test("공통 요청을 Chat Completions 요청으로 변환한다", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
    assert.equal(url, "https://example.invalid/v1/chat/completions");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Bearer test-token");
    assert.deepEqual(JSON.parse(init.body), {
      model: "gpt-4o", max_completion_tokens: 100,
      messages: [
        { role: "system", content: "지침" },
        { role: "user", content: "질문입니다" },
      ],
      tools: [{ type: "function", function: { name: "counterUP", description: "증가", parameters: { type: "object", properties: {} } } }],
    });
    return reply();
  });
  const result = await createChatCompletionsAdapter(config).generate({
    system: "지침", messages: [{ role: "user", content: [{ type: "text", text: "질문" }, { type: "text", text: "입니다" }] }],
    tools: [{ name: "counterUP", description: "증가", parameters: { type: "object", properties: {} } }], maxOutputTokens: 100,
  });
  assert.deepEqual(result, { stopReason: "stop", message: { role: "assistant", content: [{ type: "text", text: "답변" }] } });
});

test("텍스트와 복수 호출을 변환하고 모든 결과를 호출 ID에 맞춰 재전송한다", async (t) => {
  const bodies: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return bodies.length === 1 ? reply("확인하겠습니다", "tool_calls", { tool_calls: [
      { id: "a", type: "function", function: { name: "counterUP", arguments: "{}" } },
      { id: "b", type: "function", function: { name: "getCounterVal", arguments: "{}" } },
    ] }) : reply("3입니다");
  });
  const adapter = createChatCompletionsAdapter(config);
  const first = await adapter.generate(empty);
  assert.equal(first.stopReason, "tool-calls");
  assert.deepEqual(first.message.content, [
    { type: "text", text: "확인하겠습니다" },
    { type: "tool-call", id: "a", name: "counterUP", arguments: "{}" },
    { type: "tool-call", id: "b", name: "getCounterVal", arguments: "{}" },
  ]);
  const messages: Message[] = [first.message, { role: "tool", content: [
    { type: "tool-result", toolCallId: "a", content: "증가 완료" },
    { type: "tool-result", toolCallId: "b", content: "3" },
  ] }];
  const original = structuredClone(messages);
  await adapter.generate({ ...empty, messages });
  assert.deepEqual(bodies[1].messages, [
    { role: "assistant", content: "확인하겠습니다", tool_calls: [
      { id: "a", type: "function", function: { name: "counterUP", arguments: "{}" } },
      { id: "b", type: "function", function: { name: "getCounterVal", arguments: "{}" } },
    ] },
    { role: "tool", tool_call_id: "a", content: "증가 완료" },
    { role: "tool", tool_call_id: "b", content: "3" },
  ]);
  assert.deepEqual(messages, original);
  assert.equal(bodies[0].tools, undefined);
  assert.equal(bodies[0].max_completion_tokens, undefined);
});

test("인자 JSON은 미리 파싱하지 않고 ToolManager 검증용으로 그대로 반환한다", async (t) => {
  t.mock.method(globalThis, "fetch", async () => reply(null, "tool_calls", {
    tool_calls: [{ type: "function", id: "a", function: { name: "unknown", arguments: "{broken" } }],
  }));
  const result = await createChatCompletionsAdapter(config).generate(empty);
  assert.deepEqual(result.message.content, [{ type: "tool-call", id: "a", name: "unknown", arguments: "{broken" }]);
});

test("출력 한도 및 알 수 없는 종료 사유를 성공으로 바꾸지 않는다", async (t) => {
  for (const [native, expected] of [["stop", "stop"], ["length", "max-tokens"], ["content_filter", "other"], ["new-reason", "other"]]) {
    const mock = t.mock.method(globalThis, "fetch", async () => reply("부분 응답", native));
    assert.equal((await createChatCompletionsAdapter(config).generate(empty)).stopReason, expected);
    mock.mock.restore();
  }
});

test("HTTP 오류·응답 구조 오류·지원하지 않는 호출은 명시적으로 실패한다", async (t) => {
  const cases: [() => Response, RegExp][] = [
    [() => Response.json({ error: { message: "요청 실패" } }, { status: 400 }), /요청 실패/],
    [() => Response.json({}), /LLM 요청 실패/],
    [() => reply(null, "tool_calls"), /호출 내용이 없습니다/],
    [() => reply(null, "stop", { tool_calls: [{ type: "function", id: "a", function: { name: "test", arguments: "{}" } }] }), /정상 종료와 툴 호출/],
    [() => reply(null, "tool_calls", { tool_calls: [{ type: "custom", id: "a" }] }), /지원하지 않는 툴/],
    [() => Response.json({ choices: [{ message: { role: "assistant", content: [] } }] }), /응답 형식/],
  ];
  for (const [response, pattern] of cases) {
    const mock = t.mock.method(globalThis, "fetch", async () => response());
    await assert.rejects(createChatCompletionsAdapter(config).generate(empty), pattern);
    mock.mock.restore();
  }
});

test("refusal 재전송 정보는 같은 출처와 수정되지 않은 내용에만 적용한다", async (t) => {
  let body: any;
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    body = JSON.parse(init.body);
    return reply(null, "stop", { refusal: "이 요청은 도울 수 없습니다" });
  });
  const adapter = createChatCompletionsAdapter(config);
  const original = (await adapter.generate(empty)).message;
  assert.deepEqual(original.content, [{ type: "text", text: "이 요청은 도울 수 없습니다" }]);
  // 실제 저장/resume처럼 JSON round trip 이후에도 재전송 가능하다.
  const resumed = JSON.parse(JSON.stringify(original));
  await adapter.generate({ ...empty, messages: [resumed] });
  assert.deepEqual(body.messages[0], { role: "assistant", content: null, refusal: "이 요청은 도울 수 없습니다" });
  assert.equal("replayState" in body.messages[0], false);

  for (const replacement of [
    { ...resumed, content: [{ type: "text", text: "수정된 답변" }] },
    { ...resumed, replayState: { ...resumed.replayState, adapter: "other" } },
    { ...resumed, replayState: { ...resumed.replayState, provider: "other" } },
    { ...resumed, replayState: { ...resumed.replayState, model: "other" } },
    { ...resumed, replayState: { ...resumed.replayState, data: { arbitrary: "metadata" } } },
  ]) {
    await adapter.generate({ ...empty, messages: [replacement] });
    assert.equal(body.messages[0].refusal, undefined);
    assert.equal(body.messages[0].content, replacement.content[0].text);
  }
});

test("tool 오류는 같은 호출 ID의 결과로 API에 전달된다", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    assert.deepEqual(JSON.parse(init.body).messages, [{ role: "tool", tool_call_id: "a", content: "툴 오류: 인자가 잘못되었습니다" }]);
    return reply();
  });
  await createChatCompletionsAdapter(config).generate({ ...empty, messages: [
    { role: "tool", content: [{ type: "tool-result", toolCallId: "a", content: "인자가 잘못되었습니다", isError: true }] },
  ] });
});
