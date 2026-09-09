import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { imageFromBytes } from "../image-content.ts";
import type { ImageBlock } from "../llm-types.ts";
import type { GameBridge } from "./bridge.ts";

// 진행 상태다. running은 스케줄러가 배속대로 진행 중, paused는 정지, stopped는 종료, lost는 컨트롤러 오류로 제어를 잃음.
export type TestRunMode = "running" | "paused" | "stopped" | "lost";

// UI·모델에 보고할 현재 상태다. 게임 시간은 테스트 시작(정지 시점)을 0으로 한다.
export type TestRunStatus = {
  testId: string; mode: TestRunMode; rate: number; gameTimeMs: number; runForCalls: number;
  // 스케줄러가 실제로 진행한 구간에서 계산한 달성 배속과, 정체를 따라가지 않고 버린 게임 시간.
  achievedRate: number | null; droppedMs: number; heldKeys: string[]; error?: string;
};

// 시계·대기 함수를 바꿔 넣을 수 있게 하여 단위 테스트에서 실제 시간을 쓰지 않는다.
export type TestRunOptions = {
  bridge: GameBridge; tab: number; rate: number;
  now?: () => number; sleep?: (ms: number) => Promise<void>;
  // 한 번에 진행하는 게임 시간의 하한·상한(ms). 상한을 넘는 정체분은 버리고 기준점을 다시 잡는다.
  minStepMs?: number; maxStepMs?: number;
};

// 시계 적용 확인에서 한 번에 진행하는 게임 시간(ms)이다. 게임 화면이 바뀔 만큼은 되고 상태를 크게 바꾸지는 않는 값이다.
export const CHECK_ADVANCE_MS = 500;

// PNG 바이트의 SHA-256 앞 16자리로 두 화면이 같은지 비교한다.
function hashOf(png: Buffer) {
  return createHash("sha256").update(png).digest("hex").slice(0, 16);
}

// 한 번의 입력이다. keys를 동시에 누르고 holdGameMs(게임 시간) 뒤 놓은 다음, gapGameMs가 지나야 다음 입력으로 넘어간다.
export type ActInput = { keys: string[]; holdGameMs: number; gapGameMs?: number };

// 게임 시간이 특정 시각에 도달하기를 기다리는 호출자다. 입력 사이 간격에 쓴다.
type GameTimer = { atGameMs: number; resolve: () => void; reject: (error: Error) => void };

// 누른 키 하나의 해제 예정 게임 시각과 완료 알림이다.
type HeldKey = { key: string; pressedAtGameMs: number; releaseAtGameMs: number; resolve: (releasedAt: number) => void; reject: (error: Error) => void };

