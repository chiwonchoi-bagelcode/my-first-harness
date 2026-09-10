import assert from "node:assert/strict";
import test from "node:test";
import { createAnthropicMessagesAdapter } from "../adapters/anthropic-messages.ts";
import { createResponsesAdapter } from "../adapters/responses.ts";
import { createModelAdapter } from "../model-config.ts";
import { createAgent } from "../agent.ts";
import { createSession } from "../session.ts";
import { ToolManager } from "../tool-manager.ts";
import { SkillManager } from "../skill-manager.ts";
import { createHarnessPaths } from "../harness-paths.ts";
import type { LLMRequest } from "../llm-types.ts";

const base = { provider: "cache-test", baseURL: "https://example.invalid/anthropic/v1", model: "claude-haiku-4-5-20251001", apiKey: "k" };
const tools = [{ name: "probe", description: "테스트", parameters: { type: "object", properties: {} } }];
const request: LLMRequest = { system: "지침", messages: [{ role: "user", content: [{ type: "text", text: "안녕" }] }], tools, promptCache: true };

// 텍스트 블록 하나로 끝나는 모의 Messages 응답을 만든다.
const reply = () => Response.json({ type: "message", role: "assistant", content: [{ type: "text", text: "답" }], stop_reason: "end_turn",
  usage: { input_tokens: 10, cache_creation_input_tokens: 5000, cache_read_input_tokens: 0, output_tokens: 3 } });

// fetch를 가로채 실제 전송 본문을 돌려준다.
function capture(t: any) {
  const bodies: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => { bodies.push(JSON.parse(init.body)); return reply(); });
  return bodies;
}

test("연결이 캐시를 지원하고 요청이 접두어 재사용을 알리면 system 마지막 블록과 최상위에 cache_control을 붙인다", async (t) => {
  const bodies = capture(t);
  const result = await createAnthropicMessagesAdapter({ ...base, promptCache: true }).generate(request);
  assert.deepEqual(bodies[0].system, [{ type: "text", text: "지침", cache_control: { type: "ephemeral" } }]);
  assert.deepEqual(bodies[0].cache_control, { type: "ephemeral" });
  // 툴 정의에는 표시를 넣지 않고, 메시지에는 첫 메시지의 첫 블록에만 넣는다. 대화 꼬리는 최상위 표시가 서버에서 처리한다.
  assert.equal(JSON.stringify(bodies[0].tools).includes("cache_control"), false);
  assert.deepEqual(bodies[0].messages[0].content[0], { type: "text", text: "안녕", cache_control: { type: "ephemeral" } });
  // 응답 처리와 재전송 정보는 표시와 무관하다.
  assert.equal(JSON.stringify(result.message.replayState).includes("cache_control"), false);
  assert.deepEqual(result.usage, { inputTokens: 5010, outputTokens: 3, cachedInputTokens: 0, cacheWriteInputTokens: 5000 });
});

test("연결 설정이나 요청 표시 중 하나라도 없으면 예전 본문 그대로 보낸다", async (t) => {
  const bodies = capture(t);
  await createAnthropicMessagesAdapter(base).generate(request);
  await createAnthropicMessagesAdapter({ ...base, promptCache: true }).generate({ ...request, promptCache: undefined });
  for (const body of bodies) {
    assert.equal(body.system, "지침");
    assert.equal(body.cache_control, undefined);
    assert.equal(JSON.stringify(body.messages).includes("cache_control"), false);
  }
});

test("첫 메시지 표시는 AGENTS.md와 첫 입력이 한 메시지로 합쳐져도 첫 블록(AGENTS.md)에만 붙고 세션 원본은 바꾸지 않는다", async (t) => {
  const bodies = capture(t);
  const messages: LLMRequest["messages"] = [
    { role: "user", content: [{ type: "text", text: "[프로젝트 지침 · AGENTS.md]\n규칙" }] },
    { role: "user", content: [{ type: "text", text: "안녕" }] },
    { role: "assistant", content: [{ type: "text", text: "답" }] },
    { role: "user", content: [{ type: "text", text: "다음" }] },
  ];
  const original = JSON.stringify(messages);
  await createAnthropicMessagesAdapter({ ...base, promptCache: true }).generate({ ...request, messages });
  const wire = bodies[0].messages;
  assert.equal(wire.length, 3);
  assert.deepEqual(wire[0].content, [
    { type: "text", text: "[프로젝트 지침 · AGENTS.md]\n규칙", cache_control: { type: "ephemeral" } },
    { type: "text", text: "안녕" },
  ]);
  assert.equal(JSON.stringify(wire.slice(1)).includes("cache_control"), false);
  assert.equal(JSON.stringify(messages), original);
});

test("system이 비어 있으면 빈 텍스트 블록을 만들지 않고 최상위 표시만 붙인다", async (t) => {
  const bodies = capture(t);
  await createAnthropicMessagesAdapter({ ...base, promptCache: true }).generate({ ...request, system: "" });
  assert.equal(bodies[0].system, undefined);
  assert.deepEqual(bodies[0].cache_control, { type: "ephemeral" });
});

test("Responses 어댑터는 접두어 재사용 표시를 무시한다(OpenAI 쪽 캐시는 자동)", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    assert.equal(body.cache_control, undefined);
    assert.equal(JSON.stringify(body).includes("cache_control"), false);
    return Response.json({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] });
  });
  await createResponsesAdapter({ provider: "p", baseURL: "https://example.invalid/v1", model: "gpt-5.6-luna", apiKey: "k" }).generate(request);
});

test("haiku 연결은 캐시를 켜고, 코어는 스텝 요청에만 접두어 재사용을 표시하며 요약 요청에는 표시하지 않는다", async (t) => {
  // haiku 연결은 stream도 켜져 있어 SSE 모의 응답으로 답한다.
  const bodies: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    const events = [
      { type: "message_start", message: { type: "message", role: "assistant", model: base.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "답" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  });
  await createModelAdapter("haiku", "k").generate({ ...request, promptCache: true });
  assert.deepEqual(bodies[0].cache_control, { type: "ephemeral" });
  assert.equal(Array.isArray(bodies[0].system), true);

  const flags: (boolean | undefined)[] = [];
  const agent = createAgent({
    adapter: { contextBudget: { contextWindow: 20_000, reservedOutputTokens: 1000, safetyMarginTokens: 4000, retainRatio: 0 },
      // 어댑터가 받은 요청의 표시만 기록한다.
      async generate(received) { flags.push(received.promptCache); return { stopReason: "stop", message: { role: "assistant", content: [{ type: "text", text: "요약 또는 답" }] } }; } },
    paths: createHarnessPaths("/test", "/test-home"), toolManager: new ToolManager(), skillManager: new SkillManager(),
    history: { async append() {}, async flush() {} }, async saveSession() {},
  });
  const session = createSession("/test");
  await agent.turn(session, "hi");
  session.messages.push({ role: "user", content: [{ type: "text", text: "x".repeat(2000) }] });
  await agent.compact(session);
  assert.deepEqual(flags, [true, undefined]);
});
