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
import { createResponsesAdapter } from "../adapters/responses.ts";
import { createAnthropicMessagesAdapter } from "../adapters/anthropic-messages.ts";
import * as context from "../context-manager.ts";
import { createHarnessPaths } from "../harness-paths.ts";
import { summarize } from "../llm.ts";
import { registerShellTools } from "../tools/shell.ts";
import { recordLLM } from "../recorded-llm.ts";
import { registerOtherLLMTools } from "../tools/other-llm.ts";
import type { HistoryEvent, HistoryScope } from "../execution-history.ts";
import { textOf } from "../llm-types.ts";
import type { LLMAdapter, LLMRequest } from "../llm-types.ts";
import type { Session } from "../session-store.ts";

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
  const records: (HistoryEvent & HistoryScope)[] = [];
  const history = {
    // 실제 실행 경로의 기록을 파일 대신 복사해 검사한다.
    async append(scope: HistoryScope, event: HistoryEvent) { records.push(structuredClone({ ...scope, ...event })); },
    async flush() {},
  };
  const deps = {
    SkillManager, validateToolArguments, adapter, ...context, summarize, textOf, randomUUID, history, recordLLM,
    paths: createHarnessPaths("/test", "/test-home"),
    console: { log: (text: string) => events.push(text) },
    saveSession: async (session: any) => { saved.push(structuredClone(session)); },
  };
  const build = new Function("deps", `
    const { ${Object.keys(deps).join(", ")} } = deps;
    ${definitions}
    return { toolManager, skillManager, turn, createSession, assembleContext };
  `);
  const runtime = build(deps) as {
    toolManager: any;
    skillManager: SkillManager;
    turn(session: Session, input: string): Promise<string>;
    createSession(): Session;
    assembleContext(session: Session): LLMRequest;
  };
  return { ...runtime, events, saved, records };
}

// 실행 기록에서 대화 원문 이벤트만 골라 기존 메시지 검증에 사용한다.
function recordedMessages(runtime: ReturnType<typeof harness>) {
  return runtime.records.filter((event) => event.type === "message").map((event) => event.message);
}

test("실제 turn이 background 작업 ID를 기록하고 다음 step의 조회 결과로 완료한다", async (t) => {
  let steps = 0;
  let jobId: string;
  const command = `"${process.execPath}" -e "setTimeout(()=>console.log('job-result'),100)"`;
  const runtime = harness({
    // 모델 판단만 고정하고 ToolManager와 셸 프로세스·조회·메시지 기록은 실제로 실행한다.
    async generate(request) {
      const results = request.messages.filter((m) => m.role === "tool").flatMap((m) => m.content);
      if (++steps === 1) return { stopReason: "tool-calls", message: { role: "assistant", content: [
        { type: "tool-call", id: "start", name: "runCommand", arguments: JSON.stringify({ command, background: true }) },
      ] } };
      if (steps === 2) {
        assert.equal(results[0].toolCallId, "start");
        const result = JSON.parse(results[0].content);
        assert.equal(result.status, "running");
        jobId = result.jobId;
        return { stopReason: "tool-calls", message: { role: "assistant", content: [
          { type: "tool-call", id: "read", name: "readJob", arguments: JSON.stringify({ jobId, waitMs: 3000 }) },
        ] } };
      }
      assert.equal(steps, 3);
      assert.equal(results[1].toolCallId, "read");
      const result = JSON.parse(results[1].content);
      assert.equal(result.jobId, jobId);
      assert.equal(result.status, "completed");
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, "job-result\n");
      return { stopReason: "stop", message: { role: "assistant", content: [{ type: "text", text: "검증 완료" }] } };
    },
  });
  const jobs = registerShellTools(runtime.toolManager);
  t.after(() => jobs.dispose());
  const session = runtime.createSession();
  assert.equal(await runtime.turn(session, "백그라운드 실행 후 결과 확인"), "검증 완료");
  assert.equal(steps, 3);
  assert.deepEqual(recordedMessages(runtime), session.messages);
  const starts = runtime.records.filter((event) => event.type === "tool-start");
  const ends = runtime.records.filter((event) => event.type === "tool-end");
  assert.deepEqual(starts.map((event) => [event.name, event.step]), [["runCommand", 1], ["readJob", 2]]);
  assert.deepEqual(ends.map((event) => event.toolCallId), ["start", "read"]);
  assert.equal(JSON.parse(ends[0].result.content).jobId, jobId!);
  assert.equal(JSON.parse(ends[1].result.content).status, "completed");
});

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
  assert.deepEqual(session.messages, recordedMessages(runtime));
  assert.equal(recordedMessages(runtime).length, 5);
  assert.doesNotMatch(JSON.stringify(recordedMessages(runtime)), /tool_calls|tool_call_id|choices/);
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
  assert.match(textOf(recordedMessages(runtime)[0]), /긴 작업/);
  assert.deepEqual(runtime.records.filter((event) => event.type === "model-start").map((event) => event.purpose), ["compaction", "step"]);
  assert.equal(runtime.records.filter((event) => event.type === "context-update").length, 1);
  assert.equal(session.messages.length, 2);
  assert.equal(runtime.saved.length, 2);
});

