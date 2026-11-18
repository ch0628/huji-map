-- ============================================================================
-- VERIFICATION SCRIPT: verify_restroom_admin_review_rollback.sql
-- Purpose: Complete PostgreSQL verification of TASK 14 Admin Review RPCs
--          G00: Preflight Collision Checks (9 tables, isolated fa140000-... space)
--          G01: Migration Record Verification (20261112000000 in schema_migrations)
--          G02: RPC Existence, Signatures, SECURITY DEFINER & safe search_path
--          G03: EXECUTE Permissions Check (anon/public revoked, authenticated/service_role granted)
--          G04: Test Fixtures Setup (auth.users, profiles, roles, businesses, restrooms, policies, photo)
--          G05: Non-Admin Role-Based Access Control Rejection (42501)
--          G06: NULL and Empty Input Validation (22023)
--          G07: Strict State Machine Transition Rules (HM001 & HM002)
--          G08: Required Fields (HM005), Independent Partner Business Gating (HM007), Reason Len (HM006)
--          G09: Normal Transitions, Exact 2-Character Reasons, and Atomic Audit Logs
--          G10: Photo Moderation and Atomic Audit Logs
--          G11: Intentional Force Rollback (P0099) & Complete Zero Residue Check (9 tables)
-- Reference: tasks/14_restroom_admin_review.md, docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/11_DECISIONS.md
-- ============================================================================

DO $$
DECLARE
  v_orig_user text;
  v_all_done boolean := false;
  v_caught_code text;
  v_caught_msg text;
  v_count integer;
  v_func_oid oid;
  v_args text;
  v_rettype text;
  v_prosecdef boolean;
  v_proconfig text[];
  v_audit_count integer;
  v_res public.restrooms;
  v_photo_res public.restroom_photos;

  -- Test Users (Isolated UUID space: fa140000-...)
  u_admin uuid := 'fa140000-0000-4000-a000-000000000001'::uuid;
  e_admin text := 'test_admin_t14@hujimap.local';

  u_merchant uuid := 'fa140000-0000-4000-a000-000000000002'::uuid;
  e_merchant text := 'test_merchant_t14@hujimap.local';

  u_customer uuid := 'fa140000-0000-4000-a000-000000000003'::uuid;
  e_customer text := 'test_customer_t14@hujimap.local';

  -- Test Businesses
  v_approved_biz_id uuid := 'fa140000-0000-4000-b000-000000000001'::uuid;
  v_draft_biz_id uuid := 'fa140000-0000-4000-b000-000000000002'::uuid;

  -- Test Restrooms
  v_pending_restroom_id uuid := 'fa140000-0000-4000-c000-000000000001'::uuid;
  v_draft_restroom_id uuid := 'fa140000-0000-4000-c000-000000000002'::uuid;
  v_published_restroom_id uuid := 'fa140000-0000-4000-c000-000000000003'::uuid;
  v_suspended_restroom_id uuid := 'fa140000-0000-4000-c000-000000000004'::uuid;
  v_archived_restroom_id uuid := 'fa140000-0000-4000-c000-000000000005'::uuid;
  v_incomplete_restroom_id uuid := 'fa140000-0000-4000-c000-000000000006'::uuid;
  v_unapproved_biz_restroom_id uuid := 'fa140000-0000-4000-c000-000000000007'::uuid;

  -- Test Photos
  v_photo_id uuid := 'fa140000-0000-4000-d000-000000000001'::uuid;

  -- Tracking Arrays for Preflight & Residue Checks
  v_tracked_user_ids uuid[] := ARRAY[u_admin, u_merchant, u_customer];
  v_tracked_user_emails text[] := ARRAY[e_admin, e_merchant, e_customer];
  v_tracked_biz_ids uuid[] := ARRAY[v_approved_biz_id, v_draft_biz_id];
  v_tracked_restroom_ids uuid[] := ARRAY[
    v_pending_restroom_id, v_draft_restroom_id, v_published_restroom_id,
    v_suspended_restroom_id, v_archived_restroom_id, v_incomplete_restroom_id,
    v_unapproved_biz_restroom_id
  ];
  v_tracked_photo_ids uuid[] := ARRAY[v_photo_id];

  v_done text[] := ARRAY[]::text[];
