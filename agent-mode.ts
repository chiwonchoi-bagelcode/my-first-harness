import type { PermissionPolicy } from "./permissions.ts";
import { PLAN_INSTRUCTIONS, EDIT_INSTRUCTIONS } from "./prompts.ts";

// 실행 중인 앱에서 선택하는 작업 방식이며 세션 기록과 별도로 유지한다.
export type AgentMode = "plan" | "edit";

// 명령의 모드 인자를 검증하며 오타를 임의의 기본 모드로 바꾸지 않는다.
export function parseMode(value: string): AgentMode {
  if (value === "plan" || value === "edit") return value;
  throw new Error("사용법: /mode plan 또는 /mode edit (UI에서 /mode yolo도 지원)");
}

// 현재 모드 지침은 요청마다 조립하므로 이전 모드 지침이 대화에 누적되지 않는다.
export function modeInstructions(mode: AgentMode): string {
  return mode === "plan" ? PLAN_INSTRUCTIONS : EDIT_INSTRUCTIONS;
}

// plan에서는 기존 정책을 유지하면서 내장 파일 쓰기·편집에 명시적 거부를 추가한다.
export function modePermissions(mode: AgentMode, base: PermissionPolicy): PermissionPolicy {
  if (mode === "edit") return base;
  return { defaultDecision: base.defaultDecision, rules: [...base.rules,
    { toolName: "writeTextFile", decision: "deny" },
    { toolName: "editTextFile", decision: "deny" },
  ] };
}
