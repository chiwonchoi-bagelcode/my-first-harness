// 실제 모델이 createTool로 툴을 만들고 그 툴을 불러 답하는지 확인하는 연기 테스트(유료).
// 사용법: node tests/custom-tools-smoke.ts [--model haiku|farm|luna|fable]
import "dotenv/config";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../agent.ts";
import { ExecutionHistory } from "../execution-history.ts";
import { createHarnessPaths } from "../harness-paths.ts";
import { createModelAdapter } from "../model-config.ts";
import { ALLOW_ALL } from "../permissions.ts";
import { PluginManager } from "../plugin-manager.ts";
import { createSession } from "../session.ts";
import { SkillManager } from "../skill-manager.ts";
import { ToolManager } from "../tool-manager.ts";
import { createCustomToolsPlugin, ephemeralToolsDirectory } from "../tools/custom-tools.ts";

const args = process.argv.slice(2);
const model = args[args.indexOf("--model") + 1] ?? "haiku";
const token = model === "farm" ? process.env.BCF_API_KEY : process.env.AIPROXY_TOKEN;
assert.ok(token, "모델 키가 없습니다(.env의 AIPROXY_TOKEN 또는 BCF_API_KEY).");

const temporary = await mkdtemp(join(tmpdir(), "harness-custom-tools-smoke-"));
const paths = createHarnessPaths(join(temporary, "project"), join(temporary, "home"));
// 세션 전용 툴은 작업 폴더에 아무것도 쓰지 않으므로 작업 폴더를 직접 만든다(툴 실행의 cwd).
await mkdir(paths.workspaceDirectory, { recursive: true });
const adapter = createModelAdapter(model, token);
const history = new ExecutionHistory(paths, [token]);
const toolManager = new ToolManager();
const plugins = new PluginManager(toolManager);
plugins.register(createCustomToolsPlugin(paths));
await plugins.enable("custom-tools");
const toolCalls: string[] = [];
const agent = createAgent({
  adapter, toolManager, skillManager: new SkillManager(), history, paths, permissions: ALLOW_ALL,
  onEvent(event) {
    const record = event as { type: string; name?: string; arguments?: string; content?: unknown; isError?: boolean };
    if (record.type === "tool-start") { toolCalls.push(record.name ?? "?"); console.log(`[tool] ${record.name} ${(record.arguments ?? "").slice(0, 160)}`); }
    if (record.type === "tool-end" && record.isError) console.log(`[tool-error] ${String(record.content).slice(0, 300)}`);
  },
});
const session = createSession(paths.workspaceDirectory);
const started = performance.now();
try {
  const answer = await agent.turn(session,
    "createTool로 두 정수의 최대공약수를 구하는 툴을 만들어라. 이름은 gcd, 인자는 정수 a와 b, 결과는 최대공약수 숫자. "
    + "만든 뒤 반드시 그 gcd 툴을 불러 gcd(84, 36)을 계산하고, 마지막 답은 결과 숫자만 써라.");
  const elapsed = Math.round(performance.now() - started);
  console.log(`\n[answer] ${answer}`);
  assert.ok(toolCalls.includes("createTool"), "createTool을 부르지 않았습니다.");
  assert.ok(toolCalls.includes("gcd"), "만든 gcd 툴을 부르지 않았습니다.");
  assert.match(answer, /12/);
  // 기본은 세션 전용이라 임시 폴더에 저장된다.
  const meta = JSON.parse(await readFile(join(ephemeralToolsDirectory(), "gcd", "tool.json"), "utf8"));
  assert.equal(meta.name, "gcd");
  const direct = await toolManager.execute("gcd", JSON.stringify({ a: 84, b: 36 }));
  console.log(`[direct] ${JSON.stringify(direct).slice(0, 600)}`);
  assert.equal(direct.isError, undefined, JSON.stringify(direct));
  assert.match(String(direct.content), /12/);
  console.log(JSON.stringify({ model, elapsedMs: elapsed, toolCalls, savedTool: meta.name, directCall: String(direct.content) }, null, 2));
} finally {
  await plugins.dispose();
  await rm(temporary, { recursive: true, force: true });
}
