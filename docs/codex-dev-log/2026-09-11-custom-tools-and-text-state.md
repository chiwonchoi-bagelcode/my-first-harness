# 모델이 만드는 툴(custom-tools)과 텍스트 상태 관찰 복원

작성일: 2026-09-11

## 배경과 결정

게임 플레이 실험의 결론은 "지각과 시간을 걷어내도 모델의 배치 판단이 병목"이었고, 그 코드는 사용자 판단으로 되돌렸다(stash 보관, [2026-09-11-fable-model-option.md](2026-09-11-fable-model-option.md) 배경 절). Fable로 바꾸자 플레이가 됐지만 목표는 "테트리스도 풀 수 있는 범용 게임 테스팅 하네스"이므로, 약한 모델(Haiku)로도 되게 하는 다음 아이디어를 사용자가 냈다.

- 모델 지능을 우회한다. 모델이 필요에 따라 **직접 툴을 만들** 수 있게 하고, 구조화된 게임 상태를 바탕으로 **결정론적 전략(손실함수)** 을 툴로 구현해 쓰게 한다. 모델은 후보 행동을 내고 툴의 점수로 고른다.
- **하네스가 조각 단위 루프를 대신 도는 것은 치팅이다.** 매 블록은 모델이 직접 툴을 불러 판단한다. 그래서 자동 플레이 루프는 만들지 않는다.
- 스킬에는 활용 방식을 적지 않는다. "게임 전략을 결정론적 손실함수로 구현할 수 있으면 툴로 만들어 써라" 한 문장만 두고, 어떻게 쓸지는 모델에 맡긴다.
- 상태 계약(텍스트 관찰)은 손실함수의 입력이 되므로 되살린다. 플레이 두뇌·추론 강도·턴제는 되살리지 않는다.

## 하네스 변경

### custom-tools 플러그인 (신규, 범용)

- `tools/custom-tools.ts`: 내장 플러그인 `custom-tools`. 관리 툴 둘을 등록한다.
  - `createTool({ name, description, parameters, code, timeoutMs?, replace? })`: 코드를 `<작업 폴더>/.my-first-harness/tools/<name>/index.mjs`, 메타데이터를 `tool.json`에 저장하고 즉시 일반 툴로 등록한다. 다음 스텝부터 모델의 툴 목록에 바로 보인다(MCP처럼 ToolSearch를 거치지 않음). 이름 규칙 `^[a-z][A-Za-z0-9_]{0,39}$`, 예약 이름 거절, 스키마는 `type: "object"`이고 컴파일돼야 함(기존 Ajv 검증기 재사용), 코드 64KB 이하, `export default` 필수. 같은 이름은 `replace: true`로만 교체. 등록에 실패하면 저장한 폴더를 되돌린다.
  - `deleteTool({ name })`: 등록 해제 후 폴더 삭제. 모델이 만든 툴이 아니면 거절.
  - 시작(setup) 때 폴더의 `tool.json`을 읽어 저장된 툴을 다시 등록한다. 손상된 항목은 경고만 남기고 건너뛴다.
- `custom-tools/runner.mjs`: 고정 실행기. 하네스가 `node runner.mjs <툴 폴더>`로 자식 프로세스를 띄우고 인자를 stdin JSON으로 넘긴다. 실행기는 `index.mjs`의 default export 함수를 부르고 결과를 표식 `__HARNESS_TOOL_RESULT__` 뒤에 JSON으로 낸다. 툴 코드의 `console.log/info/debug`는 stderr로 돌려, 코드가 무엇을 찍어도 결과가 깨지지 않는다.
- 실행 격리: 자식 환경 변수는 `PATH`, `HOME`, `LANG`, `TOOL_DIR`, `WORKSPACE_DIR`만. 하네스 프로세스의 API 키는 넘어가지 않는다(테스트로 확인). 작업 디렉터리는 작업 폴더. 시간 제한 기본 30초, 1초~300초. 결과 16,384자 초과는 잘림 표시. 실패는 예외 메시지 + stderr 끝부분 + "고쳐서 replace로 다시 등록" 안내가 담긴 오류 결과로 돌아가 모델이 스스로 고칠 수 있다. 턴 중단 신호가 오면 자식을 죽인다.
- `plugin-manager.ts`: 지금까지는 setup 실행 중에만 툴 등록을 허용했다. **플러그인이 켜져 있는 동안**으로 넓혔다(`PluginEntry.accepting`). 뒤늦게 등록한 툴도 같은 목록에 추적되어 끄면 함께 해제되고, 끈 뒤 등록은 거절된다. 모델이 만든 툴이 setup 뒤에 등록되기 때문이다.
- `permissions.ts`: 기본 정책에 `{ ownerPrefix: "custom-tools", decision: "ask" }`. 만들기·지우기·실행 모두 `runCommand`와 같이 승인 대상이며, 같은 툴은 세션 안에서 한 번 승인하면 기억된다. yolo는 건너뛴다.
- `builtin-plugins.ts`: 플러그인 목록에 추가.
- 스킬 `custom-tools/skills/tool-making/SKILL.md`(플러그인 소유): 언제 만들 가치가 있는지, 코드 계약, 예시 입력으로 먼저 시험, 순수 계산·비밀 정보 금지, `replace`로 고치기, 필요 없으면 지우기.

### 텍스트 상태 관찰 복원 (stash에서 선별)

