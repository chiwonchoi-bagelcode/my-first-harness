# Anthropic Messages + Haiku

## 변경 범위

- `adapters/anthropic-messages.ts` 추가. 공통 요청·응답 타입과 step/turn, ToolManager, 세션 저장 형식은 변경하지 않았다.
- `model-config.ts`에 연결 선택을 모았다. 메인은 첫 실행 인자로 고른 어댑터를 받는다.
  - `node my-first-harness.ts`: 기존처럼 Luna + Responses.
  - `node my-first-harness.ts luna`: 위와 동일.
  - `node my-first-harness.ts haiku`: Haiku + Anthropic Messages.
  - 잘못된 이름은 오류를 내며 다른 모델로 자동 전환하지 않는다.
- Haiku는 AIProxy의 `/anthropic/v1/messages`, 모델 `claude-haiku-4-5-20251001`, 기존 `AIPROXY_TOKEN`의 Bearer 인증을 사용한다. Farm 또는 Anthropic 직접 연결을 검증한 것은 아니다.
- 기존 Chat Completions 어댑터는 유지한다. 실행 인자 선택은 현재 luna/haiku 두 개만 제공한다.

## 어댑터가 처리하는 차이

- system은 최상위 필드, 툴 parameters는 input_schema로 보낸다. Messages에서 필수인 max_tokens는 요청 값 → 어댑터 설정 → 4096 순서로 정한다.
- 모델의 text는 공통 text, tool_use의 객체 input은 JSON.stringify로 공통 arguments 문자열이 된다. 툴 이름·인자 검증과 실행은 기존 ToolManager가 담당한다.
- 공통 tool 결과는 API의 user 메시지 내 tool_result로 바꾼다. 연속된 결과를 한 메시지에 모아 모든 tool_use_id에 응답하고 isError는 is_error로 전달한다. 실제 사용자 텍스트가 뒤따르면 결과 뒤에 놓는다.
- end_turn / stop_sequence / 텍스트가 있는 refusal은 stop, tool_use는 tool-calls, max_tokens는 max-tokens다. pause_turn이나 알 수 없는 종료는 other로 남긴다. 서버 내장 툴의 이어 실행은 이번 범위가 아니다.
- 원본 assistant content는 replayState에 저장한다. 같은 어댑터·제공자·모델이고 공통 내용과 일치할 때만 재사용한다. thinking/signature와 redacted_thinking도 원본 순서로 보존하지만 사용자 출력이나 요약용 텍스트로 변환하지 않는다.
- 이번 요청에서는 extended thinking을 켜지 않는다. 해당 블록의 보존은 모의 테스트로만 검증했다.
- API별 재전송 정보는 다른 제공자에 보내지 않는다. 공통 내용으로 변환할 수 있지만, 임의의 과거 세션을 모델 간에 무손실 전환한다고 보장하지 않는다. 특히 객체로 복원할 수 없는 과거 툴 인자는 명시적으로 실패한다.
- 기본 인증은 공식 API의 x-api-key이고, AIProxy 연결에서는 auth: bearer를 지정한다. anthropic-version은 2023-06-01이다.

## 검증

- `pnpm test`: 67개 통과. 이전 Responses/Chat Completions, 컨텍스트, MCP, 스킬 테스트를 포함한다.
- 새 테스트: 요청/툴 정의 변환, 두 인증 방식, 출력 한도 우선순위, 복수 툴 결과 묶음, 오류 피드백, 원본 배열 비변경, thinking/서명 재전송, 손상·타출처 replay 제외, 종료 사유, 잘린 툴 실행 방지, 모델 선택.
- 메인의 실제 함수 정의를 이용한 모의 통합에서 중간 출력 → 인자 검증 → 실행 → 한 user 메시지로 여러 결과 전송을 확인했다.
- `pnpm --package=typescript dlx tsc --noEmit --strict`: 통과.
- Bun 실행파일 빌드: 통과. 출력은 `/tmp/harness-haiku-build.d9rmrm/my-first-harness`이며 실행파일 자체를 실행한 것은 아니다.
- `git diff --check`: 통과.

### 실제 API

- `pnpm test:anthropic`: AIProxy Haiku에 HTTP 요청 4회, 모두 200.
- 응답 model은 4회 모두 `claude-haiku-4-5-20251001`.
- 텍스트 응답(end_turn) → label 인자가 있는 readProbe 호출(tool_use) → 로컬에서 만든 UUID 결과를 사용한 답변(end_turn) → JSON 직렬화/복원 후 이전 값을 다시 사용한 다음 턴(end_turn)을 확인했다.
- 개인 파일·기존 세션·MCP는 사용하지 않았다. 스모크 테스트는 실제 API 비용이 발생하므로 일반 `pnpm test`와 분리했다.
- 이번 턴에서는 Luna 실연결을 반복하지 않았으며 기존 모의 테스트와 모델 선택 테스트를 통과했다. 이전 턴의 Luna 실연결 결과는 Responses 개발 로그에 있다.

README, 키 파일, 기존 세션 데이터는 변경하지 않았다. 이전 턴의 미커밋 Responses 변경을 유지했으며 커밋·병합은 수행하지 않았다.

## 참고

### 후속 수정: 실제 툴 목록의 빈 스키마 누락

- 사용자의 실제 실행에서 `tools.0.custom.input_schema.type: Field required`가 발생했다. 첫 툴 counterUP의 parameters가 `{}`였으며 getCounterVal, getCurrentTime도 같았다.
- 이 세 툴을 `{ type: "object", properties: {} }`로 수정했다. 빈 JSON Schema는 인자 없음의 명시적 표현이 아니며 Anthropic의 필수 type도 충족하지 못했다. 툴 실행 함수나 순서는 바꾸지 않았다.
- 최초 실연결 테스트는 별도의 readProbe만 사용했으므로 실제 내장 툴 정의의 오류를 놓쳤다. 어댑터 테스트 성공을 실제 하네스 전체의 성공으로 보고한 검증 범위가 부족했다.
- `tests/builtin-tool-definitions.ts`로 실제 등록 함수를 실행해 정의만 수집하고, 기본 툴 전체의 스키마를 확인하는 회귀 테스트를 추가했다. 자동 테스트는 68개 통과, strict 타입 검사와 diff 검사도 통과했다.
- 이제 `pnpm test:anthropic`은 기본 툴 8개도 포함한다. `pnpm test:anthropic --mcp`는 임시 작업/홈 경로로 MCP 서버 4개를 연결해 그 정의까지 포함한다.
- 후속 실측: 기본 8개 + MCP 28개 = 실제 정의 36개를 넣은 첫 요청 성공. 이후 readProbe를 추가해 툴 호출·결과·다음 턴까지 HTTP 4회 모두 200, 모델 claude-haiku-4-5-20251001을 확인했다.
- 기본/MCP 툴은 실제로 실행하지 않았다. 테스트가 만든 임시 디렉터리만 정리했으며 사용자 세션·파일·메모리는 변경하지 않았다.

- 내부 연결 가이드: `/Users/choechiwon/bagelcode/aiproxy-docs/aiproxy-connection-guide.md`, `passthrough-api-guide.md`.
- [Messages API](https://platform.claude.com/docs/en/api/messages/create): 필드, 필수 max_tokens, 인증·버전, thinking 서명 보존.
- [툴 결과 처리](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls): tool_use / tool_result, 결과 메시지 순서, is_error.
- [종료 사유](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons): end_turn, tool_use, max_tokens, pause_turn, refusal 구분.
