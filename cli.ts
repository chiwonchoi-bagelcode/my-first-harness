import { createInterface } from "node:readline/promises";
import { createSession } from "./session.ts";
import { readProjectInstructions } from "./project-instructions.ts";
import { loadSession as restoreSession, saveSession as persistSession } from "./session-store.ts";
import { attachmentPath, checkImageInput, loadImage } from "./image-content.ts";
import type { Agent, AgentEvent } from "./agent.ts";
import type { HistorySink } from "./execution-history.ts";
import type { HarnessPaths } from "./harness-paths.ts";
import type { ImageBlock } from "./llm-types.ts";
import type { PermissionRequest, RequestApproval } from "./permissions.ts";
import { parseMode } from "./agent-mode.ts";
import { parsePermissionMode } from "./permissions.ts";
import type { RequestPlanReview } from "./plan-review.ts";

// 계획 전문을 보여주고 y로 승인, 수정 의견으로 재계획, 빈 입력으로 검토를 닫는다.
export function createCliPlanReview(terminal: ReturnType<typeof createInterface>): RequestPlanReview {
  let isClosed = false;
  terminal.once("close", () => { isClosed = true; });
  return async (plan, signal) => {
    if (isClosed || signal?.aborted) return { decision: "cancel" };
    console.log(`[plan review]\n${plan}`);
    const closed = new AbortController();
    // EOF에서도 실행 중인 검토를 해소한다.
    const onClose = () => closed.abort();
    terminal.once("close", onClose);
    try {
      const answer = (await terminal.question("계획 승인: y / 수정 요청: 의견 입력 / 닫기: Enter > ", {
        signal: signal ? AbortSignal.any([signal, closed.signal]) : closed.signal,
      })).trim();
      if (closed.signal.aborted || signal?.aborted || !answer) return { decision: "cancel" };
      return /^(y|yes)$/i.test(answer) ? { decision: "approve" } : { decision: "revise", feedback: answer };
    } catch { return { decision: "cancel" }; }
    finally { terminal.removeListener("close", onClose); }
  };
}

// 같은 readline 입력을 사용하되 명시적인 y/yes만 일회 승인으로 처리한다.
export function createCliApproval(terminal: ReturnType<typeof createInterface>): RequestApproval {
  let isClosed = false;
  terminal.once("close", () => { isClosed = true; });
  return async (request, signal) => {
    if (signal?.aborted || isClosed) return false;
    console.log(`[approval] ${JSON.stringify(request.toolName)}\n${JSON.stringify(request.args, null, 2)}`);
    const closed = new AbortController();
    // EOF·종료로 입력이 닫히면 승인 질문도 취소한다.
    const onClose = () => closed.abort();
    terminal.once("close", onClose);
    try {
      const answer = await terminal.question("Y 일회 승인 / S 세션 동안 이 툴의 모든 인자 승인 / N 거부 > ", {
        signal: signal ? AbortSignal.any([signal, closed.signal]) : closed.signal,
      });
      if (signal?.aborted || closed.signal.aborted) return false;
      if (/^(s|session)$/i.test(answer.trim())) return "session";
      return /^(y|yes)$/i.test(answer.trim());
    } catch { return false; }
    finally { terminal.removeListener("close", onClose); }
  };
}

// 에이전트 생성 전 승인 콜백을 제공하고 실행 중인 CLI의 입력 장치에 연결한다.
export function createCli() {
  let approve: RequestApproval | undefined;
  let review: RequestPlanReview | undefined;
  return {
    // CLI 입력이 연결된 동안에만 계획 검토를 요청한다.
    requestPlanReview(plan: string, signal?: AbortSignal) { return review?.(plan, signal) ?? Promise.resolve({ decision: "cancel" } as const); },
    // CLI가 아직 열리지 않았거나 종료됐으면 승인을 거부한다.
    requestApproval(request: PermissionRequest, signal?: AbortSignal) { return approve?.(request, signal) ?? Promise.resolve(false); },
    // 기존 CLI 실행 API는 유지하면서 승인 질문만 연결한다.
    run(options: CliOptions) { return runCli({ ...options, connectApproval(handler) {
      approve = handler;
      return () => { approve = undefined; };
    }, connectPlanReview(handler) {
      review = handler;
      return () => { review = undefined; };
    } }); },
  };
}

