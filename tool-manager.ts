import { validateToolArguments } from "./tool-schema.ts";
import type { LLMAdapter, ToolContent, ToolDefinition } from "./llm-types.ts";

// 모듈이 등록하는 툴의 API 정의와 실행 함수다.
export type RegisteredTool = ToolDefinition & {
  execute: (args: any, context?: { llm: LLMAdapter }) => unknown;
};
// 플러그인에는 소속을 지정할 수 없는 등록 API만 전달한다.
export type ToolRegistrar = { register(tool: RegisteredTool): () => void };

// MCP 도구의 전체 정의는 검색 후 다음 요청에 공개한다.
const searchDefinition: ToolDefinition = {
  name: "ToolSearch",
  description: "Find connected MCP tools by name or description. Search with a tool/server name or relevant keywords (prefer English). Matching tools become callable on the next model request. This does not install tools or execute them.",
  parameters: { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false },
};

// 툴 정의와 실행 함수를 보관하고 호출 인자 검증 및 실행을 담당한다.
export class ToolManager {
  tools: any[] = [];
  private catalog = new Map<string, { tool: RegisteredTool; owner?: string; active: boolean }>();
  private disabled = new Set<string>();

  // 툴의 정의와 실행 함수를 목록에 추가한다.
  register(tool: RegisteredTool, options: { owner?: string } = {}) {
    if (tool.name === "ToolSearch") throw new Error("ToolSearch는 하네스 검색용 예약 이름입니다.");
    const previous = this.catalog.get(tool.name);
    if (previous && (previous.active || previous.owner !== options.owner)) {
      throw new Error(`이미 등록된 툴입니다: ${tool.name}`);
    }
    const record = { tool, owner: options.owner, active: true };
    this.catalog.set(tool.name, record);
    this.tools.push(tool);
    // 이 등록만 해제하며 같은 이름으로 나중에 등록된 툴은 건드리지 않는다.
    return () => {
      if (this.catalog.get(tool.name) !== record || !record.active) return;
      record.active = false;
      this.tools = this.tools.filter((entry) => entry !== tool);
    };
  }

  // 개별 툴 설정은 플러그인의 해제·재등록과 독립적으로 유지한다.
  setEnabled(name: string, enabled: boolean) {
    if (enabled) this.disabled.delete(name);
    else this.disabled.add(name);
  }

  // 한 번 발견한 툴은 플러그인이 꺼져도 관리 화면에 남겨 둔다.
  getCatalog() {
    const entries = [...this.catalog.values()].map(({ tool, owner, active }) => ({
      name: tool.name, description: tool.description, owner, active,
      enabled: !this.disabled.has(tool.name),
    }));
    if (this.mcpTools().length) entries.push({ name: "ToolSearch", description: searchDefinition.description,
      owner: undefined, active: true, enabled: !this.disabled.has("ToolSearch") });
    return entries;
  }

  // 활성화된 MCP 도구만 검색 대상으로 삼으며 이름 접두사가 아니라 등록 소유권으로 구분한다.
  private mcpTools() {
    return [...this.catalog.values()].filter(({ tool, owner, active }) =>
      active && owner?.startsWith("mcp:") && !this.disabled.has(tool.name)).map(({ tool }) => tool);
  }

  // 처음에는 MCP 이름만 알려 전체 설명·인자 규격이 컨텍스트를 차지하지 않게 한다.
  getSearchInstructions() {
    if (this.disabled.has("ToolSearch")) return "";
    const names = this.mcpTools().map((tool) => tool.name).sort();
    return names.length ? `Connected MCP tools (names only): ${names.join(", ")}\nUse ToolSearch to load their definitions before calling them.` : "";
  }

  // 내장 도구와 이 세션에서 검색한 MCP 정의만 안정적인 이름 순서로 공개한다.
  getModelDefinitions(discovered: readonly string[]): ToolDefinition[] {
    const deferred = new Set(this.mcpTools().map((tool) => tool.name));
    const definitions = this.getDefinitions().filter((tool) => !deferred.has(tool.name) || discovered.includes(tool.name));
    if (deferred.size && !this.disabled.has("ToolSearch")) definitions.push(searchDefinition);
    return definitions.sort((a, b) => a.name.localeCompare(b.name));
  }

  // 이름·설명을 키워드 검색해 최대 다섯 도구를 세션에 공개하되 실제 실행은 하지 않는다.
  private search(query: string, discovered: string[]) {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return "검색어를 입력하세요.";
    const matches = this.mcpTools().map((tool) => ({ tool, score: terms.reduce((score, term) =>
      score + (tool.name.toLowerCase().includes(term) ? 3 : tool.description.toLowerCase().includes(term) ? 1 : 0), 0) }))
      .filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name)).slice(0, 5);
    for (const { tool } of matches) if (!discovered.includes(tool.name)) discovered.push(tool.name);
    return matches.length ? JSON.stringify({ loaded: matches.map(({ tool }) => ({ name: tool.name, description: tool.description })),
      instruction: "Full argument schemas are available in tools on the next request. Call the tools then." })
      : "일치하는 MCP 도구가 없습니다. 목록의 정확한 이름이나 영어 키워드로 다시 검색하세요.";
  }

  // 모델에게 보낼 이름·설명·인자 규격만 꺼낸다.
  getDefinitions(): ToolDefinition[] {
    return this.tools.filter((tool) => !this.disabled.has(tool.name)).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  // 툴과 인자를 검증한 뒤 실행하고, 호출·실행 오류도 결과로 반환한다.
  async execute(name: string, argumentsJson: string, context?: { llm: LLMAdapter; discoveredTools?: string[] }) {
    if (this.disabled.has(name)) return { content: `툴 요청 오류: 비활성화된 툴입니다: ${name}`, isError: true };
    const tool = name === "ToolSearch" && this.mcpTools().length && context?.discoveredTools
      ? { ...searchDefinition, execute: (args: { query: string }) => this.search(args.query, context.discoveredTools!) }
      : this.tools.find((tool) => tool.name === name);

    if (!tool) {
      return { content: `툴 요청 오류: 등록되지 않은 툴입니다: ${name}`, isError: true };
    }
    if (context?.discoveredTools && this.mcpTools().some((entry) => entry.name === name)
      && !context.discoveredTools.includes(name)) {
      return { content: "먼저 ToolSearch로 해당 MCP 툴의 정의를 로드하세요.", isError: true };
    }

    let arguments_: any;
    try {
      arguments_ = JSON.parse(argumentsJson);
    } catch {
      return { content: "툴 인자 오류: arguments는 올바른 JSON 문자열이어야 합니다.", isError: true };
    }

    const validationError = validateToolArguments(tool.parameters, arguments_);
    if (validationError) return { content: validationError, isError: true };

    try {
      const value = await tool.execute(arguments_, context);
      const content: ToolContent = Array.isArray(value) ? value : String(value);
      return { content };
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : String(error);

      return { content: `툴 실행 오류: ${message}`, isError: true };
    }
  }
}
