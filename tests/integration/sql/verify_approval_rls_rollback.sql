-- ==============================================================================
-- verify_approval_rls_rollback.sql
-- TASK 08-A / 08-B: Remote PostgreSQL Schema, RLS, Trigger, RPC & Transaction Verification
--
-- 대상 마이그레이션: supabase/migrations/20261109000000_audit_and_approval.sql
-- 실행 방법: psql -v ON_ERROR_STOP=1 -f tests/integration/sql/verify_approval_rls_rollback.sql
--
-- [SAFETY GUARANTEE]
-- 1. G00 사전 점검: 테스트 UUID/이메일이 기존 관련 테이블에 이미 존재하면 즉시 중단 (잔류 방지).
-- 2. 모든 DML은 서브트랜잭션(BEGIN ... EXCEPTION) 안에서 수행되고, 모든 그룹 통과 후 P0099로 100% 롤백.
-- 3. 롤백 후 G13에서 8개 테이블(business_hours 포함) 잔류 레코드 0건을 확인.
-- 4. 테스트 데이터는 DEMO/TEST 식별자와 *.invalid 도메인만 사용.
-- ==============================================================================

DO $verify$
DECLARE
  -- Static mock test identifiers (DEMO/TEST only)
  u_applicant uuid := 'a4444444-4444-4444-8444-444444444444'::uuid;
  u_other     uuid := 'a5555555-5555-4555-8555-555555555555'::uuid;
  u_admin     uuid := 'a6666666-6666-4666-8666-666666666666'::uuid;
  u_temp      uuid := 'a7777777-7777-4777-8777-777777777777'::uuid;
  e_applicant text := 'demo_test_applicant_08@verify.invalid';
  e_other     text := 'demo_test_other_08@verify.invalid';
  e_admin     text := 'demo_test_admin_08@verify.invalid';
  e_temp      text := 'demo_test_temp_08@verify.invalid';

  -- Verification bookkeeping
  v_orig_user text := current_user;
  v_expected text[] := ARRAY[
    'G00_PREFLIGHT',
    'G01_SCHEMA_AUDIT_LOGS',
    'G02_AUDIT_LOGS_IMMUTABLE_TRIGGER',
    'G03_AUDIT_LOGS_GRANTS_RLS',
    'G04_RPC_DECIDE_APPROVAL_SIGNATURE',
    'G05_TEST_USERS_SETUP',
    'G06_CREATE_AND_SUBMIT_TEST_BUSINESS',
    'G07_UNAUTHENTICATED_AND_NON_ADMIN_BLOCKED',
    'G08_INVALID_DECISION_AND_REASON_VALIDATION',
    'G09_ADMIN_APPROVE_ATOMIC_EXECUTION',
    'G10_PREVENT_DUPLICATE_APPROVAL',
    'G11_AUDIT_LOGS_IMMUTABILITY_ENFORCEMENT',
    'G12_REJECTION_FLOW_AND_ROLE_PRESERVATION',
    'G13_ROLLBACK_AND_RESIDUE_CHECK'
  ];
  v_done text[] := ARRAY[]::text[];
  v_all_done boolean := false;

  -- Test state variables
  v_biz1_id uuid;
  v_biz2_id uuid;
  v_biz_unverif_id uuid;
  v_created_biz_ids uuid[] := ARRAY[]::uuid[];
  v_created_audit_ids uuid[] := ARRAY[]::uuid[];
  v_count integer;
  v_status text;
  v_approved_by uuid;
  v_approved_at timestamptz;
  v_rejection_reason text;
  v_verif_status text;
  v_verif_reviewed_by uuid;
  v_verif_reviewed_at timestamptz;
  v_has_merchant boolean;
  v_audit_count integer;
  v_audit_action text;
  v_caught_code text;
  v_caught_msg text;
  v_temp_audit_id uuid;

