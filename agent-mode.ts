import type { PermissionPolicy } from "./permissions.ts";

// 실행 중인 앱에서 선택하는 작업 방식이며 세션 기록과 별도로 유지한다.
export type AgentMode = "plan" | "edit";

// 명령의 모드 인자를 검증하며 오타를 임의의 기본 모드로 바꾸지 않는다.
export function parseMode(value: string): AgentMode {
  if (value === "plan" || value === "edit") return value;
  throw new Error("사용법: /mode plan 또는 /mode edit (UI에서 /mode yolo도 지원)");
}

// 현재 모드 지침은 요청마다 조립하므로 이전 모드 지침이 대화에 누적되지 않는다.
export function modeInstructions(mode: AgentMode): string {
  return mode === "plan"
    ? "[현재 모드: plan]\nYou are in plan mode. Explore and design before presenting the complete plan through exit_plan_mode.\n구현하거나 파일을 생성·수정하지 마세요. 셸·MCP는 조사에 필요한 경우에만 요청하세요. 완성된 계획은 # 제목으로 시작하는 Markdown 전문으로 exit_plan_mode에 제출해 사용자 검토를 받으세요. 계획이 승인되면 다음 스텝부터 구현합니다. 일반 툴 실행 승인은 계획 승인이나 모드 전환이 아닙니다. 거부된 작업을 다른 도구로 우회하지 마세요."
    : "[현재 모드: edit]\n사용자가 요청한 범위에서 구현·수정·검증할 수 있습니다. 질문이나 계획 요청만으로 구현을 시작하지 마세요. 도구 실행 권한과 승인 결과를 따르고 거부된 작업을 우회하지 마세요.";
}

// plan에서는 기존 정책을 유지하면서 내장 파일 쓰기·편집에 명시적 거부를 추가한다.
export function modePermissions(mode: AgentMode, base: PermissionPolicy): PermissionPolicy {
  if (mode === "edit") return base;
  return { defaultDecision: base.defaultDecision, rules: [...base.rules,
    { toolName: "writeTextFile", decision: "deny" },
    { toolName: "editTextFile", decision: "deny" },
  ] };
}
