import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { ExecutionHistory } from "../execution-history.ts";
import { createHarnessPaths } from "../harness-paths.ts";
import { saveSession, loadSession } from "../session-store.ts";
import type { Session } from "../session.ts";
import { compactSession, pruneToolResults, recordMessage } from "../context-manager.ts";
import { recordLLM } from "../recorded-llm.ts";
import { createChatCompletionsAdapter } from "../adapters/chat-completions.ts";
import { createResponsesAdapter } from "../adapters/responses.ts";
import { createModelAdapter } from "../model-config.ts";
import { createAnthropicMessagesAdapter } from "../adapters/anthropic-messages.ts";
import { usageOf } from "../adapters/usage.ts";
import type { LLMRequest, Message } from "../llm-types.ts";

// 사용자 경로 대신 임시 프로젝트에 JSONL과 스냅샷을 만드는 검증 환경.
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "harness-history-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = createHarnessPaths(directory, directory);
  const scope = { sessionId: "test-session", turnId: "test-turn", step: 1 };
  const history = new ExecutionHistory(paths, ["test-private-token"]);
  const logPath = join(paths.sessionDirectory, `${scope.sessionId}.jsonl`);
  // 한 줄에 한 이벤트가 저장됐는지 실제 파일을 파싱한다.
  const events = async (): Promise<any[]> => (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return { paths, scope, history, logPath, events };
}

// 단순 텍스트 호출에 사용할 공통 요청을 매번 새로 만든다.
function request(): LLMRequest {
  return { system: "시스템", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }], tools: [] };
}

test("JSONL은 호출 시점의 값을 순서대로 추가하고 알려진 인증 값은 기록하지 않는다", async (t) => {
  const f = await fixture(t);
  const message: Message = { role: "user", content: [{ type: "text", text: "처음\n다음 줄 test-private-token" }] };
  const first = f.history.append(f.scope, { type: "message", message });
  assert.ok(message.content[0].type === "text");
  message.content[0].text = "나중에 바뀐 값";
  const writes = Array.from({ length: 20 }, (_, i) => f.history.append(f.scope, { type: "command", input: `/test ${i}` }));
  await Promise.all([first, ...writes]);
  await f.history.flush();
  const events = await f.events();
  assert.equal(events.length, 21);
  assert.equal(events[0].message.content[0].text, "처음\n다음 줄 [redacted]");
  assert.deepEqual(events.slice(1).map((entry) => entry.input), Array.from({ length: 20 }, (_, i) => `/test ${i}`));
  assert.equal(new Set(events.map((entry) => entry.eventId)).size, 21);
  assert.ok(events.every((entry) => entry.version === 1 && entry.sessionId === f.scope.sessionId && !Number.isNaN(Date.parse(entry.timestamp))));
});

test("압축·축약 원문은 JSONL에 남고 resume는 JSON 스냅샷만 읽는다", async (t) => {
  const f = await fixture(t);
  const session: Session = { id: f.scope.sessionId, workspaceDirectory: f.paths.workspaceDirectory, system: "지침", projectInstructions: "", discoveredTools: [], messages: [] };
  const original: Message = { role: "tool", content: [{ type: "tool-result", toolCallId: "a", content: "원문".repeat(20_000) }] };
  await f.history.append(f.scope, { type: "message", message: original });
  recordMessage(session, original);
  assert.equal(pruneToolResults(session), 1);
  await compactSession(session, async () => "작업 요약");
  const before = await readFile(f.logPath, "utf8");
  await saveSession(session, f.paths);
  assert.equal(await readFile(f.logPath, "utf8"), before);
  const resumed = await loadSession(session.id, f.paths);
  assert.deepEqual(resumed, session);
  assert.equal("history" in resumed, false);
  assert.equal((await f.events())[0].message.content[0].content, "원문".repeat(20_000));
  const next = new ExecutionHistory(f.paths);
  await next.append(f.scope, { type: "session-resume", messageCount: resumed.messages.length });
  assert.ok((await readFile(f.logPath, "utf8")).startsWith(before));
  // 로그가 불완전해도 스냅샷 읽기는 로그 재생에 의존하지 않는다.
  await writeFile(f.logPath, before + '{"type":');
  assert.deepEqual(await loadSession(session.id, f.paths), session);
  const broken = new ExecutionHistory(f.paths);
  await assert.rejects(broken.append(f.scope, { type: "turn-start" }), /마지막 줄이 미완성/);
  assert.equal(await readFile(f.logPath, "utf8"), before + '{"type":');
});

