# Game Testing 단계 0 — 연결·감속 가능성 검증 결과

작성일: 2026-09-09

계획: [2026-09-09-game-testing-plugin-plan.md](2026-09-09-game-testing-plugin-plan.md) 11절 단계 0.
재현: `pnpm test:game-testing` (`tests/game-testing-smoke.ts`, 픽스처 `tests/game-testing-init-page.cjs`). 모델 호출 없음, API 비용 없음. headless Chromium과 Playwright MCP 0.0.80 프로세스만 사용한다.

## 결론

- 계획서 7절의 **1안(하네스 → 기존 MCP Client → `browser_run_code_unsafe` → `page.clock`)은 그대로는 불가능하다.** `run_code_unsafe`를 포함해 `waitForCompletion`을 거치는 모든 MCP 툴이, 시계가 정지된 탭에서 MCP 서버 자신의 settle 대기에 걸려 반환하지 않는다.
- 계획서 7절의 **대안(같은 브라우저를 소유하는 MCP 측의 지속 실행 컨트롤러)은 MCP 공식 옵션 `--init-page`로 구현 가능하고, 단계 0의 여섯 항목을 모두 통과했다.** 감속 루프의 `runFor` 왕복 중앙값 5.6ms, 요청 배속 0.1에 달성 0.0993, backlog 4ms.
- 새로 확인한 제약 둘: (1) Playwright Clock은 **페이지가 아니라 브라우저 컨텍스트 단위**다. (2) 정지 중에는 모델의 일반 브라우저 툴 중 `click`·`type`·`evaluate`·`run_code_unsafe` 등이 같은 컨텍스트의 어느 탭에서든 멈춘다. `screenshot`·`snapshot`·`navigate`·`tabs`는 동작한다.
- 계획서 14절대로 이 문서는 구현 승인이 아니다. 대안 채택 여부와 아래 설계 변경을 확인받은 뒤 단계 1을 진행한다.

## 1안이 실패하는 원리

MCP 서버의 `Tab.waitForCompletion`은 액션 뒤 settle(기본 500ms)을 **페이지 안의 `setTimeout`으로** 기다린다.

```js
async waitForTimeout(time) {
  if (this._javaScriptBlocked()) { await new Promise((f) => setTimeout(f, time)); return; }
  await this.page.evaluate((ms) => new Promise((f) => setTimeout(f, ms)), time).catch(() => {});
}
```

`page.clock.pauseAt()` 뒤에는 이 `setTimeout`이 가짜 타이머가 되어 울리지 않는다. 그래서 시계를 정지시킨 `run_code_unsafe` 호출 자체가 반환하지 않고, 이후 같은 경로의 호출도 모두 멈춘다. `--timeout-settle 0`도 소용없다. 정지 중에는 0ms 가짜 타이머도 울리지 않는다(8초 타임아웃 3회 확인).

재현 결과(검증기 A). A(pauseAt)를 보내고 1.5초 뒤 B(runFor 600), 다시 1.5초 뒤 C(resume)를 동시에 보냈다.

| 호출 | 왕복 | 해석 |
| --- | ---: | --- |
| install+goto (정지 없음) | 1,020ms | 정상. settle 500ms 포함 |
| A: pauseAt | 1,653ms | B가 가상 시간 600ms를 진행시켜 A의 settle 타이머가 울릴 때까지 멈춤 |
| B: runFor(600) | 2,017ms | C가 시계를 재개해 500ms 실시간이 흐를 때까지 멈춤 |
| C: resume | 517ms | 정상 |

정지 상태에서 멈추는 툴과 동작하는 툴을 번들에서 `waitForCompletion` 사용 여부로 분류했다.

- 멈춤: `click` `drag` `drop` `evaluate` `file_upload` `handle_dialog` `mouse_click_xy` `mouse_drag_xy` `press_sequentially` `run_code_unsafe` `type`. `press_key`는 조건부이며 정지 중 `ArrowLeft` 단독 입력은 8ms에 반환했다.
- 동작: `navigate` `reload` `snapshot` `take_screenshot` `tabs` `wait_for` `mouse_down/up/move` 등. `keydown`/`keyup`은 `skillOnly`라 MCP 툴 목록에 나오지 않는다(하네스가 실제로 받은 목록에도 없음). 즉 키 유지(hold)는 일반 MCP 툴로 불가능하다.

## 대안의 동작 원리

Playwright MCP는 `--init-page <파일>`을 받으면 **탭이 생길 때마다 MCP 프로세스 안에서** `require(파일).default({ page })`를 await한다. `require` 캐시 덕분에 모듈 상태가 프로세스 수명 동안 유지된다. 검증기의 픽스처 `tests/game-testing-init-page.cjs`는 이 훅에서 page 객체를 보관하고 로컬 HTTP로 `install`·`runFor`·`pauseAt`·`resume`·`keydown`·`keyup`·`state`·`screenshot`을 받는다. 이 경로는 MCP 툴 호출이 아니라 프로세스 안의 Playwright 호출이므로 settle 대기가 없다.

계획서 7절이 금지한 "별도 MCP/브라우저를 몰래 새로 띄우거나 공유 전역 객체에 타이머를 숨기는 방식"이 아니다. 같은 브라우저, 같은 MCP 프로세스, MCP가 문서화한 진입점이다. 탭 고정은 URL이나 nonce가 아니라 실제 `Page` 객체 참조로 한다.

## 검증기 B 결과 (init-page 컨트롤러)

