import { createElement as h, useRef, useState } from "react";
import { Box, Text, useCursor, useInput, usePaste } from "ink";
import stringWidth from "string-width";
import { stripVTControlCharacters } from "node:util";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// 한글·이모지를 쪼개지 않고 입력 커서를 움직일 수 있는 문자 단위로 나눈다.
export function inputCharacters(value: string) {
  return Array.from(segmenter.segment(value), (entry) => entry.segment);
}

// 각 문자 경계가 차지하는 터미널 열과 줄을 저장한다.
type InputPosition = { x: number; y: number };

// 실제 표시 너비로 자동 줄바꿈하고 모든 문자 경계의 커서 좌표를 계산한다.
export function layoutInput(value: string, width: number) {
  const columns = Math.max(2, width);
  const lines = [""];
  const positions: InputPosition[] = [];
  let x = 0;
  let y = 0;
  for (const char of inputCharacters(value)) {
    const visible = char === "\t" ? "  " : char.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
    const size = stringWidth(visible);
    if (char !== "\n" && x + size > columns) { lines.push(""); y++; x = 0; }
    positions.push({ x, y });
    if (char === "\n") { lines.push(""); y++; x = 0; }
    else { lines[y] += visible; x += size; }
  }
  // 맨 끝이 오른쪽 경계이면 커서를 다음 줄에 두어 조합 문자가 잘리지 않게 한다.
  if (x >= columns) { lines.push(""); y++; x = 0; }
  positions.push({ x, y });
  return { lines, positions };
}

// 긴 입력은 원문을 유지하며 커서가 있는 줄 주변을 입력창 높이만큼 보여준다.
export function inputViewport(value: string, cursor: number, width: number, height: number) {
  const layout = layoutInput(value, width);
  const position = layout.positions[Math.min(cursor, layout.positions.length - 1)];
  const start = Math.max(0, position.y - Math.max(1, height) + 1);
  return { lines: layout.lines.slice(start, start + Math.max(1, height)),
    cursor: { x: position.x, y: position.y - start } };
}

// 표시 줄 위아래에서 현재 열에 가장 가까운 문자 경계를 찾는다. 입력 기록은 탐색하지 않는다.
function verticalCursor(value: string, cursor: number, width: number, direction: number) {
  const { positions } = layoutInput(value, width);
  const current = positions[cursor];
  let next = cursor;
  let distance = Infinity;
  positions.forEach((position, index) => {
    const delta = Math.abs(position.x - current.x);
    if (position.y === current.y + direction && delta < distance) { next = index; distance = delta; }
  });
  return next;
}

// 여러 줄 편집과 붙여넣기를 처리하고 Ink 공식 IME 예제처럼 실제 커서를 입력 위치에 둔다.
export function TuiInput({ value, width, height, cursorStart, focus, menuOpen = false, placeholder, onChange, onSubmit }: {
  value: string; width: number; height: number; cursorStart: InputPosition;
  focus: boolean; menuOpen?: boolean; placeholder: string;
  onChange: (value: string) => void; onSubmit: (value: string) => void;
}) {
  const [cursor, setCursor] = useState(inputCharacters(value).length);
  // 같은 프레임에 여러 키가 도착해도 앞선 입력을 덮어쓰지 않도록 최신 편집 값을 즉시 보관한다.
  const draft = useRef({ value, cursor });
  const previousValue = useRef(value);
  if (previousValue.current !== value) {
    previousValue.current = value;
    draft.current = { value, cursor: Math.min(draft.current.cursor, inputCharacters(value).length) };
  }
  const { setCursorPosition } = useCursor();
  const viewport = inputViewport(value, cursor, width, height);
  // 글자 반전으로 가짜 커서를 그리지 않는다. 한글 조합 표시는 터미널/OS가 이 좌표에서 담당한다.
  setCursorPosition(focus ? { x: cursorStart.x + viewport.cursor.x, y: cursorStart.y + viewport.cursor.y } : undefined);

  // 커서와 원문을 함께 갱신해 다음 키 이벤트에도 같은 편집 상태를 사용한다.
  function change(text: string, position: number) {
    const changed = draft.current.value !== text;
    draft.current = { value: text, cursor: position };
    setCursor(position);
    if (changed) onChange(text);
  }
  // 줄바꿈을 LF로 통일하고 제어 시퀀스를 제거한 뒤 커서 위치에 텍스트를 삽입한다.
  function insert(text: string) {
    const clean = stripVTControlCharacters(text).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
    const { value: current, cursor: position } = draft.current;
    const chars = inputCharacters(current);
    const before = chars.slice(0, position).join("") + clean;
    change(before + chars.slice(position).join(""), inputCharacters(before).length);
  }
  // Bracketed paste는 키 입력과 분리하므로 붙여넣은 Enter가 전송으로 오인되지 않는다.
  usePaste(insert, { isActive: focus });
  useInput((input, key) => {
    if (key.eventType === "release") return;
    if (key.tab || key.escape || key.pageUp || key.pageDown) return;
    if (menuOpen && (key.upArrow || key.downArrow)) return;
    if ((key.return && key.shift) || (input.toLowerCase() === "j" && (key.super || key.ctrl)) || input === "\n") {
      insert("\n"); return;
    }
    const { value: current, cursor: position } = draft.current;
    if (key.return) {
      if (current.trim()) {
        onSubmit(current);
        // 후보가 열렸을 때 Enter는 선택만 하고 부모가 입력 컴포넌트를 다시 만든다.
        if (!menuOpen) change("", 0);
      }
      return;
    }
    const chars = inputCharacters(current);
    if (key.leftArrow) { change(current, Math.max(0, position - 1)); return; }
    if (key.rightArrow) { change(current, Math.min(chars.length, position + 1)); return; }
    if (key.upArrow || key.downArrow) { change(current, verticalCursor(current, position, width, key.upArrow ? -1 : 1)); return; }
    if (key.home || (key.ctrl && input === "a")) { change(current, 0); return; }
    if (key.end || (key.ctrl && input === "e")) { change(current, chars.length); return; }
    if (key.ctrl && input === "u") { change("", 0); return; }
    if (key.ctrl || key.meta || key.super) return;
    if (key.backspace || key.delete) {
      const index = key.backspace ? position - 1 : position;
      if (index >= 0 && index < chars.length) { chars.splice(index, 1); change(chars.join(""), Math.max(0, index)); }
      return;
    }
    if (input) insert(input);
  }, { isActive: focus });

  return h(Box, { flexDirection: "column", width, height, overflow: "hidden" },
    ...(!value ? [h(Text, { key: 0, dimColor: true, wrap: "truncate-end" }, placeholder)]
      : viewport.lines.map((line, index) => h(Text, { key: index, wrap: "truncate-end" }, line || " "))));
}
