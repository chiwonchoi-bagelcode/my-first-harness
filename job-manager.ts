import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const OUTPUT_LIMIT = 16_384;
export const MAX_JOB_WAIT_MS = 10_000;
// Windows에서 소유한 프로세스 트리를 종료할 때 taskkill의 완료를 기다린다.
const execFileAsync = promisify(execFile);

// 모델에게 공개하는 셸 작업의 상태와 제한된 최근 출력이다.
export type JobSnapshot = {
  jobId: string;
  command: string;
  status: "running" | "stopping" | "completed" | "failed" | "stopped";
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
};

// 공개 상태 외에 프로세스 핸들과 종료 대기·중복 중단 방지 정보를 보관한다.
type Job = {
  snapshot: JobSnapshot;
  child: ChildProcess;
  done: Promise<void>;
  closed: boolean;
  stopRequested: boolean;
  stopping?: Promise<JobSnapshot>;
};

// 현재 하네스가 시작한 셸 프로세스의 실행·조회·종료를 관리한다. 재시작 복원은 하지 않는다.
export class JobManager {
  private jobs = new Map<string, Job>();
  private disposed = false;
  private cleanup?: Promise<void>;
  private cwd: string;

  // 모든 명령에 사용할 작업 폴더를 고정한다.
  constructor(cwd = process.cwd()) {
    this.cwd = cwd;
  }

