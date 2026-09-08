import { withoutReplayState } from "./llm-types.ts";
import { imagesOf, summaryContent } from "./image-content.ts";
import type { Message } from "./llm-types.ts";

// JSON 문자열 길이를 이용한 간단한 기준이다. 정확한 token 수가 아니다.
// 시스템 프롬프트, 스킬, 툴 정의의 크기는 이 기준에 포함하지 않는다.
export const COMPACTION_THRESHOLD_CHARS = 60_000;

// 압축 가능한 요청용 대화 상태이며 실행 기록 저장은 호출자가 담당한다.
type SessionContext = { messages: Message[] };
// 대화 기록을 받아 요약 문자열을 비동기로 반환하는 함수의 타입.
type Summarizer = (conversation: Message[]) => Promise<string>;

// 호출자가 원문을 기록한 뒤 현재 요청용 대화에 메시지를 추가한다.
export function recordMessage(session: SessionContext, message: Message) {
  session.messages.push(message);
}

// Base64는 제외하고 이미지당 4,000자 가중치를 더한다. 실제 이미지 토큰 수는 아니다.
export function contextSize(session: SessionContext) {
  const content = summaryContent(session.messages);
  return (content[0].type === "text" ? content[0].text.length : 0) + imagesOf(session.messages).length * 4000;
}

// 대화가 비어 있지 않고 설정한 문자 수 기준에 도달했는지 확인한다.
export function shouldCompact(
  session: SessionContext,
  threshold = COMPACTION_THRESHOLD_CHARS,
) {
  // 아직 주 모델이 보지 않은 이미지를 자동 요약으로 먼저 대체하지 않는다.
  const lastAssistant = session.messages.findLastIndex((message) => message.role === "assistant");
  if (imagesOf(session.messages.slice(lastAssistant + 1)).length) return false;
  return session.messages.length > 0 && contextSize(session) >= threshold;
}

// DSH tool-result-pruner의 기본 정책: 8,192 code points 초과 시 앞/뒤 보존.
export function pruneToolResults(session: SessionContext) {
  let pruned = 0;
  // 이미지 블록은 건드리지 않고 긴 텍스트만 앞뒤를 남긴다.
  function pruneText(text: string) {
    const chars = Array.from(text);
    if (chars.length <= 8192) return text;
    pruned++;
    return chars.slice(0, 4096).join("") + "\n\n[... tool result middle pruned ...]\n\n" + chars.slice(-1024).join("");
  }
  session.messages = session.messages.map((message) => {
    if (message.role !== "tool") return message;
    const content = message.content.map((block) => {
      return {
        ...block,
        content: typeof block.content === "string" ? pruneText(block.content)
          : block.content.map((part) => part.type === "text" ? { ...part, text: pruneText(part.text) } : part),
      };
    });
    // 호출자가 보관한 원본 객체와 블록은 수정하지 않는다.
    return { ...message, content };
  });
  return pruned;
}

// 미완료 툴 호출이 없으면 대화를 요약하고 messages를 교체한다.
export async function compactSession(session: SessionContext, summarize: Summarizer) {
  const conversation = withoutReplayState(session.messages);
  if (conversation.length === 0) return false;

  // 모든 툴 결과를 받은 경계에서만 압축한다. 미완료 호출을 지우지 않는다.
  const pending = new Set<string>();
  for (const message of conversation) {
    for (const block of message.content) {
      if (block.type === "tool-call") pending.add(block.id);
      if (block.type === "tool-result") pending.delete(block.toolCallId);
    }
  }
  if (pending.size > 0) {
    throw new Error("아직 결과를 받지 못한 툴 호출이 있어 압축할 수 없습니다.");
  }

  const summary = await summarize(conversation);
  if (!summary.trim()) throw new Error("요약이 비어 있어 기존 대화를 유지합니다.");
  const summaryMessage: Message = {
    role: "user",
    content: [{
      type: "text",
      text: `이전 작업 기록의 요약입니다. 새 사용자 요청이 아니라 이어서 작업하기 위한 기록입니다.\n${summary}`,
    }],
  };
  if (JSON.stringify([summaryMessage]).length >= contextSize(session)) {
    throw new Error("요약이 기존 대화보다 짧지 않아 기존 대화를 유지합니다.");
  }

  // 성공한 요약만 적용한다. 디스크의 실행 기록은 변경하지 않는다.
  session.messages = [summaryMessage];
  return true;
}