- `game-testing/mcp-controller.cjs` `state` 명령, `game-testing/bridge.ts` `state()`, `game-testing/test-run.ts` `observe(format)`(image · text · both)와 `ACT_INPUTS_SCHEMA` export, `tools/game-testing.ts` `gameTestObserve`의 `format` 인자. 계약 없음·게임 함수 오류는 `lost`로 만들지 않고 안내 오류로 돌아간다. 툴은 여전히 5개다.
- 스킬 `game-testing/skills/game-testing/SKILL.md`: 계약 절과 텍스트 모드 절차(단계 1 그대로)에 "Strategy as a tool (optional)" 절을 더했다. 내용은 사용자 지시대로 범용 문장 하나 수준이다: 구조화된 상태가 있고 전략을 결정론적 손실·점수 함수로 표현할 수 있으면 tool-making 스킬로 툴을 만들어 쓰라, 하네스는 게임 지식을 더하지 않고 툴을 대신 돌리지도 않는다, 쓰는 방식은 모델의 몫이다.
- 플레이 두뇌, `reasoningEffort`, 턴제, 평가 스크립트는 되살리지 않았다(stash에 그대로).

## 검증

- 모의: `tests/custom-tools.test.ts` 6개(만들기·실행·인자 검증, 잘못된 입력 거절, replace·삭제, 환경 변수 차단·작업 폴더·예외·시간 초과·stdout 오염 무해, 재활성화·새 관리자에서 재등록, 플러그인의 늦은 등록과 끈 뒤 거절), `tests/permissions.test.ts` 승인 규칙, `tests/extensions.test.ts` 늦은 등록 의미 갱신, `tests/game-testing.test.ts` 단계 1의 관찰 테스트 13개 복원. `pnpm test` 281개 전부 통과, `pnpm exec tsc --noEmit`, `git diff --check` 통과.
- 실제(모델 없음): `pnpm test:game-testing`(실제 headless 브라우저 + Playwright MCP) 통과. 검증 페이지의 계약을 정지된 시계에서 읽는 데 5.6ms, `check` 판정 `controllable`, 관찰→입력 지연 7ms(게임 5ms), 배속 0.05 구간 달성 배속 0.049.
- 실제(모델): `pnpm test:custom-tools --model haiku`(신규 스크립트, `tests/custom-tools-smoke.ts`). Haiku가 `createTool`로 `gcd` 툴(정수 a·b, 결과 숫자)을 만들고 곧바로 `gcd(84, 36)`을 그 툴로 불러 12를 답했다. 툴 호출 순서 createTool → gcd, 전체 5.8초. 저장된 `tool.json`과 하네스가 직접 부른 `gcd` 결과도 확인.

## 남긴 것

- 툴 코드는 JavaScript(ES 모듈)만 받는다. TypeScript는 Node의 타입 제거로 돌릴 수 있지만 우선 단순하게 두었다.
- 실행 격리는 프로세스와 환경 변수 수준이다. 파일 시스템 접근은 막지 않았다(작업 폴더의 게임 파일을 읽어야 할 수 있음). 그래서 승인이 기본이다.
- 모델이 만든 툴은 세션 컨텍스트의 툴 정의 목록에 그대로 들어간다. 많이 만들면 컨텍스트가 커지므로 스킬이 "다 쓰면 지우라"고 안내한다.
- 게임 플레이 실측은 사용자가 직접 한다(Haiku, 텍스트 관찰, 손실함수 툴).

## 후속 (같은 날) — 스킬의 결정 시점 이동

사용자 실측(Haiku, 세션 `76a8b5ce…`): 스킬 목록에 `tool-making`이, 툴 목록에 `createTool`이 있었고 game-testing 스킬 본문(Strategy 절 포함)도 읽었지만, 모델은 `createTool`을 한 번도 부르지 않고 조각마다 관찰·입력을 반복했다(5조각, 0줄, 중단). 원인은 스킬 끝의 "optional" 절을 명령형 5단계 절차가 덮은 것으로 봤다. 고친 것: 5단계 텍스트 모드의 첫 항목을 "첫 배치 전에 결정론적 손실함수 전략 툴을 만들지 판단하고, 만들면 현재 상태로 시험한 뒤 시작"으로 두고 선택 절은 없앴다. 활용 방식은 여전히 적지 않는다(사용자 지시). 프론트매터 설명에도 한 구절을 더했다. 재시험은 사용자가 한다.

## 후속 (같은 날) — 세션 전용이 기본

사용자 실측에서 이전 세션이 만든 `tetrisStrategy`(근사식 전략)가 다음 세션에도 등록되어 새 세션을 오염시켰다. 처리:
- 남아 있던 `.my-first-harness/tools/tetrisStrategy/`는 삭제했다(코드 원문은 세션 JSONL의 createTool 호출과 스크래치 백업에 있다).
- `createTool`에 `persist`(기본 false)를 두었다. 기본은 세션 전용: OS 임시 폴더(`my-first-harness-custom-tools/<pid>/`)에 저장하고 플러그인이 꺼지거나 하네스가 끝나면 폴더를 지운다. `persist: true`일 때만 프로젝트 폴더에 저장해 다음 실행에 다시 등록하며, 시작 때 `[custom-tools] 저장된 툴 N개 등록: …` 한 줄로 알린다. 교체로 저장 위치가 바뀌면 옛 폴더를 지운다.
- 스킬: tool-making에 "세션 전용이 기본, 사용자가 남기라고 할 때만 persist"를, 게임 스킬 `strategy-tool.md`에 "이 게임·이 세션용으로 새로 만들고, 이전 세션의 전략 툴이 등록돼 있으면 코드를 읽고 요구사항에 못 미치면 교체"를 적었다.
- 테스트: 기본 생성은 프로젝트 폴더 밖, 끄면 폴더 삭제, `persist: true`만 재등록·새 관리자에서 복원. `pnpm test` 전체 통과.

