import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SkillManager } from "../skill-manager.ts";
import { discoverMcpTools } from "../mcp-client.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createChatCompletionsAdapter } from "../adapters/chat-completions.ts";
import { createResponsesAdapter } from "../adapters/responses.ts";
import { createAnthropicMessagesAdapter } from "../adapters/anthropic-messages.ts";
import { createHarnessPaths } from "../harness-paths.ts";
import { registerShellTools } from "../tools/shell.ts";
import { registerFilesystemTools } from "../tools/filesystem.ts";
import { registerOtherLLMTools } from "../tools/other-llm.ts";
import type { HistoryEvent, HistoryScope } from "../execution-history.ts";
import { textOf } from "../llm-types.ts";
import { solidPng } from "./image-fixture.ts";
import type { ImageBlock, LLMAdapter, ToolContent } from "../llm-types.ts";
import { createSession } from "../session.ts";
import type { Session } from "../session.ts";
import { createAgent } from "../agent.ts";
import type { AgentEvent } from "../agent.ts";
import { ToolManager } from "../tool-manager.ts";

// 실제 코어를 import하고 모델·저장·화면 출력만 테스트용으로 연결한다.
function harness(adapter: LLMAdapter, paths = createHarnessPaths("/test", "/test-home")) {
  const events: AgentEvent[] = [];
  const saved: Session[] = [];
  const records: (HistoryEvent & HistoryScope)[] = [];
  const history = {
    // 기록 시점의 값을 복사해 이후 messages 변경과 구분한다.
    async append(scope: HistoryScope, event: HistoryEvent) { records.push(structuredClone({ ...scope, ...event })); },
    // 테스트 기록은 즉시 저장되므로 대기할 쓰기가 없다.
    async flush() {},
  };
  const toolManager = new ToolManager();
  const skillManager = new SkillManager();
  const agent = createAgent({
    adapter: { contextBudget: { contextWindow: 20_000, reservedOutputTokens: 1000, safetyMarginTokens: 4000, retainRatio: 0 }, ...adapter },
    toolManager, skillManager, history, paths,
    // 화면 이벤트를 구조 그대로 수집해 CLI 문구와 독립적으로 검증한다.
    onEvent: (event) => { events.push(event); },
    // 실제 사용자 폴더 대신 저장 요청 시점의 스냅샷을 보관한다.
    saveSession: async (session) => { saved.push(structuredClone(session)); },
  });
  return {
    ...agent, toolManager, skillManager, events, saved, records,
    // 테스트 작업 폴더에 속하는 독립 세션을 만든다.
    createSession: () => createSession(paths.workspaceDirectory),
  };
}

// 실행 기록에서 대화 원문 이벤트만 골라 기존 메시지 검증에 사용한다.
function recordedMessages(runtime: ReturnType<typeof harness>) {
  return runtime.records.filter((event) => event.type === "message").map((event) => event.message);
}

// 문자열을 반환하는 툴의 결과를 좁혀 이미지 배열과 혼동하지 않는다.
function toolText(content: ToolContent): string {
  if (typeof content !== "string") throw new Error("expected text tool result");
  return content;
}

test("실제 turn은 첨부와 readImage 결과를 같은 루프에서 보내고 툴 이미지 오류는 결과로 돌려준다", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-image-turn-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "screen.png");
  await writeFile(path, solidPng());
  const image: ImageBlock = { type: "image", data: solidPng().toString("base64"), mediaType: "image/png", path, width: 128, height: 128 };
  let steps = 0;
  const runtime = harness({ supportsImages: true,
    // 실제 툴과 기록 루프를 실행하고 모델의 요청·응답만 대체한다.
    async generate(request) {
      const attached = request.messages[0].content[1] as ImageBlock;
      assert.equal(attached.data, image.data);
      assert.ok(attached.storedPath?.startsWith(directory));
      assert.deepEqual(await readFile(attached.storedPath!), solidPng());
      if (++steps === 1) return { stopReason: "tool-calls", message: { role: "assistant", content: [
        { type: "tool-call", id: "good", name: "readImage", arguments: JSON.stringify({ path }) },
        { type: "tool-call", id: "bad", name: "readImage", arguments: JSON.stringify({ path: join(directory, "missing.png") }) },
      ] } };
      const results = request.messages.filter((item) => item.role === "tool").flatMap((item) => item.content);
      assert.deepEqual(results[0], { type: "tool-result", toolCallId: "good", content: [attached] });
      assert.equal(results[1].isError, true);
      assert.match(toolText(results[1].content), /ENOENT/);
      return { stopReason: "stop", message: { role: "assistant", content: [{ type: "text", text: "확인 완료" }] } };
    },
  }, createHarnessPaths(directory, directory));
  registerFilesystemTools(runtime.toolManager, true);
  const session = runtime.createSession();
  assert.equal(await runtime.turn(session, "화면 확인", [image]), "확인 완료");
  assert.equal(steps, 2);
  assert.deepEqual(session.messages, recordedMessages(runtime));
});

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
        const result = JSON.parse(toolText(results[0].content));
        assert.equal(result.status, "running");
        jobId = result.jobId;
        return { stopReason: "tool-calls", message: { role: "assistant", content: [
          { type: "tool-call", id: "read", name: "readJob", arguments: JSON.stringify({ jobId, waitMs: 3000 }) },
        ] } };
      }
      assert.equal(steps, 3);
      assert.equal(results[1].toolCallId, "read");
      const result = JSON.parse(toolText(results[1].content));
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
  assert.equal(JSON.parse(toolText(ends[0].result.content)).jobId, jobId!);
  assert.equal(JSON.parse(toolText(ends[1].result.content)).status, "completed");
});

