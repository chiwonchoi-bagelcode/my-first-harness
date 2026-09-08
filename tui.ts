import { createElement as h, useEffect, useState, useSyncExternalStore } from "react";
import { Box, Text, render, useInput, useWindowSize } from "ink";
import { TuiInput } from "./tui-input.ts";
import wrapAnsi from "wrap-ansi";
import { stripVTControlCharacters } from "node:util";
import { commandSuggestions, createTuiSession } from "./tui-session.ts";
import type { TuiEntry, TuiOptions, TuiSession } from "./tui-session.ts";
import type { AgentEvent } from "./agent.ts";

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
  const [input, setInput] = useState("");
  const [selected, setSelected] = useState(0);
  const [menuHidden, setMenuHidden] = useState(false);
  const [inputVersion, setInputVersion] = useState(0);
  const [scroll, setScroll] = useState(0);
  const candidates = menuHidden ? [] : commandSuggestions(input, supportsImages);
  const choice = candidates[Math.min(selected, Math.max(0, candidates.length - 1))];
  const menuRows = candidates.length ? candidates.length + 3 : 0;
  const feedRows = Math.max(1, rows - menuRows - 7);
  const lines = conversationLines(state.entries, Math.max(1, columns));
  const offset = Math.min(scroll, Math.max(0, lines.length - feedRows));
  const end = Math.max(0, lines.length - offset);
  const visible = lines.slice(Math.max(0, end - feedRows), end);

  // 새 세션에서는 화면 위치를 최신 내용으로 되돌린다.
  useEffect(() => { setScroll(0); }, [state.sessionId]);
  // 명령 선택은 실행하지 않고 입력창에 채우며 새 입력 커서를 끝으로 옮긴다.
  function complete() {
    if (!choice) return;
    setInput(choice.name + (choice.name === "/attach" || choice.name === "/resume" ? " " : ""));
    setMenuHidden(true);
    setInputVersion((version) => version + 1);
  }
  // 후보가 열려 있으면 선택하고, 닫혀 있으면 현재 입력을 한 번 실행한다.
  function submit(value: string) {
    if (state.busy) return;
    if (choice) { complete(); return; }
    if (!value.trim()) return;
    setInput("");
    setSelected(0);
    setMenuHidden(false);
    setScroll(0);
    void controller.submit(value);
  }
  useInput((value, key) => {
    if (key.ctrl && value === "c") { onQuit(); return; }
    if (key.pageUp) setScroll(Math.min(lines.length, offset + feedRows));
    if (key.pageDown) setScroll(Math.max(0, offset - feedRows));
    if (state.busy) return;
    if (key.escape) setMenuHidden(true);
    if (choice && key.upArrow) setSelected((selected + candidates.length - 1) % candidates.length);
    if (choice && key.downArrow) setSelected((selected + 1) % candidates.length);
    if (choice && key.tab) complete();
  });

  if (rows < 16 || columns < 40) {
    return h(Text, { color: "yellow" }, "터미널을 40열 × 16줄 이상으로 넓혀주세요. Ctrl+C 종료");
  }

  return h(Box, { flexDirection: "column", width: columns, height: Math.max(rows, 8) },
    h(Text, { bold: true, color: "cyan", wrap: "truncate-end" }, `My First Harness · ${model} · ${state.sessionId}`),
    h(Text, { dimColor: true }, "─".repeat(Math.max(1, columns))),
    h(Box, { flexDirection: "column", height: feedRows, flexShrink: 0, overflow: "hidden" },
      ...visible.map((line, index) => h(Text, { key: index, wrap: "truncate-end",
        color: line.kind === "user" ? "cyan" : line.kind === "error" ? "red" : undefined,
        dimColor: line.kind === "tool" || line.kind === "notice",
      }, line.text)),
      state.entries.length ? null : h(Text, { dimColor: true }, "메시지를 입력하세요. /를 누르면 명령과 사용법을 볼 수 있습니다.")),
    candidates.length ? h(Box, { flexDirection: "column", height: menuRows, flexShrink: 0 },
      h(Text, { color: "cyan" }, "명령 선택 · ↑↓ 이동 · Enter/Tab 채우기 · Esc 닫기"),
      ...candidates.map((command) => h(Text, { key: command.name, color: command === choice ? "cyan" : undefined,
        bold: command === choice, wrap: "truncate-end" }, `${command === choice ? "❯" : " "} ${command.name}  ${command.description}`)),
      h(Text, { wrap: "truncate-end" }, `사용법: ${choice?.usage}`),
      h(Text, { dimColor: true, wrap: "truncate-end" }, "입력창에 채운 후 Enter를 다시 누르면 실행합니다.")) : null,
    h(Box, { borderStyle: "round", borderColor: state.busy ? "gray" : "cyan", height: 3, flexShrink: 0, overflow: "hidden" },
      h(Text, { color: "cyan" }, "> "),
      h(TuiInput, { key: inputVersion, value: input, width: Math.max(1, columns - 6), focus: !state.busy,
        placeholder: state.busy ? "실행 중 · 새 요청은 완료 후 입력" : "메시지 또는 /명령",
        onChange(value) { setInput(value); setSelected(0); setMenuHidden(false); }, onSubmit: submit })),
    h(Text, { color: state.busy ? "yellow" : "green", wrap: "truncate-end" }, `상태: ${state.status}${state.pendingImages ? ` · 첨부 ${state.pendingImages}개` : ""}`),
    h(Text, { dimColor: true, wrap: "truncate-end" }, `${offset ? "이전 내용 보는 중 · " : ""}Enter 전송 · / 명령 · PgUp/PgDn 대화 보기 · Ctrl+C 종료`),
  );
}

// 코어의 이벤트 수신 함수를 먼저 만들고, 실행 시 터미널 화면과 연결한다.
export function createTui() {
  let controller: TuiSession | undefined;
  return {
    // createAgent의 onEvent에 그대로 연결한다.
    onEvent(event: AgentEvent) { controller?.onEvent(event); },
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
            { alternateScreen: true, exitOnCtrlC: false, interactive: true });
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
