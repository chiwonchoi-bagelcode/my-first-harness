import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldNow } from "node:timers/promises";
import { createTestRun } from "../game-testing/test-run.ts";
import { createGameTestingPlugin } from "../tools/game-testing.ts";
import { createHarnessPaths } from "../harness-paths.ts";
import { ToolManager } from "../tool-manager.ts";
import { solidPng } from "./image-fixture.ts";
import type { GameBridge, TabInfo } from "../game-testing/bridge.ts";
import type { ContentBlock } from "../llm-types.ts";

// 가짜 현실 시계다. sleep이 시간을 흘리고 실제 이벤트 루프에는 한 번만 양보한다.
function fakeClock() {
  let real = 0;
  return { now: () => real, async sleep(ms: number) { real += ms; await yieldNow(); }, advance(ms: number) { real += ms; } };
}

// 컨트롤러 대신 호출 순서를 기록하고 runFor 겹침·소요 시간·실패를 흉내 내는 브리지다.
function fakeBridge(clock: ReturnType<typeof fakeClock>, options: { tabs?: TabInfo[]; runForRealMs?: () => number; failAtRunFor?: number;
  screenshotColor?: (state: { runFors: number; shots: number }) => [number, number, number] } = {}) {
  const calls: string[] = [];
  let busy = false;
  let overlaps = 0;
  let runFors = 0;
  let shots = 0;
  const bridge: GameBridge = {
    async tabs() { return options.tabs ?? []; },
    async install(tab, time) { calls.push(`install:${tab}`); return { url: options.tabs?.[tab]?.url ?? "", pausedAt: time + 200, freshInstall: true }; },
    async runFor(_tab, ms) {
      if (busy) overlaps++;
      busy = true;
      runFors++;
      try {
        if (options.failAtRunFor && runFors >= options.failAtRunFor) throw new Error("controller gone");
        calls.push(`runFor:${ms}`);
        clock.advance(options.runForRealMs?.() ?? 0);
        await yieldNow();
      } finally { busy = false; }
    },
    async resume() { calls.push("resume"); },
    async keyDown(_tab, key) { calls.push(`down:${key}`); },
    async keyUp(_tab, key) { calls.push(`up:${key}`); },
    async screenshot() { shots++; calls.push("shot"); return solidPng(options.screenshotColor?.({ runFors, shots }) ?? [255, 0, 0]); },
  };
  return { bridge, calls, overlaps: () => overlaps, steps: () => calls.filter((call) => call.startsWith("runFor:")).map((call) => Number(call.slice(7))) };
}

// 스케줄러가 몇 번 양보하도록 실제 이벤트 루프를 돌린다.
async function turns(count: number) { for (let i = 0; i < count; i++) await yieldNow(); }

test("스케줄러는 현실 경과 × rate만큼 5~50ms 단위로 겹치지 않게 진행하고 pause 뒤 resume에서 따라가지 않는다", async (t) => {
  const clock = fakeClock();
  const { bridge, overlaps, steps } = fakeBridge(clock);
  const run = createTestRun({ bridge, tab: 0, rate: 0.1, now: clock.now, sleep: clock.sleep });
  t.after(() => run.stop().catch(() => {}));
  assert.equal(run.status().mode, "paused");
  run.resume();
  run.resume();
  await turns(40);
  await run.pause();
  const paused = run.status();
  assert.equal(paused.mode, "paused");
  assert.ok(paused.gameTimeMs >= 50, `진행량 ${paused.gameTimeMs}`);
  assert.ok(Math.abs(paused.gameTimeMs - clock.now() * 0.1) <= 5, `게임 ${paused.gameTimeMs} vs 현실×rate ${clock.now() * 0.1}`);
  assert.ok(steps().every((step) => step >= 5 && step <= 50));
  assert.equal(overlaps(), 0);
  assert.ok(paused.achievedRate !== null && Math.abs(paused.achievedRate - 0.1) < 0.01, `달성 배속 ${paused.achievedRate}`);
  // 정지한 동안 흐른 현실 5초는 재개 뒤 따라가지 않는다.
  clock.advance(5_000);
  run.resume();
  await turns(4);
  await run.pause();
  assert.ok(run.status().gameTimeMs - paused.gameTimeMs <= 50, `재개 직후 진행량 ${run.status().gameTimeMs - paused.gameTimeMs}`);
  assert.equal(run.status().droppedMs, 0);
});

