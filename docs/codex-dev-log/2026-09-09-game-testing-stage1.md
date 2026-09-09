# Game Testing 단계 1 — 고정 배속 플러그인

작성일: 2026-09-09

계획: [2026-09-09-game-testing-plugin-plan.md](2026-09-09-game-testing-plugin-plan.md) 11절 단계 1.
전제: [2026-09-09-game-testing-stage0.md](2026-09-09-game-testing-stage0.md)의 결론과 사용자 결정 3건(컨텍스트 분리 안 함, 스케줄러는 하네스, 정지 중 일반 툴은 스킬 지침으로 금지).
범위: 1-a 플러그인 소유 스킬 확장, 1-b 컨트롤러·브리지·스케줄러·툴 5개·스킬, 1-c 실제 모델(Farm Luna) 관찰→입력 루프 smoke.

## 채택한 구조

```text
모델 → ToolManager → tools/game-testing.ts (툴 5개)
                        → game-testing/test-run.ts (테스트 1건: 스케줄러·키·관찰·정리)
                        → game-testing/bridge.ts (127.0.0.1 HTTP + 토큰)
                        → game-testing/mcp-controller.cjs (Playwright MCP 프로세스 안, --init-page)
                        → page.clock / page.keyboard / page.screenshot
```

- `mcp-servers.ts`가 Playwright MCP 실행 인자에 `--init-page <mcp-controller.cjs>`를 항상 붙인다. MCP는 탭이 생길 때마다 이 파일의 `default({ page })`를 호출하고, 컨트롤러는 첫 호출에서 HTTP 서버를 열어 `<output-dir>/game-testing.json`에 `{ port, token, pid }`를 기록한다(mode 0600, 종료 시 삭제).
- 연결 정보 전달은 소켓·환경변수 대신 파일을 택했다. Unix 소켓은 macOS 경로 104바이트 제한에 걸릴 수 있고, MCP SDK의 stdio 전송은 `env`를 주면 기본 환경을 통째로 바꾼다. 컨트롤러는 자기 `process.argv`의 `--output-dir`에서 파일 위치를 알아내므로 하네스 쪽 `playwrightOutputDirectory(paths)`와 규칙만 공유한다.
- 브리지는 호출마다 파일을 읽는다. MCP가 재시작되면 포트·토큰이 바뀌므로 캐시하지 않는다. 파일 없음·연결 거부·토큰 불일치를 각각 모델이 다음에 할 일(browser_navigate로 탭 열기 등)을 담은 한국어 오류로 바꾼다.
- Clock은 컨텍스트 단위이고 두 번 설치할 수 없다. 컨트롤러는 컨텍스트별 설치 여부를 기억해 두 번째 테스트부터는 `reload → pauseAt`만 한다. 정지 시각은 reload 뒤 페이지의 `Date.now()` + 200ms로, 게임이 정상 속도로 도는 구간을 로드 시간 + 0.2초로 줄였다(단계 0 검증기의 +5초 점프 대신).
- 스케줄러(`test-run.ts`): 현실 경과 × rate를 목표로 5~50ms 단위 `runFor`를 비중첩 반복한다. 한 step이 50ms를 넘는 정체가 생기면 50ms만 진행하고 초과분은 `droppedMs`로 보고하며 기준점을 다시 잡는다(계획서 8절 "한꺼번에 따라가지 않는다"). pause 뒤 resume도 따라가지 않는다. `achievedRate`는 진행 중 구간에서만 계산한다.
- 키 유지: `act(keys, holdGameMs)`는 즉시 keydown하고 해제 예정 게임 시각을 기록한다. 스케줄러가 매 step 뒤 만기된 키를 keyup한다. 툴은 해제까지 기다렸다 실제 누른·놓은 게임 시각과 현실 소요를 돌려준다(rate 0.2, hold 100ms → 현실 약 500ms). 검증기 픽스처처럼 `runFor(hold)`로 점프시키지 않는다.
- 정리 순서: 진행 정지 → 누른 키 전부 keyup → `clock.resume()`. 컨트롤러 오류가 나면 `lost`로 표시하고 대기 중인 키 해제를 실패시키되 stop은 그래도 resume을 시도한다. 플러그인 비활성화 cleanup이 같은 stop을 호출한다. 플러그인 간 의존 기능은 만들지 않았다. MCP가 꺼지면 다음 요청이 실패해 `lost`가 된다.
- 툴 5개: `gameTestStart(url, rate)` — 이미 열린 탭에서 URL을 찾아(0개·2개 이상은 오류) 설치·정지 후 스케줄러를 바로 시작한다. `gameTestClock(status|pause|advance|resume)`. `gameTestObserve` — 텍스트(observationId·게임 시간)와 이미지 블록을 함께 돌려주어 기존 이미지 경로를 탄다. `gameTestAct(keys, holdGameMs, observationId?)`. `gameTestStop`. 동시에 하나만 허용하고 testId 불일치는 거부한다.
- 스킬 `game-testing/skills/game-testing/SKILL.md`: 절차(navigate → Start → Observe/Act 루프 → Stop), 정지 중 `click`·`type`·`press_key`·`evaluate`·`run_code`·`drag`·`fill_form` 금지, 컨텍스트 전체 정지 안내, `achievedRate`·`droppedMs`·`lost` 보고 규칙, 감속 성공 ≠ 정상 속도 성공.

## 1-a 플러그인 소유 스킬

