# 실행 코어와 CLI 분리

## 범위와 작업 위치

- 사용자 승인에 따라 `/Users/choechiwon/my-first-harness`의 main에서 리팩터링했다.
- 프롬프트, 모델 선택과 API 변환, 이미지 처리, 압축 기준, 세션 파일 형식은 변경하지 않았다.
- README, 기존 세션 데이터, 다른 worktree는 수정하지 않았다. 커밋·병합은 하지 않았다.

## 파일별 역할

- `my-first-harness.ts`: 환경·모델·기록 객체 생성, 툴·스킬·MCP 등록, 코어와 CLI 연결. 생성한 셸 작업·MCP 연결의 종료 함수를 CLI에 전달한다.
- `agent.ts`: `createAgent(options)`가 `turn(session, input, images)`와 `compact(session)`을 반환한다. 컨텍스트 조립, 모델 호출, 툴 실행, 기록과 압축을 담당한다.
- `cli.ts`: `runCli(options)`가 readline, slash 명령, 첨부 대기열, 최종 출력, 세션 시작/resume 기록, SIGINT 정리를 담당한다. 테스트에서 명령 루프도 직접 import하도록 계획의 파일 목록에 추가했다.
- `tool-manager.ts`: 기존 ToolManager를 옮겼다. 등록과 실행 방식, 인자 검증, 반환값 변환은 그대로다. 등록 규격의 any 제거는 이번 범위가 아니다.
- `session.ts`: Session 타입과 `createSession(workspaceDirectory)`를 소유한다. 시스템 프롬프트는 원문 그대로 옮겼다.
- `session-store.ts`: JSON 저장과 로드만 담당한다. 형식은 계속 version 2다.

## 외부에서 코어를 사용할 때

```ts
const agent = createAgent({
  adapter, toolManager, skillManager, history, paths,
  onEvent: renderCliEvent,
});

const session = createSession(paths.workspaceDirectory);
const output = await agent.turn(session, input, images);
await saveSession(session, paths);
```

- 모듈 import나 createAgent 호출만으로 터미널·MCP·모델 요청을 시작하지 않는다.
- 코어에는 console 출력, stdin 입력, process 종료가 없다. 화면 이벤트는 콜백으로 전달하며 콜백이 없으면 출력하지 않는다.
- 이벤트는 중간 답변, 툴 시작, 압축 시작/완료/빈 상태, 툴 결과 축약만 제공한다. 최종 답변은 turn의 반환값이다.
- 이벤트 콜백은 동기 함수다. Promise를 기다리는 이벤트 버스나 오류 격리 정책은 추가하지 않았다. 툴 시작은 JSONL 기록 후 화면에 알리도록 순서를 정했다.
- ExecutionHistory는 화면 이벤트와 별도로 유지한다. 화면 이벤트를 원문 로그에 다시 넣지 않는다.
- 기존과 같이 정상 turn 완료 시 저장은 호출자가 담당한다. CLI가 완료 후 저장하며, 코어는 압축 전후와 turn 오류 시 저장한다.
- 테스트가 사용자 디스크에 쓰지 않도록 AgentOptions에 선택적 saveSession을 받는다. 생략하면 기존 파일 저장 함수를 쓴다. CLI도 같은 목적으로 저장·로드 함수를 교체할 수 있다.
- 한 코어의 turn/compact는 순차 호출을 전제로 한다. 여러 사용자 동시 실행, 중단 API, 웹 서버, TUI, 토큰 스트리밍은 구현하지 않았다. 웹에서는 서버 측에서 이 코어를 실행하고 브라우저로 이벤트를 전달하는 별도 연결이 필요하다.

## 테스트와 검증

- 기존 코어·CLI 테스트의 소스 문자열 추출과 동적 함수 생성을 제거하고 실제 모듈을 import한다. 시작 시 모델 선택 코드만 검사하는 기존 Responses 설정 테스트는 이번 범위 밖이라 그대로 뒀다.
- 기존 118개 테스트에 7개를 추가했다. import 무실행, 화면 없는 실행, 수동 압축 성공/실패/빈 기록, 축약 이벤트, CLI 표시 문구, 실제 CLI·코어 연결을 검증한다.
- CLI 통합 테스트는 임시 폴더에서 실제 JSON/JSONL 기록을 저장하고 툴 실행·압축·new/resume·quit를 확인한다. 모델만 모의 응답으로 대체했다.
- 기존 SIGINT/quit 테스트는 실제 자식 프로세스의 종료를 확인한다.
- `pnpm test`: 125개 통과.
- `pnpm --package=typescript dlx tsc --noEmit --strict`: 통과.
- `pnpm build`: 통과. `dist/my-first-harness`에 출력된다.
- 실제 LLM API나 공개 MCP 서버에 요청하지 않았다. 실제 모델 품질이나 웹/TUI 구현 완료를 검증한 것은 아니다.
