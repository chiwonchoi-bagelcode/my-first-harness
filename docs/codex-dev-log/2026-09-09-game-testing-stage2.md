# Game Testing 단계 2 — 적용 확인·지연 측정·배속 결정을 스킬 파이프라인으로

작성일: 2026-09-09

계획: [2026-09-09-game-testing-plugin-plan.md](2026-09-09-game-testing-plugin-plan.md) 9절·11절 단계 2를 사용자 지시로 축소했다.
전제: [2026-09-09-game-testing-stage1.md](2026-09-09-game-testing-stage1.md).

## 사용자 지시 (2026-09-09)

측정과 배속 설정은 스킬이 모델에게 파이프라인 초반에 시키는 절차로 둔다. 순서는 (1) 이 게임에 시계 제어가 적용되는지 확인 → (2) 캡처→전송→판단→입력의 현실 시간 L을 측정 → (3) 인간 반응 시간 H로 나눠 배속을 정해 적용 → (4) 그 배속으로 재측정·재조정 없이 관찰→입력 루프를 돌린다. 여러 표본의 통계는 만들지 않는다. 실제 모델로 스킬이 이 순서를 따르는지 확인하는 마지막 테스트는 사용자가 직접 한다.

## 하네스에 추가한 것 (셋)

- **`gameTestClock { action: "check" }`** — (1)을 코드가 보장한다. 진행을 멈추고 화면 두 장 → 게임 시간 500ms 진행(`CHECK_ADVANCE_MS`) → 한 장을 찍어 PNG 바이트의 SHA-256으로 비교한다. `frozenWhilePaused`(앞 두 장이 같음)·`changesOnAdvance`(세 번째가 다름)·`verdict`(controllable / not-frozen / no-change-on-advance)를 돌려주고 확인 전 상태(진행 중이면 진행, 정지면 정지)로 돌려놓는다. 정지된 메뉴 한 장을 증거로 삼지 않게 "진행 뒤 달라지는가"를 함께 본다(계획서 6절).
- **`gameTestAct` 결과의 `observationToInputMs`·`observationToInputGameMs`** — (2)의 측정값. `gameTestObserve`가 관찰 ID별로 캡처 완료 시각(스크린샷 바이트 도착, 하네스 단조 시계)과 게임 시간을 기억하고, `observationId`를 받은 Act가 keydown 전송 완료 시각과의 차이를 현실·게임 시간으로 계산한다. 페이지에 실제 적용된 시각은 재지 않으므로 전송 완료 시각을 대용으로 쓴다(계획서 9절). 모르는 ID는 키를 누르기 전에 거부한다. 관찰 결과에 `imageHash`도 추가했다.
- **`gameTestClock { action: "rate", rate }`** — (3)에서 Stop → Start(페이지 새로고침)를 거치지 않고 진행 중인 게임에 배속을 적용한다. 내부는 pause → rate 교체 → resume이라 스케줄러가 기준점을 다시 잡고 따라가기 점프가 없다. `achievedRate`는 새 배속 구간만 반영하도록 누적을 초기화한다.

`test-run.ts`는 `status`·`advance`를 내부 함수로 바꾸고 `check`·`setRate`를 추가했다. 툴 스키마는 `action` enum 두 값과 `rate` 인자만 늘었다.

## 스킬 문서

`game-testing/skills/game-testing/SKILL.md`를 6단계 파이프라인으로 다시 썼다: Phase 1 열기·임시 rate 0.1로 Start → Phase 2 `check`(no-change면 시작 키를 누르고 재확인, 그래도 안 되면 "시계 제어 불가"로 보고 후 Stop; not-frozen이면 움직이는 요소를 보고에 명시) → Phase 3 진짜 판단으로 Observe → Act(observationId) 한 번, `observationToInputMs`가 L → Phase 4 H 기본 250ms(사용자 값 우선, "실험용 선택값"이라고 명시), `rate = H / L`을 [0.01, 1]로 잘라 소수 셋째 자리, `gameTestClock rate` → Phase 5 고정 배속 루프, 재측정·재조정 금지, `observationToInputGameMs`로 H 근접 여부 관찰 → Phase 6 Stop, 보고에 verdict·H·L·rate·게임 지연 값·미검증 항목. 금지 툴 목록과 컨텍스트 전체 정지 안내는 유지.

