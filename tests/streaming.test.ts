import assert from "node:assert/strict";
import test from "node:test";
import { createResponsesAdapter } from "../adapters/responses.ts";
import { createAnthropicMessagesAdapter } from "../adapters/anthropic-messages.ts";
import { recordLLM } from "../recorded-llm.ts";
import { createAgent } from "../agent.ts";
import type { AgentEvent } from "../agent.ts";
import { renderCliAnswer, renderCliEvent } from "../cli.ts";
import { createTuiSession } from "../tui-session.ts";
import type { TuiSession } from "../tui-session.ts";
import { createSession } from "../session.ts";
import { ToolManager } from "../tool-manager.ts";
import { SkillManager } from "../skill-manager.ts";
import { createHarnessPaths } from "../harness-paths.ts";
import { textOf } from "../llm-types.ts";
import type { LLMAdapter, LLMObserver, LLMRequest, LLMResult } from "../llm-types.ts";
import type { HistoryEvent, HistoryScope } from "../execution-history.ts";
import { modeFixture } from "./mode-fixture.ts";

const empty: LLMRequest = { system: "", messages: [], tools: [] };

// SSE 이벤트 하나를 공백 줄까지 포함한 텍스트로 만든다.
function frame(event: object) {
  return `event: ${(event as any).type}\ndata: ${JSON.stringify(event)}\n\n`;
}

// 텍스트를 작은 바이트 조각으로 나눠 보내는 SSE 응답을 만든다.
function stream(text: string, chunkSize = 5) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    // 소비자가 읽을 때마다 다음 조각만 전달한다.
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset = Math.min(bytes.length, offset + chunkSize);
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

// 텍스트 조각들과 완성 메시지를 담은 실제 Responses SSE 순서를 만든다.
function textStream(pieces: string[], extra = "") {
  const message = { type: "message", id: "msg_1", role: "assistant", status: "completed", phase: "final_answer",
    content: [{ type: "output_text", text: pieces.join(""), annotations: [] }] };
  return stream(frame({ type: "response.created", response: { status: "in_progress" } })
    + frame({ type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } })
    + pieces.map((delta) => frame({ type: "response.output_text.delta", output_index: 0, delta })).join("")
    + extra
    + frame({ type: "response.output_item.done", output_index: 0, item: message })
    + frame({ type: "response.completed", response: { status: "completed", output: [message] } }));
}

// 기록 콜백은 비워 두고 텍스트 조각만 모으는 관찰자를 만든다.
function collector() {
  const deltas: string[] = [];
  const observer: LLMObserver = { async onRequest() {}, async onResponse() {}, onTextDelta: (text) => { deltas.push(text); } };
  return { deltas, observer };
}

test("Responses SSE의 output_text.delta만 도착 순서대로 onTextDelta에 전달하고 합치면 완성본과 같다", async (t) => {
  const pieces = ["안", "녕하세요", "!", " 🌞 무엇", "을 도와드릴까요?"];
  t.mock.method(globalThis, "fetch", async () => textStream(pieces,
    frame({ type: "response.function_call_arguments.delta", output_index: 1, delta: "{\"label\":" })
    + frame({ type: "response.reasoning_summary_text.delta", output_index: 2, delta: "생각" })));
  const { deltas, observer } = collector();
  const adapter = createResponsesAdapter({ provider: "stream-test", baseURL: "https://example.invalid/v1", model: "gpt-5.6-luna", apiKey: "k", stream: true });
  const result = await adapter.generate(empty, observer);
  assert.deepEqual(deltas, pieces);
  assert.equal(deltas.join(""), textOf(result.message));
  assert.equal(result.stopReason, "stop");
});

