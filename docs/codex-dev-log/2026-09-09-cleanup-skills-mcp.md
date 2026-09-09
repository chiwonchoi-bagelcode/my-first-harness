# 스킬·MCP 정리 (push 전)

작성일: 2026-09-09

## 근거

세션 21개(9/8~9/9)의 실행 기록에서 툴 호출을 집계했다. MCP는 playwright 47회·filesystem 5회(초기 학습 때)·memory 0·microsoft 0·cloudflare 0. 스킬 본문 읽기는 frontend-design 3·game-testing 3·aggressive-greeting 2·webapp-testing 2(두 번 모두 Python·Python Playwright 미설치로 실패 후 MCP로 우회)·counter-check 0·when-user-said-wu 0. 시스템 프롬프트의 MCP 이름 목록은 52개(1,819자)였다.

## 사용자 결정

`webapp-testing` 스킬과 MCP `filesystem`·`microsoft`·`cloudflare`를 삭제한다. `memory`는 남긴다(MCP 학습 예제이자 stdio 토글 검증에 사용). 다른 스킬·내장 툴은 이번에는 건드리지 않는다.

## 변경

- `.my-first-harness/skills/webapp-testing/` 삭제. Python Playwright 스크립트 방식이라 우리 Playwright MCP·game-testing과 역할이 겹치고 요구 환경이 다르다.
- `mcp-servers.ts`: filesystem(`.my-first-harness/mcp-files` 루트)과 원격 HTTP 서버 두 개 제거. `mcp-files` 폴더 생성도 제거. 남는 서버는 memory·playwright. 이름 목록은 52 → 33개.
- `package.json`: `@modelcontextprotocol/server-filesystem` 의존성 제거. `.gitignore`의 `mcp-files/` 항목 제거. README의 폴더 설명 수정.
- 테스트: `tests/mcp.test.ts` 서버 목록, `tests/package-smoke.ts` 등록 확인 목록(MCP 2개), `tests/mcp-smoke.ts`의 filesystem·원격 호출 제거. `tests/skills.test.ts`의 "공개 스킬 보조 파일" 검증은 실제 webapp-testing 폴더 대신 frontend-design(LICENSE)과 임시 폴더의 스크립트 포함 스킬 픽스처로 바꿨다.

## 검증

- `pnpm exec tsc --noEmit`, `pnpm test` 245개, `git diff --check`: 통과.
- `pnpm test:mcp`(실제 stdio 서버 2개, API 키 없음): memory 생성·검색 통과, 등록 툴 33개. 처음 실행에서 두 서버 모두 `spawn node ENOENT`로 실패했는데, 원인은 스모크의 임시 작업 폴더 `<tmp>/project`가 존재하지 않은 것이었다. 제거한 filesystem 서버의 `mkdir(mcp-files)`가 그 폴더를 부수 효과로 만들어 주고 있었다. 실제 실행에서는 cwd가 항상 있으므로 스모크가 폴더를 만들도록 고쳤다.
- `pnpm test:package`: pack → 임시 전역 설치 → 다른 cwd 실행 → MCP 2개 연결 → 이미지 첨부 → 세션 저장 통과. server-filesystem 의존성 없이 설치된다.
- 실행 코드 변경은 `mcp-servers.ts`만이며 스킬 삭제는 파일 삭제다. 모델 API는 호출하지 않았다.
