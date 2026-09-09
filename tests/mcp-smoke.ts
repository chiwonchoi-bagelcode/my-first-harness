// 실 서버 통신 테스트. pnpm test에는 포함하지 않는다. LLM/API 키도 사용하지 않는다.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarnessPaths } from "../harness-paths.ts";
import { createMcpServerConfigs } from "../mcp-servers.ts";
import { closeMcpServers, connectMcpServers, type McpTool } from "../mcp-client.ts";
import { validateToolArguments } from "../tool-schema.ts";

const temporary = await mkdtemp(join(tmpdir(), "harness-mcp-test-"));
const paths = createHarnessPaths(join(temporary, "project"), join(temporary, "home"));
// stdio 서버의 cwd로 쓰이므로 실제 실행처럼 작업 폴더가 존재해야 한다. 없으면 spawn이 ENOENT로 실패한다.
await mkdir(paths.workspaceDirectory, { recursive: true });
const tools: McpTool[] = [];
const configs = await createMcpServerConfigs(paths);
const clients = await connectMcpServers({ register: (tool) => tools.push(tool) }, configs);

async function execute(name: string, args: Record<string, unknown>) {
  const tool = tools.find((tool) => tool.name === name);
  assert.ok(tool, `툴 등록 실패: ${name}`);
  assert.equal(validateToolArguments(tool.parameters, args), undefined);
  const result = await tool.execute(args);
  assert.equal(typeof result, "string");
  if (typeof result !== "string") throw new Error("이 테스트의 도구는 텍스트를 반환해야 합니다.");
  console.log(`[PASS] ${name}: ${result.slice(0, 180).replaceAll("\n", " ")}`);
  return result;
}

try {
  assert.equal(clients.length, configs.length, "모든 실제 MCP 서버가 연결되어야 합니다.");

  await execute("mcp__memory__create_entities", {
    entities: [{ name: "MCP smoke test", entityType: "test", observations: ["favorite color is blue"] }],
  });
  assert.match(await execute("mcp__memory__search_nodes", { query: "MCP smoke test" }), /favorite color is blue/);
  assert.match(await readFile(join(paths.userHarnessDirectory, "mcp", "memory.jsonl"), "utf8"), /favorite color is blue/);
  console.log(`실 서버 ${clients.length}개, 등록 툴 ${tools.length}개: 연결 확인 (브라우저 조작은 test:playwright로 별도 검증)`);
} finally {
  await closeMcpServers(clients);
  // 이 테스트가 mkdtemp로 만든 디렉터리만 제거한다. 사용자 파일/메모리는 건드리지 않는다.
  await rm(temporary, { recursive: true, force: true });
}
