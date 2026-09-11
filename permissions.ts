// 권한 판단은 실행 허용·거부·사용자 승인 요청 중 하나다.
export type PermissionDecision = "allow" | "deny" | "ask";

// 정확한 툴 이름 또는 등록 소유권으로 대상을 정하고 필요한 규칙만 인자 조건을 추가한다.
export type PermissionRule = ({ toolName: string; ownerPrefix?: never } | { ownerPrefix: string; toolName?: never }) & {
  decision: PermissionDecision;
  matchesArguments?: (args: unknown) => boolean;
};

// 작업 모드와 독립적인 실행 정책이다. 설정 파일·경로 패턴 해석은 아직 하지 않는다.
export type PermissionPolicy = {
  defaultDecision: PermissionDecision;
  rules: readonly PermissionRule[];
};

// 승인 화면에 전달할 실제 툴 이름과 검증된 인자다.
export type PermissionRequest = { toolName: string; args: unknown; owner?: string };

// 인터페이스가 승인 결과를 반환한다. 중단 신호를 받으면 화면도 닫아야 한다.
export type ApprovalAnswer = boolean | "session";
// session은 현재 세션에서 같은 소유자·이름의 툴을 모든 인자로 허용한다.
export type RequestApproval = (request: PermissionRequest, signal?: AbortSignal) => Promise<ApprovalAnswer>;

// 협업 모드(plan/edit)와 독립적으로 권한 검사를 적용하거나 우회한다.
export type PermissionMode = "default" | "yolo";

// 오타로 권한을 완화하지 않도록 명시적인 두 값만 받는다.
export function parsePermissionMode(value: string): PermissionMode {
  if (value === "default" || value === "yolo") return value;
  throw new Error("사용법: /permissions default 또는 /permissions yolo");
}

// 실행 중인 앱에서만 세션별 툴 승인을 기억하며 명시적 deny 판단 뒤 ask 단계에서만 사용한다.
export function createSessionApprover(approve?: RequestApproval) {
  const grants = new Map<string, Set<string>>();
  return async (sessionId: string, request: PermissionRequest, signal?: AbortSignal): Promise<boolean> => {
    signal?.throwIfAborted();
    const key = JSON.stringify([request.owner ?? null, request.toolName]);
    if (grants.get(sessionId)?.has(key)) return true;
    const answer = await approve?.(structuredClone(request), signal);
    signal?.throwIfAborted();
    if (answer === "session") {
      const sessionGrants = grants.get(sessionId) ?? new Set<string>();
      sessionGrants.add(key);
      grants.set(sessionId, sessionGrants);
      return true;
    }
    return answer === true;
  };
}

// 기존 동작을 유지하는 기본값이며, 제한·샌드박스를 제공하는 정책이 아니다.
export const ALLOW_ALL: PermissionPolicy = { defaultDecision: "allow", rules: [] };

// 앱의 첫 승인 정책: 셸과 MCP, 그리고 모델이 만든 툴(만들기·지우기·실행)은 매번 묻고 나머지 내장 도구는 기존처럼 허용한다.
export const INTERACTIVE_PERMISSIONS: PermissionPolicy = {
  defaultDecision: "allow",
  rules: [
    { toolName: "runCommand", decision: "ask" },
    { ownerPrefix: "mcp:", decision: "ask" },
    { ownerPrefix: "custom-tools", decision: "ask" },
  ],
};

// 명시적 거부 → 승인 요청 → 허용 순으로 검사하고 일치하지 않으면 기본값을 쓴다.
export function checkPermission(policy: PermissionPolicy, request: PermissionRequest): PermissionDecision {
  for (const decision of ["deny", "ask", "allow"] as const) {
    if (policy.rules.some((rule) => rule.decision === decision
      && (rule.toolName !== undefined ? rule.toolName === request.toolName : request.owner?.startsWith(rule.ownerPrefix))
      && (!rule.matchesArguments || rule.matchesArguments(structuredClone(request.args))))) return decision;
  }
  return policy.defaultDecision;
}

// 명시적인 일회·세션 승인만 허용하며 중단 시 답을 기다리지 않는다.
export async function waitForApproval(request: PermissionRequest, approve?: RequestApproval, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  if (!approve) return false;
  let onAbort: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    const result = await Promise.race([approve(structuredClone(request), signal), cancelled]);
    signal?.throwIfAborted();
    return result === true || result === "session";
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
