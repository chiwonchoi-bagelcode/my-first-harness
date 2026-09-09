import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { archiveImages, projectRequestImages, requestImageSize } from "../image-request.ts";
import { checkImageInput, imageFromBytes, imagesOf, loadImage, MAX_REQUEST_IMAGE_BYTES, withImagePaths } from "../image-content.ts";
import { createHarnessPaths } from "../harness-paths.ts";
import { saveSession, loadSession } from "../session-store.ts";
import { recordLLM } from "../recorded-llm.ts";
import { createResponsesAdapter } from "../adapters/responses.ts";
import { createAnthropicMessagesAdapter } from "../adapters/anthropic-messages.ts";
import { summarize } from "../llm.ts";
import type { ImageBlock, Message } from "../llm-types.ts";
import { solidPng } from "./image-fixture.ts";

// 테스트용 원본 이미지와 파일 경로를 일관되게 만든다.
async function fixtureImage(path?: string) { return imageFromBytes(solidPng(), path); }

test("공개 축소 예시·세로 화면·작은 이미지의 비율과 패치 예산을 지킨다", () => {
  assert.deepEqual(requestImageSize(3456, 2234), { width: 1372, height: 887 });
  assert.deepEqual(requestImageSize(1920, 1080), { width: 1456, height: 819 });
  assert.deepEqual(requestImageSize(2234, 3456), { width: 887, height: 1372 });
  assert.deepEqual(requestImageSize(128, 128), { width: 128, height: 128 });
  for (const [width, height] of [[4000, 3000], [100, 8192], [8192, 100]]) {
    const size = requestImageSize(width, height);
    assert.ok(Math.ceil(size.width / 28) * Math.ceil(size.height / 28) <= 1568);
    assert.ok(size.width <= 1568 && size.height <= 1568);
    assert.ok(Math.abs(size.height - size.width * height / width) <= Math.max(1, height / width));
  }
});

test("4 MiB보다 큰 정상 원본도 받아 축소하며 원본 바이트·회전 좌표를 보존한다", async () => {
  const bytes = await sharp(randomBytes(1800 * 1000 * 3), { raw: { width: 1800, height: 1000, channels: 3 } }).png().toBuffer();
  assert.ok(bytes.length > 4 * 1024 * 1024);
  const original = await imageFromBytes(bytes);
  const messages: Message[] = [{ role: "user", content: [original] }];
  const snapshot = structuredClone(messages);
  const preview = imagesOf(await projectRequestImages(messages))[0];
  assert.deepEqual(messages, snapshot);
  assert.deepEqual(preview.originalDimensions, { width: 1800, height: 1000 });
  const metadata = await sharp(Buffer.from(preview.data, "base64")).metadata();
  assert.equal(metadata.width, preview.width);
  assert.equal(metadata.height, preview.height);
  assert.match(JSON.stringify(withImagePaths([preview])), /좌표/);
  const rotated = await imageFromBytes(await sharp(bytes).withMetadata({ orientation: 6 }).jpeg().toBuffer());
  const portrait = imagesOf(await projectRequestImages([{ role: "user", content: [rotated] }]))[0];
  const portraitMetadata = await sharp(Buffer.from(portrait.data, "base64")).metadata();
  assert.equal(portraitMetadata.width, portrait.width);
  assert.equal(portraitMetadata.height, portrait.height);
  assert.ok(portrait.height > portrait.width);
});

test("원본 보관은 중복·동시 쓰기를 처리하고 원래 파일 변경·resume 후에도 다시 읽힌다", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mfh-image-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'screen "one".png');
  await writeFile(source, solidPng());
  const original = await loadImage(source);
  const paths = createHarnessPaths(root, root);
  const messages: Message[] = [{ role: "user", content: [original, original] }];
  const archived = await archiveImages(messages, paths.sessionDirectory);
  assert.equal(original.storedPath, undefined);
  const [first, second] = imagesOf(archived);
  assert.equal(first.storedPath, second.storedPath);
  assert.equal((await readdir(join(paths.sessionDirectory, "attachments"))).length, 1);
  await writeFile(source, "changed");
  await saveSession({ id: "image-review", workspaceDirectory: root, system: "test", messages: archived }, paths);
  const resumed = await loadSession("image-review", paths);
  const preserved = imagesOf(resumed.messages)[0];
  assert.deepEqual(await readFile(preserved.storedPath!), solidPng());
  assert.equal((await loadImage(preserved.storedPath!)).data, original.data);
  const projected = await projectRequestImages(resumed.messages, { maxBytes: first.data.length });
  const marker = projected[0].content[0];
  assert.equal(marker.type, "text");
  assert.match(JSON.stringify(marker), /readImage|보관 경로/);
  assert.ok(JSON.stringify(marker).includes(JSON.stringify(first.storedPath!).slice(1, -1)));
  // 다시 읽은 이미지는 새 위치에 추가되므로 오래된 생략 대상과 구분된다.
  const reread: Message[] = [...resumed.messages, { role: "assistant", content: [] },
    { role: "user", content: [await loadImage(preserved.storedPath!)] }];
  assert.equal(imagesOf(await projectRequestImages(reread, { maxBytes: first.data.length, protectRecent: true })).length, 1);
});

