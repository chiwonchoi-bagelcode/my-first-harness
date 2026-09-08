# Responses 어댑터와 AIProxy Luna 연결

## 범위와 연결

- `adapters/responses.ts`를 추가했다. 공통 `LLMRequest` / `LLMResult`, 세션 저장 형식, `step` / `turn`, ToolManager 실행 흐름은 바꾸지 않았다.
- 메인의 어댑터 생성 부분만 Responses + `gpt-5.6-luna`로 전환했다. 기존 Chat Completions 어댑터와 테스트는 유지한다. 실행 시 API를 선택하는 설정 기능은 아직 없다.
- 연결은 **Bakery Farm 직접 연결이 아닌 AIProxy**의 `https://aiproxy-api.backoffice.bagelgames.com/openai/v1/responses`다. 기존 `.env`의 `AIPROXY_TOKEN`을 그대로 사용한다.
- 새 패키지는 설치하지 않았다. README, 기존 세션, 키 파일은 변경하지 않았다. 커밋·병합은 수행하지 않았다.

## 변환과 보존

- 공통 system → instructions, messages → input, 툴 정의 → 평평한 function 스키마로 변환한다.
- `strict: false`를 명시해 기존 선택 인자 규칙을 유지한다. 실제 인자 JSON 파싱과 검증은 기존 ToolManager가 맡는다.
- output 전체를 순서대로 읽는다. message의 output_text / refusal → 공통 text, function_call → 공통 tool-call이다. 툴 결과를 연결하는 ID는 항목의 `id`가 아니라 `call_id`다.
- tool-result는 function_call_output으로 보내며 오류는 output 문자열에 표시한다. 복수 호출에는 각각 대응 결과를 보낸다.
- `store: false`, `include: ["reasoning.encrypted_content"]`를 사용한다. previous_response_id나 서버 conversation은 사용하지 않는다.
- 지원하는 출력 항목(message / function_call / reasoning)의 원본을 replayState에 보존한다. reasoning, ID, assistant phase 등이 다음 요청에서 사라지지 않게 한다. 전체 HTTP 응답이나 usage는 저장하지 않는다.
- 같은 adapter / provider / model이며 현재 공통 내용과 일치하는 replay만 쓴다. 구조가 손상됐거나 내용이 편집됐거나 출처가 다르면 공통 블록으로 변환한다. 다른 모델로 reasoning을 이식한다고 보장하지 않는다.
- reasoning은 사용자용 텍스트로 꺼내지 않는다. 기존 withoutReplayState 덕분에 요약 입력과 문자 수 계산에도 포함되지 않는다. 따라서 기존 문자 수 임계값은 여전히 전체 API 토큰 수 측정값이 아니다.
- completed일 때만 툴 실행 또는 최종 답변으로 분류한다. incomplete + max_output_tokens는 max-tokens, 그 외 미완료는 other다. 알 수 없는 출력 타입, 실패 응답, 누락된 encrypted_content는 오류로 드러낸다.
- 어댑터의 선택 설정 `reasoningEffort`는 지정한 경우만 reasoning.effort로 보낸다. 메인은 생략해 모델 기본값을 쓰며, 실제 지원값 전체를 확인한 것은 아니다.

## 검증

- `pnpm test`: 56개 통과. 기존 Chat Completions / 컨텍스트 / 스킬 / MCP 모의 테스트 포함.
- 새 모의 테스트: 요청 변환, optional 인자 유지, 텍스트+복수 호출, call_id 연결, 오류 결과, 원본 순서·phase·reasoning 보존, JSON 왕복, 다른 출처·변경/손상된 replay 제외, refusal, 잘린 인자, 미완료/필터/빈 응답, HTTP/구조 오류, 키 누락, effort 옵션.
- 메인의 실제 함수 정의를 이용한 통합 모의 테스트: 중간 출력 후 툴 실행, 복수 결과 재전송, 없는 툴 오류 피드백, 잘린 함수 호출 실행 방지. 실제 CLI와 MCP 서버를 실행한 테스트는 아니다.
- `pnpm --package=typescript dlx tsc --noEmit --strict`: 통과.
- `bun build --compile my-first-harness.ts --outfile <임시 디렉토리>/my-first-harness`: 통과. 프로젝트 안에 실행파일을 만들지 않았다.
- `git diff --check`: 통과.

