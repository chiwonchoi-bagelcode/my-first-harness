import type { ToolManager, ToolRegistrar } from "./tool-manager.ts";

// 플러그인이 소유한 프로세스·연결을 정리하는 함수다.
export type PluginCleanup = () => void | Promise<void>;
// 이름과 등록 함수, 선택적인 자원 정리 함수와 소유 스킬 파일 경로를 갖는 내장 플러그인 규격이다.
export type HarnessPlugin = {
  name: string;
  description: string;
  setup(tools: ToolRegistrar): void | PluginCleanup | Promise<void | PluginCleanup>;
  // 플러그인이 소유하는 SKILL.md 절대 경로다. 플러그인이 켜져 있는 동안만 스킬 목록에 노출한다.
  skills?: string[];
};
// 한 플러그인의 활성 상태와 정확히 해제할 등록들을 보관한다.
type PluginEntry = {
  plugin: HarnessPlugin;
  active: boolean;
  // 켜는 중이거나 켜져 있는 동안 참. 모델이 만든 툴처럼 setup 뒤에 등록되는 툴도 이 동안만 받는다.
  accepting: boolean;
  cleanup?: PluginCleanup;
  unregister: (() => void)[];
};

// 플러그인 시작·종료를 직렬화하고 등록 소유권과 자원 수명을 관리한다.
export class PluginManager {
  private entries = new Map<string, PluginEntry>();
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private disposal?: Promise<void>;
  private tools: ToolManager;

  // 실제 툴 저장소는 공유하되 플러그인에는 소속이 고정된 등록 API만 준다.
  constructor(privateTools: ToolManager) { this.tools = privateTools; }

  // 등록만으로 setup을 실행하지 않으므로 꺼진 플러그인은 자원을 만들지 않는다.
  register(plugin: HarnessPlugin) {
    if (this.closing) throw new Error("플러그인 관리자가 종료 중입니다.");
    if (this.entries.has(plugin.name)) throw new Error(`중복 플러그인: ${plugin.name}`);
    this.entries.set(plugin.name, { plugin, active: false, accepting: false, unregister: [] });
  }

  // 화면에 보여줄 활성 상태만 반환하고 내부 정리 함수는 노출하지 않는다.
  list() {
    return [...this.entries.values()].map(({ plugin, active }) => ({ name: plugin.name, description: plugin.description, active }));
  }

  // 대기 중인 작업이 실패해도 다음 토글이나 종료는 계속 실행한다.
  private enqueue(action: () => Promise<void>) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }

  // 이름으로 관리 항목을 찾고 잘못된 호출은 즉시 거부한다.
  private entry(name: string) {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`등록되지 않은 플러그인: ${name}`);
    return entry;
  }

  // 새 툴 호출부터 차단한 후 소유 자원을 정리한다. 정리 실패는 재시도할 수 있다.
  private async stop(entry: PluginEntry) {
    entry.accepting = false;
    for (const unregister of entry.unregister.splice(0).reverse()) unregister();
    entry.active = false;
    await entry.cleanup?.();
    entry.cleanup = undefined;
  }

  // setup이 실패하면 해당 시도에서 등록한 툴도 전부 되돌린다.
  enable(name: string) {
    if (this.closing) return Promise.reject(new Error("플러그인 관리자가 종료 중입니다."));
    return this.enqueue(async () => {
      const entry = this.entry(name);
      if (entry.active) return;
      if (entry.cleanup) await this.stop(entry);
      entry.accepting = true;
      const tools: ToolRegistrar = {
        // 소속을 호출자가 바꾸지 못하도록 관리자가 직접 지정한다. 켜져 있는 동안은 setup 뒤에도 등록할 수 있고, 그 등록도 추적되어 끄면 함께 해제된다.
        register: (tool) => {
          if (!entry.accepting) throw new Error("툴은 플러그인이 켜져 있는 동안에만 등록할 수 있습니다.");
          const unregister = this.tools.register(tool, { owner: name });
          entry.unregister.push(unregister);
          return unregister;
        },
      };
      try {
        const cleanup = await entry.plugin.setup(tools);
        entry.cleanup = cleanup || undefined;
        entry.active = true;
      } catch (error) {
        await this.stop(entry);
        throw error;
      }
    });
  }

  // 같은 이름을 여러 번 꺼도 등록 해제와 성공한 자원 정리를 반복하지 않는다.
  disable(name: string) {
    if (this.closing) return Promise.reject(new Error("플러그인 관리자가 종료 중입니다."));
    return this.enqueue(() => this.stop(this.entry(name)));
  }

  // 시작 중인 플러그인까지 기다린 뒤 모든 자원을 정리한다.
  dispose() {
    this.closing = true;
    return this.disposal ??= this.enqueue(async () => {
      const results = await Promise.allSettled([...this.entries.values()].map((entry) => this.stop(entry)));
      const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, "플러그인 정리 실패");
    });
  }
}
