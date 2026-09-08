# TUI 한글 입력·여러 줄 편집·세션 선택

## 범위

- `/Users/choechiwon/my-first-harness`의 main에서 수정했다.
- 한글 IME 위치, 여러 줄 입력, `/resume` 목록만 개선했다. 입력 기록·실행 중 초안·중단 API는 추가하지 않았다.
- 코어·모델 어댑터·일반 CLI·README·세션 저장 형식은 변경하지 않았다. 새 패키지는 설치하지 않았다.

## 입력 수정의 근거

- [Ink 7.1.1 공식 cursor-ime 예제](https://github.com/vadimdemedes/ink/blob/v7.1.1/examples/cursor-ime/cursor-ime.tsx): `useCursor().setCursorPosition()`에 실제 입력 위치를 전달하고 CJK 너비는 `string-width`로 계산한다.
- [ink-text-input의 IME 수정 PR #93](https://github.com/vadimdemedes/ink-text-input/pull/93): 입력창 시작 좌표와 커서까지의 표시 너비를 더하는 방식. 확인 당시 미병합 PR이므로 패키지를 교체하지 않고, 이미 설치된 Ink의 공식 훅을 사용했다.
- 기존 구현은 반전된 글자를 커서처럼 그렸을 뿐 실제 터미널 커서를 이동하지 않았다. 이제 조합 중 글자 표시는 터미널/OS에 맡기고 커서 좌표를 매 프레임 맞춘다. 자체 한글 조합기나 추측으로 중복 문자를 삭제하는 로직은 넣지 않았다.
- PTY 검증 중 Ink 7.1.1의 전체 높이 출력에서 커서가 한 줄 위로 가는 것을 확인했다. `renderInteractiveFrame`은 끝 개행을 생략하지만 `buildCursorSuffix`는 끝 개행을 가정한다. 화면을 `rows - 1`줄로 제한해 마지막 한 줄을 비우고, 라이브러리 내부 수정 없이 개행/커서 기준을 일치시켰다. 이 동작은 실제 ANSI 출력 테스트로 보호한다.

## 여러 줄 편집과 키

- 입력창은 자동 줄바꿈하며 최대 5줄까지 커진다. 더 길면 커서 주변 줄만 표시하고 원문은 유지한다.
- Enter: 전송. 명령 후보가 열렸으면 기존처럼 먼저 명령 이름을 채운다.
- Shift+Enter, Cmd+J: 줄바꿈. 터미널에서 해당 키/수식키를 보고해야 한다.
- Ctrl+J: LF 줄바꿈 대안. Cmd+J와 Ctrl+J는 다른 키이며 혼동해서 설명하지 않는다.
- Ink의 Kitty keyboard 자동 협상을 켰다. 지원하지 않는 터미널에 강제로 모드를 적용하지 않는다.
- iTerm2에서 단축키가 앱에 도착하지 않으면 `Settings → Profiles → Keys → Key Mappings`에서 원하는 키를 `Send Hex Code: 0x0a`로 지정하면 같은 LF 처리로 연결된다. 설정은 변경하지 않았다.
- [iTerm2 공식 키 설정](https://iterm2.com/documentation-preferences-profiles-keys.html), [키 보고 권장 방식](https://iterm2.com/documentation-csiu.html), [Kitty 키보드 규격](https://sw.kovidgoyal.net/kitty/keyboard-protocol/).
- 위아래 방향키는 입력창 안의 줄 이동 또는 열린 메뉴 선택에만 사용한다. 이전 입력 히스토리는 추가하지 않았다.
- Backspace와 Delete를 구분했다. 각각 커서 앞/뒤 문자를 지운다.
- `usePaste`로 bracketed paste를 키 이벤트와 분리했다. 붙여넣은 줄바꿈은 전송하지 않는다. CRLF/CR은 LF로 통일하고 실행 가능한 터미널 제어 시퀀스는 입력에서 제거한다.
- 같은 프레임에 여러 입력 이벤트가 와도 앞선 입력을 잃지 않도록 최신 편집 값을 ref에 함께 보관하며 키 release는 무시한다.

## 세션 목록

- TUI에서 `/resume` 실행 → 현재 프로젝트에 저장된 JSON 스냅샷을 최근 수정 순으로 표시한다.
- 첫 사용자 텍스트를 제목으로 사용하고, 마지막 저장 시각·현재 세션 표시·선택한 전체 ID를 보여준다.
- ↑↓ 선택, Enter 재개, Esc 취소. `/resume <ID>`는 계속 지원한다.
- 현재 세션을 포함한다. 텍스트 없는 세션에는 대체 제목을 표시한다. 제목은 스냅샷의 현재 messages에서 가져오므로 압축으로 원래 첫 메시지가 사라졌으면 최초 제목과 다를 수 있다.
- 목록을 열 때 JSON을 읽는 단순 구현이다. 별도 인덱스·검색·페이지 로딩·자동 제목 모델 호출은 없다.
- JSONL 원문은 목록에 포함하지 않는다. 읽을 수 없는 JSON은 건너뛰되 제외 수를 표시하고 삭제하지 않는다. 폴더 자체를 읽지 못하면 오류를 표시한다.
- 빈 목록이나 취소는 현재 세션을 바꾸지 않는다. 선택 뒤 파일을 읽지 못해도 기존 세션을 보존한다. 성공한 재개만 기존 정책대로 첨부 대기열을 비운다.

## 검증

- 전체 테스트 145개 통과, strict TypeScript 검사와 `pnpm build` 통과.
- 단위/통합 테스트: 다중 줄과 자동 줄바꿈, CJK·이모지 너비, 커서 좌표·메뉴·resize, 빠른 입력, release 중복 방지, Shift+Enter/Cmd+J/Ctrl+J, 분할 bracketed paste, 세션 목록 정렬·프로젝트 분리·선택·취소·읽기 실패.
- Ink 실제 TTY 출력 모드에서 끝 개행과 실제 커서 이동 ANSI를 검사한다. 단순 문자열 주입 테스트를 OS 한글 조합 테스트라고 부르지 않는다.
- PTY에서 모의 모델 fixture로 입력·툴 실행·세션 목록과 종료를 확인한다. Bun 독립 실행 파일도 별도 임시 폴더에서 검증한다.
- iTerm2 UI 조작은 도구 정책에서 차단되었다. 따라서 실제 macOS 한글 IME 조합 및 사용자의 iTerm2 단축키 설정은 직접 검증하지 못했다. 수정 후 사용자의 재확인이 필요하다.
- 실제 유료 모델/API 요청은 보내지 않는다.
