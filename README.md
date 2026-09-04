# my-first-harness

## bagelcode Dash-backery team onboarding assignment

과제:

온보딩 프로젝트 - 자체 하네스 제작

시스템 프롬프트 기능, 세션 기능, 툴 기능, 스킬 기능 정도
API가 돌아갈때 들어가야되는 툴과 컨텍스트,

위 목표 습득 지식을 습득하는게 목적

## 구현 범위
- 턴(유저 입력 1회), 스탭(한 턴에서 돌아가는 여러번의 LLM호출 각각)을 구분한 최소한의 **에이전트 루프**
- **컨텍스트 조립**(시스템 프롬프트, 스킬 로드 메시지, 과거 대화기록, 런타임 컨텍스트(현재 작업 디렉토리))
- **세션**(id단위 세션 저장, /new, /resuem {session-id} 구현)
- **툴**(openAI api형식에 맞춰 입력, 응답의 stop_reason에 따라 실행 후 결과 전달)
- **스킬**(tools에 들어있는 모듈에서 넣거나, .my-first-harness/skills/{skill-name} 에서 로드해 컨텍스트 조립 때 추가)
- **유저 커멘드**(/quit, /new, /resume)

## Quick start

### 1. 저장소 복제

```bash
git clone git@github.com:chiwonchoi-bagelcode/my-first-harness.git
cd my-first-harness
```

### 2. 의존성 설치

```bash
pnpm install
```

### 3. API 키 설정

```bash
cp .env.example .env
```

생성된 `.env`에 AI Proxy API 키를 입력한다.

### 4. 실행

```bash
node my-first-harness.ts
```

실행하면 현재 세션 ID와 입력 프롬프트가 표시된다.

```text
session: <session-id>
>
```

### 사용자 명령어

```text
/new                 새 세션 생성
/resume <session-id> 저장된 세션 재개
/quit                하네스 종료
```

완료된 턴의 대화 기록은 `.my-first-harness/sessions/<session-id>.json`에 저장된다.

`/Users/choechiwon/my-first-harness/.my-first-harness/skills` 여기에 스킬을 평문으로 등록할 수 있다.

`/Users/choechiwon/my-first-harness/tools/` 여기에 툴/스킬을 포함한 플러그인을 추가할 수 있다.

### Study Log

/Users/choechiwon/my-first-harness/docs/my-first-harness-project.pdf