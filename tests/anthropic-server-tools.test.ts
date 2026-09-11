import assert from "node:assert/strict";
import test from "node:test";
import { readAnthropicStream } from "../adapters/anthropic-stream.ts";
import { createAnthropicMessagesAdapter } from "../adapters/anthropic-messages.ts";

// 웹 검색이 섞인 Anthropic SSE를 만든다: 서버 툴 호출(입력은 JSON 조각), 검색 결과 블록, 인용 조각이 붙은 본문.
function searchStream() {
  const events = [
    { type: "message_start", message: { type: "message", role: "assistant", model: "claude-haiku-4-5-20251001", content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"query\":" } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "\"tetris\"}" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "https://example.com/t", title: "Tetris" }] } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "1984년" } },
    { type: "content_block_delta", index: 2, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://example.com/t", cited_text: "1984" } } },
    { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "에 나왔다." } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 30, server_tool_use: { web_search_requests: 1 } } },
    { type: "message_stop" },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

test("SSE 파서는 서버 툴 호출의 JSON 조각·검색 결과 블록·인용 조각을 조립하고 본문 텍스트는 그대로 둔다", async () => {
  const message = await readAnthropicStream(searchStream());
  const content = message.content as any[];
  assert.deepEqual(content.map((block) => block.type), ["server_tool_use", "web_search_tool_result", "text"]);
  assert.deepEqual(content[0].input, { query: "tetris" });
  assert.equal(content[2].text, "1984년에 나왔다.");
  assert.equal(content[2].citations.length, 1);
  assert.equal((message.usage as any).server_tool_use.web_search_requests, 1);
});

test("스트리밍 어댑터는 검색 블록을 숨긴 본문만 공통 내용으로 내고 재전송 정보에 세 블록을 보관하며 검색 횟수를 사용량에 남긴다", async (t) => {
  t.mock.method(globalThis, "fetch", async () => searchStream());
  const adapter = createAnthropicMessagesAdapter({ provider: "test", baseURL: "https://example.invalid/v1", model: "claude-haiku-4-5-20251001", apiKey: "k",
    stream: true, webSearch: { type: "web_search_20250305", maxUses: 5 } });
  const result = await adapter.generate({ system: "", messages: [], tools: [] });
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.message.content, [{ type: "text", text: "1984년에 나왔다." }]);
  assert.deepEqual(((result.message.replayState?.data as any).content as any[]).map((block) => block.type), ["server_tool_use", "web_search_tool_result", "text"]);
  assert.equal(result.usage?.webSearchRequests, 1);
});
