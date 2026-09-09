import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { SkillManager } from "../skill-manager.ts";
import { loadSkills, parseSkillMetadata } from "../skill-loader.ts";
import { createHarnessPaths } from "../harness-paths.ts";
import { registerFilesystemTools } from "../tools/filesystem.ts";
import { recordMessage } from "../context-manager.ts";
import { loadSession, saveSession } from "../session-store.ts";
import type { Session } from "../session.ts";

// 메타데이터와 본문을 가진 테스트용 스킬 파일 내용을 만든다.
const skillFile = (name: string, body = "BODY_SHOULD_NOT_BE_IN_CATALOG", description = "테스트 작업에 사용한다.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

// 사용자 데이터와 분리된 임시 프로젝트·전역 경로를 만들고 테스트 후 정리한다.
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "harness-skills-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return createHarnessPaths(join(root, "project"), join(root, "home"));
}

// 지정한 스킬 폴더에 테스트용 SKILL.md를 저장한다.
async function put(directory: string, name: string, source = skillFile(name)) {
  const location = join(directory, name, "SKILL.md");
  await mkdir(dirname(location), { recursive: true });
  await writeFile(location, source);
  return location;
}

test("YAML은 객체로 파싱하지만 등록 값에는 본문이 없다 (BOM/CRLF/여러 줄 설명)", () => {
  const source = "\uFEFF---\r\nname: sample\r\ndescription: >\r\n  첫 번째 줄\r\n  두 번째 줄\r\n---\r\nPRIVATE_BODY";
  const metadata = parseSkillMetadata(source, "/tmp/sample/SKILL.md");
  assert.deepEqual(metadata, {
    name: "sample", description: "첫 번째 줄 두 번째 줄", location: "/tmp/sample/SKILL.md",
  });
  assert.doesNotMatch(JSON.stringify(metadata), /PRIVATE_BODY/);
});

test("스킬 필수 필드·폴더 이름·YAML을 검증한다", () => {
  for (const source of [
    "본문만 있음",
    "---\nname: sample\ndescription: [broken\n---\nbody",
    "---\nname: sample\ndescription: 123\n---\nbody",
    skillFile("different"),
    skillFile("BAD_NAME"),
    skillFile("sample", "body", '""'),
  ]) {
    assert.throws(() => parseSkillMetadata(source, "/tmp/sample/SKILL.md"));
  }
});

test("실행 방식 확장은 거부하고 모델 호출 비활성화는 목록에서 제외한다", () => {
  const source = skillFile("sample");
  assert.equal(parseSkillMetadata(source.replace("description:", "disable-model-invocation: true\ndescription:"), "/tmp/sample/SKILL.md"), undefined);
  assert.throws(() => parseSkillMetadata(source.replace("description:", "context: fork\ndescription:"), "/tmp/sample/SKILL.md"), /지원하지 않는 실행 설정/);
  assert.throws(() => parseSkillMetadata(source.replace("description:", 'disable-model-invocation: "true"\ndescription:'), "/tmp/sample/SKILL.md"), /boolean/);
});

test("없는 스킬 폴더/빈 목록에는 스킬 안내 메시지를 넣지 않는다", async (t) => {
  const manager = new SkillManager();
  await loadSkills(manager, await fixture(t));
  assert.deepEqual(manager.getInstructions(), []);
});

test("전역 + 프로젝트를 발견하고 같은 이름은 프로젝트가 우선한다", async (t) => {
  const paths = await fixture(t);
  await put(paths.userSkillsDirectory, "shared", skillFile("shared", "GLOBAL_BODY", "전역 설명"));
  await put(paths.userSkillsDirectory, "global-only");
  const projectFile = await put(paths.projectSkillsDirectory, "shared", skillFile("shared", "PROJECT_BODY", "프로젝트 설명"));
  await put(paths.projectSkillsDirectory, "broken", "옛 형식");
  const warning = t.mock.method(console, "warn", () => {});
  const manager = new SkillManager();
  await loadSkills(manager, paths);
  assert.equal(manager.skills.length, 2);
  assert.equal(manager.skills.find((skill) => skill.name === "shared")?.location, projectFile);
  assert.equal(warning.mock.callCount(), 1);
  const catalog = JSON.stringify(manager.getInstructions());
  assert.match(catalog, /프로젝트 설명/);
  assert.doesNotMatch(catalog, /GLOBAL_BODY|PROJECT_BODY|BODY_SHOULD_NOT_BE_IN_CATALOG/);
});