// 스트리밍으로 이미 화면에 쓴 답변 조각을 모아 둔다. 완성본이 오면 같은 내용을 두 번 찍지 않기 위해 비교한다.
let streamed = "";

// 진행 중인 스트리밍 줄을 마감하고 지금까지 쓴 텍스트를 돌려준다. 쓴 것이 없으면 아무것도 출력하지 않는다.
function endStream() {
  const shown = streamed;
  if (shown) {
    streamed = "";
    process.stdout.write("\n");
  }
  return shown;
}

// 완성된 답변을 표시한다. 스트리밍으로 같은 내용을 이미 썼으면 줄만 마감하고, 다르면 완성본을 다시 쓴다.
export function renderCliAnswer(text: string) {
  const shown = endStream();
  if (!shown) console.log(text);
  else if (text && text !== shown) console.log(text);
}

// 코어 진행 이벤트를 기존 CLI 출력 형식으로 표시한다.
export function renderCliEvent(event: AgentEvent) {
  // 조각은 줄바꿈 없이 이어 쓰고, 다른 이벤트가 오면 먼저 스트리밍 줄을 마감한다.
  if (event.type === "assistant-delta") {
    streamed += event.text;
    process.stdout.write(event.text);
    return;
  }
  if (event.type === "assistant-text") { renderCliAnswer(event.text); return; }
  endStream();
  switch (event.type) {
    case "mode-changed": console.log(`[mode] ${event.mode} · ${event.reason === "plan-approved" ? "계획 승인됨" : "사용자 전환 적용"}`); break;
    case "tool-start": console.log(`[tool] ${event.name} ${event.arguments}`); break;
    case "compaction-start": console.log("[context] 대화를 요약합니다..."); break;
    case "compaction-end": console.log(`[context] 압축 완료: ${event.beforeChars} → ${event.afterChars}자`); break;
    case "compaction-empty": console.log("[context] 최근 기록을 보존하면 요약할 오래된 구간이 없습니다."); break;
    case "output-limit-recovery": console.log(`[recovery] 출력 한도 도달 · 작업을 나눠 다시 요청합니다 (${event.attempt}/${event.maxAttempts})`); break;
    case "tool-results-pruned": console.log(`[context] 툴 결과 ${event.count}개 정리: ${event.beforeChars} → ${event.afterChars}자`); break;
  }
}

// 터미널 실행에 필요한 코어와 저장·종료 함수를 받는다.
export type CliOptions = {
  agent: Agent;
  paths: HarnessPaths;
  history: HistorySink;
  supportsImages?: boolean;
  dispose: () => Promise<void>;
  saveSession?: typeof persistSession;
  loadSession?: typeof restoreSession;
  connectApproval?: (handler: RequestApproval) => () => void;
  connectPlanReview?: (handler: RequestPlanReview) => () => void;
};

