-- ============================================================================
-- File: tests/integration/sql/verify_auth_rls_rollback.sql
-- Description: Single-statement self-rolling-back PostgreSQL verification for
--              TASK 03-B3 (on_auth_user_created trigger & authenticated RLS).
-- Compatibility: Official Supabase CLI (`npx supabase db query --file ...`)
-- Safety Guarantees:
--   1. Runs as a single PL/pgSQL DO statement (compatible with Extended Query mode).
--   2. Pre-checks that synthetic test identifiers do not exist in auth.users,
--      public.profiles, public.user_roles, public.visitor_sessions,
--      public.consent_records, and public.feature_flags before running.
--   3. Executes all inserts/updates inside a PL/pgSQL subtransaction block and
--      unconditionally aborts that subtransaction via SQLSTATE 'P0099' so that
--      PostgreSQL's RollbackAndReleaseCurrentSubTransaction() rolls back 100%
--      of changes on both pass and fail.
--   4. Post-checks inside the exception handler that v_pass_count equals
--      v_expected_pass_count (15) and 0 test rows remain across all tables.
-- ============================================================================

DO $verify$
DECLARE
  u1 CONSTANT uuid := '00000000-0000-4000-8000-0000000000b1';
  u2 CONSTANT uuid := '00000000-0000-4000-8000-0000000000b2';
  b1 CONSTANT uuid := '00000000-0000-4000-8000-0000000000c1';
  b2 CONSTANT uuid := '00000000-0000-4000-8000-0000000000c2';
  s1 CONSTANT uuid := '00000000-0000-4000-8000-0000000000d1';
  s2 CONSTANT uuid := '00000000-0000-4000-8000-0000000000d2';
  c1 CONSTANT uuid := '00000000-0000-4000-8000-0000000000e1';
  c2 CONSTANT uuid := '00000000-0000-4000-8000-0000000000e2';
  f1 CONSTANT text := '__test_b3_unauthorized_flag__';
  v_expected_pass_count CONSTANT int := 15;
  v_cnt int;
  v_bool boolean;
  v_name text;
  v_lang text;
  v_blocked boolean;
  v_pass_count int := 0;
