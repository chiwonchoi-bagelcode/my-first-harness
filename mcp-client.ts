import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type McpServerConfig = { name: string } & (
  | { transport: "stdio"; command: string; args: string[]; env?: Record<string, string>; cwd?: string }
  | { transport: "http"; url: string; headers?: Record<string, string> }
);

export type McpTool = {
  name: string;
  description: string;
  parameters: Record<string, any>;
  execute: (args: Record<string, unknown>) => Promise<string>;
};

const requestOptions = { timeout: 15_000 };

// 서버의 원래 이름은 execute의 closure에 보존한다. 공개 이름을 역으로 파싱하지 않는다.
export function mcpToolName(server: string, tool: string) {
  const original = `mcp__${server}__${tool}`;
  const normalized = original.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (original === normalized && normalized.length <= 64) return original;
  const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 12);
  return `${normalized.slice(0, 51)}_${hash}`;
}

// 현재 하네스의 tool content는 문자열이다. 이미지/오디오는 지원하지 않는다고 명시한다.
export function mcpResultText(result: CallToolResult) {
  const parts = result.content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "resource" && "text" in block.resource) return block.resource.text;
    if (block.type === "resource_link") return `${block.name}: ${block.uri}`;
    return `[MCP ${block.type}: 현재 하네스는 이 비텍스트 결과를 표시할 수 없습니다.]`;
  });
  if (result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  return parts.join("\n") || "(빈 MCP 결과)";
}

export async function discoverMcpTools(client: Client, serverName: string): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const page = await client.listTools(cursor ? { cursor } : {}, requestOptions);
    for (const remote of page.tools) {
      tools.push({
        name: mcpToolName(serverName, remote.name),
        description: remote.description ?? "",
        parameters: remote.inputSchema,
        execute: async (args) => {
          const result = await client.callTool(
            { name: remote.name, arguments: args },
            undefined,
            requestOptions,
          ) as CallToolResult;
          const text = mcpResultText(result);
          if (result.isError) throw new Error(text);
          return text;
        },
      });
    }
    cursor = page.nextCursor;
    if (cursor && seenCursors.has(cursor)) throw new Error("MCP 툴 목록 cursor가 반복됩니다.");
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
    throw new Error("MCP 서버가 중복된 툴 이름을 반환했습니다.");
  }
  return tools;
}

export async function connectMcpServers(
  toolManager: { register(tool: McpTool): void },
  servers: McpServerConfig[],
) {
  if (new Set(servers.map((server) => server.name)).size !== servers.length) {
    throw new Error("MCP 서버 name은 서로 달라야 합니다.");
  }
  // 서버마다 연결은 별도지만, 툴은 모두 기존 ToolManager에 등록한다.
  const connections = await Promise.all(servers.map(async (server) => {
    const client = new Client({ name: "my-first-harness", version: "1.0.0" });
    try {
      const transport = server.transport === "stdio"
        ? new StdioClientTransport({
            command: server.command,
            args: server.args,
            cwd: server.cwd,
            // SDK의 기본 환경 + 명시한 값만 전달한다. process.env 전체를 넘기지 않는다.
            env: server.env,
          })
        : new StreamableHTTPClientTransport(new URL(server.url), {
            requestInit: { headers: server.headers },
          });
      await client.connect(transport, requestOptions);
      const tools = await discoverMcpTools(client, server.name);
      return { client, tools, server };
    } catch (error) {
      await client.close().catch(() => {});
      console.warn(`[mcp] ${server.name} 연결 실패 — 건너뜁니다: ${error instanceof Error ? error.message : error}`);
      return undefined;
    }
  }));
  const clients: Client[] = [];
  // 연결 완료 순서가 달라도 모델에게 보내는 툴 순서는 설정 순서로 고정한다.
  for (const connection of connections) {
    if (!connection) continue;
    for (const tool of connection.tools) toolManager.register(tool);
    clients.push(connection.client);
    console.log(`[mcp] ${connection.server.name} (${connection.server.transport}): 툴 ${connection.tools.length}개 등록`);
  }
  return clients;
}

// 런타임 on/off 기능이 아니라 하네스 종료 시 자식 프로세스/연결을 정리하기 위한 코드다.
export async function closeMcpServers(clients: Client[]) {
  await Promise.allSettled(clients.map((client) => client.close()));
}
