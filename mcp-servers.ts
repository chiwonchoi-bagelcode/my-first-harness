import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessPaths } from "./harness-paths.ts";
import type { McpServerConfig } from "./mcp-client.ts";

// 설치된 로컬 MCP 서버와 원격 문서 서버의 실행·연결 설정을 만든다.
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
      entry: "dist/index.js",
      args: [filesDirectory],
    },
    {
      name: "memory",
      packageName: "@modelcontextprotocol/server-memory",
      entry: "dist/index.js",
      args: [],
      env: { MEMORY_FILE_PATH: join(memoryDirectory, "memory.jsonl") },
    },
    {
      name: "playwright",
      packageName: "@playwright/mcp",
      entry: "cli.js",
      // 개인 프로필을 쓰지 않고, 스크린샷은 기본 설정대로 이미지로 반환한다.
      args: ["--isolated", "--output-dir",
        join(paths.projectHarnessDirectory, "mcp-playwright")],
    },
  ];
  for (const server of localServers) {
    try {
      const entry = fileURLToPath(new URL(server.entry, import.meta.resolve(`${server.packageName}/package.json`)));
      servers.push({
        name: server.name,
        transport: "stdio",
        command: "node",
        args: [entry, ...server.args],
        env: server.env,
        cwd: paths.workspaceDirectory,
      });
    } catch {
      // 정상 패키지 설치에는 의존성이 포함된다. 누락된 서버만 건너뛴다.
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
