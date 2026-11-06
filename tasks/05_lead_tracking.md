# TASK 05 — 가게 접촉 50곳 리드/기록

## Antigravity에 그대로 붙여 넣을 지시

현재 workspace의 `AGENTS.md` 규칙을 반드시 따른다. **지금은 TASK 05만 수행하고 다른 TASK는 절대 시작하지 않는다.**

**목적:** 가게 접촉 50곳 리드/기록

**읽을 명세:** docs/03_DATA_MODEL.md, docs/06_EVENTS_AND_PMF.md, docs/04_API_CONTRACT.md. 추가로 `docs/11_DECISIONS.md`를 참고한다.

**수정 허용 경로:** `supabase/migrations/**`, `src/app/api/v1/admin/leads/**`, `src/app/admin/leads/**`, `src/lib/leads/**`, `tests/**`. `IMPLEMENTATION_STATUS.md`는 항상 갱신할 수 있다. 필요한 다른 파일이 있으면 임의로 변경하지 말고 이유를 보고하고 사용자 승인을 받는다.

**구현 지시:** `business_leads` + `lead_contact_attempts` migration, admin-only create/list/detail/contact API와 가벼운 테이블 UI 작성. 최초 분모는 연락 시도가 존재하는 고유 lead. 가상의 실제 리드를 시드하지 않는다. 전화번호·메모 공개 금지.

아직 `businesses` 테이블이 없다면 `converted_business_id` 외래키는 `business_backend`에서 추가하고 지금은 UUID 열만 둔다.

**완료 기준:** 리드 추가/연락시도/필터 동작; 일반 회원·비회원에게 403/401; 중복 연락은 고유 리드 한 개로 집계.

## 반드시 수행할 검증

1. 변경 전 필요한 코드 파일과 기존 기능을 확인한다.
2. 작업에 맞는 unit/integration test 또는 화면 smoke를 추가하고 가능한 한 직접 실행한다.
3. 준비된 경우 `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`를 실행한다. 외부 서비스 키가 없으면 실연동은 `BLOCKED`로 표시한다.
4. 키·PIN·전화번호·영수증·개인정보가 일반 응답/로그/커밋에 유출되지 않았는지 점검한다.
5. `IMPLEMENTATION_STATUS.md`의 TASK 05에 수정 파일/테스트 명령/정확한 PASS·FAIL·BLOCKED/남은 사용자 액션을 기록한다.
6. 사용자에게 6줄 이내로 결과를 요약하고 **멈춘다**. 다음 TASK를 실행하거나 넓은 범위로 리팩터링하지 않는다.

