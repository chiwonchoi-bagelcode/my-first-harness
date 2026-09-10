import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import { render } from "ink-testing-library";
import { createAgent } from "../agent.ts";
import type { AgentEvent } from "../agent.ts";
import { createSession } from "../session.ts";
import { createHarnessPaths } from "../harness-paths.ts";
import { ToolManager } from "../tool-manager.ts";
import { SkillManager } from "../skill-manager.ts";
import { INTERACTIVE_PERMISSIONS } from "../permissions.ts";
import { createTuiSession } from "../tui-session.ts";
import { TuiScreen } from "../tui.ts";
import type { LLMRequest, LLMResult } from "../llm-types.ts";
import { modeFixture } from "./mode-fixture.ts";

const paths = createHarnessPaths("/test", "/test-home");
const history = { async append() {}, async flush() {} };

// 지정한 툴을 한 번 요청하는 모델 응답을 만든다.
function call(name: string, id: string): LLMResult {
  return { stopReason: "tool-calls", message: { role: "assistant", content: [{ type: "tool-call", id, name, arguments: "{}" }] } };
}
const stop: LLMResult = { stopReason: "stop", message: { role: "assistant", content: [{ type: "text", text: "끝" }] } };

// 스텝마다 호출되는 훅으로 턴 도중 모드·권한 변경을 흉내 내는 실제 코어를 만든다.
function fixture(options: {
  outputs: LLMResult[];
  onGenerate?: (request: LLMRequest, index: number) => void;
  requestApproval?: (request: { toolName: string }) => Promise<boolean | "session">;
}) {
  const tools = new ToolManager();
  const executions: string[] = [];
  for (const name of ["runCommand", "writeTextFile"]) tools.register({ name, description: "test", parameters: { type: "object" },
    // 실제 셸·파일 대신 실행 순서만 남긴다.
    execute() { executions.push(name); return "ok"; } });
  const requests: LLMRequest[] = [];
  const events: AgentEvent[] = [];
  const agent = createAgent({ paths, history, toolManager: tools, skillManager: new SkillManager(),
    permissions: INTERACTIVE_PERMISSIONS, async saveSession() {}, onEvent: (event) => events.push(event),
    requestApproval: options.requestApproval,
    adapter: {
      // 요청을 보관하고 훅을 부른 뒤 준비된 응답을 차례로 돌려준다.
      async generate(request) {
        requests.push(structuredClone(request));
        options.onGenerate?.(request, requests.length);
        return options.outputs.shift() ?? stop;
      },
    },
  });
  return { agent, requests, events, executions };
}

test("턴 중 YOLO 전환은 다음 툴 호출부터 승인을 생략하고 이미 열린 질문은 답을 기다린다", async () => {
  const first = Promise.withResolvers<boolean>();
  let asked = 0;
  const f = fixture({
    outputs: [call("runCommand", "1"), call("runCommand", "2"), stop],
    // 첫 질문만 열어 둔다. 두 번째 질문은 나오면 안 된다.
    async requestApproval() { asked++; return first.promise; },
  });
  const turn = f.agent.turn(createSession("/test"), "run twice");
  while (asked === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  f.agent.setPermissionMode("yolo");
  assert.equal(f.agent.getPermissionMode(), "yolo");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(f.executions, [], "열린 승인 질문을 YOLO 전환이 대신 답하면 안 된다");
  first.resolve(true);
  assert.equal(await turn, "끝");
  assert.deepEqual(f.executions, ["runCommand", "runCommand"]);
  assert.equal(asked, 1);
});

test("턴 중 plan 요청은 다음 스텝에서 지침·권한과 알림 메시지로 반영된다", async () => {
  const f = fixture({
    outputs: [call("writeTextFile", "1"), call("writeTextFile", "2"), stop],
    onGenerate(_request, index) {
      if (index !== 1) return;
      assert.equal(f.agent.setMode("plan"), "queued");
      assert.equal(f.agent.getMode(), "edit");
      assert.equal(f.agent.getPendingMode(), "plan");
    },
  });
  const session = createSession("/test");
  await f.agent.turn(session, "write");
  // 첫 스텝의 쓰기는 edit 그대로 실행되고, 둘째 스텝의 쓰기는 plan에서 거부된다.
  assert.deepEqual(f.executions, ["writeTextFile"]);
  assert.match(f.requests[0].system, /현재 모드: edit/);
  assert.match(f.requests[1].system, /현재 모드: plan/);
  assert.match(JSON.stringify(f.requests[1].messages), /\[하네스 알림\] 사용자가 작업 모드를 plan로 전환/);
  assert.match(JSON.stringify(f.requests[2].messages), /거부/);
  assert.deepEqual(f.events.filter((event) => event.type === "mode-changed"), [{ type: "mode-changed", mode: "plan", reason: "user" }]);
  assert.equal(f.agent.getMode(), "plan");
  assert.equal(f.agent.getPendingMode(), undefined);
});

test("대기 중 같은 모드를 다시 고르면 취소되고, 스텝 없이 턴이 끝나면 턴 끝에 반영된다", async () => {
  const cancel = fixture({
    outputs: [call("writeTextFile", "1"), stop],
    onGenerate(_request, index) {
      if (index !== 1) return;
      assert.equal(cancel.agent.setMode("plan"), "queued");
      assert.equal(cancel.agent.setMode("edit"), "applied");
      assert.equal(cancel.agent.getPendingMode(), undefined);
    },
  });
  await cancel.agent.turn(createSession("/test"), "cancel");
  assert.deepEqual(cancel.executions, ["writeTextFile"]);
  assert.doesNotMatch(JSON.stringify(cancel.requests[1].messages), /하네스 알림\] 사용자가 작업 모드/);
  assert.equal(cancel.events.filter((event) => event.type === "mode-changed").length, 0);

  const late = fixture({
    outputs: [stop],
    onGenerate() { assert.equal(late.agent.setMode("plan"), "queued"); },
  });
  const session = createSession("/test");
  await late.agent.turn(session, "last step");
  assert.equal(late.agent.getMode(), "plan");
  assert.deepEqual(late.events.filter((event) => event.type === "mode-changed"), [{ type: "mode-changed", mode: "plan", reason: "user" }]);
  assert.doesNotMatch(JSON.stringify(session.messages), /하네스 알림\] 사용자가 작업 모드/);
  // 턴 밖의 변경은 즉시 적용된다.
  assert.equal(late.agent.setMode("edit"), "applied");
  assert.equal(late.agent.getMode(), "edit");
});

