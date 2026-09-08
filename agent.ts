import { randomUUID } from "node:crypto";
import { summarize } from "./llm.ts";
import { recordLLM } from "./recorded-llm.ts";
import { textOf } from "./llm-types.ts";
import { checkImageInput } from "./image-content.ts";
import { saveSession as persistSession } from "./session-store.ts";
import { compactSession, contextSize, pruneToolResults, recordMessage, shouldCompact } from "./context-manager.ts";
import type { HistoryScope, HistorySink } from "./execution-history.ts";
import type { ImageBlock, LLMAdapter, LLMRequest, Message } from "./llm-types.ts";
import type { HarnessPaths } from "./harness-paths.ts";
import type { Session } from "./session.ts";
import type { ToolManager } from "./tool-manager.ts";
import type { SkillManager } from "./skill-manager.ts";

// 화면에 표시할 진행 정보다. 원문 보존용 HistoryEvent와는 별개다.
export type AgentEvent =
  | { type: "assistant-text"; text: string }
  | { type: "tool-start"; name: string; arguments: string }
  | { type: "compaction-start" }
  | { type: "compaction-end"; beforeChars: number; afterChars: number }
  | { type: "compaction-empty" }
  | { type: "output-limit-recovery"; attempt: number; maxAttempts: number }
  | { type: "tool-results-pruned"; count: number; beforeChars: number; afterChars: number };

// 실행에 필요한 객체를 외부에서 받는다. 화면 알림은 동기 콜백이며 생략하면 출력하지 않는다.
export type AgentOptions = {
  adapter: LLMAdapter;
  toolManager: ToolManager;
  skillManager: SkillManager;
  history: HistorySink;
  paths: HarnessPaths;
  onEvent?: (event: AgentEvent) => void;
  saveSession?: typeof persistSession;
};

// CLI·TUI·웹에서 호출할 실행 API다. 같은 세션의 호출은 순서대로 기다려야 한다.
export interface Agent {
  // 사용자 입력 한 번에 대한 모델·툴 반복을 실행하고 최종 텍스트를 반환한다.
  turn(session: Session, input: string, images?: ImageBlock[]): Promise<string>;
  // 현재 대화를 요약하고 전후 스냅샷과 실행 기록을 저장한다.
  compact(session: Session): Promise<void>;
}

