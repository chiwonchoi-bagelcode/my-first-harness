# 공통 LLM 형식과 MCP·스킬 구현 병합

- 대상: 사용자가 `main`에서 시작한 `codex/session-context` 병합. 사용자 승인으로 `/Users/choechiwon/my-first-harness`의 충돌 파일을 수정했다.
- 에이전트는 git add/commit/merge/push를 실행하지 않았다. 충돌 표시는 파일에서 제거했지만 인덱스의 UU는 사용자가 git add해야 해제된다.

## 합친 구현

- 공통 `LLMRequest`/메시지 블록과 Chat Completions 어댑터를 유지했다. 실제 연결 모델·주소는 들어오는 브랜치 그대로다. Responses/Anthropic 어댑터를 새로 구현한 것은 아니다.
- MCP 서버 연결·종료, 툴 발견과 실행, draft-07/2020-12 인자 검증을 유지했다. 검증 오류를 공통 `{ content, isError }` 결과로 연결했다.
- 스킬 YAML 메타데이터 로딩과 점진적 공개를 유지했다. `SkillManager.getMessages()` 대신 `getInstructions(): string[]`로 목록과 읽기 지침을 반환하여 공통 요청의 `system`에 합친다. 본문은 여전히 파일 읽기 툴 결과로만 들어간다.
- 공통 툴 호출 블록을 순회하면서 기존 `[tool] 이름 인자` 로그를 출력한다. 카운터 툴은 증가/조회가 분리된 상태이며 지침은 별도 SKILL.md로 유지한다.
- 세션 history/messages 분리, 압축·긴 툴 결과 줄이기, 저장/resume는 공통 메시지 형식을 사용한다.

## 기존 정책과 데이터 영향

- 프로젝트 스킬 우선·비활성화 시 동명 전역 스킬 숨김 등 기존 정책을 유지했다. 병합을 이유로 새 fallback이나 실행 정책을 추가하지 않았다.
- 들어오는 브랜치의 세션 형식은 `system`이 별도 문자열이고 `messages`/`history`는 공통 블록이다. 이전 형식의 세션은 resume 시 거부된다. 자동 변환과 기존 세션 삭제는 하지 않았다.
- README와 별도 작업 worktree는 수정하지 않았다.

## 검증

- `pnpm test`: 45개 통과. 실제 메인 step/turn의 정의를 사용하는 모의 응답 테스트 및 MCP 등록→인자 검증→원격 실행→공통 기록 연결 테스트 포함.
- `pnpm --package=typescript dlx tsc --noEmit`: 통과.
- `pnpm test:mcp`: 실제 stdio 서버 2개와 HTTP 서버 2개, 총 28개 툴 등록 및 호출 통과. 테스트 전용 임시 파일·메모리를 사용하고 정리했다.
- `bun build --compile my-first-harness.ts --outfile /tmp/harness-merge-build.Mz3Cdr/my-first-harness`: 통과. 프로젝트의 기존 실행파일은 덮어쓰지 않았다.
- 충돌 마커 없음, `git diff --check` 통과.
- 실제 LLM API 호출은 이번 검증에서 하지 않았다. Bun 실행파일은 컴파일만 확인했다.
