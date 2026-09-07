# 파일 기반 스킬과 progressive disclosure

## 변경 목적

기존에는 모든 SKILL.md 전문을 매 LLM 요청의 system 메시지에 넣었다. 이제 시작 시 이름·설명·절대경로만 등록하고, 모델이 필요할 때 기존 `readTextFile` 툴로 전문을 읽는다. API 제공자의 skills 전용 필드나 새로운 Skill 툴은 사용하지 않는다.

## 코드 연결

- `skill-loader.ts`: 전역/프로젝트 폴더 검색 → SKILL.md frontmatter를 `yaml`로 파싱 → `name`, `description`, `location`만 등록.
- `skill-manager.ts`: 기존 메인의 SkillManager를 분리. `getMessages()`는 목록과 읽기 안내만 system 메시지로 반환. 스킬이 없으면 빈 배열.
- 메인의 `assembleContext()`는 이전처럼 `skillManager.getMessages()`를 포함한다.
- 모델의 `readTextFile` 호출 → 기존 ToolManager 실행 → 기존 turn에서 history/messages 기록 → 다음 step에서 전문을 전달한다.
- 파일 읽기/툴 실행/세션/API provider 구현은 변경하지 않았다.

프로그램 시작 시 파일 전문을 디스크에서 읽어 YAML을 추출하지만, 전문을 목록이나 모델 요청에 넣지는 않는다. 점진적 공개는 디스크 읽기 횟수가 아니라 모델에게 전달하는 내용의 범위에 관한 것이다.

## 설치 규칙

```text
~/.my-first-harness/skills/<skill-name>/SKILL.md
<작업폴더>/.my-first-harness/skills/<skill-name>/SKILL.md
```

다운로드한 스킬 폴더 전체를 위 경로에 두고 하네스를 다시 실행하면 된다. `scripts`, `references`, `assets`, LICENSE 같은 보조 파일도 함께 보존한다. 자동 다운로드 명령이나 마켓플레이스는 이번 범위가 아니다.

필수 frontmatter:

```yaml
---
name: sample-skill
description: 어떤 작업에서 사용할지 설명한다.
---
```

- name: 64자 이하의 ASCII 소문자/숫자/단일 하이픈. 폴더 이름과 일치해야 한다.
- description: 비어 있지 않은 1~1024자 문자열.
- 동일 이름은 기존 정책대로 프로젝트가 전역보다 우선한다.
- 잘못된 파일은 경고 후 건너뛴다. 없는 검색 폴더는 정상이다.
- 모델에게 스킬 폴더 기준의 상대경로를 절대경로로 바꾸도록 안내한다. 참조 자료는 필요한 경우만 읽는다.
- 외부 스킬은 지침/코드로서 검토 후 설치해야 한다. 설치 과정이 스크립트를 실행하거나 의존성을 자동 설치하지 않는다.

## 기존 스킬

- 기존 두 실험 스킬(`aggressive-greeting`, `when-user-said-wu`)은 본문을 유지하고 name/description만 추가했다.
- `counter.ts`의 인라인 `counter-check` 지침은 프로젝트의 `counter-check/SKILL.md`로 이동했다. 도구 두 개는 그대로다.
- 현재 프로젝트에서 발견되는 스킬은 총 5개다.

## 공개 스킬 다운로드

출처: https://github.com/anthropics/skills

가져온 커밋: `41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f`

- `skills/frontend-design`: UI 시각 디자인 지침. SKILL.md, LICENSE.txt.
- `skills/webapp-testing`: Python Playwright 기반 웹앱 테스트 지침. SKILL.md, LICENSE.txt, `scripts/with_server.py`, `examples/*.py`.

각 폴더를 프로젝트 스킬 경로에 복사했다. 본문·보조 코드·라이선스 내용은 수정하지 않았으며, 일부 파일 끝의 개행만 정규화했다. 보조 스크립트는 다운로드만 했고 실행하지 않았다. webapp-testing의 실제 브라우저 테스트에는 별도 Python/Playwright/브라우저 설치가 필요하며 이번에는 설치하지 않았다.

## 검증

- `pnpm test`: 기존 23개 + 스킬 관련 8개 = 31개 통과.
- `pnpm --package=typescript dlx tsc --noEmit`: 통과.
- `git diff --check`: 통과.
- 파싱(BOM/CRLF/여러 줄 YAML), 잘못된 파일, 없는 폴더, 전역/프로젝트 우선순위, 비활성화, 목록에 본문 미포함을 검증했다.
- 실제 내장 readTextFile로 SKILL.md/참조 파일을 읽었을 때만 해당 텍스트가 컨텍스트에 추가되고, 저장/resume에서도 결과가 유지되는 것을 검증했다.
- 공개 스킬의 발견, 보조 스크립트와 라이선스 존재를 검증했다.
- 실제 CLI와 현재 LLM에 스킬 이름을 지정하지 않고 레트로 테트리스 시작 화면 디자인 조언을 요청했다. 모델이 `readTextFile`로 `frontend-design/SKILL.md`를 읽은 뒤 답변한 것을 세션 기록에서 확인했다. 본문 9,363자는 tool 결과로 들어갔으며, 파일 생성/구현/인터넷 검색은 요청하지 않았고 실행되지 않았다.

## 남겨둔 한계

- 별도의 활성 스킬 상태, 중복 로드 방지 코드, 자동 키워드 매칭, `/skill-name` 명령은 없다. 선택은 모델이 수행한다.
- 읽은 스킬 본문은 일반 툴 결과다. 기존 pruning/compaction 대상이며, 압축 뒤 자동 재주입하지 않는다. 필요한 원문이 현재 컨텍스트에 없으면 다시 읽도록 안내한다.
- `disable-model-invocation: true`는 목록에서 제외한다. 프로젝트에서 지정하면 같은 이름의 전역 항목도 숨긴다. 파일 읽기 권한을 차단하는 보안 기능은 아니다.
- `context`, `agent`, `hooks`, `model` 실행 확장이 있는 스킬은 지원하지 않는다고 경고하고 제외한다.
- `allowed-tools`를 해석해 권한을 부여하지 않으며, 인자 치환/동적 명령 삽입도 처리하지 않는다. 해당 문자열은 원문 그대로 남는다. 따라서 모든 Claude Code 전용 스킬과 완전히 호환된다는 뜻은 아니다.
- 폴더째 설치하는 방식은 지원하지만, 인터넷 스킬의 외부 의존성/도구 이름/환경 요구가 자동으로 충족되지는 않는다.
- README는 수정하지 않았다.

참고: [Agent Skills 규격](https://agentskills.io/specification), [파일 읽기 기반 활성화 가이드](https://agentskills.io/client-implementation/adding-skills-support#model-driven-activation).
