# TASK 29 — 관리자 영수증 심사 화면

## Antigravity에 그대로 붙여 넣을 지시

현재 workspace의 `AGENTS.md` 규칙을 반드시 따른다. **지금은 TASK 29만 수행하고 다른 TASK는 절대 시작하지 않는다.**

**목적:** 관리자 영수증 심사 화면

**읽을 명세:** docs/05_SCREEN_SPEC.md, docs/07_PAYMENT_ACCESS_REFUND.md. 추가로 `docs/11_DECISIONS.md`를 참고한다.

**수정 허용 경로:** `src/app/admin/receipts/**`, `src/components/receipt/**`, `tests/**`. `IMPLEMENTATION_STATUS.md`는 항상 갱신할 수 있다. 필요한 다른 파일이 있으면 임의로 변경하지 말고 이유를 보고하고 사용자 승인을 받는다.

**구현 지시:** 관리자 대기열·개별 사진 뷰어·가게/구매시간/결제 비교 UI, 승인/반려/재제출 사유 입력. 백엔드 검증을 UI 우회할 수 없고 PG 취소는 다음 단계.

**완료 기준:** 필드 비교 및 원본 표시, 로그인/권한 없는 접근 실패, UI 승인 후 별도 환급 대기.

## 반드시 수행할 검증

1. 변경 전 필요한 코드 파일과 기존 기능을 확인한다.
2. 작업에 맞는 unit/integration test 또는 화면 smoke를 추가하고 가능한 한 직접 실행한다.
3. 준비된 경우 `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`를 실행한다. 외부 서비스 키가 없으면 실연동은 `BLOCKED`로 표시한다.
4. 키·PIN·전화번호·영수증·개인정보가 일반 응답/로그/커밋에 유출되지 않았는지 점검한다.
5. `IMPLEMENTATION_STATUS.md`의 TASK 29에 수정 파일/테스트 명령/정확한 PASS·FAIL·BLOCKED/남은 사용자 액션을 기록한다.
6. 사용자에게 6줄 이내로 결과를 요약하고 **멈춘다**. 다음 TASK를 실행하거나 넓은 범위로 리팩터링하지 않는다.

