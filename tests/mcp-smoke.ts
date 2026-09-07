// 실 서버 통신 테스트. pnpm test에는 포함하지 않는다. LLM/API 키도 사용하지 않는다.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarnessPaths } from "../harness-paths.ts";
import { createMcpServerConfigs } from "../mcp-servers.ts";
import { closeMcpServers, connectMcpServers, type McpTool } from "../mcp-client.ts";
import { validateToolArguments } from "../tool-schema.ts";

const temporary = await mkdtemp(join(tmpdir(), "harness-mcp-test-"));
const paths = createHarnessPaths(join(temporary, "project"), join(temporary, "home"));
const tools: McpTool[] = [];
const configs = await createMcpServerConfigs(paths);
const clients = await connectMcpServers({ register: (tool) => tools.push(tool) }, configs);

async function execute(name: string, args: Record<string, unknown>) {
  const tool = tools.find((tool) => tool.name === name);
  assert.ok(tool, `툴 등록 실패: ${name}`);
  assert.equal(validateToolArguments(tool.parameters, args), undefined);
  const result = await tool.execute(args);
  console.log(`[PASS] ${name}: ${result.slice(0, 180).replaceAll("\n", " ")}`);
  return result;
}

try {
  assert.equal(clients.length, configs.length, "모든 실제 MCP 서버가 연결되어야 합니다.");
  const file = join(paths.projectHarnessDirectory, "mcp-files", "hello.txt");
  await execute("mcp__filesystem__write_file", { path: file, content: "Hello from real MCP!" });
  assert.equal(await readFile(file, "utf8"), "Hello from real MCP!");
  assert.match(await execute("mcp__filesystem__read_text_file", { path: file }), /Hello from real MCP!/);
  await assert.rejects(execute("mcp__filesystem__read_text_file", { path: join(temporary, "outside.txt") }), /[Aa]ccess denied|outside allowed/);

  await execute("mcp__memory__create_entities", {
    entities: [{ name: "MCP smoke test", entityType: "test", observations: ["favorite color is blue"] }],
  });
  assert.match(await execute("mcp__memory__search_nodes", { query: "MCP smoke test" }), /favorite color is blue/);
  assert.match(await readFile(join(paths.userHarnessDirectory, "mcp", "memory.jsonl"), "utf8"), /favorite color is blue/);
  assert.match(await execute("mcp__microsoft__microsoft_docs_search", { query: "What is TypeScript?" }), /https:\/\/learn.microsoft.com/);
  assert.match(await execute("mcp__cloudflare__search_cloudflare_documentation", { query: "What are Cloudflare Workers?" }), /[Ww]orkers/);
  console.log(`실 서버 4개, 등록 툴 ${tools.length}개: 연결·인자 검증·실행·결과 수신 확인`);
} finally {
  await closeMcpServers(clients);
  // 이 테스트가 mkdtemp로 만든 디렉터리만 제거한다. 사용자 파일/메모리는 건드리지 않는다.
  await rm(temporary, { recursive: true, force: true });
}
