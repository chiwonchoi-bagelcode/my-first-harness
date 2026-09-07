// JSON 문자열 길이를 이용한 간단한 기준이다. 정확한 token 수가 아니다.
// 시스템 프롬프트, 스킬, 툴 정의의 크기는 이 기준에 포함하지 않는다.
export const COMPACTION_THRESHOLD_CHARS = 60_000;

type SessionContext = { history: any[]; messages: any[] };
type Summarizer = (conversation: any[]) => Promise<string>;

export function recordMessage(session: SessionContext, message: any) {
  session.history.push(message);
  session.messages.push(message);
}

export function contextSize(session: SessionContext) {
  return JSON.stringify(session.messages.slice(1)).length;
}

export function shouldCompact(
  session: SessionContext,
  threshold = COMPACTION_THRESHOLD_CHARS,
) {
  return session.messages.length > 1 && contextSize(session) >= threshold;
}

// DSH tool-result-pruner의 기본 정책: 8,192 code points 초과 시 앞/뒤 보존.
export function pruneToolResults(session: SessionContext) {
  let pruned = 0;
  session.messages = session.messages.map((message: any) => {
    if (message.role !== "tool" || typeof message.content !== "string") return message;

    const chars = Array.from(message.content);
    if (chars.length <= 8192) return message;

    const shortened =
      chars.slice(0, 4096).join("") +
      "\n\n[... tool result middle pruned ...]\n\n" +
      chars.slice(-1024).join("");

    pruned++;
    // history와 공유하는 원본 객체는 수정하지 않는다.
    return { ...message, content: shortened };
  });
  return pruned;
}

export async function compactSession(session: SessionContext, summarize: Summarizer) {
  const conversation = session.messages.slice(1);
  if (conversation.length === 0) return false;

  // 모든 툴 결과를 받은 경계에서만 압축한다. 미완료 호출을 지우지 않는다.
  const pending = new Set<string>();
  for (const message of conversation) {
    for (const call of message.tool_calls ?? []) pending.add(call.id);
    if (message.role === "tool") pending.delete(message.tool_call_id);
  }
  if (pending.size > 0) {
    throw new Error("아직 결과를 받지 못한 툴 호출이 있어 압축할 수 없습니다.");
  }

  const summary = await summarize(conversation);
  if (!summary.trim()) throw new Error("요약이 비어 있어 기존 대화를 유지합니다.");
  const summaryMessage = {
    role: "user",
    content: `이전 작업 기록의 요약입니다. 새 사용자 요청이 아니라 이어서 작업하기 위한 기록입니다.\n${summary}`,
  };
  if (JSON.stringify([summaryMessage]).length >= contextSize(session)) {
    throw new Error("요약이 기존 대화보다 짧지 않아 기존 대화를 유지합니다.");
  }

  // 성공한 요약만 적용한다. 원본 history는 수정하지 않는다.
  session.messages = [session.messages[0], summaryMessage];
  return true;
}
