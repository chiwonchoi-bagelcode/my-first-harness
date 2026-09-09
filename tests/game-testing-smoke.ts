import "dotenv/config";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHarnessPaths } from "../harness-paths.ts";
import { createMcpServerConfigs } from "../mcp-servers.ts";
import { connectMcpServers, closeMcpServers } from "../mcp-client.ts";
import { ToolManager } from "../tool-manager.ts";
import { imageFromBytes } from "../image-content.ts";
import { createGameTestingPlugin } from "../tools/game-testing.ts";
import { createBuiltinPlugins } from "../builtin-plugins.ts";
import { createExtensionRuntime } from "../extension-runtime.ts";
import { SkillManager } from "../skill-manager.ts";
import { ExecutionHistory } from "../execution-history.ts";
import { createModelAdapter } from "../model-config.ts";
import { createAgent } from "../agent.ts";
import { createSession } from "../session.ts";
import type { ContentBlock } from "../llm-types.ts";

// game-testing 검증기. 모델은 호출하지 않으며 API 비용도 없다. headless 브라우저와 MCP 프로세스만 사용한다.
// (A) 단계 0: 계획서의 1안(run_code_unsafe → page.clock)이 MCP settle 대기와 교착하는 것을 재현한다.
// (B) 단계 0: 계획서 7절의 대안(--init-page로 MCP 프로세스 안에 컨트롤러)으로 여섯 항목을 실측한다.
// (C) 단계 1: 실제 플러그인 툴 5개 → 브리지 → 실제 컨트롤러 경로를 ToolManager를 통해 검증한다.
// (D) 단계 1-c: --model farm|luna|haiku를 주면 실제 모델이 스킬을 읽고 관찰→입력 루프를 수행하는지 확인한다. 유료.

// 브라우저가 실행하는 검증용 게임 페이지다. setInterval·rAF·performance.now·키 입력을 모두 사용한다.
const GAME_PAGE = `<!doctype html><html lang="en"><title>Game clock test</title>
<canvas id="c" width="400" height="400"></canvas><p id="hud"></p><script>
const ctx = document.getElementById('c').getContext('2d');
const state = { ticks: 0, frames: 0, x: 200, y: 0, keys: {} };
window.__state = state;
// HUD는 타이머 안에서 바로 갱신해 정지 시점의 상태를 rAF 지연 없이 스냅샷으로 읽을 수 있게 한다.
function hud() { document.getElementById('hud').textContent = 'ticks ' + state.ticks + ' · x ' + state.x; }
setInterval(() => { state.ticks++; state.y = (state.y + 10) % 400; hud(); }, 100);
function render() {
  state.frames++;
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 400, 400);
  ctx.fillStyle = 'rgb(200,30,30)'; ctx.fillRect(state.x, state.y, 20, 20);
  requestAnimationFrame(render);
}
requestAnimationFrame(render);
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  state.keys[e.key] = { downAt: performance.now(), upAt: null };
  if (e.key === 'ArrowLeft') state.x -= 20;
  if (e.key === 'ArrowRight') state.x += 20;
  hud();
});
addEventListener('keyup', (e) => { const k = state.keys[e.key]; if (k) k.upAt = performance.now(); });
</script></html>`;

// 같은 브라우저 컨텍스트의 다른 탭이 시계 정지에 영향을 받는지 보기 위한 실시간 타이머 페이지다.
const DECOY_PAGE = `<!doctype html><html lang="en"><title>Decoy tab</title><p id="hud"></p><script>
window.__state = { ticks: 0 };
setInterval(() => { window.__state.ticks++; document.getElementById('hud').textContent = 'ticks ' + window.__state.ticks; }, 50);
</script></html>`;

const CONTROLLER = fileURLToPath(new URL("./game-testing-init-page.cjs", import.meta.url));
const T0 = Date.UTC(2026, 0, 1);

// MCP 연결 하나를 열고 직접 툴 호출·종료 함수를 반환한다. 추가 인자와 환경변수로 실행 방식을 바꾼다.
async function connect(paths: ReturnType<typeof createHarnessPaths>, options: { args?: string[]; env?: Record<string, string> } = {}) {
  const manager = new ToolManager();
  const configs = (await createMcpServerConfigs(paths)).filter((config) => config.name === "playwright");
  assert.equal(configs.length, 1, "Playwright MCP 패키지와 등록 설정이 필요합니다.");
  const config = configs[0];
  assert.equal(config.transport, "stdio");
  if (config.transport === "stdio") {
    config.args.push("--headless", ...(options.args ?? []));
    if (options.env) config.env = { ...(process.env as Record<string, string>), ...options.env };
  }
  const clients = await connectMcpServers(manager, configs);
  assert.equal(clients.length, 1, "Playwright MCP 연결 실패");
  const client = clients[0];

  // 툴 호출의 왕복 시간을 재고, 타임아웃은 예외 대신 ok=false로 돌려 교착 재현에 쓴다.
  async function call(name: string, args: Record<string, unknown>, timeout = 15_000) {
    const started = performance.now();
    try {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout }) as CallToolResult;
      const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      return { ok: !result.isError, ms: Math.round(performance.now() - started), text, content: result.content };
    } catch (error) {
      return { ok: false, ms: Math.round(performance.now() - started), text: error instanceof Error ? error.message : String(error), content: [] as CallToolResult["content"] };
    }
  }
  // 모델이 실제로 쓰는 경로: ToolManager의 인자 검증·MCP 호출·이미지 변환을 그대로 거친다.
  async function tool(name: string, args: Record<string, unknown>) {
    const started = performance.now();
    const result = await manager.execute(`mcp__playwright__${name}`, JSON.stringify(args));
    assert.ok(!result.isError, String(result.content));
    return { content: result.content, ms: Math.round(performance.now() - started) };
  }
  return { call, tool, async close() {
    await call("browser_close", {}, 5_000);
    await closeMcpServers(clients);
  } };
}

