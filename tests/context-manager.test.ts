import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compactSession, contextSize, pruneToolResults, recordMessage, shouldCompact } from "../context-manager.ts";
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

test("긴 툴 결과의 앞뒤만 남기고 원본과 호출 ID를 보존한다", () => {
  const session = createSession();
  const original = {
    role: "tool", tool_call_id: "call-1", content: "A".repeat(4096) + "M".repeat(10_000) + "Z".repeat(1024),
  };
  recordMessage(session, original);
  const history = structuredClone(session.history);
  const earlierMessages = session.messages.slice(0, -1);
  assert.equal(pruneToolResults(session), 1);
  assert.deepEqual(session.history, history);
  assert.deepEqual(session.messages.slice(0, -1), earlierMessages);
  assert.deepEqual(session.messages.at(-1), {
    ...original,
    content: "A".repeat(4096) + "\n\n[... tool result middle pruned ...]\n\n" + "Z".repeat(1024),
  });
  assert.notEqual(session.messages.at(-1), original);
  assert.equal(pruneToolResults(session), 0);
});

test("8,192자 이하의 결과와 사용자·assistant 메시지는 그대로 둔다", () => {
  const session = createSession();
  for (const role of ["tool", "user", "assistant"]) {
    recordMessage(session, { role, content: "x".repeat(role === "tool" ? 8192 : 9000) });
  }
  const original = structuredClone(session);
  assert.equal(pruneToolResults(session), 0);
  assert.deepEqual(session, original);
  recordMessage(session, { role: "tool", content: "x".repeat(8193) });
  assert.equal(pruneToolResults(session), 1);
});

test("이모지는 UTF-16 길이가 아니라 code points로 세고 자른다", () => {
  const session = createSession();
  recordMessage(session, { role: "tool", content: "😀".repeat(8192) });
  assert.equal(pruneToolResults(session), 0);
  recordMessage(session, { role: "tool", content: "😀".repeat(8193) });
  assert.equal(pruneToolResults(session), 1);
  const result = session.messages.at(-1)!.content;
  assert.equal(result, "😀".repeat(4096) + "\n\n[... tool result middle pruned ...]\n\n" + "😀".repeat(1024));
});

test("툴 결과 정리만으로 기준치 아래가 되면 요약이 필요 없다", () => {
  const session = createSession();
  recordMessage(session, { role: "tool", content: "x".repeat(60_000) });
  assert.equal(shouldCompact(session), true);
  pruneToolResults(session);
  assert.equal(shouldCompact(session), false);
});

test("정리 후에도 크면 요약 함수는 줄인 결과를 받는다", async () => {
  const session = createSession();
  recordMessage(session, { role: "user", content: "목표 ".repeat(20_000) });
  recordMessage(session, {
    role: "assistant", content: null, tool_calls: [{ id: "call-1" }],
  });
  recordMessage(session, { role: "tool", tool_call_id: "call-1", content: "x".repeat(20_000) });
  const history = structuredClone(session.history);
  pruneToolResults(session);
  assert.equal(shouldCompact(session), true);
  await compactSession(session, async (conversation) => {
    assert.match(conversation.at(-1).content, /tool result middle pruned/);
    assert.ok(conversation.at(-1).content.length < 8192);
    return "목표를 이어서 수행한다.";
  });
  assert.deepEqual(session.history, history);
});

test("요약 없이 정리한 툴 결과도 저장/resume 후 유지된다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-pruning-test-"));
  try {
    const paths = createHarnessPaths(directory, directory);
    const session = createSession();
    recordMessage(session, { role: "tool", content: "원문 ".repeat(10_000) });
    pruneToolResults(session);
    await saveSession(session, paths);
    const resumed = await loadSession(session.id, paths);
    assert.deepEqual(resumed, session);
    assert.equal(resumed.history.at(-1)?.content, "원문 ".repeat(10_000));
    assert.match(resumed.messages.at(-1)?.content ?? "", /tool result middle pruned/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
