import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarnessPaths } from "../harness-paths.ts";
import { createMcpServerConfigs } from "../mcp-servers.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { discoverMcpTools, mcpResultContent, mcpToolName, connectMcpServers, closeMcpServers } from "../mcp-client.ts";
import { solidPng } from "./image-fixture.ts";
import { MAX_IMAGE_BYTES, withImagePaths, summaryContent } from "../image-content.ts";
import { ToolManager } from "../tool-manager.ts";
import { validateToolArguments } from "../tool-schema.ts";

test("Playwright는 설치된 CLI와 프로젝트 cwd·별도 프로필로 등록하고 이미지도 허용한다", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-mcp-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = createHarnessPaths(directory, join(directory, "home"));
  const configs = await createMcpServerConfigs(paths);
  assert.deepEqual(configs.map((config) => config.name), ["filesystem", "memory", "playwright", "microsoft", "cloudflare"]);
  for (const config of configs) {
    if (config.transport === "stdio") {
      await access(config.args[0]);
      assert.equal(config.cwd, paths.workspaceDirectory);
    }
  }
  const playwright = configs.find((config) => config.name === "playwright")!;
  assert.ok(playwright.transport === "stdio");
  assert.equal(playwright.command, "node");
  assert.match(playwright.args[0], /[/\\]cli\.js$/);
  assert.deepEqual(playwright.args.slice(1), ["--isolated",
    "--output-dir", join(paths.projectHarnessDirectory, "mcp-playwright")]);
});

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

test("MCP 호출 옵션에 턴 취소 신호를 넘겨 SDK가 취소를 전달할 수 있게 한다", async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const client = {
    // 도구 목록만 제공하고 네트워크 연결은 만들지 않는다.
    listTools: async () => ({ tools: [{ name: "wait", inputSchema: { type: "object" } }] }),
    // 실제 SDK가 받는 옵션의 신호와 취소 전달을 검사한다.
    callTool: async (_params: unknown, _schema: unknown, options: { signal: AbortSignal }) => {
      assert.equal(options.signal, controller.signal);
      entered.resolve();
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
    },
  } as unknown as Client;
  const [tool] = await discoverMcpTools(client, "test");
  const rejected = assert.rejects(tool.execute({}, { signal: controller.signal }), /MCP 취소/);
  await entered.promise;
  controller.abort(new Error("MCP 취소"));
  await rejected;
});

test("텍스트·리소스·이미지·구조화 결과의 순서를 보존하고 base64를 텍스트로 보내지 않는다", async () => {
  const data = solidPng().toString("base64");
  const content = await mcpResultContent({
    content: [
      { type: "text", text: "결과" },
      { type: "resource", resource: { uri: "file:///example", text: "원문" } },
      { type: "image", data, mimeType: "image/png" },
      { type: "text", text: "이미지 다음 설명" },
    ],
    structuredContent: { value: 5 },
  });
  assert.ok(Array.isArray(content));
  assert.deepEqual(content.map((block) => block.type), ["text", "text", "image", "text", "text"]);
  assert.deepEqual(content[2], { type: "image", mediaType: "image/png", data, width: 128, height: 128 });
  assert.deepEqual(withImagePaths(content), content, "없는 원본 파일 경로를 만들어내지 않는다.");
  const texts = content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  assert.match(texts, /결과\n원문/);
  assert.match(texts, /"value":5/);
  assert.ok(!texts.includes(data));
  const summary = summaryContent([{ role: "tool", content: [{ type: "tool-result", toolCallId: "image", content }] }]);
  assert.ok(summary.some((block) => block.type === "image"));
  assert.doesNotMatch(summary.filter((block) => block.type === "text").map((block) => block.text).join("\n"), /undefined/);
  assert.equal(await mcpResultContent({ content: [] }), "(빈 MCP 결과)");
});

test("MCP 이미지의 형식·base64·크기·치수 오류는 기존 ToolManager 오류 결과로 반환한다", async () => {
  const tooWide = await sharp({ create: { width: 8193, height: 1, channels: 3, background: "red" } }).png().toBuffer();
  for (const [data, mimeType, error] of [
    [solidPng().toString("base64"), "image/jpeg", /MIME/],
    ["invalid!", "image/png", /base64/],
    [Buffer.from("not png").toString("base64"), "image/png", /PNG/],
    ["A".repeat(4 * Math.ceil(MAX_IMAGE_BYTES / 3) + 4), "image/png", /20 MiB/],
    [tooWide.toString("base64"), "image/png", /8192/],
  ] as const) {
    const client = {
      listTools: async () => ({ tools: [{ name: "screen", inputSchema: { type: "object" } }] }),
      callTool: async () => ({ content: [{ type: "image", data, mimeType }] }),
    } as unknown as Client;
    const manager = new ToolManager();
    manager.register((await discoverMcpTools(client, "test"))[0]);
    const result = await manager.execute("mcp__test__screen", "{}");
    assert.equal(result.isError, true);
    assert.match(String(result.content), error);
  }
});

test("MCP의 JPEG·WebP도 원본 MIME·바이트와 결과 순서를 유지한다", async () => {
  for (const format of ["jpeg", "webp"] as const) {
    const bytes = await sharp(solidPng()).toFormat(format).toBuffer();
    const data = bytes.toString("base64");
    const content = await mcpResultContent({ content: [
      { type: "text", text: "앞" }, { type: "image", mimeType: `image/${format}`, data },
      { type: "text", text: "뒤" },
    ] });
    assert.deepEqual(content, [{ type: "text", text: "앞" },
      { type: "image", mediaType: `image/${format}`, data, width: 128, height: 128 },
      { type: "text", text: "뒤" }]);
  }
});

test("MCP 이미지도 ToolManager를 통과하고 오류 응답의 base64는 오류 텍스트에 넣지 않는다", async () => {
  let isError = false;
  const data = solidPng().toString("base64");
  const client = {
    listTools: async () => ({ tools: [{ name: "screen", inputSchema: { type: "object" } }] }),
    callTool: async () => ({ isError, content: [{ type: "text", text: "화면 결과" }, { type: "image", data, mimeType: "image/png" }] }),
  } as unknown as Client;
  const manager = new ToolManager();
  manager.register((await discoverMcpTools(client, "test"))[0]);
  assert.ok(Array.isArray((await manager.execute("mcp__test__screen", "{}")).content));
  isError = true;
  assert.deepEqual(await manager.execute("mcp__test__screen", "{}"), { content: "툴 실행 오류: 화면 결과", isError: true });
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
