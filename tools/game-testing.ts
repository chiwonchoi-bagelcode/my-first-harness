import { fileURLToPath } from "node:url";
import { controllerInfoPath, createBridge } from "../game-testing/bridge.ts";
import type { GameBridge } from "../game-testing/bridge.ts";
import { createTestRun } from "../game-testing/test-run.ts";
import type { ActInput, TestRun } from "../game-testing/test-run.ts";
import { playwrightOutputDirectory } from "../mcp-servers.ts";
import type { HarnessPaths } from "../harness-paths.ts";
import type { HarnessPlugin } from "../plugin-manager.ts";
import type { ToolRegistrar } from "../tool-manager.ts";

// 플러그인이 소유하는 스킬 파일이다. 모델은 이 경로를 readTextFile로 읽는다.
const SKILL_PATH = fileURLToPath(new URL("../game-testing/skills/game-testing/SKILL.md", import.meta.url));
// 첫 정지 시각의 기준이 되는 가상 시계 시작값이다. 게임 시간 보고는 정지 시점을 0으로 하므로 값 자체는 중요하지 않다.
const CLOCK_EPOCH = Date.UTC(2026, 0, 1);

// 두 URL을 정규화해 같은 페이지인지 비교한다.
function sameUrl(a: string, b: string) {
  try { return new URL(a).href === new URL(b).href; } catch { return false; }
}

