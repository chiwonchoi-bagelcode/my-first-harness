import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createAgent } from "../agent.ts";
import type { AgentEvent, AgentOptions } from "../agent.ts";
import { renderCliEvent } from "../cli.ts";
import { createSession } from "../session.ts";
import type { Session } from "../session.ts";
import { ToolManager } from "../tool-manager.ts";
import { SkillManager } from "../skill-manager.ts";
import { createHarnessPaths } from "../harness-paths.ts";
import type { HistoryEvent, HistoryScope } from "../execution-history.ts";
import type { LLMAdapter, LLMResult } from "../llm-types.ts";

// 정상 완료된 모의 모델 답변을 만든다.
function reply(text: string): LLMResult {
  return { stopReason: "stop", message: { role: "assistant", content: [{ type: "text", text }] } };
}

// 실제 코어의 파일 기록과 모델만 대체하고 이벤트·저장 시점을 수집한다.
function fixture(adapter: LLMAdapter, overrides: Partial<AgentOptions> = {}) {
  const events: AgentEvent[] = [];
  const saved: Session[] = [];
  const records: (HistoryEvent & HistoryScope)[] = [];
  const agent = createAgent({
    adapter: { contextBudget: { contextWindow: 20_000, reservedOutputTokens: 1000, safetyMarginTokens: 4000, retainRatio: 0 }, ...adapter },
    paths: createHarnessPaths("/test", "/test-home"),
    toolManager: new ToolManager(),
    skillManager: new SkillManager(),
    history: {
      // 원문 기록을 이후 메시지 변경과 분리한다.
      async append(scope, event) { records.push(structuredClone({ ...scope, ...event })); },
      // 메모리 기록에는 대기 중인 파일 쓰기가 없다.
      async flush() {},
    },
    // 실제 디스크에 쓰지 않고 저장 요청의 값을 보관한다.
    async saveSession(session) { saved.push(structuredClone(session)); },
    // 화면에 출력하지 않고 진행 이벤트만 받는다.
    onEvent(event) { events.push(event); },
    ...overrides,
  });
  return { agent, events, saved, records };
}

test("중단 신호는 모델 요청에 전달되고 interrupted 저장 후 같은 세션에서 새 턴을 실행한다", async () => {
  const entered = Promise.withResolvers<void>();
  let calls = 0;
  const { agent, events, records, saved } = fixture({
    // 첫 요청은 신호를 기다리고 두 번째 요청은 정상 완료한다.
    async generate(_request, _observer, signal) {
      if (++calls > 1) return reply("다시 완료");
      assert.ok(signal);
      entered.resolve();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  });
  assert.equal(agent.interrupt(), false);
  const session = createSession("/test");
  const running = agent.turn(session, "시작");
  await entered.promise;
  assert.equal(agent.interrupt(), true);
  assert.equal(agent.interrupt(), false);
  assert.equal(await running, "");
  assert.ok(records.some((event) => event.type === "turn-end" && event.outcome === "interrupted"));
  assert.equal(events.at(-1)?.type, "turn-interrupted");
  assert.equal(saved.length, 1);
  assert.equal(await agent.turn(session, "다시"), "다시 완료");
});

test("실행 도중 중단하면 남은 툴을 건너뛰고 호출 ID별 결과를 채워 다음 요청을 보낸다", async () => {
  const tools = new ToolManager();
  const entered = Promise.withResolvers<void>();
  let unexpected = 0;
  tools.register({ name: "wait", description: "wait", parameters: { type: "object" },
    // 원격·비동기 툴처럼 실행 중 취소 신호를 받는다.
    execute(_args, context) {
      entered.resolve();
      return new Promise((_resolve, reject) => context!.signal!.addEventListener("abort", () => reject(context!.signal!.reason), { once: true }));
    },
  });
  tools.register({ name: "later", description: "later", parameters: { type: "object" },
    // 중단 뒤 호출되면 테스트가 실패한다.
    execute() { unexpected++; return "bad"; },
  });
  let calls = 0;
  const { agent, records, events } = fixture({ async generate(request) {
    if (++calls === 1) return { stopReason: "tool-calls", message: { role: "assistant", content: [
      { type: "tool-call", id: "one", name: "wait", arguments: "{}" },
      { type: "tool-call", id: "two", name: "later", arguments: "{}" },
    ] } };
    const results = request.messages.flatMap((message) => message.role === "tool" ? message.content : []);
    assert.deepEqual(results.map((result) => result.toolCallId), ["one", "two"]);
    assert.ok(results.every((result) => result.isError));
    return reply("다시 완료");
  } }, { toolManager: tools });
  const session = createSession("/test");
  const running = agent.turn(session, "시작");
  await entered.promise;
  agent.interrupt(); await running;
  assert.equal(unexpected, 0);
  assert.equal(events.filter((event) => event.type === "tool-end").length, 1);
  assert.equal(records.filter((event) => event.type === "tool-start").length, 1);
  assert.equal(await agent.turn(session, "이어서"), "다시 완료");
});

test("취소 불가능한 도구는 실제 완료를 기다리고 성공 결과를 보존한 뒤 중단한다", async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<string>();
  const tools = new ToolManager();
  tools.register({ name: "write", description: "write", parameters: { type: "object" },
    // 파일 쓰기처럼 이미 시작한 처리가 끝날 때까지 기다리는 툴이다.
    execute() { entered.resolve(); return finish.promise; },
  });
  const { agent, records } = fixture({ async generate() { return { stopReason: "tool-calls", message: {
    role: "assistant", content: [{ type: "tool-call", id: "write-one", name: "write", arguments: "{}" }],
  } }; } }, { toolManager: tools });
  const session = createSession("/test");
  let ended = false;
  const running = agent.turn(session, "write").then(() => { ended = true; });
  await entered.promise;
  agent.interrupt();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ended, false);
  finish.resolve("파일 저장 완료"); await running;
  const result = records.find((event) => event.type === "tool-end");
  assert.ok(result?.type === "tool-end");
  assert.equal(result.result.content, "파일 저장 완료");
  assert.equal(result.result.isError, undefined);
});

