# TASK 32 — E2E·보안 점검·배포 준비

## Antigravity에 그대로 붙여 넣을 지시

현재 workspace의 `AGENTS.md` 규칙을 반드시 따른다. **지금은 TASK 32만 수행하고 다른 TASK는 절대 시작하지 않는다.**

**목적:** E2E·보안 점검·배포 준비

**읽을 명세:** docs/09_TEST_AND_ACCEPTANCE.md, docs/08_SECURITY_OPERATIONS.md, docs/10_CONFIG_AND_BLOCKERS.md. 추가로 `docs/11_DECISIONS.md`를 참고한다.

**수정 허용 경로:** `tests/**`, `docs/deployment_checklist.md`, `docs/security_review.md`, `package.json`. `IMPLEMENTATION_STATUS.md`는 항상 갱신할 수 있다. 필요한 다른 파일이 있으면 임의로 변경하지 말고 이유를 보고하고 사용자 승인을 받는다.

**구현 지시:** 전체 작업이 완료되었는지 검사하고 A01~A22 수용 테스트, 모바일 smoke, 비밀 누출 여부, 보안 RLS/권한 검사, 환경변수 검사를 실시한다. 테스트 모드 Vercel 배포는 사전 계정 권한이 있을 때만. 운영 라이브 키나 실제 결제는 활성화 금지.

**완료 기준:** 실제 실행 증거와 blocked 항목을 표로 작성; 여전히 사용자/PG/가게 허가 없는 외부 행동은 하지 않음.

## 반드시 수행할 검증

1. 변경 전 필요한 코드 파일과 기존 기능을 확인한다.
2. 작업에 맞는 unit/integration test 또는 화면 smoke를 추가하고 가능한 한 직접 실행한다.
3. 준비된 경우 `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`를 실행한다. 외부 서비스 키가 없으면 실연동은 `BLOCKED`로 표시한다.
4. 키·PIN·전화번호·영수증·개인정보가 일반 응답/로그/커밋에 유출되지 않았는지 점검한다.
5. `IMPLEMENTATION_STATUS.md`의 TASK 32에 수정 파일/테스트 명령/정확한 PASS·FAIL·BLOCKED/남은 사용자 액션을 기록한다.
6. 사용자에게 6줄 이내로 결과를 요약하고 **멈춘다**. 다음 TASK를 실행하거나 넓은 범위로 리팩터링하지 않는다.

