import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { ExecutionHistory } from "../execution-history.ts";
import { createHarnessPaths } from "../harness-paths.ts";
import { recordLLM } from "../recorded-llm.ts";
import { omitImageData } from "../adapters/wire-log.ts";
import { createResponsesAdapter } from "../adapters/responses.ts";
import { createAnthropicMessagesAdapter } from "../adapters/anthropic-messages.ts";
import { imageFromBytes } from "../image-content.ts";
import type { LLMRequest } from "../llm-types.ts";
import { solidPng } from "./image-fixture.ts";

// 임시 프로젝트에 JSONL을 만들고 파일을 직접 파싱해 돌려주는 검증 환경.
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "harness-request-size-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = createHarnessPaths(directory, directory);
  const scope = { sessionId: "size-session", turnId: "turn", step: 1 };
  const history = new ExecutionHistory(paths);
  const logPath = join(paths.sessionDirectory, `${scope.sessionId}.jsonl`);
  const events = async (): Promise<any[]> => (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return { scope, history, logPath, events };
}

// 사용자 첨부 한 장과 툴 결과 한 장이 들어간 요청을 만든다.
async function imageRequest() {
  const image = await imageFromBytes(solidPng([0, 128, 255]), "/tmp/shot.png");
  const request: LLMRequest = {
    system: "시스템 지침", tools: [{ name: "screenshot", description: "화면", parameters: { type: "object", properties: {} } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "이 화면을 봐" }, image] },
      { role: "assistant", content: [{ type: "tool-call", id: "call-1", name: "screenshot", arguments: "{}" }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "찍음" }, image] }] },
    ],
  };
  return { image, request };
}

test("omitImageData는 Responses·Anthropic 본문의 이미지 바이트만 설명으로 바꾸고 원본은 수정하지 않는다", () => {
  const base64 = Buffer.from("png-bytes").toString("base64");
  const sha256 = createHash("sha256").update("png-bytes").digest("hex");
  const responses = { input: [
    { role: "user", content: [{ type: "input_text", text: "a" }, { type: "input_image", image_url: `data:image/png;base64,${base64}`, detail: "auto" }] },
    { type: "function_call_output", call_id: "c", output: [{ type: "input_image", image_url: `data:image/webp;base64,${base64}`, detail: "auto" }] },
    { role: "user", content: [{ type: "input_image", image_url: "https://example.invalid/remote.png", detail: "auto" }] },
  ] };
  const snapshot = structuredClone(responses);
  const logged = omitImageData("responses", responses);
  assert.equal(logged.imageDataOmitted, 2);
  assert.deepEqual(responses, snapshot);
  const body = logged.body as any;
  assert.equal(body.input[0].content[1].image_url, `[image data omitted from log: image/png, 9 bytes, sha256 ${sha256}]`);
  assert.match(String(body.input[1].output[0].image_url), /^\[image data omitted from log: image\/webp, 9 bytes, sha256 /);
  assert.equal(body.input[2].content[0].image_url, "https://example.invalid/remote.png");
  assert.equal(body.input[0].content[0].text, "a");

  const anthropic = { messages: [
    { role: "user", content: [{ type: "text", text: "a" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: base64 } }] }] },
  ] };
  const loggedAnthropic = omitImageData("anthropic-messages", anthropic);
  assert.equal(loggedAnthropic.imageDataOmitted, 2);
  const wire = loggedAnthropic.body as any;
  assert.equal((wire.messages[0].content[1] as any).source.data, `[image data omitted from log: image/jpeg, 9 bytes, sha256 ${sha256}]`);
  assert.equal((wire.messages[0].content[1] as any).source.media_type, "image/jpeg");
  assert.equal((anthropic.messages[0].content[1] as any).source.data, base64);

  const chat = { messages: [{ role: "user", content: `data:image/png;base64,${base64}` }] };
  assert.deepEqual(omitImageData("chat-completions", chat), { body: chat, imageDataOmitted: 0 });
});

for (const api of ["responses", "anthropic-messages"] as const) {
  test(`${api}: 모델에는 이미지 바이트를 보내지만 JSONL의 요청 기록에는 남기지 않는다`, async (t) => {
    const f = await fixture(t);
    const { image, request } = await imageRequest();
    const config = { provider: "test", model: "test-model", baseURL: "https://example.invalid/v1", apiKey: "test", supportsImages: true };
    const adapter = api === "responses" ? createResponsesAdapter(config) : createAnthropicMessagesAdapter(config);
    let sent = "";
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      sent = String(init?.body);
      return Response.json(api === "responses"
        ? { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "확인" }] }] }
        : { type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "확인" }] });
    });
    await recordLLM(adapter, f.history, f.scope, "step").generate(request);
    // 실제 전송에는 두 장의 바이트가 그대로 들어간다.
    assert.equal(sent.split(image.data).length - 1, 2);
    const log = await readFile(f.logPath, "utf8");
    assert.ok(!log.includes(image.data), "JSONL에 이미지 base64가 남아 있음");
    const events = await f.events();
    assert.deepEqual(events.map((event) => event.type), ["model-start", "model-request", "model-response", "model-end"]);
    assert.deepEqual(events[0].request, {
      systemChars: 6, messageCount: 3, imageCount: 2, toolNames: ["screenshot"], estimatedTokens: events[0].request.estimatedTokens,
    });
    assert.ok(events[0].request.estimatedTokens > 2 * 256, "이미지 시각 토큰이 추정에 포함돼야 함");
    assert.equal(events[1].request.imageDataOmitted, 2);
    const serialized = JSON.stringify(events[1].request.body);
    // 기록된 본문은 바이트를 설명으로 바꿨으므로 실제 전송 본문보다 작다.
    assert.ok(serialized.length < sent.length, `기록 ${serialized.length}자 ≥ 전송 ${sent.length}자`);
    assert.equal(serialized.split("[image data omitted from log: image/png, ").length - 1, 2);
    const sha256 = createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex");
    assert.match(serialized, new RegExp(sha256));
    // 이미지 앞의 경로 안내 텍스트는 그대로 남아 어떤 이미지였는지 알 수 있다.
    assert.match(serialized, /\/tmp\/shot\.png/);
  });
}

test("이미지가 없는 요청의 기록 본문은 실제 전송 본문과 같고 생략 수를 표시하지 않는다", async (t) => {
  const f = await fixture(t);
  let sent: unknown;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return Response.json({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] });
  });
  const adapter = createResponsesAdapter({ provider: "test", model: "test-model", baseURL: "https://example.invalid/v1", apiKey: "test" });
  await recordLLM(adapter, f.history, f.scope, "step").generate({ system: "s", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [], maxOutputTokens: 512 });
  const events = await f.events();
  assert.deepEqual(events[1].request.body, sent);
  assert.equal("imageDataOmitted" in events[1].request, false);
  assert.deepEqual(events[0].request, { systemChars: 1, messageCount: 1, imageCount: 0, toolNames: [], estimatedTokens: events[0].request.estimatedTokens, maxOutputTokens: 512 });
});
