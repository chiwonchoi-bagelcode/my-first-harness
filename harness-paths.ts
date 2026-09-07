import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

// 작업 폴더와 사용자 홈을 기준으로 스킬 및 프로젝트별 세션 저장 경로를 만든다.
export function createHarnessPaths(
  workspace = process.cwd(),
  userHome = homedir(),
) {
  const workspaceDirectory = resolve(workspace);
  const userHarnessDirectory = join(resolve(userHome), ".my-first-harness");
  const projectHarnessDirectory = join(workspaceDirectory, ".my-first-harness");
  const projectName = basename(workspaceDirectory).replace(/[^a-zA-Z0-9_-]/g, "_") || "project";
  const pathHash = createHash("sha256")
    .update(workspaceDirectory)
    .digest("hex")
    .slice(0, 12);
  const projectKey = `${projectName}-${pathHash}`;

  return {
    workspaceDirectory,
    userHarnessDirectory,
    projectHarnessDirectory,
    userSkillsDirectory: join(userHarnessDirectory, "skills"),
    projectSkillsDirectory: join(projectHarnessDirectory, "skills"),
    sessionDirectory: join(userHarnessDirectory, "projects", projectKey),
  };
}

// createHarnessPaths가 반환하는 경로 객체의 타입.
export type HarnessPaths = ReturnType<typeof createHarnessPaths>;