test("구형 세션을 자동 변환하지 않고 파일과 잘못된 ID 대상도 보존한다", async (t) => {
  const f = await fixture(t);
  await f.history.append(f.scope, { type: "turn-start" });
  const path = join(f.paths.sessionDirectory, `${f.scope.sessionId}.json`);
  const old = JSON.stringify({ id: f.scope.sessionId, system: "지침", history: [], messages: [] });
  await writeFile(path, old);
  await assert.rejects(loadSession(f.scope.sessionId, f.paths), /현재 세션 형식/);
  assert.equal(await readFile(path, "utf8"), old);
  await assert.rejects(loadSession("../escape", f.paths), /세션 ID/);
  assert.throws(() => f.history.append({ sessionId: "../escape" }, { type: "turn-start" }), /세션 ID/);
});

test("기록 저장에 실패하면 API 요청을 보내지 않는다", async (t) => {
  const f = await fixture(t);
  let called = false;
  t.mock.method(globalThis, "fetch", async () => { called = true; throw new Error("호출되면 안 됨"); });
  await writeFile(join(f.paths.workspaceDirectory, "not-a-directory"), "file");
  const history = new ExecutionHistory({ ...f.paths, sessionDirectory: join(f.paths.workspaceDirectory, "not-a-directory", "child") });
  const adapter = createResponsesAdapter({ provider: "proxy", model: "test", baseURL: "https://example.invalid/v1", apiKey: "test-private-token" });
  await assert.rejects(recordLLM(adapter, history, f.scope, "step").generate(request()));
  assert.equal(called, false);
  await assert.rejects(history.flush());
});

for (const api of ["chat-completions", "responses", "anthropic-messages"] as const) {
  test(`${api}: 실제 본문·사용량·종료 이유를 기록하고 인증 헤더는 제외한다`, async (t) => {
    const f = await fixture(t);
    const config = { provider: "proxy", model: "test-model", baseURL: "https://example.invalid/v1", apiKey: "test-private-token" };
    const adapter = api === "responses" ? createResponsesAdapter(config)
      : api === "chat-completions" ? createChatCompletionsAdapter(config) : createAnthropicMessagesAdapter(config);
    const raw = api === "responses" ? {
      id: "response-id", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }],
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 70 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 10 } },
    } : api === "chat-completions" ? {
      id: "response-id", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "hello" } }],
      usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 70 }, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 10 } },
    } : {
      id: "response-id", type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "hello" }],
      usage: { input_tokens: 30, cache_read_input_tokens: 60, cache_creation_input_tokens: 10, output_tokens: 20 },
    };
    let sent: unknown;
    t.mock.method(globalThis, "fetch", async (_url: any, options: any) => {
      sent = JSON.parse(options.body);
      assert.match(JSON.stringify(options.headers), /test-private-token/);
      return Response.json(raw, { headers: { "x-request-id": "request-id", "set-cookie": "do-not-log" } });
    });
    const result = await recordLLM(adapter, f.history, f.scope, "step").generate(request());
    assert.equal(result.usage?.inputTokens, 100);
    assert.equal(result.usage?.outputTokens, 20);
    const events = await f.events();
    assert.deepEqual(events.map((entry) => entry.type), ["model-start", "model-request", "model-response", "model-end"]);
    assert.equal(new Set(events.map((entry) => entry.callId)).size, 1);
    assert.deepEqual(events[1].request.body, sent);
    assert.equal(events[1].request.provider, "proxy");
    assert.equal(events[1].request.api, api);
    assert.deepEqual(events[2].response.body, raw);
    assert.deepEqual(events[2].response.usage, result.usage);
    assert.equal(events[2].response.requestId, "request-id");
    assert.equal(events[3].stopReason, "stop");
    assert.ok(events[3].durationMs >= 0);
    assert.doesNotMatch(await readFile(f.logPath, "utf8"), /test-private-token|Authorization|x-api-key|do-not-log/);
  });
}

test("Farm SSE의 원본 이벤트·완료 항목·사용량도 같은 호출 ID의 JSONL에 남는다", async (t) => {
  const f = await fixture(t);
  const item = { type: "message", role: "assistant", content: [{ type: "output_text", text: "완료" }] };
  const frames = [
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { status: "completed", output: [],
      usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 70 } } } },
  ];
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    assert.equal(JSON.parse(init.body).stream, true);
    return new Response(frames.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/plain", "x-request-id": "farm-request" },
    });
  });
  const result = await recordLLM(createModelAdapter("farm", "test-private-token"), f.history, f.scope, "step").generate(request());
  assert.deepEqual(result.message.content, [{ type: "text", text: "완료" }]);
  const events = await f.events();
  assert.deepEqual(events.map((event) => event.type), ["model-start", "model-request", "model-response", "model-end"]);
  assert.equal(new Set(events.map((event) => event.callId)).size, 1);
  assert.deepEqual(events[2].response.body, { events: frames });
  assert.deepEqual(events[2].response.usage, { inputTokens: 100, outputTokens: 20, cachedInputTokens: 70 });
  assert.deepEqual(events[2].response.usage, result.usage);
  assert.equal(events[2].response.requestId, "farm-request");
  assert.doesNotMatch(await readFile(f.logPath, "utf8"), /test-private-token|Authorization/);
});

