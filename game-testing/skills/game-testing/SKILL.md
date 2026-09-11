---
name: game-testing
description: Play-test a browser game with a harness-controlled game clock (paused, slow-motion, or real time) so you can observe, decide, and press keys without the game running away while you think. Observe as a screenshot or, when the game exposes the state contract described here, as exact JSON text. When the state is structured, decide first whether to build a deterministic strategy tool for it. Use when asked to play, QA, or verify a browser game's behavior (movement, rotation, collisions, game over, restart), or to make a game text-observable for testing.
---

# Game testing with a harness-controlled clock

The harness can freeze a game tab's clock and advance it at a fixed fraction of real time (`rate`; 1.0 = real time). While you read an observation and decide, the game moves only `rate` × as fast as normal. Tools: `gameTestStart`, `gameTestClock`, `gameTestObserve`, `gameTestAct`, `gameTestStop`.

Two ways to observe:

- **image** — a screenshot. Works for any game; counting rows and columns from pixels is error-prone.
- **text** — the game's own state as JSON, read through the contract below. Exact and cheap, but only for games that implement it. Prefer text whenever it is available.

## Testable game contract

A game is text-observable when its page defines `window.__gameTest = { getState(), controls? }`: `getState()` returns a JSON-serializable snapshot of what the player can see (grid as strings, the controlled object, previews, HUD values, a `phase`), read-only, and `controls` maps action names to key codes. The harness knows nothing about the game and forwards the JSON to you as text. The full specification, the rules, and how to add the contract to an existing game are in `state-contract.md` in this skill's folder; read it with `readTextFile` only when you need to add or check a contract.

## Phase 1 — Open and start