test("관찰자가 없거나 onTextDelta가 없어도 SSE 응답은 지금처럼 완성본으로 반환된다", async (t) => {
  t.mock.method(globalThis, "fetch", async () => textStream(["a", "b"]));
  const adapter = createResponsesAdapter({ provider: "stream-test", baseURL: "https://example.invalid/v1", model: "gpt-5.6-luna", apiKey: "k", stream: true });
  assert.equal(textOf((await adapter.generate(empty)).message), "ab");
  assert.equal(textOf((await adapter.generate(empty, { async onRequest() {}, async onResponse() {} })).message), "ab");
});

test("AIProxy Luna 연결도 stream을 켜고 Farm과 달리 출력 한도는 계속 보낸다", async (t) => {
  const { createModelAdapter } = await import("../model-config.ts");
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    assert.equal(body.stream, true);
    assert.equal(body.max_output_tokens, 4096);
    return textStream(["pong"]);
  });
  const { deltas, observer } = collector();
  const result = await createModelAdapter("luna", "proxy-key").generate({ ...empty, maxOutputTokens: 4096 }, observer);
  assert.deepEqual(deltas, ["pong"]);
  assert.equal(textOf(result.message), "pong");
});

test("기록 래퍼는 호출자가 준 onTextDelta만 어댑터 관찰자에 넘기고 기록 이벤트에는 조각을 남기지 않는다", async () => {
  const records: HistoryEvent[] = [];
  const history = { async append(_scope: HistoryScope, event: HistoryEvent) { records.push(event); }, async flush() {} };
  const seen: string[] = [];
  const adapter: LLMAdapter = { async generate(_request, observer) {
    seen.push(typeof observer?.onTextDelta);
    observer?.onTextDelta?.("조각");
    return { stopReason: "stop", message: { role: "assistant", content: [{ type: "text", text: "조각" }] } };
  } };
  const deltas: string[] = [];
  await recordLLM(adapter, history, { sessionId: "s" }, "step", undefined, { onTextDelta: (text) => deltas.push(text) }).generate(empty);
  await recordLLM(adapter, history, { sessionId: "s" }, "compaction").generate(empty);
  assert.deepEqual(seen, ["function", "undefined"]);
  assert.deepEqual(deltas, ["조각"]);
  assert.doesNotMatch(JSON.stringify(records), /조각/);
  assert.deepEqual(records.map((event) => event.type), ["model-start", "model-end", "model-start", "model-end"]);
});

// 조각을 흘린 뒤 완성본을 돌려주는 모의 모델로 실제 코어를 만든다.
function agentFixture(outputs: (observer: LLMObserver | undefined) => Promise<LLMResult>) {
  const events: AgentEvent[] = [];
  const observers: (LLMObserver | undefined)[] = [];
  const agent = createAgent({
    adapter: { contextBudget: { contextWindow: 20_000, reservedOutputTokens: 1000, safetyMarginTokens: 4000, retainRatio: 0 },
      async generate(_request, observer) { observers.push(observer); return outputs(observer); } },
    paths: createHarnessPaths("/test", "/test-home"),
    toolManager: new ToolManager(),
    skillManager: new SkillManager(),
    history: { async append() {}, async flush() {} },
    // 디스크 대신 메모리에만 둔다.
    async saveSession() {},
    onEvent(event) { events.push(event); },
  });
  return { agent, events, observers };
}

test("코어는 작업 스텝의 조각을 assistant-delta로 순서대로 알리고 완성 텍스트를 반환한다", async () => {
  const { agent, events } = agentFixture(async (observer) => {
    for (const piece of ["안", "녕"]) observer?.onTextDelta?.(piece);
    return { stopReason: "stop", message: { role: "assistant", content: [{ type: "text", text: "안녕" }] } };
  });
  const output = await agent.turn(createSession("/test"), "hi");
  assert.equal(output, "안녕");
  assert.deepEqual(events, [{ type: "assistant-delta", text: "안" }, { type: "assistant-delta", text: "녕" }]);
});

