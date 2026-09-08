import "dotenv/config";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelAdapter } from "../model-config.ts";
import { loadImage } from "../image-content.ts";
import { registerFilesystemTools } from "../tools/filesystem.ts";
import { textOf } from "../llm-types.ts";
import type { LLMRequest } from "../llm-types.ts";
import { solidPng } from "./image-fixture.ts";

// 개인 파일 없이 두 단색 PNG를 생성해 사용자 첨부와 이미지 툴 결과를 실제 API로 확인한다.
async function main() {
  const choice = process.argv[2] ?? "farm";
  const key = choice === "farm" ? process.env.BCF_API_KEY : process.env.AIPROXY_TOKEN;
  assert.ok(key, "선택한 연결의 API 키가 필요합니다.");
  const adapter = createModelAdapter(choice, key);
  const directory = await mkdtemp(join(tmpdir(), "harness-image-smoke-"));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  // 연결 대기를 제한하고 인증 값이나 이미지 원문은 출력하지 않는다.
  globalThis.fetch = async (url, init) => {
    const response = await originalFetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    console.log(`[image smoke] request ${++requests}: HTTP ${response.status}`);
    return response;
  };
  try {
    const colors: { name: string; rgb: [number, number, number] }[] = [
      { name: "red", rgb: [255, 0, 0] }, { name: "blue", rgb: [0, 0, 255] },
      { name: "green", rgb: [0, 180, 0] }, { name: "yellow", rgb: [255, 255, 0] },
    ];
    const firstIndex = randomInt(colors.length);
    const firstColor = colors[firstIndex];
    const secondColor = colors[(firstIndex + 1) % colors.length];
    const firstPath = join(directory, "first.png");
    const secondPath = join(directory, "second.png");
    await writeFile(firstPath, solidPng(firstColor.rgb));
    await writeFile(secondPath, solidPng(secondColor.rgb));
    const request: LLMRequest = { system: "Follow the user's request. Keep answers short.", tools: [], messages: [
      { role: "user", content: [{ type: "text", text: "What is the dominant color in this image? Reply with one English color word." }, await loadImage(firstPath)] },
    ] };
    const first = await adapter.generate(request);
    assert.equal(first.stopReason, "stop");
    assert.ok(textOf(first.message).toLowerCase().includes(firstColor.name), "첨부 이미지 색상 확인 실패");
    console.log("PASS: 사용자 이미지 첨부");
    const tools: any[] = [];
    registerFilesystemTools({ register(tool: any) { tools.push(tool); } }, true);
    const tool = tools.find((entry) => entry.name === "readImage");
    request.tools = [{ name: tool.name, description: tool.description, parameters: tool.parameters }];
    request.messages.push(first.message, { role: "user", content: [{ type: "text", text:
      `Use readImage to open ${secondPath}. Then tell me its dominant color in one English word. This is a different image.` }] });
    const second = await adapter.generate(request);
    assert.equal(second.stopReason, "tool-calls");
    const calls = second.message.content.filter((block) => block.type === "tool-call");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "readImage");
    const args = JSON.parse(calls[0].arguments);
    assert.equal(args.path, secondPath);
    request.messages.push(second.message, { role: "tool", content: [
      { type: "tool-result", toolCallId: calls[0].id, content: await tool.execute(args) },
    ] });
    // 저장·resume와 같은 JSON 왕복 뒤에도 이미지와 reasoning이 유지돼야 한다.
    request.messages = JSON.parse(JSON.stringify(request.messages));
    const third = await adapter.generate(request);
    assert.equal(third.stopReason, "stop");
    assert.ok(textOf(third.message).toLowerCase().includes(secondColor.name), "툴 결과 이미지 색상 확인 실패");
    console.log(`PASS: readImage → 이미지 툴 결과 → 후속 답변 (${requests} HTTP 요청)`);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
}

// 실패 메시지에서도 두 연결의 키를 제거한다.
await main().catch((error) => {
  let message = error instanceof Error ? error.message : String(error);
  for (const key of [process.env.BCF_API_KEY, process.env.AIPROXY_TOKEN]) if (key) message = message.replaceAll(key, "[REDACTED]");
  console.error(message);
  process.exitCode = 1;
});
