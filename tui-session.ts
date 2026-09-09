import { createSession } from "./session.ts";
import { readProjectInstructions } from "./project-instructions.ts";
import { listSessions as readSessions, loadSession as restoreSession, saveSession as persistSession } from "./session-store.ts";
import { attachmentPath, checkImageInput, loadImage } from "./image-content.ts";
import { textOf } from "./llm-types.ts";
import type { ImageBlock } from "./llm-types.ts";
import type { Agent, AgentEvent } from "./agent.ts";
import type { HistorySink } from "./execution-history.ts";
import type { HarnessPaths } from "./harness-paths.ts";
import type { ExtensionControls, ExtensionItem } from "./extension-runtime.ts";
import type { ExtensionKind } from "./extension-settings.ts";
import { parsePermissionMode } from "./permissions.ts";
import type { PermissionRequest, ApprovalAnswer, PermissionMode } from "./permissions.ts";
import { parseMode } from "./agent-mode.ts";
import type { AgentMode } from "./agent-mode.ts";
import type { PlanReviewAnswer } from "./plan-review.ts";

// 입력창에서 선택할 수 있는 명령의 이름과 사용법이다.
export const TUI_COMMANDS = [
  { name: "/new", usage: "/new", description: "새 대화를 시작합니다." },
  { name: "/resume", usage: "/resume [session-id]", description: "목록에서 고르거나 ID로 세션을 엽니다." },
  { name: "/compact", usage: "/compact", description: "현재 대화를 요약해 컨텍스트를 줄입니다." },
  { name: "/attach", usage: '/attach "/path/to/image.png"', description: "다음 메시지에 PNG 이미지를 첨부합니다." },
  { name: "/skills", usage: "/skills", description: "스킬 목록을 보고 켜거나 끕니다." },
  { name: "/tools", usage: "/tools", description: "발견한 툴을 개별적으로 켜거나 끕니다." },
  { name: "/plugins", usage: "/plugins", description: "내장 기능 모듈을 묶어서 켜거나 끕니다." },
  { name: "/mcp", usage: "/mcp", description: "MCP 서버 연결을 켜거나 끕니다." },
  { name: "/reload-skills", usage: "/reload-skills", description: "전역·프로젝트 스킬 파일을 다시 읽습니다." },
  { name: "/reload-instructions", usage: "/reload-instructions", description: "작업 폴더의 AGENTS.md를 다시 읽습니다." },
  { name: "/mode", usage: "/mode plan|edit|yolo", description: "Shift+Tab: edit → plan → YOLO → edit" },
  { name: "/permissions", usage: "/permissions default|yolo", description: "YOLO는 모든 툴 권한 검사를 우회합니다." },
  { name: "/quit", usage: "/quit", description: "작업과 연결을 정리하고 종료합니다." },
] as const;

// 명령 이름을 입력하는 동안만 해당 모델에서 사용할 수 있는 후보를 반환한다.
export function commandSuggestions(input: string, supportsImages = false) {
  if (!/^\/\S*$/.test(input)) return [];
  return TUI_COMMANDS.filter((command) => command.name.startsWith(input)
    && (command.name !== "/attach" || supportsImages));
}

// 화면용 대화 항목이며 원문 실행 기록은 별도 history에 보존한다.
export type TuiEntry = { kind: "user" | "assistant" | "tool" | "notice" | "error"; text: string };
// React 화면이 구독할 현재 표시 상태다.
export type TuiState = {
  sessionId: string;
  mode: AgentMode;
  permissionMode: PermissionMode;
  entries: TuiEntry[];
  pendingImages: number;
  busy: boolean;
  status: string;
  closed: boolean;
  approval?: PermissionRequest;
  planReview?: { plan: string; feedback: boolean };
  resumePicker?: Awaited<ReturnType<typeof readSessions>>;
  extensionPicker?: { kind: ExtensionKind; items: ExtensionItem[]; error?: string };
};
// 이미 만들어진 코어와 저장·종료 함수를 TUI에 연결한다.
export type TuiOptions = {
  agent: Agent;
  history: HistorySink;
  paths: HarnessPaths;
  model: string;
  supportsImages?: boolean;
  dispose: () => Promise<void>;
  saveSession?: typeof persistSession;
  loadSession?: typeof restoreSession;
  listSessions?: typeof readSessions;
  extensions?: ExtensionControls;
};

