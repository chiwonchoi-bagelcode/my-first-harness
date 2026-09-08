# Playwright MCP 연결 및 실제 브라우저 검증

## 범위와 구성

- `@playwright/mcp` 0.0.80을 pnpm 의존성으로 고정했다. Playwright 라이브러리는 서버의 전이 의존성이므로 별도 직접 의존성을 추가하지 않았다.
- 기존 stdio MCP 경로에 `playwright`를 추가했다. 설치된 패키지의 `package.json`을 기준으로 `cli.js`를 찾아 Node.js로 실행한다. 기존 두 서버는 `dist/index.js`를 사용한다.
- 작업 디렉터리는 현재 프로젝트, 출력 경로는 `<프로젝트>/.my-first-harness/mcp-playwright`이다. 생성 결과는 gitignore에 추가했다.
- 기본은 별도 창을 띄우는 서버 기본 동작이다. `--isolated`로 개인 브라우저 프로필을 사용하지 않고, 이번 단계에서는 `--image-responses omit`으로 이미지 반환을 제외한다.
- 이 Mac에 이미 설치된 Google Chrome으로 검증했으며 브라우저를 추가 설치하거나 개인 브라우저 확장 프로그램을 연결하지 않았다.
- 기존 ToolManager, Agent, 모델 어댑터, MCP 클라이언트 실행 로직은 바꾸지 않았다. README도 수정하지 않았다.

## 검증

- `pnpm test`: 126개 통과.
- `pnpm test:mcp`: 실제 서버 5개·도구 52개 연결 및 기존 파일·메모리·문서 도구 실행 통과.
- `pnpm --package=typescript dlx tsc --noEmit --strict`: 통과.
- `pnpm build`: 통과. 외부 MCP 서버와 브라우저를 실행파일에 내장했다는 의미는 아니다.
- `pnpm test:playwright --model farm`: 실제 Playwright MCP 도구 24개 등록. headless 브라우저에서 로컬 페이지를 열고 스냅샷의 버튼 참조를 이용해 클릭하여 40 → 41 변경을 확인했다.
- 같은 테스트에서 실제 Farm Luna와 기존 `createAgent()`를 연결했다. 모델이 navigate → snapshot → click → click → snapshot을 선택했고 6번의 모델 호출 후 `Counter value: 43`으로 보고했다. 서버의 실제 증가 횟수, 도구 호출 기록, 반환된 페이지 텍스트와 최종 답변을 모두 검증했다.
- 최초 수동 스모크에서는 구형 `ref` 인자로 인해 검증이 거부됐다. 설치된 서버의 실제 스키마를 조회해 0.0.80의 `target` 인자로 수정했다. 하네스는 서버에서 스키마를 동적으로 가져오므로 실행 로직 변경은 필요 없었다.

## 다시 실행

```sh
# API 키 없이 실제 MCP·브라우저만 검증
pnpm test:playwright

# .env의 BCF_API_KEY로 실제 모델과 기존 Agent까지 검증 (API 사용량 발생)
pnpm test:playwright --model farm
```

테스트는 localhost의 임시 페이지만 사용한다. 임시 홈·출력·JSONL은 종료 때 정리하며 기존 사용자 세션과 메모리를 변경하지 않는다. 실제 모델 테스트에는 호출 횟수 상한 10회를 두었다.

## 연결 단계 완료 시 남아 있던 항목

- MCP 이미지 결과를 공통 이미지 블록으로 전달하는 기능은 아직 구현하지 않았다.
- 다른 컴퓨터에는 Node.js, 서버 패키지와 사용 가능한 브라우저가 필요하다. 패키지 설치와 MCP 연결 성공만으로 브라우저 실행까지 보장되는 것은 아니다.
- 기존 MCP 호출 제한 시간은 15초다. 느린 페이지나 브라우저 설치처럼 오래 걸리는 작업의 제한 시간 정책은 이번에 변경하지 않았다.

## 후속: MCP 이미지 결과 연결

- 사용자의 추가 요청으로 `--image-responses omit`을 제거했다.
- `mcpResultText`를 `mcpResultContent`로 바꿨다. PNG 이미지가 있으면 텍스트·이미지 순서를 보존한 공통 블록 배열을 반환하고, 텍스트만 있으면 기존 문자열 결과를 유지한다.
- `loadImage`의 PNG 검증을 `imageFromBytes`로 분리해 파일과 MCP가 재사용한다. 별도 임시 이미지 파일을 쓰거나 `readImage` 도구를 중첩 호출하지 않는다.
- MCP 인라인 이미지에는 로컬 파일 경로가 없을 수 있어 `ImageBlock.path`를 선택 항목으로 바꿨다. 없는 경로를 만들거나 `undefined` 경로 안내를 모델에 넣지 않는다.
- 기존 PNG 크기·치수·요청 합계 제한을 유지한다. JPEG/WebP, 잘못된 base64·PNG, 초과 크기·치수는 모델에게 기존 도구 오류 경로로 반환한다. 비정상 MCP 결과의 이미지는 오류 텍스트로 직렬화하지 않는다.
- `Agent`, `ToolManager`, 제공자 어댑터는 변경하지 않았다. 기존 이미지 전달 경로를 사용한다.
- 실제 브라우저 스모크에 PNG 수신 검증과 canvas 색상을 이미지로 읽는 모델 테스트를 추가했다. 색상은 매 실행 무작위이며 페이지 구조에 답을 포함하지 않는다. 유료 모델 테스트의 상한은 턴마다 10회다.
- Playwright MCP 0.0.80의 스크린샷 스키마에서는 `scale`이 필수이므로 직접 호출 테스트에 `scale: "css"`를 지정했다.
- 자동 테스트 129개, strict 타입 검사, Bun 빌드 통과. 경로 없는 이미지의 Responses·Anthropic 요청 형식도 모의 응답 테스트로 확인했다.
- 실제 Farm Luna 검증: 기존 클릭 테스트 통과 후 별도 턴에서 navigate → screenshot → 최종 답변의 3회 모델 호출로 무작위 canvas 색상 `Yellow`를 맞췄다. 툴 결과에 이미지 블록이 존재하고 JavaScript 평가 도구로 답을 읽지 않았는지도 검사했다.
- 설치 버전은 스크린샷에 `filename`을 지정하면 파일만 저장하고 인라인 이미지는 반환하지 않는다(`coreBundle.js`의 screenshot handler에서 확인). 최초 모델 테스트에서는 이미지가 없어 실패했고, 인라인 결과 검증 요청에 filename 생략을 명시한 뒤 통과했다. 저장 경로로 받은 스크린샷은 기존 `readImage`로 읽을 수도 있지만 이번 검증은 그 우회 경로를 사용하지 않았다.
