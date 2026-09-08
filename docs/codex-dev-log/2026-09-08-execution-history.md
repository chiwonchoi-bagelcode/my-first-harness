# 실행 기록 JSONL과 세션 스냅샷 분리

## 결정과 범위

- `<sessionId>.json`에는 version 2, 세션 ID, 작업 폴더, 시스템 지침, 현재 `messages`만 저장한다. 기존 `history: Message[]`는 제거했다.
- 같은 프로젝트 전역 저장 폴더의 `<sessionId>.jsonl`에 원문 대화와 실행 이벤트를 추가한다. 각 줄에는 version 1, eventId, timestamp, sessionId, 필요하면 turnId/step/parentToolCallId가 있다.
- resume는 JSON 스냅샷만 읽는다. JSONL에서 messages를 재구성하거나 스냅샷 이후 작업을 자동 복구하지 않는다. 기존 세션 자동 변환과 파일 삭제도 하지 않았다.
- 컨텍스트 압축·툴 결과 축약 정책, 모델 선택·출력 한도, 툴 실행 순서는 바꾸지 않았다. max-tokens 응답의 툴 실행을 막고 저장 후 오류 종료하는 기존 처리는 다음 과제다. 현재도 잘린 assistant가 messages에 남을 수 있으므로 자동 복구를 보장하지 않는다.

## 핵심 파일과 흐름

- `execution-history.ts`: 이벤트 타입과 세션별 직렬 JSONL writer. 원문은 메모리 배열에 계속 쌓지 않는다. 호출 즉시 직렬화해서 이후 객체 변경이 이미 예약한 기록을 바꾸지 않게 한다.
- `recorded-llm.ts`: 공통 어댑터를 감싸 model-start/request/response/end/error를 기록한다. callId로 연결하며 일반 step, compaction, other-llm을 purpose로 구분한다.
- `adapters/http.ts`: 세 API가 실제로 보낼 본문을 전송 전에 관찰자에게 전달한다. 응답은 본문 읽기·JSON 파싱 후, API별 응답 정규화 전에 기록한다. HTTP 오류 및 JSON이 아닌 오류 본문도 남는다. 네트워크 실패처럼 응답을 받지 못하면 model-error만 남는다.
- `adapters/usage.ts`: 원본 응답의 usage를 공통 값으로 바꾼다. 원본의 세부 항목은 JSONL response.body.usage에 계속 보존한다.
- 메인의 `rememberMessage`: 원문 message 이벤트를 먼저 기록한 뒤 현재 messages에 반영한다. 압축·축약 이후에는 context-update에 변경 결과를 남기지만 이 이벤트를 resume에 재생하지 않는다.
- 툴 검증·실행 시도는 tool-start, 반환된 성공/오류는 tool-end로 기록한다. tool-start가 실제 함수 실행 성공을 뜻하지 않는다.
- 다른 LLM 툴에는 해당 실행의 세션·턴·스텝·부모 툴 ID에 묶인 어댑터를 전달한다. /new 또는 /resume 이전 세션으로 내부 호출이 잘못 귀속되지 않게 한다.
- /new, /resume, /compact, /quit 입력과 세션 시작·재개·종료, turn 시작·종료를 기록한다. MCP 서버 내부에서 일어나는 별도 모델 호출 등 하네스가 관측할 수 없는 작업까지 기록하는 것은 아니다.

## 사용량 읽기

