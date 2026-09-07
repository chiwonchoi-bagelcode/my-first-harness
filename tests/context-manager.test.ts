import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compactSession, contextSize, recordMessage, shouldCompact } from "../context-manager.ts";
import { createHarnessPaths } from "../harness-paths.ts";
import { loadSession, saveSession } from "../session-store.ts";

function createSession() {
  const messages = [{ role: "system", content: "시스템 지침" }];
  const session = { id: "test-session", history: [...messages], messages };
  recordMessage(session, { role: "user", content: "테트리스 만들어줘. " + "기록 ".repeat(300) });
  return session;
}

test("새 메시지는 양쪽에 기록하고, 압축은 messages만 교체한다", async () => {
  const session = createSession();
  const original = structuredClone(session.history);
  await compactSession(session, async () => "테트리스 구현 중.");
  assert.deepEqual(session.history, original);
  assert.equal(session.messages[0].content, "시스템 지침");
  assert.equal(session.messages.length, 2);
  assert.match(session.messages[1].content, /테트리스 구현 중/);
  recordMessage(session, { role: "user", content: "점수 기능 추가해줘" });
  assert.equal(session.history.at(-1)?.content, "점수 기능 추가해줘");
  assert.equal(session.messages.at(-1)?.content, "점수 기능 추가해줘");
});

test("임계치 미만은 건너뛰고 도달하면 압축 대상으로 판단한다", () => {
  const session = createSession();
  const size = contextSize(session);
  assert.equal(shouldCompact(session, size + 1), false);
  assert.equal(shouldCompact(session, size), true);
  assert.equal(shouldCompact(session), false);
  recordMessage(session, { role: "tool", content: "x".repeat(60_000) });
  assert.equal(shouldCompact(session), true);
});

test("두 번째 요약에는 이전 요약과 새 대화만 전달한다", async () => {
  const session = createSession();
  await compactSession(session, async () => "첫 요약");
  recordMessage(session, { role: "user", content: "새 작업 ".repeat(300) });
  await compactSession(session, async (conversation) => {
    assert.equal(conversation.length, 2);
    assert.match(conversation[0].content, /첫 요약/);
    assert.match(conversation[1].content, /새 작업/);
    assert.doesNotMatch(JSON.stringify(conversation), /테트리스 만들어줘/);
    return "두 번째 요약";
  });
  assert.match(session.history[1].content, /테트리스 만들어줘/);
});

test("요약 실패·빈 결과·더 긴 결과는 기존 상태를 바꾸지 않는다", async () => {
  for (const summarize of [
    async () => { throw new Error("API 실패"); },
    async () => " ",
    async () => "x".repeat(10_000),
  ]) {
    const session = createSession();
    const original = structuredClone(session);
    await assert.rejects(compactSession(session, summarize));
    assert.deepEqual(session, original);
  }
});

test("한 응답의 모든 툴 결과를 받기 전에는 요약하지 않는다", async () => {
  const session = createSession();
  recordMessage(session, {
    role: "assistant", content: null,
    tool_calls: [{ id: "a" }, { id: "b" }],
  });
  recordMessage(session, { role: "tool", tool_call_id: "a", content: "성공" });
  let calls = 0;
  const summarize = async () => { calls++; return "두 툴 실행 완료"; };
  await assert.rejects(compactSession(session, summarize), /결과를 받지 못한/);
  assert.equal(calls, 0);
  recordMessage(session, { role: "tool", tool_call_id: "b", content: "성공" });
  await compactSession(session, summarize);
  assert.equal(calls, 1);
  assert.equal(session.messages.some((m: any) => m.tool_calls || m.role === "tool"), false);
});

test("빈 대화에서는 요약 API를 호출하지 않는다", async () => {
  const session = { history: [], messages: [{ role: "system", content: "지침" }] };
  assert.equal(shouldCompact(session, 0), false);
  assert.equal(await compactSession(session, async () => { throw new Error("호출되면 안 됨"); }), false);
});

test("저장/resume 이후에도 원문과 압축 상태가 유지된다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-compaction-test-"));
  try {
    const paths = createHarnessPaths(directory, directory);
    const session = createSession();
    await compactSession(session, async () => "저장할 요약");
    await saveSession(session, paths);
    const resumed = await loadSession(session.id, paths);
    assert.deepEqual(resumed, session);
    recordMessage(resumed, { role: "user", content: "계속해" });
    assert.match(resumed.history[1].content, /테트리스 만들어줘/);
    assert.match(resumed.messages[1].content, /저장할 요약/);
    assert.equal(resumed.messages.at(-1)?.content, "계속해");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
