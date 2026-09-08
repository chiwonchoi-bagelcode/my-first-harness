// 본문을 읽기 전에 스킬을 선택하는 데 필요한 이름·설명·파일 위치.
export type SkillMetadata = {
  name: string;
  description: string;
  location: string;
};

// 스킬 메타데이터를 보관하고 점진적 공개를 위한 목록과 읽기 지침을 제공한다.
export class SkillManager {
  skills: SkillMetadata[] = [];

  // 발견한 스킬의 메타데이터를 등록한다.
  register(skill: SkillMetadata) {
    this.skills.push(skill);
  }

  // API 전용 메시지 대신 공통 요청의 system에 넣을 문자열 배열을 반환한다.
  getInstructions(): string[] {
    if (this.skills.length === 0) return [];
    const catalog = this.skills.map(({ name, description, location }) => ({ name, description, location }));
    // DSH 스킬 목록 원문을 유지하되 전용 skill 툴 대신 파일 읽기로 연결한다.
    return [`<system-reminder>
A skill is a reusable set of task-specific instructions. The following skills are available in this session:

<available_skills>
${JSON.stringify(catalog, null, 2)}
</available_skills>

If the user names a skill, or the task clearly matches a skill's description, call the readTextFile tool with path set to the exact location from this catalog before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.
</system-reminder>`,
    ];
  }
}
