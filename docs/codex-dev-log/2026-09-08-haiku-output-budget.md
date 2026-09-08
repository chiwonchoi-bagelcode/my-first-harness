# Haiku 코딩용 기본 출력 한도

- `model-config.ts`의 Haiku 4.5 구성에 `maxOutputTokens: 32_000`을 지정했다. 기존에는 공통 Anthropic 어댑터의 fallback인 4,096이 적용됐다.
- 공식 모델 사양은 최대 출력 64K다: https://platform.claude.com/docs/en/models/haiku-4-5/overview
- 32,000은 이번에 선택한 기본 요청 한도이지 모델의 최대 능력이 아니다. 다음 단계의 자동 재시도에서 더 높은 한도를 요청할 여지를 남긴다.
- AIProxy 가이드의 `/anthropic/v1/messages`는 원본 Messages 형식을 사용한다. 실제 AIProxy에 `max_tokens: 32000`과 짧은 응답 요청을 보내 HTTP 200 / 정상 종료를 확인했다. 입력 16·출력 5토큰이었으며, 32K 길이의 생성이나 프록시의 최댓값까지 검증한 것은 아니다.
- 요청에 명시한 `maxOutputTokens`가 모델 기본값보다 우선한다. 따라서 압축 요약의 2,048 제한은 유지된다. 다른 모델과 공통 어댑터 fallback은 변경하지 않았다.
- 모의 HTTP 테스트로 Haiku 기본값, 요청별 2,048·64,000 재정의, 다음 요청의 기본값 복귀, Luna 요청 미변경을 확인했다. 64,000 재정의는 모의 테스트이며 실제 API 검증이 아니다.
- `pnpm build`, `pnpm test` 156개 통과.
- 자동 한도 증가·재시도·작업 분할·오류 후 세션 복구는 이번 범위에 포함하지 않았다. README·전역 설치본·세션 데이터는 수정하지 않았다.
