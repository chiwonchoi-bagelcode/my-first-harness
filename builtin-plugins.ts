import { registerCounterFeature } from "./tools/counter.ts";
import { registerTimeTools } from "./tools/time.ts";
import { registerOtherLLMTools } from "./tools/other-llm.ts";
import { registerFilesystemTools } from "./tools/filesystem.ts";
import { registerShellTools } from "./tools/shell.ts";
import type { HarnessPlugin } from "./plugin-manager.ts";
import type { HarnessPaths } from "./harness-paths.ts";
import type { LLMAdapter } from "./llm-types.ts";

// 기존 등록 함수들을 이름으로 켜고 끌 수 있는 내장 플러그인으로 구성한다.
export function createBuiltinPlugins(paths: HarnessPaths, adapter: LLMAdapter): HarnessPlugin[] {
  return [
    // 기존 카운터 변수와 두 툴을 그대로 등록한다.
    { name: "counter", description: "카운터 증가·조회. 껐다 켜도 현재 값은 유지됩니다.", setup: registerCounterFeature },
    // 시각 조회 툴을 등록하며 별도 자원 정리는 필요 없다.
    { name: "time", description: "현재 시간 조회", setup: registerTimeTools },
    // 실행 중인 모델 어댑터를 별도 질문 툴에 연결한다.
    { name: "other-llm", description: "별도 LLM 질문", setup: (tools) => registerOtherLLMTools(tools, adapter) },
    // 이미지 지원 여부를 반영해 파일 도구를 등록한다.
    { name: "filesystem", description: "파일 읽기·쓰기·목록·이미지 읽기", setup: (tools) => registerFilesystemTools(tools, adapter.supportsImages) },
    {
      name: "shell", description: "셸·백그라운드 작업. 끄면 관리 중인 작업도 종료되고 작업 목록은 초기화됩니다.",
      // 재활성화할 때 새 작업 관리자를 만들고 이전 관리자는 비활성화할 때 정리한다.
      setup(tools) {
        const jobs = registerShellTools(tools, paths.workspaceDirectory);
        return () => jobs.dispose();
      },
    },
  ];
}
