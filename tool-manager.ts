import { validateToolArguments } from "./tool-schema.ts";
import type { LLMAdapter, ToolContent, ToolDefinition } from "./llm-types.ts";

// 모듈이 등록하는 툴의 API 정의와 실행 함수다.
export type RegisteredTool = ToolDefinition & {
  execute: (args: any, context?: { llm: LLMAdapter }) => unknown;
};
// 플러그인에는 소속을 지정할 수 없는 등록 API만 전달한다.
export type ToolRegistrar = { register(tool: RegisteredTool): () => void };

// 툴 정의와 실행 함수를 보관하고 호출 인자 검증 및 실행을 담당한다.
export class ToolManager {
  tools: any[] = [];
  private catalog = new Map<string, { tool: RegisteredTool; owner?: string; active: boolean }>();
  private disabled = new Set<string>();

  // 툴의 정의와 실행 함수를 목록에 추가한다.
  register(tool: RegisteredTool, options: { owner?: string } = {}) {
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
    return [...this.catalog.values()].map(({ tool, owner, active }) => ({
      name: tool.name, description: tool.description, owner, active,
      enabled: !this.disabled.has(tool.name),
    }));
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
  async execute(name: string, argumentsJson: string, context?: { llm: LLMAdapter }) {
    if (this.disabled.has(name)) return { content: `툴 요청 오류: 비활성화된 툴입니다: ${name}`, isError: true };
    const tool = this.tools.find((tool) => tool.name === name);

    if (!tool) {
      return { content: `툴 요청 오류: 등록되지 않은 툴입니다: ${name}`, isError: true };
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
