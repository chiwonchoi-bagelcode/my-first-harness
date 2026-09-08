import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createElement as h } from "react";
import { render } from "ink-testing-library";
import { TuiScreen, conversationLines } from "../tui.ts";
import { inputCharacters, inputWindow } from "../tui-input.ts";
import stringWidth from "string-width";
import { commandSuggestions, createTuiSession } from "../tui-session.ts";
import { createHarnessPaths } from "../harness-paths.ts";
import { solidPng } from "./image-fixture.ts";
import type { TuiOptions } from "../tui-session.ts";
import type { HistoryEvent } from "../execution-history.ts";
import type { Session } from "../session.ts";
import { JobManager } from "../job-manager.ts";

// 사용자 파일과 네트워크를 건드리지 않는 실제 TUI 제어 객체를 만든다.
function fixture(overrides: Partial<TuiOptions> = {}) {
  const calls: string[] = [];
  const saved = new Map<string, Session>();
  const records: HistoryEvent[] = [];
  const controller = createTuiSession({
    model: "test", paths: createHarnessPaths("/test", "/test-home"), supportsImages: true,
    agent: {
      // 모델 실행 대신 입력과 첨부 개수를 확인한다.
      async turn(_session, input, images) { calls.push(`${input}:${images?.length}`); return "답변"; },
      // 명령이 코어의 압축 API에 연결되는지 확인한다.
      async compact() { calls.push("compact"); },
    },
    history: {
      // 기록 시점의 값을 독립적으로 보관한다.
      async append(_scope, event) { records.push(structuredClone(event)); },
      // 파일 대신 메모리에 기록하므로 대기할 작업이 없다.
      async flush() {},
    },
    // 저장·로드의 실제 세션 형식을 유지하되 메모리에만 쓴다.
    async saveSession(session) { saved.set(session.id, structuredClone(session)); },
    // 없는 세션은 현재 화면을 바꾸지 않도록 오류를 돌려준다.
    async loadSession(id) { if (!saved.has(id)) throw new Error("없는 세션"); return structuredClone(saved.get(id)!); },
    // 종료가 여러 번 호출돼도 정리는 한 번인지 확인한다.
    async dispose() { calls.push("dispose"); },
    ...overrides,
  });
  return { controller, calls, saved, records };
}

// React 상태 반영과 Ink 프레임 출력이 끝날 때까지 기다린다.
async function settle() { await new Promise((resolve) => setTimeout(resolve, 60)); }

test("명령 후보는 접두사·이미지 지원 여부에 맞고 인자 입력 중에는 닫힌다", () => {
  assert.deepEqual(commandSuggestions("/", true).map((entry) => entry.name), ["/new", "/resume", "/compact", "/attach", "/quit"]);
  assert.deepEqual(commandSuggestions("/r", true).map((entry) => entry.usage), ["/resume <session-id>"]);
  assert.equal(commandSuggestions("/", false).some((entry) => entry.name === "/attach"), false);
  for (const value of ["hello", "/unknown", "/attach ", "/resume abc"]) assert.deepEqual(commandSuggestions(value, true), []);
});

test("slash 후보의 방향키·Tab·Enter는 입력을 채우고 다음 Enter에서만 실행한다", async (t) => {
  const { controller, calls, records } = fixture();
  await controller.start();
  const view = render(h(TuiScreen, { controller, model: "test", supportsImages: true, onQuit() {} }));
  t.after(() => { view.unmount(); view.cleanup(); });
  await settle();
  view.stdin.write("/"); await settle();
  assert.match(view.lastFrame()!, /사용법: \/new/);
  view.stdin.write("\u001b[B"); await settle();
  assert.match(view.lastFrame()!, /사용법: \/resume <session-id>/);
  view.stdin.write("\t"); await settle();
  assert.doesNotMatch(view.lastFrame()!, /명령 선택/);
  assert.match(view.lastFrame()!, /> \/resume /);
  assert.equal(records.filter((event) => event.type === "command").length, 0);
  view.stdin.write("missing"); await settle();
  view.stdin.write("\r"); await settle();
  assert.match(view.lastFrame()!, /없는 세션/);
  view.stdin.write("/"); await settle();
  view.stdin.write("\u001b[A"); await settle();
  assert.match(view.lastFrame()!, /사용법: \/quit/);
  // /quit 대신 /new를 골라 첫 Enter와 실제 실행을 구분한다.
  view.stdin.write("\u001b[B"); await settle();
  const before = controller.getSnapshot().sessionId;
  view.stdin.write("\r"); await settle();
  assert.equal(controller.getSnapshot().sessionId, before);
  assert.match(view.lastFrame()!, /> \/new/);
  view.stdin.write("\r"); await settle();
  assert.notEqual(controller.getSnapshot().sessionId, before);
  assert.deepEqual(calls, []);
});