// 터미널·모델 연결·툴 등록을 시작하지 않고 전달받은 구성으로 실행 함수를 만든다.
export function createAgent(options: AgentOptions): Agent {
  const { adapter, toolManager, skillManager, history, paths, onEvent, saveSession = persistSession } = options;

  // 시스템 지침·스킬·작업 폴더와 현재 대화·툴 정의를 공통 요청으로 조립한다.
  function assembleContext(session: Session): LLMRequest {
    return {
      system: [
        session.system,
        ...skillManager.getInstructions(),
        `현재 작업 디렉토리: ${paths.workspaceDirectory}`,
      ].join("\n\n"),
      messages: session.messages,
      tools: toolManager.getDefinitions(),
    };
  }

  // 요약 실패에 대비해 세션을 먼저 저장하고 압축 성공 후 다시 저장한다.
  async function compactAndSave(session: Session, scope: HistoryScope = { sessionId: session.id }) {
    // 요약 API가 실패해도 요약 직전 messages로 resume할 수 있게 먼저 저장한다.
    await saveSession(session, paths);
    const before = contextSize(session);
    onEvent?.({ type: "compaction-start" });
    const compacted = await compactSession(session, (conversation) =>
      summarize(recordLLM(adapter, history, scope, "compaction"), conversation),
    );
    if (compacted) {
      await history.append(scope, { type: "context-update", reason: "compact", beforeChars: before,
        afterChars: contextSize(session), messages: session.messages });
      await saveSession(session, paths);
      onEvent?.({ type: "compaction-end", beforeChars: before, afterChars: contextSize(session) });
    } else {
      onEvent?.({ type: "compaction-empty" });
    }
  }

  // 원문을 JSONL에 먼저 보존한 뒤 모델에게 보낼 대화에 추가한다.
  async function rememberMessage(session: Session, message: Message, scope: HistoryScope, source?: "harness") {
    await history.append(scope, { type: "message", message, ...(source ? { source } : {}) });
    recordMessage(session, message);
  }

  // 필요하면 컨텍스트를 줄이고 모델을 한 번 호출해 응답을 기록한다.
  async function step(session: Session, scope: HistoryScope) {
    // turn()이 이전 step의 모든 툴 결과를 기록한 뒤 여기로 돌아온다.
    if (shouldCompact(session)) {
      const before = contextSize(session);
      const pruned = pruneToolResults(session);
      if (pruned > 0) {
        await history.append(scope, { type: "context-update", reason: "prune", beforeChars: before,
          afterChars: contextSize(session), messages: session.messages });
        await saveSession(session, paths);
        onEvent?.({ type: "tool-results-pruned", count: pruned, beforeChars: before, afterChars: contextSize(session) });
      }
      if (shouldCompact(session)) await compactAndSave(session, scope);
    }
    const context = assembleContext(session);
    const result = await recordLLM(adapter, history, scope, "step").generate(context);
    // 잘린 응답은 model-response 원본 로그에만 남기고 재전송용 대화에는 넣지 않는다.
    if (result.stopReason !== "max-tokens") await rememberMessage(session, result.message, scope);

    return result;
  }

  // 사용자 입력을 기록하고 모델 호출과 툴 실행을 반복해 최종 답변을 반환한다.
  async function turn(session: Session, input: string, images: ImageBlock[] = []) {
    const turnScope = { sessionId: session.id, turnId: randomUUID() };
    await history.append(turnScope, { type: "turn-start" });
    await rememberMessage(session, {
      role: "user",
      content: [{ type: "text", text: input }, ...images],
    }, turnScope);

    // 정상 스텝이 끼어도 초기화하지 않아 한 턴의 복구 요청 수를 제한한다.
    let outputLimitRecoveries = 0;
    const maxOutputLimitRecoveries = 2;
    try {
      for (let stepNumber = 1; ; stepNumber++) {
        const scope = { ...turnScope, step: stepNumber };
        const output = await step(session, scope);
        if (output.stopReason === "max-tokens") {
          if (outputLimitRecoveries >= maxOutputLimitRecoveries) {
            throw new Error(`LLM 응답이 정상 완료되지 않았습니다: max-tokens (작업 분할 복구 ${maxOutputLimitRecoveries}회 소진)`);
          }
          outputLimitRecoveries++;
          await rememberMessage(session, { role: "user", content: [{ type: "text", text:
            `[하네스 실행 피드백 · 출력 한도 복구 ${outputLimitRecoveries}/${maxOutputLimitRecoveries}]\n` +
            "직전 모델 응답이 출력 토큰 한도에 도달해 잘렸습니다. 그 응답의 툴 호출은 하나도 실행되지 않았습니다.\n" +
            "이전 스텝에서 완료한 작업과 툴 결과는 그대로 유효합니다. 이미 성공한 작업을 반복하지 마세요.\n" +
            "한 번에 생성할 내용을 줄여 원래 요청을 계속 수행하세요. 파일이나 작업을 나누거나, 지원되는 부분 편집 도구로 작은 범위를 수정하세요.\n" +
            "파일 전체 덮어쓰기 도구에 일부 내용만 보내 기존 내용을 지우지 마세요. 설명도 간결하게 작성하세요.\n" +
            "이 메시지는 실제 사용자의 새 요청이 아니라 하네스가 제공하는 실행 피드백입니다."
          }] }, scope, "harness");
          onEvent?.({ type: "output-limit-recovery", attempt: outputLimitRecoveries, maxAttempts: maxOutputLimitRecoveries });
          continue;
        }
        if (output.stopReason === "stop") {
          await history.append(scope, { type: "turn-end", outcome: "completed" });
          return textOf(output.message);
        }
        if (output.stopReason !== "tool-calls") {
          // 잘린 응답의 툴 인자를 실행하거나, 작업 완료로 취급하지 않는다.
          throw new Error(`LLM 응답이 정상 완료되지 않았습니다: ${output.stopReason}`);
        }

        const text = textOf(output.message);
        if (text) onEvent?.({ type: "assistant-text", text });

        for (const toolCall of output.message.content) {
          if (toolCall.type !== "tool-call") continue;
          await history.append(scope, { type: "tool-start", toolCallId: toolCall.id,
            name: toolCall.name, arguments: toolCall.arguments });
          onEvent?.({ type: "tool-start", name: toolCall.name, arguments: toolCall.arguments });
          const started = performance.now();
          let toolResult = await toolManager.execute(
            toolCall.name,
            toolCall.arguments,
            { llm: recordLLM(adapter, history, { ...scope, parentToolCallId: toolCall.id }, "other-llm") },
          );
          if (Array.isArray(toolResult.content)) {
            try {
              checkImageInput([...session.messages, { role: "tool", content: [
                { type: "tool-result", toolCallId: toolCall.id, ...toolResult },
              ] }], adapter.supportsImages);
            } catch (error) {
              toolResult = { content: error instanceof Error ? error.message : String(error), isError: true };
            }
          }
          await history.append(scope, { type: "tool-end", toolCallId: toolCall.id,
            durationMs: performance.now() - started, result: toolResult });

          await rememberMessage(session, {
            role: "tool",
            content: [{ type: "tool-result", toolCallId: toolCall.id, ...toolResult }],
          }, scope);
        }
      }
    } catch (error) {
      await saveSession(session, paths);
      await history.append(turnScope, { type: "turn-end", outcome: "error",
        error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  return { turn, compact: compactAndSave };
}
