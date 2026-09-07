import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SkillManager } from "../skill-manager.ts";
import { validateToolArguments } from "../tool-schema.ts";
import { discoverMcpTools } from "../mcp-client.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createChatCompletionsAdapter } from "../adapters/chat-completions.ts";
import * as context from "../context-manager.ts";
import { createHarnessPaths } from "../harness-paths.ts";
import { summarize } from "../llm.ts";
import { textOf } from "../llm-types.ts";
import type { LLMAdapter } from "../llm-types.ts";

// 실제 메인의 정의만 읽어 테스트한다. CLI 시작, dotenv, 사용자 스킬 로딩은 실행하지 않는다.
const source = await readFile(new URL("../my-first-harness.ts", import.meta.url), "utf8");
// 메인 소스에서 두 표시 문자열 사이의 정의를 테스트용으로 추출한다.
function section(start: string, end: string) {
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin);
  assert.ok(begin >= 0 && finish > begin);
  return source.slice(begin, finish);
}
const definitions = stripTypeScriptTypes([
  section("class ToolManager", "const toolManager"),
  "const toolManager = new ToolManager(); const skillManager = new SkillManager();",
  section("function assembleContext", "let session = createSession();"),
].join("\n"));

// 실제 메인의 클래스·함수에 테스트 의존성을 연결하고 출력과 저장 내용을 수집한다.
function harness(adapter: LLMAdapter) {
  const events: string[] = [];
  const saved: any[] = [];
  const deps = {
    SkillManager, validateToolArguments, adapter, ...context, summarize, textOf, randomUUID,
    paths: createHarnessPaths("/test", "/test-home"),
    console: { log: (text: string) => events.push(text) },
    saveSession: async (session: any) => { saved.push(structuredClone(session)); },
  };
  const build = new Function("deps", `
    const { ${Object.keys(deps).join(", ")} } = deps;
    ${definitions}
    return { toolManager, skillManager, turn, createSession, assembleContext };
  `);
  return { ...build(deps), events, saved };
}

test("실제 step/turn이 공통 형식으로 복수 툴을 실행하고 다음 API 요청에 모든 결과를 넣는다", async (t) => {
  const bodies: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ choices: [bodies.length === 1 ? {
      finish_reason: "tool_calls", message: { role: "assistant", content: "확인 중", tool_calls: [
        { type: "function", id: "a", function: { name: "increase", arguments: '{"amount":3}' } },
        { type: "function", id: "b", function: { name: "read", arguments: "{}" } },
      ] },
    } : { finish_reason: "stop", message: { role: "assistant", content: "현재 값은 3" } }] });
  });
  const runtime = harness(createChatCompletionsAdapter({
    provider: "test", model: "gpt-4o", baseURL: "https://example.invalid/v1", apiKey: "test",
  }));
  let count = 0;
  runtime.toolManager.register({ name: "increase", description: "증가", parameters: {
    type: "object", properties: { amount: { type: "number" } }, required: ["amount"],
  }, execute({ amount }: { amount: number }) {
    assert.deepEqual(runtime.events, ["확인 중", '[tool] increase {"amount":3}']);
    count += amount; return count;
  } });
  runtime.toolManager.register({ name: "read", description: "조회", parameters: {}, execute: () => count });
  runtime.skillManager.register({ name: "test-skill", description: "검증용 스킬", location: "/test/test-skill/SKILL.md" });
  const session = runtime.createSession();
  assert.equal(await runtime.turn(session, "3 올리고 알려줘"), "현재 값은 3");
  assert.equal(count, 3);
  assert.equal(bodies.length, 2);
  assert.match(bodies[0].messages[0].content, /검증용 스킬/);
  assert.match(bodies[0].messages[0].content, /현재 작업 디렉토리: \/test/);
  assert.equal(bodies[0].messages[1].content, "3 올리고 알려줘");
  assert.deepEqual(bodies[1].messages.slice(-2), [
    { role: "tool", tool_call_id: "a", content: "3" },
    { role: "tool", tool_call_id: "b", content: "3" },
  ]);
  assert.deepEqual(session.messages, session.history);
  assert.equal(session.history.length, 5);
  assert.doesNotMatch(JSON.stringify(session.history), /tool_calls|tool_call_id|choices/);
});