test("프로젝트의 비활성화는 같은 이름의 전역 목록도 숨긴다", async (t) => {
  const paths = await fixture(t);
  await put(paths.userSkillsDirectory, "sample");
  await put(paths.projectSkillsDirectory, "sample", skillFile("sample").replace("description:", "disable-model-invocation: true\ndescription:"));
  const manager = new SkillManager();
  await loadSkills(manager, paths);
  assert.deepEqual(manager.skills, []);
});

test("전문과 참조 파일은 기존 readTextFile 결과로만 컨텍스트에 들어가고 저장/resume된다", async (t) => {
  const paths = await fixture(t);
  const location = await put(paths.projectSkillsDirectory, "sample", skillFile("sample", "본문 지침. 자세한 기준은 references/checklist.md를 읽어라."));
  const reference = join(dirname(location), "references", "checklist.md");
  await mkdir(dirname(reference), { recursive: true });
  await writeFile(reference, "REFERENCE_ONLY_AFTER_READ");
  const manager = new SkillManager();
  await loadSkills(manager, paths);
  const tools: any[] = [];
  registerFilesystemTools({ register: (tool: any) => tools.push(tool) });
  const reader = tools.find((tool) => tool.name === "readTextFile");
  const session: Session = { id: "skill-test", workspaceDirectory: paths.workspaceDirectory, system: "테스트용 지침", projectInstructions: "", discoveredTools: [], messages: [] };
  // 실제 조립처럼 시스템 지침과 대화 기록을 분리한 요청을 검사한다.
  const request = () => JSON.stringify({ system: [session.system, ...manager.getInstructions()].join("\n\n"), messages: session.messages });
  assert.doesNotMatch(request(), /본문 지침|REFERENCE_ONLY_AFTER_READ/);

  // 시작 시 읽은 파일 내용을 캐시해 주는 것이 아니라 툴이 현재 파일을 다시 읽는다.
  await writeFile(location, skillFile("sample", "수정된 본문 지침. references/checklist.md를 확인하라."));
  recordMessage(session, { role: "assistant", content: [{
    id: "load-skill", type: "tool-call", name: "readTextFile", arguments: JSON.stringify({ path: location }),
  }] });
  const skillResult = await reader.execute({ path: location });
  recordMessage(session, { role: "tool", content: [{ type: "tool-result", toolCallId: "load-skill", content: skillResult }] });
  assert.match(request(), /수정된 본문 지침/);
  assert.doesNotMatch(request(), /REFERENCE_ONLY_AFTER_READ/);
  recordMessage(session, { role: "assistant", content: [{
    id: "load-reference", type: "tool-call", name: "readTextFile", arguments: JSON.stringify({ path: reference }),
  }] });
  const referenceResult = await reader.execute({ path: reference });
  recordMessage(session, { role: "tool", content: [{ type: "tool-result", toolCallId: "load-reference", content: referenceResult }] });
  assert.match(request(), /REFERENCE_ONLY_AFTER_READ/);
  await saveSession(session, paths);
  const resumed = await loadSession(session.id, paths);
  assert.deepEqual(resumed.messages, session.messages);
});

test("설치한 공개 스킬을 발견하고 보조 파일/라이선스도 그대로 사용할 수 있다", async (t) => {
  const paths = await fixture(t);
  const project = fileURLToPath(new URL("..", import.meta.url));
  const manager = new SkillManager();
  await loadSkills(manager, createHarnessPaths(project, dirname(paths.userHarnessDirectory)));
  for (const name of ["frontend-design", "webapp-testing", "counter-check"]) {
    assert.ok(manager.skills.some((skill) => skill.name === name));
  }
  const skill = manager.skills.find((skill) => skill.name === "webapp-testing")!;
  assert.match(await readFile(join(dirname(skill.location), "scripts", "with_server.py"), "utf8"), /argparse/);
  assert.match(await readFile(join(dirname(skill.location), "LICENSE.txt"), "utf8"), /Apache License/);
  assert.doesNotMatch(JSON.stringify(manager.getInstructions()), /from playwright.sync_api import sync_playwright/);
});
