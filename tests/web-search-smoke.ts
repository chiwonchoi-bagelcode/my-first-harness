// 제공자 실행 웹 검색이 어댑터를 통해 동작하는지 확인하는 연기 테스트(유료).
// 사용법: node tests/web-search-smoke.ts [--model haiku|fable|luna|farm]
import "dotenv/config";
import assert from "node:assert/strict";
import { createModelAdapter } from "../model-config.ts";
import { textOf } from "../llm-types.ts";

const args = process.argv.slice(2);
const model = args[args.indexOf("--model") + 1] ?? "haiku";
const token = model === "farm" ? process.env.BCF_API_KEY : process.env.AIPROXY_TOKEN;
assert.ok(token, "모델 키가 없습니다(.env의 AIPROXY_TOKEN 또는 BCF_API_KEY).");

const adapter = createModelAdapter(model, token);
const started = performance.now();
const result = await adapter.generate({
  system: "Answer in one sentence and include the URL of the source you used.",
  messages: [{ role: "user", content: [{ type: "text", text: "Search the web: in what year was the game Tetris first released, and who created it?" }] }],
  tools: [], maxOutputTokens: 400,
});
const elapsed = Math.round(performance.now() - started);
const text = textOf(result.message);
console.log(`[${model}] ${elapsed}ms stop=${result.stopReason} usage=${JSON.stringify(result.usage)}`);
console.log(`[answer] ${text}`);
assert.equal(result.stopReason, "stop");
assert.match(text, /1984/, "검색 결과가 답에 반영되어야 한다.");
assert.match(text, /https?:\/\//, "출처 URL이 있어야 한다.");
const replayBlocks: any[] = Array.isArray((result.message.replayState?.data as any)?.content) ? (result.message.replayState?.data as any).content
  : Array.isArray((result.message.replayState?.data as any)?.output) ? (result.message.replayState?.data as any).output : [];
const searchBlocks = replayBlocks.filter((block) => block?.type === "server_tool_use" || block?.type === "web_search_call");
console.log(`[replay] blocks=${replayBlocks.map((block) => block?.type).join(",")} search=${searchBlocks.length}`);
assert.ok(searchBlocks.length >= 1, "검색 호출 블록이 재전송 정보에 있어야 한다.");
