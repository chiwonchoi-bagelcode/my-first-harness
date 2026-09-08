import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { contentBlocks, imageFromBytes, MAX_IMAGE_BYTES } from "./image-content.ts";
import type { ContentBlock, ToolContent } from "./llm-types.ts";

// MCP 서버를 실행하거나 연결할 위치와 인증 옵션.
export type McpServerConfig = { name: string } & (
  | { transport: "stdio"; command: string; args: string[]; env?: Record<string, string>; cwd?: string }
  | { transport: "http"; url: string; headers?: Record<string, string> }
);

// 원격 MCP 도구를 기존 ToolManager에 등록하기 위한 정의와 실행 함수.
export type McpTool = {
  name: string;
  description: string;
  parameters: Record<string, any>;
  execute: (args: Record<string, unknown>) => Promise<ToolContent>;
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

// 텍스트·이미지를 순서대로 검사하고, 이미지가 없는 기존 MCP 결과는 문자열로 반환한다.
export async function mcpResultContent(result: CallToolResult): Promise<ToolContent> {
  const parts: ContentBlock[] = [];
  for (const block of result.content) {
    if (block.type === "image") {
      if (block.data.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3)) throw new Error("이미지는 4 MiB 이하여야 합니다.");
      const bytes = Buffer.from(block.data, "base64");
      if (bytes.toString("base64") !== block.data) throw new Error("MCP 이미지의 base64 형식이 올바르지 않습니다.");
      const image = await imageFromBytes(bytes);
      if (image.mediaType !== block.mimeType) throw new Error("MCP 이미지의 MIME 형식과 실제 파일 형식이 다릅니다.");
      parts.push(image);
    } else if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "resource" && "text" in block.resource) {
      parts.push({ type: "text", text: block.resource.text });
    } else if (block.type === "resource_link") {
      parts.push({ type: "text", text: `${block.name}: ${block.uri}` });
    } else {
      parts.push({ type: "text", text: `[MCP ${block.type}: 현재 하네스는 이 비텍스트 결과를 표시할 수 없습니다.]` });
    }
  }
  if (result.structuredContent !== undefined) parts.push({ type: "text", text: JSON.stringify(result.structuredContent) });
  return parts.some((block) => block.type === "image") ? parts
    : parts.map((block) => block.type === "text" ? block.text : "").join("\n") || "(빈 MCP 결과)";
}

// MCP의 모든 도구 정의를 조회하고 원격 호출을 실행 함수로 연결한다.
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
          const content = await mcpResultContent(result);
          if (result.isError) throw new Error(contentBlocks(content)
            .filter((block) => block.type === "text").map((block) => block.text).join("\n") || "MCP 툴 실행 실패");
          return content;
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

// 서버 하나에 연결해 툴 목록을 받는다. 실패하면 생성한 연결부터 닫는다.
export async function connectMcpServer(server: McpServerConfig) {
  const client = new Client({ name: "my-first-harness", version: "1.0.0" });
  try {
    const transport = server.transport === "stdio"
      ? new StdioClientTransport({ command: server.command, args: server.args, cwd: server.cwd, env: server.env })
      : new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } });
    await client.connect(transport, requestOptions);
    const tools = await discoverMcpTools(client, server.name);
    return { client, tools, server };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

// 서버 연결 후 발견한 도구를 등록하고 종료 때 닫을 클라이언트를 반환한다.
export async function connectMcpServers(
  toolManager: { register(tool: McpTool): void },
  servers: McpServerConfig[],
) {
  if (new Set(servers.map((server) => server.name)).size !== servers.length) {
    throw new Error("MCP 서버 name은 서로 달라야 합니다.");
  }
  // 서버마다 연결은 별도지만, 툴은 모두 기존 ToolManager에 등록한다.
  const connections = await Promise.all(servers.map(async (server) => {
    try {
      return await connectMcpServer(server);
    } catch (error) {
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

// 여러 서버를 연결한 테스트·CLI 호출부에서 소유 연결들을 함께 닫는다.
export async function closeMcpServers(clients: Client[]) {
  await Promise.allSettled(clients.map((client) => client.close()));
}
