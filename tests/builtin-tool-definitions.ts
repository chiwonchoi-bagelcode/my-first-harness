import { registerCounterFeature } from "../tools/counter.ts";
import { registerTimeTools } from "../tools/time.ts";
import { registerOtherLLMTools } from "../tools/other-llm.ts";
import { registerFilesystemTools } from "../tools/filesystem.ts";
import { registerShellTools } from "../tools/shell.ts";
import type { ToolDefinition } from "../llm-types.ts";

// 메인과 같은 등록 함수를 호출하되 실행 함수는 버리고 실제 기본 툴 정의만 수집한다.
export function builtinToolDefinitions(): ToolDefinition[] {
  const definitions: ToolDefinition[] = [];
  const registry = {
    // 실행 권한 없이 API에 전달할 필드만 수집한다.
    register(tool: ToolDefinition) {
      definitions.push({ name: tool.name, description: tool.description, parameters: tool.parameters });
    },
  };
  registerCounterFeature(registry);
  registerTimeTools(registry);
  registerOtherLLMTools(registry, {
    // 정의 수집 중에는 LLM을 호출할 수 없다.
    async generate() { throw new Error("정의 수집 중 LLM 실행 금지"); },
  });
  registerFilesystemTools(registry, true);
  registerShellTools(registry);
  return definitions;
}
