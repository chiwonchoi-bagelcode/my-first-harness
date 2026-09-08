# 내장 플러그인과 TUI 확장 기능 토글

## 구조

- `builtin-plugins.ts`: 기존 counter/time/other-llm/filesystem/shell 등록 함수를 `name`, `description`, `setup(tools)`로 구성한다. 외부 플러그인 설치 규격이나 Cordis는 도입하지 않았다.
- `plugin-manager.ts`: setup에 소속이 고정된 ToolRegistrar를 전달한다. 등록할 때 얻은 해제 함수와 setup이 반환한 자원 정리 함수를 보관한다. disable은 해당 등록을 해제한 뒤 자원을 정리한다.
- `tool-manager.ts`: 등록 소유권·정확한 등록 해제·개별 enabled 설정을 추가했다. off 툴은 요청 정의에서 빠지고 직접 execute 호출도 거부된다.
- `extension-runtime.ts`: 같은 ToolManager/SkillManager 인스턴스에 설정을 반영한다. MCP 연결도 서버별 소유 단위로 관리하되 TUI에서는 내장 plugins와 별도 mcp 목록에 표시한다.
- `extension-settings.ts`: 현재 프로젝트 `.my-first-harness/settings.json`의 `extensions.skills/tools/plugins/mcp`에 이름별 boolean을 저장한다. 미설정 항목은 기본 on이다. 전역 설정 계층은 이번 범위에 추가하지 않았다.
- `tui-session.ts`, `tui.ts`: `/skills`, `/tools`, `/plugins`, `/mcp` 목록. ↑↓ 선택, Space/Enter 토글, Esc 닫기. `/reload-skills`는 스킬 폴더를 다시 읽는다.

## 반영 시점과 정책

- 작업 중 토글하지 않는다. 입력 대기 상태에서 변경하면 설정을 저장하고 즉시 반영하며 다음 요청부터 바뀐 목록을 사용한다. 일반 CLI도 시작할 때 같은 저장 설정을 적용한다. 관리 메뉴 자체는 TUI에만 추가했다.
- 설정 저장 실패 시 런타임을 변경하지 않는다. 설정 저장 후 MCP 연결이 실패하면 요청 상태 on과 실제 연결 실패를 구분해 표시한다. off/on으로 재시도하거나 다음 시작 때 다시 연결한다.
- 플러그인과 개별 툴의 off는 독립적이다. 소속을 껐다 켜도 개별 툴 off는 유지된다.
- 꺼진 플러그인/MCP의 툴은 해당 실행에서 한 번 발견한 경우 목록에 남는다. 시작부터 꺼져 있어 아직 발견하지 않은 툴을 알아내기 위해 몰래 setup/연결을 실행하지 않는다.
- 셸 플러그인 off는 관리 중인 백그라운드 작업도 종료한다. 재활성화하면 새 JobManager이므로 작업 목록은 초기화된다. 메뉴에 경고를 표시한다. 카운터는 기존 모듈 변수이므로 플러그인 off/on 중 값이 유지된다.
- 스킬 off는 카탈로그 노출을 끄는 것이다. 이미 읽힌 본문, 파일 자체, 세션/history는 삭제하지 않는다. 파일 읽기나 셸을 통한 직접 접근을 차단하는 보안 경계도 아니다.
- 스킬 재탐색은 새 목록을 만든 뒤 교체한다. 중복 등록과 삭제된 파일의 잔존을 막으며 off 설정을 다시 적용한다. 기존 frontmatter `disable-model-invocation` 처리와 프로젝트 우선순위는 그대로다.
- 자동 파일 감시, 플러그인 코드 HMR, MCP 구성 파일 편집 UI, 설치/삭제/마켓플레이스는 추가하지 않았다.
- 설정 파일은 같은 폴더의 임시 파일에 쓴 뒤 rename한다. 기존 다른 최상위 설정 필드는 보존한다.
- 플러그인 등록 충돌·setup 실패는 해당 시도의 등록을 되돌린다. setup 완료 뒤 늦게 등록하는 것은 이번 최소 규격에서 허용하지 않는다. 종료는 진행 중인 토글/시작 이후에 자원을 정리한다.

## 검증

- strict TypeScript 검사 통과.
- 전체 자동 테스트 165개 통과: 토글·재등록·개별 off·설정 재시작·스킬 수정/삭제/reload·실패 표시·TUI 키 입력·종료 경합 포함.
- 실제 SDK stdio memory MCP 연결 → 호출 → off 시 호출 차단 → on 후 새 연결 호출 성공.
- 실제 셸 백그라운드 자식 프로세스가 플러그인 off 후 종료되는 것 확인.
- `pnpm build` 통과. 출력은 기존 정책대로 `dist/`에 생성.
- `pnpm test:package` 통과: 임시 전역 설치, 다른 cwd의 CLI 시작, 로컬 MCP 3개, PNG/JPEG/WebP 첨부, 세션 저장, 종료.
- MCP 실패/토글 상태는 모의 연결도 이용해 검사했다. 실제 LLM API 요청은 하지 않았다. iTerm2의 실제 OS 입력기는 이번 검증 대상이 아니다.
- README와 기존 세션 파일은 수정하지 않았다. 커밋·푸시하지 않았다.
