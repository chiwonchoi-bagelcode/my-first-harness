# SSE 텍스트 조각을 화면까지 스트리밍

작성일: 2026-09-10

배경: 제출 후 시니어 피드백 "SSE는 많이 써야 하니 한 번 해보라". Farm 연결은 09-08부터 `stream: true`로 SSE를 받고 있었지만(`2026-09-08-bakery-farm.md`), `readResponsesStream`이 `response.completed`까지 모아 완성본 하나로 돌려주고 `output_text.delta`는 JSONL 기록용 배열에만 쌓였다. 화면은 스텝이 끝난 뒤 `assistant-text` 한 번으로 전체 문장을 받았다.

## 범위

- Responses 어댑터(Farm Luna, AIProxy Luna)의 텍스트 조각을 어댑터 → 기록 래퍼 → 코어 → CLI/TUI로 흘린다.
- 툴 실행·JSONL 기록·세션 저장은 지금처럼 완성 응답 기준이다. 조각만으로 툴을 실행하지 않는다는 기존 원칙을 유지한다.
- reasoning 요약·툴 인자 조각의 표시, 포크·샌드박스는 범위 밖이다(피드백에서 포크·샌드박스는 불필요로 정리). Anthropic Messages 스트리밍은 처음에는 범위 밖이었으나 같은 날 후속으로 추가했다(아래 "후속" 절).
- README·세션 형식·JSONL 형식은 변경하지 않았다. 커밋은 하지 않았다.

## 설계

조각을 밖으로 넘기는 통로는 기존 `LLMObserver`에 선택적 동기 콜백 `onTextDelta?(text)`를 추가하는 것으로 했다. 관찰자는 이미 "이 호출 중에 일어나는 일을 바깥에 알리는 객체"(`onRequest`·`onResponse`)여서 `generate` 시그니처와 세 어댑터 호출부가 그대로다. `generate`가 이벤트 반복자를 돌려주는 대안은 기록 래퍼와 코어 `step`까지 바뀌어 이번 범위에 비해 컸다.

- `adapters/http.ts`: SSE 분기의 이벤트 콜백이 `events.push` 외에 `response.output_text.delta`의 `delta` 문자열을 `observer.onTextDelta`로 넘긴다. `function_call_arguments.delta`·reasoning 조각은 넘기지 않는다.
- `recorded-llm.ts`: `recordLLM(..., options: { onTextDelta? })`. 호출자가 준 콜백만 어댑터 관찰자에 넣는다. 요약(compaction)·다른 LLM에게 묻기(other-llm) 호출은 넘기지 않아 화면에 섞이지 않는다. 조각은 기록 이벤트에 넣지 않는다(원문 delta는 기존대로 `model-response.body.events`에 있다).
- `agent.ts`: `AgentEvent`에 `assistant-delta` 추가. `step()`이 작업 스텝 호출에만 콜백을 넘겨 조각을 이벤트로 바꾼다. 완성 텍스트는 기존대로 툴 호출 스텝이면 `assistant-text`, 최종이면 `turn` 반환값으로 온다.
- `model-config.ts`: AIProxy Luna에 `stream: true`. Farm과 달리 `max_output_tokens`는 계속 보낸다.
- `cli.ts`: 조각은 `process.stdout.write`로 이어 쓰고 모듈 변수 `streamed`에 모은다. 다른 이벤트가 오면 줄을 마감한다. 완성본은 `renderCliAnswer`가 받아 스트리밍한 내용과 같으면 줄만 마감하고, 다르면 완성본을 다시 쓴다. 스트리밍이 없었으면 예전처럼 `console.log`. 중단된 턴의 빈 완성본은 받은 조각을 지우지 않는다. `turn`이 던지면 줄을 마감한 뒤 오류를 전달한다.
- `tui-session.ts`: 첫 조각에 `assistant` 항목을 만들고 상태를 "응답 수신 중"으로, 이후 조각은 그 항목의 텍스트를 교체한다. 완성본이 같으면 항목을 늘리지 않고 다르면 그 항목만 바꾼다. 조각이 아닌 이벤트(툴 시작, 중단, 출력 한도 복구 등)가 오면 진행 중 항목을 그대로 확정하므로 툴 호출 사이의 답변은 별도 항목이 된다.

