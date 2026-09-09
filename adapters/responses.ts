import { textOf } from "../llm-types.ts";
import { checkImageInput, withImagePaths } from "../image-content.ts";
import { requestJSON } from "./http.ts";
import { usageOf } from "./usage.ts";
import type { AssistantMessage, ContentBlock, LLMAdapter, Message, StopReason, ToolContent } from "../llm-types.ts";

// Responses 연결에 사용할 경로 이름, API 주소, 모델과 인증 키.
type Config = {
  provider: string;
  baseURL: string;
  model: string;
  apiKey: string | undefined;
  // 생략하면 모델 기본값을 쓴다. 허용값은 연결 서버와 모델별 문서로 확인한다.
  reasoningEffort?: string;
  // Farm처럼 SSE만 반환하는 연결에서는 스트리밍으로 요청한다.
  stream?: boolean;
  // false인 연결에는 서버가 무시하는 출력 한도 필드를 보내지 않는다.
  supportsMaxOutputTokens?: boolean;
  supportsImages?: boolean;
};

// 이 어댑터가 지원하는 텍스트·거절·함수 호출·재전송용 reasoning 항목.
type OutputItem = (
  | { type: "message"; role: "assistant"; content: (
    | { type: "output_text"; text: string }
    | { type: "refusal"; refusal: string }
  )[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "reasoning"; summary: { type: "summary_text"; text: string }[]; encrypted_content: string }
) & { id?: string; status?: string };

// 외부 JSON을 필드 확인 가능한 객체로 좁힌다.
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// 지원 범위를 확인하되 phase·ID 등 재전송에 필요한 원본 필드는 그대로 유지한다.
function readOutput(value: unknown): OutputItem[] {
  if (!Array.isArray(value)) throw new Error("Responses output이 배열이 아닙니다.");
  for (const item of value) {
    if (!isObject(item)
      || (item.id !== undefined && typeof item.id !== "string")
      || (item.status !== undefined && !["completed", "incomplete", "in_progress"].includes(String(item.status)))) {
      throw new Error("지원하지 않는 Responses 출력 항목입니다.");
    }
    if (item.type === "message") {
      if (item.role !== "assistant" || !Array.isArray(item.content)
        || !item.content.every((block: unknown) => isObject(block) && (
          (block.type === "output_text" && typeof block.text === "string")
          || (block.type === "refusal" && typeof block.refusal === "string")
        ))) throw new Error("지원하지 않는 Responses 메시지 형식입니다.");
    } else if (item.type === "function_call") {
      if (typeof item.call_id !== "string" || !item.call_id
        || typeof item.name !== "string" || !item.name || typeof item.arguments !== "string") {
        throw new Error("지원하지 않는 Responses 함수 호출 형식입니다.");
      }
    } else if (item.type === "reasoning") {
      if (!Array.isArray(item.summary) || !item.summary.every((part: unknown) =>
        isObject(part) && part.type === "summary_text" && typeof part.text === "string")) {
        throw new Error("지원하지 않는 Responses reasoning 형식입니다.");
      }
      if (typeof item.encrypted_content !== "string" || !item.encrypted_content) {
        throw new Error("Responses reasoning에 재전송할 encrypted_content가 없습니다.");
      }
    } else {
      throw new Error(`지원하지 않는 Responses 출력 타입입니다: ${item.type}`);
    }
  }
  return value as OutputItem[];
}

// 출력 순서대로 텍스트와 함수 호출만 공통 블록으로 만들고 reasoning은 노출하지 않는다.
function contentOf(output: OutputItem[]): AssistantMessage["content"] {
  const content: AssistantMessage["content"] = [];
  const callIds = new Set<string>();
  for (const item of output) {
    if (item.type === "message") {
      for (const block of item.content) {
        const text = block.type === "output_text" ? block.text : block.refusal;
        if (text) content.push({ type: "text", text });
      }
    } else if (item.type === "function_call") {
      if (callIds.has(item.call_id)) throw new Error("Responses 함수 호출 ID가 중복되었습니다.");
      callIds.add(item.call_id);
      // arguments는 ToolManager가 JSON 파싱·검증하도록 문자열을 유지한다.
      content.push({ type: "tool-call", id: item.call_id, name: item.name, arguments: item.arguments });
    }
  }
  return content;
}

// 출처·구조·공통 내용이 모두 일치할 때만 저장된 원본 출력 항목을 재사용한다.
function replayOutput(message: AssistantMessage, config: Config): OutputItem[] | undefined {
  const replay = message.replayState;
  if (replay?.adapter !== "responses" || replay.provider !== config.provider || replay.model !== config.model) return;
  const data = replay.data;
  if (!isObject(data) || data.contentKey !== JSON.stringify(message.content)) return;
  try {
    const output = readOutput(data.output);
    if (JSON.stringify(contentOf(output)) === data.contentKey) return output;
  } catch {
    // 손상된 재전송 정보는 쓰지 않고 공통 내용으로 요청을 구성한다.
  }
}

// 공통 이미지 블록을 data URL로 바꾸며 일반 텍스트 결과는 문자열로 유지한다.
function toContent(content: ToolContent): string | object[] {
  if (typeof content === "string") return content;
  return withImagePaths(content).map((block: ContentBlock) => block.type === "text"
    ? { type: "input_text", text: block.text }
    : { type: "input_image", image_url: `data:${block.mediaType};base64,${block.data}`, detail: "auto" });
}

// 사용자·툴 결과를 input 항목으로 바꾸고 assistant는 유효한 원본 또는 공통 내용으로 보낸다.
function toInput(message: Message, config: Config): object[] {
  if (message.role === "user") return [{ role: "user", content: message.content.some((block) => block.type === "image")
    ? toContent(message.content) : textOf(message) }];
  if (message.role === "tool") return message.content.map((block) => ({
    type: "function_call_output",
    call_id: block.toolCallId,
    output: toContent(block.isError
      ? typeof block.content === "string" ? `툴 오류: ${block.content}` : [{ type: "text", text: "툴 오류:" }, ...block.content]
      : block.content),
  }));
  const replay = replayOutput(message, config);
  if (replay) return replay;
  return message.content.map((block) => block.type === "text"
    ? { role: "assistant", content: block.text }
    : { type: "function_call", call_id: block.id, name: block.name, arguments: block.arguments });
}

// 응답 및 개별 항목이 정상 완료됐을 때만 최종 답변 또는 실행 가능한 툴 호출로 판단한다.
function stopReason(result: Record<string, unknown>, output: OutputItem[], message: AssistantMessage): StopReason {
  if (result.status === "incomplete" && isObject(result.incomplete_details)
    && result.incomplete_details.reason === "max_output_tokens") return "max-tokens";
  if (result.status !== "completed" || output.some((item) => item.status && item.status !== "completed")) return "other";
  if (message.content.some((block) => block.type === "tool-call")) return "tool-calls";
  return textOf(message).trim() ? "stop" : "other";
}

// 서버 세션에 의존하지 않고 매 요청에 기록을 직접 보내는 Responses 어댑터를 만든다.
export function createResponsesAdapter(config: Config): LLMAdapter {
  return {
    supportsImages: config.supportsImages ?? false,
    // 공통 요청을 Responses로 보내고 공통 답변과 다음 요청용 원본 출력 항목을 반환한다.
    async generate(request, observer, signal) {
      if (!config.apiKey) throw new Error("Responses API 인증 키가 없습니다.");
      checkImageInput(request.messages, config.supportsImages);
      const { response, result } = await requestJSON({
        api: "responses", provider: config.provider, model: config.model,
        url: `${config.baseURL.replace(/\/$/, "")}/responses`,
        body: {
          model: config.model,
          store: false,
          ...(config.stream ? { stream: true } : {}),
          include: ["reasoning.encrypted_content"],
          ...(config.reasoningEffort ? { reasoning: { effort: config.reasoningEffort } } : {}),
          ...(request.system ? { instructions: request.system } : {}),
          input: request.messages.flatMap((message) => toInput(message, config)),
          ...(request.tools.length ? { tools: request.tools.map((tool) => ({
            type: "function", name: tool.name, description: tool.description, parameters: tool.parameters,
            // 선택 인자를 강제 필수로 바꾸지 않는다. 기존 ToolManager에서 원래 스키마로 검증한다.
            strict: false,
          })) } : {}),
          ...(config.supportsMaxOutputTokens !== false && request.maxOutputTokens !== undefined
            ? { max_output_tokens: request.maxOutputTokens } : {}),
        },
      }, { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" }, observer, config.stream, signal);
      if (!response.ok || !isObject(result) || result.error || result.status === "failed") {
        const error = isObject(result) && isObject(result.error) ? result.error.message : undefined;
        throw new Error(typeof error === "string" ? error : `LLM 요청 실패: HTTP ${response.status}`);
      }
      const output = readOutput(result.output);
      const message: AssistantMessage = { role: "assistant", content: contentOf(output) };
      // 재전송에 필요한 항목만 메시지에 넣고 전체 HTTP 응답은 실행 로그에 별도로 남긴다.
      message.replayState = {
        adapter: "responses", provider: config.provider, model: config.model,
        data: { contentKey: JSON.stringify(message.content), output },
      };
      return { message, stopReason: stopReason(result, output, message), ...usageOf("responses", result) };
    },
  };
}