1. Confirm the target URL, what must be verified, the success criteria, and the rate the user wants. `gameTestStart` reloads the page and resets its state; confirm that is acceptable.
2. Load every browser tool you will need (`browser_navigate`, `browser_snapshot`, `browser_tabs`) with a single ToolSearch call before you start: each load changes the tool list and resets the prompt cache, so one early load is far cheaper than loading tools one at a time mid-test.
3. Open the game with `browser_navigate` (the controller attaches to tabs when they are created).
4. Call `gameTestStart({ url, rate })`. Rate: the user's value if given. Otherwise **1.0** when you will observe as text (text observation is fast enough to test at true speed), or **0.1 provisional** for image observation (Phases 3–4 replace it). Game time is 0 at start and advances at `rate` while you work. Only one test can run at a time.
5. Try `gameTestObserve({ format: "text" })` once. If it returns state JSON, use text for the rest of the test. If it returns the "no contract" error, use image observation (or, if you are also allowed to edit the game, add the contract first following `state-contract.md` in this skill's folder, then restart the test).

## Phase 2 — Check that the clock controls this game

6. Call `gameTestClock({ action: "check" })`. It freezes game time, takes two screenshots, advances game time by 500 ms, takes a third, and compares them.
   - `verdict: "controllable"` — proceed.
   - `"no-change-on-advance"` — the game is probably not running yet (menu, start screen). Start it with `gameTestAct` (the game's start key, `controls.start` if given), then `check` again. If it still does not change, the game does not run on the page clock (e.g. server-driven or worker-driven): report "not testable with clock control" and `gameTestStop`.
   - `"not-frozen"` — something on the page moves while game time is frozen (CSS animation, video, real-time network updates). Report it; you may continue only if the moving part is not what you are testing, and say so in the report.

## Phase 3 — Measure your own reaction latency (image mode; once)

7. Call `gameTestObserve`, look at the image, decide a real input for the current situation, and call `gameTestAct` with a one-element `inputs` sequence and the `observationId`. The result's `observationToInputMs` is **L**: the real milliseconds from the capture to your first key press (transfer + your thinking + tool round trip). Do this with a genuine decision, not a dummy key. One measurement is enough; take a second only if the first looks abnormal. In text mode every `gameTestAct` that carries an `observationId` reports the same latencies, so skip this explicit step and Phase 4 unless the user asked for slowed play.

## Phase 4 — Set the rate from L (image mode)

8. Target reaction time **H** in game milliseconds: use the value the user gave; if none, use **250 ms** and state that it is an experimental choice, not a universal human constant.
9. `rate = H / L`, clamped to `[0.01, 1]`, rounded to 3 decimals. Example: L = 5200 ms, H = 250 ms → rate = 0.048.
10. Apply it with `gameTestClock({ action: "rate", rate })`. This keeps the current game state; it does not reload.

## Phase 5 — Play at the fixed rate

Text mode:

11. **Before the first placement, decide whether to build a strategy tool.** Read `strategy-tool.md` in this skill's folder with `readTextFile` and follow it: look for a known strategy first (web search when your model connection has it), build the tool to its four requirements with the tool-making skill (`createTool`), test it on the current state, and only then start placing pieces. If the strategy cannot be made deterministic, say so in one line and play without one. How you use the tool in the loop below is your call; the harness never runs it for you.
12. Loop: `gameTestObserve({ format: "text" })` → decide the **whole placement** for the current piece (where it should come to rest) → compute the key sequence from the state: the moves from the current position to the target column (e.g. x = 4 → column 2 is two `left` presses), the rotations, and the commit input (hard drop) **last** → one `gameTestAct({ inputs: [...], observationId })` with `gapGameMs` about 50 between inputs and a small `holdGameMs` (1–50) per tap. One observation and one action per piece; do not re-observe between individual keys.
13. Assume the game has no key auto-repeat unless `controls` or the state says otherwise: one press moves one cell, so n cells = n inputs.
14. Rotation can shift the position (wall kicks). If a rotation is part of the plan and the exact column matters, account for the kick or rotate first and re-observe before the drop.
15. In real time the piece keeps falling while you think. If the next observation shows a different current piece than the one you planned for and you did not drop it, the piece locked on its own: record it as a **late lock**, plan the new piece, and keep going. Do not change the rate mid-run unless the user asked.

Image mode:

16. Loop: `gameTestObserve` → decide the whole next maneuver → one `gameTestAct({ inputs: [...], observationId })`. Plan from one observation everything the current piece or situation needs — positioning moves first, then rotation, and the commit input last — as one `inputs` sequence with a small `gapGameMs` (about 50). Keep passing `observationId`; `observationToInputGameMs` in each result shows how close your reaction was to H. **Do not change the rate during this phase** and do not re-measure; one play segment uses one rate. Before relying on a long hold to move several cells, check once whether this game auto-repeats a held key — many do not.

Both modes:

17. Compare expected vs. observed for each requirement. Keep the game times and observation ids that show a failure and describe how to reproduce it. Use `gameTestClock` `pause` / `advance` / `resume` only when a deterministic step is needed.

## Phase 6 — Stop and report

18. Always finish with `gameTestStop`. Then, if the user wants it, run a separate normal-speed check with the ordinary browser tools.
19. Report: the observation mode (text or image), the `check` verdict, the rate (and H, L when you calibrated), the pieces placed and the lines/score from the final state, the number of late locks, a few `observationToInputMs` / `observationToInputGameMs` values, what passed, what failed, and what was not checked. Being "human-like" here means only that the game time between seeing and acting is near H; it says nothing about attention, prediction, skill, or input frequency. Slowed-clock success is not normal-speed success, and text observation is exact perception, not a judgment of the game's rendering — say so when reporting visual issues.

## Rules

- **Keep your visible output minimal while a test runs.** Between tool calls write nothing, or one short line. Every sentence costs output tokens and real time while the game clock is running. Put observations, numbers, and judgments in the final report instead.
- **While a test is running, do not call `browser_click`, `browser_type`, `browser_press_key`, `browser_evaluate`, `browser_run_code_unsafe`, `browser_drag`, or `browser_fill_form` on this browser.** The clock is paused between advances and those tools wait on page timers, so they hang until the test stops. `browser_snapshot` and `browser_tabs` are safe; prefer `gameTestObserve` over `browser_take_screenshot`.
- The controlled clock applies to the whole browser context: other tabs opened in this browser also freeze during the test. Stop the test before browsing elsewhere.
- Send only the inputs you decided on. Read the game only through the screen or the read-only contract; do not modify the game's internal state to make a check pass. Report a failure or "unverified" instead.
- `achievedRate` well below the requested rate, `droppedMs` > 0, or `mode: "lost"` mean the slow-motion loop fell behind or lost the controller. Say so in the report; do not present those runs as clean measurements.
