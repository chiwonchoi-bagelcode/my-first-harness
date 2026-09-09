import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compactSession, contextSize, pruneToolResults, recordMessage, shouldCompact as requestNeedsCompaction } from "../context-manager.ts";
import { estimateRequestTokens } from "../token-budget.ts";
import { createHarnessPaths } from "../harness-paths.ts";
import { loadSession, saveSession } from "../session-store.ts";
import type { Session } from "../session.ts";
import type { Message } from "../llm-types.ts";
import { textOf } from "../llm-types.ts";

// 테스트에서 사용할 공통 사용자 메시지를 만든다.
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
// 작은 테스트 예산으로 요청 전체의 임계치와 정리 동작을 검증한다.
function shouldCompact(session: { messages: Message[]; system?: string }, threshold = 15_000) {
  return requestNeedsCompaction({ system: session.system ?? "", tools: [], messages: session.messages }, {
    contextWindow: threshold + 1, reservedOutputTokens: 0, safetyMarginTokens: 1, retainRatio: 0,
  });
}
// 테스트에서 사용할 호출 ID와 결과를 가진 공통 툴 메시지를 만든다.
const tool = (content: string, id = "call-1"): Message => ({
  role: "tool", content: [{ type: "tool-result", toolCallId: id, content }],
});
// 툴 메시지인지 확인한 뒤 첫 결과 블록의 문자열을 꺼낸다.
function toolText(message: Message): string {
  if (message.role !== "tool") throw new Error("expected tool result");
  assert.equal(typeof message.content[0].content, "string");
  if (typeof message.content[0].content !== "string") throw new Error("expected text result");
  return message.content[0].content;
}
// 컨텍스트 압축을 검증할 긴 사용자 입력이 담긴 테스트 세션을 만든다.
function createSession(): Session {
  const session: Session = { id: "test-session", workspaceDirectory: "/test", system: "시스템 지침", messages: [] };
  recordMessage(session, user("테트리스 만들어줘. " + "기록 ".repeat(300)));
  return session;
}

test("새 메시지는 요청용 대화에 추가하고 압축은 원본 객체를 바꾸지 않고 교체한다", async () => {
  const session = createSession();
  const original = session.messages;
  const snapshot = structuredClone(original);
  await compactSession(session, async () => "테트리스 구현 중.");
  assert.deepEqual(original, snapshot);
  assert.equal(session.system, "시스템 지침");
  assert.equal(session.messages.length, 1);
  assert.match(textOf(session.messages[0]), /테트리스 구현 중/);
  recordMessage(session, user("점수 기능 추가해줘"));
  assert.equal(textOf(session.messages.at(-1)!), "점수 기능 추가해줘");
});

test("첫 사용자 메시지도 임계치 계산에 포함한다", () => {
  const session = createSession();
  const size = estimateRequestTokens({ ...session, tools: [] });
  assert.equal(shouldCompact(session, size + 1), false);
  assert.equal(shouldCompact(session, size), true);
  assert.equal(shouldCompact(session), false);
  recordMessage(session, tool("x".repeat(60_000)));
  assert.equal(shouldCompact(session), true);
});

test("두 번째 요약에는 이전 요약과 새 대화만 전달한다", async () => {
  const session = createSession();
  await compactSession(session, async () => "첫 요약");
  recordMessage(session, user("새 작업 ".repeat(300)));
  await compactSession(session, async (conversation) => {
    assert.equal(conversation.length, 2);
    assert.match(textOf(conversation[0]), /첫 요약/);
    assert.match(textOf(conversation[1]), /새 작업/);
    assert.doesNotMatch(JSON.stringify(conversation), /테트리스 만들어줘/);
    return "두 번째 요약";
  });
  assert.match(textOf(session.messages[0]), /두 번째 요약/);
});

test("요약 실패·빈 결과·더 긴 결과는 기존 상태를 바꾸지 않는다", async () => {
  for (const summarize of [
    async () => { throw new Error("API 실패"); },
    async () => " ", async () => "x".repeat(10_000),
  ]) {
    const session = createSession();
    const original = structuredClone(session);
    await assert.rejects(compactSession(session, summarize));
    assert.deepEqual(session, original);
  }
});

test("한 응답의 모든 툴 결과를 받기 전에는 요약하지 않는다", async () => {
  const session = createSession();
  recordMessage(session, { role: "assistant", content: [
    { type: "tool-call", id: "a", name: "counterUP", arguments: "{}" },
    { type: "tool-call", id: "b", name: "getCounterVal", arguments: "{}" },
  ] });
  recordMessage(session, tool("성공", "a"));
  let calls = 0;
  const summarize = async () => { calls++; return "두 툴 실행 완료"; };
  await assert.rejects(compactSession(session, summarize), /결과를 받지 못한/);
  assert.equal(calls, 0);
  recordMessage(session, tool("3", "b"));
  await compactSession(session, summarize);
  assert.equal(calls, 1);
  assert.equal(session.messages.some((m) => m.role === "tool" || m.role === "assistant"), false);
});

test("빈 대화에서는 요약 API를 호출하지 않는다", async () => {
  const session = { messages: [] };
  assert.equal(shouldCompact(session), false);
  assert.equal(await compactSession(session, async () => { throw new Error("호출되면 안 됨"); }), false);
});

