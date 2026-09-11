#!/usr/bin/env node

import { createBuiltinPlugins } from "./builtin-plugins.ts";
import { createExtensionRuntime } from "./extension-runtime.ts";
import { SkillManager } from "./skill-manager.ts";
import { createHarnessPaths } from "./harness-paths.ts";
import { createMcpServerConfigs } from "./mcp-servers.ts";
import { createModelAdapter } from "./model-config.ts";
import { ExecutionHistory } from "./execution-history.ts";
import { ToolManager } from "./tool-manager.ts";
import { createAgent } from "./agent.ts";
import { renderCliEvent, createCli } from "./cli.ts";
import { loadEnvironment } from "./environment.ts";
import { INTERACTIVE_PERMISSIONS } from "./permissions.ts";

const paths = createHarnessPaths();
loadEnvironment(paths);
// 기본은 Bakery Farm Luna이며 luna, haiku, fable을 지정하면 AIProxy 연결을 사용한다.
const modelChoice = process.argv.slice(2).filter((arg) => arg !== "--tui")[0] ?? "farm";
const token = modelChoice === "farm" ? process.env.BCF_API_KEY : process.env.AIPROXY_TOKEN;
const adapter = createModelAdapter(modelChoice, token);
const history = new ExecutionHistory(paths,
  [process.env.BCF_API_KEY, process.env.AIPROXY_TOKEN].filter((key): key is string => !!key));

// 기본 CLI는 유지하며 --tui일 때만 화면 라이브러리를 로드한다.
const tui = process.argv.includes("--tui") ? (await import("./tui.ts")).createTui() : undefined;
const cli = tui ? undefined : createCli();

const toolManager = new ToolManager();
const skillManager = new SkillManager();
const mcpServers = await createMcpServerConfigs(paths);

const extensions = await createExtensionRuntime({
  paths, toolManager, skillManager,
  plugins: createBuiltinPlugins(paths, adapter), servers: mcpServers,
});
for (const server of extensions.list("mcp")) {
  const transport = mcpServers.find((config) => config.name === server.name)!.transport;
  const count = toolManager.getCatalog().filter((tool) => tool.owner === `mcp:${server.name}` && tool.active).length;
  console.log(`[mcp] ${server.name} (${transport}): ${server.error ? `연결 실패 — ${server.error}` : server.active ? `툴 ${count}개 등록` : "비활성화"}`);
}

const agent = createAgent({
  permissions: INTERACTIVE_PERMISSIONS,
  adapter, toolManager, skillManager, history, paths, onEvent: tui?.onEvent ?? renderCliEvent,
  requestApproval: (request, signal) => (tui ?? cli!).requestApproval(request, signal),
  requestPlanReview: (plan, signal) => (tui ?? cli!).requestPlanReview(plan, signal),
});

const interfaceOptions = {
  agent, paths, history, extensions, supportsImages: adapter.supportsImages,
  // CLI가 끝날 때 이 실행에서 생성한 셸 작업과 MCP 연결을 함께 정리한다.
  async dispose() {
    await extensions.dispose();
  },
};
if (tui) await tui.run({ ...interfaceOptions, model: modelChoice });
else await cli!.run(interfaceOptions);
