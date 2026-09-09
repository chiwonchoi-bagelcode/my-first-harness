import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createElement as h } from "react";
import { render } from "ink-testing-library";
import { render as renderTerminal } from "ink";
import { PassThrough } from "node:stream";
import { TuiScreen, conversationLines } from "../tui.ts";
import { inputCharacters, inputViewport, layoutInput } from "../tui-input.ts";
import stringWidth from "string-width";
import { commandSuggestions, createTuiSession } from "../tui-session.ts";
import { createHarnessPaths } from "../harness-paths.ts";
import { solidPng } from "./image-fixture.ts";
import type { TuiOptions } from "../tui-session.ts";
import type { HistoryEvent } from "../execution-history.ts";
import type { Session } from "../session.ts";
import { JobManager } from "../job-manager.ts";
import { listSessions, saveSession } from "../session-store.ts";
import { createSession } from "../session.ts";
import type { ExtensionControls, ExtensionItem } from "../extension-runtime.ts";
import type { ExtensionKind } from "../extension-settings.ts";

// 사용자 파일과 네트워크를 건드리지 않는 실제 TUI 제어 객체를 만든다.
function fixture(overrides: Partial<TuiOptions> = {}) {
  const calls: string[] = [];
  const saved = new Map<string, Session>();
  const records: HistoryEvent[] = [];
  const controller = createTuiSession({
    model: "test", paths: createHarnessPaths("/test", "/test-home"), supportsImages: true,
    agent: {
      // 기본 대체 코어에는 진행 중인 작업이 없다.
      interrupt() { return false; },
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
    // 목록도 같은 메모리 스냅샷에서 만들어 사용자 저장 폴더에 접근하지 않는다.
    async listSessions() { return { sessions: [...saved.values()].map((session) => ({ id: session.id, title: "테스트 대화", updatedAt: 1 })), skippedFiles: 0 }; },
    // 종료가 여러 번 호출돼도 정리는 한 번인지 확인한다.
    async dispose() { calls.push("dispose"); },
    ...overrides,
  });
  return { controller, calls, saved, records };
}

// React 상태 반영과 Ink 프레임 출력이 끝날 때까지 기다린다.
async function settle() { await new Promise((resolve) => setTimeout(resolve, 60)); }

test("휠·트랙패드 보고는 대화만 스크롤하고 새 출력에도 읽는 위치를 유지한다", async (t) => {
  const { controller } = fixture();
  for (let i = 0; i < 60; i++) controller.onEvent({ type: "assistant-text", text: `ROW-${String(i).padStart(3, "0")}` });
  const view = render(h(TuiScreen, { controller, model: "test", onQuit() {} }));
  t.after(() => { view.unmount(); view.cleanup(); });
  await settle();
  view.stdin.write("draft");
  view.stdin.write("\x1b[<64;10;5M"); await settle();
  const before = view.lastFrame()!.match(/ROW-\d+/g);
  assert.ok(before?.length);
  assert.doesNotMatch(view.lastFrame()!, /ROW-059/);
  controller.onEvent({ type: "assistant-text", text: "ROW-060" }); await settle();
  assert.deepEqual(view.lastFrame()!.match(/ROW-\d+/g), before);
  assert.match(view.lastFrame()!, /> draft/);
  assert.doesNotMatch(view.lastFrame()!, /64;10/);
  for (let i = 0; i < 10; i++) view.stdin.write("\x1b[<65;10;5M");
  await settle();
  assert.match(view.lastFrame()!, /ROW-060/);
  controller.onEvent({ type: "assistant-text", text: "ROW-061" }); await settle();
  assert.match(view.lastFrame()!, /ROW-061/);
});

test("툴 결과는 성공·실패와 시간 및 첫 줄만 표시하고 전체 내용은 화면에 펼치지 않는다", () => {
  const { controller } = fixture();
  controller.onEvent({ type: "tool-end", name: "readTextFile", durationMs: 1234, content: "first line\nsecret second line" });
  controller.onEvent({ type: "tool-end", name: "runCommand", durationMs: 99, content: "failed line\nmore", isError: true });
  assert.match(controller.getSnapshot().entries[0].text, /성공 · readTextFile · 1.23s · first line/);
  assert.match(controller.getSnapshot().entries[1].text, /실패 · runCommand · 0.10s · failed line/);
  assert.doesNotMatch(JSON.stringify(controller.getSnapshot().entries), /secret second line/);
  assert.equal(conversationLines(controller.getSnapshot().entries, 40).length, 2);
});

test("Esc는 턴 중단만 요청하고 완료 전 입력 잠금을 유지하며 이후 같은 세션을 이어간다", async (t) => {
  const pending = Promise.withResolvers<string>();
  let requests = 0;
  let turns = 0;
  const { controller } = fixture({ agent: {
    // 완료 시점은 테스트가 결정해 요청과 완료가 구분되는지 확인한다.
    interrupt() { requests++; return requests === 1; },
    async turn() { return ++turns === 1 ? pending.promise : "다음 답변"; },
    async compact() {},
  } });
  const view = render(h(TuiScreen, { controller, model: "test", onQuit() { assert.fail("Esc는 quit이 아니다"); } }));
  t.after(() => { view.unmount(); view.cleanup(); });
  const turn = controller.submit("작업"); await settle();
  view.stdin.write("\x1b"); await settle();
  assert.equal(requests, 1);
  assert.equal(controller.getSnapshot().busy, true);
  assert.match(controller.getSnapshot().status, /중단 요청됨/);
  controller.onEvent({ type: "turn-interrupted" }); pending.resolve(""); await turn;
  assert.equal(controller.getSnapshot().busy, false);
  await controller.submit("이어서");
  assert.equal(turns, 2);
  assert.equal(controller.getSnapshot().closed, false);
  assert.match(controller.getSnapshot().entries.at(-1)!.text, /다음 답변/);
});

// TUI 입력이 실제 관리 API로 전달되는지 검사할 메모리 목록이다.
function extensionFixture() {
  const items: Record<ExtensionKind, ExtensionItem[]> = {
    skills: [{ name: "sample", description: "스킬", enabled: true, active: true }],
    tools: Array.from({ length: 30 }, (_, index) => ({ name: `tool-${index}`, description: "툴 설명", enabled: true, active: true })),
    plugins: [{ name: "shell", description: "셸", enabled: true, active: true }],
    mcp: [{ name: "memory", description: "stdio", enabled: true, active: true }],
  };
  const actions: string[] = [];
  const extensions: ExtensionControls = {
    // 화면 스냅샷과 설정 객체를 분리한다.
    list(kind) { return structuredClone(items[kind]); },
    // 선택한 항목만 바뀌는지 기록한다.
    async toggle(kind, name) {
      actions.push(`${kind}:${name}`);
      const item = items[kind].find((entry) => entry.name === name)!;
      item.enabled = !item.enabled;
      item.active = item.enabled;
    },
    // 스킬 재탐색은 모델을 호출하지 않는다.
    async reloadSkills() { actions.push("reload"); },
  };
  return { extensions, actions };
}

test("확장 목록은 방향키·Space·Enter로 토글하고 Esc로 닫으며 모델을 호출하지 않는다", async (t) => {
  const { extensions, actions } = extensionFixture();
  const { controller, calls } = fixture({ extensions });
  const view = render(h(TuiScreen, { controller, model: "test", onQuit() {} }));
  t.after(() => { view.unmount(); view.cleanup(); });
  await controller.submit("/tools"); await settle();
  assert.match(view.lastFrame()!, /\[on\] tool-0/);
  view.stdin.write("\u001b[B"); await settle();
  view.stdin.write(" "); await settle();
  assert.match(view.lastFrame()!, /❯ \[off\] tool-1/);
  view.stdin.write("\r"); await settle();
  assert.match(view.lastFrame()!, /❯ \[on\] tool-1/);
  for (let i = 0; i < 26; i++) { view.stdin.write("\u001b[B"); await settle(); }
  assert.match(view.lastFrame()!, /tool-27/);
  view.stdin.write("\u001b"); await settle();
  assert.equal(controller.getSnapshot().extensionPicker, undefined);
  await controller.submit("/plugins"); await settle();
  assert.match(view.lastFrame()!, /끄면 실행 중인 셸 작업도 종료/);
  controller.dismissExtensionPicker();
  await controller.submit("/skills");
  await controller.toggleExtension("sample");
  controller.dismissExtensionPicker();
  await controller.submit("/mcp");
  await controller.toggleExtension("memory");
  controller.dismissExtensionPicker();
  await controller.submit("/reload-skills");
  assert.deepEqual(actions, ["tools:tool-1", "tools:tool-1", "skills:sample", "mcp:memory", "reload"]);
  assert.deepEqual(calls, []);
});

test("확장 변경 중 중복 토글과 모델 실행을 막고 연결 실패는 목록에 표시한다", async () => {
  const { extensions } = extensionFixture();
  const gate = Promise.withResolvers<void>();
  let changes = 0;
  extensions.toggle = async () => { changes++; await gate.promise; throw new Error("연결 실패"); };
  const { controller, calls } = fixture({ extensions });
  await controller.submit("/mcp");
  const pending = controller.toggleExtension("memory");
  await controller.toggleExtension("memory");
  await controller.submit("중복 요청");
  assert.equal(changes, 1);
  gate.resolve();
  await pending;
  assert.equal(controller.getSnapshot().extensionPicker?.error, "연결 실패");
  assert.equal(controller.getSnapshot().busy, false);
  assert.deepEqual(calls, []);
});

test("명령 후보는 접두사·이미지 지원 여부에 맞고 인자 입력 중에는 닫힌다", () => {
  assert.deepEqual(commandSuggestions("/", true).map((entry) => entry.name), ["/new", "/resume", "/compact", "/attach", "/skills", "/tools", "/plugins", "/mcp", "/reload-skills", "/reload-instructions", "/quit"]);
  assert.deepEqual(commandSuggestions("/r", true).map((entry) => entry.usage), ["/resume [session-id]", "/reload-skills", "/reload-instructions"]);
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
  assert.match(view.lastFrame()!, /사용법: \/resume \[session-id\]/);
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
    // 이 테스트는 입력 잠금만 검사한다.
    interrupt() { return false; },
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
  controller.onEvent({ type: "output-limit-recovery", attempt: 1, maxAttempts: 2 });
  await settle();
  assert.match(view.lastFrame()!, /작업을 나눠 다시 요청합니다/);
  assert.match(view.lastFrame()!, /출력 한도 복구 중/);
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

test("긴 한글·이모지 입력은 실제 너비로 줄바꿈하고 커서 주변 줄을 표시한다", () => {
  const value = "가나다".repeat(100) + "👨‍👩‍👧‍👦끝";
  const chars = inputCharacters(value);
  assert.deepEqual(chars.slice(-2), ["👨‍👩‍👧‍👦", "끝"]);
  const viewport = inputViewport(value, chars.length, 20, 5);
  assert.ok(viewport.lines.every((line) => stringWidth(line) <= 20));
  assert.ok(viewport.lines.at(-1)!.endsWith("끝"));
  assert.ok(viewport.lines.length <= 5);
  assert.deepEqual(layoutInput("가a\n나", 20), {
    lines: ["가a", "나"], positions: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 0, y: 1 }, { x: 2, y: 1 }],
  });
  assert.deepEqual(layoutInput("가나", 4).lines, ["가나", ""]);
  assert.deepEqual(layoutInput("abc한", 4).lines, ["abc", "한"]);
});

test("줄바꿈 붙여넣기는 자동 제출하지 않고 원문 그대로 전달하며 긴 입력 끝도 보인다", async (t) => {
  const { controller, calls } = fixture();
  const view = render(h(TuiScreen, { controller, model: "test", supportsImages: true, onQuit() {} }));
  t.after(() => { view.unmount(); view.cleanup(); });
  await settle();
  const value = "가".repeat(120) + "\n마지막";
  view.stdin.write(value); await settle();
  assert.equal(calls.length, 0);
  assert.match(view.lastFrame()!, /마지막/);
  assert.doesNotMatch(view.lastFrame()!, /↵/);
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
  assert.match(view.lastFrame()!, /이전 내용/);
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
    // 실패한 모의 턴은 이미 종료되었다.
    interrupt() { return false; },
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

test("Shift+Enter·Cmd+J·Ctrl+J는 줄바꿈하고 일반 Enter만 전송한다", async (t) => {
  const { controller, calls } = fixture();
  const view = render(h(TuiScreen, { controller, model: "test", onQuit() {} }));
  t.after(() => { view.unmount(); view.cleanup(); });
  await settle();
  for (const key of ["첫줄", "\x1b[13;2u", "둘째", "\x1b[106;9u", "셋째", "\n", "넷째"]) {
    view.stdin.write(key); await settle();
  }
  assert.equal(calls.length, 0);
  assert.match(view.lastFrame()!, /첫줄/);
  assert.match(view.lastFrame()!, /넷째/);
  view.stdin.write("\r"); await settle();
  assert.deepEqual(calls, ["첫줄\n둘째\n셋째\n넷째:0"]);
});

test("연속 한글 입력과 키 release는 중복·누락 없이 처리하고 Delete는 앞 문자를 지운다", async (t) => {
  const { controller, calls } = fixture();
  const view = render(h(TuiScreen, { controller, model: "test", onQuit() {} }));
  t.after(() => { view.unmount(); view.cleanup(); });
  await settle();
  for (const char of ["안", "녕", "하", "세", "요"]) view.stdin.write(char);
  await settle();
  view.stdin.write("\x1b[33;1:3u"); await settle();
  view.stdin.write("\x1b[D"); await settle();
  view.stdin.write("\x1b[3~"); await settle();
  view.stdin.write("\x7f"); await settle();
  view.stdin.write("\r"); await settle();
  assert.deepEqual(calls, ["안녕하:0"]);
});

test("실제 커서 좌표는 한글 너비·여러 줄·메뉴·resize와 함께 이동한다", async (t) => {
  // Ink 7.1.1의 CursorContext에서 공식 useCursor가 전달한 좌표를 관측한다. OS IME 테스트는 아니다.
  const { default: CursorContext } = await import(new URL("./components/CursorContext.js", import.meta.resolve("ink")).href);
  let position: { x: number; y: number } | undefined;
  const { controller } = fixture();
  const view = render(h(CursorContext.Provider, { value: {
    // 매 프레임의 실제 터미널 커서 목적지를 기록한다.
    setCursorPosition(next: typeof position) { position = next; },
  } }, h(TuiScreen, { controller, model: "test", onQuit() {} })));
  t.after(() => { view.unmount(); view.cleanup(); });
  await settle();
  assert.deepEqual(position, { x: 3, y: 19 });
  view.stdin.write("한글"); await settle();
  assert.deepEqual(position, { x: 7, y: 19 });
  view.stdin.write("\x1b[13;2u"); await settle();
  assert.deepEqual(position, { x: 3, y: 19 });
  view.stdin.write("\x1b[A"); await settle();
  assert.deepEqual(position, { x: 3, y: 18 });
  view.stdin.write("\x15"); await settle();
  view.stdin.write("/"); await settle();
  assert.deepEqual(position, { x: 4, y: 19 });
  Object.defineProperty(view.stdout, "rows", { configurable: true, value: 30 });
  view.stdout.emit("resize"); await settle();
  assert.deepEqual(position, { x: 4, y: 25 });
  // 포커스가 없는 선택 목록에서는 조합 커서를 숨긴다.
  await controller.submit("/resume"); await settle();
  assert.equal(position, undefined);
});

test("분할 bracketed paste의 줄바꿈·명령 문자는 입력에만 들어가며 두 번 삽입되지 않는다", async (t) => {
  const { controller, calls } = fixture();
  const view = render(h(TuiScreen, { controller, model: "test", onQuit() {} }));
  t.after(() => { view.unmount(); view.cleanup(); });
  await settle();
  for (const chunk of ["\x1b[200~", "한글\r\n", "/quit\n끝", "\x1b[201~"]) { view.stdin.write(chunk); await settle(); }
  assert.equal(calls.length, 0);
  view.stdin.write("\r"); await settle();
  assert.deepEqual(calls, ["한글\n/quit\n끝:0"]);
});

test("세션 목록은 현재 프로젝트만 최신 순으로 읽으며 JSONL·손상된 스냅샷을 구분한다", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-resume-list-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = createHarnessPaths(join(directory, "project"), directory);
  assert.deepEqual(await listSessions(paths), { sessions: [], skippedFiles: 0 });
  const first = createSession(paths.workspaceDirectory);
  first.messages.push({ role: "user", content: [{ type: "text", text: "첫 대화\n테트리스 만들기" }] });
  const second = createSession(paths.workspaceDirectory);
  second.messages.push({ role: "user", content: [{ type: "text", text: "두 번째 대화" }] });
  await saveSession(first, paths);
  await saveSession(second, paths);
  await utimes(join(paths.sessionDirectory, `${first.id}.json`), 1000, 1000);
  await utimes(join(paths.sessionDirectory, `${second.id}.json`), 2000, 2000);
  await writeFile(join(paths.sessionDirectory, "broken.json"), "{");
  await writeFile(join(paths.sessionDirectory, `${first.id}.jsonl`), "원문 기록");
  const otherPaths = createHarnessPaths(join(directory, "other"), directory);
  await saveSession(createSession(otherPaths.workspaceDirectory), otherPaths);
  const result = await listSessions(paths);
  assert.deepEqual(result.sessions.map((entry) => entry.id), [second.id, first.id]);
  assert.equal(result.sessions[1].title, "첫 대화 테트리스 만들기");
  assert.equal(result.skippedFiles, 1);
});

test("/resume 목록은 방향키 선택·Enter 재개·Esc 취소를 지원하고 모델을 호출하지 않는다", async (t) => {
  const { controller, calls } = fixture();
  await controller.start();
  const first = controller.getSnapshot().sessionId;
  await controller.submit("/new");
  const second = controller.getSnapshot().sessionId;
  const view = render(h(TuiScreen, { controller, model: "test", onQuit() {} }));
  t.after(() => { view.unmount(); view.cleanup(); });
  await settle();
  view.stdin.write("/resume"); await settle();
  view.stdin.write("\r"); await settle();
  view.stdin.write("\r"); await settle();
  assert.match(view.lastFrame()!, /세션 선택 · 현재 프로젝트/);
  view.stdin.write("\x1b[B"); await settle();
  assert.match(view.lastFrame()!, new RegExp(second));
  view.stdin.write("\x1b[A"); await settle();
  view.stdin.write("\r"); await settle();
  assert.equal(controller.getSnapshot().sessionId, first);
  assert.equal(controller.getSnapshot().resumePicker, undefined);
  await controller.submit("/resume"); await settle();
  view.stdin.write("\x1b"); await settle();
  assert.equal(controller.getSnapshot().resumePicker, undefined);
  assert.equal(controller.getSnapshot().sessionId, first);
  assert.deepEqual(calls, []);
});

test("빈 세션 목록·목록 오류·선택 후 파일 삭제에도 현재 세션을 보존한다", async (t) => {
  const { controller } = fixture();
  const current = controller.getSnapshot().sessionId;
  const view = render(h(TuiScreen, { controller, model: "test", onQuit() {} }));
  t.after(() => { view.unmount(); view.cleanup(); });
  await controller.submit("/resume"); await settle();
  assert.match(view.lastFrame()!, /저장된 세션이 없습니다/);
  view.stdin.write("\r"); await settle();
  assert.equal(controller.getSnapshot().sessionId, current);
  await controller.submit("/resume missing");
  assert.match(controller.getSnapshot().entries.at(-1)!.text, /없는 세션/);
  assert.equal(controller.getSnapshot().sessionId, current);
  const broken = fixture({ async listSessions() { throw new Error("목록 읽기 실패"); } });
  await broken.controller.submit("/resume");
  assert.equal(broken.controller.getSnapshot().resumePicker, undefined);
  assert.match(broken.controller.getSnapshot().entries.at(-1)!.text, /목록 읽기 실패/);
});

test("TTY 출력은 끝 개행을 유지해 실제 커서를 입력 줄에 놓고 다음 프레임도 같은 위치를 유지한다", async (t) => {
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 24 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  let output = "";
  stdout.on("data", (chunk) => { output += chunk.toString(); });
  const { controller } = fixture();
  const view = renderTerminal(h(TuiScreen, { controller, model: "test", onQuit() {} }), {
    stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
    interactive: true, alternateScreen: true, exitOnCtrlC: false, patchConsole: false,
  });
  t.after(() => { view.unmount(); view.cleanup(); stdin.destroy(); stdout.destroy(); });
  await settle();
  // 23개 표시 줄 뒤 개행으로 24번째 줄에 도착한 후 네 줄 올라가면 입력 줄(0-based 19)이다.
  assert.match(output, /\x1b\[\?1000h\x1b\[\?1006h/);
  assert.match(output, /Ctrl\+C 종료\n\x1b\[4A\x1b\[4G\x1b\[\?25h/);
  output = "";
  stdin.write("한글"); await settle();
  assert.match(output, /Ctrl\+C 종료\n\x1b\[4A\x1b\[8G\x1b\[\?25h/);
  output = "";
  stdin.write("\x1b[13;2u"); await settle();
  assert.match(output, /Ctrl\+C 종료\n\x1b\[4A\x1b\[4G\x1b\[\?25h/);
  view.unmount();
  assert.match(output, /\x1b\[\?1006l\x1b\[\?1000l/);
});