test("TUI는 실행 중 Shift+Tab을 받아 대기 모드를 표시하고 적용 이벤트로 갱신한다", async (t) => {
  const pendingTurn = Promise.withResolvers<string>();
  let pendingMode: "plan" | "edit" | undefined;
  let mode: "plan" | "edit" = "edit";
  const agent = {
    ...modeFixture(),
    getMode: () => mode,
    // 실제 코어처럼 실행 중에는 대기로 받는다.
    setMode(next: "plan" | "edit") { pendingMode = next === mode ? undefined : next; return pendingMode ? "queued" as const : "applied" as const; },
    getPendingMode: () => pendingMode,
    interrupt() { return false; },
    async turn() { return pendingTurn.promise; },
    async compact() {},
  };
  const records: string[] = [];
  const controller = createTuiSession({ agent, model: "test", paths, dispose: async () => {}, async saveSession() {},
    history: { async append(_scope, event) { if (event.type === "command") records.push(event.input); }, async flush() {} } });
  const view = render(h(TuiScreen, { controller, model: "test", onQuit() {} }));
  t.after(() => { view.unmount(); view.cleanup(); });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  await settle();
  void controller.submit("오래 걸리는 요청");
  await settle();
  assert.equal(controller.getSnapshot().busy, true);
  view.stdin.write("\x1b[Z"); await settle();
  assert.equal(controller.getSnapshot().pendingMode, "plan");
  assert.equal(controller.getSnapshot().mode, "edit");
  assert.match(view.lastFrame()!, /\[edit → plan \(다음 스텝\)\]/);
  assert.match(view.lastFrame()!, /모드: plan \(다음 스텝부터\)/);
  assert.deepEqual(records, ["/mode plan"]);
  // 두 번째 Shift+Tab은 대기 중인 plan을 기준으로 YOLO로 간다. 권한은 즉시 바뀐다.
  view.stdin.write("\x1b[Z"); await settle();
  assert.equal(controller.getSnapshot().permissionMode, "yolo");
  assert.match(view.lastFrame()!, /\[YOLO\]/);
  assert.match(view.lastFrame()!, /다음 툴 호출부터/);
  // 코어가 다음 스텝에서 적용하면 대기 표시가 사라진다.
  mode = "edit"; pendingMode = undefined;
  controller.onEvent({ type: "mode-changed", mode: "edit", reason: "user" });
  await settle();
  assert.equal(controller.getSnapshot().pendingMode, undefined);
  assert.doesNotMatch(view.lastFrame()!, /다음 스텝\)/);
  assert.equal(controller.getSnapshot().busy, true, "모드 변경이 실행 중 상태를 풀면 안 된다");
  pendingTurn.resolve("완료");
  await settle();
  assert.equal(controller.getSnapshot().busy, false);
  await controller.close();
});
