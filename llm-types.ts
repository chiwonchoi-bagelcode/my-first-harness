// 하네스 내부 형식. API별 필드 이름은 adapters/ 안에서만 사용한다.
// 사용자 입력이나 모델 답변의 텍스트 한 조각.
export type TextBlock = { type: "text"; text: string };

// 지원하는 이미지 원본을 세션에 보존하고 API 요청에서는 이미지 입력으로 변환한다.
export type ImageBlock = {
  type: "image";
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  data: string;
  // 파일에서 읽은 경우만 경로가 있다. MCP 인라인 이미지는 경로가 없을 수 있다.
  path?: string;
  // 당시 바이트를 보관한 경로와 표시 이름이며 원래 파일의 변경과 독립적이다.
  storedPath?: string;
  name?: string;
  // 요청용 축소본에서만 사용하며 좌표 변환의 기준이 되는 원본 크기다.
  originalDimensions?: { width: number; height: number };
  width: number;
  height: number;
};

// 사용자 입력과 툴 결과에 담을 수 있는 텍스트 또는 이미지.
export type ContentBlock = TextBlock | ImageBlock;

// 일반 툴의 문자열 반환과 이미지 툴의 블록 배열을 모두 보존한다.
export type ToolContent = string | ContentBlock[];

// 모델이 요청한 툴의 호출 ID, 이름, JSON 인자.
export type ToolCallBlock = {
  type: "tool-call";
  id: string;
  name: string;
  arguments: string;
};

// 특정 툴 호출에 대응하는 실행 결과와 오류 여부.
export type ToolResultBlock = {
  type: "tool-result";
  toolCallId: string;
  content: ToolContent;
  isError?: boolean;
};

// 같은 API로 대화를 이어갈 때 어댑터가 사용할 전용 정보와 출처.
export type ReplayState = {
  adapter: string;
  provider: string;
  model: string;
  // 어댑터가 JSON으로 저장 가능한 값만 넣고, 읽을 때 구조를 확인한다.
  data: unknown;
};

// 모델의 텍스트·툴 호출과 선택적인 재전송 정보를 담는 메시지.
export type AssistantMessage = {
  role: "assistant";
  content: (TextBlock | ToolCallBlock)[];
  replayState?: ReplayState;
};

// 사용자 입력, 모델 응답, 툴 결과를 구분하는 공통 메시지 형식.
export type Message =
  | { role: "user"; content: ContentBlock[] }
  | AssistantMessage
  | { role: "tool"; content: ToolResultBlock[] };

// 실행 함수는 제외하고 모델에게 전달할 툴 설명과 인자 규격.
export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

// 컨텍스트 조립이 끝난 시스템 지침, 대화, 툴 정의와 출력 한도.
export type LLMRequest = {
  system: string;
  messages: Message[];
  tools: ToolDefinition[];
  maxOutputTokens?: number;
  // 이 요청의 접두어(툴·지침·대화)를 다음 요청에서 다시 보낼 예정임을 알린다. 명시적 캐시 표시가 필요한 제공자만 사용하며,
  // 요약·독립 의견처럼 한 번만 보내는 요청에는 켜지 않는다(쓰기 요금만 내고 읽히지 않는다).
  promptCache?: boolean;
};

// 이번 모델 응답이 끝난 이유를 API와 무관하게 구분한 값.
export type StopReason = "stop" | "tool-calls" | "max-tokens" | "other";

// 제공자가 보고한 토큰 수다. 누락은 미확인이며 0으로 채우지 않는다.
export type LLMUsage = {
  // 캐시 읽기·쓰기를 포함한 전체 입력 토큰 수.
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  // 출력 토큰에 포함된 부분 집합이므로 출력에 다시 더하지 않는다.
  reasoningOutputTokens?: number;
};

// 인증 정보 없이 기록할 실제 API 요청 본문과 연결 식별 정보.
export type WireRequest = {
  api: "chat-completions" | "responses" | "anthropic-messages";
  provider: string;
  model: string;
  url: string;
  body: unknown;
  // 기록용 본문에서 설명 문자열로 바꾼 이미지 수다. 실제 전송 본문은 바뀌지 않는다.
  imageDataOmitted?: number;
};

// 변환 실패 응답도 분석할 수 있도록 보존하는 HTTP 결과와 사용량.
export type WireResponse = {
  status: number;
  requestId?: string;
  body: unknown;
  usage?: LLMUsage;
};

// API 전송 직전과 응답 해석 전에 기록을 기다리는 선택적 관찰 함수.
export type LLMObserver = {
  onRequest(request: WireRequest): Promise<void>;
  onResponse(response: WireResponse): Promise<void>;
  // 스트리밍 응답의 텍스트 조각이 도착하는 즉시 받는 동기 콜백이다. 없으면 조각은 화면에 전달되지 않고 완성본만 반환된다.
  onTextDelta?(text: string): void;
};

// 어댑터가 반환하는 공통 assistant 메시지, 종료 이유와 사용량.
export type LLMResult = {
  message: AssistantMessage;
  stopReason: StopReason;
  usage?: LLMUsage;
};

// 각 API 어댑터가 공통 요청과 결과를 주고받기 위해 지킬 계약.
export interface LLMAdapter {
  // 제공자별 한도 또는 명시적으로 선택한 운영 예산을 코어에 전달한다.
  contextBudget?: import("./token-budget.ts").ContextBudget;
  // 선택한 모델·연결에서 이미지 전송을 허용할지 명시한다. 미지정은 비활성화다.
  supportsImages?: boolean;
  // 공통 요청을 받아 모델을 한 번 호출하고 공통 결과로 반환한다.
  generate(request: LLMRequest, observer?: LLMObserver, signal?: AbortSignal): Promise<LLMResult>;
}

// 메시지의 텍스트 블록만 순서대로 이어 붙여 문자열로 반환한다.
export function textOf(message: Message): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

// 요약·크기 계산용으로 원본을 유지한 채 assistant의 재전송 정보를 뺀 새 메시지 배열을 만든다.
export function withoutReplayState(messages: Message[]): Message[] {
  return messages.map((message) => message.role === "assistant"
    ? { role: "assistant", content: message.content }
    : message);
}