test("생략은 같은 위치의 text만 교체하고 호출 ID·원문·재전송 정보와 결정성을 보존한다", async () => {
  const image = await fixtureImage();
  const assistant: Message = { role: "assistant", content: [{ type: "tool-call", id: "call", name: "screen", arguments: "{}" }],
    replayState: { adapter: "mock", provider: "test", model: "test", data: { opaque: "keep" } } };
  const messages: Message[] = [{ role: "user", content: [image] }, assistant,
    { role: "tool", content: [{ type: "tool-result", toolCallId: "call", content: [{ type: "text", text: "ok" }, image] }] }];
  const before = structuredClone(messages);
  const options = { maxBytes: image.data.length, protectRecent: true };
  const projected = await projectRequestImages(messages, options);
  assert.deepEqual(messages, before);
  assert.equal(projected[0].content[0].type, "text");
  assert.equal(projected[1], assistant);
  assert.deepEqual(projected[2], messages[2]);
  assert.deepEqual(await projectRequestImages(messages, options), projected);
  assert.deepEqual(await projectRequestImages(JSON.parse(JSON.stringify(messages)), options), projected);
  await assert.rejects(projectRequestImages([{ role: "user", content: [image, image] }], options), /새 이미지/);
});

test("20 MiB는 Base64 기준이며 한도 초과 시 새 이미지를 오류로 바꾸지 않고 이전 이미지를 비운다", async () => {
  assert.equal(MAX_REQUEST_IMAGE_BYTES, 20 * 1024 * 1024);
  const bytes = await sharp(randomBytes(1024 * 1024 * 3), { raw: { width: 1024, height: 1024, channels: 3 } }).png().toBuffer();
  const image = await imageFromBytes(bytes);
  const messages: Message[] = [];
  for (let i = 0; i < 6; i++) {
    messages.push({ role: "assistant", content: [] }, { role: "tool", content: [
      { type: "tool-result", toolCallId: String(i), content: [image] },
    ] });
  }
  const projected = await projectRequestImages(messages, { protectRecent: true });
  checkImageInput(projected, true);
  assert.ok(imagesOf(projected).length < 6);
  assert.deepEqual(projected.at(-1), messages.at(-1));
  assert.equal(imagesOf(messages).length, 6);
  const end = [...messages, { role: "assistant" as const, content: [] }];
  assert.deepEqual(await projectRequestImages(end, { protectRecent: true }), [...projected, end.at(-1)]);
});

test("요약 호출도 같은 축소 경로를 거치며 기록용 원본은 바뀌지 않는다", async () => {
  const image = await imageFromBytes(await sharp({ create: { width: 3456, height: 2234, channels: 3, background: "red" } }).png().toBuffer());
  const conversation: Message[] = [{ role: "user", content: [image] }];
  const before = structuredClone(conversation);
  const adapter = recordLLM({ supportsImages: true,
    // 네트워크 대신 실제 요청 조립 결과를 검사한다.
    async generate(request) {
      assert.equal(imagesOf(request.messages)[0].width, 1372);
      return { stopReason: "stop", message: { role: "assistant", content: [{ type: "text", text: "요약" }] } };
    },
  }, {
    // 이 테스트는 파일 대신 호출 경로만 검증한다.
    async append() {},
    // 비동기 파일 기록이 없어 바로 완료한다.
    async flush() {},
  }, { sessionId: "test" }, "compaction");
  assert.equal(await summarize(adapter, conversation), "요약");
  assert.deepEqual(conversation, before);
});

test("축소·생략된 요청은 Responses와 Anthropic에서 일반 텍스트·이미지 필드로 전송된다", async (t) => {
  const original = await imageFromBytes(await sharp({ create: { width: 3456, height: 2234, channels: 3, background: "blue" } }).png().toBuffer());
  const image = { ...original, name: "screen.png", storedPath: "/test/attachments/screen.png" };
  const messages: Message[] = [{ role: "user", content: [image] },
    { role: "assistant", content: [{ type: "tool-call", id: "call", name: "screenshot", arguments: "{}" }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "call", content: [image] }] }];
  const preview = imagesOf(await projectRequestImages(messages))[0];
  const projected = await projectRequestImages(messages, { maxBytes: preview.data.length, protectRecent: true });
  const config = { provider: "test", baseURL: "https://example.invalid", apiKey: "test", model: "test", supportsImages: true };
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    requests++;
    const body = JSON.parse(String(init?.body));
    assert.match(JSON.stringify(body), /이미지 본문 생략/);
    assert.match(JSON.stringify(body), /\/test\/attachments\/screen.png/);
    assert.ok(!JSON.stringify(body).includes(original.data));
    if (String(url).endsWith("/responses")) {
      assert.equal(typeof body.input[0].content, "string");
      assert.equal(body.input[2].call_id, "call");
      assert.equal(body.input[2].output.at(-1).image_url, `data:image/png;base64,${preview.data}`);
      return Response.json({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] });
    }
    assert.equal(body.messages[0].content[0].type, "text");
    assert.equal(body.messages[2].content[0].tool_use_id, "call");
    assert.equal(body.messages[2].content[0].content.at(-1).source.data, preview.data);
    return Response.json({ type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" });
  });
  for (const adapter of [createResponsesAdapter(config), createAnthropicMessagesAdapter(config)]) {
    await adapter.generate({ system: "", messages: projected, tools: [] });
  }
  assert.equal(requests, 2);
  assert.equal(imagesOf(messages)[0].data, original.data);
});
