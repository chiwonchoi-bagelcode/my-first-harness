import assert from "node:assert/strict";
import test from "node:test";
import { callLLM, summarize } from "../llm.ts";

test("요약 요청은 툴 없이 기록 JSON과 요약 지침을 보낸다", async (t) => {
  const conversation = [
    { role: "assistant", tool_calls: [{ id: "a", function: { name: "counterUP" } }] },
    { role: "tool", tool_call_id: "a", content: "3" },
  ];
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    assert.equal(body.model, "gpt-4o");
    assert.equal(body.tools, undefined);
    assert.equal(body.max_completion_tokens, 2048);
    assert.equal(body.messages[0].role, "system");
    assert.match(body.messages[0].content, /실제 툴 결과/);
    assert.equal(body.messages[1].role, "user");
    assert.deepEqual(JSON.parse(body.messages[1].content), conversation);
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "카운터 값은 3." } }] });
  });
  assert.equal(await summarize("test-token", conversation), "카운터 값은 3.");
});

test("잘린 요약이나 빈 요약은 사용하지 않는다", async (t) => {
  for (const [finish_reason, content] of [["length", "잘린 요약"], ["stop", ""]]) {
    const mocked = t.mock.method(globalThis, "fetch", async () =>
      Response.json({ choices: [{ finish_reason, message: { content } }] }),
    );
    await assert.rejects(summarize("test-token", []), /정상적으로 완료/);
    mocked.mock.restore();
  }
});

test("API 오류는 choices 접근 오류 대신 서버 메시지를 전달한다", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: { message: "요청 실패" } }, { status: 400 }),
  );
  await assert.rejects(callLLM("test-token", { messages: [] }), /요청 실패/);
});
