import { createAgent } from "../../agent.ts";
import { createTui } from "../../tui.ts";
import { ToolManager } from "../../tool-manager.ts";
import { SkillManager } from "../../skill-manager.ts";
import { createHarnessPaths } from "../../harness-paths.ts";
import { ExecutionHistory } from "../../execution-history.ts";
import { registerShellTools } from "../../tools/shell.ts";
import type { LLMAdapter } from "../../llm-types.ts";

// 호출자가 만든 임시 폴더에서만 실행하는 실제 터미널·빌드 검증용 예제다.
const directory = process.argv[2];
if (!directory) throw new Error("테스트용 임시 폴더 경로가 필요합니다.");
const paths = createHarnessPaths(directory, directory);
const history = new ExecutionHistory(paths);
const toolManager = new ToolManager();
const jobs = registerShellTools(toolManager, directory);
toolManager.register({ name: "probe", description: "화면 검증용", parameters: { type: "object", properties: {} },
  // 중간 보고와 실행 중 입력 차단을 확인하도록 응답을 잠깐 늦춘다.
  async execute() { await new Promise((resolve) => setTimeout(resolve, 700)); return "42"; },
});
// 네트워크 요청 없이 실제 agent의 모델·툴 반복과 화면 출력을 실행한다.
const adapter: LLMAdapter = {
  supportsImages: true,
  async generate(request, observer) {
    if (request.maxOutputTokens) return { stopReason: "stop", message: { role: "assistant", content: [{ type: "text", text: "검증 결과는 42입니다." }] } };
    if (request.messages.at(-1)?.role === "tool") {
      // 실제 SSE처럼 조각을 시간차로 흘려 화면이 이어 쓰는지 확인한다. 완성본은 조각을 합친 것과 같다.
      const answer = "확인 완료: 42\n한글 표시와 툴 실행이 정상입니다.";
      for (const piece of answer.match(/.{1,4}/gs) ?? []) {
        await new Promise((resolve) => setTimeout(resolve, 120));
        observer?.onTextDelta?.(piece);
      }
      return { stopReason: "stop", message: { role: "assistant", content: [{ type: "text", text: answer }] } };
    }
    return { stopReason: "tool-calls", message: { role: "assistant", content: [
      { type: "text", text: "확인하겠습니다. 도구를 실행합니다." },
      { type: "tool-call", id: `probe-${request.messages.length}`, name: "probe", arguments: "{}" },
    ] } };
  },
};
const tui = createTui();
const agent = createAgent({ adapter, toolManager, skillManager: new SkillManager(), paths, history, onEvent: tui.onEvent });
await tui.run({ agent, paths, history, model: "mock · 실제 API 미사용", supportsImages: true,
  // 테스트 프로세스가 만든 작업만 종료한다.
  async dispose() { await jobs.dispose(); },
});
