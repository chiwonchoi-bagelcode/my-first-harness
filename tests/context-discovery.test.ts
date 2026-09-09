import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "../session.ts";
import { readProjectInstructions } from "../project-instructions.ts";
import { loadSession, saveSession } from "../session-store.ts";
import { createHarnessPaths } from "../harness-paths.ts";
import { createAgent } from "../agent.ts";
import { createTuiSession } from "../tui-session.ts";
import { ToolManager } from "../tool-manager.ts";
import { SkillManager } from "../skill-manager.ts";
import { compactSession } from "../context-manager.ts";
import type { LLMAdapter, LLMResult, LLMRequest } from "../llm-types.ts";
import type { HistorySink } from "../execution-history.ts";

// 테스트 중 실제 실행 로그를 디스크에 생성하지 않는다.
const history: HistorySink = { async append() {}, async flush() {} };
// 단일 툴 요청을 반환하는 모의 모델 결과다.
function call(name: string, args: object): LLMResult {
  return { stopReason: "tool-calls", message: { role: "assistant", content: [
    { type: "tool-call", id: name, name, arguments: JSON.stringify(args) },
  ] } };
}
// 정상적인 턴 종료 결과를 만든다.
function done(): LLMResult {
  return { stopReason: "stop", message: { role: "assistant", content: [{ type: "text", text: "완료" }] } };
}

test("AGENTS.md는 시작 시 스냅샷으로 읽고 압축 대상에서 제외하며 resume에서 유지한다", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "instructions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = createHarnessPaths(root, root);
  const file = join(root, "AGENTS.md");
  assert.equal(readProjectInstructions(root), "");
  await writeFile(file, "PROJECT_RULE_ORIGINAL");
  const session = createSession(root);
  await writeFile(file, "PROJECT_RULE_CHANGED");
  const requests: LLMRequest[] = [];
  const agent = createAgent({ paths, history, skillManager: new SkillManager(), toolManager: new ToolManager(),
    adapter: { async generate(request) { requests.push(structuredClone(request)); return done(); } },
    async saveSession() {},
  });
  await agent.turn(session, "작업 기록 ".repeat(500));
  await agent.turn(session, "다음");
  assert.equal(requests[0].messages[0].role, "user");
  assert.match(JSON.stringify(requests[0].messages[0]), /PROJECT_RULE_ORIGINAL/);
  assert.deepEqual(requests[0].messages[0], requests[1].messages[0]);
  assert.equal(JSON.stringify(requests[1]).split("PROJECT_RULE_ORIGINAL").length - 1, 1);
  await compactSession(session, async (messages) => {
    assert.doesNotMatch(JSON.stringify(messages), /PROJECT_RULE/);
    return "요약";
  });
  assert.equal(session.projectInstructions, "PROJECT_RULE_ORIGINAL");
  session.discoveredTools.push("mcp_example");
  await saveSession(session, paths);
  assert.deepEqual(await loadSession(session.id, paths), session);
  await agent.turn(session, "계속");
  assert.match(JSON.stringify(requests.at(-1)?.messages[0]), /PROJECT_RULE_ORIGINAL/);
  assert.deepEqual(createSession(root).discoveredTools, []);
});

test("TUI 명시적 갱신은 다음 요청부터 적용하고 삭제된 파일은 지침을 비운다", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "instructions-ui-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "AGENTS.md");
  await writeFile(file, "old");
  const seen: string[] = [];
  const ui = createTuiSession({ paths: createHarnessPaths(root, root), history, model: "test",
    agent: { interrupt() { return false; }, async turn(session) { seen.push(session.projectInstructions); return "ok"; }, async compact() {} },
    async saveSession() {}, async dispose() {},
  });
  await ui.start();
  await writeFile(file, "new");
  await ui.submit("before");
  await ui.submit("/reload-instructions");
  await ui.submit("after");
  await rm(file);
  await ui.submit("/reload-instructions");
  await ui.submit("empty");
  assert.deepEqual(seen, ["old", "new", ""]);
  await ui.close();
});

test("ToolSearch가 실행 없이 MCP를 세션에 공개하고 다음 step에서 실제 호출한다", async () => {
  const tools = new ToolManager();
  let executed = 0;
  tools.register({ name: "browser_screenshot", description: "Capture browser screenshot", parameters: { type: "object", properties: {} },
    execute() { executed++; return "picture"; } }, { owner: "mcp:browser" });
  tools.register({ name: "readTextFile", description: "Read", parameters: { type: "object", properties: {} }, execute() { return "text"; } });
  const session = createSession("/nonexistent-test-workspace");
  const requests: LLMRequest[] = [];
  const adapter: LLMAdapter = { async generate(request) {
    requests.push(structuredClone(request));
    if (requests.length === 1) return call("ToolSearch", { query: "screenshot" });
    if (requests.length === 2) { assert.equal(executed, 0); return call("browser_screenshot", {}); }
    return done();
  } };
  const agent = createAgent({ adapter, toolManager: tools, skillManager: new SkillManager(), history,
    paths: createHarnessPaths("/nonexistent-test-workspace", "/test-home"), async saveSession() {} });
  await agent.turn(session, "화면 확인");
  assert.deepEqual(requests[0].tools.map((tool) => tool.name), ["readTextFile", "ToolSearch"].sort((a, b) => a.localeCompare(b)));
  assert.ok(requests[1].tools.some((tool) => tool.name === "browser_screenshot"));
  assert.equal(executed, 1);
  assert.deepEqual(session.discoveredTools, ["browser_screenshot"]);
  assert.equal(tools.getModelDefinitions([]).some((tool) => tool.name === "browser_screenshot"), false);
  tools.setEnabled("browser_screenshot", false);
  assert.equal(tools.getModelDefinitions(session.discoveredTools).some((tool) => tool.name === "browser_screenshot"), false);
  assert.equal((await tools.execute("browser_screenshot", "{}", { llm: adapter, discoveredTools: session.discoveredTools })).isError, true);
});

test("검색은 빈값·잘못된 인자를 거부하고 비활성화·해제된 MCP를 제외한다", async () => {
  const tools = new ToolManager();
  const adapter: LLMAdapter = { async generate() { return done(); } };
  const discoveredTools: string[] = [];
  const context = { llm: adapter, discoveredTools };
  const removes: (() => void)[] = [];
  for (let i = 0; i < 8; i++) removes.push(tools.register({ name: `sample_${i}`, description: "sample", parameters: { type: "object" }, execute() { return "ok"; } }, { owner: "mcp:sample" }));
  assert.equal((await tools.execute("sample_0", "{}", context)).isError, true);
  assert.equal((await tools.execute("ToolSearch", '{"query":2}', context)).isError, true);
  assert.equal((await tools.execute("ToolSearch", '{"query":""}', context)).isError, true);
  tools.setEnabled("sample_0", false);
  removes[1]();
  await tools.execute("ToolSearch", '{"query":"sample"}', context);
  assert.equal(discoveredTools.length, 5);
  assert.ok(!discoveredTools.includes("sample_0") && !discoveredTools.includes("sample_1"));
  tools.setEnabled("ToolSearch", false);
  assert.equal((await tools.execute("ToolSearch", '{"query":"sample"}', context)).isError, true);
  assert.equal(tools.getSearchInstructions(), "");
  assert.throws(() => tools.register({ name: "ToolSearch", description: "", parameters: {}, execute() {} }), /예약/);
});