// 사용자 명령·이미지 첨부·터미널 종료를 처리한다. 코어는 입력 장치를 알지 못한다.
export async function runCli(options: CliOptions) {
  const { agent, paths, history, supportsImages, dispose,
    saveSession = persistSession, loadSession = restoreSession } = options;

  let session = createSession(paths.workspaceDirectory);
  let pendingImages: ImageBlock[] = [];

  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const disconnectApproval = options.connectApproval?.(createCliApproval(terminal));
  const disconnectPlanReview = options.connectPlanReview?.(createCliPlanReview(terminal));
  let cleanupPromise: Promise<void> | undefined;
  let interrupted = false;
  // 정상 종료와 중단이 겹쳐도 셸 작업과 MCP 연결을 한 번만 정리하고 실패를 알린다.
  function cleanupRuntime() {
    cleanupPromise ??= Promise.allSettled([dispose()])
      .then(async (results) => {
        await history.append({ sessionId: session.id }, { type: "session-close", reason: interrupted ? "SIGINT" : "runtime-exit" });
        await history.flush();
        const failures = results.filter((result) => result.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "런타임 정리 실패");
      });
    return cleanupPromise;
  }
  // 터미널 Ctrl+C와 운영체제 SIGINT 모두 같은 정리를 거쳐 종료한다.
  function handleInterrupt() {
    interrupted = true;
    agent.interrupt();
    terminal.close();
    void cleanupRuntime().catch(console.error).finally(() => process.exit(130));
  }
  terminal.on("SIGINT", handleInterrupt);
  process.once("SIGINT", handleInterrupt);
  console.log(`session: ${session.id}`);

  try {
    await history.append({ sessionId: session.id }, { type: "session-start",
      workspaceDirectory: session.workspaceDirectory, system: session.system });
    await saveSession(session, paths);
    while (true) {
      const input = await terminal.question("> ");
      if (input.trim().startsWith("/")) {
        await history.append({ sessionId: session.id }, { type: "command", input });
      }

      if (input.trim() === "/quit") {
        break;
      }

      if (input.trim().split(/\s/, 1)[0] === "/mode") {
        try {
          const target = input.trim().slice(5).trim();
          const result = agent.setMode(target === "yolo" ? "edit" : parseMode(target));
          agent.setPermissionMode(target === "yolo" ? "yolo" : "default");
          console.log(`[mode] ${target === "yolo" ? "YOLO · 모든 툴 권한 검사 우회" : agent.getMode()}${result === "queued" ? " · 모드는 다음 스텝부터" : ""}`);
        } catch (error) {
          console.log(error instanceof Error ? error.message : String(error));
        }
        continue;
      }

      if (input.trim().split(/\s/, 1)[0] === "/permissions") {
        try {
          agent.setPermissionMode(parsePermissionMode(input.trim().slice("/permissions".length).trim()));
          console.log(`[permissions] ${agent.getPermissionMode()} · ${agent.getPermissionMode() === "yolo" ? "모든 툴 권한 검사 우회 (plan의 쓰기 차단 포함)" : "정책 및 세션 승인 적용"}`);
        } catch (error) { console.log(error instanceof Error ? error.message : String(error)); }
        continue;
      }

      if (input.trim() === "/attach" || input.startsWith("/attach ")) {
        try {
          if (!supportsImages) throw new Error("현재 모델 연결은 이미지 입력이 비활성화되어 있습니다.");
          const image = await loadImage(attachmentPath(input));
          checkImageInput([{ role: "user", content: [...pendingImages, image] }], true, false);
          pendingImages.push(image);
          console.log(`[attach] ${image.path} (${image.width}×${image.height}) — 다음 메시지에 첨부합니다.`);
        } catch (error) {
          console.log(`[attach] ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }

      if (input.trim() === "/new") {
        session = createSession(paths.workspaceDirectory);
        pendingImages = [];
        await history.append({ sessionId: session.id }, { type: "session-start",
          workspaceDirectory: session.workspaceDirectory, system: session.system });
        await saveSession(session, paths);
        console.log(`new session: ${session.id}`);
        continue;
      }

      if (input.startsWith("/resume ")) {
        const id = input.slice("/resume ".length).trim();

        session = await loadSession(id, paths);
        pendingImages = [];
        await history.append({ sessionId: session.id }, { type: "session-resume", messageCount: session.messages.length });

        console.log(`resumed session: ${session.id}`);
        continue;
      }

      if (input.trim() === "/compact") {
        await agent.compact(session);
        continue;
      }

      if (input.trim() === "/reload-instructions") {
        session.projectInstructions = readProjectInstructions(paths.workspaceDirectory);
        await history.append({ sessionId: session.id }, { type: "instructions-reloaded", projectInstructions: session.projectInstructions });
        await saveSession(session, paths);
        console.log("[instructions] AGENTS.md를 다시 읽었습니다. 파일이 없으면 프로젝트 지침은 비워집니다.");
        continue;
      }

      const images = pendingImages;
      pendingImages = [];
      let output: string;
      // 실패해도 스트리밍 중이던 줄을 마감해 뒤따르는 오류 출력이 같은 줄에 붙지 않게 한다.
      try { output = await agent.turn(session, input, images); }
      catch (error) { endStream(); throw error; }

      await saveSession(session, paths);

      renderCliAnswer(output);
    }
  } catch (error) {
    // Ctrl+C로 question 또는 실행 중 명령이 취소된 오류는 중단 처리에서 마무리한다.
    if (!interrupted) throw error;
  } finally {
    disconnectApproval?.();
    disconnectPlanReview?.();
    terminal.close();
    await cleanupRuntime();
    process.removeListener("SIGINT", handleInterrupt);
  }
}