test("실제 turn에 Responses를 연결해 중간 출력·인자 검증·복수 툴 결과·reasoning 재전송을 확인한다", async (t) => {
  const bodies: any[] = [];
  const native = [
    { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "test-ciphertext" },
    { type: "message", id: "msg_1", role: "assistant", status: "completed", phase: "commentary",
      content: [{ type: "output_text", text: "확인 중", annotations: [] }] },
    { type: "function_call", id: "fc_a", call_id: "a", name: "increase", arguments: '{"amount":3}', status: "completed" },
    { type: "function_call", id: "fc_b", call_id: "b", name: "read", arguments: "{}", status: "completed" },
    { type: "function_call", id: "fc_c", call_id: "c", name: "missing", arguments: "{}", status: "completed" },
  ];
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ status: "completed", output: bodies.length === 1 ? native : [
      { type: "message", id: "msg_2", role: "assistant", status: "completed", phase: "final_answer",
        content: [{ type: "output_text", text: "현재 값은 3", annotations: [] }] },
    ] });
  });
  const runtime = harness(createResponsesAdapter({
    provider: "test", model: "gpt-5.6-luna", baseURL: "https://example.invalid/v1", apiKey: "test",
  }));
  let count = 0;
  runtime.toolManager.register({ name: "increase", description: "증가", parameters: {
    type: "object", properties: { amount: { type: "number" } }, required: ["amount"],
  },
  // 실제 툴 실행 전에 중간 텍스트가 출력됐는지 확인한다.
  execute({ amount }: { amount: number }) {
    assert.deepEqual(runtime.events, ["확인 중", '[tool] increase {"amount":3}']);
    count += amount; return count;
  } });
  runtime.toolManager.register({ name: "read", description: "조회", parameters: {}, execute: () => count });
  const session = runtime.createSession();
  assert.equal(await runtime.turn(session, "3 올리고 알려줘"), "현재 값은 3");
  assert.equal(count, 3);
  assert.equal(bodies.length, 2);
  assert.match(bodies[0].instructions, /현재 작업 디렉토리: \/test/);
  assert.deepEqual(bodies[1].input.slice(1, 1 + native.length), native);
  assert.deepEqual(bodies[1].input.slice(-3), [
    { type: "function_call_output", call_id: "a", output: "3" },
    { type: "function_call_output", call_id: "b", output: "3" },
    { type: "function_call_output", call_id: "c", output: "툴 오류: 툴 요청 오류: 등록되지 않은 툴입니다: missing" },
  ]);
  assert.deepEqual(session.messages, recordedMessages(runtime));
  assert.equal(recordedMessages(runtime).length, 6);
});

test("Responses의 잘린 함수 호출은 실제 turn에서도 실행하지 않는다", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({
    status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "function_call", call_id: "a", name: "danger", arguments: "{", status: "incomplete" }],
  }));
  const runtime = harness(createResponsesAdapter({
    provider: "test", model: "gpt-5.6-luna", baseURL: "https://example.invalid/v1", apiKey: "test",
  }));
  let executed = false;
  runtime.toolManager.register({ name: "danger", parameters: {}, execute: () => { executed = true; } });
  await assert.rejects(runtime.turn(runtime.createSession(), "실행"), /max-tokens/);
  assert.equal(executed, false);
  assert.equal(runtime.saved.length, 1);
});

