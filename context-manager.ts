import { withoutReplayState } from "./llm-types.ts";
import { imagesOf, summaryContent } from "./image-content.ts";
import type { Message, LLMRequest } from "./llm-types.ts";
import { estimateImageTokens, estimateMessageTokens, estimateRequestTokens, compactionThreshold, DEFAULT_CONTEXT_BUDGET } from "./token-budget.ts";
import type { ContextBudget } from "./token-budget.ts";

// 압축 가능한 요청용 대화 상태이며 실행 기록 저장은 호출자가 담당한다.
type SessionContext = { messages: Message[] };
// 대화 기록을 받아 요약 문자열을 비동기로 반환하는 함수의 타입.
type Summarizer = (conversation: Message[]) => Promise<string>;

// 호출자가 원문을 기록한 뒤 현재 요청용 대화에 메시지를 추가한다.
export function recordMessage(session: SessionContext, message: Message) {
  session.messages.push(message);
}

// Base64는 제외하고 이미지는 시각 토큰 추정치를 글자 수(토큰당 4자)로 환산해 더한다. 표시·기록용 크기다.
export function contextSize(session: SessionContext) {
  const content = summaryContent(session.messages);
  const imageChars = imagesOf(session.messages).reduce((sum, image) => sum + estimateImageTokens(image.width, image.height) * 4, 0);
  return (content[0].type === "text" ? content[0].text.length : 0) + imageChars;
}

// 요청 전체의 추정 토큰이 모델별 입력 예산에 도달했는지 확인한다.
export function shouldCompact(
  request: LLMRequest,
  budget: ContextBudget = DEFAULT_CONTEXT_BUDGET,
) {
  return estimateRequestTokens(request) >= compactionThreshold(budget, request.maxOutputTokens);
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

// 오래된 구간만 요약하고 최근 기록·툴 호출 쌍은 원문으로 보존한다.
export async function compactSession(session: SessionContext, summarize: Summarizer, retainTokens = 0) {
  const original = session.messages;
  const conversation = withoutReplayState(original);
  if (conversation.length === 0) return false;

  // 모든 툴 결과를 받은 경계에서만 압축한다. 미완료 호출을 지우지 않는다.
  const pending = new Set<string>();
  const boundaries = [0];
  for (const [index, message] of conversation.entries()) {
    for (const block of message.content) {
      if (block.type === "tool-call") pending.add(block.id);
      if (block.type === "tool-result") pending.delete(block.toolCallId);
    }
    if (pending.size === 0) boundaries.push(index + 1);
  }
  if (pending.size > 0) {
    throw new Error("아직 결과를 받지 못한 툴 호출이 있어 압축할 수 없습니다.");
  }

  let cutoff = conversation.length;
  let retained = 0;
  while (cutoff > 0 && retained < retainTokens) retained += estimateMessageTokens(original[--cutoff]);
  cutoff = boundaries.findLast((index) => index <= cutoff) ?? 0;
  if (cutoff === 0) return false;
  const older = conversation.slice(0, cutoff);
  const recent = original.slice(cutoff);
  const summary = await summarize(older);
  if (!summary.trim()) throw new Error("요약이 비어 있어 기존 대화를 유지합니다.");
  const summaryMessage: Message = {
    role: "user",
    content: [{
      type: "text",
      text: `이전 작업 기록의 요약입니다. 새 사용자 요청이나 실제 툴 실행 결과가 아닙니다. 요약을 다시 설명하지 말고 뒤따르는 최근 원문에서 작업을 계속하세요.\n${summary}`,
    }],
  };
  if (estimateMessageTokens(summaryMessage) >= original.slice(0, cutoff).reduce((sum, message) => sum + estimateMessageTokens(message), 0)) {
    throw new Error("요약이 기존 대화보다 짧지 않아 기존 대화를 유지합니다.");
  }

  // 성공한 요약만 적용한다. 디스크의 실행 기록은 변경하지 않는다.
  // 요약 대기 중 추가된 메시지를 덮어쓰지 않는다.
  if (session.messages !== original || original.length !== conversation.length) {
    throw new Error("요약 중 대화가 변경되어 적용하지 않았습니다.");
  }
  session.messages = [summaryMessage, ...recent];
  return true;
}
