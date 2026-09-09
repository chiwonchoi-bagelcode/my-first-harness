import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import sharp from "sharp";
import { withoutReplayState } from "./llm-types.ts";
import type { ContentBlock, ImageBlock, Message, ToolContent } from "./llm-types.ts";

// 원본 입력 한도와 Base64 인코딩 후 요청 합계 한도는 서로 다른 기준이다.
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024;

// 일반 파일만 제한된 크기로 읽고 공통 이미지 검사에 전달한다.
export async function loadImage(path: string): Promise<ImageBlock> {
  const absolute = resolve(path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path);
  // FIFO 같은 특수 파일도 open에서 멈추지 않고 아래 일반 파일 검사로 거절한다.
  const file = await open(absolute, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("이미지는 일반 파일이어야 합니다.");
    if (info.size > MAX_IMAGE_BYTES) throw new Error("원본 이미지는 20 MiB 이하여야 합니다.");
    // 파일이 읽는 동안 커져도 한도보다 많이 메모리에 올리지 않는다.
    const buffer = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_IMAGE_BYTES) throw new Error("원본 이미지는 20 MiB 이하여야 합니다.");
    return imageFromBytes(buffer.subarray(0, length), absolute);
  } finally { await file.close(); }
}

// sharp로 형식·치수·픽셀 손상을 검사하되 정상 이미지의 원본 바이트는 보존한다.
export async function imageFromBytes(bytes: Buffer, path?: string): Promise<ImageBlock> {
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("원본 이미지는 20 MiB 이하여야 합니다.");
  const image = sharp(bytes, { failOn: "error", limitInputPixels: 4096 * 4096 });
  const metadata = await image.metadata().catch(() => {
    throw new Error("이미지를 읽을 수 없습니다. PNG·JPEG·WebP 형식과 파일 손상 여부를 확인해 주세요.");
  });
  const format = metadata.format;
  if (format !== "png" && format !== "jpeg" && format !== "webp") {
    throw new Error("현재는 PNG·JPEG·WebP 이미지만 지원합니다.");
  }
  if ((metadata.pages ?? 1) > 1) throw new Error("현재는 정지 이미지만 지원합니다. 한 프레임을 저장해 주세요.");
  // EXIF 회전 정보가 축을 바꾸는 경우 화면에 보이는 가로·세로를 기록한다.
  const transposed = (metadata.orientation ?? 1) >= 5;
  const width = transposed ? metadata.height : metadata.width;
  const height = transposed ? metadata.width : metadata.height;
  if (!width || !height || width > 8192 || height > 8192) {
    throw new Error("이미지의 가로·세로는 각각 1~8192픽셀이어야 합니다. 크기를 줄여 주세요.");
  }
  await image.raw().toBuffer().catch(() => {
    throw new Error("이미지 픽셀을 읽을 수 없습니다. 파일 손상 여부를 확인해 주세요.");
  });
  return { type: "image", mediaType: `image/${format}`, data: bytes.toString("base64"),
    ...(path ? { path } : {}), width, height };
}

// 문자열을 텍스트 블록으로 감싸되 기존 블록 배열은 그대로 유지한다.
export function contentBlocks(content: ToolContent): ContentBlock[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

// 전송할 이미지 바로 앞에 출처를 붙인다. 저장된 메시지는 변경하지 않는다.
export function withImagePaths(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.flatMap((block): ContentBlock[] => block.type === "image" && (block.path || block.storedPath || block.originalDimensions) ? [
    { type: "text", text: [
      ...(block.path ? [`다음 이미지의 원본 파일 경로: ${JSON.stringify(block.path)}\n이미지를 읽은 시점의 경로이며, 현재 파일은 변경되거나 삭제되었을 수 있습니다.`] : []),
      ...(block.storedPath ? [`당시 원본 보관 경로: ${JSON.stringify(block.storedPath)} (읽기 전용 복사본)`] : []),
      ...(block.originalDimensions ? [`원본 ${block.originalDimensions.width}×${block.originalDimensions.height}, 전송 이미지 ${block.width}×${block.height}. 좌표는 전송 이미지 기준이며 실제 화면 조작 시 변환이 필요합니다.`] : []),
    ].join("\n") },
    block,
  ] : [block]);
}

// 사용자 메시지와 툴 결과의 이미지 블록을 원래 순서대로 모은다.
export function imagesOf(messages: Message[]): ImageBlock[] {
  return messages.flatMap((message) => {
    const blocks = message.role === "tool"
      ? message.content.flatMap((block) => contentBlocks(block.content)) : message.content;
    return blocks.filter((block): block is ImageBlock => block.type === "image");
  });
}

// 미지원 연결이나 과도한 이미지 요청을 전송 전에 명시적으로 거절한다.
export function checkImageInput(messages: Message[], supported: boolean | undefined, checkBudget = true) {
  const images = imagesOf(messages);
  if (images.length && !supported) throw new Error("현재 모델 연결은 이미지 입력이 비활성화되어 있습니다.");
  const bytes = images.reduce((sum, image) => sum + Buffer.byteLength(image.data), 0);
  if (checkBudget && bytes > MAX_REQUEST_IMAGE_BYTES) {
    throw new Error("전송 이미지의 Base64 합계가 20 MiB를 넘었습니다. 이번 입력의 이미지 수를 줄여 주세요.");
  }
}

// 텍스트 JSON 안의 이미지 데이터는 번호·경로로 대체하고 실제 이미지는 별도 블록으로 보낸다.
export function summaryContent(messages: Message[]): ContentBlock[] {
  const images: ImageBlock[] = [];
  const text = JSON.stringify(withoutReplayState(messages), (_key, value) => {
    if (value?.type !== "image") return value;
    images.push(value);
    return { type: "image", imageNumber: images.length, path: value.path, storedPath: value.storedPath,
      name: value.name, width: value.width, height: value.height };
  });
  return [{ type: "text", text }, ...images.flatMap((image, index): ContentBlock[] => [
    { type: "text", text: `기록의 이미지 ${index + 1}: ${image.path ?? "툴이 반환한 인라인 이미지"}` }, image,
  ])];
}

// /attach의 나머지 전체를 한 경로로 읽는다. 공백 경로와 감싼 따옴표를 허용한다.
export function attachmentPath(input: string): string {
  let path = input.slice("/attach".length).trim();
  if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) path = path.slice(1, -1);
  if (!path) throw new Error("사용법: /attach /path/to/image.png");
  return path;
}
