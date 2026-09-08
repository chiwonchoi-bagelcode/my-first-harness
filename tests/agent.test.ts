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
    adapter,
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
    { type: "tool-results-pruned", count: 2, beforeChars: 80000, afterChars: 5000 },
  ];
  events.forEach(renderCliEvent);
  assert.deepEqual(lines, ["확인 중", "[tool] read {}", "[context] 대화를 요약합니다...",
    "[context] 압축 완료: 70000 → 1000자", "[context] 요약할 대화가 없습니다.",
    "[context] 툴 결과 2개 정리: 80000 → 5000자"]);
});
