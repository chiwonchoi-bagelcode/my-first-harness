---
name: tool-making
description: Build your own tool at runtime with createTool when a task needs the same deterministic computation many times (scoring candidates, simulating a rule system, parsing a format, checking invariants). The tool is saved in the project and becomes an ordinary callable tool on the next step. Use when you notice yourself repeating a calculation, when precision matters more than prose, or when a skill tells you a strategy can be expressed as a deterministic function.
---

# Making your own tools

`createTool` turns a piece of JavaScript you write into a tool you can call like any other. The harness saves it under the project's `.my-first-harness/tools/<name>/`, registers it immediately, and loads it again in later sessions. `deleteTool` removes it.

## When it pays off

- The same deterministic computation is needed on every step (score each candidate move, simulate a rule system, transform a state).
- A precise answer matters more than a fluent one (counting, geometry, exact arithmetic, exhaustive enumeration).
- You would otherwise re-derive the same logic in your head each time, slowly and with mistakes.

Do not build a tool for a one-off calculation; run it once with `runCommand` instead. Do not build tools that need network access, secrets, or interactive input.

## The code contract

```js
// index.mjs — the whole tool is this one default export.
export default async function run(args) {
  // args is the JSON object the caller passed, already validated against your `parameters` schema.
  return { ok: true, score: 42 };   // any JSON-serializable value, or a string
}
```

- Plain JavaScript (ES modules). Node's standard library is available (`import { readFileSync } from "node:fs"` etc.); there are no third-party packages.
- The tool runs in a separate process with the project folder as its working directory. It does not see the harness's environment variables or API keys. Do not rely on them.
- Return the result; do not print it. Anything you `console.log` goes to stderr and is only shown when the run fails.
- Keep results small (they are cut at 16,384 characters). Return numbers and short structures, not dumps.
- Default time limit 30 seconds (`timeoutMs`, up to 300,000). A tool that never returns is killed and reports a timeout.

## Procedure

1. Write the schema first: `parameters` is a JSON Schema object (`type: "object"`, `properties`, `required`). Name every argument clearly; the harness validates calls against it before your code runs.
2. Call `createTool({ name, description, parameters, code })`. The name must be `[a-z][A-Za-z0-9_]*`, at most 40 characters, and not already taken.
3. Test it once with a realistic input before using it for real work. If it fails, the error result contains the exception and stderr; fix the code and call `createTool` again with `replace: true`.
4. Use it. When a result contradicts what you observe afterwards, treat the tool as wrong first: fix and replace it.
5. Delete it with `deleteTool` when it is no longer useful. It disappears with the session anyway unless it was created with `persist: true`.

## Rules

- Tools live only in this session unless you pass `persist: true`. Persist one only when the user asks to keep it; a persisted tool shows up in later sessions, so check that it still fits before relying on it.
- Say briefly why you are building a tool and what it computes; the user sees the tool appear in `/tools`.
- Creating and running your own tools asks for permission in the default mode, like shell commands. Do not work around a denial.
- Keep game or domain knowledge inside the tool's code and description, never in the harness. A tool is yours to write, test, and replace.