// (A) run_code로 시계를 정지하면 그 호출 자체가 settle 대기에 걸리고, 다음 호출의 runFor·resume이 앞 호출을 풀어준다.
async function proveRunCodeDeadlock(paths: ReturnType<typeof createHarnessPaths>, url: string) {
  const link = await connect(paths);
  try {
    // 호출 결과 텍스트의 Result 절에서 반환값을 읽는다.
    const resultOf = (text: string) => /### Result\n([\s\S]*?)(?:\n### |$)/.exec(text)?.[1]?.trim();
    const install = await link.call("browser_run_code_unsafe", { code: `async (page) => {
  await page.clock.install({ time: ${T0} }); await page.goto(${JSON.stringify(url)}); return "installed"; }` });
    assert.ok(install.ok && resultOf(install.text) === '"installed"', install.text);
    // A는 기다리지 않고, 1.5초 뒤 B(runFor 600), 다시 1.5초 뒤 C(resume)를 동시에 보낸다.
    const a = link.call("browser_run_code_unsafe", { code: `async (page) => { await page.clock.pauseAt(${T0 + 5_000}); return "paused"; }` }, 20_000);
    await sleep(1_500);
    const b = link.call("browser_run_code_unsafe", { code: `async (page) => { await page.clock.runFor(600); return "advanced"; }` }, 20_000);
    await sleep(1_500);
    const c = link.call("browser_run_code_unsafe", { code: `async (page) => { await page.clock.resume(); return "resumed"; }` }, 20_000);
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    assert.ok(ra.ok && rb.ok && rc.ok, [ra.text, rb.text, rc.text].join("\n"));
    assert.ok(ra.ms >= 1_400, `A(pauseAt)는 B가 시간을 진행시킬 때까지 멈춰 있어야 합니다: ${ra.ms}ms`);
    assert.ok(rb.ms >= 1_400, `B(runFor)는 C가 시계를 재개할 때까지 멈춰 있어야 합니다: ${rb.ms}ms`);
    assert.ok(rc.ms < 1_500, `C(resume)는 settle 500ms만 기다려야 합니다: ${rc.ms}ms`);
    console.log(`[PASS] A. run_code 교착 재현: install ${install.ms}ms · pauseAt ${ra.ms}ms(B가 풀어줌) · runFor ${rb.ms}ms(C가 풀어줌) · resume ${rc.ms}ms`);
    return { installMs: install.ms, pauseAtMs: ra.ms, runForMs: rb.ms, resumeMs: rc.ms };
  } finally { await link.close(); }
}

