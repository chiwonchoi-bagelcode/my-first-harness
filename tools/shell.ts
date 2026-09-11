import { JobManager, MAX_JOB_WAIT_MS } from "../job-manager.ts";

// 셸 실행과 작업 관리 도구를 등록하고 런타임 종료 때 정리할 관리자를 반환한다.
export function registerShellTools(toolManager: any, cwd = process.cwd()) {
  const jobs = new JobManager(cwd);
  toolManager.register({
    name: "runCommand",
    description: "현재 작업 폴더에서 셸 명령을 실행한다. 기본은 종료까지 기다린다. 오래 걸리는 명령이나 서버를 실행해 둔 채 다른 작업을 하려면 background=true를 선택한다. 이때 작업 ID를 반환하며 서버 준비나 작업 성공을 보장하지 않는다. 셸의 & 대신 background 옵션을 사용하라. `&`로 프로세스를 남기면 명령이 끝난 직후 경고와 함께 돌아오지만 그 프로세스는 관리되지 않는다. 대화형 stdin은 지원하지 않는다.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          minLength: 1,
          description: "실행할 터미널 명령",
        },
        background: { type: "boolean", description: "true면 작업 ID를 먼저 반환한다. 생략 또는 false면 종료까지 기다린다." },
      },
      required: ["command"],
    },
    // 상태 객체는 기존 ToolManager가 문자열로 기록할 수 있도록 JSON으로 반환한다.
    execute: async (args: { command: string; background?: boolean }, context?: { signal?: AbortSignal }) => args.background
      ? JSON.stringify(await jobs.start(args.command))
      : jobs.run(args.command, context?.signal),
  });
  toolManager.register({
    name: "readJob",
    description: "작업의 최신 상태·stdout·stderr·종료 코드를 조회한다. 출력은 스트림별 최근 16384자이며 잘림 여부를 표시한다. waitMs를 주면 종료 또는 시간 만료까지 기다린다. 불필요한 반복 조회 대신 대기를 활용하라. running은 성공이나 서버 준비 완료가 아니다.",
    parameters: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "runCommand 또는 listJobs가 반환한 작업 ID" },
        waitMs: { type: "integer", minimum: 0, maximum: MAX_JOB_WAIT_MS, description: "최대 대기 시간(ms). 기본 0으로 즉시 조회하며, 이미 끝났으면 즉시 반환한다." },
      },
      required: ["jobId"],
    },
    // 조회 자체는 성공한 도구 호출이며 명령 실패 여부는 status와 exitCode에 담는다.
    execute: async (args: { jobId: string; waitMs?: number }, context?: { signal?: AbortSignal }) =>
      JSON.stringify(await jobs.read(args.jobId, args.waitMs, context?.signal)),
  });
  toolManager.register({
    name: "listJobs",
    description: "현재 하네스 실행에서 시작한 셸 작업 목록과 상태를 조회한다. foreground 작업도 포함한다. 작업 ID는 프로그램 재시작 후 복원되지 않으며 /new와 /resume 동안에는 같은 런타임 목록을 유지한다.",
    parameters: { type: "object", properties: {} },
    // 목록 조회에서는 각 작업의 큰 출력을 제외한다.
    execute: () => JSON.stringify(jobs.list()),
  });
  toolManager.register({
    name: "stopJob",
    description: "작업 ID에 해당하는 셸과 일반 자식 프로세스를 종료한다. 별도 세션으로 분리·daemon화한 프로세스는 관리 범위 밖이다. 이미 종료된 작업은 현재 상태를 반환한다.",
    parameters: {
      type: "object",
      properties: { jobId: { type: "string", description: "종료할 작업 ID" } },
      required: ["jobId"],
    },
    // 종료 신호만 보낸 시점이 아니라 종료를 확인한 상태를 반환한다.
    execute: async (args: { jobId: string }) => JSON.stringify(await jobs.stop(args.jobId)),
  });
  return jobs;
}
