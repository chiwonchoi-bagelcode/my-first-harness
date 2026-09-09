# CLI·TUI 승인 연결

- `/Users/choechiwon/my-first-harness`에서 이전 권한 검사에 UI 콜백을 연결했다. 기본 allow-all 정책, 세션 형식, README는 변경하지 않았다.
- CLI: 기존 readline을 공유한다. 툴 이름·JSON 인자 전체를 출력하고 y/yes + Enter만 일회 승인한다. 빈 입력·다른 입력·EOF·AbortSignal은 거부한다. Ctrl+C는 코어 중단 요청 후 기존 종료 경로로 정리한다.
- TUI: 승인 요청을 스크롤 가능한 대화 영역에 생략 없이 추가한다. Y는 일회 승인, N/Enter는 거부, Esc는 기존 턴 중단, Ctrl+C는 종료다. 일반 메시지 입력은 승인 중 비활성화한다. 작은 화면에서 내용을 못 보는 동안 Y 승인을 받지 않는다.
- 종료·중단 시 승인 대기를 해제한다. 동시 승인 요청은 추가로 열지 않고 거부하며, 화면 연결 전·종료 후 요청도 거부한다.
- `createCli()`와 기존 `createTui()`가 에이전트 생성 전에 requestApproval 콜백을 제공하고, 실제 UI가 열릴 때 입력 처리에 연결한다.
- 정책 선택 명령·plan/edit 모드·세션 단위 영구 승인은 추가하지 않았다. 현재 기본 정책에는 ask 규칙이 없으므로 기본 앱에서는 승인 질문이 발생하지 않는다. createAgent의 permissions에 ask 정책을 전달하면 연결된 화면을 사용한다.
- 검증: readline 승인/거부/EOF/중단, TUI 키 입력·승인 상태·종료 취소, 실제 Agent → TUI 승인 → 도구 실행을 모의 모델로 검사. 외부 API 및 실제 iTerm2 수동 검증은 하지 않았다.
