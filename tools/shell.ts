import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

async function runCommand(command: string) {
  const result = await execAsync(command);

  return result.stdout + result.stderr;
}

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
    execute: (arguments_: any) => runCommand(arguments_.command),
  });
}
