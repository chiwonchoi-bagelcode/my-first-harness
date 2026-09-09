import assert from "node:assert/strict";
import test from "node:test";
import { createSession } from "../session.ts";
import { modeInstructions } from "../agent-mode.ts";
import { SkillManager } from "../skill-manager.ts";
import { BASE_SYSTEM_PROMPT, PLAN_INSTRUCTIONS, EDIT_INSTRUCTIONS, SUMMARY_SYSTEM_PROMPT,
  OPINION_SYSTEM_PROMPT, skillInstructions } from "../prompts.ts";

test("새 세션만 현재 공통 지침을 채택하고 기존 세션의 스냅샷은 그대로 둔다", () => {
  const previous = { ...createSession("/prompt-test"), system: "사용자가 보관한 기존 지침" };
  const current = createSession("/prompt-test");
  assert.equal(current.system, BASE_SYSTEM_PROMPT);
  assert.equal(previous.system, "사용자가 보관한 기존 지침");
});

test("모드 지침은 계획 제출 계약을 안내하고 실행 모드에 계획 제한을 섞지 않는다", () => {
  assert.equal(modeInstructions("plan"), PLAN_INSTRUCTIONS);
  assert.equal(modeInstructions("edit"), EDIT_INSTRUCTIONS);
  assert.match(PLAN_INSTRUCTIONS, /exit_plan_mode/);
  assert.match(PLAN_INSTRUCTIONS, /next step/);
  assert.match(PLAN_INSTRUCTIONS, /ordinary tool call is NOT plan approval/);
  assert.doesNotMatch(EDIT_INSTRUCTIONS, /현재 모드: plan/);
});

test("스킬 목록은 활성 메타데이터만 전달하며 원문·참조 파일을 미리 읽지 않는다", () => {
  const skill = { name: "design", description: "UI design", location: "/skills/design/SKILL.md" };
  const manager = new SkillManager();
  manager.register(skill);
  assert.deepEqual(manager.getInstructions(), [skillInstructions([skill])]);
  assert.match(manager.getInstructions()[0], /already present in the current context/);
  assert.match(manager.getInstructions()[0], /directory containing that skill file/);
  manager.setEnabled("design", false);
  assert.deepEqual(manager.getInstructions(), []);
});

test("요약은 고정된 일곱 제목과 검증·승인·관찰 시점 구분을 유지한다", () => {
  assert.equal((SUMMARY_SYSTEM_PROMPT.match(/^## /gm) ?? []).length, 7);
  for (const term of ["실제 툴 결과", "승인 범위", "성공 기준", "마지막 관찰 상태", "미확인", "이미지"])
    assert.ok(SUMMARY_SYSTEM_PROMPT.includes(term), term);
});

test("참고 하네스의 미지원 도구·미해결 템플릿·전체 프롬프트를 가져오지 않는다", () => {
  const prompts = [BASE_SYSTEM_PROMPT, PLAN_INSTRUCTIONS, EDIT_INSTRUCTIONS, SUMMARY_SYSTEM_PROMPT, OPINION_SYSTEM_PROMPT];
  for (const prompt of prompts) assert.doesNotMatch(prompt, /\$\{|\{\{|multi_tool_use|AskUserQuestion|TaskCreate|TodoWrite/);
  assert.ok(BASE_SYSTEM_PROMPT.length < 5000, "공통 지침을 필요 이상으로 늘리지 않는다");
  assert.match(OPINION_SYSTEM_PROMPT, /no tools or access/);
});
