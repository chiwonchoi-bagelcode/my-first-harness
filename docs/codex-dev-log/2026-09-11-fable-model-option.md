# 모델 선택지 fable 추가

작성일: 2026-09-11

## 배경

게임 플레이 실험(단계 1·2, 텍스트 상태 계약·플레이 두뇌·추론 강도·턴제)은 사용자 판단으로 마지막 커밋(447c274)으로 되돌렸다. 코드·문서·기록은 `git stash` 항목 "2026-09-11 game-play stage1-2 + probes + docs (rolled back at user request)"에 보관되어 있다. 실험에서 남은 결론은 "지각과 시간을 걷어내도 모델의 배치 판단이 병목"이었고, 사용자는 이를 모델 지능 문제로 보고 현재 방식(시계 감속 + 스크린샷 관찰 + 키 입력)을 그대로 두고 모델만 더 강한 것으로 바꿔 직접 테스트하기로 했다.

## 변경

- `model-config.ts`: `fable` 선택지. Haiku와 같은 AIProxy Anthropic 경로(`/anthropic/v1`, bearer)로 `claude-fable-5-1`을 연결한다. 이미지 지원, SSE 스트리밍, 프롬프트 캐시 표시, 기본 출력 한도 32,000. 컨텍스트 예산은 프록시의 실효 한도를 확인하지 못해 Haiku와 같은 200K로 둔다. 확장 사고는 켜지 않는다(이 어댑터는 `thinking` 옵션을 보내지 않음).
- `my-first-harness.ts`: 토큰 선택은 기존 로직 그대로(farm만 `BCF_API_KEY`, 나머지는 `AIPROXY_TOKEN`). 주석만 갱신.
- `tests/anthropic-messages.test.ts`: 모델 선택 테스트에 fable 경로·모델 이름 확인 추가.
- `CLAUDE.md` 실행 명령 주석에 fable 추가. README는 요청이 없어 건드리지 않았다.

실행: `node my-first-harness.ts fable` 또는 `node my-first-harness.ts fable --tui`. TUI 상단 표시줄에 모델 이름이 그대로 나온다.

## 검증

- 모의: `pnpm test` 전체 통과, `pnpm exec tsc --noEmit`, `git diff --check` 통과.
- 실제: AIProxy에 `claude-fable-5-1`, `claude-opus-5`, `claude-sonnet-5`로 한 단어 요청을 보내 셋 다 정상 응답을 확인했고(각 2~4초), `createModelAdapter("fable")` 경로로도 한 번 더 확인했다. 게임 플레이 실측은 사용자가 직접 한다.

## 남긴 것

- Fable의 확장 사고(adaptive thinking)는 켜지 않았다. 켜려면 어댑터에 `thinking: { type: "adaptive" }` 전송을 추가해야 하고, 사고 토큰이 응답 지연을 늘리므로 게임 배속 산정에 영향을 준다.
- 프롬프트 캐시가 실제로 읽히는 최소 접두어 길이는 모델마다 다르다. Fable에서의 캐시 읽기 수치는 실행 기록(JSONL)의 usage로 확인할 수 있다.
