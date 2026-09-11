# runCommand가 `cd … && 서버 &`에서 영원히 멈추던 문제

작성일: 2026-09-11

## 현상

사용자 실측(Haiku, TUI, YOLO)에서 모델이 게임을 로컬 서버로 열기 위해 두 번 연속 같은 모양의 foreground `runCommand`를 불렀고, 두 번 모두 하네스가 "실행 중 · runCommand"에서 멈췼다.

```
cd /Users/…/tetris-mfh-test-luna-full-fixed && python3 -m http.server 8765 > /tmp/tetris-server.log 2>&1 &
echo $!
```

툴 설명은 "셸의 `&` 대신 background 옵션을 쓰라"고 적혀 있었지만 모델은 따르지 않았다. 첫 번째 시도를 Esc로 끊은 뒤 "왜 멈췼냐"고 묻자 같은 모양으로 다시 시도했다.

## 원인

`a && b &`는 셸에서 `a && b` 묶음 전체가 **서브셸로 백그라운드**에 간다. 리다이렉션(`> log 2>&1`)은 `b`(python)에만 적용되고, 서브셸 자체는 하네스가 준 stdout·stderr 파이프를 그대로 쥔 채 python이 끝나기를 기다린다. 바깥 셸은 `echo $!`를 찍고 끝나므로 프로세스 `exit`는 오지만, Node의 `close`는 모든 stdio 스트림이 닫혀야 오고, 서브셸이 파이프를 쥐고 있어 오지 않는다. `JobManager.run()`은 `close`만 기다렸으므로 영원히 멈췼다. 프로세스 목록에 `/bin/sh -c cd … && python3 …`(서브셸)과 python이 살아 있는 것으로 확인했다. 단순 명령 `python3 … &`(`&&` 없이)는 셸이 백그라운드 자식의 stdin을 /dev/null로 돌리고 리다이렉션이 그 자식에 붙어 파이프를 쥐지 않아 재현되지 않았다.

## 수정

- `job-manager.ts`: 작업에 `exited`(프로세스 종료) 약속을 추가하고 `exit`에서 종료 코드·상태를 확정한다(`close`에서도 같은 계산을 해 생성 실패 경로를 보존). foreground `run()`은 `exit` 뒤 `close`를 최대 500ms만 기다리고, 스트림이 여전히 열려 있으면 지금까지의 출력에 주의 문구를 붙여 돌아온다: 출력 스트림을 쥔 프로세스가 남아 있으며 이 도구가 관리하지 않고 하네스 종료 때 함께 정리한다, 서버·장기 작업은 `background: true`로 실행하라. 남은 프로세스는 같은 프로세스 그룹이라 `stop`·`dispose`의 그룹 신호로 정리된다.
- `tools/shell.ts`: `runCommand` 설명에 이 동작을 한 문장 추가.
- `tests/jobs.test.ts`: `cd … && sleep 3 &` 뒤 `echo started`가 2초 안에 "started"와 주의 문구를 돌려주고 상태가 `completed`, `dispose`가 자식을 정리하는 회귀 테스트.

## 검증

- 모의: `pnpm test` 전체 통과(회귀 테스트 포함), `pnpm exec tsc --noEmit`, `git diff --check` 통과.
- 사용자 세션의 멈춘 명령은 Esc로 끊으면 `stop()`이 프로세스 그룹(서브셸과 8765 서버)을 종료한다. 수정된 코드는 하네스를 다시 켜야 적용된다.

## 남긴 것

- foreground 명령에 전체 시간 제한은 여전히 없다. 끝나지 않는 명령은 Esc로 끊어야 한다.
- background 작업(`background: true`)의 상태는 여전히 `close` 기준이다. 그 안에서 `&`로 자식을 남기면 셸이 끝나도 `running`으로 보일 수 있다.
