# 공통 메시지와 첫 API 어댑터

## 범위

- 기존 Bagel OpenAI 경로와 gpt-4o는 유지한다.
- `llm-types.ts`: 텍스트/툴 호출/툴 결과 블록, Message, ReplayState, 요청/결과/어댑터 계약.
- `adapters/chat-completions.ts`: 요청·응답 변환과 HTTP 호출. 이 단계는 텍스트와 function tools만 지원한다.
- 메인 step/turn, 요약, 다른 LLM 의견 툴은 공통 형식만 사용한다.
- ToolManager는 API용 function 포장 없이 정의를 반환하고, 실행 결과에 선택적인 isError를 제공한다.

## 세션과 컨텍스트

- 시스템 프롬프트는 `session.system`으로 분리한다. history/messages는 대화 메시지만 담는다.
- 스킬 지침과 현재 작업 디렉토리는 요청의 system 문자열에 조립한다. 기존 요청 끝의 runtime system 메시지는 더 이상 별도로 보내지 않는다.
- 압축/툴 결과 줄이기는 기존 기준을 유지하되 공통 블록을 읽는다. 첫 대화 메시지도 크기 계산과 요약에 포함한다.
- 재전송 정보는 세션 JSON에 남지만 요약 프롬프트 및 문자 수 계산에서는 제외한다.
- Chat Completions의 일반 텍스트/function 응답은 공통 블록만으로 재전송한다. refusal이 있을 때만 원래 content/refusal 및 내용 일치 확인값을 replayState에 저장한다.
- 같은 어댑터/연결 경로/모델이며 내용이 일치할 때만 해당 정보를 사용한다. 임의의 원본 필드를 요청에 펼쳐 넣지 않는다.
- 구형 세션 변환/삭제는 하지 않는다. 변경 후 새 세션을 사용한다.

## 검증

- `pnpm test`: 모의 API 및 공통 어댑터로 요청 변환, 복수 호출/결과 ID, 인자 오류와 실행 오류 피드백, 종료 이유, 재전송 정보 검증, 자동 압축, 저장/resume을 확인한다.
- `tests/harness.test.ts`는 CLI/환경변수/사용자 스킬 로딩을 피하려고 메인의 클래스 및 함수 정의만 추출해 실제 step/turn을 실행한다.
- `bun x --package typescript tsc --noEmit`: 타입 검사.
- `bun build --compile my-first-harness.ts --outfile <임시 디렉토리>/my-first-harness`: 컴파일 확인.
- 실제 유료 API 호출과 키 읽기는 하지 않았다.

## 다음 단계

Responses와 Anthropic Messages 어댑터, 사용량/캐시 제어, native reasoning replay는 아직 구현하지 않았다. 출력 한도/미분류 종료는 실패로 알리며 자동 재개하지 않는다. Bakery Luna의 실제 연결 가이드 확인 후 Responses를 추가한다.

참고: https://developers.openai.com/api/reference/cli/resources/chat