- 집계 대상은 `type === "model-response"`의 `response.usage`다. raw body.usage를 다시 더하면 이중 집계가 된다. purpose가 필요하면 같은 callId의 model-start와 연결한다.
- 공통 inputTokens는 캐시를 포함한 전체 입력, outputTokens는 전체 출력이다. cachedInputTokens와 reasoningOutputTokens는 각각 입력·출력의 부분 집합이다.
- Messages는 input_tokens + cache_read_input_tokens + cache_creation_input_tokens를 전체 입력으로 매핑한다. 세 값 중 누락이 있으면 총 입력을 추측하지 않고, 확인된 세부 값과 원본만 남긴다.
- OpenAI의 prompt_tokens/input_tokens는 전체 입력으로 사용한다. 캐시 입력과 reasoning을 총계에 다시 더하지 않는다. Responses의 cache_write_tokens도 제공되면 보존한다.
- 누락·null·음수 등은 0으로 바꾸지 않는다. 실제 청구액, 모델별 단가표, 비용 대시보드는 이번에 구현하지 않았다.
- [OpenAI Chat usage](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), [Responses usage](https://developers.openai.com/api/reference/cli/resources/responses/methods/retrieve), [Anthropic 캐시 사용량](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)을 기준으로 필드를 대조했다.

## 저장과 개인정보 제한

- 인증 헤더는 기록 인터페이스에 전달하지 않는다. 응답 헤더에서는 요청 ID만 선택한다. 알려진 AIPROXY_TOKEN과 인증 이름의 필드는 JSONL 직렬화에서 마스킹한다.
- 대화·파일 내용·툴 결과·reasoning 재전송 데이터는 로그에 남는다. 모든 임의의 비밀을 자동 탐지하는 DLP나 로그 암호화는 아니다. JSON 스냅샷의 기존 메시지 저장 방식은 유지한다.
- 새 로그 파일 권한은 0600이다. 쓰기 실패를 무시하지 않고 해당 세션의 후속 기록도 실패시킨다. 마지막 줄이 개행으로 끝나지 않는 기존 로그에는 추가하지 않으며, 원본을 삭제·절단하지 않는다.
- 단일 프로세스의 세션별 쓰기 순서를 보장한다. 여러 프로세스가 같은 세션에 동시 쓰는 잠금, fsync 기반 전원 장애 내구성, 로그 로테이션은 미구현이다.
- JSON 스냅샷과 JSONL은 원자적 한 트랜잭션이 아니다. 비정상 종료 시 JSONL이 스냅샷보다 최신일 수 있다. 현재 resume는 그 차이를 자동 반영하지 않는다.
- 실제 요청 전체를 매번 보존하므로 로그 총량은 커질 수 있다. JSONL의 이점은 새 기록만 추가한다는 것이지 전체 저장 용량이 작아진다는 뜻은 아니다.

## 검증

- JSONL 순서·개행·객체 변경 방지·인증 마스킹, 압축 전 원문 보존, 스냅샷 resume, 기존 로그에 추가, 손상된 마지막 줄 거부, 구형 스냅샷 거부를 임시 디렉터리에서 검사했다.
- 세 API의 요청/응답 원본·사용량 매핑, HTTP 오류·비JSON·응답 정규화 실패·네트워크 실패, max-tokens 기록과 자동 재시도 없음은 모의 응답으로 검증했다.
- 실제 메인 함수의 모의 통합에서 일반/요약/중첩 호출 기록, 중첩 툴 ID와 세션 구분, 기록 데이터가 요청용 대화에 섞이지 않음을 검사했다.
- 실제 CLI 명령 루프를 별도 프로세스에서 실행해 /new → /resume → /quit의 파일 분리와 스냅샷 저장을 확인했다. API와 MCP는 대체했다.
- `pnpm test:history`: AIProxy에 합성 입력으로 Luna/Haiku 각각 1회 요청. 둘 다 HTTP 200, stop, JSONL 이벤트 4개를 확인했다. Luna 입력 20/출력 5, Haiku 입력 18/출력 5 토큰이 기록됐으며 둘 다 캐시 읽기/쓰기 0이었다. 개인 대화·툴·MCP는 사용하지 않았다. 생성한 임시 기록만 정리했다.
- strict 타입 검사와 git diff --check 통과. Bun 실행파일 빌드 통과. 빌드 산출물 자체의 실연결 실행은 하지 않았다.
- 전체 `pnpm test` 92개 통과. 이 수에는 작업 시작 전에 남아 있던 백그라운드 셸 테스트도 포함되어 있다.

## 작업 경계

- 시작 시 다른 에이전트의 백그라운드 셸 변경이 같은 worktree에 있었고, 사용자에게 겹침을 알렸다. 해당 기능을 임의 삭제하거나 커밋하지 않았다. 이 기록의 변경 범위는 history와 필요한 연결·테스트다.
- README, API 키 파일, 사용자 기존 세션은 수정하지 않았다. 커밋·병합·동기화도 하지 않았다.

## 후속: main의 백그라운드 작업 완료분과 코드 정합성 확인

- 사용자 요청으로 `git fetch origin` 후 `origin/main`의 `05d9fe5`를 비교했다. 백그라운드 셸 구현은 이 worktree에 남아 있던 버전과 동일했다. main 개발 기록에는 원본 worktree를 원복한 것이 아니라 main으로 변경만 선별 반영했다고 명시되어 있었다.
- `job-manager.ts`, `tools/shell.ts`, 백그라운드 작업 테스트의 구현은 main과 일치함을 확인했다. 메인의 종료 처리와 테스트에는 History 기록을 위한 연결만 유지했다.
- main에 추가된 `package.json`의 dist 빌드 명령과 빌드 폴더 개발 기록, 백그라운드 작업 문서의 위치 정정 내용을 반영했다. `test:history`는 유지했다.
- 백그라운드 실행→작업 ID 반환→조회 완료가 각각 올바른 toolCallId와 step으로 실행 기록에 연결되는지 통합 테스트에 추가했다.
- 전체 테스트 92개, strict 타입 검사, diff 검사 통과. `pnpm build`로 현재 worktree의 `dist/my-first-harness`를 생성했고 gitignore 대상임을 확인했다. 이번에는 실제 API 호출을 반복하지 않았다.
- 코드 내용만 최신 main과 조합했다. HEAD는 f37e7d5에 두었으며 commit/merge/rebase/staging/push는 수행하지 않았다. 브랜치 이력의 동기화는 사용자에게 남긴다.
