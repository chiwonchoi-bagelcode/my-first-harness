import { createSession } from "./session.ts";
import { listSessions as readSessions, loadSession as restoreSession, saveSession as persistSession } from "./session-store.ts";
import { attachmentPath, checkImageInput, loadImage } from "./image-content.ts";
import { textOf } from "./llm-types.ts";
import type { ImageBlock } from "./llm-types.ts";
import type { Agent, AgentEvent } from "./agent.ts";
import type { HistorySink } from "./execution-history.ts";
import type { HarnessPaths } from "./harness-paths.ts";

// 입력창에서 선택할 수 있는 명령의 이름과 사용법이다.
export const TUI_COMMANDS = [
  { name: "/new", usage: "/new", description: "새 대화를 시작합니다." },
  { name: "/resume", usage: "/resume [session-id]", description: "목록에서 고르거나 ID로 세션을 엽니다." },
  { name: "/compact", usage: "/compact", description: "현재 대화를 요약해 컨텍스트를 줄입니다." },
  { name: "/attach", usage: '/attach "/path/to/image.png"', description: "다음 메시지에 PNG 이미지를 첨부합니다." },
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
  entries: TuiEntry[];
  pendingImages: number;
  busy: boolean;
  status: string;
  closed: boolean;
  resumePicker?: Awaited<ReturnType<typeof readSessions>>;
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
};

// 화면과 독립적으로 명령·세션·첨부 대기열을 관리해 테스트에서도 그대로 실행한다.
export function createTuiSession(options: TuiOptions) {
  const { agent, history, paths, supportsImages, dispose,
    saveSession = persistSession, loadSession = restoreSession, listSessions = readSessions } = options;
  let session = createSession(paths.workspaceDirectory);
  let images: ImageBlock[] = [];
  let failedTurn = false;
  let closePromise: Promise<void> | undefined;
  let state: TuiState = { sessionId: session.id, entries: [], pendingImages: 0, busy: false, status: "대기 중", closed: false };
  const listeners = new Set<() => void>();

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
      case "assistant-text": append("assistant", event.text); break;
      case "tool-start":
        append("tool", `${event.name} ${event.arguments}`);
        update({ status: `실행 중 · ${event.name}` });
        break;
      case "compaction-start": update({ status: "대화 요약 중" }); break;
      case "compaction-end": append("notice", `압축 완료: ${event.beforeChars} → ${event.afterChars}자`); break;
      case "compaction-empty": append("notice", "요약할 대화가 없습니다."); break;
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
        if (name !== "/attach" && name !== "/resume" && trimmed !== name) throw new Error(`사용법: ${command.usage}`);
        if (name === "/quit") { await close(); return; }
        if (name === "/attach") {
          if (!supportsImages) throw new Error("현재 모델 연결은 이미지 입력이 비활성화되어 있습니다.");
          const image = await loadImage(attachmentPath(trimmed));
          checkImageInput([...session.messages, { role: "user", content: [...images, image] }], true);
          images.push(image);
          update({ pendingImages: images.length });
          append("notice", `첨부: ${image.path} (${image.width}×${image.height}) — 다음 메시지에 전달`);
        } else if (name === "/new" || name === "/resume") {
          const id = trimmed.slice(name.length).trim();
          if (name === "/resume" && !id) {
            const resumePicker = await listSessions(paths);
            if (!state.closed) update({ resumePicker });
            return;
          }
          session = name === "/new" ? createSession(paths.workspaceDirectory) : await loadSession(id, paths);
          images = [];
          failedTurn = false;
          update({ sessionId: session.id, pendingImages: 0, resumePicker: undefined, entries: session.messages.flatMap((message): TuiEntry[] => {
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
          const output = await agent.turn(session, input, attachments);
          if (!state.closed) {
            await saveSession(session, paths);
            append("assistant", output);
          }
        } catch (error) { failedTurn = true; throw error; }
      }
    } catch (error) {
      append("error", error instanceof Error ? error.message : String(error));
    } finally {
      if (!state.closed) update({ busy: false, status: failedTurn ? "실행 실패 · /new 또는 /resume" : "대기 중" });
    }
  }
  // quit·Ctrl+C·화면 종료가 겹쳐도 소유 자원과 기록을 한 번만 정리한다.
  function close(reason = "runtime-exit") {
    closePromise ??= Promise.resolve().then(async () => {
      update({ closed: true, busy: true, status: "종료 중" });
      const [result] = await Promise.allSettled([dispose()]);
      await history.append({ sessionId: session.id }, { type: "session-close", reason });
      await history.flush();
      if (result.status === "rejected") throw result.reason;
    });
    return closePromise;
  }
  return {
    start, submit, close, onEvent,
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
