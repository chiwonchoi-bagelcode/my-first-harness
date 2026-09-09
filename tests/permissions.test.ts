import assert from "node:assert/strict";
import test from "node:test";
import { ALLOW_ALL, INTERACTIVE_PERMISSIONS, checkPermission } from "../permissions.ts";
import type { PermissionPolicy, PermissionRequest } from "../permissions.ts";
import { ToolManager } from "../tool-manager.ts";
import { createAgent } from "../agent.ts";
import { createSession } from "../session.ts";
import { createHarnessPaths } from "../harness-paths.ts";
import { SkillManager } from "../skill-manager.ts";
import type { LLMAdapter } from "../llm-types.ts";

// 네트워크 없이 툴을 테스트하기 위한 모의 모델이다.
const llm: LLMAdapter = { async generate() { return { stopReason: "stop", message: { role: "assistant", content: [] } }; } };

test("앱 정책은 셸·MCP에 승인 요청하고 내장 편집·조회·검색은 허용한다", () => {
  for (const toolName of ["writeTextFile", "readTextFile", "ToolSearch", "readJob", "counterUP"]) {
    assert.equal(checkPermission(INTERACTIVE_PERMISSIONS, { toolName, args: {} }), "allow");
  }
  assert.equal(checkPermission(INTERACTIVE_PERMISSIONS, { toolName: "runCommand", args: { background: true } }), "ask");
  assert.equal(checkPermission(INTERACTIVE_PERMISSIONS, { toolName: "read", owner: "mcp:later-added", args: {} }), "ask");
  assert.equal(checkPermission(INTERACTIVE_PERMISSIONS, { toolName: "mcp_fake", owner: "plugins:local", args: {} }), "allow");
});

test("시작 후 등록한 MCP도 실제 소유권으로 판단하여 승인 전에는 실행하지 않는다", async () => {
  const { tools, executions } = fixture("mcp:new-server");
  const result = await tools.execute("writeTextFile", '{"path":"a.txt"}', { llm,
    discoveredTools: ["writeTextFile"], permissions: INTERACTIVE_PERMISSIONS });
  assert.equal(result.isError, true);
  assert.equal(executions.length, 0);
  await tools.execute("writeTextFile", '{"path":"a.txt"}', { llm, discoveredTools: ["writeTextFile"],
    permissions: INTERACTIVE_PERMISSIONS, async requestApproval(request) {
      assert.equal(request.owner, "mcp:new-server");
      return true;
    } });
  assert.equal(executions.length, 1);
});

// 실제 부작용 없이 실행 횟수와 전달된 인자를 수집한다.
function fixture(owner?: string) {
  const tools = new ToolManager();
  const executions: unknown[] = [];
  const unregister = tools.register({ name: "writeTextFile", description: "write", parameters: {
    type: "object", properties: { path: { type: "string" } }, required: ["path"],
  }, execute(args) { executions.push(args); return "written"; } }, { owner });
  return { tools, executions, unregister };
}

test("명시적 deny > ask > allow이며 인자 조건과 기본 정책을 평가한다", () => {
  const request = { toolName: "writeTextFile", args: { path: "a.txt" } };
  assert.equal(checkPermission(ALLOW_ALL, request), "allow");
  const policy: PermissionPolicy = { defaultDecision: "ask", rules: [
    { toolName: "writeTextFile", decision: "allow" },
    { toolName: "writeTextFile", decision: "deny", matchesArguments: (args) => (args as { path: string }).path === "a.txt" },
  ] };
  assert.equal(checkPermission(policy, request), "deny");
  assert.equal(checkPermission(policy, { ...request, args: { path: "b.txt" } }), "allow");
  assert.equal(checkPermission(policy, { toolName: "unknown", args: {} }), "ask");
  assert.equal(checkPermission({ ...policy, rules: [...policy.rules, { toolName: "writeTextFile", decision: "ask" }] },
    { ...request, args: { path: "b.txt" } }), "ask");
});

