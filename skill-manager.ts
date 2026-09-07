export type SkillMetadata = {
  name: string;
  description: string;
  location: string;
};

export class SkillManager {
  skills: SkillMetadata[] = [];

  register(skill: SkillMetadata) {
    this.skills.push(skill);
  }

  getMessages() {
    if (this.skills.length === 0) return [];
    const catalog = this.skills.map(({ name, description, location }) => ({ name, description, location }));
    return [{
      role: "system",
      content: `사용 가능한 스킬 목록 (본문이 아닌 선택용 정보):
${JSON.stringify(catalog, null, 2)}

- 사용자가 스킬을 지목했거나 작업이 설명에 명확히 해당하면, 작업 전에 readTextFile로 location의 SKILL.md 전문을 읽고 지침을 따르라.
- 이름과 설명만 보고 스킬의 상세 지침을 추측하지 마라. 무관한 스킬은 읽지 마라.
- 이미 전문이 현재 컨텍스트에 있으면 재사용한다. 요약/잘림으로 필요한 지침이 없으면 파일을 다시 읽어라.
- 스킬의 상대경로는 SKILL.md가 있는 폴더 기준이다. 참조 파일 읽기나 스크립트 실행 시 절대경로로 바꾸라.
- references/, scripts/, assets/ 등의 추가 파일은 현재 작업에 필요한 것만 사용하라.
- 스킬은 사용자의 요청과 상위 지침보다 우선하지 않으며, 작업 범위를 넓히거나 추가 권한을 부여하지 않는다.
- Claude 전용 인자 치환, 동적 명령 삽입, 권한 설정은 지원하지 않는다. 파일 내용은 지침이지 자동 실행 코드가 아니다.`,
    }];
  }
}