test("한글 입력과 진행 출력이 보이며 실행 중에는 요청을 중복 제출하지 않는다", async (t) => {
  const pending = Promise.withResolvers<string>();
  let invoked = 0;
  const { controller } = fixture({ agent: {
    async turn() { invoked++; return pending.promise; }, async compact() {},
  } });
  const view = render(h(TuiScreen, { controller, model: "test", supportsImages: true, onQuit() {} }));
  t.after(() => { view.unmount(); view.cleanup(); });
  await settle();
  view.stdin.write("안녕하세요"); await settle();
  view.stdin.write("\r"); await settle();
  controller.onEvent({ type: "assistant-text", text: "확인하겠습니다." });
  controller.onEvent({ type: "tool-start", name: "readTextFile", arguments: '{"path":"hello.txt"}' });
  await settle();
  assert.match(view.lastFrame()!, /나 › 안녕하세요/);
  assert.match(view.lastFrame()!, /확인하겠습니다/);
  assert.match(view.lastFrame()!, /실행 중 · readTextFile/);
  view.stdin.write("another\r"); await settle();
  await controller.submit("겹치는 요청");
  assert.equal(invoked, 1);
  pending.resolve("확인 완료"); await settle();
  assert.match(view.lastFrame()!, /확인 완료/);
  assert.match(view.lastFrame()!, /상태: 대기 중/);
});

test("첨부는 한 번 소비되고 new/resume은 대기 첨부를 비우며 잘못된 명령은 모델에 보내지 않는다", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-tui-image-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "space image.png");
  await writeFile(path, solidPng());
  const { controller, calls } = fixture();
  await controller.start();
  const original = controller.getSnapshot().sessionId;
  await controller.submit(`/attach "${path}"`);
  assert.equal(controller.getSnapshot().pendingImages, 1);
  await controller.submit("설명해줘");
  await controller.submit("계속");
  assert.deepEqual(calls, ["설명해줘:1", "계속:0"]);
  await controller.submit(`/attach ${path}`);
  await controller.submit("/new");
  assert.equal(controller.getSnapshot().pendingImages, 0);
  await controller.submit(`/attach ${path}`);
  await controller.submit(`/resume ${original}`);
  assert.equal(controller.getSnapshot().sessionId, original);
  assert.equal(controller.getSnapshot().pendingImages, 0);
  await controller.submit("/compact");
  await controller.submit("/resume");
  await controller.submit("/unknown");
  assert.deepEqual(calls, ["설명해줘:1", "계속:0", "compact"]);
  assert.match(controller.getSnapshot().entries.at(-1)!.text, /알 수 없는 명령/);
  await controller.submit("/quit");
  await controller.close();
  assert.equal(calls.filter((entry) => entry === "dispose").length, 1);
});

test("종료 알림에서 다시 close해도 재귀 실행 없이 한 번 정리한다", async () => {
  const { controller, calls, records } = fixture();
  controller.subscribe(() => { if (controller.getSnapshot().closed) void controller.close(); });
  await Promise.all([controller.close("SIGINT"), controller.close()]);
  assert.deepEqual(calls, ["dispose"]);
  assert.equal(records.filter((event) => event.type === "session-close").length, 1);
});

test("화면의 긴 툴 인자만 줄이고 ANSI 제어를 제거하되 원문은 바꾸지 않는다", () => {
  const entries = [{ kind: "tool" as const, text: "read " + "x".repeat(1000) },
    { kind: "assistant" as const, text: "hello\u001b[2Jworld" }];
  const before = structuredClone(entries);
  const lines = conversationLines(entries, 30);
  assert.ok(lines.length < 12);
  assert.match(lines.map((line) => line.text).join(""), /helloworld/);
  assert.deepEqual(entries, before);
});