test("runFor 한 번이 오래 걸린 정체 뒤에는 최대 50ms만 진행하고 초과분은 버린 양으로 보고한다", async (t) => {
  const clock = fakeClock();
  let slow = true;
  const { bridge, steps } = fakeBridge(clock, { runForRealMs: () => { if (slow) { slow = false; return 3_000; } return 0; } });
  const run = createTestRun({ bridge, tab: 0, rate: 0.1, now: clock.now, sleep: clock.sleep });
  t.after(() => run.stop().catch(() => {}));
  run.resume();
  await turns(6);
  await run.pause();
  assert.equal(Math.max(...steps()), 50);
  assert.equal(run.status().droppedMs, 250);
});

test("act는 즉시 누르고 게임 시간이 holdGameMs 흐른 뒤 스케줄러가 놓으며 paused·중복 키는 거부한다", async (t) => {
  const clock = fakeClock();
  const { bridge, calls } = fakeBridge(clock);
  const run = createTestRun({ bridge, tab: 0, rate: 0.1, now: clock.now, sleep: clock.sleep });
  t.after(() => run.stop().catch(() => {}));
  await assert.rejects(run.act([{ keys: ["ArrowLeft"], holdGameMs: 100 }]), /running 상태/);
  run.resume();
  const acting = run.act([{ keys: ["ArrowLeft"], holdGameMs: 100 }]);
  await turns(1);
  assert.ok(calls.includes("down:ArrowLeft"));
  await assert.rejects(run.act([{ keys: ["ArrowLeft"], holdGameMs: 50 }]), /이미 눌린/);
  const result = await acting;
  assert.ok(result.releasedAtGameMs - result.pressedAtGameMs >= 100 && result.releasedAtGameMs - result.pressedAtGameMs <= 105, `유지 ${result.releasedAtGameMs - result.pressedAtGameMs}`);
  assert.ok(result.realMs >= 1_000 && result.realMs <= 1_100, `현실 ${result.realMs}`);
  const down = calls.indexOf("down:ArrowLeft");
  const up = calls.indexOf("up:ArrowLeft");
  assert.ok(down < up);
  const advancedBetween = calls.slice(down, up).filter((call) => call.startsWith("runFor:")).reduce((sum, call) => sum + Number(call.slice(7)), 0);
  assert.ok(advancedBetween >= 100);
  await run.pause();
  assert.deepEqual(run.status().heldKeys, []);
});

test("stop은 진행 정지 → 누른 키 해제 → 시계 재개 순서로 되돌리고 두 번째 stop은 반복하지 않는다", async (t) => {
  const clock = fakeClock();
  const { bridge, calls } = fakeBridge(clock);
  const run = createTestRun({ bridge, tab: 0, rate: 0.1, now: clock.now, sleep: clock.sleep });
  t.after(() => run.stop().catch(() => {}));
  run.resume();
  const acting = run.act([{ keys: ["ArrowUp", "z"], holdGameMs: 5_000 }]);
  await turns(2);
  const summary = await run.stop();
  await assert.rejects(acting, /종료/);
  assert.deepEqual(summary.releasedKeys, ["ArrowUp", "z"]);
  assert.equal(summary.clockResumed, true);
  assert.equal(summary.mode, "stopped");
  const tail = calls.slice(calls.lastIndexOf("down:z") + 1).filter((call) => !call.startsWith("runFor:"));
  assert.deepEqual(tail, ["up:ArrowUp", "up:z", "resume"]);
  const again = await run.stop();
  assert.equal(again.alreadyStopped, true);
  assert.equal(calls.filter((call) => call === "resume").length, 1);
  assert.throws(() => run.resume(), /stopped/);
});

