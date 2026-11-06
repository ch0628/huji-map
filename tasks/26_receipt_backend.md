# TASK 26 — 영수증 비공개 저장·API

## Antigravity에 그대로 붙여 넣을 지시

현재 workspace의 `AGENTS.md` 규칙을 반드시 따른다. **지금은 TASK 26만 수행하고 다른 TASK는 절대 시작하지 않는다.**

**목적:** 영수증 비공개 저장·API

**읽을 명세:** docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md. 추가로 `docs/11_DECISIONS.md`를 참고한다.

**수정 허용 경로:** `supabase/migrations/**`, `src/app/api/v1/receipts/**`, `src/lib/receipts/**`, `tests/**`. `IMPLEMENTATION_STATUS.md`는 항상 갱신할 수 있다. 필요한 다른 파일이 있으면 임의로 변경하지 말고 이유를 보고하고 사용자 승인을 받는다.

**구현 지시:** `receipt_submissions` 마이그레이션, Supabase private bucket 정책, 소유자 검증/업로드 intent/파일 타입·용량/제출 DB API 구현. 사용자 업로드 화면은 다음 태스크. OCR 없음.

기존 `payment_refunds.receipt_submission_id` FK를 추가한다.

**완료 기준:** 공개 사진 URL 0, 승인 상태 사용자 변경 불가, 다른 계정의 이미지 접근 차단.

## 반드시 수행할 검증

1. 변경 전 필요한 코드 파일과 기존 기능을 확인한다.
2. 작업에 맞는 unit/integration test 또는 화면 smoke를 추가하고 가능한 한 직접 실행한다.
3. 준비된 경우 `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`를 실행한다. 외부 서비스 키가 없으면 실연동은 `BLOCKED`로 표시한다.
4. 키·PIN·전화번호·영수증·개인정보가 일반 응답/로그/커밋에 유출되지 않았는지 점검한다.
5. `IMPLEMENTATION_STATUS.md`의 TASK 26에 수정 파일/테스트 명령/정확한 PASS·FAIL·BLOCKED/남은 사용자 액션을 기록한다.
6. 사용자에게 6줄 이내로 결과를 요약하고 **멈춘다**. 다음 TASK를 실행하거나 넓은 범위로 리팩터링하지 않는다.