test("deny와 승인자 없는 ask는 실행하지 않고 allow는 실행한다", async () => {
  const { tools, executions } = fixture();
  for (const defaultDecision of ["deny", "ask"] as const) {
    const result = await tools.execute("writeTextFile", '{"path":"a.txt"}', { llm, permissions: { defaultDecision, rules: [] } });
    assert.equal(result.isError, true);
  }
  assert.equal(executions.length, 0);
  assert.equal((await tools.execute("writeTextFile", '{"path":"a.txt"}', { llm })).content, "written");
});

test("인자 검증이 먼저이며 승인은 실제 인자를 보고 한 번만 허용한다", async () => {
  const { tools, executions } = fixture();
  let approvals = 0;
  const context = { llm, permissions: { defaultDecision: "ask", rules: [] } as PermissionPolicy,
    // 화면에 전달된 인자를 바꿔도 실제 실행 인자는 바뀌지 않는다.
    async requestApproval(request: PermissionRequest) { approvals++; assert.deepEqual(request.args, { path: "a.txt" }); (request.args as { path: string }).path = "other.txt"; return true; },
  };
  assert.equal((await tools.execute("writeTextFile", '{"path":1}', context)).isError, true);
  assert.equal(approvals, 0);
  await tools.execute("writeTextFile", '{"path":"a.txt"}', context);
  await tools.execute("writeTextFile", '{"path":"a.txt"}', context);
  assert.equal(approvals, 2);
  assert.deepEqual(executions, [{ path: "a.txt" }, { path: "a.txt" }]);
  await tools.execute("writeTextFile", '{"path":"a.txt"}', { ...context, async requestApproval() { return false; } });
  assert.equal(executions.length, 2);
});

test("MCP도 같은 권한 검사를 통과해야 한다", async () => {
  const { tools, executions } = fixture("mcp:test");
  const result = await tools.execute("writeTextFile", '{"path":"a.txt"}', { llm,
    discoveredTools: ["writeTextFile"], permissions: { defaultDecision: "deny", rules: [] } });
  assert.equal(result.isError, true);
  assert.equal(executions.length, 0);
});

test("승인 중 중단은 응답을 기다리지 않고 실행을 막는다", async () => {
  const { tools, executions } = fixture();
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const running = tools.execute("writeTextFile", '{"path":"a.txt"}', { llm,
    signal: controller.signal, permissions: { defaultDecision: "ask", rules: [] },
    async requestApproval() { entered.resolve(); return new Promise<boolean>(() => {}); },
  });
  await entered.promise;
  controller.abort(new Error("cancelled"));
  await assert.rejects(running, /cancelled/);
  assert.equal(executions.length, 0);
});

test("승인 중 툴 해제 또는 승인 함수 실패는 실행으로 이어지지 않는다", async () => {
  const { tools, executions, unregister } = fixture();
  const context = { llm, permissions: { defaultDecision: "ask", rules: [] } as PermissionPolicy };
  assert.equal((await tools.execute("writeTextFile", '{"path":"a.txt"}', {
    ...context, async requestApproval() { throw new Error("UI 실패"); },
  })).isError, true);
  assert.equal((await tools.execute("writeTextFile", '{"path":"a.txt"}', {
    ...context, async requestApproval() { unregister(); return true; },
  })).isError, true);
  assert.equal(executions.length, 0);
});

test("Agent의 정책이 실행기에 전달되고 거부 결과를 다음 모델 요청에 기록한다", async () => {
  const { tools, executions } = fixture();
  let calls = 0;
  const agent = createAgent({ toolManager: tools, skillManager: new SkillManager(),
    paths: createHarnessPaths("/test", "/test-home"),
    history: { async append() {}, async flush() {} }, async saveSession() {},
    permissions: { defaultDecision: "deny", rules: [] },
    adapter: { async generate(request) {
      if (++calls === 1) return { stopReason: "tool-calls", message: { role: "assistant", content: [
        { type: "tool-call", id: "write", name: "writeTextFile", arguments: '{"path":"a.txt"}' },
      ] } };
      assert.match(JSON.stringify(request.messages.at(-1)), /권한 정책/);
      return { stopReason: "stop", message: { role: "assistant", content: [{ type: "text", text: "거부 확인" }] } };
    } },
  });
  assert.equal(await agent.turn(createSession("/test"), "write"), "거부 확인");
  assert.equal(executions.length, 0);
});
