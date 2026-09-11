# Testable game contract

Read this when `gameTestObserve({ format: "text" })` answers "no contract" and you are allowed to edit the game, or when the user asks to make a game text-observable. The game-testing skill (Phase 1, step 5) routes here.

A game is text-observable when its page defines:

```js
window.__gameTest = {
  getState() { return { /* JSON-serializable snapshot of what the player can see */ }; },
  controls: { left: 'ArrowLeft', right: 'ArrowRight', rotateCw: 'ArrowUp', hardDrop: 'Space', start: 'Enter' }, // optional
};
```

The harness knows nothing about the game: it calls `getState()` and forwards the JSON to you as text. Rules for the contract:

- **Visible information only, read-only.** The board or grid, the controlled object, previews shown on screen, HUD numbers, and a `phase` (`"start"` | `"playing"` | `"paused"` | `"over"`). No hidden information (upcoming randomness beyond the visible preview, seeds) and no side effects.
- **Grid games:** the grid as an array of strings, top row first, one character per cell (`.` = empty, one letter or symbol per kind). Include the controlled object's position and orientation or the cells it occupies, and the next preview.
- Keep it compact (well under 65,536 characters); prefer fields to prose.
- `controls` maps action names to key codes so nobody has to guess key names.

To add it to an existing game: read the game's script, find the variables that hold the board, the current piece, the preview and the HUD values, and append the `window.__gameTest = { ... }` definition at the end of the script (after those variables exist), referencing them read-only. Do not change game logic. Games without the contract keep working; the harness answers "no contract" and you use image observation.
