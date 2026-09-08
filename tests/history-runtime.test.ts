import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHarnessPaths } from "../harness-paths.ts";

// 자식 프로세스가 명령을 받을 준비가 될 때까지 짧게 기다린다.
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("CLI 기록 테스트 대기 시간 초과");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("실제 CLI의 new/resume/quit는 세션별 JSONL에 추가하고 JSON 스냅샷으로 재개한다", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-history-runtime-"));
  const root = new URL("..", import.meta.url);
  const script = `
    import { runCli } from ${JSON.stringify(new URL("../cli.ts", import.meta.url).href)};
    import { ExecutionHistory } from ${JSON.stringify(new URL("execution-history.ts", root).href)};
    import { createHarnessPaths } from ${JSON.stringify(new URL("harness-paths.ts", root).href)};
    import { loadSession, saveSession } from ${JSON.stringify(new URL("session-store.ts", root).href)};
    const paths = createHarnessPaths(${JSON.stringify(directory)}, ${JSON.stringify(directory)});
    const history = new ExecutionHistory(paths);
    const shellJobs = { dispose: async () => {} };
    const mcpClients = [];
    const closeMcpServers = async () => {};
    const compactAndSave = async () => {};
    const turn = async () => { throw new Error('API 호출 금지'); };
    await runCli({
      agent: { turn, compact: compactAndSave }, paths, history,
      supportsImages: false, saveSession, loadSession,
      dispose: async () => { await shellJobs.dispose(); await closeMcpServers(mcpClients); },
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { errors += chunk; });
  const closed = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    await rm(directory, { recursive: true, force: true });
  });
  await until(() => output.includes("> "));
  const first = /session: ([\w-]+)/.exec(output)![1];
  child.stdin.write("/new\n");
  await until(() => output.includes("new session:") && output.endsWith("> "));
  const second = /new session: ([\w-]+)/.exec(output)![1];
  assert.notEqual(first, second);
  child.stdin.write(`/resume ${first}\n`);
  await until(() => output.includes(`resumed session: ${first}`) && output.endsWith("> "));
  child.stdin.write("/quit\n");
  const [code] = await closed;
  assert.equal(code, 0, errors);
  const paths = createHarnessPaths(directory, directory);
  // 사용자 데이터 없이 이 테스트가 만든 두 기록 파일만 읽는다.
  const records = async (id: string) => (await readFile(join(paths.sessionDirectory, `${id}.jsonl`), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  const firstLog = await records(first);
  const secondLog = await records(second);
  assert.deepEqual(firstLog.map((event) => event.type), ["session-start", "command", "session-resume", "command", "session-close"]);
  assert.deepEqual(secondLog.map((event) => event.type), ["session-start", "command"]);
  assert.equal(firstLog[1].input, "/new");
  assert.equal(secondLog[1].input, `/resume ${first}`);
  assert.ok(firstLog.every((event) => event.sessionId === first));
  const snapshot = JSON.parse(await readFile(join(paths.sessionDirectory, `${first}.json`), "utf8"));
  assert.equal(snapshot.version, 2);
  assert.deepEqual(snapshot.messages, []);
  assert.equal("history" in snapshot, false);
});
