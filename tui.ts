import { createElement as h, useEffect, useState, useSyncExternalStore } from "react";
import { Box, Text, render, useInput, useWindowSize, useStdout } from "ink";
import { TuiInput, layoutInput } from "./tui-input.ts";
import wrapAnsi from "wrap-ansi";
import { stripVTControlCharacters } from "node:util";
import { commandSuggestions, createTuiSession } from "./tui-session.ts";
import type { TuiEntry, TuiOptions, TuiSession } from "./tui-session.ts";
import type { AgentEvent } from "./agent.ts";
import type { PermissionRequest } from "./permissions.ts";

// 모델·툴 출력의 터미널 제어문자는 화면에 실행하지 않는다. 원문 기록은 바꾸지 않는다.
function displayText(text: string) {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

// 표시 너비에 맞춰 대화를 줄로 나눈다. 긴 툴 인자는 화면에서만 짧게 보여준다.
export function conversationLines(entries: TuiEntry[], columns: number) {
  return entries.flatMap((entry) => {
    const prefix = { user: "나 › ", assistant: "에이전트 › ", tool: "  ↳ ", notice: "· ", error: "오류 › " }[entry.kind];
    const plain = displayText(entry.text);
    const text = entry.kind === "tool" && plain.length > 180 ? plain.slice(0, 180) + " …" : plain;
    if (entry.kind === "tool") return [{ kind: entry.kind, text: prefix + text.split("\n")[0] }];
    return wrapAnsi(prefix + text, Math.max(1, columns), { hard: true, trim: false })
      .split("\n").map((line) => ({ kind: entry.kind, text: line }));
  });
}

// 세션 상태를 표시하고 명령 후보 선택과 입력창 조작을 처리한다.
export function TuiScreen({ controller, model, supportsImages = false, onQuit }: {
  controller: TuiSession; model: string; supportsImages?: boolean; onQuit: () => void;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const { rows, columns } = useWindowSize();
  const { stdout } = useStdout();
  // Ink 7.1.1의 fullscreen 경로는 끝 개행을 생략해 useCursor가 한 줄 어긋나므로 마지막 줄을 비운다.
  const screenRows = Math.max(1, rows - 1);
  const [input, setInput] = useState("");
  const [planFeedback, setPlanFeedback] = useState("");
  const [selected, setSelected] = useState(0);
  const [menuHidden, setMenuHidden] = useState(false);
  const [inputVersion, setInputVersion] = useState(0);
  // null이면 최신 출력 추적, 숫자이면 보고 있는 첫 줄을 고정한다.
  const [scroll, setScroll] = useState<number | null>(null);
  const [resumeSelected, setResumeSelected] = useState(0);
  const [extensionSelected, setExtensionSelected] = useState(0);
  const picker = state.resumePicker;
  const extensionPicker = state.extensionPicker;
  const allCandidates = menuHidden || picker || extensionPicker || state.approval || state.planReview ? [] : commandSuggestions(input, supportsImages);
  const selectedIndex = Math.min(selected, Math.max(0, allCandidates.length - 1));
  // 명령이 늘어나도 작은 터미널에서 입력창이 화면 밖으로 밀리지 않게 한다.
  const candidateCount = Math.max(1, Math.min(allCandidates.length, rows - 13));
  const candidateStart = Math.max(0, selectedIndex - candidateCount + 1);
  const candidates = allCandidates.slice(candidateStart, candidateStart + candidateCount);
  const choice = allCandidates[selectedIndex];
  const menuRows = candidates.length ? candidates.length + 3 : 0;
  const inputWidth = Math.max(2, columns - 6);
  const inputRows = Math.min(5, Math.max(1, screenRows - menuRows - 10), layoutInput(state.planReview?.feedback ? planFeedback : input, inputWidth).lines.length);
  const feedRows = Math.max(0, screenRows - menuRows - inputRows - 6);
  const resumeIndex = Math.min(resumeSelected, Math.max(0, (picker?.sessions.length ?? 0) - 1));
  const resumeCount = Math.max(1, feedRows - 4);
  const resumeStart = Math.max(0, resumeIndex - resumeCount + 1);
  const extensionIndex = Math.min(extensionSelected, Math.max(0, (extensionPicker?.items.length ?? 0) - 1));
  const extensionCount = Math.max(1, feedRows - 5);
  const extensionStart = Math.max(0, extensionIndex - extensionCount + 1);
  const extension = extensionPicker?.items[extensionIndex];
  const lines = conversationLines(state.entries, Math.max(1, columns));
  const bottom = Math.max(0, lines.length - feedRows);
  const top = scroll === null ? bottom : Math.min(scroll, bottom);
  const offset = bottom - top;
  const visible = lines.slice(top, top + feedRows);

  // SGR 마우스 보고를 켜 휠·트랙패드 이벤트를 받고 화면 종료 시 원래 모드로 복원한다.
  useEffect(() => {
    if (!stdout.isTTY) return;
    stdout.write("\x1b[?1000h\x1b[?1006h");
    return () => { stdout.write("\x1b[?1006l\x1b[?1000l"); };
  }, [stdout]);
  // 연속 휠 이벤트도 누적하며 맨 아래에 도달하면 새 출력 자동 추적을 재개한다.
  function moveScroll(delta: number) {
    setScroll((current) => {
      const next = Math.max(0, Math.min(bottom, (current ?? bottom) + delta));
      return next === bottom ? null : next;
    });
  }

  // 새 세션에서는 화면 위치를 최신 내용으로 되돌린다.
  useEffect(() => { setScroll(null); }, [state.sessionId]);
  // 승인 요청이 도착하면 이전 스크롤 위치 대신 새 요청을 보여준다.
  useEffect(() => { if (state.approval) setScroll(null); }, [state.approval]);
  // 새 계획은 최신 출력으로 이동하며 이전 검토의 수정 의견을 재사용하지 않는다.
  useEffect(() => { if (state.planReview) setScroll(null); setPlanFeedback(""); }, [state.planReview?.plan]);
  // 목록을 새로 열면 최신 저장 세션부터 선택한다.
  useEffect(() => { setResumeSelected(0); }, [picker]);
  // 토글 후에는 선택을 유지하고 다른 종류의 목록을 열 때만 처음으로 돌아간다.
  useEffect(() => { setExtensionSelected(0); }, [extensionPicker?.kind]);
  // 명령 선택은 실행하지 않고 입력창에 채우며 새 입력 커서를 끝으로 옮긴다.
  function complete() {
    if (!choice) return;
    setInput(choice.name + (["/attach", "/resume", "/mode", "/permissions"].includes(choice.name) ? " " : ""));
    setMenuHidden(true);
    setInputVersion((version) => version + 1);
  }
  // 후보가 열려 있으면 선택하고, 닫혀 있으면 현재 입력을 한 번 실행한다.
  function submit(value: string) {
    if (state.planReview?.feedback) {
      if (value.trim()) controller.answerPlanReview({ decision: "revise", feedback: value.trim() });
      return;
    }
    if (state.busy) return;
    if (choice) { complete(); return; }
    if (!value.trim()) return;
    setInput("");
    setSelected(0);
    setMenuHidden(false);
    setScroll(null);
    void controller.submit(value);
  }
  useInput((value, key) => {
    if (key.eventType === "release") return;
    if (key.ctrl && value === "c") { onQuit(); return; }
    const mouse = /^\[<(\d+);(\d+);(\d+)([Mm])$/.exec(value);
    if (mouse) {
      const button = Number(mouse[1]);
      const y = Number(mouse[3]);
      if (!picker && !extensionPicker && mouse[4] === "M" && y >= 3 && y < 3 + feedRows) {
        if ((button & 67) === 64) moveScroll(-3);
        if ((button & 67) === 65) moveScroll(3);
      }
      return;
    }
    if (state.planReview && key.escape) { controller.answerPlanReview({ decision: "cancel" }); return; }
    if (state.busy && key.escape) { controller.interrupt(); return; }
    if (key.shift && key.tab) {
      if (!state.busy && !picker && !extensionPicker) {
        void controller.submit(`/mode ${state.permissionMode === "yolo" ? "edit" : state.mode === "edit" ? "plan" : "yolo"}`);
      }
      return;
    }
    if (extensionPicker) {
      if (state.busy) return;
      if (key.escape) { controller.dismissExtensionPicker(); return; }
      if (key.upArrow) setExtensionSelected(Math.max(0, extensionIndex - 1));
      if (key.downArrow) setExtensionSelected(Math.min(extensionPicker.items.length - 1, extensionIndex + 1));
      if ((value === " " || key.return) && extension) void controller.toggleExtension(extension.name);
      return;
    }
    if (picker) {
      if (state.busy) return;
      if (key.escape) { controller.dismissResumePicker(); return; }
      if (key.upArrow) setResumeSelected(Math.max(0, resumeIndex - 1));
      if (key.downArrow) setResumeSelected(Math.min(picker.sessions.length - 1, resumeIndex + 1));
      if (key.return && !key.shift && picker.sessions[resumeIndex]) {
        void controller.submit(`/resume ${picker.sessions[resumeIndex].id}`);
      }
      return;
    }
    if (key.pageUp) moveScroll(-feedRows);
    if (key.pageDown) moveScroll(feedRows);
    if (state.planReview) {
      if (rows < 16 || columns < 40 || state.planReview.feedback) return;
      if (!key.ctrl && !key.meta && value.toLowerCase() === "y") controller.answerPlanReview({ decision: "approve" });
      else if (value.toLowerCase() === "n") controller.beginPlanFeedback();
      return;
    }
    if (state.approval) {
      if (rows < 16 || columns < 40) return;
      if (!key.ctrl && !key.meta && value.toLowerCase() === "y") controller.answerApproval(true);
      else if (!key.ctrl && !key.meta && value.toLowerCase() === "s") controller.answerApproval("session");
      else if (value.toLowerCase() === "n" || key.return) controller.answerApproval(false);
      return;
    }
    if (state.busy) return;
    if (key.escape) setMenuHidden(true);
    if (choice && key.upArrow) setSelected((selectedIndex + allCandidates.length - 1) % allCandidates.length);
    if (choice && key.downArrow) setSelected((selectedIndex + 1) % allCandidates.length);
    if (choice && key.tab) complete();
  });

  if (rows < 16 || columns < 40) {
    return h(Text, { color: "yellow" }, "터미널을 40열 × 16줄 이상으로 넓혀주세요. Ctrl+C 종료");
  }

  return h(Box, { flexDirection: "column", width: columns, height: screenRows },
    h(Text, { bold: true, color: state.permissionMode === "yolo" ? "red" : "cyan", wrap: "truncate-end" }, `My First Harness · ${model} · [${state.mode}]${state.permissionMode === "yolo" ? " [YOLO]" : ""} · ${state.sessionId}`),
    h(Text, { dimColor: true }, "─".repeat(Math.max(1, columns))),
    extensionPicker ? h(Box, { flexDirection: "column", height: feedRows, flexShrink: 0, overflow: "hidden" },
      h(Text, { bold: true, color: "cyan", wrap: "truncate-end" }, `${extensionPicker.kind} · 프로젝트 설정 · 다음 요청부터 반영`),
      ...(extensionPicker.items.length ? extensionPicker.items.slice(extensionStart, extensionStart + extensionCount).map((item, index) =>
        h(Text, { key: item.name, color: extensionStart + index === extensionIndex ? "cyan" : undefined, wrap: "truncate-end" },
          `${extensionStart + index === extensionIndex ? "❯" : " "} [${item.enabled ? "on" : "off"}] ${displayText(item.name)}${item.error ? " · 실패" : item.enabled && !item.active ? " · 소속 비활성/미연결" : ""}${item.owner ? ` · ${displayText(item.owner)}` : ""}`))
        : [h(Text, { key: "empty", dimColor: true }, "항목 없음 · 툴 목록은 소속 플러그인/MCP를 켜서 발견합니다.")]),
      h(Text, { wrap: "truncate-end" }, displayText(extension?.description ?? "")),
      h(Text, { dimColor: true, wrap: "truncate-end" }, extensionPicker.kind === "skills" ? "기존에 읽힌 스킬 본문은 남습니다. /reload-skills로 파일 재탐색" : "↑↓ 선택 · Space/Enter 토글 · Esc 닫기 · 설정은 자동 저장"),
      h(Text, { dimColor: true, wrap: "truncate-end" }, extensionPicker.kind === "skills" ? "↑↓ 선택 · Space/Enter 토글 · Esc 닫기"
        : extensionPicker.kind === "plugins" && extension?.name === "shell" ? "주의: 끄면 실행 중인 셸 작업도 종료됩니다."
        : "소속을 켜도 개별 툴의 off 설정은 유지됩니다."),
      h(Text, { color: "red", wrap: "truncate-end" }, displayText(extensionPicker.error ?? extension?.error ?? "")))
    : picker ? h(Box, { flexDirection: "column", height: feedRows, flexShrink: 0, overflow: "hidden" },
      h(Text, { bold: true, color: "cyan", wrap: "truncate-end" }, "세션 선택 · 현재 프로젝트 · 최신 저장 순"),
      ...(picker.sessions.length ? picker.sessions.slice(resumeStart, resumeStart + resumeCount).map((session, index) =>
        h(Text, { key: session.id, color: resumeStart + index === resumeIndex ? "cyan" : undefined, wrap: "truncate-end" },
          `${resumeStart + index === resumeIndex ? "❯" : " "} ${new Date(session.updatedAt).toLocaleString("ko-KR")} · ${displayText(session.title)}${session.id === state.sessionId ? " (현재)" : ""}`))
        : [h(Text, { key: "empty", dimColor: true }, "저장된 세션이 없습니다.")]),
      h(Text, { dimColor: true, wrap: "truncate-end" }, picker.sessions[resumeIndex]?.id ?? ""),
      h(Text, { dimColor: true, wrap: "truncate-end" }, `↑↓ 선택 · Enter 재개 · Esc 취소${picker.skippedFiles ? ` · 읽을 수 없는 파일 ${picker.skippedFiles}개 제외` : ""}`),
      state.entries.at(-1)?.kind === "error" ? h(Text, { color: "red", wrap: "truncate-end" }, displayText(state.entries.at(-1)!.text)) : null)
    : h(Box, { flexDirection: "column", height: feedRows, flexShrink: 0, overflow: "hidden" },
      ...visible.map((line, index) => h(Text, { key: index, wrap: "truncate-end",
        color: line.kind === "user" ? "cyan" : line.kind === "error" ? "red" : undefined,
        dimColor: line.kind === "tool" || line.kind === "notice",
      }, line.text)),
      state.entries.length ? null : h(Text, { dimColor: true }, "메시지를 입력하세요. /를 누르면 명령과 사용법을 볼 수 있습니다.")),
    candidates.length ? h(Box, { flexDirection: "column", height: menuRows, flexShrink: 0 },
      h(Text, { color: "cyan", wrap: "truncate-end" }, "명령 선택 · ↑↓ 이동 · Enter/Tab 채우기 · Esc 닫기"),
      ...candidates.map((command) => h(Text, { key: command.name, color: command === choice ? "cyan" : undefined,
        bold: command === choice, wrap: "truncate-end" }, `${command === choice ? "❯" : " "} ${command.name}  ${command.description}`)),
      h(Text, { wrap: "truncate-end" }, `사용법: ${choice?.usage}`),
      h(Text, { dimColor: true, wrap: "truncate-end" }, "입력창에 채운 후 Enter를 다시 누르면 실행합니다.")) : null,
    h(Box, { borderStyle: "round", borderColor: state.busy || picker || extensionPicker ? "gray" : "cyan", height: inputRows + 2, flexShrink: 0, overflow: "hidden" },
      h(Text, { color: "cyan" }, "> "),
      h(TuiInput, { key: `${inputVersion}-${Boolean(state.planReview?.feedback)}`, value: state.planReview?.feedback ? planFeedback : input, width: inputWidth, height: inputRows,
        cursorStart: { x: 3, y: 3 + feedRows + menuRows }, focus: Boolean(state.planReview?.feedback) || (!state.busy && !picker && !extensionPicker), menuOpen: Boolean(choice),
        placeholder: state.planReview ? (state.planReview.feedback ? "수정 의견 입력 · Enter 제출 · Esc 취소" : "Y 계획 승인 · N 수정 의견 · Esc 취소 · PgUp/PgDn 검토") : state.approval ? "Y 일회 · S 세션(모든 인자) · N/Enter 거부" : extensionPicker ? "Space/Enter 토글 · Esc 닫기" : picker ? "목록에서 세션을 선택하세요." : state.busy ? "실행 중 · 새 요청은 완료 후 입력" : "메시지 또는 /명령",
        onChange(value) { if (state.planReview?.feedback) setPlanFeedback(value); else { setInput(value); setSelected(0); setMenuHidden(false); } }, onSubmit: submit })),
    h(Text, { color: state.busy ? "yellow" : "green", wrap: "truncate-end" }, `상태: ${state.status}${state.pendingImages ? ` · 첨부 ${state.pendingImages}개` : ""}`),
    h(Text, { dimColor: true, wrap: "truncate-end" }, `${offset ? "이전 내용 · " : ""}Shift+Tab 모드 · 휠/PgUp/PgDn 스크롤 · Esc 턴 중단 · Enter 전송 · / 명령 · Ctrl+C 종료`),
  );
}

// 코어의 이벤트 수신 함수를 먼저 만들고, 실행 시 터미널 화면과 연결한다.
export function createTui() {
  let controller: TuiSession | undefined;
  return {
    // 화면에 계획 전문을 제시하고 승인 또는 수정 의견을 받는다.
    requestPlanReview(plan: string, signal?: AbortSignal) { return controller?.requestPlanReview(plan, signal) ?? Promise.resolve({ decision: "cancel" } as const); },
    // createAgent의 onEvent에 그대로 연결한다.
    onEvent(event: AgentEvent) { controller?.onEvent(event); },
    // 화면이 실행 중일 때만 승인 요청을 전달한다.
    requestApproval(request: PermissionRequest, signal?: AbortSignal) { return controller?.requestApproval(request, signal) ?? Promise.resolve(false); },
    // 종료 시 원래 터미널 화면을 복원하고 기존 CLI와 같은 자원 정리를 수행한다.
    async run(options: TuiOptions) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        await options.dispose();
        throw new Error("TUI는 대화형 터미널이 필요합니다. 일반 CLI는 --tui 없이 실행하세요.");
      }
      controller = createTuiSession(options);
      const current = controller;
      let app: ReturnType<typeof render> | undefined;
      let interrupted = false;
      let closeError: unknown;
      // SIGINT와 키보드 Ctrl+C를 같은 종료 경로로 연결한다.
      function interrupt() {
        interrupted = true;
        void current.close("SIGINT").catch((error: unknown) => { closeError = error; }).finally(() => app?.unmount());
      }
      const unsubscribe = current.subscribe(() => {
        if (current.getSnapshot().closed) {
          void current.close().catch((error: unknown) => { closeError = error; }).finally(() => app?.unmount());
        }
      });
      process.once("SIGINT", interrupt);
      try {
        await current.start();
        if (!current.getSnapshot().closed) {
          app = render(h(TuiScreen, { controller: current, model: options.model, supportsImages: options.supportsImages, onQuit: interrupt }),
            { alternateScreen: true, exitOnCtrlC: false, interactive: true, kittyKeyboard: { mode: "auto" } });
          await app.waitUntilExit();
        }
      } finally {
        unsubscribe();
        process.removeListener("SIGINT", interrupt);
        try { await current.close(interrupted ? "SIGINT" : "runtime-exit"); }
        finally { app?.cleanup(); controller = undefined; }
      }
      if (closeError) throw closeError;
      if (interrupted) process.exit(130);
    },
  };
}
