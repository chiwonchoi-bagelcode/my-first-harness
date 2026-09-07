import { textOf } from "../llm-types.ts";
import type { AssistantMessage, LLMAdapter, Message, StopReason } from "../llm-types.ts";

// Chat Completions 연결에 사용할 경로 이름, API 주소, 모델과 인증 키.
type Config = {
  provider: string;
  baseURL: string;
  model: string;
  apiKey: string | undefined;
};

// Chat Completions API가 주고받는 function 툴 호출의 형식.
type FunctionCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

// 이 어댑터가 처리하는 Chat Completions의 텍스트·툴 호출·거절 응답 형식.
type ChatAssistant = {
  role: "assistant";
  content: string | null;
  tool_calls?: FunctionCall[];
  refusal?: string | null;
};

// 공통 메시지 하나를 API 메시지로 변환하고 유효한 재전송 정보만 적용한다.
function toChatMessages(message: Message, config: Config): object[] {
  if (message.role === "user") {
    return [{ role: "user", content: textOf(message) }];
  }
  if (message.role === "tool") {
    // 공통 메시지 하나에 여러 결과가 있어도 API에는 결과별 메시지로 보낸다.
    return message.content.map((block) => ({
      role: "tool",
      tool_call_id: block.toolCallId,
      content: block.isError ? `툴 오류: ${block.content}` : block.content,
    }));
  }

  const calls = message.content.filter((block) => block.type === "tool-call");
  const wire: ChatAssistant = {
    role: "assistant",
    content: textOf(message) || null,
    ...(calls.length ? {
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments },
      })),
    } : {}),
  };

  // 이 어댑터는 refusal만 부가 보존한다. 임의의 원본 응답을 펼쳐 넣지 않는다.
  const replay = message.replayState;
  if (replay?.adapter === "chat-completions"
    && replay.provider === config.provider && replay.model === config.model) {
    const data = replay.data;
    if (data && typeof data === "object"
      && "contentKey" in data && data.contentKey === JSON.stringify(message.content)
      && "refusal" in data && typeof data.refusal === "string"
      && "content" in data && (data.content === null || typeof data.content === "string")) {
      wire.refusal = data.refusal;
      wire.content = data.content;
    }
  }
  return [wire];
}

// API 응답을 공통 텍스트·툴 호출 블록으로 바꾸고 필요한 거절 정보를 보존한다.
function fromChatMessage(wire: ChatAssistant, config: Config): AssistantMessage {
  if (wire.role !== "assistant" || (wire.content !== null && typeof wire.content !== "string")) {
    throw new Error("지원하지 않는 Chat Completions 응답 형식입니다.");
  }
  const message: AssistantMessage = { role: "assistant", content: [] };
  const text = wire.content || wire.refusal;
  if (text) message.content.push({ type: "text", text });

  for (const call of wire.tool_calls ?? []) {
    if (call.type !== "function" || typeof call.id !== "string"
      || typeof call.function?.name !== "string" || typeof call.function?.arguments !== "string") {
      throw new Error("지원하지 않는 툴 호출 형식입니다.");
    }
    message.content.push({
      type: "tool-call", id: call.id,
      name: call.function.name, arguments: call.function.arguments,
    });
  }

  if (wire.refusal) {
    message.replayState = {
      adapter: "chat-completions", provider: config.provider, model: config.model,
      data: {
        contentKey: JSON.stringify(message.content),
        content: wire.content,
        refusal: wire.refusal,
      },
    };
  }
  return message;
}

// API의 종료 이유를 공통 값으로 바꾸고 미분류 값은 other로 남긴다.
function stopReason(reason: string): StopReason {
  if (reason === "stop") return "stop";
  if (reason === "tool_calls") return "tool-calls";
  if (reason === "length") return "max-tokens";
  return "other";
}

// 주어진 연결 설정을 사용하는 Chat Completions 어댑터 객체를 만든다.
export function createChatCompletionsAdapter(config: Config): LLMAdapter {
  return {
    // 공통 요청을 API에 보내고 응답 형식과 종료 이유를 확인해 공통 결과로 반환한다.
    async generate(request) {
      const response = await fetch(`${config.baseURL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            ...(request.system ? [{ role: "system", content: request.system }] : []),
            ...request.messages.flatMap((message) => toChatMessages(message, config)),
          ],
          ...(request.tools.length ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: { name: tool.name, description: tool.description, parameters: tool.parameters },
            })),
          } : {}),
          ...(request.maxOutputTokens !== undefined
            ? { max_completion_tokens: request.maxOutputTokens } : {}),
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.choices?.[0]?.message) {
        throw new Error(result.error?.message ?? `LLM 요청 실패: HTTP ${response.status}`);
      }
      const choice = result.choices[0];
      const message = fromChatMessage(choice.message, config);
      const reason = stopReason(choice.finish_reason);
      if (reason === "tool-calls" && !message.content.some((block) => block.type === "tool-call")) {
        throw new Error("툴 호출로 종료했지만 호출 내용이 없습니다.");
      }
      if (reason === "stop" && message.content.some((block) => block.type === "tool-call")) {
        throw new Error("정상 종료와 툴 호출이 함께 반환되었습니다.");
      }
      return { message, stopReason: reason };
    },
  };
}