// 테스트 한 건의 스케줄러·키·관찰·정리를 담당한다. 동시에 하나만 존재하도록 호출자가 관리한다.
export function createTestRun(options: TestRunOptions) {
  const { bridge, tab, now = () => performance.now(), sleep = (ms) => delay(ms), minStepMs = 5, maxStepMs = 50 } = options;
  let rate = options.rate;
  if (!(rate > 0 && rate <= 1)) throw new Error("rate는 0보다 크고 1 이하여야 합니다.");
  const testId = `gt-${randomUUID().slice(0, 8)}`;
  let mode: TestRunMode = "paused";
  let gameTimeMs = 0;
  let runForCalls = 0;
  let droppedMs = 0;
  let error: string | undefined;
  let runningRealMs = 0;
  let runningGameMs = 0;
  let segmentStartReal = 0;
  let segmentStartGame = 0;
  let loopPromise: Promise<void> = Promise.resolve();
  const held = new Map<string, HeldKey>();
  const timers: GameTimer[] = [];
  // 관찰 ID별 캡처 완료 시각(현실)과 게임 시간이다. Act가 관찰→입력 지연을 계산할 때 쓴다.
  const observations = new Map<string, { capturedAtReal: number; gameTimeMs: number }>();

  // 컨트롤러 오류가 나면 제어를 잃은 것으로 표시하고 기다리는 키 해제를 모두 실패시킨다.
  function markLost(cause: unknown) {
    mode = "lost";
    error = cause instanceof Error ? cause.message : String(cause);
    for (const entry of held.values()) entry.reject(new Error(`컨트롤러 오류로 키 해제를 확인하지 못했습니다: ${error}`));
    held.clear();
    for (const timer of timers.splice(0)) timer.reject(new Error(`컨트롤러 오류로 입력 간격을 기다릴 수 없습니다: ${error}`));
  }

  // 해제 시각이 지난 키를 놓고, 도달한 게임 시각을 기다리던 호출자를 깨운다.
  async function releaseDueKeys() {
    for (const entry of [...held.values()]) {
      if (entry.releaseAtGameMs > gameTimeMs) continue;
      await bridge.keyUp(tab, entry.key);
      held.delete(entry.key);
      entry.resolve(gameTimeMs);
    }
    for (const timer of timers.filter((entry) => entry.atGameMs <= gameTimeMs)) {
      timers.splice(timers.indexOf(timer), 1);
      timer.resolve();
    }
  }

  // 게임 시간이 atGameMs에 도달할 때까지 기다린다. 스케줄러나 advance가 진행시킬 때 풀린다.
  function waitGameTime(atGameMs: number, signal?: AbortSignal) {
    if (gameTimeMs >= atGameMs) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer: GameTimer = { atGameMs, resolve, reject };
      timers.push(timer);
      signal?.addEventListener("abort", () => {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
        reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
      }, { once: true });
    });
  }

  // 테스트가 끝났거나 제어를 잃었는지 본다. 함수로 두어 await 사이에 바뀐 상태를 다시 읽는다.
  function finished() {
    return mode === "stopped" || mode === "lost";
  }

  // 진행 중 구간의 현실·게임 경과를 누적해 달성 배속 계산에 쓴다.
  function closeSegment() {
    runningRealMs += now() - segmentStartReal;
    runningGameMs += gameTimeMs - segmentStartGame;
  }

  // 현실 경과 × rate를 목표로 짧은 runFor를 비중첩 반복한다. 정체 뒤에는 한꺼번에 따라가지 않는다.
  async function loop() {
    let anchorReal = now();
    let anchorGame = gameTimeMs;
    segmentStartReal = anchorReal;
    segmentStartGame = anchorGame;
    try {
      while (mode === "running") {
        const target = anchorGame + (now() - anchorReal) * rate;
        const delta = target - gameTimeMs;
        if (delta < minStepMs) { await sleep(Math.max(1, Math.ceil((minStepMs - delta) / rate))); continue; }
        let step = Math.round(delta);
        if (step > maxStepMs) {
          droppedMs += step - maxStepMs;
          step = maxStepMs;
          anchorReal = now();
          anchorGame = gameTimeMs + step;
        }
        await bridge.runFor(tab, step);
        gameTimeMs += step;
        runForCalls++;
        await releaseDueKeys();
      }
      closeSegment();
    } catch (cause) {
      closeSegment();
      markLost(cause);
    }
  }

  // 정지 상태에서 진행을 시작한다. 이미 진행 중이거나 끝난 테스트에는 쓸 수 없다.
  function resume() {
    if (mode === "running") return;
    if (mode !== "paused") throw new Error(`${mode} 상태의 테스트는 진행할 수 없습니다.`);
    mode = "running";
    loopPromise = loop();
  }

  // 진행을 멈춘다. 현재 runFor가 끝난 뒤 반환하므로 이후 호출은 시계가 정지된 상태를 본다.
  async function pause() {
    if (mode !== "running") return;
    mode = "paused";
    await loopPromise;
  }

  // 현재 상태를 계산해 돌려준다. 진행 중이면 이번 구간의 경과도 포함한다.
  function status(): TestRunStatus {
    const realMs = runningRealMs + (mode === "running" ? now() - segmentStartReal : 0);
    const gameMs = runningGameMs + (mode === "running" ? gameTimeMs - segmentStartGame : 0);
    return { testId, mode, rate, gameTimeMs, runForCalls, achievedRate: realMs > 0 ? gameMs / realMs : null,
      droppedMs, heldKeys: [...held.keys()], ...(error ? { error } : {}) };
  }

  // 정지 상태에서만 게임 시간을 지정한 만큼 한 번에 진행한다.
  async function advance(ms: number) {
    if (mode !== "paused") throw new Error(`advance는 paused 상태에서만 가능합니다 (현재 ${mode}).`);
    try {
      await bridge.runFor(tab, ms);
      gameTimeMs += ms;
      runForCalls++;
      await releaseDueKeys();
    } catch (cause) { markLost(cause); throw cause; }
  }

  // 화면을 찍되 컨트롤러 오류는 제어 상실로 기록한다.
  async function screenshot() {
    try { return await bridge.screenshot(tab); } catch (cause) { markLost(cause); throw cause; }
  }

  return {
    testId, status, resume, pause, advance,
    // 시계 제어가 이 게임에 적용되는지 확인한다: 정지 중 두 화면이 같고, 게임 시간을 진행한 뒤 화면이 달라져야 한다. 확인 전 상태로 돌려놓는다.
    async check() {
      if (mode !== "running" && mode !== "paused") throw new Error(`${mode} 상태의 테스트는 확인할 수 없습니다.`);
      const wasRunning = mode === "running";
      await pause();
      const first = hashOf(await screenshot());
      const second = hashOf(await screenshot());
      await advance(CHECK_ADVANCE_MS);
      const third = hashOf(await screenshot());
      if (wasRunning) resume();
      const frozenWhilePaused = first === second;
      const changesOnAdvance = third !== second;
      return { frozenWhilePaused, changesOnAdvance, advancedGameMs: CHECK_ADVANCE_MS, hashes: [first, second, third],
        verdict: frozenWhilePaused && changesOnAdvance ? "controllable" : !frozenWhilePaused ? "not-frozen" : "no-change-on-advance" };
    },
    // 진행 중인 게임을 유지한 채 배속을 바꾼다. 스케줄러가 기준점을 다시 잡으므로 따라가기 점프는 없고, 달성 배속은 새 구간만 반영한다.
    async setRate(next: number) {
      if (!(next > 0 && next <= 1)) throw new Error("rate는 0보다 크고 1 이하여야 합니다.");
      if (mode !== "running" && mode !== "paused") throw new Error(`${mode} 상태의 테스트는 배속을 바꿀 수 없습니다.`);
      const wasRunning = mode === "running";
      await pause();
      rate = next;
      runningRealMs = 0;
      runningGameMs = 0;
      if (wasRunning) resume();
      return status();
    },
    // 입력 시퀀스를 게임 시간 순서로 실행한다: 누름 → holdGameMs 뒤 스케줄러가 놓음 → gapGameMs 대기 → 다음 입력. observationId를 주면 첫 입력까지의 관찰→입력 지연을 계산한다.
    async act(inputs: ActInput[], signal?: AbortSignal, observationId?: string) {
      if (mode !== "running") throw new Error(`키 입력은 running 상태에서만 가능합니다 (현재 ${mode}). gameTestClock resume 뒤 다시 시도하세요.`);
      if (inputs.length === 0) throw new Error("inputs가 비어 있습니다. 최소 한 개의 입력이 필요합니다.");
      for (const input of inputs) {
        if (new Set(input.keys).size !== input.keys.length) throw new Error(`한 입력 안에 같은 키를 두 번 넣을 수 없습니다: ${input.keys.join(", ")}. 반복 입력은 별도 항목으로 나누세요.`);
      }
      for (const key of inputs[0].keys) if (held.has(key)) throw new Error(`${key}는 이미 눌린 상태입니다. 해제된 뒤 다시 누르세요.`);
      const observation = observationId !== undefined ? observations.get(observationId) : undefined;
      if (observationId !== undefined && !observation) {
        throw new Error(`알 수 없는 observationId: ${observationId}. 이 테스트의 gameTestObserve 결과에서 받은 값을 넘기세요.`);
      }
      const startedReal = now();
      const results: { keys: string[]; holdGameMs: number; pressedAtGameMs: number; releasedAtGameMs: number }[] = [];
      let latency: { observationId?: string; observationToInputMs?: number; observationToInputGameMs?: number } = {};
      for (const [index, input] of inputs.entries()) {
        signal?.throwIfAborted();
        if (finished()) throw new Error(`입력 도중 테스트가 ${mode} 상태가 되어 ${results.length}/${inputs.length}개만 실행했습니다.`);
        for (const key of input.keys) if (held.has(key)) throw new Error(`${key}는 이미 눌린 상태입니다. ${results.length}/${inputs.length}개만 실행했습니다.`);
        const waits: Promise<number>[] = [];
        let pressedAtGameMs = gameTimeMs;
        try {
          for (const key of input.keys) {
            await bridge.keyDown(tab, key);
            pressedAtGameMs = gameTimeMs;
            waits.push(new Promise<number>((resolve, reject) => {
              held.set(key, { key, pressedAtGameMs, releaseAtGameMs: pressedAtGameMs + input.holdGameMs, resolve, reject });
              signal?.addEventListener("abort", () => reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))), { once: true });
            }));
          }
        } catch (cause) { markLost(cause); throw cause; }
        if (index === 0) {
          // 캡처 완료 → 첫 keydown 전송 완료가 관찰→입력 지연이다. 페이지에 실제 적용된 시각은 재지 않으므로 전송 완료 시각을 대용으로 쓴다.
          const inputSentAtReal = now();
          latency = observation ? {
            observationId, observationToInputMs: Math.round(inputSentAtReal - observation.capturedAtReal),
            observationToInputGameMs: pressedAtGameMs - observation.gameTimeMs,
          } : {};
        }
        const releasedAtGameMs = Math.max(...await Promise.all(waits));
        results.push({ keys: input.keys, holdGameMs: input.holdGameMs, pressedAtGameMs, releasedAtGameMs });
        if (input.gapGameMs && index < inputs.length - 1) await waitGameTime(releasedAtGameMs + input.gapGameMs, signal);
      }
      return { inputs: results, pressedAtGameMs: results[0].pressedAtGameMs, releasedAtGameMs: results.at(-1)!.releasedAtGameMs,
        realMs: Math.round(now() - startedReal), ...latency };
    },
    // 현재 화면을 찍어 공통 이미지 블록과 관찰 ID, 관찰 시점 게임 시간, 화면 해시를 돌려주고 캡처 시각을 기억한다.
    async observe(): Promise<{ observationId: string; gameTimeMs: number; mode: TestRunMode; imageHash: string; image: ImageBlock }> {
      if (mode === "stopped" || mode === "lost") throw new Error(`${mode} 상태의 테스트는 관찰할 수 없습니다.`);
      const png = await screenshot();
      const capturedAtReal = now();
      const capturedGameTimeMs = gameTimeMs;
      const image = await imageFromBytes(png);
      const observationId = `ob-${randomUUID().slice(0, 8)}`;
      observations.set(observationId, { capturedAtReal, gameTimeMs: capturedGameTimeMs });
      // 오래된 관찰은 지연 계산에 쓰이지 않으므로 최근 50개만 남긴다.
      if (observations.size > 50) observations.delete(observations.keys().next().value!);
      return { observationId, gameTimeMs: capturedGameTimeMs, mode, imageHash: hashOf(png), image: { ...image, name: `game-observe-${capturedGameTimeMs}.png` } };
    },
    // 진행 정지 → 누른 키 해제 → 시계 재개 순서로 되돌린다. 이미 끝났으면 다시 하지 않는다.
    async stop() {
      if (mode === "stopped") return { alreadyStopped: true, releasedKeys: [] as string[], clockResumed: false, ...status() };
      const wasLost = mode === "lost";
      if (mode === "running") { mode = "stopped"; await loopPromise; }
      mode = wasLost ? "lost" : "stopped";
      const releasedKeys: string[] = [];
      const failures: string[] = [];
      for (const entry of [...held.values()]) {
        try { await bridge.keyUp(tab, entry.key); releasedKeys.push(entry.key); }
        catch (cause) { failures.push(`${entry.key}: ${cause instanceof Error ? cause.message : cause}`); }
        held.delete(entry.key);
        entry.reject(new Error("테스트 종료로 키를 해제했습니다."));
      }
      for (const timer of timers.splice(0)) timer.reject(new Error("테스트 종료로 입력 시퀀스를 중단했습니다."));
      let clockResumed = false;
      try { await bridge.resume(tab); clockResumed = true; }
      catch (cause) { failures.push(`resume: ${cause instanceof Error ? cause.message : cause}`); }
      mode = "stopped";
      return { alreadyStopped: false, releasedKeys, clockResumed, ...status(), ...(failures.length ? { failures } : {}),
        note: "resume은 가짜 시계를 진행 상태로 바꾼 것이며 원래 시간 API로 되돌린 것은 아닙니다. 완전한 초기화가 필요하면 페이지를 새로 열어야 합니다." };
    },
  };
}

// createTestRun이 반환하는 객체의 타입.
export type TestRun = ReturnType<typeof createTestRun>;
