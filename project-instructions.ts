import { readFileSync } from "node:fs";
import { join } from "node:path";

// 시작·명시적 갱신 때 작업 폴더의 AGENTS.md만 읽고, 없는 파일은 빈 지침으로 취급한다.
export function readProjectInstructions(workspaceDirectory: string): string {
  try { return readFileSync(join(workspaceDirectory, "AGENTS.md"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
