import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";
import { createHarnessPaths } from "../harness-paths.ts";
import { solidPng } from "./image-fixture.ts";

// 패키지 생성·설치 명령은 제한 시간과 출력 한도를 두고 실행한다.
const run = promisify(execFile);
const repository = fileURLToPath(new URL("..", import.meta.url));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

// 실제 전역 설정 대신 임시 설치 위치에서 CLI·sharp·cwd·세션 저장을 검증한다.
async function main() {
  assert.notEqual(process.platform, "win32", "이 smoke는 POSIX 셸 환경용입니다. Windows 설치는 별도 검증이 필요합니다.");
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-package-")));
  try {
    const archive = join(root, "harness.tgz");
    await run(pnpm, ["pack", "--out", archive], { cwd: repository, timeout: 60_000, maxBuffer: 2_000_000 });
    const { stdout: listing } = await run("tar", ["-tzf", archive]);
    const files = listing.trim().split("\n");
    assert.ok(files.includes("package/dist/my-first-harness.js"));
    assert.ok(files.includes("package/dist/environment.js"));
    for (const file of files) {
      assert.match(file, /^package\/(?:package\.json|README(?:\.[^/]+)?|LICEN[CS]E(?:\.[^/]+)?|dist\/(?:[\w-]+\.js|(?:adapters|tools)\/[\w-]+\.js))$/i);
    }
    console.log("PASS: 배포 목록에 실행 JS·메타데이터만 포함 (.env·세션·테스트·Bun 바이너리 제외)");

    const bin = join(root, "bin");
    const workspace = join(root, "separate project");
    const userHome = join(root, "home");
    await mkdir(bin);
    await mkdir(workspace);
    await mkdir(userHome);
    // 실제 사용자 키·홈 설정을 전달하지 않는다. 모델 API는 호출하지 않는다.
    const env = { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, HOME: userHome,
      TMPDIR: tmpdir(), CI: "true", PNPM_HOME: bin };
    // 두 기본 MCP 서버가 선언하지 않은 zod를 찾을 수 있도록 npm식 배치를 사용한다.
    await run(pnpm, ["add", "--global", "--global-dir", join(root, "global"),
      "--global-bin-dir", bin, "--config.node-linker=hoisted", archive], { cwd: workspace, env, timeout: 180_000, maxBuffer: 2_000_000 });
    console.log("PASS: 임시 전역 위치에 pnpm으로 설치 (개발 저장소 의존성 링크 아님)");

    const paths = createHarnessPaths(workspace, userHome);
    await mkdir(paths.userHarnessDirectory, { recursive: true });
    await writeFile(join(paths.userHarnessDirectory, ".env"), "HARNESS_PACKAGE_SMOKE=global-loaded\n", { mode: 0o600 });
    for (const format of ["png", "jpeg", "webp"] as const) {
      await writeFile(join(workspace, `sample.${format}`), await sharp(solidPng()).toFormat(format).toBuffer());
    }
    const child = spawn("my-first-harness", [], { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] });
    const closed = once(child, "close");
    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { errors += chunk; });
    // 종료 여부를 함께 확인해 설치 오류가 대기 시간 초과로 가려지지 않게 한다.
    async function until(check: () => boolean) {
      const deadline = Date.now() + 40_000;
      while (!check()) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`CLI가 조기 종료됨: ${errors}`);
        if (Date.now() > deadline) throw new Error(`CLI 대기 시간 초과: ${errors}`);
        await new Promise((done) => setTimeout(done, 20));
      }
    }
    try {
      await until(() => output.endsWith("> "));
      for (const name of ["filesystem", "memory", "playwright"]) {
        assert.ok(output.includes(`[mcp] ${name} (stdio):`), `설치된 ${name} 서버 연결 누락\n${output}\n${errors}`);
      }
      const id = /session: ([\w-]+)/.exec(output)![1];
      const session = JSON.parse(await readFile(join(paths.sessionDirectory, `${id}.json`), "utf8"));
      assert.equal(session.workspaceDirectory, resolve(workspace));
      for (const format of ["png", "jpeg", "webp"]) {
        const start = output.length;
        child.stdin.write(`/attach sample.${format}\n`);
        await until(() => output.length > start && output.endsWith("> "));
        assert.ok(output.slice(start).includes(`sample.${format} (128×128)`), output.slice(start));
      }
      child.stdin.write("/quit\n");
      const [code] = await Promise.race([closed, new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("CLI 종료 시간 초과")), 15_000);
        timer.unref();
      })]);
      assert.equal(code, 0, errors);
      console.log("PASS: 다른 cwd에서 명령 실행 → 로컬 MCP 3개 → PNG·JPEG·WebP 첨부 → 세션 저장 → 종료");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
      await closed;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
