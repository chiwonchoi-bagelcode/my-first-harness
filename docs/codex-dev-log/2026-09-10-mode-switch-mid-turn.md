# 턴 중 모드·권한 전환

작성일: 2026-09-10

## 문제

턴이 도는 중에는 `/mode`·`/permissions`·Shift+Tab이 거절됐다(어제 구현의 의도: 열린 승인 질문이 나중에 우회되지 않게, 한 턴의 지침이 중간에 바뀌지 않게). 그래서 승인이 반복되는 긴 턴에서 YOLO로 바꾸고 싶어도 턴이 끝날 때까지 매번 승인해야 했다.

## 참고한 구현

세 하네스 모두 턴 중 변경을 허용하되 효력 시점이 다르다.

- Claude Code: Shift+Tab 처리기가 현재 권한 컨텍스트에서 다음 모드를 계산해 상태 저장소에 바로 쓴다(바이너리 문자열에서 순환 함수 확인: default → acceptEdits → plan → bypassPermissions(가능할 때) → default). 툴 호출마다 그 시점의 상태를 읽어 판단하므로 다음 툴 호출부터 적용된다. "턴이 도는 중인지"는 검사하지 않는다.
- Codex: `/permissions`는 작업 중 허용 명령(`tui/src/slash_command.rs` `available_during_task`)이고 `/plan`은 아니다. 변경은 `core/src/session/mod.rs` `update_settings_if`로 세션 설정에 즉시 저장되지만, 턴은 시작 시 `new_turn_with_sub_id_if`가 설정을 복사해 `TurnContext`로 갖고 승인 판단은 `turn_context.approval_policy()`를 읽으므로 **다음 턴부터** 적용된다.
- DSH: 승인 정책(`packages/interaction/user-approval`)은 `approval/policy` 이벤트를 즉시 기록하고 질문마다 최신 값을 fold해 **다음 승인 질문부터** 적용된다. plan 모드(`packages/plan/plan-mode`)는 턴이 열려 있으면 `pendingIntents`에 두고 `agent/pre-step`에서 기록해 **다음 스텝부터** 적용하며, 사용자에게 "applies from the next step", 모델에게 "The user switched this session to plan mode." 한 줄을 넣는다.

## 사용자 결정

DSH 방식. 권한(default/yolo)은 즉시(다음 툴 호출부터), 모드(plan/edit)는 다음 스텝부터. 열린 승인 질문은 YOLO 전환이 대신 답하지 않는다. Shift+Tab은 실행·승인 대기 중에도 동작한다. Codex식 "다음 턴부터"는 이번 불편을 해결하지 못해 채택하지 않았다.

## 변경

- `agent.ts`
  - `setPermissionMode`: 턴 중 거절을 제거했다. 권한 정책은 이미 툴 호출마다 그 순간의 `permissionMode`로 계산하므로 다음 툴 호출부터 반영된다. `waitForApproval`로 기다리는 질문은 그대로 남는다.
  - `setMode`: 턴 중이면 `pendingMode`에 두고 `"queued"`를 돌려준다. 턴 밖이면 즉시 적용하고 `"applied"`. 대기 중 현재 모드를 다시 고르면 대기를 취소한다. `getPendingMode()` 추가.
  - 스텝 시작(계획 승인 반영 직후)에 대기 모드를 적용하고, 실제로 바뀌었으면 `[하네스 알림] 사용자가 작업 모드를 …로 전환했습니다. 이번 스텝부터 …` user 메시지를 `source: "harness"`로 기록한다. 계획 승인으로 edit가 되는 것과 사용자가 대기시킨 모드가 겹치면 사용자 선택이 이긴다.
  - 스텝 없이 턴이 끝나면(중단 포함) `finally`에서 대기 모드를 적용한다. 이때는 알림 메시지를 넣지 않는다.
  - `mode-changed` 이벤트에 `reason: "plan-approved" | "user"`를 추가했다. 코어가 스스로 반영한 경우에만 보내고, UI가 직접 부른 턴 밖 `setMode`는 호출자가 이미 알고 있으므로 보내지 않는다(초기 구현에서 TUI 컨트롤러 생성 전에 이벤트가 나가 테스트가 깨졌다).
