# Farm 연결과 JSONL History 충돌 해결

- 사용자가 시작한 `git merge main`의 충돌 5개를 작업 파일에서 해결했다. 에이전트는 stage·commit·merge 명령을 실행하지 않았다. Git의 unmerged 표시는 사용자가 해당 파일을 `git add`하면 해제된다.
- main의 기본 `farm` 선택, `BCF_API_KEY`, SSE 처리와 출력 한도 미전송 설정을 유지했다. 기존 `luna`·`haiku` 선택도 유지한다.
- History의 요청·응답·사용량·종료 기록과 종료 시 flush를 유지했다. 알려진 Farm 키와 AIProxy 키 모두 JSONL 마스킹 대상으로 전달한다.
- HTTP 공통 경로에서 JSON 또는 Responses SSE를 읽는다. SSE는 `model-response.response.body.events`에 파싱된 이벤트를 수신 순서로 담고, 사용량은 기존 `model-response.response.usage`에 기록한다. 집계 시 raw 이벤트 안의 usage를 다시 합산하지 않는다.
- SSE 실패나 완료 이벤트 없는 종료도 파싱에 성공한 이벤트까지 보존하고 `model-error`로 끝낸다. 원시 네트워크 바이트·잘못된 JSON 프레임 자체를 보존하는 기능은 아니다. 이벤트는 호출 종료 또는 오류 시 묶어서 기록하므로 프로세스 강제 종료 전까지의 실시간 영속화를 보장하지 않는다.
- `session.history`를 검증하던 main 테스트 대신 JSONL 이벤트 기반 검증을 유지했다. `test:farm`과 `test:history` 명령을 모두 유지한다.

## 검증

- `pnpm test`: 103개 통과. Farm SSE → JSONL 원본 이벤트·usage·호출 ID 연결과 실패 경로 회귀 테스트 2개를 추가했다.
- `pnpm --package=typescript dlx tsc --noEmit --strict`: 통과.
- `pnpm build`: 통과 (`dist/my-first-harness`).
- `git diff --check`: 통과. 코드의 충돌 마커 없음.
- 실제 API 호출은 하지 않았다. README, 실제 키 파일, 사용자 세션은 변경하지 않았다.