test("컨트롤러 오류가 나면 lost로 표시하고 기다리는 키 해제를 실패시키되 stop은 재개를 시도한다", async (t) => {
  const clock = fakeClock();
  const { bridge } = fakeBridge(clock, { failAtRunFor: 3 });
  const run = createTestRun({ bridge, tab: 0, rate: 0.1, now: clock.now, sleep: clock.sleep });
  t.after(() => run.stop().catch(() => {}));
  run.resume();
  // 거부는 스케줄러가 실패하는 순간 일어나므로 처리되지 않은 거부가 되지 않게 먼저 받아 둔다.
  const acting = run.act([{ keys: ["ArrowLeft"], holdGameMs: 1_000 }]).then(() => undefined, (error: Error) => error);
  await turns(12);
  assert.equal(run.status().mode, "lost");
  assert.match(run.status().error ?? "", /controller gone/);
  assert.match((await acting)?.message ?? "", /컨트롤러 오류/);
  await assert.rejects(run.observe(), /lost/);
  const summary = await run.stop();
  assert.equal(summary.clockResumed, true);
  assert.equal(summary.mode, "stopped");
});

test("게임 테스트 툴은 열린 탭 확인·단일 테스트·인자 검증·이미지 관찰·정리를 수행한다", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-game-testing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = createHarnessPaths(directory, join(directory, "home"));
  const tabs: TabInfo[] = [];
  const { bridge, calls } = fakeBridge(fakeClock(), { tabs });
  const plugin = createGameTestingPlugin(paths, { bridge });
  const manager = new ToolManager();
  const cleanup = await plugin.setup({ register: (tool) => manager.register(tool, { owner: "plugins:game-testing" }) });
  assert.deepEqual(manager.getDefinitions().map((tool) => tool.name).sort(),
    ["gameTestAct", "gameTestClock", "gameTestObserve", "gameTestStart", "gameTestStop"]);
  assert.match(plugin.skills![0], /game-testing[/\\]skills[/\\]game-testing[/\\]SKILL\.md$/);
  const url = "http://127.0.0.1:1/game";
  // 탭이 없으면 시작하지 않고 브라우저를 먼저 열도록 안내한다.
  let result = await manager.execute("gameTestStart", JSON.stringify({ url, rate: 0.1 }));
  assert.equal(result.isError, true);
  assert.match(String(result.content), /browser_navigate/);
  tabs.push({ tab: 0, url: `${url}#closed`, closed: true }, { tab: 1, url, closed: false });
  result = await manager.execute("gameTestStart", JSON.stringify({ url, rate: 0 }));
  assert.match(String(result.content), /툴 인자 오류/);
  result = await manager.execute("gameTestStart", JSON.stringify({ url, rate: 0.1 }));
  assert.equal(result.isError, undefined, String(result.content));
  const started = JSON.parse(String(result.content));
  assert.match(started.testId, /^gt-/);
  assert.equal(started.tab.index, 1);
  assert.equal(calls[0], "install:1");
  // 동시에 하나만 진행하며 다른 testId는 거부한다.
  result = await manager.execute("gameTestStart", JSON.stringify({ url, rate: 0.1 }));
  assert.match(String(result.content), /gameTestStop/);
  result = await manager.execute("gameTestClock", JSON.stringify({ testId: "gt-other", action: "status" }));
  assert.match(String(result.content), /testId가 다릅니다/);
  // 관찰은 텍스트 정보와 이미지 블록을 함께 돌려준다.
  result = await manager.execute("gameTestObserve", JSON.stringify({ testId: started.testId }));
  assert.ok(Array.isArray(result.content));
  const [info, image] = result.content as ContentBlock[];
  assert.equal(info.type, "text");
  assert.match(JSON.parse((info as { text: string }).text).observationId, /^ob-/);
  assert.equal(image.type, "image");
  // 정지·진행·재개와 상태 조회.
  let status = JSON.parse(String((await manager.execute("gameTestClock", JSON.stringify({ testId: started.testId, action: "pause" }))).content));
  assert.equal(status.mode, "paused");
  result = await manager.execute("gameTestClock", JSON.stringify({ testId: started.testId, action: "advance" }));
  assert.match(String(result.content), /ms가 필요/);
  const before = status.gameTimeMs;
  status = JSON.parse(String((await manager.execute("gameTestClock", JSON.stringify({ testId: started.testId, action: "advance", ms: 30 }))).content));
  assert.equal(status.gameTimeMs, before + 30);
  status = JSON.parse(String((await manager.execute("gameTestClock", JSON.stringify({ testId: started.testId, action: "resume" }))).content));
  assert.equal(status.mode, "running");
  result = await manager.execute("gameTestAct", JSON.stringify({ testId: started.testId, inputs: [{ keys: ["ArrowLeft"], holdGameMs: 0 }] }));
  assert.match(String(result.content), /툴 인자 오류/);
  result = await manager.execute("gameTestAct", JSON.stringify({ testId: started.testId, keys: ["ArrowLeft"], holdGameMs: 1 }));
  assert.match(String(result.content), /툴 인자 오류/);
  // 플러그인 정리는 진행 중 테스트를 멈추고 시계를 재개한다.
  if (typeof cleanup === "function") await cleanup();
  assert.equal(calls.at(-1), "resume");
  result = await manager.execute("gameTestStop", JSON.stringify({ testId: started.testId }));
  assert.match(String(result.content), /진행 중인 게임 테스트가 없습니다/);
});