같은 글이 두 번 찍히지 않게 하는 책임은 UI에 둔 셈이다. 조각을 주지 않는 어댑터(Chat Completions, 또는 stream을 끈 연결)는 버퍼가 비어 있어 이전과 같은 동작이다.

## 검증

모의 테스트(`tests/streaming.test.ts` 9개 신규):

- HTTP 층: 실제 이벤트 순서(`created → output_item.added → delta ×n → output_item.done → completed`)를 5바이트 조각으로 쪼개 보내도 `output_text.delta`만 순서대로 콜백에 오고 합치면 완성본과 같다. 툴 인자·reasoning 조각은 오지 않는다. 관찰자가 없거나 콜백이 없어도 완성본 반환은 그대로다.
- 모델 선택: luna가 `stream: true`와 `max_output_tokens`를 함께 보낸다.
- 기록 래퍼: `step`에만 콜백이 전달되고 `compaction`에는 없다. 기록 이벤트에 조각이 없다.
- 코어: `assistant-delta` 순서, 툴 호출 스텝 뒤 같은 텍스트의 `assistant-text`, 요약 호출의 콜백 없음.
- CLI: 조각 이어 쓰기, 같은 완성본 미출력, 다른 이벤트 전 줄 마감, 다른 완성본 재출력, 빈 완성본에 조각 보존.
- TUI: 한 항목에 이어 붙이기, 상태 "응답 수신 중", 툴 사이 답변 분리, 다른 완성본 교체, 중단 시 조각 보존.

기존 테스트 하나(`tests/anthropic-messages.test.ts`의 모델 선택)는 luna를 JSON 응답 모의로 시험하고 있어 SSE 모의로 바꿨다. `pnpm test` 262개 통과, `pnpm exec tsc --noEmit`, `git diff --check` 통과. 이전에 기록된 이미지 테스트 간헐 실패는 이번 실행에서 나타나지 않았다.

실제 API(유료, 각 4요청):

| 명령 | 결과 |
| --- | --- |
| `pnpm test:farm` | 4회 모두 200, Content-Type `text/plain`. 첫 요청 "pong"의 조각 1개, 합친 결과가 완성본과 일치. reasoning 1회 재전송 |
| `pnpm test:responses` | 4회 모두 200, Content-Type `text/event-stream`. AIProxy가 SSE를 통과시킴. 조각 수 1 / 0(툴 호출) / 23 / 23, 첫 요청 조각 합 = 완성본 |

두 스모크에 `onTextDelta` 검증을 추가했다. `responses-smoke.ts`는 본문이 SSE가 되어 진단 출력용 `response.clone().json()`을 이벤트 분리로 바꿨다.

실제 CLI 배선(1요청): 임시 HOME·작업 폴더에서 `node my-first-harness.ts luna`를 파이프 stdin으로 실행해 "one부터 twelve까지 한 줄에 하나"를 요청했다. stdout 조각 27개가 약 0.9초에 걸쳐 단어·줄바꿈 단위로 도착했고(`one` 8117ms, `two` 8202ms, `three` 8315ms …), 전체 출력에 `twelve`가 한 번만 나와 완성본이 중복 출력되지 않았다. `/quit`로 종료 코드 0.

수동 확인용 `tests/fixtures/tui-demo.ts`의 모의 모델이 최종 답변을 120ms 간격 조각으로 흘리도록 바꿨다. 실제 터미널에서 TUI가 이어 쓰는 모습은 사용자가 확인한다.

## 한계

- 출력 한도로 잘린 응답도 조각은 화면에 나온 뒤 `[recovery]` 안내가 붙는다. 대화에는 들어가지 않는다는 기존 정책 그대로다.
- TUI는 조각마다 상태를 갱신하므로 긴 답변에서 재렌더링이 잦다. Ink의 렌더 스로틀에 맡기고 별도 병합은 하지 않았다.
- refusal 텍스트는 조각으로 오지 않고 완성본에서만 나타나므로, 그 경우 UI가 완성본으로 교체한다.

## 후속 (같은 날): Anthropic Messages 스트리밍

사용자 요청 "하는 김에 anthropic도". 바이트 → UTF-8 → SSE 줄 규칙 → JSON 이벤트까지는 Responses와 같고, 이벤트 이름과 모양만 다르다. 그래서 줄 규칙 부분을 공용으로 빼고 Anthropic 이벤트를 완성 응답으로 조립하는 부분만 새로 썼다.