test("툴 호출 스텝의 조각 뒤에는 같은 텍스트의 assistant-text가 오고, 요약 호출에는 조각 콜백을 넘기지 않는다", async () => {
  let calls = 0;
  const { agent, events, observers } = agentFixture(async (observer) => {
    if (++calls === 1) {
      observer?.onTextDelta?.("확인");
      observer?.onTextDelta?.(" 중");
      return { stopReason: "tool-calls", message: { role: "assistant", content: [
        { type: "text", text: "확인 중" }, { type: "tool-call", id: "c1", name: "missing", arguments: "{}" },
      ] } };
    }
    return { stopReason: "stop", message: { role: "assistant", content: [{ type: "text", text: "끝" }] } };
  });
  const session = createSession("/test");
  await agent.turn(session, "go");
  assert.deepEqual(events.map((event) => event.type), ["assistant-delta", "assistant-delta", "assistant-text", "tool-start", "tool-end"]);
  // 요약은 같은 어댑터를 쓰지만 화면 조각 콜백이 없어야 한다.
  session.messages.push({ role: "user", content: [{ type: "text", text: "x".repeat(2000) }] });
  await agent.compact(session);
  assert.equal(typeof observers.at(-1)?.onTextDelta, "undefined");
  assert.equal(events.filter((event) => event.type === "assistant-delta").length, 2);
});

test("CLI는 조각을 줄바꿈 없이 이어 쓰고 같은 완성본은 다시 찍지 않으며 다른 이벤트 전에 줄을 마감한다", (t) => {
  const out: string[] = [];
  const logs: string[] = [];
  t.mock.method(process.stdout, "write", ((text: string) => { out.push(text); return true; }) as typeof process.stdout.write);
  t.mock.method(console, "log", (text: string) => { logs.push(text); });
  renderCliEvent({ type: "assistant-delta", text: "안" });
  renderCliEvent({ type: "assistant-delta", text: "녕" });
  renderCliEvent({ type: "assistant-text", text: "안녕" });
  assert.deepEqual(out, ["안", "녕", "\n"]);
  assert.deepEqual(logs, []);
  // 스트리밍 도중 툴 시작 이벤트가 오면 줄을 마감한 뒤 툴 로그를 찍는다.
  renderCliEvent({ type: "assistant-delta", text: "잘린" });
  renderCliEvent({ type: "tool-start", name: "read", arguments: "{}" });
  assert.deepEqual(out.slice(3), ["잘린", "\n"]);
  assert.deepEqual(logs, ["[tool] read {}"]);
  // 완성본이 조각과 다르면 완성본을 다시 쓰고, 스트리밍이 없었으면 지금처럼 그대로 찍는다.
  renderCliEvent({ type: "assistant-delta", text: "부분" });
  renderCliAnswer("부분 그리고 전체");
  renderCliAnswer("일반 답변");
  assert.deepEqual(logs.slice(1), ["부분 그리고 전체", "일반 답변"]);
  // 중단된 턴의 빈 완성본은 받은 조각을 마감만 한다.
  renderCliEvent({ type: "assistant-delta", text: "중단 전" });
  renderCliAnswer("");
  assert.deepEqual(out.slice(-2), ["중단 전", "\n"]);
  assert.equal(logs.length, 3);
});

// 사용자 파일과 네트워크 없이 TUI 제어 객체를 만든다. turn은 코어 이벤트를 직접 흘릴 수 있다.
function tuiFixture(turn: (controller: TuiSession) => Promise<string>) {
  let controller!: TuiSession;
  controller = createTuiSession({
    model: "test", paths: createHarnessPaths("/test", "/test-home"),
    agent: { ...modeFixture(), interrupt() { return false; }, async turn() { return turn(controller); }, async compact() {} },
    history: { async append() {}, async flush() {} },
    async saveSession() {}, async dispose() {},
  });
  return controller;
}

