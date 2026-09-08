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
    const response = await originalFetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    const data = await response.clone().json();
    console.log(JSON.stringify({ request: ++requests, http: response.status, model: data.model,
      stopReason: data.stop_reason, contentTypes: (data.content ?? []).map((block: any) => block.type) }));
    if (response.ok) assert.match(data.model, /claude-haiku-4-5/);
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
      assert.equal(configs.length, 4, "실제 하네스와 같은 MCP 서버 4개가 필요합니다.");
      assert.equal(clients.length, configs.length, "모든 MCP 서버가 연결되어야 합니다.");
    }
    console.log(`Haiku에 실제 툴 정의 ${definitions.length}개 전송 (기본 ${builtinCount}개 + MCP ${definitions.length - builtinCount}개)`);
    const adapter = createModelAdapter("haiku", process.env.AIPROXY_TOKEN);
    const request: LLMRequest = { system: "Follow the user's request. Keep answers short.",
      messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly pong." }] }],
      tools: definitions, maxOutputTokens: 2048 };
    const first = await adapter.generate(request);
    assert.equal(first.stopReason, "stop");
    assert.match(textOf(first.message), /pong/i);

    const parameters = { type: "object", properties: { label: { type: "string" } }, required: ["label"] };
    request.tools.push({ name: "readProbe", description: "Read a fresh verification value for a label.", parameters });
    request.messages.push(first.message, { role: "user", content: [{ type: "text", text:
      "Call readProbe exactly once with label adapter-smoke. Then report the exact value the tool returned. Do not invent it." }] });
    request.messages = JSON.parse(JSON.stringify(request.messages));
    const second = await adapter.generate(request);
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
    assert.equal(third.stopReason, "stop");
    assert.ok(textOf(third.message).includes(value));
    request.messages.push(third.message, { role: "user", content: [{ type: "text", text:
      "What exact value did the tool return in the previous turn? Answer with that value only; do not call the tool again." }] });
    request.messages = JSON.parse(JSON.stringify(request.messages));
    const fourth = await adapter.generate(request);
    assert.equal(fourth.stopReason, "stop");
    assert.ok(textOf(fourth.message).includes(value));
    assert.equal(requests, 4);
    console.log("PASS: Haiku 텍스트 → 툴 인자 → 실제 결과 반영 → JSON 복원 후 다음 턴 (HTTP 4회)");
  } finally {
    globalThis.fetch = originalFetch;
    await closeMcpServers(clients);
    // 이 테스트가 mkdtemp로 만든 디렉터리만 제거한다.
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

await main();
