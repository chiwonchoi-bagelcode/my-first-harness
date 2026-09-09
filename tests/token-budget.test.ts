import assert from "node:assert/strict";
import test from "node:test";
import { estimateMessageTokens, estimateRequestTokens, estimateTextTokens, compactionThreshold, retentionTokens } from "../token-budget.ts";
import { compactSession, shouldCompact } from "../context-manager.ts";
import { createModelAdapter } from "../model-config.ts";
import type { Message, LLMRequest } from "../llm-types.ts";

// 보존 구간을 쉽게 식별할 사용자 메시지를 만든다.
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
// 모의 요청을 만들어 네트워크 없이 토큰 정책을 검증한다.
const request = (messages: Message[] = []): LLMRequest => ({ system: "", tools: [], messages });

test("휴리스틱은 ASCII와 한글을 구분하고 UTF-16 이모지를 중복 계산하지 않는다", () => {
  assert.equal(estimateTextTokens("abcd"), 1);
  assert.equal(estimateTextTokens("한글"), 4);
  assert.equal(estimateTextTokens("😀"), 2);
});

test("시스템·스킬과 툴 정의만 커져도 압축 기준에 반영한다", () => {
  const base = request([user("안녕")]);
  const budget = { contextWindow: 1000, reservedOutputTokens: 100, safetyMarginTokens: 100, retainRatio: 0.1 };
  assert.equal(shouldCompact(base, budget), false);
  assert.equal(shouldCompact({ ...base, system: "지침".repeat(1000) }, budget), true);
  assert.equal(shouldCompact({ ...base, tools: [{ name: "tool", description: "x".repeat(4000), parameters: {} }] }, budget), true);
  const size = estimateRequestTokens(base);
  assert.equal(shouldCompact(base, { ...budget, contextWindow: size + 200, retainRatio: 0 }), true);
  assert.equal(shouldCompact(base, { ...budget, contextWindow: size + 201, retainRatio: 0 }), false);
});

test("이미지 Base64 길이는 무시하고 장수·재전송 정보는 크기에 반영한다", () => {
  const image = { type: "image" as const, mediaType: "image/png" as const, width: 100, height: 100, data: "abc" };
  const a: Message = { role: "user", content: [image] };
  assert.equal(estimateMessageTokens(a), estimateMessageTokens({ role: "user", content: [{ ...image, data: "x".repeat(100_000) }] }));
  assert.ok(estimateMessageTokens({ role: "user", content: [image, image] }) > estimateMessageTokens(a) + 4000);
  const assistant: Message = { role: "assistant", content: [{ type: "text", text: "답변" }] };
  assert.ok(estimateMessageTokens({ ...assistant, replayState: { adapter: "test", provider: "test", model: "test", data: "r".repeat(5000) } }) > estimateMessageTokens(assistant));
});

test("모델별 정책과 출력 예약이 유지되고 잘못된 예산을 거부한다", () => {
  const farm = createModelAdapter("farm", undefined).contextBudget!;
  const luna = createModelAdapter("luna", undefined).contextBudget!;
  const haiku = createModelAdapter("haiku", undefined).contextBudget!;
  assert.equal(compactionThreshold(farm), 128_000);
  assert.equal(compactionThreshold(haiku), 128_000);
  assert.equal(compactionThreshold(luna), 712_000);
  assert.equal(retentionTokens(farm), 32_000);
  assert.equal(retentionTokens(haiku), 32_000);
  assert.equal(retentionTokens(luna), 168_000);
  assert.equal(retentionTokens({ ...farm, contextWindow: 1001 }), 160);
  assert.throws(() => compactionThreshold({ ...farm, retainRatio: 1 }), /예산/);
  assert.equal(compactionThreshold(haiku, 64_000), 96_000);
  assert.throws(() => compactionThreshold({ ...farm, contextWindow: 10 }), /예산/);
  assert.throws(() => compactionThreshold({ ...farm, safetyMarginTokens: NaN }), /예산/);
});

test("최근 요청·이미지·assistant replay를 그대로 보존하고 오래된 부분만 요약한다", async () => {
  const old = user("오래된 기록 ".repeat(500));
  const recent: Message[] = [user("디자인 고친 뒤 테스트해줘"), {
    role: "assistant", content: [{ type: "text", text: "수정했다" }],
    replayState: { adapter: "test", provider: "test", model: "test", data: { native: true } },
  }];
  const session = { messages: [old, ...recent] };
  const before = structuredClone(session.messages);
  await compactSession(session, async (items) => {
    assert.deepEqual(items, [old]);
    return "과거 작업 요약";
  }, recent.reduce((sum, item) => sum + estimateMessageTokens(item), 0));
  assert.deepEqual(session.messages.slice(1), recent);
  assert.equal(session.messages[1], recent[0]);
  assert.deepEqual(old, before[0]);
});

test("복수 툴 결과 중간의 보존 경계는 assistant 호출 앞으로 옮긴다", async () => {
  const old = user("old ".repeat(1000));
  const pair: Message[] = [{ role: "assistant", content: [
    { type: "tool-call", id: "a", name: "read", arguments: "{}" },
    { type: "tool-call", id: "b", name: "read", arguments: "{}" },
  ] }, { role: "tool", content: [{ type: "tool-result", toolCallId: "a", content: "A" }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "b", content: "B" }] }];
  const session = { messages: [old, ...pair] };
  await compactSession(session, async (items) => { assert.deepEqual(items, [old]); return "요약"; }, 1);
  assert.deepEqual(session.messages.slice(1), pair);
});

test("최신 대화만 있으면 요약하지 않고 처음 보는 이미지도 보존한다", async () => {
  const session = { messages: [user("x".repeat(20_000))] };
  const original = session.messages;
  assert.equal(await compactSession(session, async () => { throw new Error("호출 금지"); }, 100), false);
  assert.equal(session.messages, original);
  const image: Message = { role: "user", content: [{ type: "image", mediaType: "image/png", data: "abc", width: 1, height: 1 }] };
  session.messages.push(image);
  await compactSession(session, async (items) => { assert.deepEqual(items, [original[0]]); return "요약"; }, 100);
  assert.equal(session.messages.at(-1), image);
});

test("요약 도중 추가된 메시지를 덮어쓰지 않는다", async () => {
  const session = { messages: [user("x".repeat(2000)), user("recent")] };
  await assert.rejects(compactSession(session, async () => {
    session.messages.push(user("도중에 추가"));
    return "요약";
  }, 1), /대화가 변경/);
  assert.equal(session.messages.length, 3);
});
