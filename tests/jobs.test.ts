import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JobManager, MAX_JOB_WAIT_MS } from "../job-manager.ts";
import { registerShellTools } from "../tools/shell.ts";
import { validateToolArguments } from "../tool-schema.ts";

// 테스트의 고정 Node 코드를 POSIX 셸의 단일 인자로 전달한다.
function nodeCommand(source: string) {
  return `'${process.execPath.replaceAll("'", "'\\''")}' -e '${source.replaceAll("'", "'\\''")}'`;
}

// 임의의 고정 sleep 대신 작업 출력에서 준비 신호가 확인될 때까지 짧게 조회한다.
async function ready(jobs: JobManager, jobId: string, pattern: RegExp) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await jobs.read(jobId, 25);
    if (pattern.test(result.stdout)) return result;
    assert.equal(result.status, "running", JSON.stringify(result));
  }
  throw new Error("프로세스 준비 신호 대기 시간 초과");
}

// 소유한 테스트 프로세스가 실제로 사라졌는지 운영체제에 확인한다.
async function assertExited(pid: number) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`프로세스가 남아 있습니다: ${pid}`);
}

test("foreground는 기본적으로 종료를 기다리고 기존 텍스트와 실패 출력을 반환한다", async (t) => {
  const jobs = new JobManager();
  t.after(() => jobs.dispose());
  assert.equal(await jobs.run(nodeCommand("setTimeout(() => { console.log('done'); console.error('notice') }, 50)")), "done\nnotice\n");
  await assert.rejects(jobs.run(nodeCommand("console.log('partial'); console.error('bad'); process.exitCode=7")), /exitCode=7[\s\S]*partial[\s\S]*bad/);
  assert.deepEqual(jobs.list().map((j) => j.status), ["completed", "failed"]);
});

test("실제 서버를 백그라운드로 켜둔 채 다른 명령으로 접속하고 종료한다", async (t) => {
  const jobs = new JobManager();
  t.after(() => jobs.dispose());
  const started = await jobs.start(nodeCommand("const s=require('http').createServer((q,r)=>r.end('tetris-ready')); s.listen(0,'127.0.0.1',()=>console.log('PORT='+s.address().port))"));
  assert.equal(started.status, "running");
  const running = await ready(jobs, started.jobId, /PORT=\d+/);
  const port = /PORT=(\d+)/.exec(running.stdout)![1];
  const url = `http://127.0.0.1:${port}`;
  assert.equal(await jobs.run(nodeCommand(`fetch(${JSON.stringify(url)}).then(r=>r.text()).then(console.log)`)), "tetris-ready\n");
  assert.equal((await jobs.read(started.jobId)).status, "running");
  const stop = await jobs.stop(started.jobId);
  assert.equal(stop.status, "stopped");
  assert.deepEqual(await jobs.stop(started.jobId), stop);
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
});

test("복수 작업의 출력·상태가 분리되고 read의 짧은 대기는 작업을 종료하지 않는다", async (t) => {
  const jobs = new JobManager();
  t.after(() => jobs.dispose());
  const a = await jobs.start(nodeCommand("console.log('A'); setTimeout(()=>console.log('A-done'),250)"));
  const b = await jobs.start(nodeCommand("console.log('B'); console.error('B-error'); process.exitCode=3"));
  assert.notEqual(a.jobId, b.jobId);
  assert.equal((await jobs.read(a.jobId, 1)).status, "running");
  const [doneA, doneB] = await Promise.all([jobs.read(a.jobId, 3000), jobs.read(b.jobId, 3000)]);
  assert.equal(doneA.stdout, "A\nA-done\n");
  assert.equal(doneA.exitCode, 0);
  assert.equal(doneB.stdout, "B\n");
  assert.equal(doneB.stderr, "B-error\n");
  assert.equal(doneB.status, "failed");
  assert.equal(doneB.exitCode, 3);
  doneA.stdout = "changed";
  assert.notEqual((await jobs.read(a.jobId)).stdout, "changed");
  assert.ok(jobs.list().every((job) => !("stdout" in job)));
});