// (B) init-page 컨트롤러 경로로 계획서 11절 단계 0의 여섯 항목을 실측한다.
async function verifyInitPageController(paths: ReturnType<typeof createHarnessPaths>, gameUrl: string, decoyUrl: string, portFile: string) {
  const link = await connect(paths, { args: ["--init-page", CONTROLLER], env: { GAME_CTRL_PORT_FILE: portFile } });
  const measurements: Record<string, unknown> = {};
  try {
    let port = 0;
    // 컨트롤러 HTTP 명령을 보내고 하네스 쪽 왕복 시간을 함께 기록한다.
    async function ctrl(path: string, params: Record<string, string | number> = {}) {
      const started = performance.now();
      const target = new URL(`http://127.0.0.1:${port}${path}`);
      for (const [key, value] of Object.entries(params)) target.searchParams.set(key, String(value));
      const body = await (await fetch(target)).json() as any;
      if (body.error) throw new Error(`컨트롤러 ${path}: ${body.error}`);
      return { ...body, ms: Math.round((performance.now() - started) * 10) / 10 };
    }

    // 1. MCP로 탭을 열면 init-page가 호출되어 컨트롤러가 뜬다. Clock 설치 → reload → 정지.
    const navigate = await link.tool("browser_navigate", { url: gameUrl });
    port = Number(await readFile(portFile, "utf8"));
    const tabs = await ctrl("/tabs");
    assert.equal(tabs.tabs.length, 1); assert.equal(tabs.tabs[0].url, gameUrl);
    const installed = await ctrl("/install", { i: 0, time: T0, pauseAfter: 5_000 });
    console.log(`[PASS] 1. MCP navigate ${navigate.ms}ms → init-page 컨트롤러 기동 → install+reload+pauseAt ${installed.ms}ms`);

    // 2. 정지 중 상태 유지, runFor 때만 변화.
    const frozenA = await ctrl("/state"); await sleep(700); const frozenB = await ctrl("/state");
    assert.equal(frozenB.state.ticks, frozenA.state.ticks, "정지 중 setInterval이 진행되었습니다.");
    assert.equal(frozenB.state.frames, frozenA.state.frames, "정지 중 requestAnimationFrame이 진행되었습니다.");
    assert.equal(frozenB.now, frozenA.now, "정지 중 Date.now가 진행되었습니다.");
    const runFor = await ctrl("/runFor", { ms: 1_000 }); const advanced = await ctrl("/state");
    assert.equal(advanced.now - frozenB.now, 1_000); assert.equal(advanced.state.ticks - frozenB.state.ticks, 10);
    assert.ok(advanced.state.frames - frozenB.state.frames >= 30, `rAF 프레임 진행: ${advanced.state.frames - frozenB.state.frames}`);
    console.log(`[PASS] 2. 700ms 현실 대기 중 ticks/frames/Date 불변 → runFor(1000) ${runFor.ms}ms: ticks +10, frames +${advanced.state.frames - frozenB.state.frames}, Date +1000`);

    // 3. 키 down → 게임시간 250ms → up, canvas 렌더, 정지 중 MCP 스크린샷·스냅샷, 컨트롤러 스크린샷.
    const keyStart = performance.now();
    await ctrl("/keydown", { key: "ArrowLeft" }); await ctrl("/runFor", { ms: 250 }); await ctrl("/keyup", { key: "ArrowLeft" });
    const keyRealMs = Math.round(performance.now() - keyStart);
    const held = await ctrl("/state"); const key = held.state.keys.ArrowLeft;
    assert.ok(key && key.upAt !== null && Math.abs(key.upAt - key.downAt - 250) <= 1, `키 유지 게임시간: ${key && key.upAt - key.downAt}`);
    assert.equal(held.state.x, advanced.state.x - 20);
    const mcpShot = await link.tool("browser_take_screenshot", { type: "png", scale: "css" });
    assert.ok(Array.isArray(mcpShot.content) && mcpShot.content.some((block) => block.type === "image" && block.width > 0), "MCP 스크린샷 → 이미지 블록");
    const mcpSnapshot = await link.tool("browser_snapshot", {});
    const shot = await ctrl("/screenshot"); const image = await imageFromBytes(Buffer.from(shot.base64, "base64"));
    assert.equal(image.mediaType, "image/png");
    measurements.keyHold = { gameMs: key.upAt - key.downAt, realMs: keyRealMs };
    console.log(`[PASS] 3. 키 유지 게임시간 ${key.upAt - key.downAt}ms (현실 ${keyRealMs}ms) · 정지 중 MCP screenshot ${mcpShot.ms}ms · snapshot ${mcpSnapshot.ms}ms · 컨트롤러 screenshot ${shot.ms}ms (${image.width}×${image.height})`);

    // 4. 한계: 정지 중 waitForCompletion 계열 MCP 툴(evaluate 등)은 멈추고, 컨트롤러 resume이 풀어준다.
    const hung = link.call("browser_evaluate", { function: "() => 1" }, 6_000);
    await sleep(1_500); await ctrl("/resume"); const released = await hung;
    await ctrl("/pauseAt", { time: T0 + 60_000 });
    assert.ok(released.ok && released.ms >= 1_400, `evaluate는 resume 전까지 멈춰 있어야 합니다: ${released.ms}ms`);
    measurements.evaluateWhilePaused = { releasedAfterMs: released.ms };
    console.log(`[LIMIT] 4. 정지 중 MCP browser_evaluate는 멈춤 → 컨트롤러 resume 1.5s 뒤 ${released.ms}ms에 완료 (click·type·run_code도 같은 경로)`);

    // 5. 감속 루프: 컨트롤러 runFor를 비중첩 반복. 동시에 MCP 스크린샷·스냅샷.
    const before = await ctrl("/state");
    const rate = 0.1, durationMs = 6_000;
    const start = performance.now(); let total = 0; const latencies: number[] = []; let maxGapMs = 0; let lastEnd = start;
    const side = (async () => {
      await sleep(1_500); const shot = await link.tool("browser_take_screenshot", { type: "png", scale: "css" });
      await sleep(1_500); const snapshot = await link.tool("browser_snapshot", {});
      return { sideScreenshotMs: shot.ms, sideSnapshotMs: snapshot.ms };
    })();
    while (performance.now() - start < durationMs) {
      const delta = (performance.now() - start) * rate - total;
      if (delta < 5) { await sleep(5); continue; }
      const step = Math.round(delta);
      const call = await ctrl("/runFor", { ms: step });
      total += step; latencies.push(call.ms);
      const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - lastEnd); lastEnd = now;
    }
    const sideResult = await side; const realMs = performance.now() - start; const after = await ctrl("/state");
    latencies.sort((a, b) => a - b);
    assert.equal(after.now - before.now, total, "가상 Date 진행량이 누적 runFor와 같아야 합니다.");
    assert.ok(Math.abs((after.state.ticks - before.state.ticks) - total / 100) <= 1, `타이머 실행 횟수 ${after.state.ticks - before.state.ticks} vs ${total / 100}`);
    assert.ok(Math.abs(total / realMs - rate) < 0.005, `달성 배속 ${total / realMs}`);
    assert.ok(maxGapMs < 1_000, `동시 MCP 호출 중 최대 공백 ${maxGapMs}ms`);
    const loop = { rate, realMs: Math.round(realMs), advancedMs: total, achievedRate: Number((total / realMs).toFixed(4)), backlogMs: Math.round(realMs * rate - total),
      calls: latencies.length, meanStepMs: Number((total / latencies.length).toFixed(1)), latencyMinMs: latencies[0], latencyMedianMs: latencies[Math.floor(latencies.length / 2)],
      latencyMaxMs: latencies.at(-1), maxGapMs: Math.round(maxGapMs), ...sideResult };
    measurements.slowLoop = loop;
    console.log(`[PASS] 5. 감속 루프 ${loop.realMs}ms: runFor ${loop.calls}회, 평균 step ${loop.meanStepMs}ms, 달성 배속 ${loop.achievedRate} (요청 ${rate}), backlog ${loop.backlogMs}ms`);
    console.log(`       runFor 왕복 min/median/max ${loop.latencyMinMs}/${loop.latencyMedianMs}/${loop.latencyMaxMs}ms · 최대 공백 ${loop.maxGapMs}ms · 동시 MCP screenshot ${loop.sideScreenshotMs}ms · snapshot ${loop.sideSnapshotMs}ms`);

    // 6. 다른 탭을 열어도 컨트롤러는 page 객체로 게임 탭을 고정한다. 단, Clock은 컨텍스트 단위라 새 탭도 함께 정지한다.
    await link.tool("browser_tabs", { action: "new", url: decoyUrl });
    const tabsAfter = await ctrl("/tabs");
    assert.equal(tabsAfter.tabs.length, 2); assert.equal(tabsAfter.tabs[1].url, decoyUrl);
    assert.deepEqual(tabsAfter.tabs.map((tab: any) => tab.visibility), ["visible", "visible"], "두 탭 모두 visible이어야 스로틀링을 배제할 수 있습니다.");
    const game1 = await ctrl("/state", { i: 0 }); const decoy1 = await ctrl("/state", { i: 1 }); await sleep(300); const decoy2 = await ctrl("/state", { i: 1 });
    await ctrl("/runFor", { i: 0, ms: 500 }); const game2 = await ctrl("/state", { i: 0 }); const decoy3 = await ctrl("/state", { i: 1 });
    assert.equal(game1.state.ticks, after.state.ticks, "MCP 선택 탭이 바뀌어도 게임 탭은 정지 상태를 유지해야 합니다.");
    assert.equal(game2.state.ticks - game1.state.ticks, 5, "컨트롤러 i=0은 여전히 게임 탭이어야 합니다.");
    assert.equal(decoy2.state.ticks, decoy1.state.ticks, "컨텍스트 단위 Clock: 새 탭의 실시간 타이머도 정지해야 합니다.");
    assert.equal(decoy3.state.ticks - decoy2.state.ticks, 10, "컨텍스트 단위 Clock: 게임 탭 runFor(500)가 새 탭 50ms 타이머를 10회 진행시켜야 합니다.");
    assert.equal(decoy3.now - decoy1.now, 500);
    measurements.clockScope = "browser-context";
    console.log(`[PASS] 6. 새 탭(MCP 선택) 후 컨트롤러 i=0 게임 탭 runFor(500) → ticks +${game2.state.ticks - game1.state.ticks}`);
    console.log(`[LIMIT] 6. Clock은 브라우저 컨텍스트 단위: decoy 탭 300ms 실대기 ticks ${decoy1.state.ticks}→${decoy2.state.ticks}, 게임 runFor(500) 뒤 ${decoy3.state.ticks}, Date +${decoy3.now - decoy1.now}`);
    return measurements;
  } finally { await link.close(); }
}

