import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManager } from "../plugin-manager.ts";
import { ToolManager } from "../tool-manager.ts";
import { SkillManager } from "../skill-manager.ts";
import { createExtensionRuntime } from "../extension-runtime.ts";
import { createHarnessPaths } from "../harness-paths.ts";
import { readExtensionSettings } from "../extension-settings.ts";
import { createBuiltinPlugins } from "../builtin-plugins.ts";
import { createMcpServerConfigs } from "../mcp-servers.ts";
import type { LLMAdapter } from "../llm-types.ts";
import type { RegisteredTool, ToolRegistrar } from "../tool-manager.ts";
import type { connectMcpServer } from "../mcp-client.ts";

// 등록과 실행을 구분해서 검사할 작은 툴을 만든다.
function tool(name: string, execute = () => "ok"): RegisteredTool {
  return { name, description: name, parameters: { type: "object", properties: {} }, execute };
}

test("플러그인 등록은 실행하지 않고 활성화·해제·개별 off가 소유권을 보존한다", async () => {
  const tools = new ToolManager();
  const manager = new PluginManager(tools);
  let setups = 0;
  let cleanups = 0;
  let runs = 0;
  let savedRegistrar: ToolRegistrar | undefined;
  manager.register({ name: "counter", description: "테스트", setup(registrar) {
    setups++;
    savedRegistrar = registrar;
    registrar.register(tool("up", () => String(++runs)));
    registrar.register(tool("value"));
    return () => { cleanups++; };
  } });
  assert.equal(setups, 0);
  await Promise.all([manager.enable("counter"), manager.enable("counter")]);
  assert.equal(setups, 1);
  assert.throws(() => savedRegistrar!.register(tool("late")), /setup/);
  assert.equal((await tools.execute("up", "{}")).content, "1");
  tools.setEnabled("up", false);
  assert.equal(tools.getDefinitions().length, 1);
  assert.equal((await tools.execute("up", "{}")).isError, true);
  assert.equal(runs, 1);
  await manager.disable("counter");
  await manager.disable("counter");
  assert.equal(cleanups, 1);
  assert.equal(tools.getDefinitions().length, 0);
  assert.equal(tools.getCatalog().length, 2);
  await manager.enable("counter");
  assert.deepEqual(tools.getDefinitions().map((item) => item.name), ["value"]);
  tools.setEnabled("up", true);
  assert.equal((await tools.execute("up", "{}")).content, "2");
  await Promise.all([manager.dispose(), manager.dispose()]);
  assert.equal(cleanups, 2);
});

test("setup 중복 이름·실패는 자기 등록만 되돌리고 오래된 해제 함수는 재등록을 지우지 않는다", async () => {
  const tools = new ToolManager();
  const manager = new PluginManager(tools);
  tools.register(tool("existing"));
  manager.register({ name: "broken", description: "실패", setup(registrar) {
    registrar.register(tool("partial"));
    registrar.register(tool("existing"));
  } });
  await assert.rejects(manager.enable("broken"), /이미 등록/);
  assert.deepEqual(tools.getDefinitions().map((entry) => entry.name), ["existing"]);
  const unregister = tools.register(tool("reusable"), { owner: "one" });
  unregister();
  tools.register(tool("reusable"), { owner: "one" });
  unregister();
  assert.ok(tools.getDefinitions().some((entry) => entry.name === "reusable"));
  await manager.dispose();
});

test("종료가 setup 도중 요청돼도 끝난 뒤 정리하고 새 활성화는 거부한다", async () => {
  const tools = new ToolManager();
  const manager = new PluginManager(tools);
  const gate = Promise.withResolvers<void>();
  let cleanups = 0;
  manager.register({ name: "slow", description: "대기", async setup(registrar) {
    await gate.promise;
    registrar.register(tool("slow"));
    return () => { cleanups++; };
  } });
  const starting = manager.enable("slow");
  const closing = manager.dispose();
  await assert.rejects(manager.enable("slow"), /종료 중/);
  gate.resolve();
  await Promise.all([starting, closing]);
  assert.equal(cleanups, 1);
  assert.deepEqual(tools.getDefinitions(), []);
});