test("큰 출력은 최근 부분만 남기고 잘림을 알린다", async (t) => {
  const jobs = new JobManager();
  t.after(() => jobs.dispose());
  const started = await jobs.start(nodeCommand("process.stdout.write('가'.repeat(40000)+'END'); process.stderr.write('e'.repeat(40000)+'ERR')"));
  const result = await jobs.read(started.jobId, 3000);
  assert.equal(result.status, "completed");
  assert.ok(result.stdout.length <= 16_384);
  assert.ok(result.stderr.length <= 16_384);
  assert.ok(result.stdout.endsWith("END"));
  assert.ok(result.stderr.endsWith("ERR"));
  assert.ok(result.stdoutTruncated && result.stderrTruncated);
  assert.doesNotMatch(result.stdout, /\uFFFD/);
});

test("중단은 TERM을 무시하는 일반 자식까지 종료하며 중복 요청은 합친다", { skip: process.platform === "win32" }, async (t) => {
  const jobs = new JobManager();
  t.after(() => jobs.dispose());
  const grandchild = "process.on('SIGTERM',()=>{}); console.log('CHILD='+process.pid); setInterval(()=>{},1000)";
  const parent = `process.on('SIGTERM',()=>{}); console.log('PARENT='+process.pid); require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'}); setInterval(()=>{},1000)`;
  const started = await jobs.start(nodeCommand(parent));
  const running = await ready(jobs, started.jobId, /CHILD=\d+/);
  const pids = [...running.stdout.matchAll(/(?:PARENT|CHILD)=(\d+)/g)].map((m) => Number(m[1]));
  assert.equal(pids.length, 2);
  const stopping = jobs.stop(started.jobId);
  assert.equal((await jobs.read(started.jobId)).status, "stopping");
  const [first, second] = await Promise.all([stopping, jobs.stop(started.jobId)]);
  assert.equal(first.status, "stopped");
  assert.equal(first.signal, "SIGKILL");
  assert.deepEqual(first, second);
  await Promise.all(pids.map(assertExited));
});

test("dispose는 모든 실행 작업을 정리하고 이후 시작을 거부한다", async (t) => {
  const jobs = new JobManager();
  t.after(() => jobs.dispose());
  const ids = await Promise.all([1, 2].map(() => jobs.start(nodeCommand("console.log('READY'); setInterval(()=>{},1000)"))));
  await Promise.all(ids.map((j) => ready(jobs, j.jobId, /READY/)));
  await Promise.all([jobs.dispose(), jobs.dispose()]);
  assert.ok(jobs.list().every((j) => j.status === "stopped"));
  await assert.rejects(jobs.start("echo unexpected"), /종료된/);
});

test("알 수 없는 ID·잘못된 대기값·실행 시작 실패를 명확하게 알린다", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "harness-jobs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const jobs = new JobManager(join(dir, "missing"));
  t.after(() => jobs.dispose());
  await assert.rejects(jobs.start("echo never"), /ENOENT/);
  await assert.rejects(jobs.read("missing"), /없는 작업 ID/);
  await assert.rejects(jobs.stop("missing"), /없는 작업 ID/);
  await assert.rejects(jobs.read("missing", MAX_JOB_WAIT_MS + 1), /waitMs/);
  await assert.rejects(jobs.read("missing", -1), /waitMs/);
});

test("등록한 툴의 background 선택·JSON 직렬화·인자 규격·cwd가 동작한다", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "harness-jobs-tools-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tools = new Map<string, any>();
  const jobs = registerShellTools({ register(tool: any) { tools.set(tool.name, tool); } }, dir);
  t.after(() => jobs.dispose());
  assert.deepEqual([...tools.keys()], ["runCommand", "readJob", "listJobs", "stopJob"]);
  const run = tools.get("runCommand");
  assert.equal(validateToolArguments(run.parameters, { command: "echo ok" }), undefined);
  assert.ok(validateToolArguments(run.parameters, { command: "echo ok", background: "true" }));
  assert.ok(validateToolArguments(tools.get("readJob").parameters, { jobId: "x", waitMs: 10001 }));
  const output = await run.execute({ command: nodeCommand("console.log(require('fs').realpathSync(process.cwd()))"), background: false });
  assert.ok(output.trim().endsWith(dir.split("/").at(-1)));
  const raw = await run.execute({ command: nodeCommand("console.log('ok')"), background: true });
  const start = JSON.parse(raw);
  const result = JSON.parse(await tools.get("readJob").execute({ jobId: start.jobId, waitMs: 3000 }));
  assert.equal(result.stdout, "ok\n");
  assert.equal(result.status, "completed");
  assert.equal(JSON.parse(tools.get("listJobs").execute()).length, 2);
  assert.equal(JSON.parse(await tools.get("stopJob").execute({ jobId: start.jobId })).status, "completed");
});
