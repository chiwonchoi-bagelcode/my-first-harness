import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCustomToolsPlugin, customToolsDirectory } from "../tools/custom-tools.ts";
import { createHarnessPaths } from "../harness-paths.ts";
import { PluginManager } from "../plugin-manager.ts";
import { ToolManager } from "../tool-manager.ts";
import type { HarnessPlugin } from "../plugin-manager.ts";
import type { ToolRegistrar } from "../tool-manager.ts";

const ADDER = "export default async function run({ a, b }) { return { sum: a + b }; }";
const ADDER_SCHEMA = { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] };

// 임시 작업 폴더에 플러그인 관리자로 custom-tools를 켠 상태를 만든다.
async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), "harness-custom-tools-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = createHarnessPaths(directory, join(directory, "home"));
  const manager = new ToolManager();
  const plugins = new PluginManager(manager);
  plugins.register(createCustomToolsPlugin(paths));
  await plugins.enable("custom-tools");
  t.after(() => plugins.dispose());
  return { directory, paths, manager, plugins };
}
const text = (result: { content: unknown }) => String(result.content);
const names = (manager: ToolManager) => manager.getDefinitions().map((tool) => tool.name).sort();

test("createTool은 코드를 저장하고 바로 등록해 다음 호출에서 자식 프로세스로 실행되며 인자 검증은 ToolManager가 한다", async (t) => {
  const { paths, manager } = await fixture(t);
  assert.deepEqual(names(manager), ["createTool", "deleteTool"]);
  const created = await manager.execute("createTool", JSON.stringify({ name: "adder", description: "두 수의 합", parameters: ADDER_SCHEMA, code: ADDER }));
  assert.equal(created.isError, undefined, text(created));
  const info = JSON.parse(text(created));
  assert.equal(info.name, "adder");
  assert.equal(info.persist, false);
  assert.ok(!info.path.startsWith(customToolsDirectory(paths)), "기본은 세션 전용이라 프로젝트 폴더에 저장하지 않는다.");
  assert.deepEqual(names(manager), ["adder", "createTool", "deleteTool"]);
  const run = await manager.execute("adder", JSON.stringify({ a: 1, b: 2 }));
  assert.equal(run.isError, undefined, text(run));
  assert.deepEqual(JSON.parse(text(run)), { sum: 3 });
  const invalid = await manager.execute("adder", JSON.stringify({ a: 1 }));
  assert.equal(invalid.isError, true);
  assert.match(text(invalid), /툴 인자 오류/);
  const meta = JSON.parse(await readFile(join(info.path, "tool.json"), "utf8"));
  assert.equal(meta.description, "두 수의 합");
  assert.equal(meta.timeoutMs, 30_000);
  assert.equal(await readFile(join(info.path, "index.mjs"), "utf8"), ADDER);
});

test("잘못된 이름·스키마·default export 없는 코드·예약 이름은 만들기 전에 거절한다", async (t) => {
  const { manager } = await fixture(t);
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ name: "Bad Name", description: "x", parameters: ADDER_SCHEMA, code: ADDER }, /툴 인자 오류/],
    [{ name: "strschema", description: "x", parameters: { type: "string" }, code: ADDER }, /type이 "object"/],
    [{ name: "broken", description: "x", parameters: { type: "object", properties: { a: { type: "nonsense" } } }, code: ADDER }, /스키마 오류/],
    [{ name: "noexport", description: "x", parameters: ADDER_SCHEMA, code: "function run() {}" }, /default export/],
    [{ name: "createTool", description: "x", parameters: ADDER_SCHEMA, code: ADDER }, /예약된 이름|툴 인자 오류|이미 등록/],
  ];
  for (const [args, pattern] of cases) {
    const result = await manager.execute("createTool", JSON.stringify(args));
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(text(result), pattern);
  }
  assert.deepEqual(names(manager), ["createTool", "deleteTool"], "실패한 시도는 아무것도 남기지 않는다.");
});

test("같은 이름은 replace로만 바꾸고, 지우면 목록과 폴더에서 사라진다", async (t) => {
  const { manager } = await fixture(t);
  const calc = JSON.parse(text(await manager.execute("createTool", JSON.stringify({ name: "calc", description: "합", parameters: ADDER_SCHEMA, code: ADDER }))));
  const duplicate = await manager.execute("createTool", JSON.stringify({ name: "calc", description: "차", parameters: ADDER_SCHEMA, code: ADDER }));
  assert.equal(duplicate.isError, true);
  assert.match(text(duplicate), /replace: true/);
  const replaced = await manager.execute("createTool", JSON.stringify({ name: "calc", description: "차", parameters: ADDER_SCHEMA, replace: true,
    code: "export default async function run({ a, b }) { return a - b; }" }));
  assert.equal(replaced.isError, undefined, text(replaced));
  assert.equal(JSON.parse(text(replaced)).replaced, true);
  assert.equal(text(await manager.execute("calc", JSON.stringify({ a: 5, b: 2 }))), "3");
  assert.deepEqual(names(manager), ["calc", "createTool", "deleteTool"]);
  const deleted = await manager.execute("deleteTool", JSON.stringify({ name: "calc" }));
  assert.equal(deleted.isError, undefined, text(deleted));
  assert.deepEqual(names(manager), ["createTool", "deleteTool"]);
  await assert.rejects(stat(calc.path));
  const again = await manager.execute("deleteTool", JSON.stringify({ name: "calc" }));
  assert.equal(again.isError, true);
  assert.match(text(again), /없습니다/);
});

