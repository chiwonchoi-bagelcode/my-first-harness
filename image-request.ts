import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import sharp from "sharp";
import { imagesOf, MAX_REQUEST_IMAGE_BYTES } from "./image-content.ts";
import type { ContentBlock, ImageBlock, Message } from "./llm-types.ts";

// 원본 바이트가 같으면 같은 보관 파일과 축소 캐시를 사용한다.
function imageKey(image: ImageBlock) {
  return createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex");
}

// 중첩된 툴 결과까지 이미지 위치만 바꾸며 세션 원문과 assistant 재전송 정보는 보존한다.
export async function mapImages(messages: Message[], transform: (image: ImageBlock) => Promise<ContentBlock>): Promise<Message[]> {
  // 텍스트는 그대로 두고 이미지 변환 순서를 보존한다.
  async function blocks(content: ContentBlock[]) {
    return Promise.all(content.map((block) => block.type === "image" ? transform(block) : block));
  }
  const result: Message[] = [];
  for (const message of messages) {
    if (message.role === "assistant") result.push(message);
    else if (message.role === "user") result.push({ ...message, content: await blocks(message.content) });
    else result.push({ ...message, content: await Promise.all(message.content.map(async (block) => ({
      ...block, content: typeof block.content === "string" ? block.content : await blocks(block.content),
    }))) });
  }
  return result;
}

// 파일·MCP·첨부의 원본 바이트를 내용 해시 파일로 보존하고 실제 재열람 경로를 붙인다.
export async function archiveImages(messages: Message[], sessionDirectory: string): Promise<Message[]> {
  return mapImages(messages, async (image) => {
    const directory = join(sessionDirectory, "attachments");
    const extension = image.mediaType.split("/")[1];
    const storedPath = join(directory, `${imageKey(image)}.${extension}`);
    const bytes = Buffer.from(image.data, "base64");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${storedPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o400 });
    try {
      // 완전히 쓴 파일만 공개하고 같은 이미지의 동시 등록도 덮어쓰지 않는다.
      try { await link(temporary, storedPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!(await readFile(storedPath)).equals(bytes)) throw new Error(`이미지 보관 파일이 손상되었습니다: ${storedPath}`);
      }
    } finally { await unlink(temporary); }
    return { ...image, storedPath, name: image.name ?? basename(image.path ?? storedPath) };
  });
}

// Anthropic 표준 해상도 규칙: 28px 패치 1568개와 긴 변 1568px 이내, 비율 유지·확대 없음.
export function requestImageSize(width: number, height: number): { width: number; height: number } {
  if (height > width) {
    const rotated = requestImageSize(height, width);
    return { width: rotated.height, height: rotated.width };
  }
  // 패딩된 크기와 패치 개수를 함께 검사한다.
  function fits(w: number, h: number) {
    return Math.ceil(w / 28) * 28 <= 1568 && Math.ceil(h / 28) * 28 <= 1568
      && Math.ceil(w / 28) * Math.ceil(h / 28) <= 1568;
  }
  if (fits(width, height)) return { width, height };
  let low = 1, high = width;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (fits(mid, Math.max(1, Math.round(mid * height / width)))) low = mid;
    else high = mid;
  }
  return { width: low, height: Math.max(1, Math.round(low * height / width)) };
}

// 반복 요청에서 같은 원본을 다시 디코딩하지 않되 캐시가 무한히 커지지는 않게 한다.
const previews = new Map<string, Pick<ImageBlock, "data" | "mediaType" | "width" | "height">>();

// 원본은 변경하지 않고 회전·축소한 전송본을 만든다. 작은 이미지는 바이트도 그대로 유지한다.
async function previewImage(image: ImageBlock): Promise<ImageBlock> {
  const size = requestImageSize(image.width, image.height);
  if (size.width === image.width && size.height === image.height) return image;
  const key = `${imageKey(image)}:${size.width}x${size.height}`;
  let preview = previews.get(key);
  if (!preview) {
    const bytes = await sharp(Buffer.from(image.data, "base64"), { limitInputPixels: 4096 * 4096 })
      .rotate().resize(size.width, size.height, { fit: "fill" }).png().toBuffer();
    preview = { ...size, data: bytes.toString("base64"), mediaType: "image/png" };
    if (previews.size >= 16) previews.delete(previews.keys().next().value!);
    previews.set(key, preview);
  }
  return { ...image, ...preview, originalDimensions: { width: image.width, height: image.height } };
}

// 생략은 툴 실패가 아니며 필요할 때만 보관 원본을 다시 읽도록 안내한다.
function omittedImage(image: ImageBlock): ContentBlock {
  const size = image.originalDimensions ?? image;
  return { type: "text", text: [
    "[이미지 본문 생략: 요청 이미지 예산 초과. 툴 실패가 아님.]",
    `이름: ${JSON.stringify(image.name ?? (image.path ? basename(image.path) : "이름 없는 이미지"))}`,
    `원본 크기: ${size.width}×${size.height}`,
    ...(image.path ? [`원래 경로: ${JSON.stringify(image.path)} (현재 파일은 변경됐을 수 있음)`] : []),
    image.storedPath ? `보관 경로: ${JSON.stringify(image.storedPath)}. 필요하면 readImage로 다시 읽을 수 있음.`
      : "보관 경로 없음. 원본이 필요하면 사용자에게 재첨부를 요청할 것.",
    "생략됐다는 이유만으로 반복해서 다시 읽지 말 것.",
  ].join("\n") };
}

// 20 MiB Base64 예산을 넘으면 오래된 이미지부터 5 MiB 단위로 생략한 요청 복사본을 만든다.
export async function projectRequestImages(messages: Message[], options: { maxBytes?: number; protectRecent?: boolean } = {}): Promise<Message[]> {
  const maxBytes = options.maxBytes ?? MAX_REQUEST_IMAGE_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error("이미지 요청 예산은 양수여야 합니다.");
  const projected = await mapImages(messages, previewImage);
  const images = imagesOf(projected);
  const total = images.reduce((sum, image) => sum + Buffer.byteLength(image.data), 0);
  if (total <= maxBytes) return projected;
  const lastAssistant = projected.findLastIndex((message) => message.role === "assistant");
  const recentCount = options.protectRecent ? imagesOf(projected.slice(lastAssistant + 1)).length : 0;
  const recentBytes = images.slice(images.length - recentCount).reduce((sum, image) => sum + Buffer.byteLength(image.data), 0);
  if (recentBytes > maxBytes) throw new Error("이번 스텝의 새 이미지들만으로 전송 예산을 초과합니다. 이미지 수를 줄여 주세요.");
  const quantum = Math.min(5 * 1024 * 1024, maxBytes);
  const target = Math.ceil((total - maxBytes) / quantum) * quantum;
  let count = 0, removed = 0;
  while (count < images.length - recentCount && removed < target) removed += Buffer.byteLength(images[count++].data);
  let index = 0;
  return mapImages(projected, async (image) => index++ < count ? omittedImage(image) : image);
}
