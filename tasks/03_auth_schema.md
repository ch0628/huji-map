# TASK 03 — 회원/역할/방문 세션 DB 마이그레이션

## Antigravity에 그대로 붙여 넣을 지시

현재 workspace의 `AGENTS.md` 규칙을 반드시 따른다. **지금은 TASK 03만 수행하고 다른 TASK는 절대 시작하지 않는다.**

**목적:** 회원/역할/방문 세션 DB 마이그레이션

**읽을 명세:** docs/03_DATA_MODEL.md, docs/08_SECURITY_OPERATIONS.md. 추가로 `docs/11_DECISIONS.md`를 참고한다.

**수정 허용 경로:** `supabase/migrations/**`, `src/lib/db/**`, `src/lib/supabase/**`, `tests/integration/auth_schema*`. `IMPLEMENTATION_STATUS.md`는 항상 갱신할 수 있다. 필요한 다른 파일이 있으면 임의로 변경하지 말고 이유를 보고하고 사용자 승인을 받는다.

**구현 지시:** auth 관련 `profiles,user_roles,visitor_sessions,consent_records` 테이블 SQL migration 작성. RLS enabled 기본 거부, auth.users 후킹은 idempotent SECURITY DEFINER with safe search_path, 기본 role customer. admin은 공개 signup으로 부여 불가. Supabase cookie SSR server/browser helpers를 작성. 키 없이도 SQL·타입 검증 가능하도록 한다. UI/API 구현 금지.

추가로 `feature_flags`도 해당 역할/설정과 함께 생성한다.

**완료 기준:** SQL 마이그레이션 작성됨, 전 테이블 RLS 활성, 일반 회원이 admin 자체 할당 불가능; Supabase 접속 정보 없으면 remote apply BLOCKED.

## 반드시 수행할 검증

1. 변경 전 필요한 코드 파일과 기존 기능을 확인한다.
2. 작업에 맞는 unit/integration test 또는 화면 smoke를 추가하고 가능한 한 직접 실행한다.
3. 준비된 경우 `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`를 실행한다. 외부 서비스 키가 없으면 실연동은 `BLOCKED`로 표시한다.
4. 키·PIN·전화번호·영수증·개인정보가 일반 응답/로그/커밋에 유출되지 않았는지 점검한다.
5. `IMPLEMENTATION_STATUS.md`의 TASK 03에 수정 파일/테스트 명령/정확한 PASS·FAIL·BLOCKED/남은 사용자 액션을 기록한다.
6. 사용자에게 6줄 이내로 결과를 요약하고 **멈춘다**. 다음 TASK를 실행하거나 넓은 범위로 리팩터링하지 않는다.

