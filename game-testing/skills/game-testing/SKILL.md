---
name: game-testing
description: Play-test a browser game with a slowed, harness-controlled game clock so you can observe, decide, and press keys without the game running away while you think. Use when asked to play, QA, or verify a browser game's behavior (movement, rotation, collisions, game over, restart).
---

# Game testing with a slowed clock

The harness can freeze a game tab's clock and advance it at a fixed fraction of real time. While you read a screenshot and decide, the game moves only `rate` × as fast as normal. Tools: `gameTestStart`, `gameTestClock`, `gameTestObserve`, `gameTestAct`, `gameTestStop`.

Do the phases below in order. Phases 2–4 are the setup that makes the play phase meaningful; do not skip them.

## Phase 1 — Open and start

1. Confirm the target URL, what must be verified, and the success criteria. `gameTestStart` reloads the page and resets its state; confirm that is acceptable.
2. Open the game with `browser_navigate` (the controller attaches to tabs when they are created).
3. Call `gameTestStart({ url, rate: 0.1 })`. This `0.1` is provisional; phase 4 replaces it. Game time is 0 at start and advances at `rate` while you work. Only one test can run at a time.

## Phase 2 — Check that the clock controls this game

4. Call `gameTestClock({ action: "check" })`. It freezes game time, takes two screenshots, advances game time by 500 ms, takes a third, and compares them.
   - `verdict: "controllable"` — proceed.
   - `"no-change-on-advance"` — the game is probably not running yet (menu, start screen). Start it with `gameTestAct` (the game's start key), then `check` again. If it still does not change, the game does not run on the page clock (e.g. server-driven or worker-driven): report "not testable with clock control" and `gameTestStop`.
   - `"not-frozen"` — something on the page moves while game time is frozen (CSS animation, video, real-time network updates). Report it; you may continue only if the moving part is not what you are testing, and say so in the report.

## Phase 3 — Measure your own reaction latency (once)

5. Call `gameTestObserve`, look at the image, decide a real input for the current situation, and call `gameTestAct` with a one-element `inputs` sequence and the `observationId`. The result's `observationToInputMs` is **L**: the real milliseconds from the capture to your first key press (transfer + your thinking + tool round trip). Do this with a genuine decision, not a dummy key. One measurement is enough; take a second only if the first looks abnormal (for example a tool retry inflated it).

## Phase 4 — Set the rate from L

6. Target reaction time **H** in game milliseconds: use the value the user gave; if none, use **250 ms** and state that it is an experimental choice, not a universal human constant.
7. `rate = H / L`, clamped to `[0.01, 1]`, rounded to 3 decimals. Example: L = 5200 ms, H = 250 ms → rate = 0.048.
8. Apply it with `gameTestClock({ action: "rate", rate })`. This keeps the current game state; it does not reload.

## Phase 5 — Play at the fixed rate

9. Loop: `gameTestObserve` → decide the **whole next maneuver** → one `gameTestAct({ inputs: [...], observationId })`. Plan from one observation everything the current piece or situation needs — the positioning moves first, then rotation, and the commit input (drop, confirm) **last** — and send it as one `inputs` sequence with a small `gapGameMs` (about 50) between inputs so the game registers separate presses. One decision per piece or maneuver, not one key per call: a call costs a model round trip, and a key-by-key loop is both slow and expensive. Keep passing `observationId`; `observationToInputGameMs` in each result shows how close your reaction was to H. **Do not change the rate during this phase** and do not re-measure; one play segment uses one rate.
10. Each input holds `holdGameMs` game ms then releases; the whole call returns after (sum of holds and gaps) / rate real ms. Before relying on a long hold to move several cells, check once whether this game auto-repeats a held key — many do not; if it does not, send one input per cell instead. Use `gameTestClock` `pause` / `advance` / `resume` only when a deterministic step is needed.
11. Compare expected vs. observed for each requirement. Keep the game times and observation ids that show a failure and describe how to reproduce it.

## Phase 6 — Stop and report

12. Always finish with `gameTestStop`. Then, if the user wants it, run a separate normal-speed check with the ordinary browser tools.
13. Report: the `check` verdict, H, the measured L, the applied rate, a few `observationToInputGameMs` values from the play phase, what passed, what failed, and what was not checked. Being "human-like" here means only that the game time between seeing and acting is near H; it says nothing about attention, prediction, skill, or input frequency. Slowed-clock success is not normal-speed success.

## Rules

- **While a test is running, do not call `browser_click`, `browser_type`, `browser_press_key`, `browser_evaluate`, `browser_run_code_unsafe`, `browser_drag`, or `browser_fill_form` on this browser.** The clock is paused between advances and those tools wait on page timers, so they hang until the test stops. `browser_snapshot` and `browser_tabs` are safe; prefer `gameTestObserve` over `browser_take_screenshot`.
- The controlled clock applies to the whole browser context: other tabs opened in this browser also freeze during the test. Stop the test before browsing elsewhere.
- Send only the inputs you decided on. Do not read or modify the game's internal state to make a check pass; report a failure or "unverified" instead.
- `achievedRate` well below the requested rate, `droppedMs` > 0, or `mode: "lost"` mean the slow-motion loop fell behind or lost the controller. Say so in the report; do not present those runs as clean measurements.
