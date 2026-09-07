import assert from "node:assert/strict";
import test from "node:test";
import { summarize } from "../llm.ts";
import { registerOtherLLMTools } from "../tools/other-llm.ts";
import type { LLMAdapter, LLMRequest, Message, StopReason } from "../llm-types.ts";

test("요약 요청은 툴 없이 공통 기록 JSON과 요약 지침을 보낸다", async () => {
  const conversation: Message[] = [
    { role: "assistant", content: [{ type: "tool-call", id: "a", name: "counterUP", arguments: "{}" }],
      replayState: { adapter: "test", provider: "test", model: "test", data: { native: "not prompt" } } },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "a", content: "3" }] },
  ];
  const adapter: LLMAdapter = {
    async generate(request) {
      assert.deepEqual(request.tools, []);
      assert.equal(request.maxOutputTokens, 2048);
      assert.match(request.system, /실제 툴 결과/);
      assert.equal(request.messages[0].role, "user");
      const block = request.messages[0].content[0];
      if (block.type !== "text") throw new Error("expected text");
      assert.deepEqual(JSON.parse(block.text), conversation.map(({ role, content }) => ({ role, content })));
      assert.doesNotMatch(block.text, /replayState/);
      return { stopReason: "stop", message: { role: "assistant", content: [{ type: "text", text: "카운터 값은 3." }] } };
    },
  };
  assert.equal(await summarize(adapter, conversation), "카운터 값은 3.");
  assert.ok(conversation[0].role === "assistant" && conversation[0].replayState);
});

test("잘린 요약·빈 요약·툴 요청은 사용하지 않는다", async () => {
  const cases: [StopReason, string][] = [["max-tokens", "잘린 요약"], ["stop", ""], ["other", "거절"], ["tool-calls", "호출"]];
  for (const [stopReason, text] of cases) {
    const adapter: LLMAdapter = {
      async generate() { return { stopReason, message: { role: "assistant", content: [{ type: "text", text }] } }; },
    };
    await assert.rejects(summarize(adapter, []), /정상적으로 완료/);
  }
});

test("다른 LLM에게 묻기 툴도 공통 어댑터로 독립적인 요청을 보낸다", async () => {
  let tool: any;
  let request: LLMRequest;
  registerOtherLLMTools({ register(value: any) { tool = value; } }, {
    async generate(value) {
      request = value;
      return { stopReason: "stop", message: { role: "assistant", content: [{ type: "text", text: "의견입니다" }] } };
    },
  });
  assert.equal(await tool.execute({ ask: "어떻게 생각해?" }), "의견입니다");
  assert.deepEqual(request!, { system: "", tools: [],
    messages: [{ role: "user", content: [{ type: "text", text: "어떻게 생각해?" }] }],
  });
});