// 화면과 독립적으로 명령·세션·첨부 대기열을 관리해 테스트에서도 그대로 실행한다.
export function createTuiSession(options: TuiOptions) {
  const { agent, history, paths, supportsImages, dispose,
    saveSession = persistSession, loadSession = restoreSession, listSessions = readSessions } = options;
  let session = createSession(paths.workspaceDirectory);
  let images: ImageBlock[] = [];
  let failedTurn = false;
  let closePromise: Promise<void> | undefined;
  let activeTurn: Promise<string> | undefined;
  let stopping = false;
  let state: TuiState = { sessionId: session.id, mode: agent.getMode(), permissionMode: agent.getPermissionMode(), entries: [], pendingImages: 0, busy: false, status: "대기 중", closed: false };
  const listeners = new Set<() => void>();
  let finishApproval: ((approved: ApprovalAnswer) => void) | undefined;
  let finishPlanReview: ((answer: PlanReviewAnswer) => void) | undefined;

  // 계획을 일반 출력과 구분해 표시하고 승인·피드백·중단 선택을 기다린다.
  function requestPlanReview(plan: string, signal?: AbortSignal): Promise<PlanReviewAnswer> {
    if (state.closed || signal?.aborted || finishApproval || finishPlanReview) return Promise.resolve({ decision: "cancel" });
    const wasBusy = state.busy;
    return new Promise((resolve) => {
      // 턴 중단과 UI 종료는 승인으로 해석하지 않는다.
      const onAbort = () => finishPlanReview?.({ decision: "cancel" });
      finishPlanReview = (answer) => {
        signal?.removeEventListener("abort", onAbort);
        finishPlanReview = undefined;
        const result = signal?.aborted || state.closed ? { decision: "cancel" } as const : answer;
        update({ planReview: undefined, busy: state.closed || wasBusy });
        append("notice", result.decision === "approve" ? "계획 승인 · 다음 스텝부터 edit"
          : result.decision === "revise" ? `계획 수정 요청: ${result.feedback}` : "계획 검토 취소");
        resolve(result);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      append("notice", `[계획 검토]\n${plan}`);
      update({ planReview: { plan, feedback: false }, busy: true, status: "계획 검토 · Y 승인 · N 수정 의견 · Esc 취소" });
    });
  }

  // 승인 내용을 대화 영역에 전부 표시하고 답변·중단·종료 중 하나를 기다린다.
  function requestApproval(request: PermissionRequest, signal?: AbortSignal): Promise<ApprovalAnswer> {
    if (state.closed || signal?.aborted || finishApproval || finishPlanReview) return Promise.resolve(false);
    const wasBusy = state.busy;
    return new Promise((resolve) => {
      // 중단된 요청의 늦은 승인 클릭은 실행 권한을 주지 않는다.
      const onAbort = () => finishApproval?.(false);
      finishApproval = (approved) => {
        signal?.removeEventListener("abort", onAbort);
        finishApproval = undefined;
        const accepted = !signal?.aborted && !state.closed ? approved : false;
        update({ approval: undefined, busy: state.closed || wasBusy, status: state.closed ? "종료 중" : "처리 중" });
        append("notice", accepted === "session" ? `세션 승인: ${request.toolName} · 모든 인자 허용` : accepted ? "툴 실행 일회 승인" : "툴 실행 승인 거부·취소");
        resolve(accepted);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      append("notice", `[승인 요청] ${JSON.stringify(request.toolName)}\n${JSON.stringify(request.args, null, 2)}`);
      update({ approval: structuredClone(request), busy: true, status: "Y 일회 · S 세션: 이 툴의 모든 인자 승인 · N/Enter 거부" });
    });
  }

  // 상태 객체를 교체한 뒤 화면 구독자에게 갱신을 알린다.
  function update(patch: Partial<TuiState>) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  // 새 화면 항목을 추가하되 종료가 시작된 뒤에는 화면을 갱신하지 않는다.
  function append(kind: TuiEntry["kind"], text: string) {
    if (!state.closed) update({ entries: [...state.entries, { kind, text }] });
  }
  // 새 세션의 시작 기록과 초기 스냅샷을 보존한다.
  async function start() {
    await history.append({ sessionId: session.id }, { type: "session-start", workspaceDirectory: session.workspaceDirectory, system: session.system });
    await saveSession(session, paths);
  }
  // 코어의 진행 이벤트를 화면 항목과 상태 표시로 변환한다.
  function onEvent(event: AgentEvent) {
    if (state.closed) return;
    switch (event.type) {
      case "mode-changed": update({ mode: event.mode }); break;
      case "assistant-text": append("assistant", event.text); break;
      case "tool-start":
        append("tool", `${event.name} ${event.arguments}`);
        update({ status: `실행 중 · ${event.name}` });
        break;
      case "tool-end": {
        const text = typeof event.content === "string" ? event.content : event.content.map((block) =>
          block.type === "text" ? block.text : `[이미지 ${block.width}×${block.height}]`).join("\n");
        const firstLine = text.split(/\r?\n/).find((line) => line.trim())?.trim() || "(출력 없음)";
        append("tool", `${event.isError ? "실패" : "성공"} · ${event.name} · ${(event.durationMs / 1000).toFixed(2)}s · ${firstLine}`);
        update({ status: stopping ? "중단 요청됨 · 실행 정리 중" : "모델 응답 대기 중" });
        break;
      }
      case "turn-interrupt-requested": stopping = true; update({ status: "중단 요청됨 · 실행 정리 중" }); break;
      case "turn-interrupted": append("notice", "턴 중단 완료 · 완료한 변경은 유지됩니다. 다음 요청을 입력하세요."); break;
      case "compaction-start": update({ status: "대화 요약 중" }); break;
      case "compaction-end": append("notice", `압축 완료: ${event.beforeChars} → ${event.afterChars}자`); break;
      case "compaction-empty": append("notice", "최근 기록을 보존하면 요약할 오래된 구간이 없습니다."); break;
      case "output-limit-recovery":
        append("notice", `출력 한도 도달 · 작업을 나눠 다시 요청합니다 (${event.attempt}/${event.maxAttempts})`);
        update({ status: "출력 한도 복구 중" });
        break;
      case "tool-results-pruned": append("notice", `툴 결과 ${event.count}개 정리: ${event.beforeChars} → ${event.afterChars}자`); break;
    }
  }
  // 명령 또는 사용자 요청을 하나씩 실행하며 입력 오류는 화면에 표시한다.
  async function submit(input: string) {
    if (state.busy || state.closed || !input.trim()) return;
    update({ busy: true, status: "처리 중" });
    const trimmed = input.trim();
    const name = trimmed.split(/\s/, 1)[0];
    try {
      if (trimmed.startsWith("/")) {
        await history.append({ sessionId: session.id }, { type: "command", input });
        const command = TUI_COMMANDS.find((entry) => entry.name === name);
        if (!command) throw new Error("알 수 없는 명령입니다. /를 입력해 사용 가능한 명령을 확인하세요.");
        if (!["/attach", "/resume", "/mode", "/permissions"].includes(name) && trimmed !== name) throw new Error(`사용법: ${command.usage}`);
        if (name === "/quit") { await close(); return; }
        if (["/skills", "/tools", "/plugins", "/mcp"].includes(name)) {
          if (!options.extensions) throw new Error("확장 기능 관리가 연결되지 않았습니다.");
          const kind = name.slice(1) as ExtensionKind;
          update({ resumePicker: undefined, extensionPicker: { kind, items: options.extensions.list(kind) } });
        } else if (name === "/permissions") {
          agent.setPermissionMode(parsePermissionMode(trimmed.slice(name.length).trim()));
          update({ permissionMode: agent.getPermissionMode() });
          append("notice", agent.getPermissionMode() === "yolo" ? "YOLO: 모든 툴 권한 검사 우회 (plan의 쓰기 차단 포함)" : "권한 정책 및 세션 승인 적용");
        } else if (name === "/mode") {
          const target = trimmed.slice(name.length).trim();
          agent.setMode(target === "yolo" ? "edit" : parseMode(target));
          agent.setPermissionMode(target === "yolo" ? "yolo" : "default");
          update({ mode: agent.getMode(), permissionMode: agent.getPermissionMode() });
          append("notice", target === "yolo" ? "YOLO: edit + 모든 툴 권한 검사 우회" : `모드: ${agent.getMode()} · 일반 권한 정책`);
        } else if (name === "/reload-instructions") {
          session.projectInstructions = readProjectInstructions(paths.workspaceDirectory);
          await history.append({ sessionId: session.id }, { type: "instructions-reloaded", projectInstructions: session.projectInstructions });
          await saveSession(session, paths);
          append("notice", "AGENTS.md를 다시 읽었습니다. 파일이 없으면 프로젝트 지침은 비워집니다.");
        } else if (name === "/reload-skills") {
          if (!options.extensions) throw new Error("확장 기능 관리가 연결되지 않았습니다.");
          await options.extensions.reloadSkills();
          append("notice", "스킬 목록을 다시 읽었습니다. 기존 대화에 읽힌 본문은 유지됩니다.");
        } else if (name === "/attach") {
          if (!supportsImages) throw new Error("현재 모델 연결은 이미지 입력이 비활성화되어 있습니다.");
          const image = await loadImage(attachmentPath(trimmed));
          checkImageInput([{ role: "user", content: [...images, image] }], true, false);
          images.push(image);
          update({ pendingImages: images.length });
          append("notice", `첨부: ${image.path} (${image.width}×${image.height}) — 다음 메시지에 전달`);
        } else if (name === "/new" || name === "/resume") {
          const id = trimmed.slice(name.length).trim();
          if (name === "/resume" && !id) {
            const resumePicker = await listSessions(paths);
            if (!state.closed) update({ resumePicker, extensionPicker: undefined });
            return;
          }
          session = name === "/new" ? createSession(paths.workspaceDirectory) : await loadSession(id, paths);
          images = [];
          failedTurn = false;
          update({ sessionId: session.id, pendingImages: 0, resumePicker: undefined, extensionPicker: undefined, entries: session.messages.flatMap((message): TuiEntry[] => {
            const text = textOf(message);
            return text && message.role !== "tool" ? [{ kind: message.role === "user" ? "user" : "assistant", text }] : [];
          }) });
          if (name === "/new") await start();
          else await history.append({ sessionId: session.id }, { type: "session-resume", messageCount: session.messages.length });
          append("notice", `${name === "/new" ? "새 세션" : "세션 재개"}: ${session.id}`);
        } else if (name === "/compact") {
          await agent.compact(session);
        }
      } else {
        if (failedTurn) throw new Error("이전 실행이 실패했습니다. /new 또는 /resume으로 세션을 선택해 주세요.");
        append("user", input);
        const attachments = images;
        images = [];
        update({ pendingImages: 0, status: "모델 응답 대기 중" });
        try {
          activeTurn = agent.turn(session, input, attachments);
          const output = await activeTurn;
          if (!state.closed) {
            await saveSession(session, paths);
            if (output) append("assistant", output);
          }
        } catch (error) { failedTurn = true; throw error; }
        finally { activeTurn = undefined; stopping = false; }
      }
    } catch (error) {
      append("error", error instanceof Error ? error.message : String(error));
    } finally {
      if (!state.closed) update({ busy: false, status: failedTurn ? "실행 실패 · /new 또는 /resume" : "대기 중" });
    }
  }
  // 에이전트가 실행 중일 때는 토글을 거부하고 저장·연결 중에도 중복 입력을 막는다.
  async function toggleExtension(name: string) {
    const picker = state.extensionPicker;
    if (state.busy || state.closed || !picker || !options.extensions) return;
    update({ busy: true, status: "확장 설정 반영 중" });
    let error: string | undefined;
    try {
      await options.extensions.toggle(picker.kind, name);
      await history.append({ sessionId: session.id }, { type: "command", input: `/${picker.kind} toggle ${name}` });
    } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    finally {
      if (!state.closed) update({ busy: false, status: "대기 중",
        extensionPicker: { kind: picker.kind, items: options.extensions.list(picker.kind), error } });
    }
  }
  // quit·Ctrl+C·화면 종료가 겹쳐도 소유 자원과 기록을 한 번만 정리한다.
  function close(reason = "runtime-exit") {
    closePromise ??= Promise.resolve().then(async () => {
      update({ closed: true, busy: true, status: "종료 중" });
      finishApproval?.(false);
      finishPlanReview?.({ decision: "cancel" });
      agent.interrupt();
      await activeTurn?.catch(() => {});
      const [result] = await Promise.allSettled([dispose()]);
      await history.append({ sessionId: session.id }, { type: "session-close", reason });
      await history.flush();
      if (result.status === "rejected") throw result.reason;
    });
    return closePromise;
  }
  return {
    start, submit, close, onEvent, toggleExtension, requestApproval, requestPlanReview,
    // 수정 의견 입력으로 바꾸되 승인 여부를 아직 확정하지 않는다.
    beginPlanFeedback() {
      if (state.planReview) update({ planReview: { ...state.planReview, feedback: true }, status: "계획 수정 의견 입력 · Enter 제출 · Esc 취소" });
    },
    // 계획 검토의 선택을 대기 중인 코어에 전달한다.
    answerPlanReview(answer: PlanReviewAnswer) { finishPlanReview?.(answer); },
    // 승인 화면의 키 입력은 일반 사용자 메시지로 전달하지 않는다.
    answerApproval(approved: ApprovalAnswer) { finishApproval?.(approved); },
    // 중단 완료 전까지 busy를 유지하며 다음 요청과 현재 턴이 겹치지 않게 한다.
    interrupt() { if (activeTurn && agent.interrupt()) { stopping = true; update({ status: "중단 요청됨 · 실행 정리 중" }); } },
    // 확장 목록을 닫아도 변경한 프로젝트 설정은 유지한다.
    dismissExtensionPicker() { if (!state.busy) update({ extensionPicker: undefined }); },
    // 선택 취소는 현재 세션과 첨부를 바꾸지 않고 목록만 닫는다.
    dismissResumePicker() { update({ resumePicker: undefined }); },
    // 마지막 불변 스냅샷을 반환해 화면의 불필요한 재렌더링을 피한다.
    getSnapshot: () => state,
    // 구독이 끝나면 해당 화면의 리스너만 제거한다.
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

// 화면과 테스트가 사용하는 TUI 세션 제어 객체의 타입이다.
export type TuiSession = ReturnType<typeof createTuiSession>;
