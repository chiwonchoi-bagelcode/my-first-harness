import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentPath, checkImageInput, imagesOf, loadImage, MAX_IMAGE_BYTES, summaryContent, withImagePaths } from "../image-content.ts";
import { compactSession, contextSize, pruneToolResults, shouldCompact } from "../context-manager.ts";
import { createResponsesAdapter } from "../adapters/responses.ts";
import { createAnthropicMessagesAdapter } from "../adapters/anthropic-messages.ts";
import { createChatCompletionsAdapter } from "../adapters/chat-completions.ts";
import { createHarnessPaths } from "../harness-paths.ts";
import { loadSession, saveSession } from "../session-store.ts";
import { recordLLM } from "../recorded-llm.ts";
import { summarize } from "../llm.ts";
import { solidPng } from "./image-fixture.ts";
import type { ImageBlock, LLMAdapter, Message } from "../llm-types.ts";

const image: ImageBlock = { type: "image", mediaType: "image/png", data: solidPng().toString("base64"),
  width: 128, height: 128, path: "/test/reference.png" };
const config = { provider: "test", baseURL: "https://example.invalid/v1", model: "test", apiKey: "test", supportsImages: true };
const pathText = `다음 이미지의 원본 파일 경로: "/test/reference.png"\n이미지를 읽은 시점의 경로이며, 현재 파일은 변경되거나 삭제되었을 수 있습니다.`;

// 같은 이미지를 사용자 첨부와 특정 툴 호출의 결과 양쪽에 배치한다.
function messages(): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: "이 화면을 확인해" }, image] },
    { role: "assistant", content: [{ type: "tool-call", id: "image-call", name: "readImage", arguments: "{}" }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "image-call", content: [
      { type: "text", text: "스크린샷" }, image,
    ] }] },
  ];
}

test("PNG를 읽고 파일 형식·크기·치수·경로 오류를 거절한다", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-image-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "space name.png");
  const bytes = solidPng();
  await writeFile(path, bytes);
  assert.deepEqual(await loadImage(path), { ...image, path });
  await assert.rejects(loadImage(directory), /일반 파일/);
  await assert.rejects(loadImage(join(directory, "missing.png")), /ENOENT/);
  await writeFile(path, "not a png");
  await assert.rejects(loadImage(path), /PNG/);
  await writeFile(path, Buffer.alloc(MAX_IMAGE_BYTES + 1));
  await assert.rejects(loadImage(path), /4 MiB/);
  const large = Buffer.from(bytes);
  large.writeUInt32BE(4097, 16);
  await writeFile(path, large);
  await assert.rejects(loadImage(path), /4096/);
  assert.equal(attachmentPath('/attach "/some dir/a.png"'), "/some dir/a.png");
  assert.equal(attachmentPath("/attach /some dir/a.png"), "/some dir/a.png");
  assert.throws(() => attachmentPath("/attach"), /사용법/);
});

test("Responses는 첨부와 tool output을 모두 input_image로 전달한다", async (t) => {
  const original = messages();
  const snapshot = structuredClone(original);
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const wireImage = { type: "input_image", image_url: `data:image/png;base64,${image.data}`, detail: "auto" };
    const pathBlock = { type: "input_text", text: pathText };
    assert.deepEqual(body.input[0].content, [{ type: "input_text", text: "이 화면을 확인해" }, pathBlock, wireImage]);
    assert.deepEqual(body.input[2], { type: "function_call_output", call_id: "image-call",
      output: [{ type: "input_text", text: "스크린샷" }, pathBlock, wireImage] });
    return Response.json({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "확인" }] }] });
  });
  const adapter = createResponsesAdapter(config);
  assert.equal(adapter.supportsImages, true);
  await adapter.generate({ system: "", messages: original, tools: [] });
  // 저장/resume와 같은 JSON 왕복 뒤 재전송해도 경로 안내가 누적되지 않는다.
  await adapter.generate({ system: "", messages: JSON.parse(JSON.stringify(original)), tools: [] });
  assert.deepEqual(original, snapshot);
});

test("Anthropic은 첨부와 tool_result 안의 source를 base64 이미지로 변환한다", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const wireImage = { type: "image", source: { type: "base64", media_type: "image/png", data: image.data } };
    const pathBlock = { type: "text", text: pathText };
    assert.deepEqual(body.messages[0].content, [{ type: "text", text: "이 화면을 확인해" }, pathBlock, wireImage]);
    assert.deepEqual(body.messages[2].content[0], { type: "tool_result", tool_use_id: "image-call",
      content: [{ type: "text", text: "스크린샷" }, pathBlock, wireImage] });
    return Response.json({ type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "확인" }] });
  });
  const original = messages();
  const snapshot = structuredClone(original);
  const adapter = createAnthropicMessagesAdapter(config);
  await adapter.generate({ system: "", messages: original, tools: [] });
  await adapter.generate({ system: "", messages: JSON.parse(JSON.stringify(original)), tools: [] });
  assert.deepEqual(original, snapshot);
});