// (C) 실제 플러그인 경로: ToolManager → 툴 5개 → 브리지 → MCP 안의 실제 컨트롤러. 모델은 없다.
async function verifyPluginPath(paths: ReturnType<typeof createHarnessPaths>, gameUrl: string) {
  const link = await connect(paths);
  const plugin = createGameTestingPlugin(paths);
  const manager = new ToolManager();
  const cleanup = await plugin.setup({ register: (tool) => manager.register(tool, { owner: "plugins:game-testing" }) });
  // 툴 결과가 오류가 아닌지 확인하고 본문을 돌려준다.
  async function exec(name: string, args: Record<string, unknown>) {
    const result = await manager.execute(name, JSON.stringify(args));
    assert.ok(!result.isError, `${name}: ${result.content}`);
    return result.content;
  }
  // 접근성 스냅샷의 HUD 문구에서 게임 타이머 실행 횟수를 읽는다.
  async function ticks() {
    const snapshot = String((await link.tool("browser_snapshot", {})).content);
    const match = /ticks (\d+)/.exec(snapshot);
    assert.ok(match, `스냅샷에 HUD가 없습니다:\n${snapshot.slice(0, 500)}`);
    return Number(match[1]);
  }
  try {
    const early = await manager.execute("gameTestStart", JSON.stringify({ url: gameUrl, rate: 0.2 }));
    assert.equal(early.isError, true);
    assert.match(String(early.content), /browser_navigate/);
    await link.tool("browser_navigate", { url: gameUrl });
    const started = JSON.parse(String(await exec("gameTestStart", { url: gameUrl, rate: 0.2 })));
    assert.equal(started.freshClockInstall, true);
    // 스킬 2단계: 실제 게임 페이지에서 시계 적용 확인. 떨어지는 블록과 HUD가 500ms 진행 뒤 달라져야 한다.
    const checked = JSON.parse(String(await exec("gameTestClock", { testId: started.testId, action: "check" })));
    assert.equal(checked.verdict, "controllable", JSON.stringify(checked));
    assert.equal(checked.mode, "running");
    const observed = await exec("gameTestObserve", { testId: started.testId }) as ContentBlock[];
    assert.ok(Array.isArray(observed) && observed[1].type === "image" && observed[1].width > 0);
    const observation = JSON.parse((observed[0] as { text: string }).text);
    assert.equal(observation.imageHash.length, 16);
    const actStart = performance.now();
    const acted = JSON.parse(String(await exec("gameTestAct", { testId: started.testId, inputs: [{ keys: ["ArrowLeft"], holdGameMs: 100 }], observationId: observation.observationId })));
    const actRealMs = Math.round(performance.now() - actStart);
    const heldMs = acted.releasedAtGameMs - acted.pressedAtGameMs;
    assert.ok(heldMs >= 100 && heldMs <= 150, `키 유지 게임시간 ${heldMs}`);
    assert.ok(actRealMs >= 400 && actRealMs <= 2_500, `키 유지 현실시간 ${actRealMs}`);
    assert.equal(acted.observationId, observation.observationId);
    // 스킬 3단계: 관찰→입력 지연. 현실 지연과 게임 지연의 비가 배속과 맞아야 한다.
    assert.ok(acted.observationToInputMs >= 0 && acted.observationToInputMs < 5_000, `관찰→입력 현실 ${acted.observationToInputMs}ms`);
    assert.ok(Math.abs(acted.observationToInputGameMs - acted.observationToInputMs * 0.2) <= 60, `관찰→입력 게임 ${acted.observationToInputGameMs}ms vs 현실 ${acted.observationToInputMs}ms × 0.2`);
    // 스킬 4단계: 배속 변경 뒤 같은 hold가 새 배속의 현실 시간을 쓴다 (100ms / 0.05 = 2초).
    const rated = JSON.parse(String(await exec("gameTestClock", { testId: started.testId, action: "rate", rate: 0.05 })));
    assert.equal(rated.rate, 0.05);
    assert.equal(rated.mode, "running");
    const slowStart = performance.now();
    // 시퀀스: 두 번 이동 + 간격. 게임 시간 100+100+50 = 250ms → 배속 0.05에서 현실 약 5초.
    const slowAct = JSON.parse(String(await exec("gameTestAct", { testId: started.testId, inputs: [
      { keys: ["ArrowRight"], holdGameMs: 100, gapGameMs: 50 }, { keys: ["ArrowRight"], holdGameMs: 100 }] })));
    const slowRealMs = Math.round(performance.now() - slowStart);
    assert.ok(slowRealMs >= 4_000 && slowRealMs <= 8_000, `배속 0.05에서 시퀀스(게임 250ms) 현실시간 ${slowRealMs}`);
    assert.equal(slowAct.inputs.length, 2);
    assert.ok(slowAct.inputs[1].pressedAtGameMs >= slowAct.inputs[0].releasedAtGameMs + 50, "시퀀스 간격을 지켜야 합니다.");
    assert.equal("observationToInputMs" in slowAct, false);
    // 정지 중 MCP 스냅샷은 동작하고, advance한 게임 시간만큼 100ms 타이머가 실행된다.
    let status = JSON.parse(String(await exec("gameTestClock", { testId: started.testId, action: "pause" })));
    assert.equal(status.mode, "paused");
    const ticksBefore = await ticks();
    status = JSON.parse(String(await exec("gameTestClock", { testId: started.testId, action: "advance", ms: 300 })));
    const ticksAfter = await ticks();
    assert.equal(ticksAfter - ticksBefore, 3, `advance(300) 동안 ticks ${ticksBefore}→${ticksAfter}`);
    status = JSON.parse(String(await exec("gameTestClock", { testId: started.testId, action: "resume" })));
    assert.equal(status.mode, "running");
    const stopped = JSON.parse(String(await exec("gameTestStop", { testId: started.testId })));
    assert.equal(stopped.clockResumed, true);
    assert.deepEqual(stopped.releasedKeys, []);
    // 재개 뒤 게임은 현실 속도로 다시 돌고, 같은 컨텍스트의 두 번째 테스트는 시계를 다시 설치하지 않는다.
    const resumedA = await ticks();
    await sleep(400);
    const resumedB = await ticks();
    assert.ok(resumedB > resumedA, `재개 후 ticks ${resumedA}→${resumedB}`);
    const restarted = JSON.parse(String(await exec("gameTestStart", { url: gameUrl, rate: 0.2 })));
    assert.equal(restarted.freshClockInstall, false);
    await exec("gameTestStop", { testId: restarted.testId });
    console.log(`[PASS] C. 플러그인 경로: Start(rate 0.2) → check ${checked.verdict} → Observe(이미지) → Act(ArrowLeft 게임 ${heldMs}ms / 현실 ${actRealMs}ms, 관찰→입력 현실 ${acted.observationToInputMs}ms·게임 ${acted.observationToInputGameMs}ms) → rate 0.05 → Act 시퀀스(게임 250ms, 현실 ${slowRealMs}ms) → pause·advance(300)=ticks +3·resume → Stop(resume) → 재개 후 ticks ${resumedA}→${resumedB} → 재시작 시 기존 Clock 재사용`);
    return { checkVerdict: checked.verdict, actGameMs: heldMs, actRealMs, observationToInputMs: acted.observationToInputMs, observationToInputGameMs: acted.observationToInputGameMs, slowActRealMs: slowRealMs, achievedRate: status.achievedRate };
  } finally {
    if (typeof cleanup === "function") await cleanup();
    await link.close();
  }
}