test("툴 코드는 하네스의 환경 변수를 보지 못하고 작업 폴더에서 돌며, 예외와 시간 초과는 안내와 함께 오류로 돌아온다", async (t) => {
  const { directory, manager } = await fixture(t);
  process.env.CUSTOM_TOOL_SECRET_TEST = "secret";
  t.after(() => { delete process.env.CUSTOM_TOOL_SECRET_TEST; });
  await manager.execute("createTool", JSON.stringify({ name: "peek", description: "환경 확인", parameters: { type: "object", properties: {} },
    code: "export default async function run() { return { secret: process.env.CUSTOM_TOOL_SECRET_TEST ?? null, cwd: process.cwd(), toolDir: process.env.TOOL_DIR }; }" }));
  const peek = JSON.parse(text(await manager.execute("peek", "{}")));
  assert.equal(peek.secret, null, "하네스 프로세스의 환경 변수가 넘어가면 안 된다.");
  // macOS의 임시 폴더는 심볼릭 링크라 실제 경로로 비교한다.
  assert.equal(await realpath(peek.cwd), await realpath(directory));
  assert.match(peek.toolDir, /peek$/);

  await manager.execute("createTool", JSON.stringify({ name: "boom", description: "예외", parameters: { type: "object", properties: {} },
    code: "export default async function run() { throw new Error('계산 불가'); }" }));
  const failed = await manager.execute("boom", "{}");
  assert.equal(failed.isError, true);
  assert.match(text(failed), /툴 코드가 실패했습니다: Error: 계산 불가[\s\S]*replace: true/);

  await manager.execute("createTool", JSON.stringify({ name: "spin", description: "무한 루프", parameters: { type: "object", properties: {} }, timeoutMs: 1000,
    code: "export default async function run() { while (true) {} }" }));
  const started = performance.now();
  const timedOut = await manager.execute("spin", "{}");
  assert.equal(timedOut.isError, true);
  assert.match(text(timedOut), /1000ms 안에 끝나지 않아/);
  assert.ok(performance.now() - started < 5_000, "시간 제한 직후 돌아와야 한다.");

  await manager.execute("createTool", JSON.stringify({ name: "noisy", description: "표준 출력에 직접 씀", parameters: { type: "object", properties: {} },
    code: "export default async function run() { console.log('hello'); return 'ok'; }" }));
  const noisy = await manager.execute("noisy", "{}");
  assert.equal(noisy.isError, undefined, "console.log는 stderr로 가므로 결과를 깨뜨리지 않는다.");
  assert.equal(text(noisy), "ok");
});

test("persist: true인 툴만 플러그인을 다시 켤 때 다시 등록되고, 세션 전용 툴은 끄면 폴더까지 사라지며, 새 관리자에서도 영구 툴만 살아난다", async (t) => {
  const { paths, manager, plugins } = await fixture(t);
  const persisted = JSON.parse(text(await manager.execute("createTool", JSON.stringify({ name: "adder", description: "합", parameters: ADDER_SCHEMA, code: ADDER, persist: true }))));
  assert.equal(persisted.path, join(customToolsDirectory(paths), "adder"));
  const temporary = JSON.parse(text(await manager.execute("createTool", JSON.stringify({ name: "temp", description: "임시", parameters: ADDER_SCHEMA, code: ADDER }))));
  assert.deepEqual(names(manager), ["adder", "createTool", "deleteTool", "temp"]);
  await plugins.disable("custom-tools");
  assert.deepEqual(names(manager), []);
  await assert.rejects(stat(temporary.path), "세션 전용 툴의 폴더는 플러그인이 꺼질 때 지운다.");
  await plugins.enable("custom-tools");
  assert.deepEqual(names(manager), ["adder", "createTool", "deleteTool"], "영구 툴만 돌아온다.");
  assert.deepEqual(JSON.parse(text(await manager.execute("adder", JSON.stringify({ a: 2, b: 2 })))), { sum: 4 });

  const freshManager = new ToolManager();
  const freshPlugins = new PluginManager(freshManager);
  freshPlugins.register(createCustomToolsPlugin(paths));
  await freshPlugins.enable("custom-tools");
  t.after(() => freshPlugins.dispose());
  assert.deepEqual(names(freshManager), ["adder", "createTool", "deleteTool"]);
});

test("플러그인은 켜져 있는 동안 setup 뒤에도 툴을 등록할 수 있고, 그 등록은 끄면 함께 해제되며, 끈 뒤 등록은 거절된다", async (t) => {
  const manager = new ToolManager();
  const plugins = new PluginManager(manager);
  let late: ToolRegistrar | undefined;
  const plugin: HarnessPlugin = { name: "late", description: "늦은 등록", setup(tools) { late = tools; } };
  plugins.register(plugin);
  await plugins.enable("late");
  t.after(() => plugins.dispose());
  late!.register({ name: "lateTool", description: "d", parameters: { type: "object", properties: {} }, execute: async () => "ok" });
  assert.deepEqual(names(manager), ["lateTool"]);
  assert.equal(text(await manager.execute("lateTool", "{}")), "ok");
  await plugins.disable("late");
  assert.deepEqual(names(manager), []);
  assert.throws(() => late!.register({ name: "afterStop", description: "d", parameters: { type: "object", properties: {} }, execute: async () => "x" }), /켜져 있는 동안에만/);
});
