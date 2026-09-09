import assert from "node:assert/strict";
import test from "node:test";
import { createAgent } from "../agent.ts";
import { createSession } from "../session.ts";
import { createHarnessPaths } from "../harness-paths.ts";
import { ToolManager } from "../tool-manager.ts";
import { SkillManager } from "../skill-manager.ts";
import { INTERACTIVE_PERMISSIONS, checkPermission } from "../permissions.ts";
import { modePermissions, parseMode } from "../agent-mode.ts";
import type { LLMRequest } from "../llm-types.ts";

test("plan은 파일 쓰기·편집을 거부하며 셸·MCP 승인은 유지한다", () => {
  const policy = modePermissions("plan", INTERACTIVE_PERMISSIONS);
  for (const name of ["writeTextFile", "editTextFile"]) {
    assert.equal(checkPermission(policy, { toolName: name, args: {} }), "deny");
    assert.equal(checkPermission(modePermissions("edit", INTERACTIVE_PERMISSIONS), { toolName: name, args: {} }), "allow");
  }
  assert.equal(checkPermission(policy, { toolName: "readTextFile", args: {} }), "allow");
  assert.equal(checkPermission(policy, { toolName: "runCommand", args: {} }), "ask");
  assert.equal(checkPermission(policy, { toolName: "remote", owner: "mcp:test", args: {} }), "ask");
  assert.throws(() => parseMode("plan extra"), /사용법/);
});

test("실제 Agent는 모드 지침을 교체하고 plan 쓰기를 거부한 뒤 edit에서 실행한다", async () => {
  const tools = new ToolManager();
  let executions = 0;
  tools.register({ name: "writeTextFile", description: "test", parameters: { type: "object" },
    // 디스크 대신 실행 횟수만 기록한다.
    execute() { executions++; return "written"; } });
  const requests: LLMRequest[] = [];
  const agent = createAgent({ toolManager: tools, skillManager: new SkillManager(),
    paths: createHarnessPaths("/test", "/test-home"), permissions: INTERACTIVE_PERMISSIONS,
    history: { async append() {}, async flush() {} }, async saveSession() {},
    adapter: {
      // 매 턴 파일 쓰기 요청 하나와 최종 응답을 차례로 반환한다.
      async generate(request) {
        requests.push(structuredClone(request));
        assert.throws(() => agent.setMode("edit"), /턴/);
        return requests.length % 2 === 1
          ? { stopReason: "tool-calls", message: { role: "assistant", content: [
            { type: "tool-call", id: String(requests.length), name: "writeTextFile", arguments: "{}" },
          ] } }
          : { stopReason: "stop", message: { role: "assistant", content: [] } };
      },
    },
  });
  const session = createSession("/test");
  assert.equal(agent.getMode(), "edit");
  agent.setMode("plan");
  await agent.turn(session, "test");
  assert.equal(executions, 0);
  assert.match(requests[0].system!, /현재 모드: plan/);
  assert.match(JSON.stringify(requests[1].messages), /거부/);
  agent.setMode("edit");
  await agent.turn(session, "test");
  assert.equal(executions, 1);
  assert.match(requests[2].system!, /현재 모드: edit/);
  assert.doesNotMatch(requests[2].system!, /현재 모드: plan/);
  assert.doesNotMatch(JSON.stringify(session.messages), /현재 모드:/);
});