test("TUI는 조각을 한 답변 항목에 이어 붙이고 완성본이 같으면 항목을 늘리지 않는다", async () => {
  const statuses: string[] = [];
  const controller = tuiFixture(async (c) => {
    c.onEvent({ type: "assistant-delta", text: "안" });
    statuses.push(c.getSnapshot().status);
    c.onEvent({ type: "assistant-delta", text: "녕" });
    assert.deepEqual(c.getSnapshot().entries.map((entry) => `${entry.kind}:${entry.text}`), ["user:hi", "assistant:안녕"]);
    return "안녕";
  });
  await controller.submit("hi");
  assert.deepEqual(controller.getSnapshot().entries.map((entry) => `${entry.kind}:${entry.text}`), ["user:hi", "assistant:안녕"]);
  assert.deepEqual(statuses, ["응답 수신 중"]);
  assert.equal(controller.getSnapshot().status, "대기 중");
});

test("TUI는 툴 호출 사이의 답변을 별도 항목으로 나누고 다른 완성본·중단은 받은 조각을 바꾸거나 지우지 않는다", async () => {
  const controller = tuiFixture(async (c) => {
    c.onEvent({ type: "assistant-delta", text: "확인" });
    c.onEvent({ type: "assistant-text", text: "확인" });
    c.onEvent({ type: "tool-start", name: "read", arguments: "{}" });
    c.onEvent({ type: "assistant-delta", text: "결과" });
    c.onEvent({ type: "assistant-delta", text: " 정리" });
    return "결과 정리 (완성본이 더 김)";
  });
  await controller.submit("go");
  assert.deepEqual(controller.getSnapshot().entries.map((entry) => `${entry.kind}:${entry.text}`),
    ["user:go", "assistant:확인", "tool:read {}", "assistant:결과 정리 (완성본이 더 김)"]);

  const interrupted = tuiFixture(async (c) => {
    c.onEvent({ type: "assistant-delta", text: "중단 전 조각" });
    c.onEvent({ type: "turn-interrupted" });
    return "";
  });
  await interrupted.submit("stop me");
  assert.deepEqual(interrupted.getSnapshot().entries.map((entry) => `${entry.kind}:${entry.text}`),
    ["user:stop me", "assistant:중단 전 조각", "notice:턴 중단 완료 · 완료한 변경은 유지됩니다. 다음 요청을 입력하세요."]);
});

// Anthropic Messages SSE의 시작 이벤트다. 모델·입력 사용량은 여기에 오고 content는 비어 있다.
const anthropicStart = { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-4-5-20251001",
  content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 25, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } };

// 실제 순서(message_start → 블록들 → message_delta → message_stop)로 Anthropic SSE 응답을 만든다.
function anthropicStream(events: object[], stop = "end_turn", outputTokens = 12) {
  return stream([anthropicStart, ...events,
    { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: outputTokens } },
    { type: "message_stop" }].map((event) => frame(event)).join(""));
}

// 블록 하나를 시작·조각·종료 이벤트로 펼친다.
function block(index: number, start: object, deltas: object[]) {
  return [{ type: "content_block_start", index, content_block: start },
    ...deltas.map((delta) => ({ type: "content_block_delta", index, delta })),
    { type: "content_block_stop", index }];
}

// stream을 켠 Anthropic 어댑터를 만든다.
const anthropic = () => createAnthropicMessagesAdapter({ provider: "stream-test", baseURL: "https://example.invalid/anthropic/v1",
  model: "claude-haiku-4-5-20251001", apiKey: "k", stream: true });

test("Anthropic SSE의 text_delta만 순서대로 onTextDelta에 전달하고 완성본·종료 사유·누적 사용량을 조립한다", async (t) => {
  const pieces = ["안", "녕 ", "🌞"];
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    assert.equal(JSON.parse(init.body).stream, true);
    return anthropicStream([{ type: "ping" }, ...block(0, { type: "text", text: "" }, pieces.map((text) => ({ type: "text_delta", text })))]);
  });
  const { deltas, observer } = collector();
  const result = await anthropic().generate(empty, observer);
  assert.deepEqual(deltas, pieces);
  assert.equal(textOf(result.message), "안녕 🌞");
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.usage, { inputTokens: 25, outputTokens: 12, cachedInputTokens: 0, cacheWriteInputTokens: 0 });
});