| 항목 | 결과 | 측정 |
| --- | --- | --- |
| 1. MCP가 가진 페이지에 Clock 설치 | 통과 | `navigate` 422ms → 컨트롤러 기동 → install+reload+pauseAt 14.7ms |
| 2. 정지 중 유지, runFor에서만 변화 | 통과 | 700ms 실대기: ticks·frames·Date 불변 → runFor(1000) 326ms: ticks +10, frames +63, Date +1000 |
| 3. 키 입력·canvas·이미지 | 통과 | keydown → runFor(250) → keyup: 게임시간 250ms, 현실 73ms. 정지 중 MCP screenshot 19ms·snapshot 13ms 정상. 컨트롤러 screenshot 32.7ms(1280×720) → `imageFromBytes` 변환 정상 |
| 4. 대기 중에도 시간 진행 | 통과 | 6,003ms 동안 runFor 116회, 평균 step 5.1ms, 달성 배속 0.0993(요청 0.1), backlog 4ms. 왕복 min/median/max 2.9/5.6/10.2ms |
| 5. 다중 탭에서 오조작 없음 | 통과 | 새 탭이 MCP 선택 탭이 된 뒤에도 컨트롤러 i=0의 runFor(500)는 게임 탭만 진행(+5 ticks) |
| 6. 감속 루프가 막히지 않음 | 통과 | 루프 중 동시 MCP screenshot 21ms·snapshot 9ms, 루프 최대 공백 62ms |

한계로 기록한 두 항목.

- **정지 중 `browser_evaluate`는 멈춘다.** 컨트롤러 `resume` 1.5초 뒤 2,014ms에 완료. `click`·`type`·`run_code`도 같은 경로다.
- **Clock은 브라우저 컨텍스트 단위다.** `Clock.install`은 `this._browserContext._channel.clockInstall(...)`로 보낸다. 실측: 두 탭 모두 `visibilityState: "visible"`인데 decoy 탭의 50ms 타이머가 300ms 실대기 동안 0회, 게임 탭 `runFor(500)` 뒤 정확히 10회, decoy의 `Date.now` +500. `--isolated`의 MCP는 컨텍스트 하나를 쓰므로 게임을 정지하면 모델이 열어 둔 다른 탭의 JS 시간도 함께 정지한다.

## 계획서에 반영할 변경

- 4절 "Playwright Clock은 페이지의 …" → 컨텍스트 단위로 정정. 게임 탭 전용 정지는 컨텍스트 분리가 필요하다(컨트롤러가 `page.context().browser().newContext()`로 만들 수 있으나 그 탭은 MCP 탭 목록 밖이 된다. 목표 2 "기존 Playwright MCP가 사용하는 게임 탭을 그대로 제어"와 상충하므로 선택이 필요하다).
- 6절 툴 표: 캡처·입력을 "기존 MCP/Playwright 기능을 감싼다"에서 "컨트롤러가 프로세스 안에서 직접 호출한다"로. 키 유지는 이 경로에서만 가능하다.
- 7절: 1안 삭제, 대안을 기본 설계로. 스케줄러 위치는 하네스(현재 검증기, HTTP 왕복 ~5ms)와 MCP 프로세스 내부 중 택일. 하네스 쪽이면 `runFor` 간격 하한은 500ms가 아니라 ~3ms이므로 8절의 "간격은 실제 측정 후 결정"은 해소됐다.
- 8절 감속 루프: 검증기 4번의 수치로 고정 배속 0.1은 문제없이 따라간다. 낮은 배속(예: 0.0625)은 step이 더 작아져 부담이 줄어든다.
- 10절 수명: 컨트롤러는 MCP 프로세스와 함께 살고 죽는다. MCP 토글이 곧 컨트롤러 종료다. 컨트롤러 포트 전달은 `McpServerConfig.env`로 한다(검증기는 파일 경로 env → 포트 파일).
- 새 정책 후보: 게임 테스트 진행 중 모델의 일반 브라우저 툴 중 멈추는 계열을 스킬 지침으로 금지하거나, 컨트롤러가 정지 여부를 노출해 하네스가 해당 툴 호출을 거부(`isError`)한다. 어느 쪽인지는 결정 필요.

## 변경 파일

- `tests/game-testing-smoke.ts` 신규, `tests/game-testing-init-page.cjs` 신규(검증 픽스처, 플러그인 코드 아님), `package.json`에 `test:game-testing` 추가.
- `docs/codex-dev-log/2026-09-09-game-testing-plugin-plan.md`: 별도 위치에 있던 계획서를 이 저장소로 복사. 내용 수정 없음.
- 실행 코드(`agent.ts`, `mcp-servers.ts`, 플러그인 등)는 변경하지 않았다. README 미수정.

## 검증

- `pnpm test:game-testing`: A·1~6 통과, 한계 2건 기록. 총 15.7초.
- `pnpm exec tsc --noEmit`, `pnpm test`(233개), `git diff --check`: 통과.
- 실제 모델을 넣은 관찰→입력 루프, 실제 테트리스, 정상 속도 smoke는 하지 않았다. 감속 성공은 정상 속도 QA 성공이 아니다.

## 사용자 결정 (2026-09-09)

1. 컨텍스트 분리 안 함. 게임 정지 중 같은 컨텍스트의 다른 탭이 함께 멈추는 것을 허용한다.
2. 감속 스케줄러는 하네스 프로세스에 둔다. runFor 한 번이 컨트롤러 요청 한 번이다(검증기 기준 왕복 중앙값 5.6ms).
3. 정지 중 멈추는 일반 브라우저 툴(click·type·evaluate·run_code 등)은 하네스가 막지 않고 스킬 지침으로 사용을 금지한다.
