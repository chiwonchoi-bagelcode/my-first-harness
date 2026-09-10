import { createHash } from "node:crypto";
import type { WireRequest } from "../llm-types.ts";

// 외부 JSON 값을 필드 확인 가능한 객체로 좁힌다.
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// 이미지 바이트 대신 기록에 남길 한 줄 설명이다. 크기와 해시로 어떤 바이트가 전송됐는지 확인할 수 있다.
function describeImage(mediaType: string, base64: string): string {
  const bytes = Buffer.from(base64, "base64");
  return `[image data omitted from log: ${mediaType}, ${bytes.length} bytes, sha256 ${createHash("sha256").update(bytes).digest("hex")}]`;
}

// 전송 본문의 복사본에서 API별 이미지 필드만 설명 문자열로 바꾸고 바꾼 수를 함께 돌려준다. 실제 전송 본문은 건드리지 않는다.
export function omitImageData(api: WireRequest["api"], body: unknown): { body: unknown; imageDataOmitted: number } {
  // Chat Completions 어댑터는 텍스트 전용이므로 순회하지 않는다.
  if (api === "chat-completions") return { body, imageDataOmitted: 0 };
  let imageDataOmitted = 0;
  // 값을 새로 만들어 돌려주며 원본 객체는 수정하지 않는다.
  function walk(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(walk);
    if (!isObject(value)) return value;
    if (api === "responses" && value.type === "input_image" && typeof value.image_url === "string") {
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]*)$/.exec(value.image_url);
      if (match) {
        imageDataOmitted++;
        return { ...value, image_url: describeImage(match[1], match[2]) };
      }
    }
    if (api === "anthropic-messages" && value.type === "image" && isObject(value.source)
      && value.source.type === "base64" && typeof value.source.data === "string") {
      imageDataOmitted++;
      return { ...value, source: { ...value.source, data: describeImage(String(value.source.media_type ?? "image"), value.source.data) } };
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walk(entry)]));
  }
  return { body: walk(body), imageDataOmitted };
}