test("프로젝트 설정 저장·재시작과 스킬 hot reload가 삭제·수정·off를 반영한다", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-extensions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = createHarnessPaths(directory, join(directory, "home"));
  const skillDir = join(paths.projectSkillsDirectory, "sample");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "---\nname: sample\ndescription: first\n---\nsecret-body");
  await writeFile(join(paths.projectHarnessDirectory, "settings.json"), JSON.stringify({ unrelated: "preserve" }));
  const toolManager = new ToolManager();
  const skillManager = new SkillManager();
  const plugins = [{ name: "test", description: "테스트", setup(registrar: ToolRegistrar) { registrar.register(tool("example")); } }];
  const runtime = await createExtensionRuntime({ paths, toolManager, skillManager, plugins, servers: [] });
  t.after(() => runtime.dispose());
  assert.match(skillManager.getInstructions().join(""), /first/);
  assert.doesNotMatch(skillManager.getInstructions().join(""), /secret-body/);
  await runtime.toggle("tools", "example");
  await runtime.toggle("plugins", "test");
  await runtime.toggle("skills", "sample");
  assert.deepEqual(skillManager.getInstructions(), []);
  await writeFile(join(skillDir, "SKILL.md"), "---\nname: sample\ndescription: second\n---\nbody");
  await runtime.reloadSkills();
  await runtime.reloadSkills();
  assert.equal(runtime.list("skills").length, 1);
  assert.equal(runtime.list("skills")[0].enabled, false);
  assert.match(runtime.list("skills")[0].description, /second/);
  const persisted = JSON.parse(await readFile(join(paths.projectHarnessDirectory, "settings.json"), "utf8"));
  assert.equal(persisted.unrelated, "preserve");
  assert.equal(persisted.extensions.plugins.test, false);
  await runtime.dispose();
  const restoredTools = new ToolManager();
  const restored = await createExtensionRuntime({ paths, toolManager: restoredTools, skillManager: new SkillManager(), plugins, servers: [] });
  t.after(() => restored.dispose());
  assert.equal(restored.list("plugins")[0].active, false);
  assert.deepEqual(restoredTools.getDefinitions(), []);
  await restored.toggle("plugins", "test");
  assert.equal(restored.list("tools")[0].enabled, false);
  assert.equal((await restoredTools.execute("example", "{}")).isError, true);
  await restored.toggle("tools", "example");
  assert.equal((await restoredTools.execute("example", "{}")).content, "ok");
  await rm(skillDir, { recursive: true });
  await restored.reloadSkills();
  assert.deepEqual(restored.list("skills"), []);
});

test("MCP 서버 토글은 연결·등록을 함께 바꾸며 실패 설정은 실제 연결과 구별한다", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-mcp-toggle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = createHarnessPaths(directory, join(directory, "home"));
  let connected = 0;
  let closed = 0;
  let fail = false;
  const tools = new ToolManager();
  // 실제 SDK 연결 대신 연결·종료 횟수와 원격 툴 정의를 검증한다.
  const connect = async (server: Parameters<typeof connectMcpServer>[0]) => {
    if (fail) throw new Error("offline");
    connected++;
    return { server, client: { async close() { closed++; } }, tools: [tool("mcp__demo__echo")] } as unknown as Awaited<ReturnType<typeof connectMcpServer>>;
  };
  const runtime = await createExtensionRuntime({ paths, toolManager: tools, skillManager: new SkillManager(), plugins: [],
    servers: [{ name: "demo", transport: "http", url: "https://example.invalid" }], connect });
  t.after(() => runtime.dispose());
  assert.equal(connected, 1);
  await runtime.toggle("tools", "mcp__demo__echo");
  await runtime.toggle("mcp", "demo");
  assert.equal(closed, 1);
  fail = true;
  await assert.rejects(runtime.toggle("mcp", "demo"), /offline/);
  assert.equal(runtime.list("mcp")[0].enabled, true);
  assert.equal(runtime.list("mcp")[0].active, false);
  assert.equal(runtime.list("mcp")[0].error, "offline");
  assert.deepEqual(tools.getDefinitions(), []);
  await runtime.toggle("mcp", "demo");
  fail = false;
  await runtime.toggle("mcp", "demo");
  assert.equal(connected, 2);
  assert.equal(runtime.list("tools")[0].enabled, false);
  assert.equal(runtime.list("tools")[0].active, false);
  await runtime.dispose();
  assert.equal(closed, 2);
});

test("실제 stdio MCP를 껐다 켜면 툴 호출이 차단되고 새 연결에서 다시 실행된다", { timeout: 25000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-real-mcp-toggle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = createHarnessPaths(directory, join(directory, "home"));
  const server = (await createMcpServerConfigs(paths)).find((entry) => entry.name === "memory")!;
  const toolManager = new ToolManager();
  const runtime = await createExtensionRuntime({ paths, toolManager, skillManager: new SkillManager(), plugins: [], servers: [server] });
  t.after(() => runtime.dispose());
  assert.equal(runtime.list("mcp")[0].active, true);
  assert.equal((await toolManager.execute("mcp__memory__read_graph", "{}")).isError, undefined);
  await runtime.toggle("mcp", "memory");
  assert.equal((await toolManager.execute("mcp__memory__read_graph", "{}")).isError, true);
  await runtime.toggle("mcp", "memory");
  assert.equal(runtime.list("mcp")[0].active, true);
  assert.equal((await toolManager.execute("mcp__memory__read_graph", "{}")).isError, undefined);
});

