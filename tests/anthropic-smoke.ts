import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createModelAdapter } from "../model-config.ts";
import { textOf } from "../llm-types.ts";
import type { LLMRequest } from "../llm-types.ts";
import { validateToolArguments } from "../tool-schema.ts";
import { builtinToolDefinitions } from "./builtin-tool-definitions.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarnessPaths } from "../harness-paths.ts";
import { createMcpServerConfigs } from "../mcp-servers.ts";
import { connectMcpServers, closeMcpServers } from "../mcp-client.ts";

// 실제 기본 툴 정의도 전송하되 실행하지 않고 임시 검증값만 주고받는다.
async function main() {
  assert.ok(process.env.AIPROXY_TOKEN, ".env의 AIPROXY_TOKEN을 설정하세요.");
  const originalFetch = globalThis.fetch;
  const definitions = builtinToolDefinitions();
  const builtinCount = definitions.length;
  let temporary: string | undefined;
  let clients: Awaited<ReturnType<typeof connectMcpServers>> = [];
  let requests = 0;
  // 테스트 요청에 제한 시간을 두고 키·본문 대신 응답 상태와 블록 타입만 출력한다.
  globalThis.fetch = async (url, init) => {
    const target = url instanceof Request ? url.url : String(url);
    if (target !== "https://aiproxy-api.backoffice.bagelgames.com/anthropic/v1/messages") return originalFetch(url, init);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.stream, true);
    const response = await originalFetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    // 본문은 SSE다. 진단 출력용으로만 이벤트를 나눠 모델·종료 사유·블록 종류·조각 수를 읽는다. 어댑터는 원본 응답을 그대로 읽는다.
    const events = (await response.clone().text()).split(/\r?\n\r?\n/)
      .map((block) => block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n"))
      .filter(Boolean).map((payload) => { try { return JSON.parse(payload); } catch { return {}; } });
    const start = events.find((event: any) => event.type === "message_start")?.message ?? events.at(-1) ?? {};
    const stop = events.find((event: any) => event.type === "message_delta")?.delta ?? {};
    console.log(JSON.stringify({ request: ++requests, http: response.status, contentType: response.headers.get("content-type"), model: start.model,
      stopReason: stop.stop_reason, contentTypes: events.filter((event: any) => event.type === "content_block_start").map((event: any) => event.content_block?.type),
      textDeltaEvents: events.filter((event: any) => event.type === "content_block_delta" && event.delta?.type === "text_delta").length }));
    if (response.ok) assert.match(String(start.model), /claude-haiku-4-5/);
    return response;
  };
  try {
    if (process.argv.includes("--mcp")) {
      // 사용자 데이터 대신 임시 폴더로 MCP를 연결하고 정의만 수집한다. MCP 툴은 실행하지 않는다.
      temporary = await mkdtemp(join(tmpdir(), "harness-anthropic-catalog-"));
      const paths = createHarnessPaths(join(temporary, "project"), join(temporary, "home"));
      const configs = await createMcpServerConfigs(paths);
      clients = await connectMcpServers({
        // 실행 함수는 저장하지 않아 모델이 실제 파일·메모리를 변경할 수 없게 한다.
        register(tool) { definitions.push({ name: tool.name, description: tool.description, parameters: tool.parameters }); },
      }, configs);
      assert.equal(configs.length, 2, "실제 하네스와 같은 MCP 서버 2개(memory·playwright)가 필요합니다.");
      assert.equal(clients.length, configs.length, "모든 MCP 서버가 연결되어야 합니다.");
    }
    console.log(`Haiku에 실제 툴 정의 ${definitions.length}개 전송 (기본 ${builtinCount}개 + MCP ${definitions.length - builtinCount}개)`);
    const adapter = createModelAdapter("haiku", process.env.AIPROXY_TOKEN);
    // Haiku 4.5는 접두어가 4,096토큰 이상일 때만 캐시한다. 툴 13개(약 3,300자)와 짧은 지침만으로는 못 넘기므로 고정 지침 본문을 덧붙여 실제 앱(약 25,000자)과 비슷한 크기로 만든다.
    const guidelines = Array.from({ length: 200 }, (_, index) =>
      `Guideline ${index + 1}: verify the requested behavior with observed evidence before reporting completion; a passing build alone is not proof.`).join("\n");
    const request: LLMRequest = { system: `Follow the user's request. Keep answers short.\n\n${guidelines}`,
      messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly pong." }] }],
      // 실제 코어의 스텝 요청처럼 접두어 재사용을 알려 cache_control 표시를 붙인다.
      tools: definitions, maxOutputTokens: 2048, promptCache: true };
    // 응답 usage의 캐시 필드를 요청별로 남긴다. 키·본문은 출력하지 않는다.
    const cacheLog = (label: string, usage: { inputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number } | undefined) =>
      console.log(JSON.stringify({ [label]: { inputTokens: usage?.inputTokens, cacheRead: usage?.cachedInputTokens, cacheWrite: usage?.cacheWriteInputTokens } }));
    // 텍스트 조각이 도착 순서대로 콜백에 오고 합치면 완성본과 같은지 확인한다.
    const deltas: string[] = [];
    const first = await adapter.generate(request, { async onRequest() {}, async onResponse() {}, onTextDelta: (text) => { deltas.push(text); } });
    assert.equal(first.stopReason, "stop");
    assert.match(textOf(first.message), /pong/i);
    assert.ok(deltas.length > 0, "SSE 텍스트 조각이 onTextDelta로 전달되어야 합니다.");
    assert.equal(deltas.join(""), textOf(first.message), "조각을 합친 결과가 완성 텍스트와 같아야 합니다.");
    console.log(`PASS: 스트리밍 조각 ${deltas.length}개 수신, 합친 결과가 완성본과 일치`);
    cacheLog("usage1", first.usage);
    assert.ok((first.usage?.cacheWriteInputTokens ?? 0) > 0, "첫 요청은 tools+system 접두어를 캐시에 써야 합니다(AIProxy가 cache_control을 통과시키고 접두어가 4,096토큰 이상이어야 함).");

    const parameters = { type: "object", properties: { label: { type: "string" } }, required: ["label"] };
    request.tools.push({ name: "readProbe", description: "Read a fresh verification value for a label.", parameters });
    request.messages.push(first.message, { role: "user", content: [{ type: "text", text:
      "Call readProbe exactly once with label adapter-smoke. Then report the exact value the tool returned. Do not invent it." }] });
    request.messages = JSON.parse(JSON.stringify(request.messages));
    const second = await adapter.generate(request);
    // 두 번째 요청은 툴 정의가 하나 늘어 접두어가 바뀌므로 읽기 없이 다시 쓴다. 이후 요청부터 읽힌다.
    cacheLog("usage2 (tools changed)", second.usage);
    assert.equal(second.stopReason, "tool-calls");
    const calls = second.message.content.filter((block) => block.type === "tool-call");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "readProbe");
    const args = JSON.parse(calls[0].arguments);
    assert.equal(validateToolArguments(parameters, args), undefined);
    assert.equal(args.label, "adapter-smoke");
    const value = randomUUID();
    request.messages.push(second.message, { role: "tool", content: [{ type: "tool-result", toolCallId: calls[0].id, content: value }] });
    request.messages = JSON.parse(JSON.stringify(request.messages));
    const third = await adapter.generate(request);
    cacheLog("usage3", third.usage);
    assert.equal(third.stopReason, "stop");
    assert.ok(textOf(third.message).includes(value));
    assert.ok((third.usage?.cachedInputTokens ?? 0) > 0, "같은 tools+system과 대화 접두어를 다시 보낸 요청은 캐시를 읽어야 합니다.");
    request.messages.push(third.message, { role: "user", content: [{ type: "text", text:
      "What exact value did the tool return in the previous turn? Answer with that value only; do not call the tool again." }] });
    request.messages = JSON.parse(JSON.stringify(request.messages));
    const fourth = await adapter.generate(request);
    cacheLog("usage4", fourth.usage);
    assert.equal(fourth.stopReason, "stop");
    assert.ok(textOf(fourth.message).includes(value));
    assert.ok((fourth.usage?.cachedInputTokens ?? 0) >= (third.usage?.cachedInputTokens ?? 0), "대화가 늘수록 읽는 접두어도 늘어야 합니다.");
    assert.equal(requests, 4);
    console.log("PASS: Haiku 텍스트 → 툴 인자 → 실제 결과 반영 → JSON 복원 후 다음 턴 (HTTP 4회), 3·4번째 요청에서 캐시 읽기 확인");
  } finally {
    globalThis.fetch = originalFetch;
    await closeMcpServers(clients);
    // 이 테스트가 mkdtemp로 만든 디렉터리만 제거한다.
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

await main();
