import { PluginManager } from "./plugin-manager.ts";
import type { HarnessPlugin } from "./plugin-manager.ts";
import { SkillManager } from "./skill-manager.ts";
import { ToolManager } from "./tool-manager.ts";
import { readFile } from "node:fs/promises";
import { loadSkills, parseSkillMetadata } from "./skill-loader.ts";
import { connectMcpServer } from "./mcp-client.ts";
import type { McpServerConfig } from "./mcp-client.ts";
import type { HarnessPaths } from "./harness-paths.ts";
import { readExtensionSettings, writeExtensionSettings } from "./extension-settings.ts";
import type { ExtensionKind } from "./extension-settings.ts";

// 요청된 설정과 실제 등록 상태를 구분해 실패하거나 소속이 꺼진 항목도 보여준다.
export type ExtensionItem = {
  name: string; description: string; enabled: boolean; active: boolean; owner?: string; error?: string;
};
// TUI는 구현 클래스 대신 목록·토글·스킬 재탐색만 호출한다.
export type ExtensionControls = {
  list(kind: ExtensionKind): ExtensionItem[];
  toggle(kind: ExtensionKind, name: string): Promise<void>;
  reloadSkills(): Promise<void>;
};

// 설정과 플러그인·MCP 수명을 연결하며 코어가 쓰는 매니저 인스턴스는 교체하지 않는다.
export async function createExtensionRuntime(options: {
  paths: HarnessPaths;
  toolManager: ToolManager;
  skillManager: SkillManager;
  plugins: HarnessPlugin[];
  servers: McpServerConfig[];
  connect?: typeof connectMcpServer;
}) {
  const { paths, toolManager, skillManager, plugins, servers, connect = connectMcpServer } = options;
  const store = await readExtensionSettings(paths);
  let settings = store.settings;
  const manager = new PluginManager(toolManager);
  const errors = new Map<string, string>();
  let closing = false;
  let queue: Promise<unknown> = Promise.resolve();
  let disposal: Promise<void> | undefined;
  // 내장 플러그인과 MCP 서버 이름이 같아도 소유권이 충돌하지 않게 한다.
  const owner = (kind: "plugins" | "mcp", name: string) => `${kind}:${name}`;
  // 설정 파일에 직접 기록된 이름만 적용해 Object.prototype의 이름과 혼동하지 않는다.
  const enabled = (kind: ExtensionKind, name: string) => !Object.hasOwn(settings[kind], name) || settings[kind][name] !== false;
  for (const plugin of plugins) manager.register({ ...plugin, name: owner("plugins", plugin.name) });
  for (const server of servers) {
    manager.register({
      name: owner("mcp", server.name), description: `${server.transport} MCP 서버`,
      // 연결과 도구 등록을 하나의 소유 단위로 만들고 실패 시 연결을 남기지 않는다.
      async setup(tools) {
        const connection = await connect(server);
        try { for (const tool of connection.tools) tools.register(tool); }
        catch (error) { await connection.client.close(); throw error; }
        return () => connection.client.close();
      },
    });
  }

  // 디스크의 파일 스킬과 켜진 플러그인의 스킬을 합쳐 완성된 목록을 만든 뒤 한 번에 교체한다.
  async function scanSkills() {
    const next = new SkillManager();
    await loadSkills(next, paths);
    const active = new Set(manager.list().filter((entry) => entry.active).map((entry) => entry.name));
    for (const plugin of plugins) {
      if (!active.has(owner("plugins", plugin.name))) continue;
      for (const location of plugin.skills ?? []) {
        try {
          const skill = parseSkillMetadata(await readFile(location, "utf8"), location);
          if (!skill) continue;
          // 같은 이름은 사용자가 편집하는 파일 스킬을 유지하고 플러그인 스킬을 건너뛴다. 묵시적으로 덮어쓰지 않는다.
          if (next.skills.some((entry) => entry.name === skill.name)) {
            console.warn(`[skills] ${location} 건너뜀: 같은 이름의 스킬이 이미 있습니다 (${skill.name})`);
            continue;
          }
          next.register(skill);
        } catch (error) {
          console.warn(`[skills] ${location} 건너뜀: ${error instanceof Error ? error.message : error}`);
        }
      }
    }
    skillManager.replace(next.skills);
    for (const skill of next.skills) skillManager.setEnabled(skill.name, enabled("skills", skill.name));
  }
  // 시작 실패도 목록에 남겨 사용자가 끄거나 다시 켤 수 있게 한다.
  async function apply(kind: "plugins" | "mcp", name: string) {
    const id = owner(kind, name);
    try {
      if (enabled(kind, name)) await manager.enable(id);
      else await manager.disable(id);
      errors.delete(id);
    } catch (error) {
      errors.set(id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  // 종료와 설정 변경이 겹쳐도 시작한 자원이 정리보다 늦게 남지 않게 한다.
  function change(action: () => Promise<void>) {
    if (closing) return Promise.reject(new Error("확장 기능이 종료 중입니다."));
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  }
  // 보관된 설정과 실제 런타임 상태를 합쳐 화면용 목록을 만든다.
  function list(kind: ExtensionKind): ExtensionItem[] {
    if (kind === "skills") return skillManager.getCatalog().map((skill) => ({
      ...skill, description: `${skill.description} · ${skill.location}`, active: skill.enabled,
    }));
    if (kind === "tools") return toolManager.getCatalog().map((tool) => ({ ...tool, active: tool.active && tool.enabled }));
    const definitions = kind === "plugins" ? plugins : servers.map((server) => ({ name: server.name, description: `${server.transport} MCP 서버` }));
    return definitions.map((definition) => ({
      ...definition, enabled: enabled(kind, definition.name),
      active: manager.list().find((entry) => entry.name === owner(kind, definition.name))?.active ?? false,
      error: errors.get(owner(kind, definition.name)),
    }));
  }
  try {
    for (const [name, value] of Object.entries(settings.tools)) toolManager.setEnabled(name, value);
    for (const plugin of plugins) await apply("plugins", plugin.name);
    // 플러그인 스킬은 활성 상태를 반영해야 하므로 플러그인 적용 뒤에 목록을 만든다.
    await scanSkills();
    for (const server of servers) {
      await apply("mcp", server.name).catch(() => {});
    }
  } catch (error) { await manager.dispose(); throw error; }

  return {
    list,
    // 먼저 설정을 보존한다. 연결 실패 시 켜짐 요청과 실제 실패 상태를 구분해 표시한다.
    toggle(kind: ExtensionKind, name: string) {
      return change(async () => {
        if (!list(kind).some((entry) => entry.name === name)) throw new Error(`알 수 없는 항목: ${name}`);
        const next = { ...settings, [kind]: { ...settings[kind], [name]: !enabled(kind, name) } };
        await writeExtensionSettings(store.path, store.document, next);
        settings = next;
        if (kind === "skills") skillManager.setEnabled(name, enabled(kind, name));
        else if (kind === "tools") toolManager.setEnabled(name, enabled(kind, name));
        else if (kind === "mcp") await apply(kind, name);
        else {
          // 플러그인 활성 상태가 바뀌면(실패로 꺼진 경우 포함) 소유 스킬 노출도 함께 갱신한다.
          try { await apply(kind, name); } finally { await scanSkills(); }
        }
      });
    },
    // 자동 감시는 도입하지 않고 명시적인 명령에서만 파일 목록을 다시 읽는다.
    reloadSkills() { return change(scanSkills); },
    // 진행 중인 토글까지 끝난 뒤 툴·MCP·셸 작업을 함께 정리한다.
    dispose() {
      closing = true;
      return disposal ??= queue.then(() => manager.dispose());
    },
  };
}
