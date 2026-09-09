import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessPaths } from "./harness-paths.ts";
import type { McpServerConfig } from "./mcp-client.ts";

// 게임 테스트 컨트롤러다. Playwright MCP가 탭마다 프로세스 안에서 실행하며 game-testing/bridge.ts가 명령을 보낸다.
const gameTestingController = fileURLToPath(new URL("./game-testing/mcp-controller.cjs", import.meta.url));

// Playwright MCP의 출력 폴더다. 스크린샷 파일과 게임 테스트 컨트롤러 연결 정보가 여기에 놓인다.
export function playwrightOutputDirectory(paths: HarnessPaths) {
  return join(paths.projectHarnessDirectory, "mcp-playwright");
}

// 설치된 로컬 MCP 서버의 실행 설정을 만든다. memory는 MCP 학습·토글 검증용, playwright는 브라우저 조작과 게임 테스트용이다.
export async function createMcpServerConfigs(paths: HarnessPaths): Promise<McpServerConfig[]> {
  const memoryDirectory = join(paths.userHarnessDirectory, "mcp");
  await mkdir(memoryDirectory, { recursive: true });

  const servers: McpServerConfig[] = [];
  const localServers = [
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
      // 개인 프로필을 쓰지 않고, 스크린샷은 기본 설정대로 이미지로 반환한다. 게임 테스트 컨트롤러를 탭마다 붙인다.
      args: ["--isolated", "--output-dir", playwrightOutputDirectory(paths), "--init-page", gameTestingController],
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
  return servers;
}