test("Farm SSE 실패·중간 단절도 수신 이벤트를 보존하고 model-error로 끝난다", async (t) => {
  const cases = [
    { frame: { type: "response.failed", response: { status: "failed", error: { message: "generation failed" },
      usage: { input_tokens: 10, output_tokens: 2 } } }, pattern: /generation failed/, usage: { inputTokens: 10, outputTokens: 2 } },
    { frame: { type: "error", message: "overloaded" }, pattern: /overloaded/, usage: undefined },
    { frame: { type: "response.created", response: { status: "in_progress" } }, pattern: /완료 이벤트 없이/, usage: undefined },
  ];
  for (const entry of cases) {
    const f = await fixture(t);
    const mock = t.mock.method(globalThis, "fetch", async () => new Response(`data: ${JSON.stringify(entry.frame)}\n\n`));
    await assert.rejects(recordLLM(createModelAdapter("farm", "test-private-token"), f.history, f.scope, "step").generate(request()), entry.pattern);
    const events = await f.events();
    assert.deepEqual(events.map((event) => event.type), ["model-start", "model-request", "model-response", "model-error"]);
    assert.deepEqual(events[2].response.body, { events: [entry.frame] });
    assert.deepEqual(events[2].response.usage, entry.usage);
    mock.mock.restore();
  }
});

test("사용량 누락은 0이 아니며 캐시와 reasoning을 이중 합산하지 않는다", () => {
  assert.deepEqual(usageOf("responses", {}), {});
  assert.deepEqual(usageOf("responses", { usage: { input_tokens: 10, input_tokens_details: { cache_write_tokens: 4 } } }), {
    usage: { inputTokens: 10, cacheWriteInputTokens: 4 },
  });
  assert.deepEqual(usageOf("responses", { usage: { input_tokens: null, output_tokens: -1 } }), {});
  assert.deepEqual(usageOf("responses", { usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 70 }, output_tokens_details: { reasoning_tokens: 10 } } }), {
    usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 70, reasoningOutputTokens: 10 },
  });
  assert.deepEqual(usageOf("anthropic-messages", { usage: { input_tokens: 5, output_tokens: 2 } }), { usage: { outputTokens: 2 } });
  assert.deepEqual(usageOf("anthropic-messages", { usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } }), {
    usage: { inputTokens: 5, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
  });
});

test("HTTP 오류·잘못된 JSON·정규화 실패·네트워크 실패도 실행 기록에 남긴다", async (t) => {
  const f = await fixture(t);
  const adapter = createResponsesAdapter({ provider: "proxy", model: "test", baseURL: "https://example.invalid/v1", apiKey: "test-private-token" });
  const cases = [
    () => Response.json({ error: { message: "bad request test-private-token" } }, { status: 400 }),
    () => new Response("bad gateway", { status: 502 }),
    () => Response.json({ status: "completed", output: [{ type: "unsupported" }], usage: { input_tokens: 5, output_tokens: 3 } }),
    () => { throw new Error("network offline"); },
  ];
  for (let i = 0; i < cases.length; i++) {
    t.mock.method(globalThis, "fetch", async () => cases[i]());
    await assert.rejects(recordLLM(adapter, f.history, { ...f.scope, step: i + 1 }, "step").generate(request()));
  }
  const events = await f.events();
  assert.equal(events.filter((event) => event.type === "model-error").length, 4);
  assert.equal(events.filter((event) => event.type === "model-response").length, 3);
  const invalid = events.find((event) => event.type === "model-response" && event.step === 3);
  assert.deepEqual(invalid.response.usage, { inputTokens: 5, outputTokens: 3 });
  assert.equal(events.find((event) => event.type === "model-response" && event.step === 2).response.body, "bad gateway");
  assert.doesNotMatch(await readFile(f.logPath, "utf8"), /test-private-token/);
});

test("잘린 응답은 usage와 max-tokens를 기록하되 자동 재시도하지 않는다", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "function_call", call_id: "tool", name: "write", arguments: "{", status: "incomplete" }],
      usage: { input_tokens: 100, output_tokens: 4096 },
    });
  });
  const adapter = createResponsesAdapter({ provider: "proxy", model: "test", baseURL: "https://example.invalid/v1", apiKey: "test-private-token" });
  const result = await recordLLM(adapter, f.history, f.scope, "step").generate(request());
  assert.equal(result.stopReason, "max-tokens");
  assert.equal(calls, 1);
  assert.equal((await f.events()).at(-1).stopReason, "max-tokens");
  assert.equal((await f.events()).find((event) => event.type === "model-response").response.usage.outputTokens, 4096);
});
