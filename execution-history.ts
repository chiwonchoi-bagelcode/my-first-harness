import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessPaths } from "./harness-paths.ts";
import type { LLMRequest, Message, StopReason, ToolContent, WireRequest, WireResponse } from "./llm-types.ts";

// 세션·턴·스텝과 중첩 모델 호출을 발생시킨 툴을 연결하는 식별 정보.
export type HistoryScope = { sessionId: string; turnId?: string; step?: number; parentToolCallId?: string };
// 일반 작업, 압축 요약, 다른 LLM에게 묻기의 사용량을 구분한다.
export type CallPurpose = "step" | "compaction" | "other-llm";
// 메시지 원문과 실행 과정을 저장하지만 상태 복원 명령으로 사용하지 않는 이벤트.
export type HistoryEvent =
  | { type: "message"; message: Message }
  | { type: "model-start"; callId: string; purpose: CallPurpose; request: LLMRequest }
  | { type: "model-request"; callId: string; request: WireRequest }
  | { type: "model-response"; callId: string; response: WireResponse }
  | { type: "model-end"; callId: string; stopReason: StopReason; durationMs: number }
  | { type: "model-error"; callId: string; error: string; durationMs: number }
  | { type: "tool-start"; toolCallId: string; name: string; arguments: string }
  | { type: "tool-end"; toolCallId: string; durationMs: number; result: { content: ToolContent; isError?: boolean } }
  | { type: "session-start"; workspaceDirectory: string; system: string }
  | { type: "session-resume"; messageCount: number }
  | { type: "turn-start" }
  | { type: "turn-end"; outcome: "completed" | "error"; error?: string }
  | { type: "command"; input: string }
  | { type: "context-update"; reason: "prune" | "compact"; beforeChars: number; afterChars: number; messages: Message[] }
  | { type: "session-close"; reason: string };

// 파일 기록을 대체할 수 있는 최소 인터페이스로 런타임과 테스트를 분리한다.
export interface HistorySink {
  // 이벤트가 파일에 추가될 때까지 기다린다.
  append(scope: HistoryScope, event: HistoryEvent): Promise<void>;
  // 진행 중인 기록 쓰기가 모두 끝날 때까지 기다린다.
  flush(): Promise<void>;
}

// ID를 파일명으로 사용하기 전에 경로 구분자와 빈 값을 거부한다.
export function checkSessionId(id: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("올바르지 않은 세션 ID입니다.");
}

// 세션별 JSONL에 순서대로 추가하며 알려진 인증 값은 기록에서 제거한다.
export class ExecutionHistory implements HistorySink {
  private queues = new Map<string, Promise<void>>();
  private paths: HarnessPaths;
  private secrets: string[];

  // 현재 프로젝트의 저장 경로와 기록에서 제거할 인증 값을 받는다.
  constructor(paths: HarnessPaths, secrets: string[] = []) {
    this.paths = paths;
    this.secrets = secrets;
  }

  // 기록 시점의 값을 고정한 뒤 같은 세션의 이전 쓰기 다음에 추가한다.
  append(scope: HistoryScope, event: HistoryEvent): Promise<void> {
    checkSessionId(scope.sessionId);
    const line = JSON.stringify({
      version: 1, eventId: randomUUID(), timestamp: new Date().toISOString(), ...scope, ...event,
    }, (key, value) => {
      if (/^(authorization|x-api-key|apiKey|api_key|access_token|refresh_token)$/i.test(key)) return "[redacted]";
      if (typeof value !== "string") return value;
      for (const secret of this.secrets) if (secret) value = value.split(secret).join("[redacted]");
      return value;
    }) + "\n";
    const previous = this.queues.get(scope.sessionId);
    const next = (previous ?? this.prepare(scope.sessionId)).then(() =>
      appendFile(join(this.paths.sessionDirectory, `${scope.sessionId}.jsonl`), line, { encoding: "utf8", mode: 0o600 }),
    );
    // 기록 실패 후에는 같은 세션에 계속 쓰지 않는다. 호출자와 flush에서 실패를 전달한다.
    this.queues.set(scope.sessionId, next);
    void next.catch(() => {});
    return next;
  }

  // 덜 쓰인 마지막 줄 뒤에 새 이벤트를 붙여 기존 기록을 손상시키지 않도록 확인한다.
  private async prepare(id: string) {
    await mkdir(this.paths.sessionDirectory, { recursive: true, mode: 0o700 });
    const file = await open(join(this.paths.sessionDirectory, `${id}.jsonl`), "a+", 0o600);
    try {
      const { size } = await file.stat();
      if (!size) return;
      const byte = Buffer.alloc(1);
      await file.read(byte, 0, 1, size - 1);
      if (byte[0] !== 10) throw new Error("실행 기록의 마지막 줄이 미완성입니다. 원본을 보존하고 새 세션으로 시작해 주세요.");
    } finally { await file.close(); }
  }

  // 이 프로세스에서 예약한 모든 세션 기록의 완료 또는 실패를 확인한다.
  async flush() {
    await Promise.all(this.queues.values());
  }
}