- `adapters/sse.ts`: `responses-stream.ts`에 있던 `readEvents`를 `readSseEvents(response, label)`로 옮겼다. 동작은 그대로다(UTF-8 조각, LF/CRLF/CR, 여러 `data:` 줄, `:` 주석 무시, `[DONE]` 종료). 오류 문구의 접두어만 API별 라벨을 받는다.
- `adapters/anthropic-stream.ts`: `message_start`의 message(모델·역할·입력 사용량)를 바탕으로 `content_block_start`로 블록을 만들고, `content_block_delta`의 `text_delta`·`input_json_delta`·`thinking_delta`·`signature_delta`를 해당 블록에 이어 붙인다. tool_use 인자는 JSON 문자열 조각이므로 `content_block_stop`에서 한 번 파싱한다(빈 문자열은 `{}`). `message_delta`에서 `stop_reason`을 받고 `usage`는 시작 때 값 위에 덧쓴다(출력 토큰은 누적값). `message_stop`에서 블록을 index 순서로 넣어 비스트리밍 응답과 같은 객체를 돌려주므로 `anthropic-messages.ts`의 이후 처리(`readContent`·`contentOf`·replay·`usageOf`)는 바뀌지 않았다. `ping`은 무시, `error` 이벤트는 실패, 완료 없는 종료는 실패. 파싱되지 않는 tool_use JSON은 종료 사유가 `max_tokens`일 때만 통과시키고(어댑터가 max-tokens로 조기 반환), 정상 종료면 오류로 드러낸다. 알 수 없는 delta 종류는 블록 내용이 빠질 수 있어 오류로 처리한다.
- `adapters/http.ts`: SSE 분기를 API별 조립 함수 표(`responses` → `readResponsesStream`, `anthropic-messages` → `readAnthropicStream`)로 바꿨다. 텍스트 조각 추출도 API별(`output_text.delta`의 `delta` / `content_block_delta`의 `text_delta.text`)이다. thinking 조각은 화면에 내보내지 않는다. Chat Completions는 스트리밍하지 않는다.
- `adapters/anthropic-messages.ts`: `stream?: boolean` 설정. 참이면 본문에 `stream: true`를 넣고 `requestJSON`에 stream 여부를 전달한다.
- `model-config.ts`: haiku에 `stream: true`.

검증(모의): `tests/streaming.test.ts`에 5개 추가 — text_delta 순서·완성본·종료 사유·누적 사용량(입력 25, 출력 12); tool_use 인자 세 조각 복원과 인자 없는 호출의 `{}`, thinking·서명 조각의 replay 보존과 화면 조각 미전달; `max_tokens`로 잘린 JSON은 max-tokens로 반환하고 정상 종료의 미완성 JSON은 실패; 오류 이벤트·완료 없는 종료·`message_start` 없는 시작·시작 없는 블록 조각의 실패; haiku 연결이 `stream: true`와 `max_tokens: 32000`을 함께 보냄. `tests/anthropic-messages.test.ts`의 haiku 모델 선택 테스트 2개는 JSON 모의를 SSE 모의(`sseReply`)로 바꿨다. `pnpm test` 267개, `pnpm exec tsc --noEmit`, `git diff --check` 통과.

검증(실제 API, 유료): `pnpm test:anthropic` 4요청 모두 200, Content-Type `text/event-stream`. AIProxy의 Anthropic 경로도 SSE를 통과시킨다. 조각 수 2 / 0(tool_use) / 4 / 1, 첫 요청의 조각 합이 완성본과 일치. 두 번째 요청은 실제 `input_json_delta`에서 복원한 인자 `label: "adapter-smoke"`가 스키마 검증을 통과했다. 스모크의 진단 출력은 SSE 이벤트 분리로 바꿨고, `--mcp` 경로의 서버 수 단정은 09-09 정리 이후 2개인데 4개로 남아 있어 함께 고쳤다(그 경로는 이번에 실행하지 않았다).

실제 CLI 배선의 Haiku 스트리밍은 별도로 돌리지 않았다. 어댑터 위의 층(기록 래퍼·코어·CLI·TUI)은 API를 구분하지 않으며 Luna로 이미 실측했다.
