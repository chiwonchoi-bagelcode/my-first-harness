# 선택적 백그라운드 셸 실행

## main 반영 위치 정정

- 최초 구현은 잘못된 작업 위치인 `codex/session-context` 워크트리에 작성했다. 사용자 요청에 따라 `/Users/choechiwon/my-first-harness`의 `main`에 백그라운드 셸 변경만 선별 반영했다.
- 메인은 셸 관리자 등록과 종료 처리만 변경했다. 워크트리의 실행 기록·세션 저장·API 사용량 관련 변경은 가져오지 않았다. 원본 워크트리 파일은 수정하거나 삭제하지 않았다.
- main에서 `pnpm test` 80개, strict 타입 검사, `bun test tests/jobs.test.ts` 8개, Bun 실행파일 빌드와 `git diff --check`를 다시 통과했다. 실제 LLM/MCP 연결 테스트는 하지 않았다.
- 빌드는 임시 경로에 만들었으므로 프로젝트 안의 기존 배포 실행파일은 갱신하지 않았다. main 소스는 `node my-first-harness.ts`로 실행한다.

## 합의한 범위

- `runCommand`의 `background`를 모델이 선택한다. 생략/false는 기존처럼 종료를 기다려 stdout+stderr 텍스트를 반환하고, true는 시작 후 작업 ID와 상태를 JSON 문자열로 반환한다.
- `readJob`, `listJobs`, `stopJob`을 추가했다. API 어댑터, 공통 메시지 형식, `step`/`turn`의 툴 실행 순서는 변경하지 않았다. 모든 툴을 백그라운드화하거나 특정 작업 순서를 강제하지 않는다.
- `job-manager.ts`가 실제 자식 프로세스, 출력, 종료 상태와 코드를 보관하고 `tools/shell.ts`가 이를 모델용 도구로 등록한다.
- `spawn` 성공은 서버 준비 완료가 아니다. 모델이 출력이나 접속 결과로 준비 여부를 확인해야 한다.

## 추가한 운영 규칙과 제한

- 작업 레지스트리는 현재 프로세스의 메모리에 있다. /new·/resume에서도 공유하며 재시작 후 ID나 프로세스를 복원하지 않는다. foreground 작업도 목록에 남는다.
- stdout/stderr는 각각 최근 16,384 UTF-16 코드 단위만 보관한다. 잘림 여부를 표시하고 서로게이트 경계가 깨지지 않게 처리한다. foreground 출력에도 이 한도가 적용되며 생략 안내를 붙인다. 원문 출력을 디스크에 별도로 저장하지 않는다.
- `readJob`은 기본 즉시 조회하며 `waitMs`는 0~10,000 정수다. 기다리는 중 새 출력이 와도 종료 또는 대기 만료 시 반환한다. 대기 만료는 프로세스를 종료하지 않는다. 반복 조회는 누적된 최근 출력의 스냅샷을 반환하며 커서는 아직 없다.
- `readJob` 자체의 성공과 프로세스 성공은 다르다. 프로세스 실패는 JSON의 status/exitCode/stderr로 보고, 잘못된 ID나 대기값은 기존 ToolManager의 오류 피드백으로 전달한다.
- 비어 있는 command는 스키마에서 거부한다. 모델에게 셸의 `&` 대신 background 옵션을 쓰도록 설명했다. 대화형 stdin은 지원하지 않는다.
- POSIX는 프로세스 그룹을 만들고 TERM 후 1초 뒤 남은 그룹에 KILL을 보낸다. 일반 자식 프로세스까지 정리하지만 별도 세션으로 분리하거나 daemon화한 프로세스는 지원 범위 밖이다. Windows에는 taskkill /T /F 경로가 있으나 이번에 실행 검증하지 않았다.
- /quit, 정상 루프 종료·오류, Ctrl+C/SIGINT에서 셸 작업과 MCP 연결 모두 정리를 시도한다. 중복 정리는 합치고, Ctrl+C로 취소된 foreground/question 오류를 일반 실패로 중복 보고하지 않는다. 강제 종료(SIGKILL)나 시스템 장애 복구는 지원하지 않는다.
- 완료 시 모델을 자동으로 깨우는 기능, 사용자용 /jobs 명령, PTY와 stdin 입력은 이번 범위가 아니다.

## 검증

- `pnpm test`: 80개 통과. 기본 툴 수는 8개에서 11개로 바뀌어 Anthropic의 실제 툴 정의 테스트와 스모크 테스트 표시를 갱신했다.
- `pnpm --package=typescript dlx tsc --noEmit --strict`: 통과.
- `bun test tests/jobs.test.ts`: 8개 통과.
- `bun build --compile my-first-harness.ts --outfile <임시 폴더>/my-first-harness`: 통과. 빌드 산출물은 검증 후 임시 폴더에서 삭제했다.
- 실제 로컬 HTTP 서버를 시작하고, 다른 셸 명령으로 접속하며 서버가 계속 살아 있는지 확인한 뒤 종료했다.
- 실제 프로세스로 출력 분리·잘림, 종료 코드, 복수 작업, 짧은 조회 대기, 실행 시작 실패, TERM을 무시하는 자식의 종료, dispose를 확인했다.
- 메인의 실제 입력/정리 소스를 별도 프로세스에 넣어 /quit 및 대기 중/foreground 실행 중 SIGINT의 종료 코드 0/130과 소유 프로세스 제거를 확인했다. 모델, MCP, 세션 저장은 이 테스트에서 대체했다.
- 실제 ToolManager/turn과 셸 프로세스를 연결한 테스트에서는 모의 모델이 실행→ID 수신→조회→최종 답변하는 기록을 확인했다.
- 실제 LLM/AIProxy/MCP 네트워크 호출은 하지 않았다. 모델의 자율 선택 품질, 실제 테트리스·브라우저 테스트와 배포된 실행파일의 전체 실연결은 별도 실사용 검증 대상이다.
- README, 사용자 세션, API 설정은 수정하지 않았다. 커밋·병합·푸시는 하지 않았다.

## 참고한 구현

- DSH `packages/shell/tool-bash/src/index.ts`의 `run_in_background`와 `packages/jobs/tool-jobs/src/index.ts`의 출력·목록·중단 구조를 축소했다. DSH의 소유 세션 구분과 완료 wakeup 정책까지 가져오지는 않았다.
- Node.js child_process 문서의 spawn/stdio/프로세스 그룹 동작을 사용했다.
