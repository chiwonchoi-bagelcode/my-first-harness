# Bakery Farm Responses 연결

## 변경 범위

- `/Users/choechiwon/my-first-harness`의 main에서 구현했다. README, 실제 `.env`, 세션 데이터, 다른 워크트리는 수정하지 않았다.
- 인자 없는 실행의 기본값을 사용자 요청대로 `farm`으로 변경했다. `farm`은 Bakery Farm의 `gpt-5.6-luna`와 `BCF_API_KEY`를 쓴다. `luna`와 `haiku`는 기존 AIProxy와 `AIPROXY_TOKEN`을 사용한다. 키가 없을 때 다른 제공자로 대체하지 않는다.
- Farm 주소는 `https://bakery-codex-farm.bagelcode.ai/v1/responses`다. 기존 Responses 어댑터를 재사용하고 `stream: true`, `supportsMaxOutputTokens: false` 설정을 추가했다.
- Farm이 제거하는 `max_output_tokens`는 보내지 않는다. Farm에서 출력 길이 제한을 적용한 것으로 간주하면 안 된다.
- `adapters/responses-stream.ts`가 SSE를 읽어 완성된 Responses 객체를 반환한다. 기존 `step`/`turn`, 공통 메시지 형식, 툴 실행 흐름과 요약 방식은 바꾸지 않았다. 화면의 실시간 delta 출력은 이번 범위가 아니다.

## 수신 규칙

- UTF-8 분할, LF/CRLF/CR, 여러 data 줄, keepalive 주석을 처리한다. 출력 delta는 실행하지 않고 종료 이벤트를 기다린다.
- 최종 output 배열이 비어 있으면 완료된 output_item.done 항목을 순서대로 사용한다. 기존 어댑터가 텍스트·툴 호출·reasoning 형식을 검증한다.
- response.failed/error, 손상된 이벤트, 완료 이벤트 없는 EOF는 실패로 반환한다. response.incomplete는 기존 종료 이유 판정을 따른다. 자동 재시도는 추가하지 않았다.
- 실제 Farm은 HTTP 200에서 Content-Type을 `text/plain; charset=UTF-8`로 반환했다. SSE 전용 설정에서는 MIME 헤더에 의존하지 않고 SSE로 읽으며, 실제 이벤트 파싱과 완료 응답으로 성공을 판정한다.
- Farm과 AIProxy의 provider ID를 구분하므로 다른 출처의 암호화된 replay 정보는 재사용하지 않는다. 같은 출처에서는 기존 JSON 저장/resume 방식으로 유지한다.
- sticky 헤더, Farm 전용 compact v2, 이미지 입출력은 이번에 추가하지 않았다.

## 검증

- `pnpm test`: 89개 통과. 기본값·키 선택, Farm 요청 필드, SSE 분할·실패·종료, 복수 툴 및 reasoning 재전송을 포함한다.
- `pnpm --package=typescript dlx tsc --noEmit --strict`: 통과.
- `bun test tests/responses-stream.test.ts`: 9개 통과.
- `pnpm build`: 통과. `dist/my-first-harness`를 최신 기본값과 Farm 구현으로 갱신했다.
- `pnpm test:farm`: 실제 발급 키를 사용한 4요청 시나리오 통과. 텍스트 → 인자가 있는 readProbe 요청 → 로컬에서 새로 만든 UUID 결과를 사용한 답변 → 다음 턴의 동일 값 회상을 확인했다. reasoning 항목은 누적 5회 재전송됐다.
- 첫 진단 호출 1회는 MIME 헤더를 엄격히 검사한 테스트에서 중단됐고, 위 헤더 처리 수정 후 4요청을 다시 검증했다. 총 실제 요청은 5회다.
- 실연결 테스트는 어댑터와 검증용 툴 결과를 사용한다. 개인 파일·세션·MCP·셸 명령을 Farm에 보내지 않았으며, 전체 CLI/MCP 실사용이나 실제 비용 집계 검증은 아니다. 키·응답 원문은 로그에 남기지 않았다.

## 실행

```sh
node my-first-harness.ts        # Farm Luna (기본)
node my-first-harness.ts farm   # Farm Luna (명시)
node my-first-harness.ts luna   # AIProxy Luna
node my-first-harness.ts haiku  # AIProxy Haiku
pnpm test:farm                 # 실제 API 4요청 검증
```

## 근거

- https://github.com/project-bakery/bakery-codex-farm/blob/main/README.md
- https://github.com/project-bakery/bakery-codex-farm/blob/main/docs/API.md
- https://github.com/project-bakery/bakery-codex-farm/blob/main/backend/src/sanitize/body.ts
- https://developers.openai.com/api/docs/guides/streaming-responses
