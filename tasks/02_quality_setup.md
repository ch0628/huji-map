# TASK 02 — 테스트·정적분석 도구만 구축

## Antigravity에 그대로 붙여 넣을 지시

현재 workspace의 `AGENTS.md` 규칙을 반드시 따른다. **지금은 TASK 02만 수행하고 다른 TASK는 절대 시작하지 않는다.**

**목적:** 테스트·정적분석 도구만 구축

**읽을 명세:** docs/09_TEST_AND_ACCEPTANCE.md. 추가로 `docs/11_DECISIONS.md`를 참고한다.

**수정 허용 경로:** `package.json`, `eslint.config.*`, `vitest.config.*`, `playwright.config.*`, `tests/**`, `tsconfig.json`. `IMPLEMENTATION_STATUS.md`는 항상 갱신할 수 있다. 필요한 다른 파일이 있으면 임의로 변경하지 말고 이유를 보고하고 사용자 승인을 받는다.

**구현 지시:** `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build` 스크립트와 Vitest 기본 smoke를 준비한다. Playwright는 환경이 지원되면 smoke 파일만 추가하고 설치가 불가능하면 명시. 기능 구현하지 않는다.

**완료 기준:** 빈 테스트가 아니라 최소 1개 실행되는 단위 테스트, 타입검사, lint 모두 통과; 실패 로그 보고.

## 반드시 수행할 검증

1. 변경 전 필요한 코드 파일과 기존 기능을 확인한다.
2. 작업에 맞는 unit/integration test 또는 화면 smoke를 추가하고 가능한 한 직접 실행한다.
3. 준비된 경우 `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`를 실행한다. 외부 서비스 키가 없으면 실연동은 `BLOCKED`로 표시한다.
4. 키·PIN·전화번호·영수증·개인정보가 일반 응답/로그/커밋에 유출되지 않았는지 점검한다.
5. `IMPLEMENTATION_STATUS.md`의 TASK 02에 수정 파일/테스트 명령/정확한 PASS·FAIL·BLOCKED/남은 사용자 액션을 기록한다.
6. 사용자에게 6줄 이내로 결과를 요약하고 **멈춘다**. 다음 TASK를 실행하거나 넓은 범위로 리팩터링하지 않는다.

