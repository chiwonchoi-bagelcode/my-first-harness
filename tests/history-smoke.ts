import "dotenv/config";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarnessPaths } from "../harness-paths.ts";
import { ExecutionHistory } from "../execution-history.ts";
import { recordLLM } from "../recorded-llm.ts";
import { createModelAdapter } from "../model-config.ts";

// 실제 API에 모델별 한 번만 요청해 임시 JSONL의 사용량 기록을 확인한다.
async function main() {
  const token = process.env.AIPROXY_TOKEN;
  assert.ok(token, ".env의 AIPROXY_TOKEN을 설정하세요.");
  const directory = await mkdtemp(join(tmpdir(), "harness-history-smoke-"));
  const paths = createHarnessPaths(directory, directory);
  const history = new ExecutionHistory(paths, [token]);
  try {
    for (const model of ["luna", "haiku"]) {
      const scope = { sessionId: `smoke-${model}`, turnId: "smoke-turn", step: 1 };
      const adapter = recordLLM(createModelAdapter(model, token), history, scope, "step");
      const result = await adapter.generate({ system: "Keep the response short.",
        messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly pong." }] }],
        tools: [], maxOutputTokens: 256,
      });
      await history.flush();
      const text = await readFile(join(paths.sessionDirectory, `${scope.sessionId}.jsonl`), "utf8");
      const events = text.trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(events.length, 4);
      const received = events.find((event) => event.type === "model-response").response;
      assert.equal(received.status, 200);
      assert.ok(received.body.usage);
      assert.deepEqual(received.usage, result.usage);
      assert.ok(result.usage?.inputTokens !== undefined);
      assert.ok(result.usage?.outputTokens !== undefined);
      assert.ok(!text.includes(token));
      assert.equal(events.at(-1).stopReason, result.stopReason);
      // 응답 본문·인증 값 대신 이번 합성 요청의 사용량과 종료 이유만 출력한다.
      console.log(JSON.stringify({ model, stopReason: result.stopReason, usage: result.usage, events: events.length }));
    }
  } finally {
    // 이 스모크 테스트가 생성한 임시 기록만 정리한다.
    await rm(directory, { recursive: true, force: true });
  }
}

await main();