  // 셸 프로세스를 시작하고 종료를 기다리지 않은 채 작업 상태를 반환한다.
  async start(command: string): Promise<JobSnapshot> {
    if (this.disposed) throw new Error("종료된 작업 관리자에서는 명령을 실행할 수 없습니다.");
    const child = spawn(command, {
      cwd: this.cwd, shell: true, detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let resolveDone!: () => void;
    const job: Job = {
      snapshot: {
        jobId: randomUUID(), command, status: "running", stdout: "", stderr: "",
        stdoutTruncated: false, stderrTruncated: false, exitCode: null, signal: null,
      },
      child, closed: false, stopRequested: false,
      done: new Promise<void>((resolve) => { resolveDone = resolve; }),
    };
    this.jobs.set(job.snapshot.jobId, job);
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => this.append(job, "stdout", chunk));
    child.stderr!.on("data", (chunk: string) => this.append(job, "stderr", chunk));
    child.once("error", (error) => { job.snapshot.error = error.message; });
    child.once("close", (code, signal) => {
      job.closed = true;
      job.snapshot.exitCode = code;
      job.snapshot.signal = signal;
      job.snapshot.status = job.snapshot.error ? "failed"
        : job.stopRequested ? "stopped" : code === 0 ? "completed" : "failed";
      resolveDone();
    });
    // 프로세스 생성 성공까지만 기다린다. 서버의 접속 준비 완료를 뜻하지 않는다.
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    return this.snapshot(job);
  }

  // foreground 명령은 종료까지 기다리며, 기존처럼 텍스트 결과 또는 실행 오류를 반환한다.
  async run(command: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const started = await this.start(command);
    const job = this.get(started.jobId);
    let stopping: Promise<JobSnapshot> | undefined;
    let onAbort!: () => void;
    // 중단 요청은 이 foreground 작업만 종료하고 실제 프로세스 정리가 끝날 때까지 기다린다.
    const aborted = new Promise<void>((resolve, reject) => {
      onAbort = () => { stopping ??= this.stop(started.jobId); void stopping.then(() => resolve(), reject); };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    try {
      await Promise.race([job.done, aborted]);
      await stopping;
      signal?.throwIfAborted();
    } finally { signal?.removeEventListener("abort", onAbort); }
    const result = this.snapshot(job);
    const output = result.stdout + result.stderr;
    const notice = result.stdoutTruncated || result.stderrTruncated
      ? "\n[명령 출력 일부 생략: 각 스트림의 최근 16384자만 보관]" : "";
    if (result.status !== "completed") {
      throw new Error(`명령 실행 실패 (exitCode=${result.exitCode}, signal=${result.signal}): ${result.error ?? ""}\n${output}${notice}`);
    }
    return output + notice;
  }

  // 즉시 조회하거나 지정한 시간 안에 종료되기를 기다린 뒤 최신 상태를 반환한다.
  async read(jobId: string, waitMs = 0, signal?: AbortSignal): Promise<JobSnapshot> {
    signal?.throwIfAborted();
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_JOB_WAIT_MS) {
      throw new Error(`waitMs는 0부터 ${MAX_JOB_WAIT_MS}까지의 정수여야 합니다.`);
    }
    const job = this.get(jobId);
    await this.wait(job, waitMs, signal);
    return this.snapshot(job);
  }

  // 큰 출력은 제외하고 현재 실행에서 생성한 작업들의 식별 정보와 상태를 반환한다.
  list() {
    return [...this.jobs.values()].map(({ snapshot }) => ({
      jobId: snapshot.jobId, command: snapshot.command, status: snapshot.status,
      exitCode: snapshot.exitCode, signal: snapshot.signal,
    }));
  }

  // 같은 작업에 대한 중단 요청을 합치고 실제 종료 확인 결과를 반환한다.
  async stop(jobId: string): Promise<JobSnapshot> {
    const job = this.get(jobId);
    if (job.stopping) return job.stopping;
    if (job.closed) return this.snapshot(job);
    job.stopping = this.terminate(job);
    return job.stopping;
  }

  // 더 이상 작업을 받지 않고 남아 있는 소유 프로세스들을 함께 종료한다.
  dispose(): Promise<void> {
    this.disposed = true;
    this.cleanup ??= Promise.allSettled([...this.jobs.keys()].map((id) => this.stop(id)))
      .then((results) => {
        const failures = results.filter((result) => result.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "일부 셸 작업을 종료하지 못했습니다.");
      });
    return this.cleanup;
  }

  // 작업 ID는 현재 런타임에서만 찾으며 과거 세션의 ID는 재사용하지 않는다.
  private get(jobId: string): Job {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`현재 실행에 없는 작업 ID입니다: ${jobId}`);
    return job;
  }

  // 내부 상태를 외부에서 수정하지 못하도록 공개 필드의 사본을 만든다.
  private snapshot(job: Job): JobSnapshot {
    return { ...job.snapshot };
  }

  // 메모리가 계속 늘지 않도록 각 출력 스트림의 최근 부분만 보관한다.
  private append(job: Job, stream: "stdout" | "stderr", chunk: string) {
    const text = job.snapshot[stream] + chunk;
    if (text.length > OUTPUT_LIMIT) job.snapshot[`${stream}Truncated`] = true;
    // 잘림 경계에 UTF-16 서로게이트 쌍의 뒷부분만 남지 않도록 한다.
    job.snapshot[stream] = text.slice(-OUTPUT_LIMIT).replace(/^[\uDC00-\uDFFF]/, "");
  }

  // 종료 또는 대기 시간 만료 중 먼저 발생하는 시점까지 기다리고 타이머를 정리한다.
  private async wait(job: Job, waitMs: number, signal?: AbortSignal) {
    if (job.closed || waitMs === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort!: () => void;
    // 조회 대기만 취소하며 이미 백그라운드로 시작한 프로세스는 종료하지 않는다.
    const aborted = new Promise<void>((_resolve, reject) => {
      onAbort = () => reject(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    try {
      await Promise.race([job.done, aborted, new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); })]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  // POSIX에서는 자신이 만든 프로세스 그룹에만 신호를 보내며 이미 종료된 그룹은 무시한다.
  private signalGroup(job: Job, signal: NodeJS.Signals) {
    if (job.child.pid === undefined) return;
    try {
      process.kill(-job.child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  // 셸과 일반 자식 프로세스를 종료하고 출력 스트림이 닫힐 때까지 확인한다.
  private async terminate(job: Job): Promise<JobSnapshot> {
    job.stopRequested = true;
    job.snapshot.status = "stopping";
    if (job.child.pid !== undefined) {
      if (process.platform === "win32") {
        await execFileAsync("taskkill", ["/pid", String(job.child.pid), "/T", "/F"]);
      } else {
        this.signalGroup(job, "SIGTERM");
        // 셸이 먼저 끝나도 TERM을 무시하는 자식이 남을 수 있어 그룹 전체에 유예 시간을 준다.
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
        this.signalGroup(job, "SIGKILL");
      }
    }
    await this.wait(job, 1000);
    if (!job.closed) throw new Error(`작업 종료를 확인하지 못했습니다: ${job.snapshot.jobId}`);
    return this.snapshot(job);
  }
}
