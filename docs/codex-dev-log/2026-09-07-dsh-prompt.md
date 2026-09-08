# DSH 원문 기반 프롬프트 실험

- 사용자 승인 범위: DSH 원문을 최대한 유지하고 실제로 다른 기능 안내만 수정한다. 테스트는 사용자가 수행한다.
- 참고 저장소: `/Users/choechiwon/playground/research/deepseek-harness`, 확인한 커밋 `49a606bc5b`.
- 기본 지침 출처: `snapshots/session/text-turn/system-prompt.expected.md`. 배포 전체에 공통인 단일 기본값이 아니라 테스트 실행 구성의 조립 결과다.
- 스킬 안내 출처: `packages/skill/tool-skill/src/index.ts`의 `renderCatalogMessage()`.

## 변경

- 기본 프롬프트는 영문 원문 중 코딩 역할, 실행·테스트 검증, 간결하고 사실적인 답변, 명령 실패 확인, 파일 읽기·쓰기 안내를 유지한다.
- 하네스 이름을 바꾸고 DSH 모델명은 제거했다. 작업 디렉토리는 기존 assembleContext에서 계속 제공한다.
- read/write/bash를 readTextFile/writeTextFile/runCommand로 변경했다. 종료 코드 마커 대신 현재 반환되는 출력·오류 확인으로 맞췄다.
- 없는 편집·검색·웹·백그라운드·goal·위임 툴과 샌드박스·파일 관찰 강제 정책·페이지 읽기 안내는 제외했다.
- 스킬 안내는 DSH의 카탈로그 문구를 유지하되 전용 skill 호출 대신 카탈로그 location의 파일 읽기를 안내한다. 카탈로그 JSON 형식과 시스템 지침으로의 조립 방식은 유지한다. 직접 스킬 호출의 skill_content 주입은 미구현이므로 그 문장은 제외했다.
- 이전 자체 중간 보고·think deep 문구와 자체 스킬 안내 문구는 교체했다. 이번 실패를 위한 별도 행동 지침은 덧붙이지 않았다.
- 루프·어댑터·요약 프롬프트·툴 구현·권한·개별 SKILL.md·README는 변경하지 않았다.

## 적용과 확인

- 처음 별도 worktree에 잘못 적용한 변경을 사용자 지적 후 `/Users/choechiwon/my-first-harness`의 main checkout으로 옮겼다. 별도 worktree의 해당 변경은 원복했다. 커밋·병합은 실행하지 않았다.
- 새 기본 프롬프트는 새 프로세스의 새 세션 또는 `/new`부터 적용된다. resume는 저장된 session.system을 사용한다. 스킬 카탈로그 지침은 현재 코드로 매번 조립된다.
- 테스트·타입 검사·빌드·실제 모델 호출은 사용자 요청에 따라 실행하지 않았다. 변경 diff만 확인했다.