- `HarnessPlugin.skills?: string[]`(SKILL.md 절대 경로). `extension-runtime.ts`의 `scanSkills`가 파일 스킬을 읽은 뒤 켜진 플러그인의 스킬을 `parseSkillMetadata`로 검증해 합친다. 같은 이름은 사용자가 편집하는 파일 스킬을 유지하고 플러그인 스킬을 건너뛰며 경고한다.
- 시작 시 플러그인 적용 뒤 스킬을 만들고, 플러그인 토글은 성공·실패와 무관하게 `scanSkills`를 다시 돈다. 개별 스킬 off 설정은 플러그인 스킬에도 적용된다.

## 배포

- `mcp-controller.cjs`와 `skills/`는 tsc 출력이 아니라 `pnpm build`가 `dist/game-testing/`으로 복사한다. `package.json` `files`에 `dist/game-testing/**` 추가. `tests/package-smoke.ts`의 목록 검사를 이에 맞게 확장했다.

## 검증

- `node --test tests/game-testing.test.ts`: 모의 브리지·가짜 시계로 6개 통과 — rate 추종(±5ms)과 비중첩, 정체 뒤 50ms 상한·`droppedMs` 250, act 유지 100~105ms·현실 1000~1100ms, stop 순서 `up → up → resume`·재호출 무반복, lost 전파, 툴 5개의 탭 확인·단일 테스트·인자 검증·이미지 블록·cleanup.
- `node --test tests/extensions.test.ts`: 9개 통과(플러그인 스킬 노출·충돌·토글·실패·재검색 1개 추가).
- `pnpm test:game-testing`(실제 headless 브라우저, 모델 없음): A·1~6 유지, C 통과 — Start(rate 0.2) → Observe 이미지 → Act(ArrowLeft 게임 100ms / 현실 502ms) → pause → advance(300)에 HUD ticks 정확히 +3 → resume → Stop(resume 성공, 해제 키 없음) → 재개 후 ticks 5→9 → 재시작 시 `freshClockInstall=false`. 검증 페이지의 HUD는 rAF 지연 없이 타이머 안에서 갱신하도록 바꿨다.
- `pnpm test` 240개, `pnpm exec tsc --noEmit`, `pnpm build`(dist 자산 복사 확인), `pnpm test:package`(pack → 임시 전역 설치 → 다른 cwd에서 실행 → MCP 3개 연결), `git diff --check`: 통과.
- `pnpm test:game-testing --model farm`(1-c, 유료, 2회 실행): 앱과 같은 배선(`createExtensionRuntime` → 내장 플러그인 전체 + Playwright MCP → `createAgent`)으로 "game-testing 스킬로 rate 0.1 테스트를 시작해 ArrowLeft를 관찰 사이에 두 번 누르고 종료, HUD의 x와 마지막 관찰 게임 시간을 보고"를 지시했다. 기록: `game-testing-evals/2026-09-09T07-51-00-388Z-farm.json`, `…T07-52-37-790Z-farm.json`(툴 순서·인자·게임 시간·Stop 요약·답변만, 이미지·인증 정보 없음).
  - 1회차: 검증기 배선 실수로 플러그인을 game-testing 하나만 올려 `readTextFile`이 없었다. 모델은 ToolSearch ×2 → navigate → Start(0.1) → Observe → Act → Observe → Act → Observe → Stop을 11회 호출로 수행하고 x 160·게임 시간 1595ms를 정확히 보고했다(게임 시간 180→695→1595, 금지 툴 0회, 달성 배속 0.0997). 스킬 읽기 항목은 판단 불가.
  - 2회차(내장 플러그인 전체): **통과.** `readTextFile(SKILL.md)`를 먼저 읽고 → ToolSearch → navigate → Start(rate 0.1) → Observe → Act(ArrowLeft, holdGameMs 1) → Observe → Act → Observe → Stop. 모델 호출 11회, 현실 34.6초. 관찰 시점 게임 시간 195→805→1330ms(모델이 생각하는 동안 배속대로 진행), 금지 툴 0회, Stop 요약 `clockResumed: true`·달성 배속 0.100·`droppedMs 0`, 하네스가 직접 읽은 HUD x 160(200에서 두 번 이동), 답변에 같은 값. 계획서 11절 단계 1 통과 조건("사용자가 정한 느린 배속에서 실제 모델이 화면→키 입력 루프를 수행하고, 기다리는 동안 게임이 계속 천천히 진행함을 로그로 확인") 충족.
  - 모델은 `holdGameMs`를 최솟값 1로 택했다(탭 입력). 키 유지 길이를 판단하게 하려면 스킬 지침에 게임별 안내가 필요할 수 있다. 단계 3에서 본다.
- 미실행: 실제 테트리스, 정상 속도 검증, Haiku·AIProxy Luna 연결에서의 같은 smoke. 감속 플레이 성공은 정상 속도 QA 성공이 아니다.

## 알려진 제약

- 정지 중 모델이 금지된 일반 툴을 부르면 그 호출은 `gameTestStop`(resume)까지 멈춘다. 하네스는 막지 않는다(사용자 결정 3).
- 같은 컨텍스트의 다른 탭도 함께 정지한다(사용자 결정 1).
- `pressedAtGameMs`는 keydown 시점의 스케줄러 게임 시간이며 진행 중인 `runFor` 한 step(≤5ms)만큼 어긋날 수 있다. 지연 계측 정밀화는 단계 2.
- 배속 자동 산정·지연 표본 통계는 단계 2. `observationId`는 Act 결과에 그대로 되돌려 주기만 한다.