test("Anthropic tool_use 인자는 JSON 조각을 합쳐 복원하고 thinking·서명은 replay에 보존하며 화면 조각으로는 내보내지 않는다", async (t) => {
  t.mock.method(globalThis, "fetch", async () => anthropicStream([
    ...block(0, { type: "thinking", thinking: "" }, [{ type: "thinking_delta", thinking: "생각 " }, { type: "thinking_delta", thinking: "중" }, { type: "signature_delta", signature: "sig-1" }]),
    ...block(1, { type: "text", text: "" }, [{ type: "text_delta", text: "확인" }]),
    ...block(2, { type: "tool_use", id: "toolu_1", name: "probe", input: {} },
      [{ type: "input_json_delta", partial_json: '{"lab' }, { type: "input_json_delta", partial_json: 'el": "한' }, { type: "input_json_delta", partial_json: '글"}' }]),
    ...block(3, { type: "tool_use", id: "toolu_2", name: "noArgs", input: {} }, []),
  ], "tool_use"));
  const { deltas, observer } = collector();
  const result = await anthropic().generate(empty, observer);
  assert.deepEqual(deltas, ["확인"]);
  assert.equal(result.stopReason, "tool-calls");
  const calls = result.message.content.filter((entry) => entry.type === "tool-call");
  assert.deepEqual(calls.map((call) => [call.id, call.name, JSON.parse(call.arguments)]),
    [["toolu_1", "probe", { label: "한글" }], ["toolu_2", "noArgs", {}]]);
  const replay = result.message.replayState?.data as { content: unknown[] };
  assert.deepEqual(replay.content[0], { type: "thinking", thinking: "생각 중", signature: "sig-1" });
});

test("Anthropic max_tokens로 잘린 tool_use 조각은 오류 없이 max-tokens로 반환하고, 정상 종료에서 미완성 JSON은 실패한다", async (t) => {
  const truncated = block(0, { type: "tool_use", id: "toolu_1", name: "probe", input: {} }, [{ type: "input_json_delta", partial_json: '{"lab' }]);
  const mock = t.mock.method(globalThis, "fetch", async () => anthropicStream(truncated, "max_tokens"));
  assert.equal((await anthropic().generate(empty)).stopReason, "max-tokens");
  mock.mock.restore();
  t.mock.method(globalThis, "fetch", async () => anthropicStream(truncated, "tool_use"));
  await assert.rejects(anthropic().generate(empty), /완성되지 않은/);
});

test("Anthropic SSE의 오류 이벤트·완료 없는 종료·순서 위반은 실패로 처리한다", async (t) => {
  const cases: [string, RegExp][] = [
    [frame({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), /Overloaded/],
    [frame(anthropicStart) + block(0, { type: "text", text: "" }, []).map((event) => frame(event)).join(""), /완료 이벤트 없이/],
    [frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }), /message_start 없이/],
    [frame(anthropicStart) + frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }), /블록 조각/],
  ];
  for (const [body, pattern] of cases) {
    const mock = t.mock.method(globalThis, "fetch", async () => stream(body));
    await assert.rejects(anthropic().generate(empty), pattern);
    mock.mock.restore();
  }
});

test("Haiku 연결도 stream을 켜고 기본 출력 한도를 함께 보낸다", async (t) => {
  const { createModelAdapter } = await import("../model-config.ts");
  t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    assert.equal(url, "https://aiproxy-api.backoffice.bagelgames.com/anthropic/v1/messages");
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 32_000);
    return anthropicStream(block(0, { type: "text", text: "" }, [{ type: "text_delta", text: "pong" }]));
  });
  const { deltas, observer } = collector();
  const result = await createModelAdapter("haiku", "proxy-key").generate(empty, observer);
  assert.deepEqual(deltas, ["pong"]);
  assert.equal(textOf(result.message), "pong");
});
