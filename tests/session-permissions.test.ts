import assert from "node:assert/strict";
import test from "node:test";
import { createSessionApprover, INTERACTIVE_PERMISSIONS } from "../permissions.ts";
import { createAgent } from "../agent.ts";
import { createSession } from "../session.ts";
import { createHarnessPaths } from "../harness-paths.ts";
import { ToolManager } from "../tool-manager.ts";
import { SkillManager } from "../skill-manager.ts";

test("세션 승인은 인자가 달라도 재사용하되 세션·등록 소유자는 구분한다", async () => {
  let approvals = 0;
  const approve = createSessionApprover(async () => { approvals++; return "session"; });
  const request = { toolName: "runCommand", owner: "plugin:shell", args: { command: "one" } };
  assert.equal(await approve("one", request), true);
  assert.equal(await approve("one", { ...request, args: { command: "two" } }), true);
  assert.equal(approvals, 1);
  await approve("two", request);
  await approve("one", { ...request, owner: "mcp:remote" });
  assert.equal(approvals, 3);
});

test("중단 뒤 늦은 세션 승인은 저장되지 않는다", async () => {
  let count = 0;
  const pending = Promise.withResolvers<"session">();
  const approve = createSessionApprover(async () => ++count === 1 ? pending.promise : false);
  const signal = new AbortController();
  const request = { toolName: "runCommand", args: {} };
  const answer = approve("one", request, signal.signal);
  signal.abort();
  pending.resolve("session");
  await assert.rejects(answer);
  assert.equal(await approve("one", request), false);
});

test("실제 Agent는 세션 승인을 재사용하고 YOLO에서만 deny를 우회한다", async () => {
  const tools = new ToolManager();
  let executions = 0;
  let approvals = 0;
  for (const name of ["runCommand", "writeTextFile"]) tools.register({
    name, description: "test", parameters: { type: "object" },
    // 실제 셸·파일 대신 실행 횟수만 측정한다.
    execute() { executions++; return "ok"; },
  });
  let calls = 0;
  let toolName = "runCommand";
  const agent = createAgent({
    toolManager: tools, skillManager: new SkillManager(), paths: createHarnessPaths("/test", "/test-home"),
    history: { async append() {}, async flush() {} }, async saveSession() {},
    permissions: INTERACTIVE_PERMISSIONS,
    async requestApproval() { approvals++; return "session"; },
    adapter: {
      // 각 턴마다 지정한 툴을 한 번 요청하고 종료한다.
      async generate() {
        return ++calls % 2 === 1 ? { stopReason: "tool-calls", message: { role: "assistant", content: [
          { type: "tool-call", id: String(calls), name: toolName, arguments: "{}" },
        ] } } : { stopReason: "stop", message: { role: "assistant", content: [] } };
      },
    },
  });
  const session = createSession("/test");
  await agent.turn(session, "one");
  await agent.turn(session, "two");
  assert.equal(approvals, 1);
  await agent.turn(createSession("/test"), "new");
  assert.equal(approvals, 2);
  assert.equal(executions, 3);
  toolName = "writeTextFile";
  agent.setMode("plan");
  await agent.turn(session, "denied");
  assert.equal(executions, 3);
  agent.setPermissionMode("yolo");
  await agent.turn(session, "bypass");
  assert.equal(executions, 4);
  assert.equal(approvals, 2);
  agent.setPermissionMode("default");
  await agent.turn(session, "denied again");
  assert.equal(executions, 4);
});
