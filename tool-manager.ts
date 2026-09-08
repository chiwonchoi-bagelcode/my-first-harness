import { validateToolArguments } from "./tool-schema.ts";
import type { LLMAdapter, ToolContent, ToolDefinition } from "./llm-types.ts";

// 툴 정의와 실행 함수를 보관하고 호출 인자 검증 및 실행을 담당한다.
export class ToolManager {
  tools: any[] = [];

  // 툴의 정의와 실행 함수를 목록에 추가한다.
  register(tool: any) {
    this.tools.push(tool);
  }

  // 모델에게 보낼 이름·설명·인자 규격만 꺼낸다.
  getDefinitions(): ToolDefinition[] {
    return this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  // 툴과 인자를 검증한 뒤 실행하고, 호출·실행 오류도 결과로 반환한다.
  async execute(name: string, argumentsJson: string, context?: { llm: LLMAdapter }) {
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