// (D) 실제 모델: 앱과 같은 배선(확장 런타임 → 플러그인·스킬·MCP → Agent)으로 관찰→입력 루프를 수행시키고 기록으로 확인한다.
async function verifyWithModel(paths: ReturnType<typeof createHarnessPaths>, gameUrl: string, model: string, token: string) {
  const toolManager = new ToolManager();
  const skillManager = new SkillManager();
  const servers = (await createMcpServerConfigs(paths)).filter((config) => config.name === "playwright");
  if (servers[0].transport === "stdio") servers[0].args.push("--headless");
  const adapter = createModelAdapter(model, token);
  // 실제 앱과 같은 내장 플러그인 전체(파일 도구 포함)를 올린다. 스킬 본문은 readTextFile로 읽어야 하기 때문이다.
  const plugins = createBuiltinPlugins(paths, adapter);
  const plugin = plugins.find((entry) => entry.name === "game-testing")!;
  const extensions = await createExtensionRuntime({ paths, toolManager, skillManager, plugins, servers });
  const history = new ExecutionHistory(paths, [token]);
  const session = createSession(paths.workspaceDirectory);
  const maxCalls = 16;
  let calls = 0;
  const toolLog: string[] = [];
  try {
    assert.ok(extensions.list("mcp")[0].active, "Playwright MCP 연결이 필요합니다.");
    assert.ok(extensions.list("skills").some((skill) => skill.name === "game-testing"), "플러그인 스킬이 목록에 있어야 합니다.");
    const agent = createAgent({
      // 비용 상한을 두되 실제 Agent의 컨텍스트 조립·툴 실행 루프는 그대로 사용한다.
      adapter: { ...adapter, async generate(request, observer, signal) {
        assert.ok(++calls <= maxCalls, `모델 호출 ${maxCalls}회 초과: 스모크 테스트 중단`);
        return adapter.generate(request, observer, signal);
      } },
      toolManager, skillManager, history, paths,
      // 인증 정보나 이미지 데이터는 출력하지 않고 툴 호출 이름·인자만 표시한다.
      onEvent(event) {
        if (event.type === "tool-start") { toolLog.push(event.name); console.log(`[tool] ${event.name} ${event.arguments.slice(0, 160)}`); }
        if (event.type === "assistant-text") console.log(`[model] ${event.text.slice(0, 300)}`);
      },
    });
    const started = performance.now();
    const answer = await agent.turn(session,
      `Open ${gameUrl} in the browser and play-test it using the game-testing skill, following the skill's phases in order. `
      + "A red block falls on the canvas; each ArrowLeft press moves it 20px to the left. "
      + "In the play phase press ArrowLeft at least twice (you may send both presses as one input sequence), observe the result, then stop the test. "
      + "Finally report the `x` value shown in the page HUD (\"ticks N · x M\"), the game time of your last observation, the reaction latency L you measured, and the rate you applied.");
    const realMs = Math.round(performance.now() - started);
    await history.flush();
    const events = (await readFile(join(paths.sessionDirectory, `${session.id}.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const starts = events.filter((event) => event.type === "tool-start");
    const ends = new Map(events.filter((event) => event.type === "tool-end").map((event) => [event.toolCallId, event]));
    // 툴 호출 이름·인자·결과·시각을 한 줄로 묶는다.
    const callsOf = (name: string) => starts.filter((event) => event.name === name).map((event) => ({
      args: JSON.parse(event.arguments), result: ends.get(event.toolCallId)?.result, at: Date.parse(event.timestamp),
      resultText: (() => { const content = ends.get(event.toolCallId)?.result?.content; return typeof content === "string" ? content : content?.find((block: ContentBlock) => block.type === "text")?.text ?? ""; })(),
    }));
    const skillReads = callsOf("readTextFile").filter((call) => call.args.path === plugin.skills![0]);
    const startCalls = callsOf("gameTestStart");
    const observes = callsOf("gameTestObserve");
    const acts = callsOf("gameTestAct");
    const stops = callsOf("gameTestStop");
    const clocks = callsOf("gameTestClock");
    const checks = clocks.filter((call) => call.args.action === "check");
    const rateChanges = clocks.filter((call) => call.args.action === "rate");
    // 스킬 3단계의 측정 Act: observationId를 넘긴 첫 Act의 관찰→입력 현실 지연이 L이다.
    const measuredAct = acts.find((call) => call.args.observationId);
    const measuredL = (() => { try { return JSON.parse(measuredAct?.resultText ?? "{}").observationToInputMs as number | undefined; } catch { return undefined; } })();
    const appliedRate = rateChanges.at(-1)?.args.rate as number | undefined;
    const forbidden = /^mcp__playwright__browser_(click|type|press_key|evaluate|run_code_unsafe|drag|drop|fill_form)$/;
    const testWindow = [startCalls.at(-1)?.at ?? 0, stops.at(-1)?.at ?? Infinity];
    const violations = starts.filter((event) => forbidden.test(event.name) && Date.parse(event.timestamp) >= testWindow[0] && Date.parse(event.timestamp) <= testWindow[1]).map((event) => event.name);
    const observedGameTimes = observes.map((call) => { try { return JSON.parse(call.resultText).gameTimeMs as number; } catch { return NaN; } });
    const stopSummary = (() => { try { return JSON.parse(stops.at(-1)?.resultText ?? "{}"); } catch { return {}; } })();
    // 모델이 끝난 뒤 하네스가 직접 HUD를 읽어 실제 이동을 확인한다. 시계는 재개된 상태라 스냅샷이 동작한다.
    const snapshot = String((await toolManager.execute("mcp__playwright__browser_snapshot", "{}")).content);
    const finalX = Number(/x (-?\d+)/.exec(snapshot)?.[1]);
    const summary = { model, calls, realMs, toolSequence: toolLog, skillRead: skillReads.length > 0, startRate: startCalls[0]?.args.rate,
      checkVerdicts: checks.map((call) => { try { return JSON.parse(call.resultText).verdict; } catch { return "?"; } }),
      measuredL, appliedRate, expectedRate: measuredL ? Number(Math.min(1, Math.max(0.01, 250 / measuredL)).toFixed(3)) : undefined,
      observes: observes.length, acts: acts.map((call) => call.args), observedGameTimes, violations, stopSummary, finalX, answer };
    const evalDirectory = fileURLToPath(new URL("../docs/codex-dev-log/game-testing-evals/", import.meta.url));
    await mkdir(evalDirectory, { recursive: true });
    const record = join(evalDirectory, `${new Date().toISOString().replace(/[:.]/g, "-")}-${model}.json`);
    await writeFile(record, JSON.stringify(summary, null, 2) + "\n");
    console.log(`[record] ${record}`);
    try {
      assert.ok(skillReads.length > 0, "모델이 스킬 파일을 읽어야 합니다.");
      assert.ok(skillReads[0].at <= (startCalls[0]?.at ?? 0), "스킬을 먼저 읽고 테스트를 시작해야 합니다.");
      assert.equal(startCalls.length, 1, `gameTestStart 호출 ${startCalls.length}회`);
      assert.ok(startCalls[0].args.rate <= 0.25, `요청한 배속 0.1 근처여야 합니다: ${startCalls[0].args.rate}`);
      assert.ok(observes.length >= 2, `관찰 ${observes.length}회`);
      const arrowLefts = acts.reduce((count, call) => count + (call.args.inputs ?? []).filter((input: { keys: string[] }) => input.keys.includes("ArrowLeft")).length, 0);
      assert.ok(arrowLefts >= 2, `ArrowLeft 입력 ${arrowLefts}회`);
      assert.deepEqual(violations, [], "테스트 중 금지된 브라우저 툴을 쓰지 않아야 합니다.");
      assert.ok(observedGameTimes.every((value, index) => index === 0 || value > observedGameTimes[index - 1]), `관찰 사이 게임 시간이 진행해야 합니다: ${observedGameTimes.join(", ")}`);
      assert.equal(stops.length, 1, `gameTestStop 호출 ${stops.length}회`);
      assert.equal(stopSummary.clockResumed, true);
      // 스킬 2~4단계: 관찰 전에 check로 적용을 확인하고, 측정 Act 뒤 rate를 한 번 적용하며, 그 값은 250 / L에 가깝다.
      assert.ok(checks.length >= 1 && checks[0].at <= observes[0].at, "관찰·입력 전에 gameTestClock check로 시계 적용을 확인해야 합니다.");
      assert.equal(JSON.parse(checks.at(-1)!.resultText).verdict, "controllable");
      assert.ok(measuredAct && measuredL !== undefined, "observationId를 넘긴 Act로 관찰→입력 지연 L을 측정해야 합니다.");
      assert.equal(rateChanges.length, 1, `rate 적용은 측정 뒤 한 번이어야 합니다: ${rateChanges.length}회`);
      assert.ok(rateChanges[0].at >= measuredAct!.at, "rate는 L을 측정한 뒤 적용해야 합니다.");
      const expectedRate = Math.min(1, Math.max(0.01, 250 / measuredL!));
      assert.ok(Math.abs(appliedRate! - expectedRate) <= expectedRate * 0.25 + 0.005, `적용 rate ${appliedRate} vs 250/L ${expectedRate.toFixed(3)} (L=${measuredL}ms)`);
      const rate = appliedRate!;
      assert.ok(stopSummary.achievedRate > rate * 0.5 && stopSummary.achievedRate < rate * 1.5, `달성 배속 ${stopSummary.achievedRate} (적용 ${rate})`);
      assert.ok(finalX <= 160, `HUD x가 두 번 이상 왼쪽으로 이동해야 합니다: ${finalX}`);
      assert.ok(answer.includes(String(finalX)), "최종 답변에 HUD의 실제 x 값이 있어야 합니다.");
    } catch (error) {
      console.log("[diagnostic]", JSON.stringify({ toolSequence: toolLog, checkVerdicts: summary.checkVerdicts, measuredL, appliedRate, expectedRate: summary.expectedRate, observedGameTimes, violations, stopSummary, finalX }, null, 2));
      console.log("[diagnostic answer]", answer);
      throw error;
    }
    console.log(`[PASS] D. 실제 ${model}: 모델 호출 ${calls}회 · 현실 ${realMs}ms · 스킬 읽음 · Start(rate ${startCalls[0].args.rate}) · check ${summary.checkVerdicts.join(",")} · L ${measuredL}ms → rate ${appliedRate} (250/L=${summary.expectedRate}) · Observe ${observes.length}회(게임시간 ${observedGameTimes.join("→")}ms) · Act ${acts.length}회 · 금지 툴 0회 · Stop 달성 배속 ${Number(stopSummary.achievedRate).toFixed(3)} · HUD x ${finalX}`);
    console.log(answer);
    return summary;
  } finally {
    await extensions.dispose();
  }
}

// 검증용 웹 서버와 임시 폴더를 준비하고 (A)·(B)·(C), 그리고 --model이 있으면 (D)를 차례로 실행한다.
async function main() {
  const model = process.argv[2] === "--model" ? process.argv[3] : undefined;
  assert.ok(process.argv.length === 2 || model, "사용법: pnpm test:game-testing [--model farm|luna|haiku]");
  const token = model === "farm" ? process.env.BCF_API_KEY : process.env.AIPROXY_TOKEN;
  if (model) assert.ok(token, `${model} 모델의 API 키를 .env에 설정하세요.`);
  const directory = await mkdtemp(join(tmpdir(), "harness-game-testing-smoke-"));
  const paths = createHarnessPaths(directory, join(directory, "home"));
  const server = createServer((request, response) => {
    const page = request.url === "/game" ? GAME_PAGE : request.url === "/decoy" ? DECOY_PAGE : undefined;
    if (!page) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(page);
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const gameUrl = `http://127.0.0.1:${address.port}/game`;
    const decoyUrl = `http://127.0.0.1:${address.port}/decoy`;

    const deadlock = await proveRunCodeDeadlock(paths, gameUrl);
    const controller = await verifyInitPageController(paths, gameUrl, decoyUrl, join(directory, "ctrl.port"));
    const plugin = await verifyPluginPath(paths, gameUrl);
    const withModel = model ? await verifyWithModel(paths, gameUrl, model, token!) : undefined;
    console.log("\n[measurements]");
    console.log(JSON.stringify({ runCodeDeadlock: deadlock, initPageController: controller, pluginPath: plugin,
      ...(withModel ? { model: { calls: withModel.calls, realMs: withModel.realMs, finalX: withModel.finalX, achievedRate: withModel.stopSummary.achievedRate } } : {}) }, null, 2));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

await main();
