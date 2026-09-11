# Strategy as a tool

Read this before the first placement in text mode (game-testing skill, Phase 5, step 11). It is game-agnostic: the harness adds no game knowledge, and it never runs the tool for you.

## Decide

If the observed state is structured and a strategy for this game can be written as a deterministic loss or score function of that state, build it as a tool with the tool-making skill (`createTool`). If it cannot be made deterministic, say so in one line and play without one. How you use the tool while playing is your call. Build it fresh for this game and this session; if a strategy tool from an earlier session is already registered, read its code and replace it unless it meets the requirements below.

## Look for a known strategy first

Before inventing your own, look for an established one. If your model connection has web search, search for known algorithms or heuristics for this kind of game and implement one of those; record what you used in the tool's description. Without web search, use what you already know and say so.

## Four requirements for the tool

1. **Simulate, don't estimate.** Apply a candidate action to the state with the game's real rules (shapes, rotation and its kicks, gravity, collisions, scoring) and produce the resulting state. Treating a piece as a solid block that lands on the highest column under it is not a simulation and will mislead you.
2. **Return the predicted next state** alongside the recommendation. After you act, compare it with the next observation; if they differ, the tool is wrong — fix it and replace it (`createTool` with `replace: true`) before trusting it again.
3. **Score by the game's own progress counters first** — the values its HUD or state reports as progress (lines, score, level) — then by state features that hurt those counters (holes, height, unevenness, dead ends). A score that ignores the objective optimizes the wrong thing.
4. **Return the exact `inputs` to send**, in the shape `gameTestAct` accepts (keys, `holdGameMs`, `gapGameMs`), not a description such as "left 3, rotate 1". Translating by hand is where errors creep in.

## Verify before trusting

Call the tool once on the current state and read its prediction. After the first `gameTestAct`, check the next observation against that prediction. Keep the tool small and its results short (numbers and compact structures). It disappears with the session unless you created it with `persist: true`, which you should do only when the user asks to keep it.
