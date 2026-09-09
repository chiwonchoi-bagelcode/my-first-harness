# 세션 승인과 YOLO

- 승인 화면에 S/session을 추가했다. 같은 세션 ID·등록 소유자·툴 이름이면 모든 인자를 승인한다. 특히 runCommand를 세션 승인하면 다른 명령도 승인 없이 실행한다는 범위를 UI에 표시한다.
- 승인은 Agent 메모리에만 보관한다. 새 세션 ID는 별도 승인을 요구하고, 같은 앱에서 이전 세션 ID를 resume하면 그 세션의 승인도 재사용한다. 앱을 재시작하면 사라진다.
- 기존 deny → ask → allow 검사는 유지한다. 저장한 세션 승인은 ask에서만 사용하므로 명시적 deny를 무시하지 않는다. 중단 뒤 늦게 도착한 승인은 저장하지 않는다.
- /permissions yolo는 모든 툴 권한 규칙을 ALLOW_ALL로 대체한다. plan의 파일 쓰기 deny도 우회한다. 등록 여부·비활성화·스키마 검증·중단 처리까지 제거하는 것은 아니다. 계획 제출 검토도 별도로 유지한다.
- /permissions default는 원래 정책으로 돌아간다. 기존 세션 승인은 지우지 않는다.
- Shift+Tab은 edit(default) → plan(default) → edit(yolo) → edit(default)를 순환한다. /mode yolo도 같은 선택이다. /mode plan 또는 edit는 일반 권한 정책으로 돌아온다.
- 실행·검토 대기 중에는 전환하지 않는다. YOLO는 앱 런타임 상태여서 /new·/resume에서도 유지되고 앱을 재시작하면 default다. TUI 상단에 빨간 YOLO 표시를 유지한다.
- 세션 파일 형식과 README는 변경하지 않았다.
- 모의 모델과 UI 입력 테스트로 세션 격리, 늦은 승인 무효, deny 유지, YOLO 우회/복원, Shift+Tab 사이클, S 입력을 검증한다. 실제 모델 API 호출은 하지 않는다.