test("셸 플러그인을 끄면 실제 백그라운드 자식이 종료되고 다시 켜면 새 목록을 쓴다", { timeout: 15000 }, async () => {
  const toolManager = new ToolManager();
  const manager = new PluginManager(toolManager);
  const shell = createBuiltinPlugins(createHarnessPaths(), { supportsImages: false } as LLMAdapter).find((plugin) => plugin.name === "shell")!;
  manager.register(shell);
  try {
    await manager.enable("shell");
    const result = await toolManager.execute("runCommand", JSON.stringify({ command: `${JSON.stringify(process.execPath)} -e 'console.log(process.pid); setInterval(() => {}, 1000)'`, background: true }));
    assert.equal(result.isError, undefined);
    const job = JSON.parse(result.content as string);
    const snapshot = JSON.parse((await toolManager.execute("readJob", JSON.stringify({ jobId: job.jobId, waitMs: 1000 }))).content as string);
    const pid = Number(snapshot.stdout.trim());
    assert.ok(pid > 0);
    await manager.disable("shell");
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    assert.equal((await toolManager.execute("listJobs", "{}")).isError, true);
    await manager.enable("shell");
    assert.equal((await toolManager.execute("listJobs", "{}")).content, "[]");
  } finally { await manager.dispose(); }
});

test("잘못된 설정은 조용히 무시하거나 덮어쓰지 않는다", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-bad-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = createHarnessPaths(directory, join(directory, "home"));
  await mkdir(paths.projectHarnessDirectory);
  await writeFile(join(paths.projectHarnessDirectory, "settings.json"), '{"extensions":{"tools":{"x":"false"}}}');
  await assert.rejects(readExtensionSettings(paths), /boolean/);
});

test("플러그인 소유 스킬은 켜진 동안만 노출되고 같은 이름의 파일 스킬을 덮어쓰지 않는다", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-plugin-skills-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = createHarnessPaths(directory, join(directory, "home"));
  // 플러그인이 배포하는 스킬 파일 셋: 정상 하나, 파일 스킬과 이름이 겹치는 하나, frontmatter가 없는 하나.
  const pluginSkills = join(directory, "plugin-skills");
  for (const [name, description] of [["game-play", "plugin skill"], ["sample", "plugin duplicate"]]) {
    await mkdir(join(pluginSkills, name), { recursive: true });
    await writeFile(join(pluginSkills, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nbody`);
  }
  await mkdir(join(pluginSkills, "broken"), { recursive: true });
  await writeFile(join(pluginSkills, "broken", "SKILL.md"), "no frontmatter");
  const fileSkill = join(paths.projectSkillsDirectory, "sample");
  await mkdir(fileSkill, { recursive: true });
  await writeFile(join(fileSkill, "SKILL.md"), "---\nname: sample\ndescription: file skill\n---\nbody");
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message: unknown) => { warnings.push(String(message)); };
  t.after(() => { console.warn = warn; });
  let fail = false;
  const skillManager = new SkillManager();
  const plugins = [{ name: "game", description: "테스트", setup(registrar: ToolRegistrar) {
    if (fail) throw new Error("setup failed");
    registrar.register(tool("play"));
  }, skills: ["game-play", "sample", "broken"].map((name) => join(pluginSkills, name, "SKILL.md")) }];
  const runtime = await createExtensionRuntime({ paths, toolManager: new ToolManager(), skillManager, plugins, servers: [] });
  t.after(() => runtime.dispose());
  const names = () => runtime.list("skills").map((skill) => skill.name).sort();
  assert.deepEqual(names(), ["game-play", "sample"]);
  assert.match(runtime.list("skills").find((skill) => skill.name === "sample")!.description, /file skill/);
  assert.equal(warnings.filter((line) => /같은 이름/.test(line)).length, 1);
  assert.equal(warnings.filter((line) => /broken/.test(line)).length, 1);
  // 개별 스킬 off는 플러그인 스킬에도 적용되며 플러그인의 툴은 그대로 켜져 있다.
  await runtime.toggle("skills", "game-play");
  assert.doesNotMatch(skillManager.getInstructions().join(""), /game-play/);
  assert.equal(runtime.list("tools").find((entry) => entry.name === "play")!.active, true);
  // 플러그인을 끄면 소유 스킬만 사라지고 재검색도 되살리지 않는다.
  await runtime.toggle("plugins", "game");
  assert.deepEqual(names(), ["sample"]);
  await runtime.reloadSkills();
  assert.deepEqual(names(), ["sample"]);
  // 켜기에 실패하면 설정은 켜짐이지만 스킬은 노출하지 않는다.
  fail = true;
  await assert.rejects(runtime.toggle("plugins", "game"), /setup failed/);
  assert.equal(runtime.list("plugins")[0].enabled, true);
  assert.equal(runtime.list("plugins")[0].active, false);
  assert.deepEqual(names(), ["sample"]);
  // 다시 켜면 돌아오고 개별 off 설정은 유지된다.
  fail = false;
  await runtime.toggle("plugins", "game");
  await runtime.toggle("plugins", "game");
  assert.deepEqual(names(), ["game-play", "sample"]);
  assert.equal(runtime.list("skills").find((skill) => skill.name === "game-play")!.enabled, false);
});
