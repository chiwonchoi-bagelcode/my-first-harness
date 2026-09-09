// 단계 0 검증용 픽스처다. Playwright MCP의 --init-page로 MCP 프로세스 안에서 require되어 실행된다.
// 탭이 생길 때마다 호출되어 page 객체를 보관하고, 로컬 HTTP로 clock·키·스크린샷 명령을 받는다.
// MCP 툴의 settle 대기를 거치지 않으므로 시계가 정지된 탭에서도 멈추지 않는다. 플러그인 구현이 아니다.
const http = require("node:http");
const fs = require("node:fs");

const pages = [];
let server;

// 명령 URL을 실제 Playwright 호출로 옮기고 결과 객체를 만든다. i는 컨트롤러가 본 탭 순서다.
async function handle(url) {
  const index = Number(url.searchParams.get("i") ?? 0);
  const page = pages[index];
  if (!page) throw new Error(`탭 인덱스 ${index}가 없습니다.`);
  switch (url.pathname) {
    case "/tabs":
      return { tabs: await Promise.all(pages.map(async (p, i) => ({ i, url: p.url(), closed: p.isClosed(),
        visibility: p.isClosed() ? null : await p.evaluate(() => document.visibilityState).catch(() => null) }))) };
    case "/install": {
      // Clock은 게임 코드가 타이머를 잡기 전에 설치해야 하므로 설치 뒤 통제된 reload로 시작한다.
      const time = Number(url.searchParams.get("time"));
      await page.clock.install({ time });
      await page.reload();
      await page.clock.pauseAt(time + Number(url.searchParams.get("pauseAfter") ?? 5000));
      return { ok: true, url: page.url() };
    }
    case "/runFor": await page.clock.runFor(Number(url.searchParams.get("ms"))); return { ok: true };
    case "/resume": await page.clock.resume(); return { ok: true };
    case "/pauseAt": await page.clock.pauseAt(Number(url.searchParams.get("time"))); return { ok: true };
    case "/state": return { state: await page.evaluate(() => window.__state), now: await page.evaluate(() => Date.now()) };
    case "/keydown": await page.keyboard.down(url.searchParams.get("key")); return { ok: true };
    case "/keyup": await page.keyboard.up(url.searchParams.get("key")); return { ok: true };
    case "/screenshot": {
      const png = await page.screenshot({ type: "png" });
      return { base64: png.toString("base64"), bytes: png.length };
    }
    default: throw new Error(`알 수 없는 명령: ${url.pathname}`);
  }
}

// 탭마다 호출된다. 첫 호출에서 서버를 열고 포트를 GAME_CTRL_PORT_FILE에 기록하며, 이후 탭은 목록에만 추가한다.
module.exports.default = async ({ page }) => {
  pages.push(page);
  if (server) return;
  server = http.createServer(async (request, response) => {
    try {
      const body = await handle(new URL(request.url, "http://127.0.0.1"));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(process.env.GAME_CTRL_PORT_FILE, String(server.address().port));
};
