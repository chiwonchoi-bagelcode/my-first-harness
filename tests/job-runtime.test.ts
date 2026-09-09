import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

const managerUrl = new URL("../job-manager.ts", import.meta.url).href;

// 실제 CLI 함수를 별도 프로세스에서 돌리되 모델·MCP·세션 저장은 대체한다.
function runtimeScript() {
  return `
    import { runCli } from ${JSON.stringify(new URL("../cli.ts", import.meta.url).href)};
    import { createSession } from ${JSON.stringify(new URL("../session.ts", import.meta.url).href)};
    import { JobManager } from ${JSON.stringify(managerUrl)};
    const shellJobs = new JobManager();
    const mcpClients = [];
    // 외부 서버와 사용자 세션을 건드리지 않는 테스트 대체 함수들이다.
    const closeMcpServers = async () => {};
    const saveSession = async () => {};
    const loadSession = async () => createSession(paths.workspaceDirectory);
    const compactAndSave = async () => {};
    const paths = { workspaceDirectory: '/test' };
    const history = { append: async () => {}, flush: async () => {} };
    // 종료되지 않는 실제 명령을 실행해 foreground/백그라운드 정리를 검사한다.
    async function turn(session, input) {
      const command = JSON.stringify(process.execPath) + ' -e "console.log(process.pid); setInterval(()=>{},1000)"';
      if (input === 'foreground') {
        setTimeout(async () => {
          const job = shellJobs.list()[0];
          if (job) console.log('OWNED=' + (await shellJobs.read(job.jobId, 100)).stdout.trim());
        }, 100);
        return shellJobs.run(command);
      }
      const job = await shellJobs.start(command);
      const result = await shellJobs.read(job.jobId, 250);
      console.log('OWNED=' + result.stdout.trim());
      return 'STARTED';
    }
    await runCli({
      // 이 모의 코어는 취소할 모델 요청이 없고 dispose에서 프로세스를 정리한다.
      agent: { turn, compact: compactAndSave, interrupt() { return false; } }, paths, history,
      supportsImages: false, saveSession, loadSession,
      dispose: async () => { await shellJobs.dispose(); await closeMcpServers(mcpClients); },
    });
  `;
}

// 자식 런타임의 출력이 조건에 도달할 때까지 기다리고 무한 대기를 막는다.
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("런타임 출력 대기 시간 초과");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

for (const mode of ["quit", "sigint-idle", "sigint-foreground"] as const) {
  test(`실제 CLI 종료 경로: ${mode}에서 소유한 명령도 정리한다`, { timeout: 15_000, skip: process.platform === "win32" }, async (t) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", runtimeScript()], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    let ownedPid: number | undefined;
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { errors += chunk; });
    const closed = once(child, "close");
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2500);
      try { await closed; } finally { clearTimeout(timer); }
      // 실패한 테스트에서도 이 테스트가 출력으로 확인한 자식만 정리한다.
      if (ownedPid) { try { process.kill(ownedPid, "SIGKILL"); } catch {} }
    });
    await until(() => output.includes("> "));
    child.stdin.write(mode === "sigint-foreground" ? "foreground\n" : "start\n");
    await until(() => /OWNED=\d+/.test(output));
    ownedPid = Number(/OWNED=(\d+)/.exec(output)![1]);
    if (mode === "quit") {
      await until(() => output.includes("STARTED\n> "));
      child.stdin.write("/quit\n");
    } else {
      child.kill("SIGINT");
    }
    const [code, signal] = await closed;
    assert.equal(code, mode === "quit" ? 0 : 130, errors);
    assert.equal(signal, null);
    assert.doesNotMatch(errors, /런타임 정리 실패|명령 실행 실패|ERR_USE_AFTER_CLOSE/);
    assert.throws(() => process.kill(ownedPid!, 0), { code: "ESRCH" });
    ownedPid = undefined;
  });
}
