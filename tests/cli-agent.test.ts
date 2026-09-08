import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHarnessPaths } from "../harness-paths.ts";

// 자식 CLI가 다음 입력을 받을 때까지 기다리되 실패 시 무한 대기를 막는다.
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("CLI·코어 통합 테스트 대기 시간 초과");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("CLI와 실제 코어를 연결해 진행 출력·최종 답변·compact·resume·종료 저장을 검증한다", { timeout: 15_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-cli-agent-"));
  // 임시 실행 스크립트에서 실제 모듈의 절대 URL을 사용한다.
  const url = (file: string) => JSON.stringify(new URL(`../${file}`, import.meta.url).href);
  const script = `
    import { createAgent } from ${url("agent.ts")};
    import { runCli, renderCliEvent } from ${url("cli.ts")};
    import { ToolManager } from ${url("tool-manager.ts")};
    import { SkillManager } from ${url("skill-manager.ts")};
    import { ExecutionHistory } from ${url("execution-history.ts")};
    import { createHarnessPaths } from ${url("harness-paths.ts")};
    const paths = createHarnessPaths(${JSON.stringify(directory)}, ${JSON.stringify(directory)});
    const history = new ExecutionHistory(paths);
    const toolManager = new ToolManager();
    toolManager.register({ name: 'probe', description: '확인', parameters: { type: 'object', properties: {} }, execute: () => '42' });
    let calls = 0;
    const adapter = { async generate(request) {
      if (request.maxOutputTokens === 2048) return { stopReason: 'stop', message: { role: 'assistant', content: [{ type: 'text', text: '값 42 확인 완료' }] } };
      if (++calls === 1) return { stopReason: 'tool-calls', message: { role: 'assistant', content: [
        { type: 'text', text: '확인 중' }, { type: 'tool-call', id: 'probe-1', name: 'probe', arguments: '{}' },
      ] } };
      if (request.messages.at(-1).content[0].content !== '42') throw new Error('툴 결과 누락');
      return { stopReason: 'stop', message: { role: 'assistant', content: [{ type: 'text', text: '최종 답변: 42' }] } };
    } };
    const agent = createAgent({ adapter, toolManager, skillManager: new SkillManager(), history, paths, onEvent: renderCliEvent });
    await runCli({ agent, paths, history, dispose: async () => { console.log('[disposed]'); } });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: directory, stdio: ["pipe", "pipe", "pipe"],
  });
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
  const id = /session: ([\w-]+)/.exec(output)![1];
  // 한 명령의 응답과 다음 입력 프롬프트까지 수집한다.
  async function send(input: string) {
    const start = output.length;
    child.stdin.write(input + "\n");
    await until(() => output.length > start && output.endsWith("> "));
    return output.slice(start);
  }
  assert.equal(await send("값을 확인해줘"), "확인 중\n[tool] probe {}\n최종 답변: 42\n> ");
  const paths = createHarnessPaths(directory, directory);
  // 실제 JSON 스냅샷에서 턴 완료와 압축 후 저장 상태를 읽는다.
  const snapshot = async () => JSON.parse(await readFile(join(paths.sessionDirectory, `${id}.json`), "utf8"));
  const before = await snapshot();
  assert.equal(before.version, 2);
  assert.equal(before.messages.length, 4);
  assert.match(await send("/compact"), /대화를 요약합니다[\s\S]*압축 완료/);
  const after = await snapshot();
  assert.equal(after.system, before.system);
  assert.equal(after.messages.length, 1);
  assert.match(after.messages[0].content[0].text, /값 42 확인 완료/);
  await send("/new");
  assert.match(await send(`/resume ${id}`), /resumed session/);
  assert.deepEqual(await snapshot(), after);
  child.stdin.write("/quit\n");
  assert.equal((await closed)[0], 0, errors);
  assert.equal(output.split("[disposed]").length - 1, 1);
  const records = (await readFile(join(paths.sessionDirectory, `${id}.jsonl`), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.at(-1).type, "session-close");
  assert.equal(records.filter((event) => event.type === "turn-end").length, 1);
  assert.equal(records.filter((event) => event.type === "tool-end").length, 1);
  assert.deepEqual(records.filter((event) => event.type === "model-start").map((event) => event.purpose), ["step", "step", "compaction"]);
});
