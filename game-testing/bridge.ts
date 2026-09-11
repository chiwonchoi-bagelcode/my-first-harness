import { readFile } from "node:fs/promises";
import { join } from "node:path";

// 컨트롤러가 본 탭 하나의 순서·URL·닫힘 여부다.
export type TabInfo = { tab: number; url: string; closed: boolean };

// 게임 상태 계약(window.__gameTest.getState)을 읽은 결과다. ok=false는 컨트롤러 장애가 아니라 게임 쪽 사정이다:
// missing = 계약 없음, error = getState()가 예외, too-large = 결과가 한도 초과.
export type GameStateResult =
  | { ok: true; state: unknown; controls?: unknown }
  | { ok: false; reason: "missing" | "error" | "too-large"; message?: string };

// 하네스가 MCP 프로세스 안의 컨트롤러(game-testing/mcp-controller.cjs)에 보낼 수 있는 명령 집합이다.
export interface GameBridge {
  tabs(): Promise<TabInfo[]>;
  // Clock 설치(컨텍스트에 처음이면) → reload → 정지. 정지한 가상 시각과 첫 설치 여부를 돌려준다.
  install(tab: number, time: number): Promise<{ url: string; pausedAt: number; freshInstall: boolean }>;
  runFor(tab: number, ms: number): Promise<void>;
  resume(tab: number): Promise<void>;
  keyDown(tab: number, key: string): Promise<void>;
  keyUp(tab: number, key: string): Promise<void>;
  screenshot(tab: number): Promise<Buffer>;
  // 게임이 내놓는 상태 계약을 읽는다. 하네스는 그 내용의 모양을 모르고 그대로 전달한다.
  state(tab: number): Promise<GameStateResult>;
}

// 컨트롤러가 연결 정보를 기록하는 파일이다. mcp-controller.cjs의 resolveInfoFile과 같은 규칙이다.
export function controllerInfoPath(playwrightOutputDirectory: string) {
  return join(playwrightOutputDirectory, "game-testing.json");
}

// 연결 정보 파일을 매 호출마다 읽어 컨트롤러에 명령을 보낸다. MCP가 재시작되면 파일도 새로 쓰이므로 캐시하지 않는다.
export function createBridge(infoFile: string): GameBridge {
  async function send<T>(body: Record<string, unknown>): Promise<T> {
    let info: { port: number; token: string };
    try { info = JSON.parse(await readFile(infoFile, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("게임 테스트 컨트롤러가 아직 없습니다. Playwright MCP가 켜져 있는지 확인하고 browser_navigate로 게임 페이지를 먼저 열어 주세요.");
      }
      throw error;
    }
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${info.port}/`, {
        method: "POST", headers: { "content-type": "application/json", "x-game-testing-token": info.token }, body: JSON.stringify(body),
      });
    } catch {
      throw new Error("게임 테스트 컨트롤러에 연결할 수 없습니다. Playwright MCP가 재시작되었으면 browser_navigate로 게임 페이지를 다시 열어 주세요.");
    }
    const payload = await response.json() as T & { error?: string };
    if (!response.ok || payload.error) throw new Error(`컨트롤러 오류: ${payload.error ?? `HTTP ${response.status}`}`);
    return payload;
  }
  return {
    async tabs() { return (await send<{ tabs: TabInfo[] }>({ command: "tabs" })).tabs; },
    install(tab, time) { return send({ command: "install", tab, time }); },
    async runFor(tab, ms) { await send({ command: "runFor", tab, ms }); },
    async resume(tab) { await send({ command: "resume", tab }); },
    async keyDown(tab, key) { await send({ command: "keydown", tab, key }); },
    async keyUp(tab, key) { await send({ command: "keyup", tab, key }); },
    async screenshot(tab) { return Buffer.from((await send<{ base64: string }>({ command: "screenshot", tab })).base64, "base64"); },
    async state(tab) {
      const payload = await send<{ ok: boolean; json?: string; controls?: string; reason?: "missing" | "error" | "too-large"; message?: string }>({ command: "state", tab });
      if (!payload.ok) return { ok: false, reason: payload.reason ?? "error", ...(payload.message ? { message: payload.message } : {}) };
      return { ok: true, state: JSON.parse(payload.json ?? "null"), ...(payload.controls !== undefined ? { controls: JSON.parse(payload.controls) } : {}) };
    },
  };
}
