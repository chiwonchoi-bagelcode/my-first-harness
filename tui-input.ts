import { createElement as h, useState } from "react";
import { Text, useInput } from "ink";
import stringWidth from "string-width";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// 한글·이모지를 쪼개지 않고 입력 커서를 움직일 수 있는 문자 단위로 나눈다.
export function inputCharacters(value: string) {
  return Array.from(segmenter.segment(value), (entry) => entry.segment);
}

// 입력은 원문 그대로 유지하되 줄바꿈은 한 줄 입력창에서 표시 기호로 보여준다.
function visibleCharacter(value: string) {
  return value.replace(/[\r\n]/g, "↵").replace(/\t/g, "⇥").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

// 화면 너비 안에 커서와 주변 입력이 항상 보이도록 가로 표시 범위를 계산한다.
export function inputWindow(value: string, cursor: number, width: number) {
  const chars = inputCharacters(value).map(visibleCharacter);
  const position = Math.min(cursor, chars.length);
  const current = chars[position] || " ";
  let remaining = Math.max(0, width - stringWidth(current));
  let before = "";
  for (let i = position - 1; i >= 0 && stringWidth(chars[i]) <= remaining; i--) {
    before = chars[i] + before;
    remaining -= stringWidth(chars[i]);
  }
  let after = "";
  for (let i = position + 1; i < chars.length && stringWidth(chars[i]) <= remaining; i++) {
    after += chars[i];
    remaining -= stringWidth(chars[i]);
  }
  return { before, current, after };
}

// 단일 표시 줄의 편집과 붙여넣기를 처리한다. 방향키 상하·Tab은 명령 목록에 맡긴다.
export function TuiInput({ value, width, focus, placeholder, onChange, onSubmit }: {
  value: string; width: number; focus: boolean; placeholder: string;
  onChange: (value: string) => void; onSubmit: (value: string) => void;
}) {
  const [cursor, setCursor] = useState(inputCharacters(value).length);
  useInput((input, key) => {
    if (key.upArrow || key.downArrow || key.tab || key.escape || key.pageUp || key.pageDown) return;
    if (key.ctrl && input === "c") return;
    if (key.return) { onSubmit(value); setCursor(0); return; }
    const chars = inputCharacters(value);
    const position = Math.min(cursor, chars.length);
    if (key.leftArrow) { setCursor(Math.max(0, position - 1)); return; }
    if (key.rightArrow) { setCursor(Math.min(chars.length, position + 1)); return; }
    if (key.home || (key.ctrl && input === "a")) { setCursor(0); return; }
    if (key.end || (key.ctrl && input === "e")) { setCursor(chars.length); return; }
    if (key.ctrl && input === "u") { onChange(""); setCursor(0); return; }
    if (key.ctrl || key.meta) return;
    // 일반 터미널의 Delete/Backspace를 이전 문자 삭제로 처리한다.
    if (key.backspace || key.delete) {
      if (position) { chars.splice(position - 1, 1); setCursor(position - 1); onChange(chars.join("")); }
      return;
    }
    if (input) {
      const inserted = inputCharacters(input);
      chars.splice(position, 0, ...inserted);
      setCursor(position + inserted.length);
      onChange(chars.join(""));
    }
  }, { isActive: focus });
  if (!value) return h(Text, { dimColor: true, wrap: "truncate-end" }, placeholder);
  const window = inputWindow(value, cursor, Math.max(1, width));
  return h(Text, null, window.before, h(Text, { inverse: focus }, window.current), window.after);
}
