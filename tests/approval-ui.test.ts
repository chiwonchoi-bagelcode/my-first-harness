import assert from "node:assert/strict";
import { modeFixture } from "./mode-fixture.ts";
import test from "node:test";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline/promises";
import { createElement as h } from "react";
import { render } from "ink-testing-library";
import { createCliApproval, createCli } from "../cli.ts";
import { createTuiSession } from "../tui-session.ts";
import { TuiScreen } from "../tui.ts";
import { createHarnessPaths } from "../harness-paths.ts";
import { createAgent } from "../agent.ts";
import { ToolManager } from "../tool-manager.ts";
import { SkillManager } from "../skill-manager.ts";

// 승인에 표시될 툴과 실제 인자를 만든다.
const request = { toolName: "runCommand", args: { command: "echo hello" } };

// 실제 사용자 파일·모델 없이 TUI 컨트롤러를 생성한다.
function fixture() {
  const controller = createTuiSession({
    paths: createHarnessPaths("/test", "/test-home"), model: "test",
    agent: { ...modeFixture(), interrupt() { return false; }, async turn() { return "ok"; }, async compact() {} },
    history: { async append() {}, async flush() {} }, async saveSession() {}, async dispose() {},
  });
  return controller;
}

test("CLI는 명시적인 y/yes만 승인하고 EOF·중단은 거부한다", async (t) => {
  t.mock.method(console, "log", () => {});
  const input = new PassThrough();
  const terminal = createInterface({ input, output: new PassThrough(), terminal: false });
  t.after(() => terminal.close());
  const approve = createCliApproval(terminal);
  for (const [answer, expected] of [["y", true], ["YES", true], ["s", "session"], ["session", "session"], ["", false], ["no", false], ["/quit", false]] as const) {
    const pending = approve(request);
    input.write(answer + "\n");
    assert.equal(await pending, expected);
  }
  const signal = new AbortController();
  const cancelled = approve(request, signal.signal);
  signal.abort();
  assert.equal(await cancelled, false);
  const eof = approve(request);
  input.end();
  assert.equal(await eof, false);
  assert.equal(await approve(request), false);
  assert.equal(await createCli().requestApproval(request), false);
});

test("TUI는 승인·거부를 해소하고 닫힘·중단 뒤 늦은 승인은 무시한다", async () => {
  const controller = fixture();
  const pending = controller.requestApproval(request);
  assert.deepEqual(controller.getSnapshot().approval, request);
  assert.equal(controller.getSnapshot().busy, true);
  assert.equal(await controller.requestApproval(request), false);
  controller.answerApproval(true);
  assert.equal(await pending, true);
  assert.equal(controller.getSnapshot().approval, undefined);
  const signal = new AbortController();
  const cancelled = controller.requestApproval(request, signal.signal);
  signal.abort();
  controller.answerApproval(true);
  assert.equal(await cancelled, false);
  const closed = controller.requestApproval(request);
  await controller.close();
  assert.equal(await closed, false);
  assert.equal(await controller.requestApproval(request), false);
});

test("TUI 승인 화면은 전체 인자를 스크롤 영역에 남기고 Y와 Enter를 처리한다", async (t) => {
  const controller = fixture();
  const app = render(h(TuiScreen, { controller, model: "test", supportsImages: false, onQuit() {} }));
  t.after(() => { app.unmount(); app.cleanup(); });
  const pending = controller.requestApproval(request);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.match(app.lastFrame()!, /승인/);
  assert.match(app.lastFrame()!, /echo hello/);
  app.stdin.write("y");
  assert.equal(await pending, true);
  const denied = controller.requestApproval(request);
  await new Promise((resolve) => setTimeout(resolve, 100));
  app.stdin.write("\r");
  assert.equal(await denied, false);
  await controller.close();
});

test("실제 Agent의 ask가 TUI 승인 대기와 연결되고 승인 전에는 실행하지 않는다", async () => {
  const tools = new ToolManager();
  let executions = 0;
  tools.register({ name: "probe", description: "probe", parameters: { type: "object" }, execute() { executions++; return "ok"; } });
  const paths = createHarnessPaths("/test", "/test-home");
  const history = { async append() {}, async flush() {} };
  let controller: ReturnType<typeof createTuiSession>;
  const entered = Promise.withResolvers<void>();
  let calls = 0;
  const agent = createAgent({ toolManager: tools, skillManager: new SkillManager(), paths, history,
    permissions: { defaultDecision: "ask", rules: [] },
    requestApproval(request, signal) { const pending = controller.requestApproval(request, signal); entered.resolve(); return pending; },
    async saveSession() {},
    adapter: { async generate() {
      return ++calls === 1 ? { stopReason: "tool-calls", message: { role: "assistant", content: [
        { type: "tool-call", id: "p", name: "probe", arguments: "{}" },
      ] } } : { stopReason: "stop", message: { role: "assistant", content: [] } };
    } },
  });
  controller = createTuiSession({ agent, paths, history, model: "test", async saveSession() {}, async dispose() {} });
  const running = controller.submit("test");
  await entered.promise;
  assert.equal(executions, 0);
  controller.answerApproval(true);
  await running;
  assert.equal(executions, 1);
  await controller.close();
});