test("저장/resume는 압축된 messages 스냅샷을 그대로 유지한다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-compaction-test-"));
  try {
    const paths = createHarnessPaths(directory, directory);
    const session = createSession();
    await compactSession(session, async () => "저장할 요약");
    await saveSession(session, paths);
    const resumed = await loadSession(session.id, paths);
    assert.deepEqual(resumed, session);
    recordMessage(resumed, user("계속해"));
    assert.equal("history" in resumed, false);
    assert.match(textOf(resumed.messages[0]), /저장할 요약/);
    assert.equal(textOf(resumed.messages.at(-1)!), "계속해");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("긴 툴 결과의 앞뒤만 남기고 원본과 호출 ID를 보존한다", () => {
  const session = createSession();
  const original = tool("A".repeat(4096) + "M".repeat(10_000) + "Z".repeat(1024));
  recordMessage(session, original);
  const snapshot = structuredClone(original);
  const earlierMessages = session.messages.slice(0, -1);
  assert.equal(pruneToolResults(session), 1);
  assert.deepEqual(original, snapshot);
  assert.deepEqual(session.messages.slice(0, -1), earlierMessages);
  assert.deepEqual(session.messages.at(-1), tool("A".repeat(4096) + "\n\n[... tool result middle pruned ...]\n\n" + "Z".repeat(1024)));
  assert.notEqual(session.messages.at(-1), original);
  assert.equal(pruneToolResults(session), 0);
});

test("8,192자 이하의 결과와 사용자·assistant 메시지는 그대로 둔다", () => {
  const session = createSession();
  recordMessage(session, tool("x".repeat(8192)));
  recordMessage(session, user("x".repeat(9000)));
  recordMessage(session, { role: "assistant", content: [{ type: "text", text: "x".repeat(9000) }] });
  const original = structuredClone(session);
  assert.equal(pruneToolResults(session), 0);
  assert.deepEqual(session, original);
  recordMessage(session, tool("x".repeat(8193)));
  assert.equal(pruneToolResults(session), 1);
});

test("이모지는 UTF-16 길이가 아니라 code points로 세고 자른다", () => {
  const session = createSession();
  recordMessage(session, tool("😀".repeat(8192)));
  assert.equal(pruneToolResults(session), 0);
  recordMessage(session, tool("😀".repeat(8193)));
  assert.equal(pruneToolResults(session), 1);
  assert.equal(toolText(session.messages.at(-1)!), "😀".repeat(4096) + "\n\n[... tool result middle pruned ...]\n\n" + "😀".repeat(1024));
});

test("툴 결과 정리만으로 기준치 아래가 되면 요약이 필요 없다", () => {
  const session = createSession();
  recordMessage(session, tool("x".repeat(60_000)));
  assert.equal(shouldCompact(session), true);
  pruneToolResults(session);
  assert.equal(shouldCompact(session), false);
});

test("정리 후에도 크면 요약 함수는 줄인 결과를 받는다", async () => {
  const session = createSession();
  recordMessage(session, user("목표 ".repeat(20_000)));
  recordMessage(session, { role: "assistant", content: [{ type: "tool-call", id: "call-1", name: "readTextFile", arguments: "{}" }] });
  recordMessage(session, tool("x".repeat(20_000)));
  const original = session.messages;
  const snapshot = structuredClone(original);
  pruneToolResults(session);
  assert.equal(shouldCompact(session), true);
  await compactSession(session, async (conversation) => {
    assert.match(toolText(conversation.at(-1)!), /tool result middle pruned/);
    assert.ok(toolText(conversation.at(-1)!).length < 8192);
    return "목표를 이어서 수행한다.";
  });
  assert.deepEqual(original, snapshot);
});

test("정리한 툴 결과와 assistant 재전송 정보 모두 저장/resume 후 유지된다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-pruning-test-"));
  try {
    const paths = createHarnessPaths(directory, directory);
    const session = createSession();
    recordMessage(session, { role: "assistant",
      content: [{ type: "tool-call", id: "call-1", name: "readTextFile", arguments: "{}" }],
      replayState: { adapter: "test", provider: "test", model: "test", data: { native: "state" } },
    });
    recordMessage(session, tool("원문 ".repeat(10_000)));
    pruneToolResults(session);
    await saveSession(session, paths);
    const resumed = await loadSession(session.id, paths);
    assert.deepEqual(resumed, session);
    assert.equal("history" in resumed, false);
    assert.match(JSON.stringify(resumed.messages), /replayState/);
    assert.match(toolText(resumed.messages.at(-1)!), /tool result middle pruned/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("재전송 정보는 요약 입력과 문자 수에서 제외하고 압축된 messages에서는 제거한다", async () => {
  const session = createSession();
  const message: Message = { role: "assistant", content: [{ type: "text", text: "답변" }] };
  recordMessage(session, message);
  const size = contextSize(session);
  message.replayState = { adapter: "test", provider: "test", model: "test", data: "x".repeat(70_000) };
  assert.equal(contextSize(session), size);
  assert.equal(shouldCompact(session), true);
  await compactSession(session, async (messages) => {
    assert.doesNotMatch(JSON.stringify(messages), /replayState/);
    return "요약";
  });
  assert.doesNotMatch(JSON.stringify(session.messages), /replayState/);
  assert.match(JSON.stringify(message), /replayState/);
});

test("한 tool 메시지 안의 여러 결과도 각각 정리한다", () => {
  const session = createSession();
  recordMessage(session, { role: "tool", content: [
    { type: "tool-result", toolCallId: "a", content: "x".repeat(9000), isError: true },
    { type: "tool-result", toolCallId: "b", content: "짧은 결과" },
    { type: "tool-result", toolCallId: "c", content: "y".repeat(9000) },
  ] });
  assert.equal(pruneToolResults(session), 2);
  const message = session.messages.at(-1)!;
  if (message.role !== "tool") throw new Error("expected tool result");
  assert.equal(message.content[0].isError, true);
  assert.deepEqual(message.content.map((block) => block.toolCallId), ["a", "b", "c"]);
  assert.equal(message.content[1].content, "짧은 결과");
});
