-- ============================================================================
-- File: tests/integration/sql/auth_rls.pgtap.sql
-- Description: Official pgTAP test suite for TASK 03-B3 (Auth Trigger & RLS)
-- Usage (Local Docker Stack):
--   npx supabase start
--   npx supabase test db tests/integration/sql/auth_rls.pgtap.sql
-- Safety: Wrapped in BEGIN ... ROLLBACK; zero persistent changes.
-- ============================================================================

BEGIN;

SELECT plan(18);

-- [0] 사전 안전 확인: 합성 테스트 식별자가 기존 데이터와 충돌하지 않는지 검증
SELECT is(
  (
    SELECT (
      (SELECT count(*) FROM auth.users WHERE id IN ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2') OR email IN ('test_b3_u1@example.invalid', 'test_b3_u2@example.invalid')) +
      (SELECT count(*) FROM public.profiles WHERE id IN ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2')) +
      (SELECT count(*) FROM public.user_roles WHERE user_id IN ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2')) +
      (SELECT count(*) FROM public.visitor_sessions WHERE id IN ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000d2') OR user_id IN ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2') OR browser_id IN ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000c2')) +
      (SELECT count(*) FROM public.consent_records WHERE id IN ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000e2') OR user_id IN ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2') OR browser_id IN ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000c2')) +
      (SELECT count(*) FROM public.feature_flags WHERE key = '__test_b3_unauthorized_flag__')
    )::int
  ),
  0,
  '0: 모든 대상 테이블(auth.users, profiles, user_roles, visitor_sessions, consent_records, feature_flags)에 합성 테스트 식별자 충돌 없음'
);

-- 테스트용 합성 사용자 2명 생성 (auth.users INSERT -> on_auth_user_created 트리거 검증)
INSERT INTO auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
VALUES
  (
    '00000000-0000-4000-8000-0000000000b1',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'test_b3_u1@example.invalid',
    'unused_hash',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"DEMO_TEST_U1","preferred_language":"ko"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-4000-8000-0000000000b2',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'test_b3_u2@example.invalid',
    'unused_hash',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"name":"DEMO_TEST_U2"}'::jsonb,
    now(),
    now()
  );

-- [A-1] 테스트 사용자 생성 시 profiles 레코드가 자동 생성되는지 확인
SELECT is(
  (SELECT count(*)::int FROM public.profiles WHERE id IN ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2') AND account_status = 'active'),
  2,
  'A-1: auth.users INSERT 시 active 상태의 profiles 레코드 2건 자동 생성'
);

-- [A-2] user_roles에 customer 권한이 자동 부여되는지 확인
SELECT is(
  (SELECT count(*)::int FROM public.user_roles WHERE user_id IN ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2') AND role = 'customer'),
  2,
  'A-2: 신규 사용자에게 user_roles.role = customer 자동 부여'
);

-- [A-3] 신규 사용자가 admin/merchant 권한을 자동으로 받지 않는지 확인
SELECT is(
  (SELECT count(*)::int FROM public.user_roles WHERE user_id IN ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2') AND role IN ('admin', 'merchant')),
  0,
  'A-3: 신규 사용자에게 admin 또는 merchant 권한이 자동 부여되지 않음'
);

-- [C-1a] 실제 관리자 권한 부여 동작 확인 (트랜잭션 내 u2에 admin 부여 후 서버/본인 확인)
INSERT INTO public.user_roles (user_id, role, granted_by)
VALUES ('00000000-0000-4000-8000-0000000000b2', 'admin', NULL);

SELECT is(
  public.is_admin('00000000-0000-4000-8000-0000000000b2'),
  true,
  'C-1a: u2에 admin 역할 부여 후 서버 컨텍스트에서 is_admin(u2)는 true를 반환함'
);

-- 일반 로그인 사용자(u1) 역할 및 JWT claim 설정
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}';

-- [B-1] 일반 사용자는 자신의 프로필만 조회 및 수정 가능
UPDATE public.profiles
SET display_name = 'DEMO_TEST_U1_UPDATED', preferred_language = 'en'
WHERE id = '00000000-0000-4000-8000-0000000000b1';

SELECT is(
  (SELECT display_name FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000b1'),
  'DEMO_TEST_U1_UPDATED',
  'B-1: 일반 사용자는 자신의 프로필(display_name, preferred_language)을 수정할 수 있음'
);

-- [B-2] 다른 사용자(u2)의 프로필을 조회하거나 수정할 수 없음
UPDATE public.profiles
SET display_name = 'HACKED_U2'
WHERE id = '00000000-0000-4000-8000-0000000000b2';

SELECT is(
  (SELECT count(*)::int FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000b2'),
  0,
  'B-2: 일반 사용자는 타인의 프로필을 조회하거나 수정할 수 없음'
);

-- [B-3] 다른 사용자(u2)의 권한을 조회하거나 변경할 수 없음
UPDATE public.user_roles
SET role = 'customer'
WHERE user_id = '00000000-0000-4000-8000-0000000000b2';

SELECT is(
  (SELECT count(*)::int FROM public.user_roles WHERE user_id = '00000000-0000-4000-8000-0000000000b2'),
  0,
  'B-3: 일반 사용자는 타인의 권한을 조회하거나 변경할 수 없음'
);

-- [B-4] 일반 사용자가 admin 권한을 직접 추가(INSERT)할 수 없음
SELECT throws_ok(
  $$INSERT INTO public.user_roles (user_id, role) VALUES ('00000000-0000-4000-8000-0000000000b1', 'admin')$$,
  '42501',
  NULL,
  'B-4: 일반 사용자의 admin 권한 자가 추가(INSERT)는 RLS(42501)에 의해 차단됨'
);

-- [B-5a] 일반 사용자가 profiles.account_status를 임의 변경할 수 없음
SELECT throws_ok(
  $$UPDATE public.profiles SET account_status = 'suspended' WHERE id = '00000000-0000-4000-8000-0000000000b1'$$,
  'P0001',
  'Forbidden: account_status and created_at can only be modified by server or admin',
  'B-5a: 일반 사용자의 profiles.account_status 변경은 보호 트리거(P0001)에 의해 차단됨'
);

-- [B-5b] 일반 사용자가 profiles.created_at을 임의 변경할 수 없음
SELECT throws_ok(
  $$UPDATE public.profiles SET created_at = now() - interval '10 days' WHERE id = '00000000-0000-4000-8000-0000000000b1'$$,
  'P0001',
  'Forbidden: account_status and created_at can only be modified by server or admin',
  'B-5b: 일반 사용자의 profiles.created_at 변경은 보호 트리거(P0001)에 의해 차단됨'
);

-- [C-1b] 실제 admin인 u2에 대해 일반 사용자 u1이 is_admin(u2) 호출 시 false를 반환하여 관리자 열거 차단
SELECT is(
  public.is_admin('00000000-0000-4000-8000-0000000000b2'),
  false,
  'C-1b: 실제 admin인 u2에 대해 타인(u1)이 is_admin(u2) 호출 시 false를 반환하여 열거 차단'
);

-- [C-2] handle_new_user() 함수를 일반 사용자 및 익명 사용자가 직접 실행할 수 없음
SELECT is(
  has_function_privilege('authenticated', 'public.handle_new_user()', 'EXECUTE')
  OR has_function_privilege('anon', 'public.handle_new_user()', 'EXECUTE'),
  false,
  'C-2: handle_new_user()는 anon 및 authenticated 역할의 직접 실행(EXECUTE)이 차단됨'
);

-- [C-3a] visitor_sessions 본인 세션 생성 허용 및 타인 user_id 위조 차단
SELECT lives_ok(
  $$INSERT INTO public.visitor_sessions (id, browser_id, user_id, landing_path, device_type, is_test)
    VALUES ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000b1', '/map', 'mobile', true)$$,
  'C-3a(허용): 로그인 사용자는 자신의 user_id로 visitor_sessions를 생성할 수 있음'
);

SELECT throws_ok(
  $$INSERT INTO public.visitor_sessions (id, browser_id, user_id, landing_path, device_type, is_test)
    VALUES ('00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000b2', '/map', 'mobile', true)$$,
  '42501',
  NULL,
  'C-3b(차단): 타인의 user_id를 위조한 visitor_sessions INSERT는 RLS(42501)에 의해 차단됨'
);

-- [C-3b] consent_records 본인 동의 기록 생성 허용 및 타인 user_id 위조 차단
SELECT lives_ok(
  $$INSERT INTO public.consent_records (id, user_id, browser_id, consent_type, policy_version, accepted)
    VALUES ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000c1', 'terms', 'v1.0', true)$$,
  'C-3c(허용): 로그인 사용자는 자신의 user_id로 consent_records를 생성할 수 있음'
);

SELECT throws_ok(
  $$INSERT INTO public.consent_records (id, user_id, browser_id, consent_type, policy_version, accepted)
    VALUES ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000c2', 'terms', 'v1.0', true)$$,
  '42501',
  NULL,
  'C-3d(차단): 타인의 user_id를 위조한 consent_records INSERT는 RLS(42501)에 의해 차단됨'
);

-- [C-4] feature_flags 공개 읽기 허용 및 비관리자 쓰기 차단
SELECT throws_ok(
  $$INSERT INTO public.feature_flags (key, enabled, config)
    VALUES ('__test_b3_unauthorized_flag__', true, '{}'::jsonb)$$,
  '42501',
  NULL,
  'C-4: 일반 사용자의 feature_flags INSERT는 RLS(42501)에 의해 차단됨'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