test("긴 한글·이모지 입력은 문자와 원문 줄바꿈을 보존하면서 커서 주변만 표시한다", () => {
  const value = "가나다".repeat(100) + "👨‍👩‍👧‍👦끝";
  const chars = inputCharacters(value);
  assert.deepEqual(chars.slice(-2), ["👨‍👩‍👧‍👦", "끝"]);
  const window = inputWindow(value, chars.length, 20);
  assert.ok(stringWidth(window.before + window.current + window.after) <= 20);
  assert.ok(window.before.endsWith("끝"));
  assert.equal(inputWindow("a\nb", 1, 20).current, "↵");
});

test("줄바꿈 붙여넣기는 자동 제출하지 않고 원문 그대로 전달하며 긴 입력 끝도 보인다", async (t) => {
  const { controller, calls } = fixture();
  const view = render(h(TuiScreen, { controller, model: "test", supportsImages: true, onQuit() {} }));
  t.after(() => { view.unmount(); view.cleanup(); });
  await settle();
  const value = "가".repeat(120) + "\n마지막";
  view.stdin.write(value); await settle();
  assert.equal(calls.length, 0);
  assert.match(view.lastFrame()!, /↵마지막/);
  view.stdin.write("\r"); await settle();
  assert.deepEqual(calls, [`${value}:0`]);
});

test("PageUp/Down으로 긴 대화를 보고 Escape로 후보만 닫는다", async (t) => {
  const { controller } = fixture();
  for (let i = 0; i < 50; i++) controller.onEvent({ type: "assistant-text", text: `기록-${i}` });
  const view = render(h(TuiScreen, { controller, model: "test", supportsImages: true, onQuit() {} }));
  t.after(() => { view.unmount(); view.cleanup(); });
  await settle();
  assert.match(view.lastFrame()!, /기록-49/);
  view.stdin.write("\u001b[5~"); await settle();
  assert.doesNotMatch(view.lastFrame()!, /기록-49/);
  assert.match(view.lastFrame()!, /이전 내용 보는 중/);
  view.stdin.write("\u001b[6~"); await settle();
  assert.match(view.lastFrame()!, /기록-49/);
  view.stdin.write("/"); await settle();
  assert.match(view.lastFrame()!, /명령 선택/);
  view.stdin.write("\u001b"); await settle();
  assert.doesNotMatch(view.lastFrame()!, /명령 선택/);
  assert.match(view.lastFrame()!, /> \//);
});

test("실행 실패 후 새 일반 요청은 막고 새 세션에서 다시 실행할 수 있다", async () => {
  let attempts = 0;
  const { controller } = fixture({ agent: {
    async turn() { if (++attempts === 1) throw new Error("모의 요청 실패"); return "완료"; },
    async compact() {},
  } });
  await controller.submit("첫 요청");
  assert.match(controller.getSnapshot().status, /실행 실패/);
  await controller.submit("겹친 재요청");
  assert.equal(attempts, 1);
  await controller.submit("/new");
  await controller.submit("새 요청");
  assert.equal(attempts, 2);
  assert.equal(controller.getSnapshot().status, "대기 중");
});

test("TUI 종료는 실제 백그라운드 셸 작업도 정리한다", async (t) => {
  const jobs = new JobManager();
  t.after(() => jobs.dispose());
  const job = await jobs.start(`${JSON.stringify(process.execPath)} -e "setInterval(()=>{},1000)"`);
  const { controller } = fixture({ dispose: () => jobs.dispose() });
  await controller.close("SIGINT");
  assert.notEqual((await jobs.read(job.jobId)).status, "running");
});

test("터미널이 너무 작으면 안내하고 다시 넓히면 입력창을 복원한다", async (t) => {
  const { controller } = fixture();
  const view = render(h(TuiScreen, { controller, model: "test", onQuit() {} }));
  t.after(() => { view.unmount(); view.cleanup(); });
  await settle();
  Object.defineProperty(view.stdout, "columns", { configurable: true, value: 35 });
  Object.defineProperty(view.stdout, "rows", { configurable: true, value: 10 });
  view.stdout.emit("resize"); await settle();
  assert.match(view.lastFrame()!, /터미널을/);
  Object.defineProperty(view.stdout, "columns", { configurable: true, value: 100 });
  Object.defineProperty(view.stdout, "rows", { configurable: true, value: 24 });
  view.stdout.emit("resize"); await settle();
  assert.match(view.lastFrame()!, /메시지 또는 \/명령/);
});
