# sharp 기반 이미지 검사

## 변경

- `sharp@0.35.4`를 추가하고 수동 PNG 헤더 검사를 교체했다.
- 파일 입력과 MCP 이미지에 같은 비동기 `imageFromBytes()`를 사용한다.
- PNG·JPEG·WebP 정지 이미지를 실제 바이트로 판별하고 픽셀 디코딩을 검사한다. 원본 바이트와 메타데이터는 변환하지 않는다.
- EXIF 회전으로 축이 바뀌는 경우 표시 기준 치수를 기록한다.
- 다중 프레임은 명시적으로 거절한다. MCP에서 선언한 MIME과 실제 형식이 다르면 오류 결과로 반환한다.
- 기존 4 MiB/4096px/요청 합계 8 MiB 제한은 유지한다. 자동 축소·컨텍스트 이미지 정리는 추가하지 않았다.
- MCP 콘텐츠는 순차 처리해 블록 순서를 유지하고 여러 이미지의 디코딩을 한꺼번에 시작하지 않는다.

## 검증

- `pnpm test`: 133개 통과.
- `pnpm --package=typescript dlx tsc --noEmit --strict`: 통과.
- `git diff --check`: 통과.
- 실제 `pnpm test:playwright`: 페이지 탐색·클릭·카운터 변경·PNG 스크린샷 변환 통과. LLM 호출 없는 테스트다.
- JPEG·WebP의 Responses/Anthropic 사용자 첨부·툴 결과 전송은 모의 HTTP 응답으로 검증했다. 이번 변경에서 실제 모델 API는 호출하지 않았다.

## 미해결: Bun 단일 실행파일 배포

- `pnpm build` 자체는 성공한다.
- 그러나 빌드 결과를 저장소 밖 `/tmp`에서 실행하면 시작 시 `Could not load the "sharp" module using the darwin-arm64 runtime`으로 실패한다.
- 소스 실행은 정상이다. 빌드 성공만으로 독립 실행파일 배포를 검증했다고 볼 수 없다. 현재 dist 결과물은 배포하지 않아야 한다.
- sharp는 OS별 네이티브 애드온과 libvips에 의존한다. 현 빌드 설정으로는 런타임 의존성이 해결되지 않는다.
- 사용자에게 이 결과를 알렸다. 단일 파일에 네이티브 의존성을 포함시키는 별도 패키징 또는 의존 파일 동봉처럼 배포 방식에 영향을 주는 변경은 이번에 임의로 진행하지 않았다.
- 참고: https://sharp.pixelplumbing.com/install/ 및 https://bun.sh/docs/bundler/executables (Embed N-API Addons).
