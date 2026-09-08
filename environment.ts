import { configDotenv } from "dotenv";
import { join } from "node:path";
import type { HarnessPaths } from "./harness-paths.ts";

// 셸 환경변수 > 작업 폴더 .env > 사용자 전역 .env 순서로 빈 설정만 채운다.
export function loadEnvironment(paths: HarnessPaths, env: NodeJS.ProcessEnv = process.env) {
  for (const path of [join(paths.workspaceDirectory, ".env"), join(paths.userHarnessDirectory, ".env")]) {
    const { error } = configDotenv({ path, processEnv: env, override: false, quiet: true });
    if (error && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
