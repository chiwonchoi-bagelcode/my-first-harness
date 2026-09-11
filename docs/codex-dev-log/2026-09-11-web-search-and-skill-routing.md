# 스킬 라우팅 구조, 전략 툴 요구사항, 제공자 실행 웹 검색

작성일: 2026-09-11

## 배경

Haiku가 `createTool`로 만든 첫 전략 툴(`tetrisStrategy`, 세션 `d44856d2…`)을 점검한 결과, 조각을 실제로 떨어뜨리지 않고 "발밑 최고 높이 + 조각 높이"로 근사했고, 회전 루프는 있지만 모양을 회전하지 않았으며, 점수는 요철 합 하나였다. 9조각 219점 0줄, 구멍 16개. 모델이 툴 결과를 따르지도 않았다(툴은 회전 0, 모델은 회전 1). 문제는 장치가 아니라 "어떤 툴을 만들어야 하는가"가 어디에도 없었다는 점이다.

사용자 결정:
- 전략 툴 요구사항은 게임 테스팅 스킬 소유다(tool-making 스킬은 범용으로 유지).
- SKILL.md가 커지지 않게, 스킬 폴더 안에 보조 문서를 두고 본문은 필요한 줄에서 라우팅한다(Claude Code 스킬의 공식 구성 방식).
- 전략을 직접 짜기 전에 웹 검색으로 알려진 전략을 찾아 쓰게 한다. 검색은 하네스가 구현하지 않고 제공자의 서버사이드 툴을 쓴다.
- 테스트 중 사용자에게 보이는 출력을 최소화해 지연을 줄이라고 명시한다.

## 스킬 변경

- `game-testing/skills/game-testing/SKILL.md`(73줄): 계약 절은 3문장 요약 + `state-contract.md` 라우팅, 5단계 11번은 결정 시점 + `strategy-tool.md` 라우팅, 규칙에 "테스트 중 보이는 출력 최소화(툴 호출 사이에는 한 줄 이하, 판단은 최종 보고에)" 추가. 1단계 5번에도 계약 문서 라우팅.
- `state-contract.md`(신규): 기존 계약 규격·규칙·기존 게임에 붙이는 법 전문.
- `strategy-tool.md`(신규): 결정 기준, **알려진 전략 먼저 검색**(연결에 웹 검색이 있으면), 네 요구사항(실제 규칙으로 시뮬레이션, 예측한 다음 상태 반환, 게임의 진행 값을 점수의 주항으로, 그대로 보낼 `inputs` 반환), 첫 입력 뒤 예측과 관찰 비교로 검증, 끝나면 삭제.
- `custom-tools/skills/tool-making/SKILL.md`: 전략 절을 넣었다가 뺐다. 범용 지침만 남긴다.

시스템 프롬프트의 스킬 안내가 "상대 참조는 스킬 파일의 폴더 기준으로 해석하고 필요할 때 읽으라"고 이미 적혀 있어 라우팅에 코드 변경은 없다.

## 하네스 변경 — 제공자 실행 웹 검색

프록시 통과 여부를 원시 요청으로 먼저 확인했다(각 1회): Haiku `web_search_20250305` 3.6초 검색 1회, Fable `web_search_20260209` 18.5초(결과에 `code_execution_tool_result` 블록도 섞여 옴), AIProxy Luna `web_search` 4.7초, Farm `web_search` 스트리밍 6.3초(완료 이벤트의 output은 비어 있고 항목 완료 이벤트로 재조립). 넷 다 동작.

- `model-config.ts`: 네 연결에 `webSearch`를 켠다. Haiku는 구형 툴 이름, Fable은 신형, Luna·Farm은 `web_search`. Anthropic은 요청당 `max_uses: 5`.
- `adapters/anthropic-stream.ts`: `citations_delta` 조각을 받아 블록에 모은다(첫 실측에서 발견).
- `adapters/anthropic-messages.ts`: 함수 툴 뒤에 서버 툴을 붙인다(함수 툴이 없어도 보냄). 응답의 `server_tool_use`와 `*_tool_result` 블록을 받아 재전송 정보에 보관하고 공통 내용에는 내지 않는다. `pause_turn`은 기존 결정대로 알 수 없는 사유로 두어 명시적으로 실패한다(재전송으로 이어 가는 처리는 넣지 않았다). 스트림 파서는 이미 `input_json_delta`로 서버 툴 입력을 조립한다.
- `adapters/responses.ts`: 함수 툴 뒤에 `{ type: "web_search" }`. `web_search_call` 항목을 받아 공통 내용에서 숨기고 재전송에서는 뺀다(입력으로 되돌릴 수 없을 수 있음). 인용은 본문에 있다.
- `adapters/usage.ts`, `llm-types.ts`: `LLMUsage.webSearchRequests`(Anthropic이 보고).
- 코어 루프·툴 관리자·UI 변경 없음. 검색은 모델 응답 안에서 일어나고 원문은 JSONL에 남는다.

## 검증

- 모의: 어댑터 테스트 2개 추가(서버 툴 위치와 형식, 검색 블록 숨김·재전송 처리, 사용량). `pnpm test` 전체 통과, `pnpm exec tsc --noEmit`, `git diff --check` 통과.
- 실제: `pnpm test:web-search --model <연결>`(신규 `tests/web-search-smoke.ts`). 어댑터를 통해 "테트리스 출시 연도와 제작자를 웹에서 찾아 출처와 함께" 물었다. Farm 7.7초, 재전송 정보에 `web_search_call` 1개, 출처 URL 포함. Haiku 첫 실행은 실패했다: 검색 뒤 본문의 인용이 SSE `citations_delta` 조각으로 오는데 파서가 모르는 조각으로 거절했다. 파서에 `citations_delta`를 더해(블록의 `citations` 배열에 모아 재전송용으로 보관) 다시 돌려 3.1초, 검색 1회, 출처 URL 포함으로 통과. 이 SSE 모양을 `tests/anthropic-server-tools.test.ts`에 고정했다(서버 툴 입력 JSON 조각, 검색 결과 블록, 인용 조각, 사용량). Fable 12.6초, 검색 2회(재전송 정보에 thinking·server_tool_use×2·web_search_tool_result·code_execution_tool_result·text — 사고 블록이 기본으로 섞여 와도 어댑터가 받는다), 출처 URL 포함. Luna 8.7초, `web_search_call` 1개, 출처 URL 포함. 네 연결 모두 통과.

## 남긴 것

- 검색 툴을 항상 켜 두므로 모델이 필요 없는 검색을 할 수 있다. Anthropic은 요청당 5회 상한, 비용은 검색 회당 과금. 끄려면 `model-config.ts`의 `webSearch`를 지운다.
- `pause_turn`(검색 중 제공자가 턴을 멈춤)은 에이전트가 오류로 처리한다. 이어 가려면 응답을 그대로 되돌려 보내는 처리가 필요하지만 드물어 넣지 않았다.
- 모델이 만든 전략 툴의 품질은 여전히 모델 몫이다. 요구사항 네 줄과 검색 선행이 얼마나 바꾸는지는 사용자 실측으로 본다.