단계 1의 실제 실행 기록으로 계산해 보면 관찰 간격이 현실 약 5~6초였으므로 H=250ms 기준 rate는 약 0.045다. 당시 임시값 0.1은 그보다 두 배 빨랐다. 이 판단을 이제 모델이 스킬 절차 안에서 숫자로 한다.

## 검증

- `node --test tests/game-testing.test.ts`: 10개 통과. 추가 4개 — `check` 세 판정(시계로만 바뀌는 화면 → controllable, 캡처마다 바뀌는 화면 → not-frozen, 안 바뀌는 화면 → no-change-on-advance)과 확인 전 상태 복귀; `setRate` 뒤 게임 시간 유지·새 배속 추종(±5ms)·`achievedRate` 초기화·잘못된 값과 종료 뒤 거부; `observationId` 지연 계산(정지 중 흐른 현실 750ms가 그대로 L, 게임 지연은 한 step 이내)과 모르는 ID 거부 시 키 미입력; ToolManager를 통한 `check`·`rate`(값 누락·범위 오류 포함)·지연 필드 전달.
- 테스트 정비: 단정 실패 뒤 가짜 시계 스케줄러가 `setImmediate`로 계속 돌아 프로세스가 끝나지 않던 문제를 `t.after(() => run.stop())`으로 막았다. 지연 테스트는 관찰 중 루프를 멈추고 생각 시간을 명시적으로 흘리는 방식으로 고쳤다(sharp 디코드 동안 가짜 시간이 앞서 나가던 가정 오류).
- `pnpm test:game-testing`(실제 headless 브라우저, 모델 없음): C 확장 통과 — Start(rate 0.2) → `check` controllable → Observe → Act(관찰→입력 현실 6ms·게임 0ms, 배속과 일치) → `rate` 0.05 → 같은 100ms 유지가 현실 2,005ms(0.2일 때 487ms) → 이후 단계 1 검증 유지.
- `pnpm test` 244개, `pnpm exec tsc --noEmit`, `git diff --check`: 통과. 전체 실행 중 한 번 `tests/images.test.ts`의 "PNG를 읽고 파일 형식·크기·치수·경로 오류를 거절한다"가 실패했으나 단독 실행과 재실행에서 통과했고 이번 변경은 이미지 코드를 건드리지 않았다. 병렬 실행 간섭으로 보이며 원인은 확인하지 않았다.
- 검증기 D(`--model`)의 단정을 새 파이프라인 기준으로 바꿨다(코드 작성·타입체크만, 실행은 사용자 몫): 관찰 전 `check`가 있고 판정이 controllable, `observationId`를 넘긴 Act로 L 측정, 그 뒤 `rate` 적용 정확히 한 번, 적용값이 `250 / L`(0.01~1로 절단)의 ±25% 안, 달성 배속은 적용 rate 기준. 결과 JSON에 `checkVerdicts`·`measuredL`·`appliedRate`·`expectedRate`를 남긴다.
- 미실행: 실제 모델이 새 스킬의 6단계를 따르는지(`pnpm test:game-testing --model farm`, 유료, 사용자가 직접), 실제 테트리스, 마우스 입력.

## 알려진 제약

- `check`는 게임 시간을 500ms 진행시킨다. 시작 화면에서 실행하면 아무것도 바뀌지 않아 no-change가 나오며, 스킬이 시작 키 입력 후 재확인을 안내한다.
- L은 한 번 측정이다. 모델의 응답 시간은 턴마다 다르므로 배속은 근사다. 스킬은 이상치일 때만 한 번 더 재도록 한다.
- 화면 비교는 바이트 해시라 커서 깜빡임·CSS 애니메이션 같은 시계 무관 변화도 not-frozen으로 잡힌다. 의도한 동작이며 보고에 남기도록 했다.