// 게임 테스트 툴 5개와 스킬을 하나의 플러그인으로 만든다. 브리지는 테스트에서 바꿔 넣을 수 있다.
export function createGameTestingPlugin(paths: HarnessPaths, options: { bridge?: GameBridge } = {}): HarnessPlugin {
  const bridge = options.bridge ?? createBridge(controllerInfoPath(playwrightOutputDirectory(paths)));
  let active: TestRun | undefined;

  // testId가 진행 중인 테스트와 일치하는지 확인하고 그 테스트를 돌려준다.
  function current(testId: string) {
    if (!active) throw new Error("진행 중인 게임 테스트가 없습니다. gameTestStart로 시작하세요.");
    if (active.testId !== testId) throw new Error(`testId가 다릅니다. 진행 중인 테스트는 ${active.testId}입니다.`);
    return active;
  }

  return {
    name: "game-testing",
    description: "브라우저 게임을 느린 게임 시계로 플레이 테스트. Playwright MCP가 켜져 있어야 합니다.",
    skills: [SKILL_PATH],
    // 툴을 등록하고, 플러그인이 꺼질 때 진행 중인 테스트를 정리하는 함수를 돌려준다.
    setup(tools: ToolRegistrar) {
      tools.register({
        name: "gameTestStart",
        description: "Start a slowed-clock play test on a game tab that is ALREADY open in the browser (open it first with browser_navigate). Installs a controllable clock, reloads the page, pauses, then advances game time at `rate` × real time while you think. Only one test at a time. Follow the game-testing skill: check → measure → set rate → play.",
        parameters: { type: "object", properties: {
          url: { type: "string", description: "URL of the open game tab, exactly as navigated." },
          rate: { type: "number", exclusiveMinimum: 0, maximum: 1, description: "Game seconds per real second, e.g. 0.1 = game runs at 1/10 speed." },
        }, required: ["url", "rate"], additionalProperties: false },
        // 열린 탭에서 URL을 찾아 시계를 설치·정지하고 스케줄러를 시작한다.
        async execute({ url, rate }: { url: string; rate: number }) {
          if (active && !["stopped", "lost"].includes(active.status().mode)) {
            throw new Error(`이미 진행 중인 테스트 ${active.testId}가 있습니다. gameTestStop으로 끝낸 뒤 시작하세요.`);
          }
          const tabs = (await bridge.tabs()).filter((tab) => !tab.closed);
          const matches = tabs.filter((tab) => sameUrl(tab.url, url));
          if (matches.length !== 1) {
            const open = tabs.map((tab) => tab.url).join(", ") || "(없음)";
            throw new Error(matches.length === 0
              ? `열린 탭에 ${url}이 없습니다. browser_navigate로 먼저 열어 주세요. 현재 탭: ${open}`
              : `같은 URL의 탭이 ${matches.length}개입니다. 하나만 남기고 닫아 주세요.`);
          }
          const tab = matches[0].tab;
          const installed = await bridge.install(tab, CLOCK_EPOCH);
          const run = createTestRun({ bridge, tab, rate });
          active = run;
          run.resume();
          return JSON.stringify({ testId: run.testId, tab: { index: tab, url: installed.url }, rate, freshClockInstall: installed.freshInstall,
            note: "Game time is 0 now and advances at the given rate while you think. Use gameTestObserve to look, gameTestAct to press keys, gameTestStop to finish. Do not use browser_click/type/evaluate/run_code on this browser until the test is stopped." });
        },
      });

      tools.register({
        name: "gameTestClock",
        description: "Control the slowed game clock of the running test. `check`: verify the clock controls this game (two screenshots while frozen must match, one after advancing 500 game ms must differ) — `verdict` is controllable / not-frozen / no-change-on-advance. `rate`: change the fixed rate without restarting (pass `rate`). `status`, `pause`, `advance` (game `ms` while paused), `resume`.",
        parameters: { type: "object", properties: {
          testId: { type: "string" },
          action: { type: "string", enum: ["status", "check", "rate", "pause", "advance", "resume"] },
          ms: { type: "integer", minimum: 1, maximum: 60_000, description: "Game milliseconds to advance (advance only)." },
          rate: { type: "number", exclusiveMinimum: 0, maximum: 1, description: "New game-seconds-per-real-second (rate only)." },
        }, required: ["testId", "action"], additionalProperties: false },
        // 시계 적용 확인·배속 변경·정지·진행·재개를 수행하고 현재 상태를 돌려준다.
        async execute({ testId, action, ms, rate }: { testId: string; action: "status" | "check" | "rate" | "pause" | "advance" | "resume"; ms?: number; rate?: number }) {
          const run = current(testId);
          if (action === "check") return JSON.stringify({ ...await run.check(), ...run.status() });
          if (action === "rate") {
            if (rate === undefined) throw new Error("rate 동작에는 rate 값이 필요합니다.");
            return JSON.stringify(await run.setRate(rate));
          }
          if (action === "pause") await run.pause();
          else if (action === "resume") run.resume();
          else if (action === "advance") {
            if (ms === undefined) throw new Error("advance에는 ms가 필요합니다.");
            await run.advance(ms);
          }
          return JSON.stringify(run.status());
        },
      });

      tools.register({
        name: "gameTestObserve",
        description: "Take a screenshot of the game tab and return it as an image with an observationId and the game time at capture. Use this instead of browser_take_screenshot during a test.",
        parameters: { type: "object", properties: { testId: { type: "string" } }, required: ["testId"], additionalProperties: false },
        // 화면을 찍어 텍스트 정보와 이미지 블록을 함께 돌려준다.
        async execute({ testId }: { testId: string }) {
          const { image, ...info } = await current(testId).observe();
          return [{ type: "text" as const, text: JSON.stringify(info) }, image];
        },
      });

      tools.register({
        name: "gameTestAct",
        description: "Send an ordered sequence of key inputs executed in GAME time: each input presses its keys, holds them `holdGameMs`, releases (the harness releases as game time passes), then waits `gapGameMs` before the next input. Plan a whole maneuver from one observation — e.g. the moves that position a piece first, then rotation, then the commit/drop input last — and send it as ONE call instead of one key per call. Returns after the last release; real wait ≈ (sum of holds and gaps) / rate. Pass the observationId this sequence is based on to get `observationToInputMs` (real ms from that capture to the first key press — your reaction latency L) and `observationToInputGameMs`.",
        parameters: { type: "object", properties: {
          testId: { type: "string" },
          inputs: { type: "array", minItems: 1, maxItems: 16, description: "Inputs in order.", items: { type: "object", properties: {
            keys: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 4, description: "Playwright key names pressed together, e.g. ArrowLeft, ArrowUp, Space, z. Repeat a key as separate inputs, not twice in one input." },
            holdGameMs: { type: "integer", minimum: 1, maximum: 5_000, description: "Game ms to hold before release. Use a small value (1–50) for a tap." },
            gapGameMs: { type: "integer", minimum: 0, maximum: 5_000, description: "Game ms to wait after release before the next input (e.g. 50 so the game sees separate presses). Default 0." },
          }, required: ["keys", "holdGameMs"], additionalProperties: false } },
          observationId: { type: "string", description: "observationId from the gameTestObserve result you are acting on." },
        }, required: ["testId", "inputs"], additionalProperties: false },
        // 입력 시퀀스를 게임 시간 순서로 실행하고 각 입력의 누름·해제 게임 시각과 관찰→입력 지연을 돌려준다.
        async execute({ testId, inputs, observationId }: { testId: string; inputs: ActInput[]; observationId?: string }, context?: { signal?: AbortSignal }) {
          return JSON.stringify(await current(testId).act(inputs, context?.signal, observationId));
        },
      });

      tools.register({
        name: "gameTestStop",
        description: "Finish the test: release held keys, stop advancing game time, and resume the page clock at normal speed. Always call this before using other browser tools again.",
        parameters: { type: "object", properties: { testId: { type: "string" } }, required: ["testId"], additionalProperties: false },
        // 진행 중인 테스트를 정리하고 요약을 돌려준다.
        async execute({ testId }: { testId: string }) {
          const run = current(testId);
          const summary = await run.stop();
          active = undefined;
          return JSON.stringify(summary);
        },
      });

      return async () => {
        if (active) await active.stop().catch(() => {});
        active = undefined;
      };
    },
  };
}
