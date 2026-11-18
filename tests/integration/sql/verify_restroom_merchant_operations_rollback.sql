-- ============================================================================
-- Verification SQL: verify_restroom_merchant_operations_rollback.sql
-- Purpose: TASK 12-C Merchant Restroom Operations & Policy Immutability Rollback Verification
-- Reference: tasks/12_restroom_merchant_api.md, docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/11_DECISIONS.md
--
-- Structure:
--   DO block with subtransaction:
--     G00: Preflight Collision Checks (Auth Users, Businesses, Restrooms)
--     G01: Migration Record Verification (20261111000000 in supabase_migrations)
--     G02: RPC Existence, Signatures, SECURITY DEFINER & search_path
--     G03: EXECUTE Permissions Check (anon/public revoked, authenticated/service_role granted)
--     G04: Test Account & Business Setup (Admin, Merchant, Other Merchant, Customer, Revoked)
--     G05: anon & Unauthorized Calling Rejection (42501)
--     G06: Authorized Restroom Creation (Draft + Policy v1 Atomic)
--     G07: Authorized Policy Transition to v2 & Immutability / History Retention
--     G08: Direct Policy INSERT & UPDATE 42501 Rejection (Non-admin immutability)
--     G09: Review Submission Workflow (Draft -> Pending, Edge Cases)
--     G10: Direct Modification of publication_status Prohibited (Non-admin)
--     G11: Cross-Store & Revoked Access Rejection (42501)
--     G12: Free Mode vs Test Deposit Mode Default Parity Comparison
--     G13: Intentional Force Rollback (P0099) & Complete Zero Residue Check
-- ============================================================================

DO $$
DECLARE
  v_orig_user text;
  v_all_done boolean := false;
  v_caught_code text;
  v_caught_msg text;
  v_count integer;
  v_sub_success boolean;
  v_func_oid oid;
  v_args text;
  v_rettype text;
  v_prosecdef boolean;
  v_proconfig text[];

  -- Test Users (Isolated UUID space: fa120000-...)
  u_admin uuid := 'fa120000-0000-4000-a000-000000000001'::uuid;
  e_admin text := 'test_admin_t12@hujimap.local';

  u_merchant uuid := 'fa120000-0000-4000-a000-000000000002'::uuid;
  e_merchant text := 'test_merchant_t12@hujimap.local';

  u_merchant_other uuid := 'fa120000-0000-4000-a000-000000000003'::uuid;
  e_merchant_other text := 'test_merchant_other_t12@hujimap.local';

  u_customer uuid := 'fa120000-0000-4000-a000-000000000004'::uuid;
  e_customer text := 'test_customer_t12@hujimap.local';

  u_revoked uuid := 'fa120000-0000-4000-a000-000000000005'::uuid;
  e_revoked text := 'test_revoked_t12@hujimap.local';

  -- Test Businesses
  v_biz_approved_id uuid := 'fa120000-0000-4000-c000-000000000001'::uuid;
  v_biz_other_id uuid := 'fa120000-0000-4000-c000-000000000002'::uuid;
  v_biz_pending_id uuid := 'fa120000-0000-4000-c000-000000000003'::uuid;

  -- Test Restroom Records & IDs
  v_restroom_1 public.restrooms;
  v_restroom_incomplete public.restrooms;
  v_restroom_free public.restrooms;
  v_restroom_deposit public.restrooms;
  v_restroom_check public.restrooms;

  -- Test Policy Records
  v_policy_v1 public.restroom_access_policies;
  v_policy_v2 public.restroom_access_policies;
  v_policy_v3 public.restroom_access_policies;
  v_policy_check public.restroom_access_policies;
  v_policy_free_v1 public.restroom_access_policies;
  v_policy_free_v2 public.restroom_access_policies;
  v_policy_free_v3 public.restroom_access_policies;
  v_policy_dep_v1 public.restroom_access_policies;

  -- Preserved Tracking Arrays for G13 Rollback Check
  v_tracked_user_ids uuid[] := ARRAY[]::uuid[];
  v_tracked_biz_ids uuid[] := ARRAY[]::uuid[];
  v_tracked_restroom_ids uuid[] := ARRAY[]::uuid[];
  v_tracked_policy_ids uuid[] := ARRAY[]::uuid[];

  v_done text[] := ARRAY[]::text[];
