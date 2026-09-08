import { textOf } from "../llm-types.ts";
import { requestJSON } from "./http.ts";
import { usageOf } from "./usage.ts";
import type { AssistantMessage, LLMAdapter, Message, StopReason } from "../llm-types.ts";

// Messages 주소(v1까지), 모델, 인증 방식과 기본 출력 한도를 지정한다.
type Config = {
  provider: string;
  baseURL: string;
  model: string;
  apiKey: string | undefined;
  auth?: "api-key" | "bearer";
  maxOutputTokens?: number;
};

// 지원하는 assistant 블록. thinking은 표시하지 않고 재전송용으로만 보관한다.
type OutputBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

// Messages API에 보내는 user/assistant 메시지와 블록 목록.
type WireMessage = { role: "user" | "assistant"; content: object[] };

// 외부 JSON 값을 필드 확인 가능한 객체로 좁힌다.
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// 지원하는 블록만 받아들이고 서명·인용 등 원본 필드는 유지한다.
function readContent(value: unknown): OutputBlock[] {
  if (!Array.isArray(value)) throw new Error("Anthropic content가 배열이 아닙니다.");
  for (const block of value) {
    if (!isObject(block)) throw new Error("지원하지 않는 Anthropic 블록입니다.");
    if (block.type === "text" && typeof block.text === "string") continue;
    if (block.type === "tool_use" && typeof block.id === "string" && block.id
      && typeof block.name === "string" && block.name && isObject(block.input)) continue;
    if (block.type === "thinking" && typeof block.thinking === "string"
      && typeof block.signature === "string" && block.signature) continue;
    if (block.type === "redacted_thinking" && typeof block.data === "string") continue;
    throw new Error(`지원하지 않는 Anthropic 블록 형식입니다: ${block.type}`);
  }
  return value as OutputBlock[];
}

// 텍스트와 툴 호출을 공통 블록으로 변환하고 실행 인자는 JSON 문자열로 통일한다.
function contentOf(blocks: OutputBlock[]): AssistantMessage["content"] {
  const content: AssistantMessage["content"] = [];
  const ids = new Set<string>();
  for (const block of blocks) {
    if (block.type === "text") {
      if (block.text) content.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      if (ids.has(block.id)) throw new Error("Anthropic 툴 호출 ID가 중복되었습니다.");
      ids.add(block.id);
      content.push({ type: "tool-call", id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
    }
  }
  return content;
}

// 출처와 현재 공통 내용이 일치하는 원본 assistant 블록만 재사용한다.
function replayContent(message: AssistantMessage, config: Config): OutputBlock[] | undefined {
  const replay = message.replayState;
  if (replay?.adapter !== "anthropic-messages" || replay.provider !== config.provider || replay.model !== config.model) return;
  const data = replay.data;
  if (!isObject(data) || data.contentKey !== JSON.stringify(message.content)) return;
  try {
    const blocks = readContent(data.content);
    if (JSON.stringify(contentOf(blocks)) === data.contentKey) return blocks;
  } catch {
    // 손상된 replay는 재사용하지 않고 현재 공통 내용으로 변환한다.
  }
}

// 공통 호출의 JSON 인자를 Anthropic이 요구하는 객체로 복원한다.
function parseInput(argumentsJson: string): Record<string, unknown> {
  let input: unknown;
  try { input = JSON.parse(argumentsJson); } catch {
    throw new Error("Anthropic으로 보낼 이전 툴 호출 인자가 올바른 JSON이 아닙니다.");
  }
  if (!isObject(input)) throw new Error("Anthropic으로 보낼 이전 툴 호출 인자는 객체여야 합니다.");
  return input;
}

// 연속된 툴 결과를 한 user 메시지로 모으고 다른 연속 동역할 메시지도 순서대로 합친다.
function toMessages(messages: Message[], config: Config): WireMessage[] {
  const wire: WireMessage[] = [];
  for (const message of messages) {
    const role = message.role === "assistant" ? "assistant" : "user";
    let content: object[];
    if (message.role === "tool") {
      content = message.content.map((block) => ({ type: "tool_result", tool_use_id: block.toolCallId,
        content: block.content, ...(block.isError !== undefined ? { is_error: block.isError } : {}) }));
    } else if (message.role === "user") {
      content = message.content.map((block) => ({ type: "text", text: block.text }));
    } else {
      content = replayContent(message, config) ?? message.content.map((block) => block.type === "text"
        ? { type: "text", text: block.text }
        : { type: "tool_use", id: block.id, name: block.name, input: parseInput(block.arguments) });
    }
    const previous = wire.at(-1);
    // 새 배열에만 추가해 세션이나 replay의 원본 배열을 바꾸지 않는다.
    if (previous?.role === role) previous.content.push(...content);
    else wire.push({ role, content: [...content] });
  }
  return wire;
}

// 호출 여부와 종료 사유를 함께 확인해 잘린 호출이나 알 수 없는 중단을 실행하지 않는다.
function stopReason(reason: unknown, message: AssistantMessage): StopReason {
  const hasCalls = message.content.some((block) => block.type === "tool-call");
  if (reason === "max_tokens") return "max-tokens";
  if (reason === "tool_use") {
    if (!hasCalls) throw new Error("Anthropic tool_use로 종료했지만 호출 내용이 없습니다.");
    return "tool-calls";
  }
  if (["end_turn", "stop_sequence", "refusal"].includes(String(reason))) {
    if (hasCalls) throw new Error("Anthropic 정상 종료와 툴 호출이 함께 반환되었습니다.");
    return textOf(message).trim() ? "stop" : "other";
  }
  return "other";
}

// 공통 기록을 매번 직접 전송하는 Anthropic Messages 어댑터를 만든다.
export function createAnthropicMessagesAdapter(config: Config): LLMAdapter {
  return {
    // 요청·응답 형식과 인증을 변환하며 기존 하네스의 툴 실행 흐름은 유지한다.
    async generate(request, observer) {
      if (!config.apiKey) throw new Error("Anthropic API 인증 키가 없습니다.");
      const { response, result } = await requestJSON({
        api: "anthropic-messages", provider: config.provider, model: config.model,
        url: `${config.baseURL.replace(/\/$/, "")}/messages`,
        body: {
          model: config.model,
          max_tokens: request.maxOutputTokens ?? config.maxOutputTokens ?? 4096,
          ...(request.system ? { system: request.system } : {}),
          messages: toMessages(request.messages, config),
          ...(request.tools.length ? { tools: request.tools.map((tool) => ({
            name: tool.name, description: tool.description, input_schema: tool.parameters,
          })) } : {}),
        },
      }, {
        "Content-Type": "application/json", "anthropic-version": "2023-06-01",
        ...(config.auth === "bearer" ? { Authorization: `Bearer ${config.apiKey}` } : { "x-api-key": config.apiKey }),
      }, observer);
      if (!response.ok || !isObject(result) || result.error || result.type !== "message" || result.role !== "assistant") {
        const error = isObject(result) && isObject(result.error) ? result.error.message : undefined;
        throw new Error(typeof error === "string" ? error : `LLM 요청 실패: HTTP ${response.status} (Anthropic 메시지 형식 확인 필요)`);
      }
      const blocks = readContent(result.content);
      const message: AssistantMessage = { role: "assistant", content: contentOf(blocks) };
      message.replayState = {
        adapter: "anthropic-messages", provider: config.provider, model: config.model,
        data: { contentKey: JSON.stringify(message.content), content: blocks },
      };
      return { message, stopReason: stopReason(result.stop_reason, message), ...usageOf("anthropic-messages", result) };
    },
  };
}