test("부분 수정의 중복 오류를 모델에 돌려주고 구체화한 다음 호출로 복구한다", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-edit-turn-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "game.ts");
  const original = "user: hello\nadmin: hello\n";
  await writeFile(path, original, "utf8");
  let steps = 0;
  const runtime = harness({
    // 모델 출력만 고정하고 실제 파일 수정·오류 전달·후속 호출을 검증한다.
    async generate(request) {
      steps++;
      const results = request.messages.filter((message) => message.role === "tool").flatMap((message) => message.content);
      if (steps === 2) {
        assert.equal(results[0].isError, true);
        assert.match(toolText(results[0].content), /여러 곳에 일치/);
        assert.equal(await readFile(path, "utf8"), original);
      }
      if (steps <= 2) return { stopReason: "tool-calls", message: { role: "assistant", content: [{
        type: "tool-call", id: `edit-${steps}`, name: "editTextFile",
        arguments: JSON.stringify({ path, oldText: steps === 1 ? "hello" : "admin: hello", newText: "admin: 안녕" }),
      }] } };
      assert.equal(steps, 3);
      assert.equal(results[1].toolCallId, "edit-2");
      assert.equal(results[1].isError, undefined);
      assert.equal(await readFile(path, "utf8"), "user: hello\nadmin: 안녕\n");
      return { stopReason: "stop", message: { role: "assistant", content: [{ type: "text", text: "수정 완료" }] } };
    },
  });
  registerFilesystemTools(runtime.toolManager);
  assert.equal(await runtime.turn(runtime.createSession(), "admin 인사만 바꿔줘"), "수정 완료");
  const ends = runtime.records.filter((event) => event.type === "tool-end");
  assert.deepEqual(ends.map((event) => !!event.result.isError), [true, false]);
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
    assert.deepEqual(runtime.events, [
      { type: "assistant-text", text: "확인 중" },
      { type: "tool-start", name: "increase", arguments: '{"amount":3}' },
    ]);
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
  runtime.toolManager.register({ name: "valid", description: "검증 테스트", parameters: {
    type: "object", properties: { amount: { type: "number" } }, required: ["amount"],
  }, execute: ({ amount }: { amount: number }) => { executed++; return amount; } });
  runtime.toolManager.register({ name: "broken", description: "실패 테스트", parameters: {}, execute: async () => { throw new Error("실행 실패"); } });
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
      assert.match(toolText(results[1].content), /원격 실행 실패/);
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
  assert.equal(runtime.events.filter((event) => event.type === "tool-start" && event.name === "mcp__test__echo").length, 3);
});

