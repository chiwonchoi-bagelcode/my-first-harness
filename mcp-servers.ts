import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessPaths } from "./harness-paths.ts";
import type { McpServerConfig } from "./mcp-client.ts";

export async function createMcpServerConfigs(paths: HarnessPaths): Promise<McpServerConfig[]> {
  const filesDirectory = join(paths.projectHarnessDirectory, "mcp-files");
  const memoryDirectory = join(paths.userHarnessDirectory, "mcp");
  await mkdir(filesDirectory, { recursive: true });
  await mkdir(memoryDirectory, { recursive: true });

  const servers: McpServerConfig[] = [];
  const localServers = [
    {
      name: "filesystem",
      packageName: "@modelcontextprotocol/server-filesystem",
      args: [filesDirectory],
    },
    {
      name: "memory",
      packageName: "@modelcontextprotocol/server-memory",
      args: [],
      env: { MEMORY_FILE_PATH: join(memoryDirectory, "memory.jsonl") },
    },
  ];
  for (const server of localServers) {
    try {
      const entry = fileURLToPath(import.meta.resolve(`${server.packageName}/dist/index.js`));
      servers.push({
        name: server.name,
        transport: "stdio",
        command: "node",
        args: [entry, ...server.args],
        env: server.env,
      });
    } catch {
      // 실행파일에 외부 서버까지 포함되는 것은 아니다. 없는 서버만 건너뛴다.
      console.warn(`[mcp] ${server.name}: 로컬 패키지가 없습니다. Node.js와 ${server.packageName} 설치가 필요합니다.`);
    }
  }
  servers.push(
    {
      name: "microsoft",
      transport: "http",
      url: "https://learn.microsoft.com/api/mcp",
    },
    {
      name: "cloudflare",
      transport: "http",
      url: "https://docs.mcp.cloudflare.com/mcp",
    },
  );
  return servers;
}
