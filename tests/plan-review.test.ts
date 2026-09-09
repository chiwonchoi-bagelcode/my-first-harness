import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline/promises";
import { createElement as h } from "react";
import { render } from "ink-testing-library";
import { createAgent } from "../agent.ts";
import type { AgentEvent } from "../agent.ts";
import { createSession } from "../session.ts";
import { createHarnessPaths } from "../harness-paths.ts";
import { ToolManager } from "../tool-manager.ts";
import { SkillManager } from "../skill-manager.ts";
import { INTERACTIVE_PERMISSIONS } from "../permissions.ts";
import { createCliPlanReview } from "../cli.ts";
import { createTuiSession } from "../tui-session.ts";
import { TuiScreen } from "../tui.ts";
import type { RequestPlanReview } from "../plan-review.ts";
import type { LLMRequest, LLMResult, ToolCallBlock } from "../llm-types.ts";
import { modeFixture } from "./mode-fixture.ts";

const paths = createHarnessPaths("/test", "/test-home");
const history = { async append() {}, async flush() {} };
// 실제 API 없이 정해진 툴 요청을 모델 응답으로 만든다.
function calls(...names: string[]): LLMResult {
  return { stopReason: "tool-calls", message: { role: "assistant", content: names.map((name, index): ToolCallBlock => ({
    type: "tool-call", id: name + index, name,
    arguments: name === "exit_plan_mode" ? JSON.stringify({ plan: "# Test plan\n\nWrite one file." }) : "{}",
  })) } };
}
// 모델 요청과 파일 쓰기 횟수를 수집하는 실제 코어를 만든다.
function fixture(outputs: LLMResult[], requestPlanReview?: RequestPlanReview, onEvent?: (event: AgentEvent) => void) {
  const tools = new ToolManager();
  let writes = 0;
  tools.register({ name: "writeTextFile", description: "test", parameters: { type: "object" },
    // 파일을 만들지 않고 실행 여부만 기록한다.
    execute() { writes++; return "written"; } });
  const requests: LLMRequest[] = [];
  const agent = createAgent({ paths, history, toolManager: tools, skillManager: new SkillManager(),
    permissions: INTERACTIVE_PERMISSIONS, requestPlanReview, onEvent, async saveSession() {},
    adapter: {
      // 지정한 응답을 모두 소비하면 턴을 종료한다.
      async generate(request) {
        requests.push(structuredClone(request));
        return outputs.shift() ?? { stopReason: "stop", message: { role: "assistant", content: [] } };
      },
    },
  });
  agent.setMode("plan");
  return { agent, tools, requests, getWrites: () => writes };
}
// Ink 상태 변경과 입력 핸들러 교체가 끝나기를 기다린다.
async function settle() { await new Promise((resolve) => setTimeout(resolve, 80)); }

