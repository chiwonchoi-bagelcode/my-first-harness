import "dotenv/config";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarnessPaths } from "../harness-paths.ts";
import { createMcpServerConfigs } from "../mcp-servers.ts";
import { connectMcpServers, closeMcpServers } from "../mcp-client.ts";
import { ToolManager } from "../tool-manager.ts";
import { createAgent } from "../agent.ts";
import { createSession } from "../session.ts";
import { SkillManager } from "../skill-manager.ts";
import { ExecutionHistory } from "../execution-history.ts";
import { createModelAdapter } from "../model-config.ts";
import { imagesOf } from "../image-content.ts";

// 실제 브라우저·MCP를 검증한다. --model farm을 붙이면 실제 Agent와 유료 API도 사용한다.
async function main() {
  const model = process.argv[2] === "--model" ? process.argv[3] : undefined;
  assert.ok(process.argv.length === 2 || model, "사용법: pnpm test:playwright [--model farm|luna|haiku]");
  const token = model === "farm" ? process.env.BCF_API_KEY : process.env.AIPROXY_TOKEN;
  if (model) assert.ok(token, `${model} 모델의 API 키를 .env에 설정하세요.`);

  const directory = await mkdtemp(join(tmpdir(), "harness-playwright-smoke-"));
  const paths = createHarnessPaths(directory, join(directory, "home"));
  const manager = new ToolManager();
  let value = 40;
  const color = ["red", "blue", "green", "yellow"][randomInt(4)];
  // 외부 사이트 대신 테스트 전용 버튼과 서버가 확인할 수 있는 증가 결과를 제공한다.
  const server = createServer((request, response) => {
    if (request.url === "/increment" && request.method === "POST") {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end(String(++value));
    } else if (request.url === "/visual") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      // 접근성 스냅샷에 색상 답이 없는 canvas를 사용해 실제 이미지 입력을 검증한다.
      response.end(`<!doctype html><title>Visual test</title><canvas width="500" height="400"></canvas>
        <script>const ctx = document.querySelector('canvas').getContext('2d');
        ctx.fillStyle = ${JSON.stringify(color)}; ctx.fillRect(30, 30, 350, 300);</script>`);
    } else if (request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html lang="en"><title>MCP counter test</title>
        <h1>Browser counter</h1><p id="value">Counter value: ${value}</p>
        <button id="increase">Increase</button><script>
        document.querySelector('#increase').onclick = async () => {
          const result = await fetch('/increment', { method: 'POST' });
          document.querySelector('#value').textContent = 'Counter value: ' + await result.text();
        };
        </script></html>`);
    } else { response.writeHead(404); response.end(); }
  });
  let clients: Awaited<ReturnType<typeof connectMcpServers>> = [];
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/`;
    const configs = (await createMcpServerConfigs(paths)).filter((config) => config.name === "playwright");
    assert.equal(configs.length, 1, "Playwright MCP 패키지와 등록 설정이 필요합니다.");
    // CI와 수동 테스트 모두 사용자 화면을 점유하지 않고 같은 서버 설정으로 실행한다.
    assert.equal(configs[0].transport, "stdio");
    if (configs[0].transport === "stdio") configs[0].args.push("--headless");
    clients = await connectMcpServers(manager, configs);
    assert.equal(clients.length, 1, "Playwright MCP 연결 실패");

    // 실제 ToolManager의 인자 검증·MCP 호출을 통과한 텍스트 결과만 받는다.
    async function execute(name: string, args: Record<string, unknown>) {
      const result = await manager.execute(`mcp__playwright__${name}`, JSON.stringify(args));
      assert.ok(!result.isError, String(result.content));
      return String(result.content);
    }

    await execute("browser_navigate", { url });
    const before = await execute("browser_snapshot", {});
    assert.match(before, /Counter value: 40/);
    const ref = /button "Increase" \[ref=([^\]]+)\]/.exec(before)?.[1];
    assert.ok(ref, "페이지 스냅샷에 Increase 버튼 참조가 있어야 합니다.");
    // 0.0.80의 target 인자에 현재 스냅샷에서 받은 요소 참조를 전달한다.
    await execute("browser_click", { element: "Increase button", target: ref });
    assert.match(await execute("browser_snapshot", {}), /Counter value: 41/);
    assert.equal(value, 41);
    console.log("[PASS] 실제 MCP + 브라우저: 페이지 열기 → 구조 읽기 → 클릭 → 40에서 41로 변경 확인");
    const screenshot = await manager.execute("mcp__playwright__browser_take_screenshot", '{"type":"png","scale":"css"}');
    assert.ok(!screenshot.isError, String(screenshot.content));
    assert.ok(Array.isArray(screenshot.content));
    assert.ok(screenshot.content.some((block) => block.type === "image" && block.width > 0 && block.height > 0));
    console.log("[PASS] 실제 MCP 스크린샷 → 공통 이미지 블록 변환");

    if (model) {
      const adapter = createModelAdapter(model, token);
      let calls = 0;
      const history = new ExecutionHistory(paths, [token!]);
      const session = createSession(paths.workspaceDirectory);
      const agent = createAgent({
        // 테스트 비용을 제한한다. 실제 Agent의 툴 선택·실행 루프는 그대로 사용한다.
        adapter: { ...adapter, async generate(request, observer) {
          assert.ok(++calls <= 10, "모델 호출 10회 초과: 스모크 테스트 중단");
          return adapter.generate(request, observer);
        } },
        toolManager: manager, skillManager: new SkillManager(), history, paths,
        // 테스트 페이지의 도구 호출만 표시하며 인증 정보나 이미지 데이터는 출력하지 않는다.
        onEvent(event) { if (event.type === "tool-start") console.log(`[tool] ${event.name} ${event.arguments}`); },
      });
      const answer = await agent.turn(session,
        `Open ${url} in the browser. Click the Increase button exactly twice using the browser click tool, `
        + "then read the displayed counter value and report it. Do not change page code or call the HTTP endpoint directly.");
      await history.flush();
      assert.equal(value, 43, "모델이 실제 버튼을 두 번 클릭해야 합니다.");
      assert.match(answer, /43/, "최종 답변에 실제 표시된 값이 있어야 합니다.");
      const events = (await readFile(join(paths.sessionDirectory, `${session.id}.jsonl`), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(events.filter((event) => event.type === "tool-start" && event.name === "mcp__playwright__browser_click").length, 2);
      assert.ok(events.some((event) => event.type === "tool-end" && String(event.result.content).includes("Counter value: 43")));
      console.log(`[PASS] 실제 ${model} + Agent: ${calls}회 모델 호출, 버튼 2회 클릭, 화면 값 43 확인`);
      console.log(answer);
      calls = 0;
      const visualSession = createSession(paths.workspaceDirectory);
      const visualAnswer = await agent.turn(visualSession,
        `Open ${url}visual and take a PNG screenshot with the screenshot tool, omitting filename so it returns inline image data. `
        + "Look at the image and name the large rectangle's color in one English word. "
        + "Do not inspect source code, evaluate JavaScript, or read files to determine the color.");
      await history.flush();
      if (imagesOf(visualSession.messages).length === 0) {
        for (const message of visualSession.messages) {
          if (message.role === "tool") console.log("[diagnostic]", JSON.stringify(message.content).slice(0, 2000));
        }
        console.log("[diagnostic]", visualAnswer);
      }
      assert.ok(imagesOf(visualSession.messages).length > 0, "Agent의 툴 결과에 실제 이미지가 있어야 합니다.");
      assert.ok(visualAnswer.toLowerCase().includes(color), "모델이 이미지의 실제 색상을 읽어야 합니다.");
      const visualEvents = (await readFile(join(paths.sessionDirectory, `${visualSession.id}.jsonl`), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line));
      assert.ok(visualEvents.some((event) => event.type === "tool-start" && event.name === "mcp__playwright__browser_take_screenshot"));
      assert.ok(!visualEvents.some((event) => event.type === "tool-start" && /evaluate|run_code/.test(event.name)));
      console.log(`[PASS] 실제 ${model} + Agent: MCP 이미지 수신 후 색상 ${color} 확인 (${calls}회 모델 호출)`);
      console.log(visualAnswer);
    }
  } finally {
    await closeMcpServers(clients);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // 이번 테스트의 임시 페이지 출력·세션 기록만 제거하고 사용자 데이터는 유지한다.
    await rm(directory, { recursive: true, force: true });
  }
}

await main();
