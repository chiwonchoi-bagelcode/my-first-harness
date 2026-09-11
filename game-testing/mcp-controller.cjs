// Playwright MCP의 --init-page 훅으로 MCP 프로세스 안에서 require되어 실행되는 게임 테스트 컨트롤러다.
// 탭이 생길 때마다 호출되어 page 객체를 보관하고, 하네스(game-testing/bridge.ts)의 명령을 127.0.0.1 HTTP로 받아
// 같은 프로세스의 Playwright API를 직접 호출한다. MCP 툴의 settle 대기를 거치지 않아 시계가 정지된 탭에서도 멈추지 않는다.
// 연결 정보(포트·토큰)는 MCP 실행 인자의 --output-dir 아래 game-testing.json에 기록한다. 자산 복사는 package.json build가 담당한다.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const pages = [];
const installedContexts = new WeakSet();
const token = crypto.randomBytes(16).toString("hex");
let server;
let infoFile;

// MCP 실행 인자에서 --output-dir 값을 찾아 연결 정보 파일 경로를 만든다.
function resolveInfoFile() {
  const index = process.argv.indexOf("--output-dir");
  const directory = index >= 0 ? process.argv[index + 1] : undefined;
  if (!directory) throw new Error("--output-dir 인자가 없어 game-testing 연결 정보를 기록할 수 없습니다.");
  return path.join(directory, "game-testing.json");
}

// 요청 본문(JSON)을 끝까지 읽어 객체로 만든다.
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (error) { reject(new Error(`요청 본문이 JSON이 아닙니다: ${error.message}`)); }
    });
    request.on("error", reject);
  });
}

// 명령 하나를 실제 Playwright 호출로 옮기고 결과 객체를 만든다. tab은 이 컨트롤러가 본 탭 순서다.
async function handle(body) {
  if (body.command === "tabs") {
    return { tabs: pages.map((page, tab) => ({ tab, url: page.isClosed() ? "" : page.url(), closed: page.isClosed() })) };
  }
  const page = pages[body.tab];
  if (!page) throw new Error(`탭 ${body.tab}이 없습니다.`);
  if (page.isClosed()) throw new Error(`탭 ${body.tab}은 이미 닫혔습니다.`);
  switch (body.command) {
    case "install": {
      // Clock은 게임 코드가 타이머를 잡기 전에 있어야 하므로 설치 뒤 통제된 reload로 시작한다.
      // Clock은 브라우저 컨텍스트 단위이고 두 번 설치할 수 없어 같은 컨텍스트에서는 reload·정지만 반복한다.
      const context = page.context();
      const installed = installedContexts.has(context);
      if (!installed) {
        await page.clock.install({ time: body.time });
        installedContexts.add(context);
      }
      await page.reload();
      // 로드 중 흐른 가상 시간 바로 뒤에서 멈춰 게임이 정상 속도로 도는 구간을 최소화한다.
      const now = await page.evaluate(() => Date.now());
      const pausedAt = now + 200;
      await page.clock.pauseAt(pausedAt);
      return { url: page.url(), pausedAt, freshInstall: !installed };
    }
    case "runFor": await page.clock.runFor(body.ms); return { ok: true };
    case "resume": await page.clock.resume(); return { ok: true };
    case "keydown": await page.keyboard.down(body.key); return { ok: true };
    case "keyup": await page.keyboard.up(body.key); return { ok: true };
    case "screenshot": {
      const png = await page.screenshot({ type: "png" });
      return { base64: png.toString("base64") };
    }
    case "state": {
      // 게임이 협력 계약(window.__gameTest.getState)을 두었으면 그 결과를 JSON 문자열로 돌려준다. 계약이 없거나 함수가 실패한 것은
      // 컨트롤러 장애가 아니라 게임 쪽 사정이므로 ok=false로 보고한다. page.evaluate는 페이지 타이머와 무관한 CDP 호출이라 시계가 정지된 탭에서도 돌아온다.
      const result = await page.evaluate(() => {
        const api = globalThis.__gameTest;
        if (!api || typeof api.getState !== "function") return { ok: false, reason: "missing" };
        try {
          const state = api.getState();
          return { ok: true, json: JSON.stringify(state === undefined ? null : state),
            controls: api.controls === undefined ? undefined : JSON.stringify(api.controls) };
        } catch (error) {
          return { ok: false, reason: "error", message: error instanceof Error ? error.message : String(error) };
        }
      });
      if (result.ok && result.json.length > 65_536) {
        return { ok: false, reason: "too-large", message: `getState() 결과가 ${result.json.length}자입니다. 플레이어가 화면에서 보는 것만 담아 65,536자 이하로 줄이세요.` };
      }
      return result;
    }
    default: throw new Error(`알 수 없는 명령: ${body.command}`);
  }
}

// 토큰을 확인한 요청만 처리하고 결과·오류를 JSON으로 돌려준다.
async function serve(request, response) {
  const send = (status, payload) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload));
  };
  if (request.headers["x-game-testing-token"] !== token) return send(401, { error: "토큰이 일치하지 않습니다. 연결 정보 파일이 오래되었을 수 있습니다." });
  try { send(200, await handle(await readBody(request))); }
  catch (error) { send(500, { error: error instanceof Error ? error.message : String(error) }); }
}

// 연결 정보를 임시 파일에 쓴 뒤 교체하고, 프로세스 종료 시 지운다.
function writeInfo(port) {
  const temporary = `${infoFile}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(infoFile), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 });
  fs.renameSync(temporary, infoFile);
  process.on("exit", () => { try { fs.unlinkSync(infoFile); } catch {} });
}

// 탭마다 호출된다. 첫 호출에서 서버를 열고 연결 정보를 기록하며, 이후 탭은 목록에만 추가한다.
module.exports.default = async ({ page }) => {
  pages.push(page);
  if (server) return;
  infoFile = resolveInfoFile();
  server = http.createServer((request, response) => { void serve(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  writeInfo(server.address().port);
};