test("코어·CLI 모듈을 import해도 터미널·모델 호출·출력이 시작되지 않는다", () => {
  const urls = ["agent.ts", "cli.ts", "session.ts", "tool-manager.ts"].map((file) => new URL(`../${file}`, import.meta.url).href);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    globalThis.fetch = () => { throw new Error('import 중 네트워크 호출 금지'); };
    for (const url of ${JSON.stringify(urls)}) await import(url);
  `], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");
});

test("화면 콜백 없이 실행되며 slash 문자열도 코어에서는 사용자 입력이다", async (t) => {
  const output = t.mock.method(console, "log", () => { throw new Error("코어 직접 출력 금지"); });
  let called = 0;
  const { agent, records } = fixture({ async generate(request) {
    called++;
    assert.deepEqual(request.messages[0].content, [{ type: "text", text: "/new" }]);
    return reply("완료");
  } }, { onEvent: undefined });
  assert.equal(called, 0);
  const session = createSession("/test");
  const id = session.id;
  assert.equal(await agent.turn(session, "/new"), "완료");
  assert.equal(session.id, id);
  assert.equal(called, 1);
  assert.equal(output.mock.callCount(), 0);
  assert.equal(records.at(-1)?.type, "turn-end");
});

test("수동 압축 API가 원문과 저장 순서를 유지하고 진행 이벤트를 보낸다", async () => {
  const { agent, events, saved, records } = fixture({ async generate(request) {
    assert.deepEqual(request.tools, []);
    return reply("작업 기록 요약");
  } });
  const session = createSession("/test");
  session.messages.push({ role: "user", content: [{ type: "text", text: "긴 기록 ".repeat(1000) }] });
  const original = structuredClone(session.messages);
  await agent.compact(session);
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[0].messages, original);
  assert.deepEqual(saved[1].messages, session.messages);
  assert.deepEqual(events.map((event) => event.type), ["compaction-start", "compaction-end"]);
  assert.equal(records.filter((event) => event.type === "context-update").length, 1);
  assert.equal(records.find((event) => event.type === "model-start")?.purpose, "compaction");
});

test("빈 세션 압축은 모델을 부르지 않고 실패한 압축은 기존 상태를 보존한다", async () => {
  const { agent, events, saved, records } = fixture({ async generate() { throw new Error("모의 요약 실패"); } });
  const session = createSession("/test");
  await agent.compact(session);
  assert.deepEqual(events, [{ type: "compaction-start" }, { type: "compaction-empty" }]);
  assert.equal(records.length, 0);
  session.messages.push({ role: "user", content: [{ type: "text", text: "보존할 기록" }] });
  const original = structuredClone(session.messages);
  await assert.rejects(agent.compact(session), /모의 요약 실패/);
  assert.deepEqual(session.messages, original);
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[1].messages, original);
  assert.equal(events.at(-1)?.type, "compaction-start");
});

test("툴 결과 축약으로 충분하면 요약 없이 축약 이벤트와 기록만 남긴다", async () => {
  let called = 0;
  const { agent, events, records } = fixture({ async generate() { called++; return reply("완료"); } });
  const session = createSession("/test");
  session.messages.push(
    { role: "assistant", content: [{ type: "tool-call", id: "read-1", name: "read", arguments: "{}" }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "read-1", content: "a".repeat(70_000) }] },
  );
  await agent.turn(session, "계속");
  assert.equal(called, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "tool-results-pruned");
  if (events[0].type !== "tool-results-pruned") assert.fail("축약 이벤트 필요");
  assert.equal(events[0].count, 1);
  assert.ok(events[0].afterChars < events[0].beforeChars);
  assert.equal(records.find((event) => event.type === "context-update")?.reason, "prune");
});

test("CLI는 모든 코어 이벤트를 기존 화면 문구로 표시한다", (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (text: string) => { lines.push(text); });
  const events: AgentEvent[] = [
    { type: "assistant-text", text: "확인 중" },
    { type: "tool-start", name: "read", arguments: "{}" },
    { type: "compaction-start" },
    { type: "compaction-end", beforeChars: 70000, afterChars: 1000 },
    { type: "compaction-empty" },
    { type: "output-limit-recovery", attempt: 1, maxAttempts: 2 },
    { type: "tool-results-pruned", count: 2, beforeChars: 80000, afterChars: 5000 },
  ];
  events.forEach(renderCliEvent);
  assert.deepEqual(lines, ["확인 중", "[tool] read {}", "[context] 대화를 요약합니다...",
    "[context] 압축 완료: 70000 → 1000자", "[context] 최근 기록을 보존하면 요약할 오래된 구간이 없습니다.",
    "[recovery] 출력 한도 도달 · 작업을 나눠 다시 요청합니다 (1/2)",
    "[context] 툴 결과 2개 정리: 80000 → 5000자"]);
});

test("자동 압축 후에도 최근 요청과 원본 이력은 유지되고 실제 스텝은 새 컨텍스트를 받는다", async () => {
  let calls = 0;
  const { agent, records } = fixture({
    contextBudget: { contextWindow: 2000, reservedOutputTokens: 100, safetyMarginTokens: 200, retainRatio: 0.1 },
    // 첫 호출만 요약하고 두 번째 호출에서 최신 사용자 지시의 원문을 확인한다.
    async generate(request) {
      calls++;
      if (calls === 1) return reply("과거 작업은 완료. 현재는 사용자의 테스트 요청을 따를 것.");
      assert.equal(request.messages.length, 3);
      assert.deepEqual(request.messages.at(-1)?.content, [{ type: "text", text: "구현하지 말고 테스트만 해줘" }]);
      assert.ok(request.system.includes("현재 작업 디렉토리"));
      return reply("테스트 완료");
    },
  });
  const session = createSession("/test");
  session.messages.push({ role: "user", content: [{ type: "text", text: "old ".repeat(3000) }] },
    { role: "assistant", content: [{ type: "text", text: "최근 진행 상황 ".repeat(50) }] });
  await agent.turn(session, "구현하지 말고 테스트만 해줘");
  assert.equal(calls, 2);
  assert.deepEqual(records.filter((event) => event.type === "model-start").map((event) => event.purpose), ["compaction", "step"]);
  assert.ok(records.some((event) => event.type === "message" && event.message.role === "user"));
});

test("거대한 최신 입력 또는 고정 시스템만으로 예산을 넘으면 요약 무한 반복 없이 종료한다", async () => {
  for (const mode of ["input", "system"]) {
    let calls = 0;
    const { agent } = fixture({
      contextBudget: { contextWindow: 1000, reservedOutputTokens: 100, safetyMarginTokens: 100, retainRatio: 0.1 },
      // 오래된 기록 한 번의 요약 외에는 모델 호출을 허용하지 않는다.
      async generate() { calls++; return reply("짧은 요약"); },
    });
    const session = createSession("/test");
    if (mode === "system") {
      session.system = "x".repeat(10_000);
      session.messages.push({ role: "user", content: [{ type: "text", text: "old ".repeat(1000) }] },
        { role: "assistant", content: [{ type: "text", text: "recent ".repeat(100) }] });
    }
    await assert.rejects(agent.turn(session, mode === "input" ? "x".repeat(10_000) : "계속"), /예산을 초과/);
    assert.equal(calls, mode === "input" ? 0 : 1);
  }
});
