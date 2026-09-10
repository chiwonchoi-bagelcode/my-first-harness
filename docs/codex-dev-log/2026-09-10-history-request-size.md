# 실행 기록의 요청 본문 중복 축소

작성일: 2026-09-10

## 문제

플레이 세션 `c90b42a6-1134-40be-a392-c5e5b67ee145.jsonl`(모델 호출 146회)이 172MB였다. 이벤트 종류별로 재본 결과다.

| 이벤트 | 건수 | 용량 | 안에 든 이미지 블록 |
| --- | ---: | ---: | ---: |
| model-start | 146 | 73.9 MB | 1,294개 (48 MB) |
| model-request | 146 | 67.8 MB | 1,294개 (48 MB) |
| model-response | 146 | 17.4 MB | 0 |
| message | 300 | 2.1 MB | 46개 (1.5 MB) |
| attachments 폴더의 고유 이미지 | 46장 | 1.1 MB | |

원인은 이미지 자체가 아니라 **요청 본문 전체를 스텝마다 두 벌(하네스 형식 `model-start`, 전송 형식 `model-request`) 기록한 것**이다. 요청에는 그때까지의 대화 전체가 들어가므로 같은 메시지가 뒤따르는 모든 요청 기록에 반복된다. 이미지 46장이 1,294번씩 두 벌 적혔고, 이미지를 빼도 두 이벤트의 텍스트만 45MB다. 메시지를 한 번씩만 적는 `message` 이벤트는 이미지를 포함해도 2.1MB다.

## 참고한 구현

세 하네스 모두 API 요청 본문을 세션 기록에 저장하지 않는다. 대화를 한 번씩만 기록하고 요청은 기록에서 다시 조립한다.

- Claude Code: 세션 JSONL(`~/.claude/projects/<프로젝트>/<세션>.jsonl`)은 메시지만 담는다. 이 Mac의 기록 파일 어디에도 `max_tokens` 같은 요청 필드가 없다.
- Codex(`codex-rs/rollout/src/policy.rs`, `is_persisted_rollout_item`): `ResponseItem`(Message, FunctionCall, FunctionCallOutput, Reasoning 등)과 일부 이벤트만 저장하고 `RawResponseItem`·`RawResponseCompleted`는 `false`다. 요청별로는 `TokenUsageRecord`·`TurnContext` 같은 작은 항목만 남긴다. 로컬 이미지는 `protocol/src/models.rs`에서 data URL로 바꿔 user Message 항목에 한 번 저장하고, 요청 때 `core/src/image_preparation.rs`가 다시 축소하지만 그 결과는 저장하지 않는다.
- DSH: 이미지 바이트는 `packages/attachment/attachment-local/src/store.ts`가 `DSH_HOME/attachments/v1/objects/<앞2자>/<sha256>`에 한 번 저장하고 세션 로그에는 `ImageAttachmentRef`(sha256 id, 형식, 크기)만 남긴다. 세션 이벤트 목록(`packages/core/session/src/known-event-types.ts`)에 요청 본문 이벤트는 없고 `request/header`는 헤더만 담는다.

## 사용자 결정

요청 본문을 남기는 이유(API 형식 학습, 어댑터 디버깅, 스텝별 실제 입력 분석)는 이 프로젝트에서 유효하므로 없애지 않는다. 대신 (1) 요청 기록 안의 이미지 바이트를 참조로 바꾸고 (2) 요청 본문은 전송 형식 한 벌만 남긴다. 대화 기록(`message`)과 세션 JSON은 그대로 base64를 보존한다. resume와 요청 조립은 여기서 읽는다.

## 변경

- `adapters/wire-log.ts` 신규: `omitImageData(api, body)`. 전송 본문의 복사본에서 Responses `input_image`의 data URL과 Anthropic `image.source(base64)`의 `data`를 `[image data omitted from log: <형식>, <바이트 수>, sha256 <해시>]` 문자열로 바꾸고 바꾼 수를 돌려준다. 원격 URL과 텍스트는 건드리지 않는다. Chat Completions는 텍스트 전용이라 순회하지 않는다. 제공자 필드 이름은 `adapters/` 안에만 둔다는 규칙을 유지한다.
- `adapters/http.ts`: 실제 전송은 그대로 두고, 관찰자(`onRequest`)에는 이미지가 생략된 복사본을 넘긴다. `WireRequest.imageDataOmitted`(선택)에 바꾼 수를 담는다.
- `execution-history.ts`: `model-start.request`가 `LLMRequest` 전체 대신 `RequestSummary { systemChars, messageCount, imageCount, toolNames, estimatedTokens, maxOutputTokens? }`다. `recorded-llm.ts`의 `summarizeRequest`가 계산한다. `estimatedTokens`는 코어가 압축 판단에 쓰는 `estimateRequestTokens`와 같은 값이다.
- 이미지 앞에 붙는 경로 안내 텍스트(원본 경로, 보관 경로, 축소 크기)는 요청 본문에 그대로 남아 어떤 이미지였는지 알 수 있다. sha256은 실제 전송된(축소된) 바이트의 해시이므로 attachments 파일의 해시와는 다를 수 있다.
- `model-response`(Farm SSE 이벤트 전체, 17.4MB)와 `context-update`의 이미지(1.3MB)는 이번 범위에서 바꾸지 않았다. `message` 이벤트·세션 JSON을 DSH처럼 참조로 바꾸는 것은 세션 형식 변경이 필요한 별개 과제다.

## 검증

- `tests/history-request-size.test.ts` 4개: `omitImageData`의 Responses·Anthropic·원격 URL·Chat Completions 처리와 원본 비수정, 두 어댑터에서 모델에는 바이트 두 장이 가고 JSONL에는 base64가 전혀 남지 않으며 `model-request.imageDataOmitted`가 2이고 기록 본문이 전송 본문보다 작음, `model-start` 요약 값, 이미지 없는 요청은 기록 본문이 전송 본문과 같고 생략 수 필드가 없음.
- 기존 `tests/execution-history.test.ts`의 "기록 본문 = 전송 본문" 검사는 이미지 없는 요청이라 그대로 통과한다.
- 실측 재현: 위 172MB 로그를 새 규칙(model-request 이미지 생략, model-start 요약)으로 다시 직렬화하면 164.3MB → 42.4MB. 남는 것은 model-request 19.8MB(스텝마다 반복되는 대화 텍스트), model-response 17.4MB, message 2.1MB, tool-end 1.6MB, context-update 1.3MB.
- 실제 모델 API는 호출하지 않았다. 기존 세션 파일은 수정·삭제하지 않았다. 새 규칙은 이 코드로 기록하는 새 세션부터 적용된다.