### 실제 AIProxy 호출

`pnpm test:responses`는 개인 파일·MCP·세션 파일을 사용하지 않는 독립 스모크 테스트다. 실행하면 실제 API를 4회 호출하므로 사용량이 발생한다.

1. 텍스트 응답.
2. `readProbe`에 label 인자를 전달하는 모델의 함수 호출.
3. ToolManager와 같은 검증 함수를 거쳐 로컬에서 만든 임시 UUID를 결과로 전달하고, 모델이 그 값을 답변에 사용하는지 확인.
4. 기록을 JSON으로 직렬화/복원한 뒤 다음 사용자 턴에서 이전 결과를 다시 사용하는지 확인.

- 기본값 테스트의 텍스트·툴 인자·결과·후속 턴은 모두 HTTP 200 / completed로 성공했다.
- 간단한 입력은 reasoning을 생성하지 않을 수 있었다. low 지정 요청도 성공했지만 reasoning이 반드시 나오는 것은 아니므로, 이를 기본 스모크 테스트의 필수 조건으로 삼지 않는다.
- `pnpm test:responses --reasoning`은 첫 요청에 계산 문제와 high effort를 사용한다. 정답 213528을 확인하고, encrypted reasoning을 실제로 재전송했는지도 검사한다.
- 이 별도 테스트는 4회 모두 HTTP 200 / completed, 응답 model은 gpt-5.6-luna, 응답 effort는 high였다. encrypted reasoning 1개를 수신하고 후속 3회 요청에 재전송했다. 함수 인자, 결과 반영, 다음 턴도 모두 통과했다.
- 개발 중 실제 호출은 총 15회였다(초기 3회, 기본 후속 턴 확인 4회, low 확인 4회, high 재전송 확인 4회). 중간에 “reasoning이 반드시 있어야 한다”는 테스트 기대가 실패해 기본 기능 테스트와 reasoning 전용 테스트를 분리했다.
- 키, 암호화 문자열, 개인 대화 내용은 로그에 출력하지 않았다. 세션 저장/resume는 JSON 왕복으로 확인했으며 실제 CLI /resume 및 전체 MCP 목록을 붙인 실연결은 이번 검증 범위가 아니다.

## 다음 범위

Anthropic Messages + Haiku, API 선택 설정, 스트리밍, 서버 측 상태·압축, 캐싱 정책은 이번에 구현하지 않았다. AIProxy에서 성공했다고 Farm 직접 연결까지 확인한 것은 아니다.

## 확인 자료

- 내부 연결 정보: `/Users/choechiwon/bagelcode/aiproxy-docs/aiproxy-connection-guide.md`, 같은 폴더의 `passthrough-api-guide.md`.
- [OpenAI Responses 생성 규격](https://developers.openai.com/api/reference/cli/resources/responses/methods/create): instructions/input, store, include, max_output_tokens.
- [Function calling](https://developers.openai.com/api/docs/guides/function-calling): 함수 정의, call_id와 결과 연결, strict false.
- [Reasoning 모델](https://developers.openai.com/api/docs/guides/reasoning): 수동 기록 관리 시 원본 reasoning 항목 재전송. 최신 공식 문서는 store false에서 encrypted_content가 기본 포함되며 include를 계속 허용한다고 설명한다. 프록시에는 내부 가이드의 명시적 include를 유지해 실측했다.
- [Phase 안내](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.5): 수동 재전송 시 assistant phase 보존 원칙.