test("없는 툴·잘못된 JSON/인자·실행 오류를 결과로 기록하고 다음 step에서 복구할 수 있다", async () => {
  const calls = [
    { type: "tool-call" as const, id: "a", name: "missing", arguments: "{}" },
    { type: "tool-call" as const, id: "b", name: "valid", arguments: "broken" },
    { type: "tool-call" as const, id: "c", name: "valid", arguments: '{"amount":"bad"}' },
    { type: "tool-call" as const, id: "d", name: "valid", arguments: "{}" },
    { type: "tool-call" as const, id: "e", name: "broken", arguments: "{}" },
    { type: "tool-call" as const, id: "f", name: "valid", arguments: '{"amount":2}' },
  ];
  let steps = 0;
  const runtime = harness({ async generate(request) {
    if (++steps === 1) return { stopReason: "tool-calls", message: { role: "assistant", content: calls } };
    const results = request.messages.filter((m) => m.role === "tool").flatMap((m) => m.content);
    assert.deepEqual(results.map((r) => r.toolCallId), ["a", "b", "c", "d", "e", "f"]);
    assert.ok(results.slice(0, 5).every((r) => r.isError === true));
    assert.equal(results[5].isError, undefined);
    assert.equal(results[5].content, "2");
    return { stopReason: "stop", message: { role: "assistant", content: [{ type: "text", text: "복구 완료" }] } };
  } });
  let executed = 0;
  runtime.toolManager.register({ name: "valid", parameters: {
    type: "object", properties: { amount: { type: "number" } }, required: ["amount"],
  }, execute: ({ amount }: { amount: number }) => { executed++; return amount; } });
  runtime.toolManager.register({ name: "broken", parameters: {}, execute: async () => { throw new Error("실행 실패"); } });
  assert.equal(await runtime.turn(runtime.createSession(), "실행"), "복구 완료");
  assert.equal(executed, 1);
  assert.equal(steps, 2);
});

test("MCP의 2020-12 인자 검증과 원격 실행 결과가 공통 turn 기록에 연결된다", async () => {
  const remoteCalls: unknown[] = [];
  const client = {
    // 서버가 제공하는 인자 규격을 그대로 툴 등록에 사용한다.
    async listTools() {
      return { tools: [{ name: "echo", description: "입력을 돌려준다", inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object", properties: { text: { type: "string" } }, required: ["text"],
      } }] };
    },
    // 검증을 통과한 호출만 서버까지 도착하는지 수집한다.
    async callTool(request: any) {
      remoteCalls.push(request);
      if (request.arguments.text === "fail") return { isError: true, content: [{ type: "text", text: "원격 실행 실패" }] };
      return { content: [{ type: "text", text: request.arguments.text }] };
    },
  } as unknown as Client;
  let steps = 0;
  const runtime = harness({
    // 잘못된 인자·서버 오류·정상 결과를 한 번의 툴 호출 응답으로 요청한다.
    async generate(request) {
      if (++steps === 1) return { stopReason: "tool-calls", message: { role: "assistant", content:
        ['{"text":3}', '{"text":"fail"}', '{"text":"ok"}'].map((arguments_, index) => ({
          type: "tool-call" as const, id: `mcp-${index}`, name: "mcp__test__echo", arguments: arguments_,
        })),
      } };
      const results = request.messages.filter((message) => message.role === "tool").flatMap((message) => message.content);
      assert.deepEqual(results.map((result) => result.toolCallId), ["mcp-0", "mcp-1", "mcp-2"]);
      assert.deepEqual(results.map((result) => !!result.isError), [true, true, false]);
      assert.match(results[1].content, /원격 실행 실패/);
      assert.equal(results[2].content, "ok");
      return { stopReason: "stop", message: { role: "assistant", content: [{ type: "text", text: "완료" }] } };
    },
  });
  for (const tool of await discoverMcpTools(client, "test")) runtime.toolManager.register(tool);
  assert.equal(await runtime.turn(runtime.createSession(), "MCP 테스트"), "완료");
  assert.deepEqual(remoteCalls, [
    { name: "echo", arguments: { text: "fail" } },
    { name: "echo", arguments: { text: "ok" } },
  ]);
  assert.equal(runtime.events.filter((event: string) => event.startsWith("[tool] mcp__test__echo")).length, 3);
});

test("정상 종료가 아닌 응답에 있는 툴 호출은 실행하지 않는다", async () => {
  for (const stopReason of ["max-tokens", "other"] as const) {
    const runtime = harness({ async generate() {
      return { stopReason, message: { role: "assistant", content: [
        { type: "tool-call", id: "a", name: "danger", arguments: "{}" },
      ] } };
    } });
    let executed = false;
    runtime.toolManager.register({ name: "danger", parameters: {}, execute: () => { executed = true; } });
    await assert.rejects(runtime.turn(runtime.createSession(), "실행"), /정상 완료되지 않았습니다/);
    assert.equal(executed, false);
    assert.equal(runtime.saved.length, 1);
  }
});

test("자동 압축 후 step은 요약된 messages만 보내고 history는 유지한다", async () => {
  let requests = 0;
  const runtime = harness({ async generate(request) {
    requests++;
    if (requests === 1) {
      assert.equal(request.maxOutputTokens, 2048);
      assert.deepEqual(request.tools, []);
      return { stopReason: "stop", message: { role: "assistant", content: [{ type: "text", text: "이전 긴 작업의 요약" }] } };
    }
    assert.equal(request.messages.length, 1);
    assert.match(textOf(request.messages[0]), /이전 긴 작업의 요약/);
    return { stopReason: "stop", message: { role: "assistant", content: [{ type: "text", text: "작업 완료" }] } };
  } });
  const session = runtime.createSession();
  assert.equal(await runtime.turn(session, "긴 작업 ".repeat(20_000)), "작업 완료");
  assert.equal(requests, 2);
  assert.match(textOf(session.history[0]), /긴 작업/);
  assert.equal(session.messages.length, 2);
  assert.equal(runtime.saved.length, 2);
});