test("check는 정지 중 두 화면이 같고 진행 뒤 달라질 때만 controllable이며 확인 전 상태로 돌려놓는다", async (t) => {
  const clock = fakeClock();
  // 화면은 게임 시간이 진행된 횟수에만 따라 바뀐다: 시계로 제어되는 게임.
  const controllable = fakeBridge(clock, { screenshotColor: ({ runFors }) => [runFors % 256, 0, 0] });
  const run = createTestRun({ bridge: controllable.bridge, tab: 0, rate: 0.1, now: clock.now, sleep: clock.sleep });
  t.after(() => run.stop().catch(() => {}));
  run.resume();
  await turns(4);
  const result = await run.check();
  assert.equal(result.verdict, "controllable");
  assert.equal(result.frozenWhilePaused, true);
  assert.equal(result.changesOnAdvance, true);
  assert.equal(result.advancedGameMs, 500);
  assert.equal(run.status().mode, "running", "진행 중이던 테스트는 확인 뒤 다시 진행해야 합니다.");
  assert.ok(controllable.calls.includes("runFor:500"));
  await run.pause();
  assert.equal((await run.check()).verdict, "controllable");
  assert.equal(run.status().mode, "paused", "정지 중이던 테스트는 확인 뒤에도 정지 상태여야 합니다.");
  // 화면이 캡처마다 바뀐다: 시계와 무관하게 움직이는 요소.
  const moving = fakeBridge(clock, { screenshotColor: ({ shots }) => [shots % 256, 0, 0] });
  const movingRun = createTestRun({ bridge: moving.bridge, tab: 0, rate: 0.1, now: clock.now, sleep: clock.sleep });
  t.after(() => movingRun.stop().catch(() => {}));
  assert.equal((await movingRun.check()).verdict, "not-frozen");
  // 화면이 전혀 바뀌지 않는다: 시작 전 메뉴 또는 시계로 제어되지 않는 게임.
  const still = fakeBridge(clock);
  const stillRun = createTestRun({ bridge: still.bridge, tab: 0, rate: 0.1, now: clock.now, sleep: clock.sleep });
  t.after(() => stillRun.stop().catch(() => {}));
  const stillResult = await stillRun.check();
  assert.equal(stillResult.verdict, "no-change-on-advance");
  assert.equal(stillResult.frozenWhilePaused, true);
});

