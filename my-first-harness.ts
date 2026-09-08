import "dotenv/config";

import { registerCounterFeature } from "./tools/counter.ts";
import { registerTimeTools } from "./tools/time.ts";
import { registerOtherLLMTools } from "./tools/other-llm.ts";
import { registerFilesystemTools } from "./tools/filesystem.ts";
import { registerShellTools } from "./tools/shell.ts";
import { loadSkills } from "./skill-loader.ts";
import { SkillManager } from "./skill-manager.ts";
import { createHarnessPaths } from "./harness-paths.ts";
import { connectMcpServers, closeMcpServers } from "./mcp-client.ts";
import { createMcpServerConfigs } from "./mcp-servers.ts";
import { createModelAdapter } from "./model-config.ts";
import { ExecutionHistory } from "./execution-history.ts";
import { ToolManager } from "./tool-manager.ts";
import { createAgent } from "./agent.ts";
import { renderCliEvent, runCli } from "./cli.ts";

const paths = createHarnessPaths();
// 기본은 Bakery Farm Luna이며 luna 또는 haiku를 지정하면 AIProxy 연결을 사용한다.
const modelChoice = process.argv[2] ?? "farm";
const token = modelChoice === "farm" ? process.env.BCF_API_KEY : process.env.AIPROXY_TOKEN;
const adapter = createModelAdapter(modelChoice, token);
const history = new ExecutionHistory(paths,
  [process.env.BCF_API_KEY, process.env.AIPROXY_TOKEN].filter((key): key is string => !!key));

const toolManager = new ToolManager();
const skillManager = new SkillManager();

registerCounterFeature(toolManager);
registerTimeTools(toolManager);
registerOtherLLMTools(toolManager, adapter);
registerFilesystemTools(toolManager, adapter.supportsImages);
const shellJobs = registerShellTools(toolManager, paths.workspaceDirectory);
await loadSkills(skillManager, paths);
const mcpClients = await connectMcpServers(toolManager, await createMcpServerConfigs(paths));

const agent = createAgent({
  adapter, toolManager, skillManager, history, paths, onEvent: renderCliEvent,
});

await runCli({
  agent, paths, history, supportsImages: adapter.supportsImages,
  // CLI가 끝날 때 이 실행에서 생성한 셸 작업과 MCP 연결을 함께 정리한다.
  async dispose() {
    const results = await Promise.allSettled([shellJobs.dispose(), closeMcpServers(mcpClients)]);
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "런타임 정리 실패");
  },
});