BEGIN
  SELECT current_user INTO v_orig_user;
  RAISE NOTICE 'Starting TASK 14-C Admin Restroom Review Verification as %...', v_orig_user;

  -- ============================================================================
  -- G00: Preflight Collision Checks (All Fixed Test Fixture UUIDs and Emails)
  -- ============================================================================
  -- 1) auth.users
  SELECT count(*) INTO v_count FROM auth.users
  WHERE id = ANY(v_tracked_user_ids) OR email = ANY(v_tracked_user_emails);
  IF v_count > 0 THEN RAISE EXCEPTION 'G00 FAIL: auth.users preflight collision: % rows exist', v_count USING errcode = 'P0001'; END IF;

  -- 2) public.profiles
  SELECT count(*) INTO v_count FROM public.profiles WHERE id = ANY(v_tracked_user_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G00 FAIL: public.profiles preflight collision: % rows exist', v_count USING errcode = 'P0001'; END IF;

  -- 3) public.user_roles
  SELECT count(*) INTO v_count FROM public.user_roles WHERE user_id = ANY(v_tracked_user_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G00 FAIL: public.user_roles preflight collision: % rows exist', v_count USING errcode = 'P0001'; END IF;

  -- 4) public.businesses
  SELECT count(*) INTO v_count FROM public.businesses WHERE id = ANY(v_tracked_biz_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G00 FAIL: public.businesses preflight collision: % rows exist', v_count USING errcode = 'P0001'; END IF;

  -- 5) public.business_members
  SELECT count(*) INTO v_count FROM public.business_members
  WHERE business_id = ANY(v_tracked_biz_ids) OR user_id = ANY(v_tracked_user_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G00 FAIL: public.business_members preflight collision: % rows exist', v_count USING errcode = 'P0001'; END IF;

  -- 6) public.restrooms
  SELECT count(*) INTO v_count FROM public.restrooms WHERE id = ANY(v_tracked_restroom_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G00 FAIL: public.restrooms preflight collision: % rows exist', v_count USING errcode = 'P0001'; END IF;

  -- 7) public.restroom_access_policies
  SELECT count(*) INTO v_count FROM public.restroom_access_policies WHERE restroom_id = ANY(v_tracked_restroom_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G00 FAIL: public.restroom_access_policies preflight collision: % rows exist', v_count USING errcode = 'P0001'; END IF;

  -- 8) public.restroom_photos
  SELECT count(*) INTO v_count FROM public.restroom_photos
  WHERE id = ANY(v_tracked_photo_ids) OR restroom_id = ANY(v_tracked_restroom_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G00 FAIL: public.restroom_photos preflight collision: % rows exist', v_count USING errcode = 'P0001'; END IF;

  -- 9) public.audit_logs
  SELECT count(*) INTO v_count FROM public.audit_logs
  WHERE actor_user_id = ANY(v_tracked_user_ids)
     OR (entity_type = 'restrooms' AND entity_id = ANY(v_tracked_restroom_ids))
     OR (entity_type = 'restroom_photos' AND entity_id = ANY(v_tracked_photo_ids));
  IF v_count > 0 THEN RAISE EXCEPTION 'G00 FAIL: public.audit_logs preflight collision: % rows exist', v_count USING errcode = 'P0001'; END IF;

  v_done := array_append(v_done, 'G00_PREFLIGHT_COLLISION_CHECK');
  RAISE NOTICE '  ✓ G00: Preflight collision check passed (9 tables verified clean).';

  -- ============================================================================
  -- G01: Migration Record Verification (20261112000000 in schema_migrations)
  -- ============================================================================
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'supabase_migrations' AND table_name = 'schema_migrations'
  ) THEN
    RAISE EXCEPTION 'G01 FAIL: supabase_migrations.schema_migrations table does not exist' USING errcode = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
    WHERE version = '20261112000000'
  ) THEN
    RAISE EXCEPTION 'G01 FAIL: Migration 20261112000000 not recorded in schema_migrations' USING errcode = 'P0001';
  END IF;

  v_done := array_append(v_done, 'G01_MIGRATION_RECORD');
  RAISE NOTICE '  ✓ G01: Migration 20261112000000 recorded in schema_migrations.';

  -- ============================================================================
  -- G02: RPC Existence, Signatures, SECURITY DEFINER & safe search_path
  -- ============================================================================
  -- 1) decide_restroom_review
  SELECT p.oid, pg_get_function_arguments(p.oid), pg_get_function_result(p.oid), p.prosecdef, p.proconfig
  INTO v_func_oid, v_args, v_rettype, v_prosecdef, v_proconfig
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'decide_restroom_review';

  IF v_func_oid IS NULL THEN
    RAISE EXCEPTION 'G02 FAIL: decide_restroom_review RPC does not exist' USING errcode = 'P0001';
  END IF;

  IF NOT v_prosecdef THEN
    RAISE EXCEPTION 'G02 FAIL: decide_restroom_review must be SECURITY DEFINER' USING errcode = 'P0001';
  END IF;

  IF v_rettype NOT IN ('restrooms', 'public.restrooms') THEN
    RAISE EXCEPTION 'G02 FAIL: decide_restroom_review return type mismatch: %', v_rettype USING errcode = 'P0001';
  END IF;

  IF v_proconfig IS NULL OR NOT ('search_path=public, pg_temp' = ANY(v_proconfig)) THEN
    RAISE EXCEPTION 'G02 FAIL: decide_restroom_review search_path must be public, pg_temp' USING errcode = 'P0001';
  END IF;

  -- 2) moderate_restroom_photo
  SELECT p.oid, pg_get_function_arguments(p.oid), pg_get_function_result(p.oid), p.prosecdef, p.proconfig
  INTO v_func_oid, v_args, v_rettype, v_prosecdef, v_proconfig
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'moderate_restroom_photo';

  IF v_func_oid IS NULL THEN
    RAISE EXCEPTION 'G02 FAIL: moderate_restroom_photo RPC does not exist' USING errcode = 'P0001';
  END IF;

  IF NOT v_prosecdef THEN
    RAISE EXCEPTION 'G02 FAIL: moderate_restroom_photo must be SECURITY DEFINER' USING errcode = 'P0001';
  END IF;

  IF v_rettype NOT IN ('restroom_photos', 'public.restroom_photos') THEN
    RAISE EXCEPTION 'G02 FAIL: moderate_restroom_photo return type mismatch: %', v_rettype USING errcode = 'P0001';
  END IF;

  IF v_proconfig IS NULL OR NOT ('search_path=public, pg_temp' = ANY(v_proconfig)) THEN
    RAISE EXCEPTION 'G02 FAIL: moderate_restroom_photo search_path must be public, pg_temp' USING errcode = 'P0001';
  END IF;

  v_done := array_append(v_done, 'G02_RPC_DEFINITIONS_AND_SIGNATURES');
  RAISE NOTICE '  ✓ G02: Both admin review RPCs verified (SECURITY DEFINER, public.pg_temp search_path).';

  -- ============================================================================
  -- G03: EXECUTE Permissions Check (anon/public revoked, authenticated/service_role granted)
  -- ============================================================================
  -- decide_restroom_review
  SELECT p.oid INTO v_func_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'decide_restroom_review';

  IF has_function_privilege('anon', v_func_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'G03 FAIL: anon must NOT have execute on decide_restroom_review' USING errcode = 'P0001';
  END IF;
  IF has_function_privilege('public', v_func_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'G03 FAIL: public must NOT have execute on decide_restroom_review' USING errcode = 'P0001';
  END IF;
  IF NOT has_function_privilege('authenticated', v_func_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'G03 FAIL: authenticated must have execute on decide_restroom_review' USING errcode = 'P0001';
  END IF;
  IF NOT has_function_privilege('service_role', v_func_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'G03 FAIL: service_role must have execute on decide_restroom_review' USING errcode = 'P0001';
  END IF;

  -- moderate_restroom_photo
  SELECT p.oid INTO v_func_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'moderate_restroom_photo';

  IF has_function_privilege('anon', v_func_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'G03 FAIL: anon must NOT have execute on moderate_restroom_photo' USING errcode = 'P0001';
  END IF;
  IF has_function_privilege('public', v_func_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'G03 FAIL: public must NOT have execute on moderate_restroom_photo' USING errcode = 'P0001';
  END IF;
  IF NOT has_function_privilege('authenticated', v_func_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'G03 FAIL: authenticated must have execute on moderate_restroom_photo' USING errcode = 'P0001';
  END IF;
  IF NOT has_function_privilege('service_role', v_func_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'G03 FAIL: service_role must have execute on moderate_restroom_photo' USING errcode = 'P0001';
  END IF;

  v_done := array_append(v_done, 'G03_RPC_EXECUTE_PERMISSIONS');
  RAISE NOTICE '  ✓ G03: Function execute permissions verified (anon/public revoked, authenticated/service_role granted).';

  -- ============================================================================
  -- SUBTRANSACTION WRAPPER (G04 ~ G10) WITH P0099 FORCE ROLLBACK
  -- ============================================================================
  BEGIN
    -- ==========================================================================
    -- G04: SETUP TEST FIXTURES
    -- ==========================================================================
    -- Insert auth.users (trigger handle_new_user automatically creates profiles and user_roles customer)
    INSERT INTO auth.users (id, email) VALUES
      (u_admin, e_admin),
      (u_merchant, e_merchant),
      (u_customer, e_customer);

    -- Elevate u_admin and u_merchant roles
    INSERT INTO public.user_roles (user_id, role) VALUES
      (u_admin, 'admin'),
      (u_merchant, 'merchant');

    -- Businesses: 1 approved, 1 draft
    INSERT INTO public.businesses (
      id, name, category, road_address, latitude, longitude, registration_status, approved_by, approved_at, created_by
    ) VALUES
      (v_approved_biz_id, '승인된 제휴점', '카페', '수원시 팔달구 매산로 1', 37.2636, 127.0286, 'approved', u_admin, now(), u_merchant),
      (v_draft_biz_id, '미승인 신청점', '식당', '수원시 팔달구 매산로 2', 37.2637, 127.0287, 'draft', null, null, u_merchant);

    INSERT INTO public.business_members (business_id, user_id, role, membership_status) VALUES
      (v_approved_biz_id, u_merchant, 'owner', 'active'),
      (v_draft_biz_id, u_merchant, 'owner', 'active');

    -- Restrooms:
    -- 1) pending restroom (complete with coordinates, approved business, test_deposit policy)
    INSERT INTO public.restrooms (
      id, business_id, type, name, road_address, latitude, longitude, publication_status, created_by
    ) VALUES (
      v_pending_restroom_id, v_approved_biz_id, 'partner', '심사대기 화장실', '수원시 팔달구 매산로 1', 37.2636, 127.0286, 'pending', u_merchant
    );
    INSERT INTO public.restroom_access_policies (restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, is_active, effective_from, created_by)
    VALUES (v_pending_restroom_id, 1, 'test_deposit', 1000, true, true, now(), u_merchant);

    -- 2) draft restroom
    INSERT INTO public.restrooms (
      id, business_id, type, name, road_address, latitude, longitude, publication_status, created_by
    ) VALUES (
      v_draft_restroom_id, v_approved_biz_id, 'partner', '임시저장 화장실', '수원시 팔달구 매산로 1', 37.2636, 127.0286, 'draft', u_merchant
    );
    INSERT INTO public.restroom_access_policies (restroom_id, version, access_mode, is_active, effective_from, created_by)
    VALUES (v_draft_restroom_id, 1, 'free', true, now(), u_merchant);

    -- 3) published restroom
    INSERT INTO public.restrooms (
      id, business_id, type, name, road_address, latitude, longitude, publication_status, approved_by, last_verified_at, created_by
    ) VALUES (
      v_published_restroom_id, v_approved_biz_id, 'partner', '공개 화장실', '수원시 팔달구 매산로 1', 37.2636, 127.0286, 'published', u_admin, now(), u_merchant
    );
    INSERT INTO public.restroom_access_policies (restroom_id, version, access_mode, is_active, effective_from, created_by)
    VALUES (v_published_restroom_id, 1, 'free', true, now(), u_merchant);

    -- 4) suspended restroom
    INSERT INTO public.restrooms (
      id, business_id, type, name, road_address, latitude, longitude, publication_status, created_by
    ) VALUES (
      v_suspended_restroom_id, v_approved_biz_id, 'partner', '중단 화장실', '수원시 팔달구 매산로 1', 37.2636, 127.0286, 'suspended', u_merchant
    );
    INSERT INTO public.restroom_access_policies (restroom_id, version, access_mode, is_active, effective_from, created_by)
    VALUES (v_suspended_restroom_id, 1, 'free', true, now(), u_merchant);

    -- 5) archived restroom
    INSERT INTO public.restrooms (
      id, business_id, type, name, road_address, latitude, longitude, publication_status, created_by
    ) VALUES (
      v_archived_restroom_id, v_approved_biz_id, 'partner', '폐쇄 화장실', '수원시 팔달구 매산로 1', 37.2636, 127.0286, 'archived', u_merchant
    );

    -- 6) incomplete restroom (missing coordinates, approved business) -> for HM005 test
    INSERT INTO public.restrooms (
      id, business_id, type, name, road_address, latitude, longitude, publication_status, created_by
    ) VALUES (
      v_incomplete_restroom_id, v_approved_biz_id, 'partner', '좌표누락 화장실', '수원시 팔달구 매산로 1', null, null, 'pending', u_merchant
    );
    INSERT INTO public.restroom_access_policies (restroom_id, version, access_mode, is_active, effective_from, created_by)
    VALUES (v_incomplete_restroom_id, 1, 'free', true, now(), u_merchant);

    -- 7) unapproved business restroom -> for independent HM007 check
    -- (Valid name, road_address, valid coords, active policy, but business is draft)
    INSERT INTO public.restrooms (
      id, business_id, type, name, road_address, latitude, longitude, publication_status, created_by
    ) VALUES (
      v_unapproved_biz_restroom_id, v_draft_biz_id, 'partner', '미승인가게 화장실', '수원시 팔달구 매산로 2', 37.2637, 127.0287, 'pending', u_merchant
    );
    INSERT INTO public.restroom_access_policies (restroom_id, version, access_mode, is_active, effective_from, created_by)
    VALUES (v_unapproved_biz_restroom_id, 1, 'free', true, now(), u_merchant);

    -- 8) test photo
    INSERT INTO public.restroom_photos (id, restroom_id, storage_path, moderation_status, uploaded_by)
    VALUES (v_photo_id, v_pending_restroom_id, 'restrooms/test/photo.jpg', 'pending', u_merchant);

    v_done := array_append(v_done, 'G04_TEST_FIXTURES_SETUP');
    RAISE NOTICE '  ✓ G04: Test fixtures set up successfully without conflicts.';

    -- ==========================================================================
    -- G05: NON-ADMIN ROLE-BASED ACCESS CONTROL (42501)
    -- ==========================================================================
    -- 1) Act as merchant
    PERFORM set_config('request.jwt.claim.sub', u_merchant::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

    BEGIN
      PERFORM public.decide_restroom_review(v_pending_restroom_id, 'publish');
      RAISE EXCEPTION 'FAILED: merchant was able to call decide_restroom_review';
    EXCEPTION WHEN SQLSTATE '42501' THEN
      -- Expected PASS
    END;

    BEGIN
      PERFORM public.moderate_restroom_photo(v_photo_id, 'approved');
      RAISE EXCEPTION 'FAILED: merchant was able to call moderate_restroom_photo';
    EXCEPTION WHEN SQLSTATE '42501' THEN
      -- Expected PASS
    END;

    -- 2) Act as customer
    PERFORM set_config('request.jwt.claim.sub', u_customer::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

    BEGIN
      PERFORM public.decide_restroom_review(v_pending_restroom_id, 'publish');
      RAISE EXCEPTION 'FAILED: customer was able to call decide_restroom_review';
    EXCEPTION WHEN SQLSTATE '42501' THEN
      -- Expected PASS
    END;

    BEGIN
      PERFORM public.moderate_restroom_photo(v_photo_id, 'approved');
      RAISE EXCEPTION 'FAILED: customer was able to call moderate_restroom_photo';
    EXCEPTION WHEN SQLSTATE '42501' THEN
      -- Expected PASS
    END;

    -- 3) Act as anonymous (NULL uid)
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'anon', true);

    BEGIN
      PERFORM public.decide_restroom_review(v_pending_restroom_id, 'publish');
      RAISE EXCEPTION 'FAILED: anon was able to call decide_restroom_review';
    EXCEPTION WHEN SQLSTATE '28000' OR SQLSTATE '42501' THEN
      -- Expected PASS
    END;

    v_done := array_append(v_done, 'G05_RBAC_ENFORCEMENT');
    RAISE NOTICE '  ✓ G05: RBAC enforcement verified (merchant/customer/anon blocked with 42501/28000).';

    -- ==========================================================================
    -- G06: NULL AND EMPTY INPUT VALIDATION (22023)
    -- ==========================================================================
    -- Switch to administrator
    PERFORM set_config('request.jwt.claim.sub', u_admin::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

    -- 1) decide_restroom_review with NULL decision
    BEGIN
      PERFORM public.decide_restroom_review(v_pending_restroom_id, null);
      RAISE EXCEPTION 'FAILED: decide_restroom_review accepted NULL decision';
    EXCEPTION WHEN SQLSTATE '22023' THEN
      -- Expected PASS
    END;

    -- 2) decide_restroom_review with empty decision string
    BEGIN
      PERFORM public.decide_restroom_review(v_pending_restroom_id, '   ');
      RAISE EXCEPTION 'FAILED: decide_restroom_review accepted empty decision';
    EXCEPTION WHEN SQLSTATE '22023' THEN
      -- Expected PASS
    END;

    -- 3) decide_restroom_review with invalid decision string
    BEGIN
      PERFORM public.decide_restroom_review(v_pending_restroom_id, 'delete');
      RAISE EXCEPTION 'FAILED: decide_restroom_review accepted invalid decision';
    EXCEPTION WHEN SQLSTATE '22023' THEN
      -- Expected PASS
    END;

    -- 4) moderate_restroom_photo with NULL status
    BEGIN
      PERFORM public.moderate_restroom_photo(v_photo_id, null);
      RAISE EXCEPTION 'FAILED: moderate_restroom_photo accepted NULL status';
    EXCEPTION WHEN SQLSTATE '22023' THEN
      -- Expected PASS
    END;

    -- 5) moderate_restroom_photo with empty status
    BEGIN
      PERFORM public.moderate_restroom_photo(v_photo_id, '');
      RAISE EXCEPTION 'FAILED: moderate_restroom_photo accepted empty status';
    EXCEPTION WHEN SQLSTATE '22023' THEN
      -- Expected PASS
    END;

    -- 6) moderate_restroom_photo with invalid status
    BEGIN
      PERFORM public.moderate_restroom_photo(v_photo_id, 'unknown');
      RAISE EXCEPTION 'FAILED: moderate_restroom_photo accepted invalid status';
    EXCEPTION WHEN SQLSTATE '22023' THEN
      -- Expected PASS
    END;

    v_done := array_append(v_done, 'G06_INPUT_VALIDATION_22023');
    RAISE NOTICE '  ✓ G06: NULL, whitespace, and invalid inputs strictly rejected with 22023.';

    -- ==========================================================================
    -- G07: STRICT STATE MACHINE TRANSITIONS (HM001 & HM002)
    -- ==========================================================================
    -- 1) draft -> publish (Bypass review submission) -> HM001
    BEGIN
      PERFORM public.decide_restroom_review(v_draft_restroom_id, 'publish');
      RAISE EXCEPTION 'FAILED: draft restroom was published directly';
    EXCEPTION WHEN SQLSTATE 'HM001' THEN
      -- Expected PASS
    END;

    -- 2) archived -> publish (Decommissioned facility) -> HM001
    BEGIN
      PERFORM public.decide_restroom_review(v_archived_restroom_id, 'publish');
      RAISE EXCEPTION 'FAILED: archived restroom was published';
    EXCEPTION WHEN SQLSTATE 'HM001' THEN
      -- Expected PASS
    END;

    -- 3) published -> reject (Inappropriate reject on published facility) -> HM001
    BEGIN
      PERFORM public.decide_restroom_review(v_published_restroom_id, 'reject', '부적절한 반려');
      RAISE EXCEPTION 'FAILED: published restroom was rejected';
    EXCEPTION WHEN SQLSTATE 'HM001' THEN
      -- Expected PASS
    END;

    -- 4) draft -> reject -> HM001
    BEGIN
      PERFORM public.decide_restroom_review(v_draft_restroom_id, 'reject', '사유');
      RAISE EXCEPTION 'FAILED: draft restroom was rejected';
    EXCEPTION WHEN SQLSTATE 'HM001' THEN
      -- Expected PASS
    END;

    -- 5) suspended -> reject -> HM001
    BEGIN
      PERFORM public.decide_restroom_review(v_suspended_restroom_id, 'reject', '사유');
      RAISE EXCEPTION 'FAILED: suspended restroom was rejected';
    EXCEPTION WHEN SQLSTATE 'HM001' THEN
      -- Expected PASS
    END;

    -- 6) pending -> suspend (Unpublished restroom cannot be suspended) -> HM001
    BEGIN
      PERFORM public.decide_restroom_review(v_pending_restroom_id, 'suspend', '사유');
      RAISE EXCEPTION 'FAILED: pending restroom was suspended';
    EXCEPTION WHEN SQLSTATE 'HM001' THEN
      -- Expected PASS
    END;

    -- 7) draft -> suspend -> HM001
    BEGIN
      PERFORM public.decide_restroom_review(v_draft_restroom_id, 'suspend', '사유');
      RAISE EXCEPTION 'FAILED: draft restroom was suspended';
    EXCEPTION WHEN SQLSTATE 'HM001' THEN
      -- Expected PASS
    END;

    -- 8) archived -> suspend -> HM001
    BEGIN
      PERFORM public.decide_restroom_review(v_archived_restroom_id, 'suspend', '사유');
      RAISE EXCEPTION 'FAILED: archived restroom was suspended';
    EXCEPTION WHEN SQLSTATE 'HM001' THEN
      -- Expected PASS
    END;

    -- 9) published -> publish (Duplicate) -> HM002
    BEGIN
      PERFORM public.decide_restroom_review(v_published_restroom_id, 'publish');
      RAISE EXCEPTION 'FAILED: published restroom was duplicate-published';
    EXCEPTION WHEN SQLSTATE 'HM002' THEN
      -- Expected PASS
    END;

    -- 10) suspended -> suspend (Duplicate) -> HM002
    BEGIN
      PERFORM public.decide_restroom_review(v_suspended_restroom_id, 'suspend', '사유');
      RAISE EXCEPTION 'FAILED: suspended restroom was duplicate-suspended';
    EXCEPTION WHEN SQLSTATE 'HM002' THEN
      -- Expected PASS
    END;

    v_done := array_append(v_done, 'G07_STATE_MACHINE_TRANSITIONS');
    RAISE NOTICE '  ✓ G07: Strict state machine transitions enforced (invalid HM001, duplicate HM002).';

    -- ==========================================================================
    -- G08: REQUIRED FIELDS (HM005), INDEPENDENT PARTNER BIZ GATING (HM007), REASON (HM006)
    -- ==========================================================================
    -- 1) Missing coords -> HM005
    BEGIN
      PERFORM public.decide_restroom_review(v_incomplete_restroom_id, 'publish');
      RAISE EXCEPTION 'FAILED: incomplete restroom with null coords was published';
    EXCEPTION WHEN SQLSTATE 'HM005' THEN
      -- Expected PASS
    END;

    -- 2) Independent partner business approval check -> HM007
    -- (Name, address, coords, and active policy are ALL valid, only business is unapproved)
    BEGIN
      PERFORM public.decide_restroom_review(v_unapproved_biz_restroom_id, 'publish');
      RAISE EXCEPTION 'FAILED: restroom of unapproved business was published';
    EXCEPTION WHEN SQLSTATE 'HM007' THEN
      -- Expected PASS
    END;

    -- 3) Reject reason validation (NULL, empty, whitespace, 1-char, 1-char-after-trim must fail HM006)
    BEGIN
      PERFORM public.decide_restroom_review(v_incomplete_restroom_id, 'reject', null);
      RAISE EXCEPTION 'FAILED: reject accepted null reason';
    EXCEPTION WHEN SQLSTATE 'HM006' THEN
      -- Expected PASS
    END;

    BEGIN
      PERFORM public.decide_restroom_review(v_incomplete_restroom_id, 'reject', '');
      RAISE EXCEPTION 'FAILED: reject accepted empty reason';
    EXCEPTION WHEN SQLSTATE 'HM006' THEN
      -- Expected PASS
    END;

    BEGIN
      PERFORM public.decide_restroom_review(v_incomplete_restroom_id, 'reject', '   ');
      RAISE EXCEPTION 'FAILED: reject accepted whitespace reason';
    EXCEPTION WHEN SQLSTATE 'HM006' THEN
      -- Expected PASS
    END;

    BEGIN
      PERFORM public.decide_restroom_review(v_incomplete_restroom_id, 'reject', '반');
      RAISE EXCEPTION 'FAILED: reject accepted 1-char reason';
    EXCEPTION WHEN SQLSTATE 'HM006' THEN
      -- Expected PASS
    END;

    BEGIN
      PERFORM public.decide_restroom_review(v_incomplete_restroom_id, 'reject', ' 반 ');
      RAISE EXCEPTION 'FAILED: reject accepted 1-char-after-trim reason';
    EXCEPTION WHEN SQLSTATE 'HM006' THEN
      -- Expected PASS
    END;

    -- 4) Suspend reason validation (NULL, empty, whitespace, 1-char, 1-char-after-trim must fail HM006)
    BEGIN
      PERFORM public.decide_restroom_review(v_published_restroom_id, 'suspend', null);
      RAISE EXCEPTION 'FAILED: suspend accepted null reason';
    EXCEPTION WHEN SQLSTATE 'HM006' THEN
      -- Expected PASS
    END;

    BEGIN
      PERFORM public.decide_restroom_review(v_published_restroom_id, 'suspend', '');
      RAISE EXCEPTION 'FAILED: suspend accepted empty reason';
    EXCEPTION WHEN SQLSTATE 'HM006' THEN
      -- Expected PASS
    END;

    BEGIN
      PERFORM public.decide_restroom_review(v_published_restroom_id, 'suspend', '   ');
      RAISE EXCEPTION 'FAILED: suspend accepted whitespace reason';
    EXCEPTION WHEN SQLSTATE 'HM006' THEN
      -- Expected PASS
    END;

    BEGIN
      PERFORM public.decide_restroom_review(v_published_restroom_id, 'suspend', '휴');
      RAISE EXCEPTION 'FAILED: suspend accepted 1-char reason';
    EXCEPTION WHEN SQLSTATE 'HM006' THEN
      -- Expected PASS
    END;

    BEGIN
      PERFORM public.decide_restroom_review(v_published_restroom_id, 'suspend', ' 휴 ');
      RAISE EXCEPTION 'FAILED: suspend accepted 1-char-after-trim reason';
    EXCEPTION WHEN SQLSTATE 'HM006' THEN
      -- Expected PASS
    END;

    v_done := array_append(v_done, 'G08_REQUIRED_FIELDS_HM005_HM007_HM006');
    RAISE NOTICE '  ✓ G08: Incomplete coords (HM005), independent unapproved business (HM007), and reason length (HM006) verified.';

    -- ==========================================================================
    -- G09: NORMAL TRANSITIONS, EXACT 2-CHARACTER REASONS, AND ATOMIC AUDIT LOGS
    -- ==========================================================================
    -- 1) pending -> publish: 정상 심사 승인
    v_res := public.decide_restroom_review(
      v_pending_restroom_id, 'publish', null, '시설 완비 확인'
    );
    IF v_res.publication_status <> 'published' OR v_res.approved_by <> u_admin OR v_res.last_verified_at IS NULL THEN
      RAISE EXCEPTION 'FAILED: pending -> publish failed to set attributes correctly';
    END IF;

    SELECT count(*) INTO v_audit_count
    FROM public.audit_logs
    WHERE entity_type = 'restrooms' AND entity_id = v_pending_restroom_id AND action = 'restroom_published';
    IF v_audit_count <> 1 THEN
      RAISE EXCEPTION 'FAILED: audit_log was not created for publish';
    END IF;

    -- 2) published -> suspend: 정상 공개 중단 (정확히 2글자 사유 '공사' 허용 검증)
    v_res := public.decide_restroom_review(
      v_pending_restroom_id, 'suspend', '공사'
    );
    IF v_res.publication_status <> 'suspended' THEN
      RAISE EXCEPTION 'FAILED: published -> suspend failed';
    END IF;

    SELECT count(*) INTO v_audit_count
    FROM public.audit_logs
    WHERE entity_type = 'restrooms' AND entity_id = v_pending_restroom_id AND action = 'restroom_suspended' AND reason = '공사';
    IF v_audit_count <> 1 THEN
      RAISE EXCEPTION 'FAILED: audit_log was not created for suspend with 2-char reason';
    END IF;

    -- 3) suspended -> publish: 정상 재공개
    v_res := public.decide_restroom_review(
      v_pending_restroom_id, 'publish', null, '수리 완료 후 재공개'
    );
    IF v_res.publication_status <> 'published' THEN
      RAISE EXCEPTION 'FAILED: suspended -> publish (re-publish) failed';
    END IF;

    -- 4) pending -> reject: 정상 심사 반려 (정확히 2글자 사유 '반려' 허용 검증)
    v_res := public.decide_restroom_review(
      v_incomplete_restroom_id, 'reject', '반려'
    );
    IF v_res.publication_status <> 'draft' OR v_res.approved_by IS NOT NULL THEN
      RAISE EXCEPTION 'FAILED: pending -> reject failed to set draft and clear approved_by';
    END IF;

    SELECT count(*) INTO v_audit_count
    FROM public.audit_logs
    WHERE entity_type = 'restrooms' AND entity_id = v_incomplete_restroom_id AND action = 'restroom_rejected' AND reason = '반려';
    IF v_audit_count <> 1 THEN
      RAISE EXCEPTION 'FAILED: audit_log was not created for reject with 2-char reason';
    END IF;

    v_done := array_append(v_done, 'G09_NORMAL_TRANSITIONS_AND_AUDIT_LOGS');
    RAISE NOTICE '  ✓ G09: Normal publish, suspend (2-char reason), re-publish, reject (2-char reason) and atomic audit logs verified.';

    -- ==========================================================================
    -- G10: PHOTO MODERATION & ATOMIC AUDIT LOGS
    -- ==========================================================================
    v_photo_res := public.moderate_restroom_photo(v_photo_id, 'approved', '간판 및 출입구 명확 확인');
    IF v_photo_res.moderation_status <> 'approved' THEN
      RAISE EXCEPTION 'FAILED: moderate_restroom_photo failed to set approved';
    END IF;

    SELECT count(*) INTO v_audit_count
    FROM public.audit_logs
    WHERE entity_type = 'restroom_photos' AND entity_id = v_photo_id AND action = 'photo_approved';
    IF v_audit_count <> 1 THEN
      RAISE EXCEPTION 'FAILED: audit_log was not created for moderate_restroom_photo';
    END IF;

    v_done := array_append(v_done, 'G10_PHOTO_MODERATION_AND_AUDIT_LOGS');
    RAISE NOTICE '  ✓ G10: Photo moderation and atomic audit logs verified.';

    -- Mark all subtransaction tests successfully executed
    v_all_done := true;

    -- Trigger intentional rollback
    RAISE EXCEPTION 'INTENTIONAL_FORCE_ROLLBACK_TASK_14' USING errcode = 'P0099';

  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE, v_caught_msg = MESSAGE_TEXT;
    IF v_caught_code <> 'P0099' OR NOT v_all_done THEN
      RAISE EXCEPTION 'Subtransaction failed unexpectedly: SQLSTATE=% MSG=%', v_caught_code, v_caught_msg;
    END IF;
  END;

  -- Reset user context to original verifier
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);

  -- ============================================================================
  -- G11: ROLLBACK RESIDUE CHECK (9 TABLES MUST HAVE 0 TEST ROWS)
  -- ============================================================================
  -- 1) auth.users
  SELECT count(*) INTO v_count FROM auth.users
  WHERE id = ANY(v_tracked_user_ids) OR email = ANY(v_tracked_user_emails);
  IF v_count > 0 THEN RAISE EXCEPTION 'G11 FAIL: auth.users residue %', v_count USING errcode = 'P0001'; END IF;

  -- 2) public.profiles
  SELECT count(*) INTO v_count FROM public.profiles WHERE id = ANY(v_tracked_user_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G11 FAIL: public.profiles residue %', v_count USING errcode = 'P0001'; END IF;

  -- 3) public.user_roles
  SELECT count(*) INTO v_count FROM public.user_roles WHERE user_id = ANY(v_tracked_user_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G11 FAIL: public.user_roles residue %', v_count USING errcode = 'P0001'; END IF;

  -- 4) public.businesses
  SELECT count(*) INTO v_count FROM public.businesses WHERE id = ANY(v_tracked_biz_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G11 FAIL: public.businesses residue %', v_count USING errcode = 'P0001'; END IF;

  -- 5) public.business_members
  SELECT count(*) INTO v_count FROM public.business_members
  WHERE business_id = ANY(v_tracked_biz_ids) OR user_id = ANY(v_tracked_user_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G11 FAIL: public.business_members residue %', v_count USING errcode = 'P0001'; END IF;

  -- 6) public.restrooms
  SELECT count(*) INTO v_count FROM public.restrooms WHERE id = ANY(v_tracked_restroom_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G11 FAIL: public.restrooms residue %', v_count USING errcode = 'P0001'; END IF;

  -- 7) public.restroom_access_policies
  SELECT count(*) INTO v_count FROM public.restroom_access_policies WHERE restroom_id = ANY(v_tracked_restroom_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G11 FAIL: public.restroom_access_policies residue %', v_count USING errcode = 'P0001'; END IF;

  -- 8) public.restroom_photos
  SELECT count(*) INTO v_count FROM public.restroom_photos
  WHERE id = ANY(v_tracked_photo_ids) OR restroom_id = ANY(v_tracked_restroom_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G11 FAIL: public.restroom_photos residue %', v_count USING errcode = 'P0001'; END IF;

  -- 9) public.audit_logs
  SELECT count(*) INTO v_count FROM public.audit_logs
  WHERE actor_user_id = ANY(v_tracked_user_ids)
     OR (entity_type = 'restrooms' AND entity_id = ANY(v_tracked_restroom_ids))
     OR (entity_type = 'restroom_photos' AND entity_id = ANY(v_tracked_photo_ids));
  IF v_count > 0 THEN RAISE EXCEPTION 'G11 FAIL: public.audit_logs residue %', v_count USING errcode = 'P0001'; END IF;

  v_done := array_append(v_done, 'G11_ROLLBACK_AND_RESIDUE_CHECK');
  RAISE NOTICE '  ✓ G11: Rollback verified. All 9 tables have 0 residue rows.';
  RAISE NOTICE 'TASK 14-C Admin Restroom Review Verification Completed Successfully (% groups).', array_length(v_done, 1);
END $$;
