import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import type { HarnessPaths } from "./harness-paths.ts";
import type { SkillMetadata } from "./skill-manager.ts";

// 파일은 읽되, 모델에게 전달할 이름/설명/위치만 반환한다. 본문은 등록하지 않는다.
export function parseSkillMetadata(source: string, location: string): SkillMetadata | undefined {
  const match = source.replace(/^\uFEFF/, "").match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) throw new Error("파일 맨 앞에 YAML frontmatter (--- ... ---)가 필요합니다.");
  const data = parse(match[1]);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("frontmatter는 객체여야 합니다.");
  if (typeof data.name !== "string" || data.name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.name)) {
    throw new Error("name은 64자 이하의 소문자·숫자·단일 하이픈이어야 합니다.");
  }
  if (data.name !== basename(dirname(location))) throw new Error("name은 스킬 폴더 이름과 같아야 합니다.");
  if (typeof data.description !== "string" || !data.description.trim() || data.description.length > 1024) {
    throw new Error("description은 비어 있지 않은 1~1024자 문자열이어야 합니다.");
  }
  if (data["disable-model-invocation"] === true) return undefined;
  if (data["disable-model-invocation"] !== undefined && typeof data["disable-model-invocation"] !== "boolean") {
    throw new Error("disable-model-invocation은 boolean이어야 합니다.");
  }
  // 별도 실행 방식이 필요한 스킬을 일반 지침처럼 조용히 실행하지 않는다.
  const unsupported = ["context", "agent", "hooks", "model"].filter((key) => data[key] !== undefined);
  if (unsupported.length) throw new Error(`지원하지 않는 실행 설정: ${unsupported.join(", ")}`);
  return { name: data.name, description: data.description.trim(), location: resolve(location) };
}

export async function loadSkills(
  skillManager: { register(skill: SkillMetadata): void },
  paths: HarnessPaths,
) {
  const skills = new Map<string, SkillMetadata>();

  // Load project skills last so they override user skills with the same name.
  for (const directory of [paths.userSkillsDirectory, paths.projectSkillsDirectory]) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const location = join(directory, entry.name, "SKILL.md");
      try {
        const source = await readFile(location, "utf8");
        const skill = parseSkillMetadata(source, location);
        if (skill) skills.set(skill.name, skill);
        else skills.delete(entry.name); // 프로젝트에서 비활성화하면 같은 이름의 전역 스킬도 숨긴다.
      } catch (error) {
        console.warn(`[skills] ${location} 건너뜀: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  for (const skill of skills.values()) skillManager.register(skill);
}