test("여러 이미지의 경로는 각각 바로 앞에 붙고 특수문자는 경로 문자열로 표시한다", () => {
  const other = { ...image, path: '/tmp/a "quoted"\nname.png' };
  const blocks = [{ type: "text" as const, text: "두 화면 비교" }, image, other];
  const snapshot = structuredClone(blocks);
  const output = withImagePaths(blocks);
  assert.equal(output.length, 5);
  assert.deepEqual(output[0], blocks[0]);
  assert.deepEqual(output[1], { type: "text", text: pathText });
  assert.deepEqual(output[2], image);
  assert.ok(output[3].type === "text");
  assert.ok(output[3].text.includes(JSON.stringify(other.path)));
  assert.deepEqual(output[4], other);
  assert.deepEqual(blocks, snapshot);
});

test("미지원 연결은 첨부와 툴 이미지 모두 네트워크 요청 전에 거절한다", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("전송하면 안 됨"); });
  const adapters = [createResponsesAdapter({ ...config, supportsImages: false }),
    createAnthropicMessagesAdapter({ ...config, supportsImages: false }), createChatCompletionsAdapter(config)];
  for (const adapter of adapters) {
    for (const content of [messages().slice(0, 1), messages().slice(1)]) {
      await assert.rejects(adapter.generate({ system: "", messages: content, tools: [] }), /이미지 입력이 비활성화/);
    }
  }
  assert.throws(() => checkImageInput([{ role: "user", content: [
    { ...image, data: "A".repeat(12 * 1024 * 1024) },
  ] }], true), /8 MiB/);
});

test("이미지는 문자열 자르기·문자 수 계산에서 보호되고 처음 보기 전에는 자동 압축하지 않는다", () => {
  const session = { messages: messages() };
  const original = structuredClone(session.messages);
  const before = contextSize(session);
  const enlarged = structuredClone(session);
  for (const block of imagesOf(enlarged.messages)) block.data += "A".repeat(100_000);
  assert.equal(contextSize(enlarged), before);
  assert.equal(shouldCompact(session, 0), false);
  session.messages.push({ role: "assistant", content: [{ type: "text", text: "확인했다" }] });
  assert.equal(shouldCompact(session, 0), true);
  const tool = session.messages[2];
  assert.ok(tool.role === "tool" && Array.isArray(tool.content[0].content));
  tool.content[0].content.unshift({ type: "text", text: "x".repeat(9000) });
  assert.equal(pruneToolResults(session), 1);
  assert.equal(imagesOf(session.messages)[1].data, image.data);
  assert.equal(imagesOf(original)[1].data, image.data);
});

test("요약 요청은 JSON의 이미지 번호와 실제 이미지 블록을 함께 보낸다", async () => {
  const conversation = messages();
  const original = structuredClone(conversation);
  const adapter: LLMAdapter = { supportsImages: true,
    // 요약기의 실제 요청을 검사하고 네트워크 없이 짧은 요약을 돌려준다.
    async generate(request) {
      assert.deepEqual(request.tools, []);
      assert.deepEqual(imagesOf(request.messages), [image, image]);
      const text = request.messages[0].content[0];
      assert.ok(text.type === "text");
      assert.doesNotMatch(text.text, /base64/);
      assert.ok(!text.text.includes(image.data));
      assert.match(text.text, /imageNumber/);
      return { stopReason: "stop", message: { role: "assistant", content: [{ type: "text", text: "빨간 화면을 확인했다." }] } };
    },
  };
  await compactSession({ messages: conversation }, (items) => summarize(adapter, items));
  assert.deepEqual(conversation, original);
  assert.deepEqual(summaryContent(conversation).filter((block) => block.type === "image"), [image, image]);
  assert.equal(recordLLM(adapter, { async append() {}, async flush() {} }, { sessionId: "test" }, "step").supportsImages, true);
});

test("세션 저장·resume는 이미지 바이트를 보존하며 원본 파일에 다시 의존하지 않는다", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-image-resume-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const session = { id: "image-test", workspaceDirectory: directory, system: "지침", messages: messages() };
  const paths = createHarnessPaths(directory, directory);
  await saveSession(session, paths);
  assert.deepEqual(await loadSession(session.id, paths), session);
});