test("setRate는 게임 상태를 유지한 채 배속을 바꾸고 따라가기 없이 새 배속으로 진행한다", async (t) => {
  const clock = fakeClock();
  const { bridge, steps } = fakeBridge(clock);
  const run = createTestRun({ bridge, tab: 0, rate: 0.1, now: clock.now, sleep: clock.sleep });
  t.after(() => run.stop().catch(() => {}));
  run.resume();
  await turns(20);
  const before = run.status();
  const changed = await run.setRate(0.05);
  assert.equal(changed.rate, 0.05);
  assert.equal(changed.mode, "running");
  assert.equal(changed.gameTimeMs, before.gameTimeMs, "배속 변경은 게임 시간을 바꾸지 않습니다.");
  const realAtChange = clock.now();
  await turns(20);
  await run.pause();
  const after = run.status();
  const realElapsed = clock.now() - realAtChange;
  assert.ok(Math.abs((after.gameTimeMs - before.gameTimeMs) - realElapsed * 0.05) <= 5, `새 배속 진행량 ${after.gameTimeMs - before.gameTimeMs} vs ${realElapsed * 0.05}`);
  assert.ok(after.achievedRate !== null && Math.abs(after.achievedRate - 0.05) < 0.01, `달성 배속은 새 구간만 반영: ${after.achievedRate}`);
  assert.ok(steps().every((step) => step <= 50));
  await assert.rejects(run.setRate(0), /rate/);
  await run.stop();
  await assert.rejects(run.setRate(0.2), /stopped/);
});

test("observationId를 넘긴 act는 캡처 완료 → keydown 전송까지의 현실·게임 지연을 계산하고 모르는 ID는 거부한다", async (t) => {
  const clock = fakeClock();
  const { bridge, calls } = fakeBridge(clock);
  const run = createTestRun({ bridge, tab: 0, rate: 0.1, now: clock.now, sleep: clock.sleep });
  t.after(() => run.stop());
  run.resume();
  await turns(4);
  // 관찰 중에는 루프를 멈춰 가짜 시간이 디코드 동안 흐르지 않게 하고, 모델의 생각 시간 750ms를 명시적으로 흘린다.
  await run.pause();
  const observed = await run.observe();
  assert.match(observed.observationId, /^ob-/);
  assert.equal(observed.imageHash.length, 16);
  clock.advance(750);
  run.resume();
  const result = await run.act([{ keys: ["ArrowLeft"], holdGameMs: 5 }], undefined, observed.observationId);
  assert.equal(result.observationId, observed.observationId);
  assert.ok(result.observationToInputMs! >= 750 && result.observationToInputMs! <= 850, `현실 지연 ${result.observationToInputMs}`);
  assert.equal(result.observationToInputGameMs, result.pressedAtGameMs - observed.gameTimeMs);
  // 정지 중 흐른 현실 시간은 게임 시간이 아니므로 게임 지연은 재개 뒤 한 step 이내다.
  assert.ok(result.observationToInputGameMs! >= 0 && result.observationToInputGameMs! <= 10, `게임 지연 ${result.observationToInputGameMs}`);
  const downs = calls.filter((call) => call === "down:ArrowLeft").length;
  await assert.rejects(run.act([{ keys: ["ArrowRight"], holdGameMs: 5 }], undefined, "ob-unknown"), /알 수 없는 observationId/);
  assert.equal(calls.filter((call) => call.startsWith("down:")).length, downs, "모르는 ID면 키를 누르지 않아야 합니다.");
  const plain = await run.act([{ keys: ["ArrowRight"], holdGameMs: 5 }]);
  assert.equal("observationToInputMs" in plain, false);
});