test("승인 후 같은 툴 배치는 plan을 유지하고 다음 스텝에서만 edit로 바뀐다", async () => {
  const f = fixture([calls("exit_plan_mode", "writeTextFile"), calls("writeTextFile")], async (plan) => {
    assert.match(plan, /^# Test plan/);
    return { decision: "approve" };
  });
  await f.agent.turn(createSession("/test"), "plan it");
  assert.equal(f.getWrites(), 1);
  assert.match(f.requests[0].system, /현재 모드: plan/);
  assert.match(f.requests[1].system, /현재 모드: edit/);
  assert.match(JSON.stringify(f.requests[1].messages), /권한 정책.*거부/);
  assert.deepEqual(f.requests[0].tools, f.requests[1].tools);
  assert.equal(f.agent.getMode(), "edit");
});

test("수정 의견은 툴 결과로 전달되고 재제출을 승인해야 edit로 전환한다", async () => {
  let reviews = 0;
  const f = fixture([calls("exit_plan_mode"), calls("exit_plan_mode")], async () =>
    ++reviews === 1 ? { decision: "revise", feedback: "테스트 계획을 추가해" } : { decision: "approve" });
  await f.agent.turn(createSession("/test"), "plan it");
  assert.match(f.requests[1].system, /현재 모드: plan/);
  assert.match(JSON.stringify(f.requests[1].messages), /테스트 계획을 추가해/);
  assert.match(f.requests[2].system, /현재 모드: edit/);
});

test("검토 취소는 plan을 유지하고 후속 호출 없이 턴을 종료한다", async () => {
  const f = fixture([calls("exit_plan_mode", "writeTextFile")], async () => ({ decision: "cancel" }));
  await f.agent.turn(createSession("/test"), "plan it");
  assert.equal(f.agent.getMode(), "plan");
  assert.equal(f.requests.length, 1);
  assert.equal(f.getWrites(), 0);
});

test("UI 없음·edit에서 호출·잘못된 계획은 실패하며 중단 후 늦은 승인도 무효다", async () => {
  const noUi = fixture([calls("exit_plan_mode")]);
  await noUi.agent.turn(createSession("/test"), "plan it");
  assert.match(JSON.stringify(noUi.requests[1].messages), /검토 UI가 없습니다/);
  assert.equal(noUi.agent.getMode(), "plan");
  const edit = fixture([calls("exit_plan_mode")], async () => { assert.fail("edit에서는 검토하지 않는다"); });
  edit.agent.setMode("edit");
  await edit.agent.turn(createSession("/test"), "test");
  assert.match(JSON.stringify(edit.requests[1].messages), /only available in plan mode/);
  const invalid = fixture([{ stopReason: "tool-calls", message: { role: "assistant", content: [
    { type: "tool-call", id: "bad", name: "exit_plan_mode", arguments: '{"plan":"no heading"}' },
  ] } }], async () => { assert.fail("잘못된 계획은 검토하지 않는다"); });
  await invalid.agent.turn(createSession("/test"), "test");
  assert.equal(invalid.agent.getMode(), "plan");
  const entered = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<{ decision: "approve" }>();
  const cancelled = fixture([calls("exit_plan_mode")], async () => { entered.resolve(); return answer.promise; });
  const turn = cancelled.agent.turn(createSession("/test"), "plan");
  await entered.promise;
  cancelled.agent.interrupt();
  await turn;
  answer.resolve({ decision: "approve" });
  await settle();
  assert.equal(cancelled.agent.getMode(), "plan");
});

test("CLI 계획 검토는 승인·수정 의견·취소·EOF를 구분한다", async (t) => {
  t.mock.method(console, "log", () => {});
  const input = new PassThrough();
  const terminal = createInterface({ input, output: new PassThrough(), terminal: false });
  t.after(() => terminal.close());
  const review = createCliPlanReview(terminal);
  for (const [text, expected] of [["y", "approve"], ["테스트 추가", "revise"], ["", "cancel"]] as const) {
    const pending = review("# plan");
    input.write(text + "\n");
    const answer = await pending;
    assert.equal(answer.decision, expected);
    if (answer.decision === "revise") assert.equal(answer.feedback, text);
  }
  const pending = review("# plan");
  input.end();
  assert.equal((await pending).decision, "cancel");
});

test("TUI는 계획 전문과 피드백 입력을 보여주며 기존 초안을 보존한다", async (t) => {
  const controller = createTuiSession({ paths, history, model: "test", async dispose() {}, async saveSession() {},
    agent: { ...modeFixture(), interrupt() { return false; }, async turn() { return ""; }, async compact() {} },
  });
  const app = render(h(TuiScreen, { controller, model: "test", onQuit() {} }));
  t.after(() => { app.unmount(); app.cleanup(); });
  await settle();
  app.stdin.write("draft"); await settle();
  const pending = controller.requestPlanReview("# First plan\n\nDetailed plan");
  await settle();
  assert.match(app.lastFrame()!, /Detailed plan/);
  app.stdin.write("n"); await settle();
  app.stdin.write("테스트 추가"); await settle();
  app.stdin.write("\r");
  assert.deepEqual(await pending, { decision: "revise", feedback: "테스트 추가" });
  await settle();
  assert.match(app.lastFrame()!, /> draft/);
  const next = controller.requestPlanReview("# Revised plan");
  await settle();
  app.stdin.write("y");
  assert.deepEqual(await next, { decision: "approve" });
  const closed = controller.requestPlanReview("# plan");
  await controller.close();
  assert.deepEqual(await closed, { decision: "cancel" });
});

test("실제 Agent와 TUI를 연결하면 승인 전 대기하고 승인 후 상단 모드가 바뀐다", async () => {
  let controller: ReturnType<typeof createTuiSession>;
  const entered = Promise.withResolvers<void>();
  const f = fixture([calls("exit_plan_mode"), calls("writeTextFile")], (plan, signal) => {
    const result = controller.requestPlanReview(plan, signal);
    entered.resolve();
    return result;
  }, (event) => controller.onEvent(event));
  controller = createTuiSession({ agent: f.agent, paths, history, model: "test", async dispose() {}, async saveSession() {} });
  const turn = controller.submit("plan");
  await entered.promise;
  assert.equal(controller.getSnapshot().busy, true);
  assert.equal(f.getWrites(), 0);
  controller.answerPlanReview({ decision: "approve" });
  await turn;
  assert.equal(f.agent.getMode(), "edit");
  assert.equal(controller.getSnapshot().mode, "edit");
  assert.equal(f.getWrites(), 1);
  await controller.close();
});
