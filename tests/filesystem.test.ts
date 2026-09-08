import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { registerFilesystemTools } from "../tools/filesystem.ts";
import { validateToolArguments } from "../tool-schema.ts";

const tools: any[] = [];
registerFilesystemTools({ register: (tool: any) => tools.push(tool) });
const edit = tools.find((tool) => tool.name === "editTextFile");

// 사용자 파일 대신 임시 파일에 등록된 실제 편집 함수를 실행한다.
async function fixture(t: TestContext, content: string) {
  const directory = await mkdtemp(join(tmpdir(), "harness-edit-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "game.ts");
  await writeFile(path, content, "utf8");
  return path;
}

test("여러 줄을 다른 길이의 코드로 교체하고 주변 내용·CRLF·유니코드를 보존한다", async (t) => {
  const before = "// 앞 🌞\r\nfunction greet() {\r\n  say('hello');\r\n}\r\n// 뒤\r\n";
  const path = await fixture(t, before);
  const oldText = "function greet() {\r\n  say('hello');\r\n}";
  const newText = "function greet() {\r\n  say('안녕');\r\n  say('🌞');\r\n}";
  assert.equal(await edit.execute({ path, oldText, newText }), `edited ${path}`);
  assert.equal(await readFile(path, "utf8"), `// 앞 🌞\r\n${newText}\r\n// 뒤\r\n`);
});

test("빈 새 문자열은 부분 삭제이며 달러 치환 패턴도 문자 그대로 삽입한다", async (t) => {
  const path = await fixture(t, "앞 삭제 뒤");
  await edit.execute({ path, oldText: "삭제 ", newText: "" });
  assert.equal(await readFile(path, "utf8"), "앞 뒤");
  const newText = "$& $1 $` $'";
  await edit.execute({ path, oldText: "뒤", newText });
  assert.equal(await readFile(path, "utf8"), `앞 ${newText}`);
});

test("불일치·들여쓰기 차이·중복·겹친 일치·빈 원문은 파일을 바꾸지 않는다", async (t) => {
  const cases = [
    { content: "hello", oldText: "missing", error: /일치하는 내용이 없습니다/ },
    { content: "  hello", oldText: "\thello", error: /일치하는 내용이 없습니다/ },
    { content: "hello hello", oldText: "hello", error: /여러 곳에 일치/ },
    { content: "aaa", oldText: "aa", error: /여러 곳에 일치/ },
    { content: "hello", oldText: "", error: /비어 있을 수 없습니다/ },
  ];
  for (const entry of cases) {
    const path = await fixture(t, entry.content);
    await assert.rejects(edit.execute({ path, oldText: entry.oldText, newText: "changed" }), entry.error);
    assert.equal(await readFile(path, "utf8"), entry.content);
  }
});

test("존재하지 않는 파일을 생성하지 않고 스키마가 잘못된 편집 인자를 거부한다", async (t) => {
  const existing = await fixture(t, "hello");
  const path = join(existing, "..", "missing.ts");
  await assert.rejects(edit.execute({ path, oldText: "hello", newText: "hi" }), { code: "ENOENT" });
  await assert.rejects(readFile(path), { code: "ENOENT" });
  for (const args of [
    { path, oldText: "" , newText: "hi" },
    { path, oldText: "hello", newText: 1 },
    { path, oldText: "hello" },
    { path, oldText: "hello", newText: "hi", replaceAll: true },
  ]) assert.ok(validateToolArguments(edit.parameters, args));
  assert.equal(validateToolArguments(edit.parameters, { path, oldText: "hello", newText: "" }), undefined);
});
