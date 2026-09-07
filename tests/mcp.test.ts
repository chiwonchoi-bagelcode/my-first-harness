import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { discoverMcpTools, mcpResultText, mcpToolName, connectMcpServers, closeMcpServers } from "../mcp-client.ts";
import { validateToolArguments } from "../tool-schema.ts";

test("서버별 이름을 구분하고 긴 이름/특수문자도 64자 안에서 구분한다", () => {
  assert.equal(mcpToolName("a", "add"), "mcp__a__add");
  assert.notEqual(mcpToolName("a", "add"), mcpToolName("b", "add"));
  assert.notEqual(mcpToolName("a", "a.b"), mcpToolName("a", "a_b"));
  assert.notEqual(mcpToolName("a", "x".repeat(90) + "a"), mcpToolName("a", "x".repeat(90) + "b"));
  assert.match(mcpToolName("한글", "x".repeat(90)), /^[a-zA-Z0-9_-]{1,64}$/);
});

test("모든 페이지를 조회하되 등록할 때 실행하지 않고 실제 호출 때 원래 이름/인자를 보낸다", async () => {
  const requests: any[] = [];
  const calls: any[] = [];
  const client = {
    listTools: async (params: any) => {
      requests.push(params);
      return params.cursor
        ? { tools: [{ name: "second", inputSchema: { type: "object" } }] }
        : { tools: [{ name: "add", description: "덧셈", inputSchema: { type: "object" } }], nextCursor: "page2" };
    },
    callTool: async (params: any) => {
      calls.push(params);
      return { content: [{ type: "text", text: "5" }] };
    },
  } as unknown as Client;
  const tools = await discoverMcpTools(client, "calculator");
  assert.deepEqual(requests, [{}, { cursor: "page2" }]);
  assert.equal(tools.length, 2);
  assert.equal(calls.length, 0);
  assert.equal(tools[0].description, "덧셈");
  assert.equal(await tools[0].execute({ a: 2, b: 3 }), "5");
  assert.deepEqual(calls, [{ name: "add", arguments: { a: 2, b: 3 } }]);
});

test("isError 툴 결과는 기존 ToolManager가 처리할 실행 오류로 전달한다", async () => {
  const client = {
    listTools: async () => ({ tools: [{ name: "fail", inputSchema: { type: "object" } }] }),
    callTool: async () => ({ isError: true, content: [{ type: "text", text: "접근 거부" }] }),
  } as unknown as Client;
  const [tool] = await discoverMcpTools(client, "test");
  await assert.rejects(tool.execute({}), /접근 거부/);
});

test("텍스트/구조화 결과를 보존하되 이미지 base64를 모델 텍스트로 보내지 않는다", () => {
  const text = mcpResultText({
    content: [
      { type: "text", text: "결과" },
      { type: "resource", resource: { uri: "file:///example", text: "원문" } },
      { type: "image", data: "BASE64", mimeType: "image/png" },
    ],
    structuredContent: { value: 5 },
  });
  assert.match(text, /결과\n원문/);
  assert.match(text, /표시할 수 없습니다/);
  assert.match(text, /"value":5/);
  assert.doesNotMatch(text, /BASE64/);
});

test("중복된 툴과 반복 cursor를 거부한다", async () => {
  const remote = { name: "add", inputSchema: { type: "object" } };
  await assert.rejects(discoverMcpTools({
    listTools: async () => ({ tools: [remote, remote] }),
  } as unknown as Client, "test"), /중복/);
  await assert.rejects(discoverMcpTools({
    listTools: async () => ({ tools: [], nextCursor: "same" }),
  } as unknown as Client, "test"), /cursor/);
});

test("draft-07과 2020-12 모두 인자를 검증한다", () => {
  for (const $schema of ["http://json-schema.org/draft-07/schema#", "https://json-schema.org/draft/2020-12/schema"]) {
    const schema = { $schema, type: "object", properties: { n: { type: "number" } }, required: ["n"] };
    assert.equal(validateToolArguments(schema, { n: 3 }), undefined);
    assert.match(validateToolArguments(schema, { n: "3" })!, /툴 인자 오류/);
  }
  assert.match(validateToolArguments({ $schema: "https://unsupported.example/schema" }, {})!, /툴 스키마 오류/);
});

test("한 서버의 연결 실패를 건너뛰고 빈 설정은 그대로 종료한다", async () => {
  const tools: any[] = [];
  const clients = await connectMcpServers({ register: (tool) => tools.push(tool) }, [
    { name: "invalid", transport: "http", url: "not-a-url" },
  ]);
  assert.deepEqual(clients, []);
  assert.deepEqual(tools, []);
  await closeMcpServers(clients);
  assert.deepEqual(await connectMcpServers({ register() {} }, []), []);
});
