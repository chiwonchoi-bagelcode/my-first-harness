# 검증용 Bun 빌드도 dist에서 실행

- 정식 `pnpm build`는 이미 `cd dist` 후 빌드한다. 설정 오류가 아니었다.
- TUI fixture 검증 때 저장소 루트에서 `bun build --compile ... --outfile /tmp/...`를 직접 실행했다. 최종 실행 파일 경로만 지정해도 Bun의 임시 `.bun-build` 파일은 현재 작업 디렉터리에 남을 수 있다.
- 루트에 남은 Mach-O `.bun-build` 6개를 이름을 유지한 채 `dist/`로 이동했다. 삭제하거나 기존 파일을 덮어쓰지 않았다.
- 앞으로 정식 빌드는 `pnpm build`를 사용한다. 테스트용 직접 컴파일도 반드시 `dist/`를 작업 디렉터리로 지정한다. `--outfile`만 바꾸는 것으로는 충분하지 않다.

검증용 예:

```sh
cd /Users/choechiwon/my-first-harness/dist
bun build --compile ../tests/fixtures/tui-demo.ts --outfile tui-check
```

- 정식 빌드를 재실행해 루트에 `.bun-build` 파일이 생기지 않는지 확인한다.
- README와 빌드 스크립트는 변경하지 않는다.