- `tui-session.ts`: `TuiState.pendingMode`. `/mode`와 Shift+Tab이 공유하는 `changeMode()`는 `busy`를 건드리지 않아 실행·승인 대기 중에도 부를 수 있다. 새 `cycleMode()`는 대기 모드가 있으면 그것을 기준으로 다음 값을 고른다(edit → plan → YOLO → edit). 알림 문구는 "모드: plan (다음 스텝부터)", "YOLO: 모든 툴 권한 검사 우회 · 다음 툴 호출부터". `mode-changed(user)`가 오면 대기 표시를 지우고 "모드 적용: …"을 남긴다.
- `tui.ts`: Shift+Tab 처리에서 `!state.busy` 조건을 없애고 `cycleMode()`를 부른다. 상단 표시는 `[edit → plan (다음 스텝)]`.
- `cli.ts`: `mode-changed` 표시에 이유를 반영하고, `/mode` 결과가 queued면 "모드는 다음 스텝부터"를 덧붙인다(readline CLI는 턴 중 입력을 받지 않아 실제로는 항상 applied다).
- `CLAUDE.md`의 "Neither mode can change while a turn is active" 줄을 새 규칙으로 바꿨다. README는 수정하지 않았다.

## 검증

- `tests/mode-switch-midturn.test.ts` 4개(실제 코어 + 모의 모델): (1) 첫 승인 질문이 열린 채 YOLO로 바꿔도 그 질문은 답을 기다리고 실행되지 않으며, 답한 뒤 두 번째 `runCommand`는 묻지 않고 실행된다(질문 1회). (2) 첫 스텝 중 plan 요청은 `queued`·`getMode()==="edit"`·`getPendingMode()==="plan"`, 그 스텝의 쓰기는 실행되고 다음 스텝 요청은 plan 지침과 하네스 알림을 담으며 쓰기가 거부된다. `mode-changed{plan,user}` 1회. (3) 대기 중 같은 모드 재선택은 취소(알림·이벤트 없음), 마지막 스텝에서 요청한 모드는 턴 끝에 적용(알림 메시지 없음), 턴 밖 변경은 즉시. (4) TUI: 실행 중 Shift+Tab → 상단 `[edit → plan (다음 스텝)]`, `/mode plan` command 기록, busy 유지; 두 번째 Shift+Tab은 대기 모드 기준으로 YOLO(권한 즉시); `mode-changed` 수신 뒤 대기 표시 제거.
- 기존 테스트 수정: `agent-mode`·`session-permissions`의 "턴 중 setMode/setPermissionMode가 throw" 단정 제거. `tui.test.ts`의 "승인 대기 중 Shift+Tab은 무시" 단정을 "모드는 바뀌고 승인 질문은 그대로 남는다"로 바꿨다. `mode-fixture`에 `getPendingMode`와 `setMode` 반환값 추가.
- `pnpm test` 253개, `pnpm exec tsc --noEmit`, `pnpm build`, `git diff --check` 통과. 실제 모델 API와 실제 터미널(iTerm2) 조작은 검증하지 않았다.

## 알려진 제약

- 모드 변경은 다음 스텝 시작에 적용되므로, 한 스텝이 툴을 여러 개 실행하는 동안에는 이전 모드의 권한이 유지된다. 반대로 권한(YOLO)은 같은 배치 안의 다음 툴부터 바뀐다. 의도한 차이다.
- Shift+Tab 순환이 plan을 거치므로 edit(default)에서 YOLO로 가려면 두 번 누른다. 첫 번째로 대기된 plan은 두 번째 누름에서 edit로 되돌아가 상쇄된다.
- 모드·권한은 여전히 런타임 상태이며 세션 파일에 저장하지 않는다(사용자 결정).