BEGIN
  RAISE NOTICE '>>> [START] TASK 08-A / 08-B Verification SQL running as %', v_orig_user;

  -- ============================================================================
  -- G00: Preflight Collision Check
  -- ============================================================================
  -- 1) auth.users check by UUID and email
  SELECT count(*) INTO v_count
  FROM auth.users
  WHERE id IN (u_applicant, u_other, u_admin, u_temp)
     OR email IN (e_applicant, e_other, e_admin, e_temp);
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G00 FAIL: Test auth.users UUID or email already exists' USING errcode = 'P0001';
  END IF;

  -- 2) public.profiles check
  SELECT count(*) INTO v_count
  FROM public.profiles
  WHERE id IN (u_applicant, u_other, u_admin, u_temp);
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G00 FAIL: Test profile UUID already exists' USING errcode = 'P0001';
  END IF;

  -- 3) public.user_roles check
  SELECT count(*) INTO v_count
  FROM public.user_roles
  WHERE user_id IN (u_applicant, u_other, u_admin, u_temp);
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G00 FAIL: Test user_roles already exists' USING errcode = 'P0001';
  END IF;

  -- 4) public.businesses check
  SELECT count(*) INTO v_count
  FROM public.businesses
  WHERE created_by IN (u_applicant, u_other, u_admin, u_temp);
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G00 FAIL: Test businesses already exists' USING errcode = 'P0001';
  END IF;

  -- 5) public.business_members check
  SELECT count(*) INTO v_count
  FROM public.business_members
  WHERE user_id IN (u_applicant, u_other, u_admin, u_temp);
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G00 FAIL: Test business_members already exists' USING errcode = 'P0001';
  END IF;

  -- 6) public.business_verifications check
  SELECT count(*) INTO v_count
  FROM public.business_verifications
  WHERE submitted_by IN (u_applicant, u_other, u_admin, u_temp)
     OR reviewed_by IN (u_applicant, u_other, u_admin, u_temp);
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G00 FAIL: Test business_verifications already exists' USING errcode = 'P0001';
  END IF;

  -- 7) public.audit_logs check
  SELECT count(*) INTO v_count
  FROM public.audit_logs
  WHERE actor_user_id IN (u_applicant, u_other, u_admin, u_temp);
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G00 FAIL: Test audit_logs already exists' USING errcode = 'P0001';
  END IF;

  v_done := array_append(v_done, 'G00_PREFLIGHT');
  RAISE NOTICE '  ✓ G00: Preflight collision check passed.';

  -- ============================================================================
  -- G01: Schema Check for audit_logs
  -- ============================================================================
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'audit_logs'
  ) THEN
    RAISE EXCEPTION 'G01 FAIL: public.audit_logs table does not exist' USING errcode = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'audit_logs' AND column_name = 'action'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'audit_logs' AND column_name = 'entity_type'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'audit_logs' AND column_name = 'entity_id'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'audit_logs' AND column_name = 'actor_user_id'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'audit_logs' AND column_name = 'before_data'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'audit_logs' AND column_name = 'after_data'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'audit_logs' AND column_name = 'reason'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'audit_logs' AND column_name = 'created_at'
  ) THEN
    RAISE EXCEPTION 'G01 FAIL: public.audit_logs missing required columns' USING errcode = 'P0001';
  END IF;

  -- Verify actor_user_id foreign key constraint is ON DELETE RESTRICT
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.referential_constraints rc
    JOIN information_schema.table_constraints tc ON tc.constraint_name = rc.constraint_name
    WHERE tc.table_schema = 'public'
      AND tc.table_name = 'audit_logs'
      AND rc.delete_rule = 'RESTRICT'
  ) THEN
    RAISE EXCEPTION 'G01 FAIL: audit_logs.actor_user_id FK constraint must be ON DELETE RESTRICT' USING errcode = 'P0001';
  END IF;

  v_done := array_append(v_done, 'G01_SCHEMA_AUDIT_LOGS');
  RAISE NOTICE '  ✓ G01: audit_logs schema and ON DELETE RESTRICT FK verified.';

  -- ============================================================================
  -- G02: Immutable Audit Logs Trigger Check
  -- ============================================================================
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.triggers
    WHERE event_object_schema = 'public'
      AND event_object_table = 'audit_logs'
      AND trigger_name = 'trg_prevent_audit_logs_mutation'
  ) THEN
    RAISE EXCEPTION 'G02 FAIL: trg_prevent_audit_logs_mutation trigger does not exist' USING errcode = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'prevent_audit_logs_mutation'
      AND pronamespace = 'public'::regnamespace
  ) THEN
    RAISE EXCEPTION 'G02 FAIL: public.prevent_audit_logs_mutation function does not exist' USING errcode = 'P0001';
  END IF;

  v_done := array_append(v_done, 'G02_AUDIT_LOGS_IMMUTABLE_TRIGGER');
  RAISE NOTICE '  ✓ G02: audit_logs immutable trigger verified.';

  -- ============================================================================
  -- G03: Grants and RLS on audit_logs
  -- ============================================================================
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'audit_logs' AND rowsecurity = true
  ) THEN
    RAISE EXCEPTION 'G03 FAIL: audit_logs does not have RLS enabled' USING errcode = 'P0001';
  END IF;

  -- Privilege checks
  IF has_table_privilege('anon', 'public.audit_logs', 'SELECT') THEN
    RAISE EXCEPTION 'G03 FAIL: anon must not have SELECT on audit_logs' USING errcode = 'P0001';
  END IF;
  IF has_table_privilege('anon', 'public.audit_logs', 'INSERT') THEN
    RAISE EXCEPTION 'G03 FAIL: anon must not have INSERT on audit_logs' USING errcode = 'P0001';
  END IF;
  IF has_table_privilege('authenticated', 'public.audit_logs', 'UPDATE') THEN
    RAISE EXCEPTION 'G03 FAIL: authenticated must not have UPDATE on audit_logs' USING errcode = 'P0001';
  END IF;
  IF has_table_privilege('authenticated', 'public.audit_logs', 'DELETE') THEN
    RAISE EXCEPTION 'G03 FAIL: authenticated must not have DELETE on audit_logs' USING errcode = 'P0001';
  END IF;

  -- Policy check
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'audit_logs'
      AND policyname = 'audit_logs_select_admin_only'
  ) THEN
    RAISE EXCEPTION 'G03 FAIL: audit_logs_select_admin_only policy missing' USING errcode = 'P0001';
  END IF;

  v_done := array_append(v_done, 'G03_AUDIT_LOGS_GRANTS_RLS');
  RAISE NOTICE '  ✓ G03: audit_logs grants and RLS verified.';

  -- ============================================================================
  -- G04: RPC Full Signature, Return Type, SECURITY DEFINER & Permissions
  -- ============================================================================
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.proname = 'decide_business_approval'
      AND p.pronamespace = 'public'::regnamespace
      AND p.prosecdef = true
      AND p.prorettype = (
        SELECT oid FROM pg_type WHERE typname = 'businesses' AND typnamespace = 'public'::regnamespace
      )
      AND p.proconfig @> ARRAY['search_path=public, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'G04 FAIL: decide_business_approval function missing or invalid signature/security' USING errcode = 'P0001';
  END IF;

  -- Permissions on RPC
  IF has_function_privilege('public', 'public.decide_business_approval(uuid, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G04 FAIL: public role must not have EXECUTE on decide_business_approval' USING errcode = 'P0001';
  END IF;
  IF has_function_privilege('anon', 'public.decide_business_approval(uuid, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G04 FAIL: anon must not have EXECUTE on decide_business_approval' USING errcode = 'P0001';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.decide_business_approval(uuid, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G04 FAIL: authenticated must have EXECUTE on decide_business_approval' USING errcode = 'P0001';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.decide_business_approval(uuid, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G04 FAIL: service_role must have EXECUTE on decide_business_approval' USING errcode = 'P0001';
  END IF;

  v_done := array_append(v_done, 'G04_RPC_DECIDE_APPROVAL_SIGNATURE');
  RAISE NOTICE '  ✓ G04: decide_business_approval RPC signature, return type and grants verified.';

  -- ============================================================================
  -- DML Subtransaction: Execute business approval flows and force rollback
  -- ============================================================================
  BEGIN
    -- G05: Test Users Setup via handle_new_user trigger integration
    INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
    VALUES
      (u_applicant, e_applicant, '{"name":"Applicant"}'::jsonb, now(), now()),
      (u_other, e_other, '{"name":"Other"}'::jsonb, now(), now()),
      (u_admin, e_admin, '{"name":"Admin"}'::jsonb, now(), now());

    -- Verify handle_new_user automatically created profiles
    SELECT count(*) INTO v_count
    FROM public.profiles
    WHERE id IN (u_applicant, u_other, u_admin)
      AND account_status = 'active';
    IF v_count <> 3 THEN
      RAISE EXCEPTION 'G05 FAIL: profiles not automatically created by handle_new_user (count=%)', v_count USING errcode = 'P0001';
    END IF;

    -- Verify handle_new_user automatically granted customer role
    SELECT count(*) INTO v_count
    FROM public.user_roles
    WHERE user_id IN (u_applicant, u_other, u_admin)
      AND role = 'customer';
    IF v_count <> 3 THEN
      RAISE EXCEPTION 'G05 FAIL: customer role not automatically assigned by handle_new_user (count=%)', v_count USING errcode = 'P0001';
    END IF;

    -- Grant admin role ONLY to u_admin (never auto-granted)
    INSERT INTO public.user_roles (user_id, role, granted_by)
    VALUES (u_admin, 'admin', u_admin);

    -- Verify roles: u_admin has 2 (customer, admin), others have 1 (customer)
    SELECT count(*) INTO v_count FROM public.user_roles WHERE user_id = u_admin;
    IF v_count <> 2 THEN
      RAISE EXCEPTION 'G05 FAIL: u_admin role count expected 2, got %', v_count USING errcode = 'P0001';
    END IF;

    v_done := array_append(v_done, 'G05_TEST_USERS_SETUP');
    RAISE NOTICE '  ✓ G05: Test users and handle_new_user trigger integration verified.';

    -- G06: Create and Submit Store 1 as Applicant (With Business Registration Number)
    PERFORM set_config('role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', u_applicant::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u_applicant::text, 'role', 'authenticated')::text, true);

    SELECT id INTO v_biz1_id
    FROM public.create_business_with_owner(
      '검증 테스트 가게 1호점',
      '카페',
      '설명',
      '경기도 수원시 팔달구 매산로 1',
      NULL,
      '1층',
      37.2636,
      127.0286,
      '031-111-2222',
      NULL,
      '123-45-67890' -- Valid business registration number -> creates pending verification row
    );

    IF v_biz1_id IS NULL THEN
      RAISE EXCEPTION 'G06 FAIL: create_business_with_owner returned null' USING errcode = 'P0001';
    END IF;

    v_created_biz_ids := array_append(v_created_biz_ids, v_biz1_id);

    -- Add a business_hours record to verify direct rollback check on business_hours
    INSERT INTO public.business_hours (business_id, weekday, opens_at, closes_at, is_closed)
    VALUES (v_biz1_id, 1, '09:00:00'::time, '22:00:00'::time, false);

    -- Submit for review
    PERFORM public.submit_business_for_review(v_biz1_id);

    -- Reset to verifier role to inspect state
    PERFORM set_config('role', v_orig_user, false);
    PERFORM set_config('request.jwt.claim.role', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', '', true);

    SELECT registration_status INTO v_status
    FROM public.businesses WHERE id = v_biz1_id;
    IF v_status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'G06 FAIL: business status not pending (got %)', v_status USING errcode = 'P0001';
    END IF;

    -- Verify verification record exists and is pending
    SELECT status INTO v_verif_status
    FROM public.business_verifications
    WHERE business_id = v_biz1_id;
    IF v_verif_status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'G06 FAIL: business verification status expected pending, got %', v_verif_status USING errcode = 'P0001';
    END IF;

    v_done := array_append(v_done, 'G06_CREATE_AND_SUBMIT_TEST_BUSINESS');
    RAISE NOTICE '  ✓ G06: Business 1 created with verification and business_hours (status=pending).';

    -- G07: Unauthenticated & Non-Admin Blocked from Calling decide_business_approval
    -- 1) Anon
    PERFORM set_config('role', 'anon', true);
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    BEGIN
      PERFORM public.decide_business_approval(v_biz1_id, 'approved');
      RAISE EXCEPTION 'G07 FAIL: anon should not be able to execute decide_business_approval' USING errcode = 'P0001';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code NOT IN ('28000', '42501') THEN
        RAISE EXCEPTION 'G07 FAIL: unexpected error code for anon %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;

    -- 2) Customer (other user)
    PERFORM set_config('role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', u_other::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u_other::text, 'role', 'authenticated')::text, true);
    BEGIN
      PERFORM public.decide_business_approval(v_biz1_id, 'approved');
      RAISE EXCEPTION 'G07 FAIL: customer should not be able to execute decide_business_approval' USING errcode = 'P0001';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G07 FAIL: expected 42501 for customer, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;

    -- 3) Customer (business owner self-approval)
    PERFORM set_config('request.jwt.claim.sub', u_applicant::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u_applicant::text, 'role', 'authenticated')::text, true);
    BEGIN
      PERFORM public.decide_business_approval(v_biz1_id, 'approved');
      RAISE EXCEPTION 'G07 FAIL: merchant owner must not be able to self-approve' USING errcode = 'P0001';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G07 FAIL: expected 42501 for self-approval, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;

    v_done := array_append(v_done, 'G07_UNAUTHENTICATED_AND_NON_ADMIN_BLOCKED');
    RAISE NOTICE '  ✓ G07: Unauthenticated and non-admin execution blocked.';

    -- G08: Decision & Input Validation (NULL, Empty, Invalid, Missing Reason, Missing Verification)
    PERFORM set_config('role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', u_admin::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u_admin::text, 'role', 'authenticated')::text, true);

    -- 1) NULL decision
    BEGIN
      PERFORM public.decide_business_approval(v_biz1_id, NULL);
      RAISE EXCEPTION 'G08 FAIL: NULL decision must be rejected' USING errcode = 'P0001';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> 'HM005' THEN
        RAISE EXCEPTION 'G08 FAIL: expected HM005 on NULL decision, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;

    -- 2) Empty string decision
    BEGIN
      PERFORM public.decide_business_approval(v_biz1_id, '   ');
      RAISE EXCEPTION 'G08 FAIL: empty decision must be rejected' USING errcode = 'P0001';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> 'HM005' THEN
        RAISE EXCEPTION 'G08 FAIL: expected HM005 on empty decision, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;

    -- 3) Invalid decision value
    BEGIN
      PERFORM public.decide_business_approval(v_biz1_id, 'maybe');
      RAISE EXCEPTION 'G08 FAIL: invalid decision value must be rejected' USING errcode = 'P0001';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> 'HM005' THEN
        RAISE EXCEPTION 'G08 FAIL: expected HM005 on invalid decision, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;

    -- 4) Rejection without reason (NULL)
    BEGIN
      PERFORM public.decide_business_approval(v_biz1_id, 'rejected', NULL);
      RAISE EXCEPTION 'G08 FAIL: rejection without reason must be rejected' USING errcode = 'P0001';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> 'HM005' THEN
        RAISE EXCEPTION 'G08 FAIL: expected HM005 on missing rejection reason, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;

    -- 5) Rejection with empty/whitespace reason
    BEGIN
      PERFORM public.decide_business_approval(v_biz1_id, 'rejected', '    ');
      RAISE EXCEPTION 'G08 FAIL: rejection with whitespace reason must be rejected' USING errcode = 'P0001';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> 'HM005' THEN
        RAISE EXCEPTION 'G08 FAIL: expected HM005 on whitespace rejection reason, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;

    -- 6) Approval of store with NO verification record must be BLOCKED
    PERFORM set_config('request.jwt.claim.sub', u_applicant::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u_applicant::text, 'role', 'authenticated')::text, true);
    SELECT id INTO v_biz_unverif_id
    FROM public.create_business_with_owner(
      '검증서류 미제출 가게',
      '식당',
      '설명',
      '경기도 수원시 팔달구 매산로 2',
      NULL,
      '2층',
      37.2637,
      127.0287,
      '031-111-3333',
      NULL,
      NULL -- No registration number
    );
    PERFORM public.submit_business_for_review(v_biz_unverif_id);
    v_created_biz_ids := array_append(v_created_biz_ids, v_biz_unverif_id);

    -- Admin attempts approval on unverified store
    PERFORM set_config('request.jwt.claim.sub', u_admin::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u_admin::text, 'role', 'authenticated')::text, true);
    BEGIN
      PERFORM public.decide_business_approval(v_biz_unverif_id, 'approved', NULL, '임의 승인 시도');
      RAISE EXCEPTION 'G08 FAIL: store without verification must not be approved' USING errcode = 'P0001';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE, v_caught_msg = MESSAGE_TEXT;
      IF v_caught_code <> 'HM005' OR v_caught_msg <> 'VERIFICATION_REQUIRED_FOR_APPROVAL' THEN
        RAISE EXCEPTION 'G08 FAIL: expected HM005 VERIFICATION_REQUIRED_FOR_APPROVAL, got % (%)', v_caught_code, v_caught_msg USING errcode = 'P0001';
      END IF;
    END;

    v_done := array_append(v_done, 'G08_INVALID_DECISION_AND_REASON_VALIDATION');
    RAISE NOTICE '  ✓ G08: Decision, rejection reason and verification requirement validated.';

    -- G09: Admin Approve Atomic Execution
    PERFORM public.decide_business_approval(v_biz1_id, 'approved', NULL, '서류 및 국세청 확인 완료');

    -- Reset to verifier role to inspect state with full privileges
    PERFORM set_config('role', v_orig_user, false);
    PERFORM set_config('request.jwt.claim.role', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', '', true);

    -- Assert business status and approved metadata (NULL-safe)
    SELECT registration_status, approved_by, approved_at, rejection_reason
    INTO v_status, v_approved_by, v_approved_at, v_rejection_reason
    FROM public.businesses
    WHERE id = v_biz1_id;

    IF v_status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'G09 FAIL: business status expected approved, got %', v_status USING errcode = 'P0001';
    END IF;
    IF v_approved_by IS DISTINCT FROM u_admin THEN
      RAISE EXCEPTION 'G09 FAIL: approved_by mismatch' USING errcode = 'P0001';
    END IF;
    IF v_approved_at IS NULL THEN
      RAISE EXCEPTION 'G09 FAIL: approved_at must not be null' USING errcode = 'P0001';
    END IF;
    IF v_rejection_reason IS NOT NULL THEN
      RAISE EXCEPTION 'G09 FAIL: rejection_reason must be null on approval' USING errcode = 'P0001';
    END IF;

    -- Assert verification record synchronized (NULL-safe)
    SELECT status, reviewed_by, reviewed_at
    INTO v_verif_status, v_verif_reviewed_by, v_verif_reviewed_at
    FROM public.business_verifications
    WHERE business_id = v_biz1_id;

    IF v_verif_status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'G09 FAIL: verification status expected approved, got %', v_verif_status USING errcode = 'P0001';
    END IF;
    IF v_verif_reviewed_by IS DISTINCT FROM u_admin THEN
      RAISE EXCEPTION 'G09 FAIL: verification reviewed_by mismatch' USING errcode = 'P0001';
    END IF;
    IF v_verif_reviewed_at IS NULL THEN
      RAISE EXCEPTION 'G09 FAIL: verification reviewed_at must not be null' USING errcode = 'P0001';
    END IF;

    -- Assert merchant role granted in user_roles
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = u_applicant AND role = 'merchant'
    ) INTO v_has_merchant;
    IF NOT v_has_merchant THEN
      RAISE EXCEPTION 'G09 FAIL: owner was not granted merchant role' USING errcode = 'P0001';
    END IF;

    -- Assert audit log entry recorded and track its ID for G13
    SELECT count(*), max(action)
    INTO v_audit_count, v_audit_action
    FROM public.audit_logs
    WHERE entity_type = 'businesses'
      AND entity_id = v_biz1_id
      AND actor_user_id = u_admin;

    SELECT id INTO v_temp_audit_id
    FROM public.audit_logs
    WHERE entity_type = 'businesses'
      AND entity_id = v_biz1_id
      AND actor_user_id = u_admin
    LIMIT 1;

    IF v_audit_count <> 1 OR v_audit_action IS DISTINCT FROM 'business.approve' THEN
      RAISE EXCEPTION 'G09 FAIL: audit_log not recorded correctly (count=%, action=%)', v_audit_count, v_audit_action USING errcode = 'P0001';
    END IF;

    v_created_audit_ids := array_append(v_created_audit_ids, v_temp_audit_id);

    v_done := array_append(v_done, 'G09_ADMIN_APPROVE_ATOMIC_EXECUTION');
    RAISE NOTICE '  ✓ G09: Admin approve atomic execution verified.';

    -- G10: Prevent Duplicate Approval
    PERFORM set_config('role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', u_admin::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u_admin::text, 'role', 'authenticated')::text, true);

    BEGIN
      PERFORM public.decide_business_approval(v_biz1_id, 'approved');
      RAISE EXCEPTION 'G10 FAIL: duplicate approval should be blocked with HM002' USING errcode = 'P0001';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> 'HM002' THEN
        RAISE EXCEPTION 'G10 FAIL: expected HM002 on duplicate approval, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;

    -- Reset to verifier role
    PERFORM set_config('role', v_orig_user, false);
    PERFORM set_config('request.jwt.claim.role', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', '', true);

    v_done := array_append(v_done, 'G10_PREVENT_DUPLICATE_APPROVAL');
    RAISE NOTICE '  ✓ G10: Prevent duplicate approval verified.';

    -- G11: Privilege Check vs Audit Log Immutability Trigger & ON DELETE RESTRICT
    -- 1) Authenticated user blocked by Table Grant (42501)
    PERFORM set_config('role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', u_applicant::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u_applicant::text, 'role', 'authenticated')::text, true);

    BEGIN
      UPDATE public.audit_logs SET action = 'tampered' WHERE entity_id = v_biz1_id;
      RAISE EXCEPTION 'G11 FAIL: authenticated user must not UPDATE audit_logs' USING errcode = 'P0001';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G11 FAIL: expected 42501 for authenticated UPDATE, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;

    BEGIN
      DELETE FROM public.audit_logs WHERE entity_id = v_biz1_id;
      RAISE EXCEPTION 'G11 FAIL: authenticated user must not DELETE audit_logs' USING errcode = 'P0001';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G11 FAIL: expected 42501 for authenticated DELETE, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;

    -- 2) Privileged role (running as v_orig_user) blocked by TRIGGER trg_prevent_audit_logs_mutation
    PERFORM set_config('role', v_orig_user, false);
    PERFORM set_config('request.jwt.claim.role', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', '', true);

    -- 2a) Attempt direct UPDATE of action
    BEGIN
      UPDATE public.audit_logs SET action = 'tampered' WHERE entity_id = v_biz1_id;
      RAISE EXCEPTION 'G11 FAIL: trigger must block direct UPDATE even for superuser' USING errcode = 'P0001';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE, v_caught_msg = MESSAGE_TEXT;
      IF v_caught_code <> '42501' OR v_caught_msg NOT LIKE '%Immutable audit log: UPDATE and DELETE operations are prohibited%' THEN
        RAISE EXCEPTION 'G11 FAIL: expected trigger UPDATE exception, got % (%)', v_caught_code, v_caught_msg USING errcode = 'P0001';
      END IF;
    END;

    -- 2b) Attempt direct UPDATE of actor_user_id = NULL (must also be rejected by trigger!)
    BEGIN
      UPDATE public.audit_logs SET actor_user_id = NULL WHERE entity_id = v_biz1_id;
      RAISE EXCEPTION 'G11 FAIL: trigger must block direct UPDATE of actor_user_id=NULL' USING errcode = 'P0001';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE, v_caught_msg = MESSAGE_TEXT;
      IF v_caught_code <> '42501' OR v_caught_msg NOT LIKE '%Immutable audit log: UPDATE and DELETE operations are prohibited%' THEN
        RAISE EXCEPTION 'G11 FAIL: expected trigger exception on actor_user_id=NULL, got % (%)', v_caught_code, v_caught_msg USING errcode = 'P0001';
      END IF;
    END;

    -- 2c) Attempt direct DELETE
    BEGIN
      DELETE FROM public.audit_logs WHERE entity_id = v_biz1_id;
      RAISE EXCEPTION 'G11 FAIL: trigger must block DELETE even for superuser' USING errcode = 'P0001';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE, v_caught_msg = MESSAGE_TEXT;
      IF v_caught_code <> '42501' OR v_caught_msg NOT LIKE '%Immutable audit log: UPDATE and DELETE operations are prohibited%' THEN
        RAISE EXCEPTION 'G11 FAIL: expected trigger DELETE exception, got % (%)', v_caught_code, v_caught_msg USING errcode = 'P0001';
      END IF;
    END;

    -- 3) ON DELETE RESTRICT behavior test
    -- Create temporary profile and audit log
    INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
    VALUES (u_temp, e_temp, '{"name":"Temp Admin"}'::jsonb, now(), now());

    INSERT INTO public.audit_logs (
      id, actor_user_id, action, entity_type, entity_id, before_data, after_data, reason
    ) VALUES (
      gen_random_uuid(), u_temp, 'temp.action', 'test', v_biz1_id, null, null, null
    ) RETURNING id INTO v_temp_audit_id;

    v_created_audit_ids := array_append(v_created_audit_ids, v_temp_audit_id);

    -- Attempt to delete user profile from profiles: must be BLOCKED by ON DELETE RESTRICT (23001 / 23503)
    BEGIN
      DELETE FROM public.profiles WHERE id = u_temp;
      RAISE EXCEPTION 'G11 FAIL: profile with audit logs must not be deleted (ON DELETE RESTRICT expected)' USING errcode = 'P0001';
    EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN
      -- 23001 restrict_violation / 23503 foreign_key_violation is expected
      NULL;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code NOT IN ('23001', '23503') THEN
        RAISE EXCEPTION 'G11 FAIL: expected 23001/23503 on profile delete, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;

    -- Verify audit log row and referenced user still exist
    SELECT count(*) INTO v_count FROM public.profiles WHERE id = u_temp;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'G11 FAIL: profile was deleted despite ON DELETE RESTRICT' USING errcode = 'P0001';
    END IF;

    SELECT count(*) INTO v_count FROM public.audit_logs WHERE id = v_temp_audit_id;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'G11 FAIL: audit log was unexpectedly lost' USING errcode = 'P0001';
    END IF;

    v_done := array_append(v_done, 'G11_AUDIT_LOGS_IMMUTABILITY_ENFORCEMENT');
    RAISE NOTICE '  ✓ G11: Audit logs immutability, direct actor_user_id=NULL blocked, and ON DELETE RESTRICT verified.';

    -- G12: Rejection Flow, Role Preservation & Duplicate Rejection
    -- Create store 2 with registration number as applicant
    PERFORM set_config('role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', u_applicant::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u_applicant::text, 'role', 'authenticated')::text, true);

    SELECT id INTO v_biz2_id
    FROM public.create_business_with_owner(
      '검증 테스트 가게 2호점',
      '식당',
      '설명',
      '경기도 수원시 팔달구 매산로 3',
      NULL,
      '3층',
      37.2638,
      127.0288,
      '031-111-4444',
      NULL,
      '987-65-43210' -- Valid registration number
    );
    PERFORM public.submit_business_for_review(v_biz2_id);

    v_created_biz_ids := array_append(v_created_biz_ids, v_biz2_id);

    -- Admin rejects store 2
    PERFORM set_config('request.jwt.claim.sub', u_admin::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u_admin::text, 'role', 'authenticated')::text, true);
    PERFORM public.decide_business_approval(v_biz2_id, 'rejected', '임대차계약서 불일치', '반려 메모');

    -- Reset to verifier role to inspect state with full privileges
    PERFORM set_config('role', v_orig_user, false);
    PERFORM set_config('request.jwt.claim.role', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', '', true);

    -- Track rejection audit log ID for G13
    SELECT id INTO v_temp_audit_id FROM public.audit_logs
    WHERE entity_type = 'businesses' AND entity_id = v_biz2_id AND action = 'business.reject';
    v_created_audit_ids := array_append(v_created_audit_ids, v_temp_audit_id);

    -- Assert store 2 rejected (NULL-safe)
    SELECT registration_status, rejection_reason INTO v_status, v_rejection_reason
    FROM public.businesses WHERE id = v_biz2_id;
    IF v_status IS DISTINCT FROM 'rejected' OR v_rejection_reason IS DISTINCT FROM '임대차계약서 불일치' THEN
      RAISE EXCEPTION 'G12 FAIL: business 2 status or reason mismatch (status=%, reason=%)', v_status, v_rejection_reason USING errcode = 'P0001';
    END IF;

    -- Assert verification record status updated to rejected (NULL-safe)
    SELECT status INTO v_verif_status
    FROM public.business_verifications
    WHERE business_id = v_biz2_id;
    IF v_verif_status IS DISTINCT FROM 'rejected' THEN
      RAISE EXCEPTION 'G12 FAIL: verification status expected rejected, got %', v_verif_status USING errcode = 'P0001';
    END IF;

    -- Assert applicant STILL has merchant role (because store 1 is approved)
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = u_applicant AND role = 'merchant'
    ) INTO v_has_merchant;
    IF NOT v_has_merchant THEN
      RAISE EXCEPTION 'G12 FAIL: merchant role must not be revoked on rejection of store 2' USING errcode = 'P0001';
    END IF;

    -- Assert duplicate rejection blocked
    PERFORM set_config('role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', u_admin::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u_admin::text, 'role', 'authenticated')::text, true);

    BEGIN
      PERFORM public.decide_business_approval(v_biz2_id, 'rejected', '재반려');
      RAISE EXCEPTION 'G12 FAIL: duplicate rejection should be blocked with HM006' USING errcode = 'P0001';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE, v_caught_msg = MESSAGE_TEXT;
      IF v_caught_code <> 'HM006' THEN
        RAISE EXCEPTION 'G12 FAIL: expected HM006 on duplicate rejection, got % (%)', v_caught_code, v_caught_msg USING errcode = 'P0001';
      END IF;
    END;

    -- Reset to verifier role
    PERFORM set_config('role', v_orig_user, false);
    PERFORM set_config('request.jwt.claim.role', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', '', true);

    v_done := array_append(v_done, 'G12_REJECTION_FLOW_AND_ROLE_PRESERVATION');
    RAISE NOTICE '  ✓ G12: Rejection flow and merchant role preservation verified.';

    -- Mark all done and trigger intentional rollback
    v_all_done := true;
    RAISE EXCEPTION 'INTENTIONAL_FORCE_ROLLBACK_TASK_08' USING errcode = 'P0099';

  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE, v_caught_msg = MESSAGE_TEXT;
    IF v_caught_code <> 'P0099' OR NOT v_all_done THEN
      RAISE EXCEPTION 'DML Subtransaction failed unexpectedly: SQLSTATE=% MSG=%', v_caught_code, v_caught_msg;
    END IF;
  END;

  -- Reset session role to original
  PERFORM set_config('role', v_orig_user, false);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  -- ============================================================================
  -- G13: Rollback Residue Check (All 8 tables must have 0 test rows)
  -- Uses explicit preserved arrays (v_created_biz_ids, v_created_audit_ids) to prevent
  -- false-clean results from empty subqueries or NULL foreign keys.
  -- ============================================================================
  -- 1) auth.users
  SELECT count(*) INTO v_count FROM auth.users WHERE id IN (u_applicant, u_other, u_admin, u_temp);
  IF v_count > 0 THEN RAISE EXCEPTION 'G13 FAIL: auth.users residue %', v_count USING errcode = 'P0001'; END IF;

  -- 2) public.profiles
  SELECT count(*) INTO v_count FROM public.profiles WHERE id IN (u_applicant, u_other, u_admin, u_temp);
  IF v_count > 0 THEN RAISE EXCEPTION 'G13 FAIL: profiles residue %', v_count USING errcode = 'P0001'; END IF;

  -- 3) public.user_roles
  SELECT count(*) INTO v_count FROM public.user_roles WHERE user_id IN (u_applicant, u_other, u_admin, u_temp);
  IF v_count > 0 THEN RAISE EXCEPTION 'G13 FAIL: user_roles residue %', v_count USING errcode = 'P0001'; END IF;

  -- 4) public.businesses (direct ID check and creator check)
  SELECT count(*) INTO v_count FROM public.businesses
  WHERE id = ANY(v_created_biz_ids)
     OR created_by IN (u_applicant, u_other, u_admin, u_temp);
  IF v_count > 0 THEN RAISE EXCEPTION 'G13 FAIL: businesses residue %', v_count USING errcode = 'P0001'; END IF;

  -- 5) public.business_members (direct business_id check and user_id check)
  SELECT count(*) INTO v_count FROM public.business_members
  WHERE business_id = ANY(v_created_biz_ids)
     OR user_id IN (u_applicant, u_other, u_admin, u_temp);
  IF v_count > 0 THEN RAISE EXCEPTION 'G13 FAIL: business_members residue %', v_count USING errcode = 'P0001'; END IF;

  -- 6) public.business_verifications (direct business_id check and submitter/reviewer check)
  SELECT count(*) INTO v_count FROM public.business_verifications
  WHERE business_id = ANY(v_created_biz_ids)
     OR submitted_by IN (u_applicant, u_other, u_admin, u_temp)
     OR reviewed_by IN (u_applicant, u_other, u_admin, u_temp);
  IF v_count > 0 THEN RAISE EXCEPTION 'G13 FAIL: business_verifications residue %', v_count USING errcode = 'P0001'; END IF;

  -- 7) public.business_hours (DIRECT check by preserved created business UUIDs, independent of businesses table)
  SELECT count(*) INTO v_count FROM public.business_hours
  WHERE business_id = ANY(v_created_biz_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G13 FAIL: business_hours residue %', v_count USING errcode = 'P0001'; END IF;

  -- 8) public.audit_logs (DIRECT check by created audit log IDs, entity IDs, and actor IDs)
  SELECT count(*) INTO v_count FROM public.audit_logs
  WHERE id = ANY(v_created_audit_ids)
     OR entity_id = ANY(v_created_biz_ids)
     OR actor_user_id IN (u_applicant, u_other, u_admin, u_temp);
  IF v_count > 0 THEN RAISE EXCEPTION 'G13 FAIL: audit_logs residue %', v_count USING errcode = 'P0001'; END IF;

  v_done := array_append(v_done, 'G13_ROLLBACK_AND_RESIDUE_CHECK');
  RAISE NOTICE '  ✓ G13: Rollback verified. All 8 tables have 0 residue rows.';

  -- Final completion verification
  IF v_done <> v_expected THEN
    RAISE EXCEPTION 'FINAL FAIL: completed groups % != expected %', v_done, v_expected USING errcode = 'P0001';
  END IF;

  RAISE NOTICE '============================================================';
  RAISE NOTICE 'ALL 14 GROUPS PASSED (TASK 08-A / 08-B SQL VERIFICATION 100%% OK)';
  RAISE NOTICE '============================================================';

END $verify$;