test("정상 종료가 아닌 응답에 있는 툴 호출은 실행하지 않는다", async () => {
  for (const stopReason of ["max-tokens", "other"] as const) {
    const runtime = harness({ async generate() {
      return { stopReason, message: { role: "assistant", content: [
        { type: "tool-call", id: "a", name: "danger", arguments: "{}" },
      ] } };
    } });
    let executed = false;
    runtime.toolManager.register({ name: "danger", description: "실행 차단 테스트", parameters: {}, execute: () => { executed = true; } });
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
    assert.deepEqual(runtime.events, [
      { type: "assistant-text", text: "확인 중" },
      { type: "tool-start", name: "increase", arguments: '{"amount":3}' },
    ]);
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
  runtime.toolManager.register({ name: "danger", description: "실행 차단 테스트", parameters: {}, execute: () => { executed = true; } });
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
    assert.deepEqual(runtime.events, [
      { type: "assistant-text", text: "확인 중" },
      { type: "tool-start", name: "increase", arguments: '{"amount":3}' },
    ]);
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
  runtime.toolManager.register({ name: "danger", description: "실행 차단 테스트", parameters: {}, execute: () => { executed = true; } });
  await assert.rejects(runtime.turn(runtime.createSession(), "실행"), /max-tokens/);
  assert.equal(executed, false);
  assert.equal(runtime.saved.length, 1);
});

test("출력 한도 피드백으로 작은 작업을 재요청하고 잘린 인자·replay 없이 성공한 결과만 이어간다", async (t) => {
  const bodies: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    const step = bodies.length;
    return Response.json({ type: "message", role: "assistant",
      stop_reason: step === 2 ? "max_tokens" : step === 4 ? "end_turn" : "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: step === 2 ? [
        { type: "text", text: "미완성 답변" },
        { type: "tool_use", id: "broken", name: "increase", input: "{잘린 인자" },
      ] : step === 4 ? [{ type: "text", text: "완료" }]
        : [{ type: "tool_use", id: `ok-${step}`, name: "increase", input: {} }],
    });
  });
  const runtime = harness(createAnthropicMessagesAdapter({
    provider: "test", model: "claude-haiku-4-5-20251001", baseURL: "https://example.invalid/v1", apiKey: "test", maxOutputTokens: 32_000,
  }));
  let count = 0;
  runtime.toolManager.register({ name: "increase", description: "카운터 증가", parameters: {}, execute: () => ++count });
  const session = runtime.createSession();
  assert.equal(await runtime.turn(session, "두 번 증가"), "완료");
  assert.equal(count, 2);
  assert.equal(bodies.length, 4);
  assert.ok(bodies.every((body) => body.max_tokens === 32_000));
  assert.match(JSON.stringify(bodies[2].messages), /하네스 실행 피드백/);
  assert.match(JSON.stringify(bodies[2].messages), /이미 성공한 작업을 반복하지/);
  assert.match(JSON.stringify(bodies[2].messages), /ok-1/);
  assert.doesNotMatch(JSON.stringify(bodies[2].messages), /broken|미완성 답변|잘린 인자/);
  assert.doesNotMatch(JSON.stringify(session.messages), /broken|미완성 답변/);
  const raw = runtime.records.filter((event) => event.type === "model-response");
  assert.equal(raw.length, 4);
  assert.match(JSON.stringify(raw[1].response.body), /broken|잘린 인자/);
  assert.equal(raw.reduce((sum, event) => sum + (event.response.usage?.outputTokens ?? 0), 0), 20);
  assert.equal(runtime.records.filter((event) => event.type === "message" && event.source === "harness").length, 1);
  assert.equal(runtime.events.filter((event) => event.type === "output-limit-recovery").length, 1);
  assert.deepEqual(session.messages, recordedMessages(runtime));
  assert.equal(runtime.records.at(-1)?.type, "turn-end");
});

test("텍스트만 잘려도 복구는 턴당 2회이며 실패 응답 없이 저장하고 다음 턴은 새 한도를 갖는다", async () => {
  let calls = 0;
  const runtime = harness({ async generate() {
    calls++;
    return { stopReason: "max-tokens", message: { role: "assistant", content: [{ type: "text", text: "잘린 원문" }] } };
  } });
  const session = runtime.createSession();
  await assert.rejects(runtime.turn(session, "시작"), /복구 2회 소진/);
  assert.equal(calls, 3);
  assert.equal(runtime.events.filter((event) => event.type === "output-limit-recovery").length, 2);
  assert.equal(session.messages.filter((message) => message.role === "assistant").length, 0);
  assert.deepEqual(runtime.saved[0].messages, session.messages);
  assert.equal(runtime.records.filter((event) => event.type === "turn-end" && event.outcome === "error").length, 1);
  await assert.rejects(runtime.turn(session, "다시"), /복구 2회 소진/);
  assert.equal(calls, 6);
});

test("성공한 툴 스텝이 사이에 있어도 한 턴의 출력 한도 복구 횟수는 초기화하지 않는다", async () => {
  let calls = 0;
  let executed = 0;
  const runtime = harness({ async generate() {
    calls++;
    return { stopReason: calls % 2 ? "max-tokens" : "tool-calls", message: { role: "assistant", content: [
      { type: "tool-call", id: `call-${calls}`, name: "probe", arguments: "{}" },
    ] } };
  } });
  runtime.toolManager.register({ name: "probe", description: "실행 횟수 확인", parameters: {}, execute: () => ++executed });
  const session = runtime.createSession();
  await assert.rejects(runtime.turn(session, "작업"), /복구 2회 소진/);
  assert.equal(calls, 5);
  assert.equal(executed, 2);
  assert.doesNotMatch(JSON.stringify(session.messages), /call-1|call-3|call-5/);
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
