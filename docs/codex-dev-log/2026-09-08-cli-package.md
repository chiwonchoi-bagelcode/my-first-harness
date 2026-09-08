# 전역 명령으로 설치하는 Node.js 패키지

## 채택한 배포 방식

- Bun 단일 실행파일 대신 TypeScript를 ESM JavaScript로 변환해 패키지로 배포한다.
- `package.json`의 `bin`이 `my-first-harness`를 `dist/my-first-harness.js`에 연결한다. 엔트리의 shebang은 Node.js를 지정한다.
- Node.js 24 이상과 pnpm이 필요하다. 실제 검증 환경은 macOS ARM64, Node.js 26.8.1, pnpm 11.25.0이다. 다른 OS의 설치 검증은 아직 하지 않았다.
- sharp와 로컬 MCP 서버는 패키지 의존성으로 설치된다. 네이티브 파일을 실행파일에 강제로 내장하지 않는다.
- Playwright MCP 패키지 설치와 브라우저 설치는 다르다. 브라우저 동작에는 별도로 사용 가능한 Chrome 등이 필요하다.

## 빌드·전달·설치

저장소에서 `pnpm install` 후:

```sh
pnpm build
pnpm pack --out dist/my-first-harness-1.0.0.tgz
```

`pack`에는 빌드 누락을 막는 `prepack`도 연결했다. 출력물은 코드와 패키지 메타데이터만 포함한다. README는 패키지 관리자가 자동으로 포함하지만 이번 작업에서 수정하지 않았다. `.env`, 세션, 테스트, 프로젝트 스킬, playground, 이미지, 이전 Bun 바이너리는 포함하지 않는다.

받는 컴퓨터에서:

```sh
pnpm add -g --config.node-linker=hoisted ./my-first-harness-1.0.0.tgz
```

전역 실행 경로가 설정되지 않아 오류가 나면 `pnpm setup` 후 터미널을 다시 연다. 이번 작업에서는 사용자의 실제 전역 설치나 셸 설정을 변경하지 않았다.

설치 후 원하는 프로젝트에서 `my-first-harness` 또는 `my-first-harness haiku`로 실행한다. 작업 디렉터리는 설치 위치가 아닌 명령을 실행한 위치다.

### 설치 옵션이 필요한 이유

- 첫 임시 전역 설치에서 sharp와 Playwright는 로드됐지만 filesystem/memory MCP 서버가 `Cannot find package 'zod'`로 실패했다.
- 해당 서버의 2026.8.31 배포 코드는 zod를 직접 import하면서 manifest에는 직접 의존성으로 선언하지 않는다. 기존 개발 설치에서는 호이스팅된 간접 의존성 덕분에 동작했다.
- pnpm 11의 기본 격리된 전역 설치에서는 이 누락이 드러났다. 이 배포물의 검증된 설치 방식은 명령 단위의 `--config.node-linker=hoisted`이다.
- 이 옵션은 upstream manifest를 고치는 것이 아니라 설치 파일 배치를 선택하는 해결 방식이다. 타사 파일 패치나 사용자의 전역 pnpm 설정 변경은 하지 않았다.

## 인증 설정

`~/.my-first-harness/.env`에 본인의 `BCF_API_KEY`와 필요한 경우 `AIPROXY_TOKEN`을 설정한다. 실제 키는 배포 파일에 넣지 않는다.

우선순위는 셸 환경변수 > 작업 폴더의 `.env` > 사용자 전역 `.env`이다. 없는 파일은 건너뛰지만 읽기 오류는 숨기지 않는다. 설치 폴더의 `.env`를 찾거나 작업 디렉터리를 바꾸지 않는다. 기존 키 파일을 자동 복사하지 않았다.

## 검증

- `pnpm test`: 135개 통과.
- `pnpm exec tsc --noEmit --strict`, `pnpm build`, `git diff --check`: 통과.
- `pnpm test:package`: 실제 tgz를 임시 전역 경로에 설치했다. 패키지 목록 검사, 다른 cwd에서 명령 실행, 로컬 MCP 서버 3개 연결, PNG/JPEG/WebP 상대 경로 첨부, 프로젝트별 세션 저장 위치, `/quit` 종료를 검증했다.
- 테스트용 HOME·전역 설치 경로·작업 폴더는 새 임시 디렉터리였고 테스트 후 제거했다. 실제 사용자 키를 전달하지 않았으며 모델 API는 호출하지 않았다. 원격 문서 MCP 연결은 기존 시작 경로대로 수행됐다.
- 이전 `2026-09-08-sharp-images.md`의 Bun 실행파일 실패는 이 배포 방식 전환으로 우회됐다. 기존 Bun 결과물은 새 배포물에 들어가지 않으며 이제 `pnpm build`는 JS를 출력한다.