BEGIN
  -- ==========================================================================
  -- 0. 사전 안전 확인: 테스트 대상 모든 테이블의 합성 식별자 충돌 여부 검사
  -- ==========================================================================
  SELECT count(*) INTO v_cnt
  FROM auth.users
  WHERE id IN (u1, u2)
     OR email IN ('test_b3_u1@example.invalid', 'test_b3_u2@example.invalid');
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'PRECHECK_ABORT: synthetic test identifier already exists in auth.users (count=%)', v_cnt;
  END IF;

  SELECT count(*) INTO v_cnt FROM public.profiles WHERE id IN (u1, u2);
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'PRECHECK_ABORT: synthetic test identifier already exists in public.profiles (count=%)', v_cnt;
  END IF;

  SELECT count(*) INTO v_cnt FROM public.user_roles WHERE user_id IN (u1, u2);
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'PRECHECK_ABORT: synthetic test identifier already exists in public.user_roles (count=%)', v_cnt;
  END IF;

  SELECT count(*) INTO v_cnt
  FROM public.visitor_sessions
  WHERE id IN (s1, s2)
     OR user_id IN (u1, u2)
     OR browser_id IN (b1, b2);
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'PRECHECK_ABORT: synthetic test identifier already exists in public.visitor_sessions (count=%)', v_cnt;
  END IF;

  SELECT count(*) INTO v_cnt
  FROM public.consent_records
  WHERE id IN (c1, c2)
     OR user_id IN (u1, u2)
     OR browser_id IN (b1, b2);
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'PRECHECK_ABORT: synthetic test identifier already exists in public.consent_records (count=%)', v_cnt;
  END IF;

  SELECT count(*) INTO v_cnt FROM public.feature_flags WHERE key = f1;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'PRECHECK_ABORT: synthetic test identifier already exists in public.feature_flags (count=%)', v_cnt;
  END IF;

  -- 서브트랜잭션 시작 (정상 종료 시에도 P0099 예외를 발생시켜 100% 롤백 보장)
  BEGIN
    -- ========================================================================
    -- A. 회원 생성 트리거 (on_auth_user_created -> handle_new_user) 및 기본 역할
    -- ========================================================================
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
        u1,
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
        u2,
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

    -- [Group 1 / A-1] profiles 자동 생성 및 기본값 확인
    SELECT count(*) INTO v_cnt
    FROM public.profiles
    WHERE id IN (u1, u2)
      AND account_status = 'active';
    IF v_cnt <> 2 THEN
      RAISE EXCEPTION 'FAIL [A-1]: expected 2 active profiles, got %', v_cnt;
    END IF;

    SELECT display_name, preferred_language INTO v_name, v_lang
    FROM public.profiles
    WHERE id = u1;
    IF v_name IS DISTINCT FROM 'DEMO_TEST_U1' OR v_lang IS DISTINCT FROM 'ko' THEN
      RAISE EXCEPTION 'FAIL [A-1]: unexpected u1 profile metadata (%, %)', v_name, v_lang;
    END IF;
    v_pass_count := v_pass_count + 1;

    -- [Group 2 / A-2] user_roles에 customer 권한 자동 부여 확인
    SELECT count(*) INTO v_cnt
    FROM public.user_roles
    WHERE user_id IN (u1, u2)
      AND role = 'customer'
      AND granted_by IS NULL;
    IF v_cnt <> 2 THEN
      RAISE EXCEPTION 'FAIL [A-2]: expected 2 customer roles, got %', v_cnt;
    END IF;
    v_pass_count := v_pass_count + 1;

    -- [Group 3 / A-3] 신규 사용자가 admin/merchant 권한을 자동으로 받지 않는지 확인
    SELECT count(*) INTO v_cnt
    FROM public.user_roles
    WHERE user_id IN (u1, u2)
      AND role IN ('admin', 'merchant');
    IF v_cnt <> 0 THEN
      RAISE EXCEPTION 'FAIL [A-3]: unexpected privileged role count %', v_cnt;
    END IF;
    v_pass_count := v_pass_count + 1;

    -- [Group 4 / C-1a] 실제 관리자 권한 부여 동작 확인 (u2에게 admin 부여 후 본인/서버 확인)
    INSERT INTO public.user_roles (user_id, role, granted_by)
    VALUES (u2, 'admin', NULL);

    -- 서버 컨텍스트에서 u2는 실제 admin(true), u1은 비관리자(false)여야 함
    SELECT public.is_admin(u2) INTO v_bool;
    IF v_bool IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'FAIL [C-1a]: expected is_admin(u2)=true in server context after granting admin, got %', v_bool;
    END IF;

    SELECT public.is_admin(u1) INTO v_bool;
    IF v_bool IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'FAIL [C-1a]: expected is_admin(u1)=false in server context, got %', v_bool;
    END IF;

    -- u2 본인의 authenticated 컨텍스트에서도 자신의 관리자 여부 조회(is_admin(u2))는 true여야 함
    SET LOCAL ROLE authenticated;
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object('sub', u2::text, 'role', 'authenticated')::text,
      true
    );
    SELECT public.is_admin(u2) INTO v_bool;
    IF v_bool IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'FAIL [C-1a]: expected is_admin(u2)=true when called by u2 self, got %', v_bool;
    END IF;
    RESET ROLE;
    v_pass_count := v_pass_count + 1;

    -- ========================================================================
    -- B. 일반 로그인 사용자(u1, customer) 역할 전환 및 RLS 접근 제어 검증
    -- ========================================================================
    SET LOCAL ROLE authenticated;
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object('sub', u1::text, 'role', 'authenticated')::text,
      true
    );

    IF auth.uid() IS DISTINCT FROM u1 OR auth.role() IS DISTINCT FROM 'authenticated' THEN
      RAISE EXCEPTION 'FAIL [JWT_CONTEXT]: auth.uid()=% auth.role()=%', auth.uid(), auth.role();
    END IF;

    -- [Group 5 / B-1] 허용 동작: 일반 사용자는 자신의 프로필만 조회하고 수정할 수 있음
    SELECT count(*) INTO v_cnt FROM public.profiles;
    IF v_cnt <> 1 THEN
      RAISE EXCEPTION 'FAIL [B-1a]: authenticated user u1 should only see 1 profile, saw %', v_cnt;
    END IF;

    UPDATE public.profiles
    SET display_name = 'DEMO_TEST_U1_UPDATED',
        preferred_language = 'en'
    WHERE id = u1;

    SELECT display_name, preferred_language INTO v_name, v_lang
    FROM public.profiles
    WHERE id = u1;
    IF v_name IS DISTINCT FROM 'DEMO_TEST_U1_UPDATED' OR v_lang IS DISTINCT FROM 'en' THEN
      RAISE EXCEPTION 'FAIL [B-1b]: own profile update did not persist (%, %)', v_name, v_lang;
    END IF;
    v_pass_count := v_pass_count + 1;

    -- [Group 6 / B-2] 차단 동작: 다른 사용자(u2)의 프로필을 조회하거나 수정할 수 없음 (0행 처리 또는 42501만 허용)
    v_blocked := false;
    BEGIN
      UPDATE public.profiles
      SET display_name = 'HACKED_U2'
      WHERE id = u2;
      GET DIAGNOSTICS v_cnt = ROW_COUNT;
      IF v_cnt = 0 THEN
        v_blocked := true;
      END IF;
    EXCEPTION
      WHEN insufficient_privilege THEN
        v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'FAIL [B-2a]: updating other user profile affected % rows', v_cnt;
    END IF;

    SELECT count(*) INTO v_cnt FROM public.profiles WHERE id = u2;
    IF v_cnt <> 0 THEN
      RAISE EXCEPTION 'FAIL [B-2b]: other user profile visible to u1 (% rows)', v_cnt;
    END IF;
    v_pass_count := v_pass_count + 1;

    -- [Group 7 / B-3] 차단 동작: 다른 사용자(u2)의 권한 조회/변경 및 본인 권한 임의 삭제 불가 (0행 처리 또는 42501만 허용)
    SELECT count(*) INTO v_cnt FROM public.user_roles WHERE user_id = u2;
    IF v_cnt <> 0 THEN
      RAISE EXCEPTION 'FAIL [B-3a]: other user roles visible to u1 (% rows)', v_cnt;
    END IF;

    v_blocked := false;
    BEGIN
      UPDATE public.user_roles SET role = 'customer' WHERE user_id = u2;
      GET DIAGNOSTICS v_cnt = ROW_COUNT;
      IF v_cnt = 0 THEN
        v_blocked := true;
      END IF;
    EXCEPTION
      WHEN insufficient_privilege THEN
        v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'FAIL [B-3b]: updating other user role affected % rows', v_cnt;
    END IF;

    v_blocked := false;
    BEGIN
      DELETE FROM public.user_roles WHERE user_id IN (u1, u2);
      GET DIAGNOSTICS v_cnt = ROW_COUNT;
      IF v_cnt = 0 THEN
        v_blocked := true;
      END IF;
    EXCEPTION
      WHEN insufficient_privilege THEN
        v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'FAIL [B-3c]: deleting user_roles affected % rows', v_cnt;
    END IF;
    v_pass_count := v_pass_count + 1;

    -- [Group 8 / B-4] 차단 동작: 일반 사용자가 admin 또는 merchant 권한을 직접 INSERT 불가 (42501만 허용)
    v_blocked := false;
    BEGIN
      INSERT INTO public.user_roles (user_id, role) VALUES (u1, 'admin');
    EXCEPTION
      WHEN insufficient_privilege THEN
        v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'FAIL [B-4a]: self-insert of admin role was not blocked by RLS';
    END IF;

    v_blocked := false;
    BEGIN
      INSERT INTO public.user_roles (user_id, role) VALUES (u1, 'merchant');
    EXCEPTION
      WHEN insufficient_privilege THEN
        v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'FAIL [B-4b]: self-insert of merchant role was not blocked by RLS';
    END IF;
    v_pass_count := v_pass_count + 1;

    -- [Group 9 / B-5a] 차단 동작: 일반 사용자가 profiles.account_status를 임의 변경 불가
    -- (보호 트리거의 명시적 Forbidden 예외, 42501 권한 거부, 또는 0행 처리만 정상 차단으로 인정)
    v_blocked := false;
    BEGIN
      UPDATE public.profiles SET account_status = 'suspended' WHERE id = u1;
      GET DIAGNOSTICS v_cnt = ROW_COUNT;
      IF v_cnt = 0 THEN
        v_blocked := true;
      END IF;
    EXCEPTION
      WHEN insufficient_privilege THEN
        v_blocked := true;
      WHEN raise_exception THEN
        IF SQLERRM LIKE '%Forbidden: account_status and created_at can only be modified by server or admin%' THEN
          v_blocked := true;
        ELSE
          RAISE;
        END IF;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'FAIL [B-5a]: modifying profiles.account_status was not blocked';
    END IF;
    v_pass_count := v_pass_count + 1;

    -- [Group 10 / B-5b] 차단 동작: 일반 사용자가 profiles.created_at을 임의 변경 불가
    v_blocked := false;
    BEGIN
      UPDATE public.profiles SET created_at = now() - interval '10 days' WHERE id = u1;
      GET DIAGNOSTICS v_cnt = ROW_COUNT;
      IF v_cnt = 0 THEN
        v_blocked := true;
      END IF;
    EXCEPTION
      WHEN insufficient_privilege THEN
        v_blocked := true;
      WHEN raise_exception THEN
        IF SQLERRM LIKE '%Forbidden: account_status and created_at can only be modified by server or admin%' THEN
          v_blocked := true;
        ELSE
          RAISE;
        END IF;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'FAIL [B-5b]: modifying profiles.created_at was not blocked';
    END IF;
    v_pass_count := v_pass_count + 1;

    -- ========================================================================
    -- C. 함수 및 기타 테이블 보안 검증
    -- ========================================================================
    -- [Group 11 / C-1b] 차단 동작: 실제 admin인 u2에 대해 일반 사용자 u1이 is_admin(u2) 호출 시 false 반환 (열거 방지 검증)
    SELECT public.is_admin(u2) INTO v_bool;
    IF v_bool IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'FAIL [C-1b]: is_admin(u2) returned % to non-owner u1 (admin enumeration leak)', v_bool;
    END IF;

    SELECT public.is_admin(u1) INTO v_bool;
    IF v_bool IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'FAIL [C-1b]: is_admin(u1) returned % for non-admin u1', v_bool;
    END IF;
    v_pass_count := v_pass_count + 1;

    -- [Group 12 / C-2] 차단 동작: handle_new_user() 직접 실행 권한 차단 확인
    IF has_function_privilege('authenticated', 'public.handle_new_user()', 'EXECUTE')
       OR has_function_privilege('anon', 'public.handle_new_user()', 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL [C-2]: handle_new_user() EXECUTE privilege is still granted to client roles';
    END IF;
    v_pass_count := v_pass_count + 1;

    -- [Group 13 / C-3a] 허용 및 차단: visitor_sessions 본인 세션 생성/조회 허용 및 타인 user_id 위조 차단
    INSERT INTO public.visitor_sessions (id, browser_id, user_id, landing_path, device_type, is_test)
    VALUES (s1, b1, u1, '/map', 'mobile', true);

    SELECT count(*) INTO v_cnt FROM public.visitor_sessions WHERE id = s1 AND user_id = u1;
    IF v_cnt <> 1 THEN
      RAISE EXCEPTION 'FAIL [C-3a]: own visitor_session insert/select failed (count=%)', v_cnt;
    END IF;

    v_blocked := false;
    BEGIN
      INSERT INTO public.visitor_sessions (id, browser_id, user_id, landing_path, device_type, is_test)
      VALUES (s2, b2, u2, '/map', 'mobile', true);
    EXCEPTION
      WHEN insufficient_privilege THEN
        v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'FAIL [C-3b]: spoofed visitor_sessions user_id insert was not blocked';
    END IF;
    v_pass_count := v_pass_count + 1;

    -- [Group 14 / C-3b] 허용 및 차단: consent_records 본인 동의 생성/조회 허용, 타인 위조 차단, 수정/삭제(append-only) 차단
    INSERT INTO public.consent_records (id, user_id, browser_id, consent_type, policy_version, accepted)
    VALUES (c1, u1, b1, 'terms', 'v1.0', true);

    SELECT count(*) INTO v_cnt FROM public.consent_records WHERE id = c1 AND user_id = u1;
    IF v_cnt <> 1 THEN
      RAISE EXCEPTION 'FAIL [C-3c]: own consent_record insert/select failed (count=%)', v_cnt;
    END IF;

    v_blocked := false;
    BEGIN
      INSERT INTO public.consent_records (id, user_id, browser_id, consent_type, policy_version, accepted)
      VALUES (c2, u2, b2, 'terms', 'v1.0', true);
    EXCEPTION
      WHEN insufficient_privilege THEN
        v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'FAIL [C-3d]: spoofed consent_records user_id insert was not blocked';
    END IF;

    v_blocked := false;
    BEGIN
      UPDATE public.consent_records SET accepted = false WHERE id = c1;
      GET DIAGNOSTICS v_cnt = ROW_COUNT;
      IF v_cnt = 0 THEN
        v_blocked := true;
      END IF;
    EXCEPTION
      WHEN insufficient_privilege THEN
        v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'FAIL [C-3e]: consent_records should be append-only (updated % rows)', v_cnt;
    END IF;

    v_blocked := false;
    BEGIN
      DELETE FROM public.consent_records WHERE id = c1;
      GET DIAGNOSTICS v_cnt = ROW_COUNT;
      IF v_cnt = 0 THEN
        v_blocked := true;
      END IF;
    EXCEPTION
      WHEN insufficient_privilege THEN
        v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'FAIL [C-3f]: consent_records should be append-only (deleted % rows)', v_cnt;
    END IF;
    v_pass_count := v_pass_count + 1;

    -- [Group 15 / C-4] 허용 및 차단: feature_flags 공개 읽기 허용 및 일반 사용자 쓰기(INSERT/UPDATE/DELETE) 차단
    SELECT count(*) INTO v_cnt FROM public.feature_flags;
    IF v_cnt < 3 THEN
      RAISE EXCEPTION 'FAIL [C-4a]: expected >= 3 feature_flags visible to authenticated user, got %', v_cnt;
    END IF;

    v_blocked := false;
    BEGIN
      INSERT INTO public.feature_flags (key, enabled, config)
      VALUES (f1, true, '{}'::jsonb);
    EXCEPTION
      WHEN insufficient_privilege THEN
        v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'FAIL [C-4b]: non-admin INSERT into feature_flags was not blocked';
    END IF;

    v_blocked := false;
    BEGIN
      UPDATE public.feature_flags SET enabled = true WHERE key = 'payment_test_mode';
      GET DIAGNOSTICS v_cnt = ROW_COUNT;
      IF v_cnt = 0 THEN
        v_blocked := true;
      END IF;
    EXCEPTION
      WHEN insufficient_privilege THEN
        v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'FAIL [C-4c]: non-admin UPDATE on feature_flags affected % rows', v_cnt;
    END IF;

    v_blocked := false;
    BEGIN
      DELETE FROM public.feature_flags WHERE key = 'payment_test_mode';
      GET DIAGNOSTICS v_cnt = ROW_COUNT;
      IF v_cnt = 0 THEN
        v_blocked := true;
      END IF;
    EXCEPTION
      WHEN insufficient_privilege THEN
        v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'FAIL [C-4d]: non-admin DELETE on feature_flags affected % rows', v_cnt;
    END IF;
    v_pass_count := v_pass_count + 1;

    -- 역할 초기화 후 서브트랜잭션 강제 롤백 예외 발생
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);

    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'ROLLBACK_GUARD_ALL_CHECKS_PASSED';
  EXCEPTION
    WHEN SQLSTATE 'P0099' THEN
      -- 서브트랜잭션 롤백 완료 직후: 통과 그룹 수(15) 및 모든 테스트 데이터 잔류 0건 사후 검증
      RESET ROLE;
      PERFORM set_config('request.jwt.claims', '', true);

      IF v_pass_count <> v_expected_pass_count THEN
        RAISE EXCEPTION 'POSTCHECK_FAIL: expected % passed verification groups, got %', v_expected_pass_count, v_pass_count;
      END IF;

      SELECT count(*) INTO v_cnt
      FROM auth.users
      WHERE id IN (u1, u2)
         OR email IN ('test_b3_u1@example.invalid', 'test_b3_u2@example.invalid');
      IF v_cnt <> 0 THEN
        RAISE EXCEPTION 'POSTCHECK_FAIL: % test rows remain in auth.users after rollback', v_cnt;
      END IF;

      SELECT count(*) INTO v_cnt FROM public.profiles WHERE id IN (u1, u2);
      IF v_cnt <> 0 THEN
        RAISE EXCEPTION 'POSTCHECK_FAIL: % test rows remain in public.profiles after rollback', v_cnt;
      END IF;

      SELECT count(*) INTO v_cnt FROM public.user_roles WHERE user_id IN (u1, u2);
      IF v_cnt <> 0 THEN
        RAISE EXCEPTION 'POSTCHECK_FAIL: % test rows remain in public.user_roles after rollback', v_cnt;
      END IF;

      SELECT count(*) INTO v_cnt
      FROM public.visitor_sessions
      WHERE id IN (s1, s2)
         OR user_id IN (u1, u2)
         OR browser_id IN (b1, b2);
      IF v_cnt <> 0 THEN
        RAISE EXCEPTION 'POSTCHECK_FAIL: % test rows remain in public.visitor_sessions after rollback', v_cnt;
      END IF;

      SELECT count(*) INTO v_cnt
      FROM public.consent_records
      WHERE id IN (c1, c2)
         OR user_id IN (u1, u2)
         OR browser_id IN (b1, b2);
      IF v_cnt <> 0 THEN
        RAISE EXCEPTION 'POSTCHECK_FAIL: % test rows remain in public.consent_records after rollback', v_cnt;
      END IF;

      SELECT count(*) INTO v_cnt FROM public.feature_flags WHERE key = f1;
      IF v_cnt <> 0 THEN
        RAISE EXCEPTION 'POSTCHECK_FAIL: % test rows remain in public.feature_flags after rollback', v_cnt;
      END IF;
  END;
END;
$verify$;
