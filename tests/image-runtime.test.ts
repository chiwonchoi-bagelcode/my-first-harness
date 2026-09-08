import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { solidPng } from "./image-fixture.ts";

// 실제 CLI 명령 루프만 실행해 사용자 설정·API·MCP를 건드리지 않는다.
const source = await readFile(new URL("../my-first-harness.ts", import.meta.url), "utf8");
const runtimeSource = stripTypeScriptTypes(source.slice(source.indexOf("let session = createSession();")));

// 읽기 프롬프트가 돌아올 때까지 기다리되 실패한 자식 때문에 무한 대기하지 않는다.
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("이미지 CLI 테스트 대기 시간 초과");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("CLI attach는 여러 장·공백 경로·실패 복구·한 번 소비·new/resume 초기화를 처리한다", { timeout: 15_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-image-cli-"));
  const file = join(directory, "space name.png");
  await writeFile(file, solidPng());
  const root = new URL("..", import.meta.url);
  const script = `
    import { createInterface } from 'node:readline/promises';
    import { attachmentPath, checkImageInput, loadImage } from ${JSON.stringify(new URL("image-content.ts", root).href)};
    const adapter = { supportsImages: true };
    const history = { append: async () => {}, flush: async () => {} };
    const paths = {};
    const shellJobs = { dispose: async () => {} };
    const mcpClients = [];
    const closeMcpServers = async () => {};
    const saveSession = async () => {};
    const compactAndSave = async () => {};
    const loadSession = async () => createSession();
    // CLI에 필요한 빈 세션만 만든다.
    function createSession() { return { id: 'test-session', messages: [] }; }
    // 모델 호출 대신 turn에 전달된 이미지 수를 출력한다.
    async function turn(session, input, images) { return 'COUNT:' + images.length; }
    ${runtimeSource}
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close");
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { errors += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    await rm(directory, { recursive: true, force: true });
  });
  await until(() => output.endsWith("> "));
  // 명령 하나를 보내고 그 명령에 해당하는 새 출력만 검사한다.
  async function send(input: string) {
    const start = output.length;
    child.stdin.write(input + "\n");
    await until(() => output.length > start && output.endsWith("> "));
    return output.slice(start);
  }
  assert.match(await send("/attach"), /사용법/);
  assert.match(await send(`/attach ${directory}/missing.png`), /ENOENT/);
  assert.match(await send(`/attach "${file}"`), /다음 메시지에 첨부/);
  assert.match(await send(`/attach ${file}`), /다음 메시지에 첨부/);
  assert.match(await send("describe"), /COUNT:2/);
  assert.match(await send("again"), /COUNT:0/);
  await send(`/attach ${file}`);
  await send("/new");
  assert.match(await send("describe"), /COUNT:0/);
  await send(`/attach ${file}`);
  await send("/resume test-session");
  assert.match(await send("describe"), /COUNT:0/);
  child.stdin.write("/quit\n");
  assert.equal((await closed)[0], 0, errors);
});
