import type { AgentMode } from "../agent-mode.ts";
import type { PermissionMode } from "../permissions.ts";

// UI 테스트의 모의 에이전트에 독립적인 모드 상태를 제공한다.
export function modeFixture() {
  let mode: AgentMode = "edit";
  let permissionMode: PermissionMode = "default";
  return {
    // 모의 권한 모드를 반환한다.
    getPermissionMode: () => permissionMode,
    // UI 권한 명령의 결과를 기억한다.
    setPermissionMode(next: PermissionMode) { permissionMode = next; },
    // 현재 모의 모드를 반환한다.
    getMode: () => mode,
    // 대체 코어에는 턴이 없으므로 대기 중인 모드도 없다.
    getPendingMode: () => undefined,
    // 화면에서 선택한 모드를 보관하고 즉시 적용으로 보고한다.
    setMode(next: AgentMode) { mode = next; return "applied" as const; },
  };
}
