import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvironment } from "../environment.ts";
import { createHarnessPaths } from "../harness-paths.ts";

test("환경변수·프로젝트·전역 순으로 설정하고 cwd나 실제 환경을 변경하지 않는다", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = createHarnessPaths(join(root, "project"), join(root, "home"));
  await mkdir(paths.workspaceDirectory, { recursive: true });
  await mkdir(paths.userHarnessDirectory, { recursive: true });
  // 실제 인증 값 대신 테스트 전용 설정으로 우선순위를 확인한다.
  await writeFile(join(paths.workspaceDirectory, ".env"), "EXISTING=project\nPROJECT=project\n");
  await writeFile(join(paths.userHarnessDirectory, ".env"), "EXISTING=user\nPROJECT=user\nGLOBAL=user\n");
  const env = { EXISTING: "shell" };
  const cwd = process.cwd();
  loadEnvironment(paths, env);
  assert.deepEqual(env, { EXISTING: "shell", PROJECT: "project", GLOBAL: "user" });
  assert.equal(process.cwd(), cwd);
});

test("없는 .env는 무시하고 실제 읽기 오류는 숨기지 않는다", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-env-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = createHarnessPaths(root, join(root, "home"));
  const env = {};
  loadEnvironment(paths, env);
  assert.deepEqual(env, {});
  await mkdir(join(root, ".env"));
  assert.throws(() => loadEnvironment(paths, env), /EISDIR/);
});
