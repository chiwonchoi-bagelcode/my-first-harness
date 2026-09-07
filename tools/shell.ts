import { exec } from "node:child_process";
import { promisify } from "node:util";

// 콜백 방식의 exec를 await으로 기다릴 수 있는 함수로 변환한다.
const execAsync = promisify(exec);

// 현재 작업 폴더에서 셸 명령을 실행하고 표준 출력과 오류 출력을 합쳐 반환한다.
async function runCommand(command: string) {
  const result = await execAsync(command);

  return result.stdout + result.stderr;
}

// 셸 명령 실행 툴을 ToolManager에 등록한다.
export function registerShellTools(toolManager: any) {
  toolManager.register({
    name: "runCommand",
    description: "현재 작업 디렉토리에서 터미널 명령을 실행한다.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "실행할 터미널 명령",
        },
      },
      required: ["command"],
    },
    // 모델이 준 command 인자를 셸 실행 함수에 전달한다.
    execute: (arguments_: any) => runCommand(arguments_.command),
  });
}
