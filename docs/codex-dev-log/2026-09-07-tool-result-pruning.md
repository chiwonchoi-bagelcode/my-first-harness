# 요약 전 긴 툴 결과 정리

## 실제 구현에서 가져온 정책

로컬 DeepSeek Harness의 `packages/compaction/compaction-tool-result-pruner/src/config.ts`와 `src/index.ts`를 기준으로 했다.

- 자동 압축 기준에 도달한 경우에만 정리한다.
- 8,192 Unicode code points를 초과한 툴 결과를 앞 4,096 + 생략 표시 + 뒤 1,024자로 교체한다.
- 오래된 턴 여부는 선택 기준이 아니다. 최근 결과도 길면 정리한다.
- 정리한 뒤 다시 크기를 측정하고, 여전히 기준 이상일 때만 LLM 요약을 호출한다.

## 우리 코드의 대응

- `context-manager.ts`의 `pruneToolResults()`가 messages에 새 메시지 객체를 넣는다. history와 공유하는 원본 객체를 직접 수정하지 않는다.
- role과 tool_call_id 등 나머지 필드를 보존한다.
- `step()`에서 기존 60,000자 기준을 확인한 뒤 정리 → 저장 → 재측정 → 필요 시 요약 순서로 실행한다.
- `/compact`는 기존의 명시적 요약 명령으로 유지한다.
- DSH의 이벤트 기반 교체 및 token meter 대신 기존 두 배열과 JSON 문자열 길이를 사용한다. 텍스트 문자열 결과만 처리한다.
- 원문 조회 도구, 원문 경로 안내, 결과 별도 파일 저장은 추가하지 않았다.
- README는 변경하지 않았다.

## 검증

- `pnpm test`: 기존 10개 + 신규 6개, 총 16개 통과.
- 원본/호출 ID 보존, 길이 경계, 반복 실행 시 재정리 없음, 이모지 처리, 요약 생략 판단, 정리된 입력의 요약 전달, 저장/resume을 검증했다.
- `pnpm --package=typescript dlx tsc --noEmit`: 통과.
- `git diff --check`: 통과.
- 이번 변경의 테스트는 로컬 및 가짜 요약 응답으로 진행했다. 실제 장기 작업이나 API 호출은 추가 실행하지 않았다.