test("실제 turn에서 Anthropic 중간 출력·검증 오류·복수 결과를 같은 user 메시지로 보낸다", async (t) => {
  const bodies: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ type: "message", role: "assistant", stop_reason: bodies.length === 1 ? "tool_use" : "end_turn",
      content: bodies.length === 1 ? [
        { type: "text", text: "확인 중" },
        { type: "tool_use", id: "a", name: "increase", input: { amount: 3 } },
        { type: "tool_use", id: "b", name: "increase", input: { amount: "bad" } },
        { type: "tool_use", id: "c", name: "missing", input: {} },
      ] : [{ type: "text", text: "현재 값은 3" }],
    });
  });
  const runtime = harness(createAnthropicMessagesAdapter({
    provider: "test", model: "claude-haiku-4-5-20251001", baseURL: "https://example.invalid/v1", apiKey: "test",
  }));
  let count = 0;
  runtime.toolManager.register({ name: "increase", description: "증가", parameters: {
    type: "object", properties: { amount: { type: "number" } }, required: ["amount"],
  },
  // 검증된 호출 한 번만 실행하고 중간 텍스트 출력 시점도 확인한다.
  execute({ amount }: { amount: number }) {
    assert.deepEqual(runtime.events, ["확인 중", '[tool] increase {"amount":3}']);
    count += amount; return count;
  } });
  const session = runtime.createSession();
  assert.equal(await runtime.turn(session, "3 올려줘"), "현재 값은 3");
  assert.equal(count, 3);
  assert.equal(bodies.length, 2);
  assert.match(bodies[0].system, /현재 작업 디렉토리: \/test/);
  assert.equal(bodies[1].messages.length, 3);
  const results = bodies[1].messages[2];
  assert.equal(results.role, "user");
  assert.deepEqual(results.content.map((block: any) => block.tool_use_id), ["a", "b", "c"]);
  assert.equal(results.content[0].content, "3");
  assert.equal(results.content[0].is_error, undefined);
  assert.equal(results.content[1].is_error, true);
  assert.match(results.content[1].content, /number/);
  assert.equal(results.content[2].is_error, true);
  assert.match(results.content[2].content, /등록되지 않은 툴/);
  assert.deepEqual(session.messages, recordedMessages(runtime));
  assert.equal(recordedMessages(runtime).length, 6);
});

test("Anthropic max_tokens 응답에 있는 툴도 실행하지 않고 세션을 보존한다", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({
    type: "message", role: "assistant", stop_reason: "max_tokens",
    content: [{ type: "tool_use", id: "a", name: "danger", input: {} }],
  }));
  const runtime = harness(createAnthropicMessagesAdapter({
    provider: "test", model: "claude-haiku-4-5-20251001", baseURL: "https://example.invalid/v1", apiKey: "test",
  }));
  let executed = false;
  runtime.toolManager.register({ name: "danger", parameters: {}, execute: () => { executed = true; } });
  await assert.rejects(runtime.turn(runtime.createSession(), "실행"), /max-tokens/);
  assert.equal(executed, false);
  assert.equal(runtime.saved.length, 1);
});

test("다른 LLM 툴의 내부 호출도 현재 세션·툴 ID에 귀속되고 요청용 messages에 로그가 섞이지 않는다", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    const phase = calls++ % 3;
    if (phase === 0) return Response.json({ status: "completed", output: [
      { type: "function_call", call_id: "ask-tool", name: "getOtherLLMsOpinion", arguments: '{"ask":"의견?"}', status: "completed" },
    ], usage: { input_tokens: 10, output_tokens: 5 } });
    if (phase === 1) {
      assert.equal(body.tools, undefined);
      assert.deepEqual(body.input, [{ role: "user", content: "의견?" }]);
    } else {
      assert.equal(body.input.at(-1).type, "function_call_output");
      assert.equal(body.input.at(-1).output, "독립 의견");
    }
    return Response.json({ status: "completed", output: [{ type: "message", role: "assistant",
      content: [{ type: "output_text", text: phase === 1 ? "독립 의견" : "최종 답변" }],
    }], usage: { input_tokens: 10, output_tokens: 5 } });
  });
  const adapter = createResponsesAdapter({ provider: "test", model: "test", baseURL: "https://example.invalid/v1", apiKey: "test" });
  const runtime = harness(adapter);
  registerOtherLLMTools(runtime.toolManager, adapter);
  for (let i = 0; i < 2; i++) {
    const session = runtime.createSession();
    assert.equal(await runtime.turn(session, "다른 LLM에게 물어봐"), "최종 답변");
    const records = runtime.records.filter((event) => event.sessionId === session.id);
    const starts = records.filter((event) => event.type === "model-start");
    assert.deepEqual(starts.map((event) => event.purpose), ["step", "other-llm", "step"]);
    assert.equal(starts[1].parentToolCallId, "ask-tool");
    assert.equal(new Set(starts.map((event) => event.turnId)).size, 1);
    const responses = records.filter((event) => event.type === "model-response");
    assert.equal(responses.reduce((sum, event) => sum + event.response.usage!.inputTokens!, 0), 30);
    assert.equal(records.filter((event) => event.type === "tool-start").length, 1);
    assert.equal(records.filter((event) => event.type === "tool-end").length, 1);
    assert.equal(session.messages.length, 4);
    assert.doesNotMatch(JSON.stringify(session.messages), /model-start|model-response|inputTokens|purpose/);
  }
});
