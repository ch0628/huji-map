# TASK 01 — Next.js 기본 화면 및 폴더 생성

## Antigravity에 그대로 붙여 넣을 지시

현재 workspace의 `AGENTS.md` 규칙을 반드시 따른다. **지금은 TASK 01만 수행하고 다른 TASK는 절대 시작하지 않는다.**

**목적:** Next.js 기본 화면 및 폴더 생성

**읽을 명세:** docs/02_ARCHITECTURE.md, docs/05_SCREEN_SPEC.md. 추가로 `docs/11_DECISIONS.md`를 참고한다.

**수정 허용 경로:** `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.*`, `postcss.config.*`, `eslint.config.*`, `next-env.d.ts`, `src/app/**`, `src/components/layout/**`, `public/**`, `.env.example`, `.gitignore`. `IMPLEMENTATION_STATUS.md`는 항상 갱신할 수 있다. 필요한 다른 파일이 있으면 임의로 변경하지 말고 이유를 보고하고 사용자 승인을 받는다.

**구현 지시:** Next.js 안정 버전 App Router+TypeScript+Tailwind 프로젝트를 생성한다. 이 workspace에는 이미 설계 파일이 있으므로 `create-next-app .` 실행으로 충돌을 일으키지 않는다. 필요하면 임시 하위/인접 디렉터리에 scaffold를 만든 뒤 앱 구성 파일만 안전하게 workspace로 가져오고 임시 파일을 정리한다. 기존 앱 코드가 있으면 무단 재생성 금지. 한국어 모바일 앱 셸, 홈에서 `/map` 진입 가능한 Placeholder, 공통 헤더/오류/로딩 UI. `.env.example` 변수명만 작성. 데이터/인증/지도/API 연동은 하지 않는다.

**완료 기준:** 실행 가능한 dev 서버, `/`/`/map` Placeholder, 빌드 성공; 유료·실결제 없음.

## 반드시 수행할 검증

1. 변경 전 필요한 코드 파일과 기존 기능을 확인한다.
2. 작업에 맞는 unit/integration test 또는 화면 smoke를 추가하고 가능한 한 직접 실행한다.
3. 준비된 경우 `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`를 실행한다. 외부 서비스 키가 없으면 실연동은 `BLOCKED`로 표시한다.
4. 키·PIN·전화번호·영수증·개인정보가 일반 응답/로그/커밋에 유출되지 않았는지 점검한다.
5. `IMPLEMENTATION_STATUS.md`의 TASK 01에 수정 파일/테스트 명령/정확한 PASS·FAIL·BLOCKED/남은 사용자 액션을 기록한다.
6. 사용자에게 6줄 이내로 결과를 요약하고 **멈춘다**. 다음 TASK를 실행하거나 넓은 범위로 리팩터링하지 않는다.

