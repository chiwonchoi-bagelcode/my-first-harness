# Bun 빌드 산출물 폴더 정리

- main에서 루트의 기존 실행파일과 `.bun-build` 파일 7개를 `dist/`로 이동했다. 임시 파일은 삭제하지 않았다.
- `package.json`에 `build` 명령을 추가했다. `dist/`를 만든 뒤 그 안에서 Bun 빌드를 실행하므로 출력 실행파일과 작업 디렉터리 기준 임시 산출물을 루트와 분리한다.
- 앞으로 `pnpm build` 또는 `bun run build`를 사용한다. 옵션 없이 별도로 실행하는 `bun build` 명령의 동작 자체를 변경한 것은 아니다.
- `pnpm build`로 최신 소스를 다시 빌드했다. 결과는 `dist/my-first-harness`이며 기존 실행파일을 갱신했다. 프로젝트 루트에서 `./dist/my-first-harness`로 실행하면 작업 폴더는 프로젝트 루트로 유지된다.
- 루트에 실행파일/`.bun-build`가 남지 않았고 `dist/`가 기존 `.gitignore`에 의해 제외됨을 확인했다. README와 `.gitignore`는 변경하지 않았다.
- 이번 검증은 빌드 및 경로 확인이며 LLM/MCP 실행 검증은 하지 않았다.
