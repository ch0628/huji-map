# TASK 24 — 유효 이용권에만 PIN 공개 API

## Antigravity에 그대로 붙여 넣을 지시

현재 workspace의 `AGENTS.md` 규칙을 반드시 따른다. **지금은 TASK 24만 수행하고 다른 TASK는 절대 시작하지 않는다.**

**목적:** 유효 이용권에만 PIN 공개 API

**읽을 명세:** docs/07_PAYMENT_ACCESS_REFUND.md, docs/08_SECURITY_OPERATIONS.md. 추가로 `docs/11_DECISIONS.md`를 참고한다.

**수정 허용 경로:** `supabase/migrations/**`, `src/lib/access/**`, `src/app/api/v1/access/**`, `tests/**`. `IMPLEMENTATION_STATUS.md`는 항상 갱신할 수 있다. 필요한 다른 파일이 있으면 임의로 변경하지 말고 이유를 보고하고 사용자 승인을 받는다.

**구현 지시:** `pin_reveal_audits,visit_confirmations` migration. 접근 소유자/서버 Toss 테스트 승인/기한/시설/코드 버전 검사 후 no-store PIN 반환하는 서버 API를 구현. 성공/거부 감사 기록. 방문 확인 주장은 이후 UI 태스크에서 처리.

**완료 기준:** 익명/타인/미결제/만료 PIN 전부 거부; 유효 테스트 이용권만 응답; PIN 로그 유출 없음.

## 반드시 수행할 검증

1. 변경 전 필요한 코드 파일과 기존 기능을 확인한다.
2. 작업에 맞는 unit/integration test 또는 화면 smoke를 추가하고 가능한 한 직접 실행한다.
3. 준비된 경우 `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`를 실행한다. 외부 서비스 키가 없으면 실연동은 `BLOCKED`로 표시한다.
4. 키·PIN·전화번호·영수증·개인정보가 일반 응답/로그/커밋에 유출되지 않았는지 점검한다.
5. `IMPLEMENTATION_STATUS.md`의 TASK 24에 수정 파일/테스트 명령/정확한 PASS·FAIL·BLOCKED/남은 사용자 액션을 기록한다.
6. 사용자에게 6줄 이내로 결과를 요약하고 **멈춘다**. 다음 TASK를 실행하거나 넓은 범위로 리팩터링하지 않는다.