BEGIN
  SELECT current_user INTO v_orig_user;
  RAISE NOTICE 'Starting TASK 12-C Restroom Merchant Operations Verification as %...', v_orig_user;

  -- ============================================================================
  -- G00: Preflight Collision Checks (All Fixed Test Fixture UUIDs)
  -- ============================================================================
  IF EXISTS (
    SELECT 1 FROM auth.users
    WHERE id IN (u_admin, u_merchant, u_merchant_other, u_customer, u_revoked)
       OR email IN (e_admin, e_merchant, e_merchant_other, e_customer, e_revoked)
  ) THEN
    RAISE EXCEPTION 'G00 FAIL: auth.users preflight collision' USING errcode = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.businesses
    WHERE id IN (v_biz_approved_id, v_biz_other_id, v_biz_pending_id)
  ) THEN
    RAISE EXCEPTION 'G00 FAIL: businesses preflight collision' USING errcode = 'P0001';
  END IF;

  v_done := array_append(v_done, 'G00_PREFLIGHT_COLLISION_CHECK');
  RAISE NOTICE '  ✓ G00: Preflight collision check passed.';

  -- ============================================================================
  -- G01: Migration Record Verification (20261111000000 in supabase_migrations)
  -- ============================================================================
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'supabase_migrations' AND table_name = 'schema_migrations'
  ) THEN
    RAISE EXCEPTION 'G01 FAIL: supabase_migrations.schema_migrations table does not exist' USING errcode = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261111000000'
  ) THEN
    RAISE EXCEPTION 'G01 FAIL: Migration 20261111000000 not found in supabase_migrations.schema_migrations' USING errcode = 'P0001';
  END IF;

  v_done := array_append(v_done, 'G01_MIGRATION_RECORD');
  RAISE NOTICE '  ✓ G01: Migration 20261111000000 record verified in supabase_migrations.schema_migrations.';

  -- ============================================================================
  -- G02: RPC Existence, Signatures, SECURITY DEFINER & search_path
  -- ============================================================================
  -- 1) create_merchant_restroom
  SELECT p.oid, pg_get_function_arguments(p.oid), pg_get_function_result(p.oid), p.prosecdef, p.proconfig
  INTO v_func_oid, v_args, v_rettype, v_prosecdef, v_proconfig
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'create_merchant_restroom';

  IF v_func_oid IS NULL THEN
    RAISE EXCEPTION 'G02 FAIL: create_merchant_restroom RPC does not exist' USING errcode = 'P0001';
  END IF;

  IF NOT v_prosecdef THEN
    RAISE EXCEPTION 'G02 FAIL: create_merchant_restroom must be SECURITY DEFINER' USING errcode = 'P0001';
  END IF;

  IF v_rettype NOT IN ('restrooms', 'public.restrooms') THEN
    RAISE EXCEPTION 'G02 FAIL: create_merchant_restroom return type mismatch: %', v_rettype USING errcode = 'P0001';
  END IF;

  IF v_proconfig IS NULL OR NOT ('search_path=public, pg_temp' = ANY(v_proconfig)) THEN
    RAISE EXCEPTION 'G02 FAIL: create_merchant_restroom search_path must be public, pg_temp' USING errcode = 'P0001';
  END IF;

  IF v_args NOT LIKE '%p_business_id uuid%'
     OR v_args NOT LIKE '%p_name text%'
     OR v_args NOT LIKE '%p_deposit_amount_krw integer%' THEN
    RAISE EXCEPTION 'G02 FAIL: create_merchant_restroom signature mismatch: %', v_args USING errcode = 'P0001';
  END IF;

  -- 2) create_merchant_restroom_policy
  SELECT p.oid, pg_get_function_arguments(p.oid), pg_get_function_result(p.oid), p.prosecdef, p.proconfig
  INTO v_func_oid, v_args, v_rettype, v_prosecdef, v_proconfig
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'create_merchant_restroom_policy';

  IF v_func_oid IS NULL THEN
    RAISE EXCEPTION 'G02 FAIL: create_merchant_restroom_policy RPC does not exist' USING errcode = 'P0001';
  END IF;

  IF NOT v_prosecdef THEN
    RAISE EXCEPTION 'G02 FAIL: create_merchant_restroom_policy must be SECURITY DEFINER' USING errcode = 'P0001';
  END IF;

  IF v_rettype NOT IN ('restroom_access_policies', 'public.restroom_access_policies') THEN
    RAISE EXCEPTION 'G02 FAIL: create_merchant_restroom_policy return type mismatch: %', v_rettype USING errcode = 'P0001';
  END IF;

  IF v_proconfig IS NULL OR NOT ('search_path=public, pg_temp' = ANY(v_proconfig)) THEN
    RAISE EXCEPTION 'G02 FAIL: create_merchant_restroom_policy search_path must be public, pg_temp' USING errcode = 'P0001';
  END IF;

  IF v_args NOT LIKE '%p_restroom_id uuid%'
     OR v_args NOT LIKE '%p_access_mode text%'
     OR v_args NOT LIKE '%p_deposit_amount_krw integer%' THEN
    RAISE EXCEPTION 'G02 FAIL: create_merchant_restroom_policy signature mismatch: %', v_args USING errcode = 'P0001';
  END IF;

  -- 3) submit_merchant_restroom_for_review
  SELECT p.oid, pg_get_function_arguments(p.oid), pg_get_function_result(p.oid), p.prosecdef, p.proconfig
  INTO v_func_oid, v_args, v_rettype, v_prosecdef, v_proconfig
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'submit_merchant_restroom_for_review';

  IF v_func_oid IS NULL THEN
    RAISE EXCEPTION 'G02 FAIL: submit_merchant_restroom_for_review RPC does not exist' USING errcode = 'P0001';
  END IF;

  IF NOT v_prosecdef THEN
    RAISE EXCEPTION 'G02 FAIL: submit_merchant_restroom_for_review must be SECURITY DEFINER' USING errcode = 'P0001';
  END IF;

  IF v_rettype NOT IN ('restrooms', 'public.restrooms') THEN
    RAISE EXCEPTION 'G02 FAIL: submit_merchant_restroom_for_review return type mismatch: %', v_rettype USING errcode = 'P0001';
  END IF;

  IF v_proconfig IS NULL OR NOT ('search_path=public, pg_temp' = ANY(v_proconfig)) THEN
    RAISE EXCEPTION 'G02 FAIL: submit_merchant_restroom_for_review search_path must be public, pg_temp' USING errcode = 'P0001';
  END IF;

  v_done := array_append(v_done, 'G02_RPC_SIGNATURES_AND_DEFINER');
  RAISE NOTICE '  ✓ G02: All 3 RPCs exist with exact signatures, SECURITY DEFINER, and safe search_path.';

  -- ============================================================================
  -- G03: EXECUTE Permissions Check (anon/public revoked, authenticated/service_role granted)
  -- ============================================================================
  -- Check create_merchant_restroom
  SELECT p.oid INTO v_func_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'create_merchant_restroom';

  IF has_function_privilege('anon', v_func_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'G03 FAIL: anon must NOT have execute on create_merchant_restroom' USING errcode = 'P0001';
  END IF;
  IF has_function_privilege('public', v_func_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'G03 FAIL: public must NOT have execute on create_merchant_restroom' USING errcode = 'P0001';
  END IF;
  IF NOT has_function_privilege('authenticated', v_func_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'G03 FAIL: authenticated must have execute on create_merchant_restroom' USING errcode = 'P0001';
  END IF;
  IF NOT has_function_privilege('service_role', v_func_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'G03 FAIL: service_role must have execute on create_merchant_restroom' USING errcode = 'P0001';
  END IF;

  -- Check create_merchant_restroom_policy
  SELECT p.oid INTO v_func_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'create_merchant_restroom_policy';

  IF has_function_privilege('anon', v_func_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'G03 FAIL: anon must NOT have execute on create_merchant_restroom_policy' USING errcode = 'P0001';
  END IF;
  IF has_function_privilege('public', v_func_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'G03 FAIL: public must NOT have execute on create_merchant_restroom_policy' USING errcode = 'P0001';
  END IF;
  IF NOT has_function_privilege('authenticated', v_func_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'G03 FAIL: authenticated must have execute on create_merchant_restroom_policy' USING errcode = 'P0001';
  END IF;
  IF NOT has_function_privilege('service_role', v_func_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'G03 FAIL: service_role must have execute on create_merchant_restroom_policy' USING errcode = 'P0001';
  END IF;

  -- Check submit_merchant_restroom_for_review
  SELECT p.oid INTO v_func_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'submit_merchant_restroom_for_review';

  IF has_function_privilege('anon', v_func_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'G03 FAIL: anon must NOT have execute on submit_merchant_restroom_for_review' USING errcode = 'P0001';
  END IF;
  IF has_function_privilege('public', v_func_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'G03 FAIL: public must NOT have execute on submit_merchant_restroom_for_review' USING errcode = 'P0001';
  END IF;
  IF NOT has_function_privilege('authenticated', v_func_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'G03 FAIL: authenticated must have execute on submit_merchant_restroom_for_review' USING errcode = 'P0001';
  END IF;
  IF NOT has_function_privilege('service_role', v_func_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'G03 FAIL: service_role must have execute on submit_merchant_restroom_for_review' USING errcode = 'P0001';
  END IF;

  v_done := array_append(v_done, 'G03_EXECUTE_PERMISSIONS');
  RAISE NOTICE '  ✓ G03: Function execute permissions validated (anon/public denied, authenticated/service_role allowed).';

  -- ============================================================================
  -- SUBTRANSACTION FOR DATA MUTATIONS AND RPC VERIFICATION
  -- ============================================================================
  BEGIN
    -- ============================================================================
    -- G04: Test Account & Business Setup
    -- ============================================================================
    INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
    VALUES
      (u_admin, e_admin, '{"name":"Admin T12"}'::jsonb, now(), now()),
      (u_merchant, e_merchant, '{"name":"Merchant T12"}'::jsonb, now(), now()),
      (u_merchant_other, e_merchant_other, '{"name":"Other Merchant T12"}'::jsonb, now(), now()),
      (u_customer, e_customer, '{"name":"Customer T12"}'::jsonb, now(), now()),
      (u_revoked, e_revoked, '{"name":"Revoked Merchant T12"}'::jsonb, now(), now());

    v_tracked_user_ids := ARRAY[u_admin, u_merchant, u_merchant_other, u_customer, u_revoked];

    -- Roles (admin & merchant elevated roles; customer role is automatically granted by handle_new_user)
    INSERT INTO public.user_roles (user_id, role)
    VALUES
      (u_admin, 'admin'),
      (u_merchant, 'merchant'),
      (u_merchant_other, 'merchant')
    ON CONFLICT (user_id, role) DO NOTHING;

    -- Businesses
    -- 1) Approved store for u_merchant
    INSERT INTO public.businesses (
      id, name, category, road_address, latitude, longitude, registration_status, created_by, approved_by, approved_at
    ) VALUES (
      v_biz_approved_id, '승인 제휴 카페 수원본점', '카페', '수원시 팔달구 매산로 1', 37.2660, 127.0010, 'approved', u_merchant, u_admin, now()
    );
    v_tracked_biz_ids := array_append(v_tracked_biz_ids, v_biz_approved_id);

    -- 2) Approved store for u_merchant_other
    INSERT INTO public.businesses (
      id, name, category, road_address, latitude, longitude, registration_status, created_by, approved_by, approved_at
    ) VALUES (
      v_biz_other_id, '다른 제휴 식당 수원점', '식당', '수원시 팔달구 매산로 2', 37.2670, 127.0020, 'approved', u_merchant_other, u_admin, now()
    );
    v_tracked_biz_ids := array_append(v_tracked_biz_ids, v_biz_other_id);

    -- 3) Pending (unapproved) store for u_merchant
    INSERT INTO public.businesses (
      id, name, category, road_address, latitude, longitude, registration_status, created_by
    ) VALUES (
      v_biz_pending_id, '심사 대기 중인 매장', '카페', '수원시 팔달구 매산로 3', 37.2680, 127.0030, 'pending', u_merchant
    );
    v_tracked_biz_ids := array_append(v_tracked_biz_ids, v_biz_pending_id);

    -- Business Memberships
    INSERT INTO public.business_members (business_id, user_id, role, membership_status)
    VALUES
      (v_biz_approved_id, u_merchant, 'owner', 'active'),
      (v_biz_approved_id, u_revoked, 'manager', 'revoked'),
      (v_biz_other_id, u_merchant_other, 'owner', 'active'),
      (v_biz_pending_id, u_merchant, 'owner', 'active');

    v_done := array_append(v_done, 'G04_TEST_FIXTURE_SETUP');
    RAISE NOTICE '  ✓ G04: Isolated test fixtures setup complete (5 users, 3 businesses, memberships).';

    -- ============================================================================
    -- G05: anon & Unauthorized Calling Rejection (42501)
    -- ============================================================================
    -- 1) Anon / NULL auth.uid() calling create_merchant_restroom -> 42501
    PERFORM set_config('role', 'anon', true);
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);

    v_sub_success := false;
    BEGIN
      PERFORM public.create_merchant_restroom(
        p_business_id => v_biz_approved_id,
        p_name => '익명 화장실 생성 시도',
        p_road_address => '경기 수원시 팔달구 매산로 1'
      );
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G05 FAIL: anon create_merchant_restroom expected 42501, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G05 FAIL: anon must NOT be allowed to call create_merchant_restroom' USING errcode = 'P0001';
    END IF;

    -- 2) Customer (no business membership) calling create_merchant_restroom -> 42501
    PERFORM set_config('role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', u_customer::text, true);

    v_sub_success := false;
    BEGIN
      PERFORM public.create_merchant_restroom(
        p_business_id => v_biz_approved_id,
        p_name => '고객 무단 화장실 등록 시도',
        p_road_address => '경기 수원시 팔달구 매산로 1'
      );
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G05 FAIL: customer create_merchant_restroom expected 42501, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G05 FAIL: customer must NOT be allowed to register restroom' USING errcode = 'P0001';
    END IF;

    -- 3) Calling create_merchant_restroom on pending (unapproved) store -> 42501
    PERFORM set_config('request.jwt.claim.sub', u_merchant::text, true);

    v_sub_success := false;
    BEGIN
      PERFORM public.create_merchant_restroom(
        p_business_id => v_biz_pending_id,
        p_name => '미승인 매장 화장실 등록 시도',
        p_road_address => '경기 수원시 팔달구 매산로 3'
      );
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G05 FAIL: unapproved store create_merchant_restroom expected 42501, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G05 FAIL: unapproved store must NOT allow restroom creation' USING errcode = 'P0001';
    END IF;

    v_done := array_append(v_done, 'G05_UNAUTHORIZED_RPC_REJECTION');
    RAISE NOTICE '  ✓ G05: anon, customer, and unapproved business RPC calls strictly blocked with 42501.';

    -- ============================================================================
    -- G06: Authorized Restroom Creation (Draft + Policy v1 Atomic)
    -- ============================================================================
    -- As u_merchant (owner of approved business v_biz_approved_id)
    PERFORM set_config('role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', u_merchant::text, true);

    v_restroom_1 := public.create_merchant_restroom(
      p_business_id => v_biz_approved_id,
      p_name => '수원 카페 본점 제휴 화장실',
      p_description => '가게 내부 남녀공용 화장실입니다.',
      p_road_address => '경기 수원시 팔달구 매산로 10',
      p_address_detail => '1층 101호',
      p_latitude => 37.2660,
      p_longitude => 127.0010,
      p_floor => '1층',
      p_entrance_instructions => '카운터 우측 통로',
      p_gender_type => 'unisex',
      p_wheelchair_accessible => true,
      p_baby_changing_available => false,
      p_sanitary_products_available => true,
      p_access_method => 'ask_staff',
      p_access_mode => 'test_deposit',
      p_deposit_amount_krw => 1000,
      p_refund_eligible => true,
      p_receipt_window_hours => 24,
      p_min_purchase_krw => 0
    );

    v_tracked_restroom_ids := array_append(v_tracked_restroom_ids, v_restroom_1.id);

    -- Verify restroom row properties
    IF v_restroom_1.id IS NULL THEN
      RAISE EXCEPTION 'G06 FAIL: created restroom id is null' USING errcode = 'P0001';
    END IF;
    IF v_restroom_1.type <> 'partner' THEN
      RAISE EXCEPTION 'G06 FAIL: type must be partner, got %', v_restroom_1.type USING errcode = 'P0001';
    END IF;
    IF v_restroom_1.publication_status <> 'draft' THEN
      RAISE EXCEPTION 'G06 FAIL: initial status must be draft, got %', v_restroom_1.publication_status USING errcode = 'P0001';
    END IF;
    IF v_restroom_1.business_id <> v_biz_approved_id THEN
      RAISE EXCEPTION 'G06 FAIL: business_id mismatch' USING errcode = 'P0001';
    END IF;
    IF v_restroom_1.created_by <> u_merchant THEN
      RAISE EXCEPTION 'G06 FAIL: created_by mismatch' USING errcode = 'P0001';
    END IF;
    IF v_restroom_1.approved_by IS NOT NULL THEN
      RAISE EXCEPTION 'G06 FAIL: approved_by must be null on creation' USING errcode = 'P0001';
    END IF;

    -- Verify policy v1 automatically created in same transaction
    SELECT * INTO v_policy_v1
    FROM public.restroom_access_policies
    WHERE restroom_id = v_restroom_1.id;

    IF v_policy_v1.id IS NULL THEN
      RAISE EXCEPTION 'G06 FAIL: policy v1 was not created' USING errcode = 'P0001';
    END IF;

    v_tracked_policy_ids := array_append(v_tracked_policy_ids, v_policy_v1.id);

    IF v_policy_v1.version <> 1 THEN
      RAISE EXCEPTION 'G06 FAIL: policy version must be 1, got %', v_policy_v1.version USING errcode = 'P0001';
    END IF;
    IF NOT v_policy_v1.is_active THEN
      RAISE EXCEPTION 'G06 FAIL: policy v1 must be active' USING errcode = 'P0001';
    END IF;
    IF v_policy_v1.access_mode <> 'test_deposit' THEN
      RAISE EXCEPTION 'G06 FAIL: access_mode must be test_deposit, got %', v_policy_v1.access_mode USING errcode = 'P0001';
    END IF;
    IF v_policy_v1.deposit_amount_krw <> 1000 THEN
      RAISE EXCEPTION 'G06 FAIL: deposit_amount_krw must be 1000, got %', v_policy_v1.deposit_amount_krw USING errcode = 'P0001';
    END IF;
    IF NOT v_policy_v1.refund_eligible THEN
      RAISE EXCEPTION 'G06 FAIL: refund_eligible must be true' USING errcode = 'P0001';
    END IF;
    IF v_policy_v1.receipt_window_hours <> 24 THEN
      RAISE EXCEPTION 'G06 FAIL: receipt_window_hours must be 24, got %', v_policy_v1.receipt_window_hours USING errcode = 'P0001';
    END IF;
    IF v_policy_v1.min_purchase_krw <> 0 THEN
      RAISE EXCEPTION 'G06 FAIL: min_purchase_krw must be 0, got %', v_policy_v1.min_purchase_krw USING errcode = 'P0001';
    END IF;
    IF v_policy_v1.created_by <> u_merchant THEN
      RAISE EXCEPTION 'G06 FAIL: policy created_by must be u_merchant' USING errcode = 'P0001';
    END IF;

    v_done := array_append(v_done, 'G06_AUTHORIZED_RESTROOM_CREATION');
    RAISE NOTICE '  ✓ G06: Authorized draft restroom + policy v1 atomically created and verified.';

    -- ============================================================================
    -- G07: Authorized Policy Transition to v2 & Immutability / History Retention
    -- ============================================================================
    -- As u_merchant, transition restroom policy to 'free' mode
    v_policy_v2 := public.create_merchant_restroom_policy(
      p_restroom_id => v_restroom_1.id,
      p_access_mode => 'free'
    );
    v_tracked_policy_ids := array_append(v_tracked_policy_ids, v_policy_v2.id);

    IF v_policy_v2.version <> 2 THEN
      RAISE EXCEPTION 'G07 FAIL: next version must be 2, got %', v_policy_v2.version USING errcode = 'P0001';
    END IF;
    IF NOT v_policy_v2.is_active THEN
      RAISE EXCEPTION 'G07 FAIL: policy v2 must be active' USING errcode = 'P0001';
    END IF;
    IF v_policy_v2.access_mode <> 'free' THEN
      RAISE EXCEPTION 'G07 FAIL: policy v2 access_mode must be free' USING errcode = 'P0001';
    END IF;
    IF v_policy_v2.deposit_amount_krw <> 0 THEN
      RAISE EXCEPTION 'G07 FAIL: free mode deposit must be 0, got %', v_policy_v2.deposit_amount_krw USING errcode = 'P0001';
    END IF;
    IF v_policy_v2.refund_eligible THEN
      RAISE EXCEPTION 'G07 FAIL: free mode refund_eligible must be false' USING errcode = 'P0001';
    END IF;
    IF v_policy_v2.receipt_window_hours IS NOT NULL THEN
      RAISE EXCEPTION 'G07 FAIL: free mode receipt_window_hours must be null' USING errcode = 'P0001';
    END IF;

    -- Verify history retention: total 2 policies, exactly 1 active, v1 preserved as inactive
    SELECT count(*) INTO v_count
    FROM public.restroom_access_policies
    WHERE restroom_id = v_restroom_1.id;
    IF v_count <> 2 THEN
      RAISE EXCEPTION 'G07 FAIL: expected 2 policies for restroom, got %', v_count USING errcode = 'P0001';
    END IF;

    SELECT count(*) INTO v_count
    FROM public.restroom_access_policies
    WHERE restroom_id = v_restroom_1.id AND is_active = true;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'G07 FAIL: expected exactly 1 active policy, got %', v_count USING errcode = 'P0001';
    END IF;

    -- Check old version 1 record
    SELECT * INTO v_policy_check
    FROM public.restroom_access_policies
    WHERE id = v_policy_v1.id;
    IF v_policy_check.is_active THEN
      RAISE EXCEPTION 'G07 FAIL: old version 1 must now be inactive' USING errcode = 'P0001';
    END IF;
    IF v_policy_check.deposit_amount_krw <> 1000 OR v_policy_check.created_by <> u_merchant THEN
      RAISE EXCEPTION 'G07 FAIL: old version 1 historical data must be preserved unchanged' USING errcode = 'P0001';
    END IF;

    -- Further transition to v3 (custom test_deposit: deposit 2000, refund true, window 12, min 5000)
    v_policy_v3 := public.create_merchant_restroom_policy(
      p_restroom_id => v_restroom_1.id,
      p_access_mode => 'test_deposit',
      p_deposit_amount_krw => 2000,
      p_refund_eligible => true,
      p_receipt_window_hours => 12,
      p_min_purchase_krw => 5000
    );
    v_tracked_policy_ids := array_append(v_tracked_policy_ids, v_policy_v3.id);

    IF v_policy_v3.version <> 3 THEN
      RAISE EXCEPTION 'G07 FAIL: next version must be 3, got %', v_policy_v3.version USING errcode = 'P0001';
    END IF;
    IF v_policy_v3.deposit_amount_krw <> 2000 OR v_policy_v3.receipt_window_hours <> 12 OR v_policy_v3.min_purchase_krw <> 5000 THEN
      RAISE EXCEPTION 'G07 FAIL: v3 parameters mismatch' USING errcode = 'P0001';
    END IF;

    SELECT count(*) INTO v_count
    FROM public.restroom_access_policies
    WHERE restroom_id = v_restroom_1.id;
    IF v_count <> 3 THEN
      RAISE EXCEPTION 'G07 FAIL: expected 3 policies in history, got %', v_count USING errcode = 'P0001';
    END IF;

    v_done := array_append(v_done, 'G07_POLICY_VERSIONING_AND_HISTORY');
    RAISE NOTICE '  ✓ G07: Policy transitions to v2 and v3 succeeded, single active policy and full history preserved.';

    -- ============================================================================
    -- G08: Direct Policy INSERT & UPDATE 42501 Rejection (Non-admin immutability)
    -- ============================================================================
    -- 1) Merchant direct INSERT with arbitrary version 999 and forged deposit -> 42501
    v_sub_success := false;
    BEGIN
      INSERT INTO public.restroom_access_policies (
        restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, is_active, created_by
      ) VALUES (
        v_restroom_1.id, 999, 'test_deposit', 50000, true, true, u_merchant
      );
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G08 FAIL: direct policy insert expected 42501, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G08 FAIL: non-admin must NOT be allowed to directly insert policy' USING errcode = 'P0001';
    END IF;

    -- 2) Merchant direct INSERT of inactive policy (forging history) -> 42501
    v_sub_success := false;
    BEGIN
      INSERT INTO public.restroom_access_policies (
        restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, is_active, created_by
      ) VALUES (
        v_restroom_1.id, 50, 'free', 0, false, false, u_merchant
      );
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G08 FAIL: direct inactive policy insert expected 42501, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G08 FAIL: non-admin must NOT be allowed to forge policy history' USING errcode = 'P0001';
    END IF;

    -- 3) Merchant direct UPDATE of active policy (tampering with deposit_amount_krw) -> 42501
    v_sub_success := false;
    BEGIN
      UPDATE public.restroom_access_policies
      SET deposit_amount_krw = 9999
      WHERE id = v_policy_v3.id;
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G08 FAIL: direct policy update expected 42501, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G08 FAIL: non-admin must NOT be allowed to directly update policy deposit' USING errcode = 'P0001';
    END IF;

    -- 4) Merchant direct UPDATE of is_active flag -> 42501
    v_sub_success := false;
    BEGIN
      UPDATE public.restroom_access_policies
      SET is_active = false
      WHERE id = v_policy_v3.id;
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G08 FAIL: direct policy deactivation expected 42501, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G08 FAIL: non-admin must NOT be allowed to directly deactivate policy' USING errcode = 'P0001';
    END IF;

    -- 5) Customer direct INSERT -> 42501
    PERFORM set_config('request.jwt.claim.sub', u_customer::text, true);

    v_sub_success := false;
    BEGIN
      INSERT INTO public.restroom_access_policies (
        restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, is_active, created_by
      ) VALUES (
        v_restroom_1.id, 100, 'free', 0, false, true, u_customer
      );
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G08 FAIL: customer direct policy insert expected 42501, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G08 FAIL: customer must NOT be allowed to insert policy' USING errcode = 'P0001';
    END IF;

    -- Reset to merchant
    PERFORM set_config('request.jwt.claim.sub', u_merchant::text, true);

    v_done := array_append(v_done, 'G08_POLICY_IMMUTABILITY_BLOCKS');
    RAISE NOTICE '  ✓ G08: Direct policy INSERT/UPDATE attacks strictly rejected with 42501.';

    -- ============================================================================
    -- G09: Review Submission Workflow (Draft -> Pending, Edge Cases)
    -- ============================================================================
    -- 1) Create incomplete restroom without coordinates
    v_restroom_incomplete := public.create_merchant_restroom(
      p_business_id => v_biz_approved_id,
      p_name => '임시 좌표 미확인 화장실',
      p_road_address => '경기 수원시 팔달구 매산로 99',
      p_latitude => null,
      p_longitude => null,
      p_access_mode => 'free'
    );
    v_tracked_restroom_ids := array_append(v_tracked_restroom_ids, v_restroom_incomplete.id);

    -- Attempt to submit incomplete restroom for review -> HM005
    v_sub_success := false;
    BEGIN
      PERFORM public.submit_merchant_restroom_for_review(v_restroom_incomplete.id);
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE, v_caught_msg = MESSAGE_TEXT;
      IF v_caught_code <> 'HM005' THEN
        RAISE EXCEPTION 'G09 FAIL: submit without coords expected HM005, got % (MSG: %)', v_caught_code, v_caught_msg USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G09 FAIL: incomplete draft without coordinates must NOT be submitted' USING errcode = 'P0001';
    END IF;

    -- 2) Normal submission of complete restroom v_restroom_1 (draft -> pending)
    v_restroom_1 := public.submit_merchant_restroom_for_review(v_restroom_1.id);

    IF v_restroom_1.publication_status <> 'pending' THEN
      RAISE EXCEPTION 'G09 FAIL: publication_status must be pending after submission, got %', v_restroom_1.publication_status USING errcode = 'P0001';
    END IF;

    -- Verify database record
    SELECT * INTO v_restroom_check FROM public.restrooms WHERE id = v_restroom_1.id;
    IF v_restroom_check.publication_status <> 'pending' THEN
      RAISE EXCEPTION 'G09 FAIL: database publication_status is not pending' USING errcode = 'P0001';
    END IF;

    -- 3) Re-submitting an already pending restroom -> HM001
    v_sub_success := false;
    BEGIN
      PERFORM public.submit_merchant_restroom_for_review(v_restroom_1.id);
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE, v_caught_msg = MESSAGE_TEXT;
      IF v_caught_code <> 'HM001' THEN
        RAISE EXCEPTION 'G09 FAIL: resubmit pending restroom expected HM001, got % (MSG: %)', v_caught_code, v_caught_msg USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G09 FAIL: duplicate review submission must NOT be allowed' USING errcode = 'P0001';
    END IF;

    v_done := array_append(v_done, 'G09_REVIEW_SUBMISSION_WORKFLOW');
    RAISE NOTICE '  ✓ G09: Review submission (draft -> pending), completeness check (HM005), and re-submission block (HM001) verified.';

    -- ============================================================================
    -- G10: Direct Modification of publication_status Prohibited (Non-admin)
    -- ============================================================================
    -- 1) Merchant attempts to directly mark restroom as 'published' -> 42501
    v_sub_success := false;
    BEGIN
      UPDATE public.restrooms
      SET publication_status = 'published'
      WHERE id = v_restroom_1.id;
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G10 FAIL: direct published update expected 42501, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G10 FAIL: non-admin must NOT be allowed to directly publish restroom' USING errcode = 'P0001';
    END IF;

    -- 2) Merchant attempts to reset status back to 'draft' directly -> 42501
    v_sub_success := false;
    BEGIN
      UPDATE public.restrooms
      SET publication_status = 'draft'
      WHERE id = v_restroom_1.id;
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G10 FAIL: direct status draft update expected 42501, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G10 FAIL: non-admin must NOT be allowed to directly alter publication_status' USING errcode = 'P0001';
    END IF;

    v_done := array_append(v_done, 'G10_DIRECT_STATUS_TAMPERING_BLOCKED');
    RAISE NOTICE '  ✓ G10: Direct publication_status modification by merchant blocked with 42501.';

    -- ============================================================================
    -- G11: Cross-Store & Revoked Access Rejection (42501)
    -- ============================================================================
    -- 1) u_merchant_other (owner of v_biz_other_id) tries to operate on v_biz_approved_id -> 42501
    PERFORM set_config('role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', u_merchant_other::text, true);

    -- Try create_merchant_restroom for store A
    v_sub_success := false;
    BEGIN
      PERFORM public.create_merchant_restroom(
        p_business_id => v_biz_approved_id,
        p_name => '타 가게 점주의 화장실 등록 시도',
        p_road_address => '경기 수원시 팔달구 매산로 1'
      );
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G11 FAIL: cross-store create expected 42501, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G11 FAIL: cross-store create_merchant_restroom must NOT succeed' USING errcode = 'P0001';
    END IF;

    -- Try create_merchant_restroom_policy for store A restroom
    v_sub_success := false;
    BEGIN
      PERFORM public.create_merchant_restroom_policy(
        p_restroom_id => v_restroom_1.id,
        p_access_mode => 'free'
      );
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G11 FAIL: cross-store policy create expected 42501, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G11 FAIL: cross-store create_merchant_restroom_policy must NOT succeed' USING errcode = 'P0001';
    END IF;

    -- Try submit_merchant_restroom_for_review for store A restroom
    v_sub_success := false;
    BEGIN
      PERFORM public.submit_merchant_restroom_for_review(v_restroom_1.id);
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G11 FAIL: cross-store submit expected 42501, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G11 FAIL: cross-store submit_merchant_restroom_for_review must NOT succeed' USING errcode = 'P0001';
    END IF;

    -- 2) u_revoked (revoked membership on v_biz_approved_id) -> 42501
    PERFORM set_config('request.jwt.claim.sub', u_revoked::text, true);

    v_sub_success := false;
    BEGIN
      PERFORM public.create_merchant_restroom(
        p_business_id => v_biz_approved_id,
        p_name => '권한 회수자의 화장실 등록 시도',
        p_road_address => '경기 수원시 팔달구 매산로 1'
      );
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G11 FAIL: revoked member create expected 42501, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G11 FAIL: revoked member must NOT be allowed to create restroom' USING errcode = 'P0001';
    END IF;

    v_done := array_append(v_done, 'G11_CROSS_STORE_AND_REVOKED_BLOCKED');
    RAISE NOTICE '  ✓ G11: Cross-store and revoked member RPC calls blocked with 42501.';

    -- ============================================================================
    -- G12: Free Mode vs Test Deposit Mode Default Parity Comparison
    -- ============================================================================
    PERFORM set_config('request.jwt.claim.sub', u_merchant::text, true);

    -- 1) Create restroom with access_mode = 'free' via create_merchant_restroom
    v_restroom_free := public.create_merchant_restroom(
      p_business_id => v_biz_approved_id,
      p_name => '무료 개방 화장실',
      p_road_address => '경기 수원시 팔달구 매산로 50',
      p_latitude => 37.2690,
      p_longitude => 127.0040,
      p_access_mode => 'free'
    );
    v_tracked_restroom_ids := array_append(v_tracked_restroom_ids, v_restroom_free.id);

    SELECT * INTO v_policy_free_v1
    FROM public.restroom_access_policies
    WHERE restroom_id = v_restroom_free.id AND is_active = true;
    v_tracked_policy_ids := array_append(v_tracked_policy_ids, v_policy_free_v1.id);

    -- 2) Transition v_restroom_free to 'test_deposit' via create_merchant_restroom_policy (defaults omitted)
    v_policy_free_v2 := public.create_merchant_restroom_policy(
      p_restroom_id => v_restroom_free.id,
      p_access_mode => 'test_deposit'
    );
    v_tracked_policy_ids := array_append(v_tracked_policy_ids, v_policy_free_v2.id);

    -- 3) Transition v_restroom_free back to 'free' via create_merchant_restroom_policy (defaults omitted)
    v_policy_free_v3 := public.create_merchant_restroom_policy(
      p_restroom_id => v_restroom_free.id,
      p_access_mode => 'free'
    );
    v_tracked_policy_ids := array_append(v_tracked_policy_ids, v_policy_free_v3.id);

    -- 4) Create another restroom with access_mode = 'test_deposit' via create_merchant_restroom (defaults omitted)
    v_restroom_deposit := public.create_merchant_restroom(
      p_business_id => v_biz_approved_id,
      p_name => '기본 보증금 화장실',
      p_road_address => '경기 수원시 팔달구 매산로 60',
      p_latitude => 37.2695,
      p_longitude => 127.0045,
      p_access_mode => 'test_deposit'
    );
    v_tracked_restroom_ids := array_append(v_tracked_restroom_ids, v_restroom_deposit.id);

    SELECT * INTO v_policy_dep_v1
    FROM public.restroom_access_policies
    WHERE restroom_id = v_restroom_deposit.id AND is_active = true;
    v_tracked_policy_ids := array_append(v_tracked_policy_ids, v_policy_dep_v1.id);

    -- 5) PARITY COMPARISON: FREE MODE
    -- Initial create vs policy change
    IF v_policy_free_v1.access_mode <> v_policy_free_v3.access_mode
       OR v_policy_free_v1.deposit_amount_krw <> v_policy_free_v3.deposit_amount_krw
       OR v_policy_free_v1.refund_eligible <> v_policy_free_v3.refund_eligible
       OR v_policy_free_v1.receipt_window_hours IS DISTINCT FROM v_policy_free_v3.receipt_window_hours
       OR v_policy_free_v1.min_purchase_krw <> v_policy_free_v3.min_purchase_krw THEN
      RAISE EXCEPTION 'G12 FAIL: Free mode parity mismatch between create_merchant_restroom and create_merchant_restroom_policy' USING errcode = 'P0001';
    END IF;

    -- Strict expected values for free mode
    IF v_policy_free_v1.deposit_amount_krw <> 0
       OR v_policy_free_v1.refund_eligible <> false
       OR v_policy_free_v1.receipt_window_hours IS NOT NULL
       OR v_policy_free_v1.min_purchase_krw <> 0 THEN
      RAISE EXCEPTION 'G12 FAIL: Free mode values violate specification (0, false, null, 0)' USING errcode = 'P0001';
    END IF;

    -- 6) PARITY COMPARISON: TEST_DEPOSIT MODE
    -- Initial create vs policy change
    IF v_policy_dep_v1.access_mode <> v_policy_free_v2.access_mode
       OR v_policy_dep_v1.deposit_amount_krw <> v_policy_free_v2.deposit_amount_krw
       OR v_policy_dep_v1.refund_eligible <> v_policy_free_v2.refund_eligible
       OR v_policy_dep_v1.receipt_window_hours IS DISTINCT FROM v_policy_free_v2.receipt_window_hours
       OR v_policy_dep_v1.min_purchase_krw <> v_policy_free_v2.min_purchase_krw THEN
      RAISE EXCEPTION 'G12 FAIL: test_deposit mode parity mismatch between create_merchant_restroom and create_merchant_restroom_policy' USING errcode = 'P0001';
    END IF;

    -- Strict expected values for test_deposit mode
    IF v_policy_dep_v1.deposit_amount_krw <> 1000
       OR v_policy_dep_v1.refund_eligible <> true
       OR v_policy_dep_v1.receipt_window_hours <> 24
       OR v_policy_dep_v1.min_purchase_krw <> 0 THEN
      RAISE EXCEPTION 'G12 FAIL: test_deposit default values violate specification (1000, true, 24, 0)' USING errcode = 'P0001';
    END IF;

    v_done := array_append(v_done, 'G12_RPC_DEFAULTS_PARITY');
    RAISE NOTICE '  ✓ G12: 100%% exact parity verified for free mode (0, false, null, 0) and test_deposit mode (1000, true, 24, 0).';

    -- Mark all subtransaction tests successfully executed
    v_all_done := true;

    -- Trigger intentional rollback
    RAISE EXCEPTION 'INTENTIONAL_FORCE_ROLLBACK_TASK_12' USING errcode = 'P0099';

  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE, v_caught_msg = MESSAGE_TEXT;
    IF v_caught_code <> 'P0099' OR NOT v_all_done THEN
      RAISE EXCEPTION 'Subtransaction failed unexpectedly: SQLSTATE=% MSG=%', v_caught_code, v_caught_msg;
    END IF;
  END;

  -- Reset user context to original verifier
  PERFORM set_config('role', v_orig_user, false);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);

  -- ============================================================================
  -- G13: Rollback Residue Check (All Tables Must Have 0 Test Rows)
  -- ============================================================================
  -- 1) auth.users
  SELECT count(*) INTO v_count FROM auth.users WHERE id = ANY(v_tracked_user_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G13 FAIL: auth.users residue %', v_count USING errcode = 'P0001'; END IF;

  -- 2) public.profiles
  SELECT count(*) INTO v_count FROM public.profiles WHERE id = ANY(v_tracked_user_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G13 FAIL: profiles residue %', v_count USING errcode = 'P0001'; END IF;

  -- 3) public.user_roles
  SELECT count(*) INTO v_count FROM public.user_roles WHERE user_id = ANY(v_tracked_user_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G13 FAIL: user_roles residue %', v_count USING errcode = 'P0001'; END IF;

  -- 4) public.businesses
  SELECT count(*) INTO v_count FROM public.businesses WHERE id = ANY(v_tracked_biz_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G13 FAIL: businesses residue %', v_count USING errcode = 'P0001'; END IF;

  -- 5) public.business_members
  SELECT count(*) INTO v_count FROM public.business_members
  WHERE business_id = ANY(v_tracked_biz_ids) OR user_id = ANY(v_tracked_user_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G13 FAIL: business_members residue %', v_count USING errcode = 'P0001'; END IF;

  -- 6) public.restrooms
  SELECT count(*) INTO v_count FROM public.restrooms WHERE id = ANY(v_tracked_restroom_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G13 FAIL: restrooms residue %', v_count USING errcode = 'P0001'; END IF;

  -- 7) public.restroom_access_policies
  SELECT count(*) INTO v_count FROM public.restroom_access_policies
  WHERE id = ANY(v_tracked_policy_ids) OR restroom_id = ANY(v_tracked_restroom_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G13 FAIL: restroom_access_policies residue %', v_count USING errcode = 'P0001'; END IF;

  v_done := array_append(v_done, 'G13_ROLLBACK_AND_RESIDUE_CHECK');
  RAISE NOTICE '  ✓ G13: Rollback verified. All 7 tables have 0 residue rows.';
  RAISE NOTICE 'TASK 12-C Merchant Restroom Operations Verification Completed Successfully (% groups).', array_length(v_done, 1);
END $$;