test("gameTestClock의 check·rate와 gameTestAct의 지연 필드가 ToolManager를 통해 전달된다", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-game-testing-clock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = createHarnessPaths(directory, join(directory, "home"));
  const url = "http://127.0.0.1:1/game";
  const { bridge } = fakeBridge(fakeClock(), { tabs: [{ tab: 0, url, closed: false }], screenshotColor: ({ runFors }) => [runFors % 256, 0, 0] });
  const plugin = createGameTestingPlugin(paths, { bridge });
  const manager = new ToolManager();
  const cleanup = await plugin.setup({ register: (tool) => manager.register(tool, { owner: "plugins:game-testing" }) });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await manager.execute(name, JSON.stringify(args));
    assert.equal(result.isError, undefined, `${name}: ${result.content}`);
    return result.content;
  };
  const started = JSON.parse(String(await call("gameTestStart", { url, rate: 0.1 })));
  const checked = JSON.parse(String(await call("gameTestClock", { testId: started.testId, action: "check" })));
  assert.equal(checked.verdict, "controllable");
  assert.equal(checked.mode, "running");
  let result = await manager.execute("gameTestClock", JSON.stringify({ testId: started.testId, action: "rate" }));
  assert.match(String(result.content), /rate 값이 필요/);
  result = await manager.execute("gameTestClock", JSON.stringify({ testId: started.testId, action: "rate", rate: 2 }));
  assert.match(String(result.content), /툴 인자 오류/);
  const rated = JSON.parse(String(await call("gameTestClock", { testId: started.testId, action: "rate", rate: 0.048 })));
  assert.equal(rated.rate, 0.048);
  const observed = await call("gameTestObserve", { testId: started.testId }) as ContentBlock[];
  const info = JSON.parse((observed[0] as { text: string }).text);
  assert.equal(info.imageHash.length, 16);
  const acted = JSON.parse(String(await call("gameTestAct", { testId: started.testId, inputs: [{ keys: ["ArrowLeft"], holdGameMs: 1 }], observationId: info.observationId })));
  assert.equal(acted.observationId, info.observationId);
  assert.equal(typeof acted.observationToInputMs, "number");
  assert.equal(typeof acted.observationToInputGameMs, "number");
  result = await manager.execute("gameTestAct", JSON.stringify({ testId: started.testId, inputs: [{ keys: ["ArrowLeft"], holdGameMs: 1 }], observationId: "ob-nope" }));
  assert.match(String(result.content), /알 수 없는 observationId/);
  if (typeof cleanup === "function") await cleanup();
});

test("act는 입력 시퀀스를 게임 시간 순서로 실행하고 간격을 지키며 같은 입력 안의 중복 키는 거부한다", async (t) => {
  const clock = fakeClock();
  const { bridge, calls } = fakeBridge(clock);
  const run = createTestRun({ bridge, tab: 0, rate: 0.1, now: clock.now, sleep: clock.sleep });
  t.after(() => run.stop().catch(() => {}));
  run.resume();
  await turns(4);
  await assert.rejects(run.act([{ keys: ["a", "a"], holdGameMs: 1 }]), /같은 키/);
  await assert.rejects(run.act([]), /비어 있습니다/);
  const result = await run.act([
    { keys: ["ArrowLeft"], holdGameMs: 10 },
    { keys: ["ArrowLeft"], holdGameMs: 10, gapGameMs: 30 },
    { keys: ["ArrowUp", "z"], holdGameMs: 5 },
  ]);
  assert.equal(result.inputs.length, 3);
  const [first, second, third] = result.inputs;
  assert.ok(second.pressedAtGameMs >= first.releasedAtGameMs, "두 번째 입력은 첫 입력이 놓인 뒤에 누른다.");
  assert.ok(third.pressedAtGameMs >= second.releasedAtGameMs + 30, `간격 30ms를 지켜야 합니다: ${third.pressedAtGameMs - second.releasedAtGameMs}`);
  assert.ok(third.pressedAtGameMs <= second.releasedAtGameMs + 30 + 5, "간격은 한 step 이내에서 맞춘다.");
  assert.equal(result.pressedAtGameMs, first.pressedAtGameMs);
  assert.equal(result.releasedAtGameMs, third.releasedAtGameMs);
  const keyEvents = calls.filter((call) => call.startsWith("down:") || call.startsWith("up:"));
  assert.deepEqual(keyEvents, ["down:ArrowLeft", "up:ArrowLeft", "down:ArrowLeft", "up:ArrowLeft", "down:ArrowUp", "down:z", "up:ArrowUp", "up:z"]);
  assert.ok(result.realMs >= (10 + 10 + 30 + 5) / 0.1 - 100, `현실 소요 ${result.realMs}`);
  assert.deepEqual(run.status().heldKeys, []);
});
