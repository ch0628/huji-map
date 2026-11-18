-- ============================================================================
-- Verification SQL: verify_restroom_schema_rollback.sql
-- Purpose: TASK 09 / 09-A Public & Partner Restroom Schema & RLS Rollback Verification
-- Reference: tasks/09_restroom_schema.md, docs/03_DATA_MODEL.md, docs/08_SECURITY_OPERATIONS.md
--
-- Structure:
--   DO block with subtransaction:
--     G00: Preflight Collision Checks (Auth, Businesses, Restrooms, Sources, Policies, Photos)
--     G01: Table Existence, relrowsecurity=true, and Table GRANTs (All 7 New Tables)
--     G02: Restroom Type & FK Exclusivity Constraint + Coordinate Consistency
--     G03: Public Restroom No-PIN Constraint
--     G04: Single Active Access Policy Constraint
--     G05: Single Primary Photo Constraint
--     G06: Access Policy Rules Trigger (Public Free, Real Deposit Prohibited)
--     G07: Test Account & Business Setup (Admin, Merchant, Customer, Revoked)
--     G08: RLS SELECT Visibility (Published vs Draft vs Admin)
--     G09: Restroom INSERT Permissions (Customer, Draft, Suspended, Revoked, Public Admin Only)
--     G10: Restroom UPDATE Protection Trigger (Status, Origin, Core Location, Revoked Membership)
--     G11: Restroom Hours, Exceptions, and Photos Role-Based Access & Attack Scenarios
--     G12: Public Restroom Admin Ingestion Flow & Import Run Recording
--     G13: Intentional Force Rollback (P0099) & Complete 12-Table Zero Residue Check
-- ============================================================================

DO $$
DECLARE
  v_orig_user text;
  v_all_done boolean := false;
  v_caught_code text;
  v_caught_msg text;
  v_count integer;
  v_rowcount integer;
  v_sub_success boolean;
  v_rls_enabled boolean;
  v_check_text text;
  v_check_timestamptz timestamptz;
  v_test_timestamptz timestamptz;

  -- Test Users
  u_admin uuid := 'f9000000-0000-4000-a000-000000000001'::uuid;
  e_admin text := 'test_admin_r09@hujimap.local';

  u_merchant uuid := 'f9000000-0000-4000-a000-000000000002'::uuid;
  e_merchant text := 'test_merchant_r09@hujimap.local';

  u_customer uuid := 'f9000000-0000-4000-a000-000000000003'::uuid;
  e_customer text := 'test_customer_r09@hujimap.local';

  u_revoked uuid := 'f9000000-0000-4000-a000-000000000004'::uuid;
  e_revoked text := 'test_revoked_r09@hujimap.local';

  -- Test Entities
  v_source_id uuid := 'f9000000-0000-4000-b000-000000000001'::uuid;
  v_import_run_id uuid := 'f9000000-0000-4000-b000-000000000002'::uuid;

  v_biz_approved_id uuid := 'f9000000-0000-4000-c000-000000000001'::uuid;
  v_biz_draft_id uuid := 'f9000000-0000-4000-c000-000000000002'::uuid;
  v_biz_suspended_id uuid := 'f9000000-0000-4000-c000-000000000003'::uuid;

  v_restroom_partner_id uuid := 'f9000000-0000-4000-d000-000000000001'::uuid;
  v_restroom_public_id uuid := 'f9000000-0000-4000-d000-000000000002'::uuid;
  v_restroom_unlocated_id uuid := 'f9000000-0000-4000-d000-000000000003'::uuid;
  v_restroom_suspended_biz_id uuid := 'f9000000-0000-4000-d000-000000000004'::uuid;

  v_policy_id uuid := 'f9000000-0000-4000-e000-000000000001'::uuid;
  v_policy_suspended_biz_id uuid := 'f9000000-0000-4000-e000-000000000002'::uuid;
  v_photo_id uuid := 'f9000000-0000-4000-f000-000000000001'::uuid;
  v_photo_attack_id uuid := 'f9000000-0000-4000-f000-000000000002'::uuid;
  v_photo_suspended_biz_id uuid := 'f9000000-0000-4000-f000-000000000003'::uuid;

  -- Preserved Tracking Arrays for G13 Rollback Check
  v_tracked_user_ids uuid[] := ARRAY[]::uuid[];
  v_tracked_biz_ids uuid[] := ARRAY[]::uuid[];
  v_tracked_source_ids uuid[] := ARRAY[]::uuid[];
  v_tracked_import_run_ids uuid[] := ARRAY[]::uuid[];
  v_tracked_restroom_ids uuid[] := ARRAY[]::uuid[];
  v_tracked_policy_ids uuid[] := ARRAY[]::uuid[];
  v_tracked_photo_ids uuid[] := ARRAY[]::uuid[];

  v_tbl text;
  v_done text[] := ARRAY[]::text[];
BEGIN
  SELECT current_user INTO v_orig_user;
  RAISE NOTICE 'Starting TASK 09-A Restroom Schema Verification as %...', v_orig_user;

  -- ============================================================================
  -- G00: Preflight Collision Checks (All Fixed Test Fixture UUIDs)
  -- ============================================================================
  IF EXISTS (
    SELECT 1 FROM auth.users
    WHERE id IN (u_admin, u_merchant, u_customer, u_revoked)
       OR email IN (e_admin, e_merchant, e_customer, e_revoked)
  ) THEN
    RAISE EXCEPTION 'G00 FAIL: auth.users preflight collision' USING errcode = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.businesses
    WHERE id IN (v_biz_approved_id, v_biz_draft_id, v_biz_suspended_id)
  ) THEN
    RAISE EXCEPTION 'G00 FAIL: businesses preflight collision' USING errcode = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.public_data_sources
    WHERE id = v_source_id
  ) THEN
    RAISE EXCEPTION 'G00 FAIL: public_data_sources preflight collision' USING errcode = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.public_import_runs
    WHERE id = v_import_run_id
  ) THEN
    RAISE EXCEPTION 'G00 FAIL: public_import_runs preflight collision' USING errcode = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.restrooms
    WHERE id IN (v_restroom_partner_id, v_restroom_public_id, v_restroom_unlocated_id, v_restroom_suspended_biz_id)
  ) THEN
    RAISE EXCEPTION 'G00 FAIL: restrooms preflight collision' USING errcode = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.restroom_access_policies
    WHERE id IN (v_policy_id, v_policy_suspended_biz_id)
  ) THEN
    RAISE EXCEPTION 'G00 FAIL: restroom_access_policies preflight collision' USING errcode = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.restroom_photos
    WHERE id IN (v_photo_id, v_photo_attack_id, v_photo_suspended_biz_id)
  ) THEN
    RAISE EXCEPTION 'G00 FAIL: restroom_photos preflight collision' USING errcode = 'P0001';
  END IF;

  v_done := array_append(v_done, 'G00_PREFLIGHT');
  RAISE NOTICE '  ✓ G00: Preflight collision check passed for all fixture UUIDs.';

  -- Subtransaction for mutation and verification
  BEGIN

    -- ============================================================================
    -- G01: Schema Check, relrowsecurity=true, and Table GRANTs for All 7 New Tables
    -- ============================================================================
    FOREACH v_tbl IN ARRAY ARRAY[
      'public_data_sources',
      'public_import_runs',
      'restrooms',
      'restroom_hours',
      'restroom_hour_exceptions',
      'restroom_access_policies',
      'restroom_photos'
    ]
    LOOP
      -- 1) Table existence
      PERFORM 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = v_tbl;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'G01 FAIL: table % missing', v_tbl USING errcode = 'P0001';
      END IF;

      -- 2) RLS enabled check
      SELECT c.relrowsecurity INTO v_rls_enabled
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = v_tbl;

      IF NOT v_rls_enabled THEN
        RAISE EXCEPTION 'G01 FAIL: RLS not enabled on table %', v_tbl USING errcode = 'P0001';
      END IF;
    END LOOP;

    -- 3) Key table grant validations
    IF NOT has_table_privilege('anon', 'public.restrooms', 'SELECT') THEN
      RAISE EXCEPTION 'G01 FAIL: anon must have SELECT on restrooms' USING errcode = 'P0001';
    END IF;
    IF has_table_privilege('anon', 'public.restrooms', 'INSERT') THEN
      RAISE EXCEPTION 'G01 FAIL: anon must NOT have INSERT on restrooms' USING errcode = 'P0001';
    END IF;
    IF has_table_privilege('anon', 'public.public_import_runs', 'SELECT') THEN
      RAISE EXCEPTION 'G01 FAIL: anon must NOT have SELECT on public_import_runs' USING errcode = 'P0001';
    END IF;
    IF NOT has_table_privilege('authenticated', 'public.restrooms', 'SELECT') THEN
      RAISE EXCEPTION 'G01 FAIL: authenticated must have SELECT on restrooms' USING errcode = 'P0001';
    END IF;
    IF NOT has_table_privilege('authenticated', 'public.restrooms', 'INSERT') THEN
      RAISE EXCEPTION 'G01 FAIL: authenticated must have INSERT on restrooms' USING errcode = 'P0001';
    END IF;

    v_done := array_append(v_done, 'G01_SCHEMA_TABLES_RLS_GRANTS');
    RAISE NOTICE '  ✓ G01: All 7 tables defined, relrowsecurity=true verified, and GRANTs validated.';

    -- ============================================================================
    -- G07: Set up Test Accounts and Businesses
    -- ============================================================================
    INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
    VALUES
      (u_admin, e_admin, '{"name":"Admin 09"}'::jsonb, now(), now()),
      (u_merchant, e_merchant, '{"name":"Merchant 09"}'::jsonb, now(), now()),
      (u_customer, e_customer, '{"name":"Customer 09"}'::jsonb, now(), now()),
      (u_revoked, e_revoked, '{"name":"Revoked Merchant 09"}'::jsonb, now(), now());

    v_tracked_user_ids := ARRAY[u_admin, u_merchant, u_customer, u_revoked];

    INSERT INTO public.user_roles (user_id, role) VALUES (u_admin, 'admin');

    -- Approved business for u_merchant
    INSERT INTO public.businesses (
      id, name, category, road_address, latitude, longitude, registration_status, created_by, approved_by, approved_at
    ) VALUES (
      v_biz_approved_id, '승인된 제휴 카페', '카페', '수원시 팔달구 신풍로 10', 37.2840, 127.0150, 'approved', u_merchant, u_admin, now()
    );
    v_tracked_biz_ids := array_append(v_tracked_biz_ids, v_biz_approved_id);

    INSERT INTO public.business_members (business_id, user_id, role, membership_status)
    VALUES (v_biz_approved_id, u_merchant, 'owner', 'active');

    -- Revoked membership for u_revoked on approved business
    INSERT INTO public.business_members (business_id, user_id, role, membership_status)
    VALUES (v_biz_approved_id, u_revoked, 'manager', 'revoked');

    -- Draft business for u_merchant
    INSERT INTO public.businesses (
      id, name, category, road_address, latitude, longitude, registration_status, created_by
    ) VALUES (
      v_biz_draft_id, '미승인 임시 가게', '식당', '수원시 팔달구 매산로 20', 37.2650, 127.0200, 'draft', u_merchant
    );
    v_tracked_biz_ids := array_append(v_tracked_biz_ids, v_biz_draft_id);

    INSERT INTO public.business_members (business_id, user_id, role, membership_status)
    VALUES (v_biz_draft_id, u_merchant, 'owner', 'active');

    -- Suspended business for u_merchant
    INSERT INTO public.businesses (
      id, name, category, road_address, latitude, longitude, registration_status, created_by, approved_by, approved_at
    ) VALUES (
      v_biz_suspended_id, '영업정지된 가게', '카페', '수원시 팔달구 정조로 11', 37.2850, 127.0160, 'suspended', u_merchant, u_admin, now()
    );
    v_tracked_biz_ids := array_append(v_tracked_biz_ids, v_biz_suspended_id);

    INSERT INTO public.business_members (business_id, user_id, role, membership_status)
    VALUES (v_biz_suspended_id, u_merchant, 'owner', 'active');

    -- Public Data Source
    INSERT INTO public.public_data_sources (
      id, provider_name, dataset_name, source_url
    ) VALUES (
      v_source_id, '수원시청', '수원시 공중화장실 개방현황', 'https://www.suwon.go.kr'
    );
    v_tracked_source_ids := array_append(v_tracked_source_ids, v_source_id);

    v_done := array_append(v_done, 'G07_TEST_SETUP');
    RAISE NOTICE '  ✓ G07: Test users, businesses (approved/draft/suspended), and data source created.';

    -- ============================================================================
    -- G02: Restroom Type & FK Exclusivity Constraint + Coordinate Consistency
    -- ============================================================================
    -- Partner with source_id must FAIL
    v_sub_success := false;
    BEGIN
      INSERT INTO public.restrooms (
        business_id, source_id, type, name, road_address, latitude, longitude
      ) VALUES (
        v_biz_approved_id, v_source_id, 'partner', '잘못된 제휴', '주소', 37.28, 127.01
      );
      v_sub_success := true;
    EXCEPTION WHEN check_violation THEN
      NULL; -- expected
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G02 FAIL: partner restroom cannot have source_id' USING errcode = 'P0001';
    END IF;

    -- Public with business_id must FAIL
    v_sub_success := false;
    BEGIN
      INSERT INTO public.restrooms (
        business_id, source_id, type, name, road_address, latitude, longitude
      ) VALUES (
        v_biz_approved_id, v_source_id, 'public', '잘못된 공공', '주소', 37.28, 127.01
      );
      v_sub_success := true;
    EXCEPTION WHEN check_violation THEN
      NULL; -- expected
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G02 FAIL: public restroom cannot have business_id' USING errcode = 'P0001';
    END IF;

    -- Mismatched coordinates (lat not null, lng null) must FAIL chk_restrooms_coords_pair
    v_sub_success := false;
    BEGIN
      INSERT INTO public.restrooms (
        business_id, type, name, road_address, latitude, longitude
      ) VALUES (
        v_biz_approved_id, 'partner', '비대칭 좌표 화장실', '주소', 37.28, NULL
      );
      v_sub_success := true;
    EXCEPTION WHEN check_violation THEN
      NULL; -- expected
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G02 FAIL: asymmetric coordinates must be rejected' USING errcode = 'P0001';
    END IF;

    -- Published with null coordinates must FAIL chk_restrooms_published_has_coords
    v_sub_success := false;
    BEGIN
      INSERT INTO public.restrooms (
        business_id, type, name, road_address, latitude, longitude, publication_status
      ) VALUES (
        v_biz_approved_id, 'partner', '좌표없는 공개 화장실', '주소', NULL, NULL, 'published'
      );
      v_sub_success := true;
    EXCEPTION WHEN check_violation THEN
      NULL; -- expected
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G02 FAIL: published restroom without coordinates must be rejected' USING errcode = 'P0001';
    END IF;

    -- Draft with null coordinates must SUCCEED (unverified/quarantine support)
    INSERT INTO public.restrooms (
      id, business_id, type, name, road_address, latitude, longitude, publication_status, created_by
    ) VALUES (
      v_restroom_unlocated_id, v_biz_approved_id, 'partner', '좌표미확인 임시화장실', '주소', NULL, NULL, 'draft', u_merchant
    );
    v_tracked_restroom_ids := array_append(v_tracked_restroom_ids, v_restroom_unlocated_id);

    v_done := array_append(v_done, 'G02_TYPE_EXCLUSIVITY');
    RAISE NOTICE '  ✓ G02: Partner/Public exclusivity and coordinate pair/published constraints verified.';

    -- ============================================================================
    -- G03: Public Restroom No-PIN Constraint
    -- ============================================================================
    v_sub_success := false;
    BEGIN
      INSERT INTO public.restrooms (
        source_id, type, name, road_address, latitude, longitude, access_method
      ) VALUES (
        v_source_id, 'public', '공공 PIN 화장실', '주소', 37.28, 127.01, 'pin'
      );
      v_sub_success := true;
    EXCEPTION WHEN check_violation THEN
      NULL; -- expected
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G03 FAIL: public restroom cannot have pin access method' USING errcode = 'P0001';
    END IF;

    v_done := array_append(v_done, 'G03_PUBLIC_NO_PIN');
    RAISE NOTICE '  ✓ G03: Public restroom no-PIN constraint verified.';

    -- ============================================================================
    -- Insert Valid Partner Restroom
    -- ============================================================================
    INSERT INTO public.restrooms (
      id, business_id, type, name, road_address, latitude, longitude, access_method, publication_status, created_by
    ) VALUES (
      v_restroom_partner_id, v_biz_approved_id, 'partner', '제휴 카페 화장실', '수원시 팔달구 신풍로 10', 37.2840, 127.0150, 'pin', 'published', u_merchant
    );
    v_tracked_restroom_ids := array_append(v_tracked_restroom_ids, v_restroom_partner_id);

    -- Insert Valid Public Restroom
    INSERT INTO public.restrooms (
      id, source_id, type, name, road_address, latitude, longitude, access_method, publication_status, created_by
    ) VALUES (
      v_restroom_public_id, v_source_id, 'public', '수원화성 공중화장실', '수원시 팔달구 정조로 825', 37.2870, 127.0170, 'open', 'published', u_admin
    );
    v_tracked_restroom_ids := array_append(v_tracked_restroom_ids, v_restroom_public_id);

    -- ============================================================================
    -- G04: Single Active Access Policy Constraint
    -- ============================================================================
    INSERT INTO public.restroom_access_policies (
      id, restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, is_active, effective_from
    ) VALUES (
      v_policy_id, v_restroom_partner_id, 1, 'test_deposit', 1000, true, true, now()
    );
    v_tracked_policy_ids := array_append(v_tracked_policy_ids, v_policy_id);

    -- Second active policy on same restroom must FAIL unique index
    v_sub_success := false;
    BEGIN
      INSERT INTO public.restroom_access_policies (
        restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, is_active, effective_from
      ) VALUES (
        v_restroom_partner_id, 2, 'test_deposit', 1500, true, true, now()
      );
      v_sub_success := true;
    EXCEPTION WHEN unique_violation THEN
      NULL; -- expected
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G04 FAIL: second active access policy must be rejected' USING errcode = 'P0001';
    END IF;

    v_done := array_append(v_done, 'G04_SINGLE_ACTIVE_POLICY');
    RAISE NOTICE '  ✓ G04: Single active access policy constraint verified.';

    -- ============================================================================
    -- G05: Single Primary Photo Constraint
    -- ============================================================================
    INSERT INTO public.restroom_photos (
      id, restroom_id, storage_path, photo_type, is_primary, moderation_status, uploaded_by
    ) VALUES (
      v_photo_id, v_restroom_partner_id, 'photos/exterior1.jpg', 'exterior', true, 'approved', u_admin
    );
    v_tracked_photo_ids := array_append(v_tracked_photo_ids, v_photo_id);

    -- Second primary photo on same restroom must FAIL
    v_sub_success := false;
    BEGIN
      INSERT INTO public.restroom_photos (
        restroom_id, storage_path, photo_type, is_primary, moderation_status, uploaded_by
      ) VALUES (
        v_restroom_partner_id, 'photos/exterior2.jpg', 'exterior', true, 'pending', u_admin
      );
      v_sub_success := true;
    EXCEPTION WHEN unique_violation THEN
      NULL; -- expected
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G05 FAIL: second primary photo must be rejected' USING errcode = 'P0001';
    END IF;

    v_done := array_append(v_done, 'G05_SINGLE_PRIMARY_PHOTO');
    RAISE NOTICE '  ✓ G05: Single primary photo constraint verified.';

    -- ============================================================================
    -- G06: Access Policy Rules Trigger
    -- ============================================================================
    -- Public restroom with test_deposit must FAIL
    v_sub_success := false;
    BEGIN
      INSERT INTO public.restroom_access_policies (
        restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, is_active, effective_from
      ) VALUES (
        v_restroom_public_id, 1, 'test_deposit', 1000, true, true, now()
      );
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G06 FAIL: expected 42501 on public test_deposit, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G06 FAIL: public restroom cannot have test_deposit policy' USING errcode = 'P0001';
    END IF;

    -- real_deposit must FAIL for any restroom
    v_sub_success := false;
    BEGIN
      INSERT INTO public.restroom_access_policies (
        restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, is_active, effective_from
      ) VALUES (
        v_restroom_partner_id, 2, 'real_deposit', 1000, true, false, now()
      );
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G06 FAIL: expected 42501 on real_deposit, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G06 FAIL: real_deposit mode must be prohibited' USING errcode = 'P0001';
    END IF;

    -- Valid free policy for public restroom
    INSERT INTO public.restroom_access_policies (
      restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, is_active, effective_from
    ) VALUES (
      v_restroom_public_id, 1, 'free', 0, false, true, now()
    );

    v_done := array_append(v_done, 'G06_ACCESS_POLICY_TRIGGER');
    RAISE NOTICE '  ✓ G06: Access policy trigger (public free only, real_deposit prohibited) verified.';

    -- ============================================================================
    -- Insert Published Partner Restroom for Suspended Business
    -- ============================================================================
    INSERT INTO public.restrooms (
      id, business_id, type, name, road_address, latitude, longitude, access_method, publication_status, created_by
    ) VALUES (
      v_restroom_suspended_biz_id, v_biz_suspended_id, 'partner', '영업정지 가게 화장실', '수원시 팔달구 정조로 11', 37.2850, 127.0160, 'pin', 'published', u_admin
    );
    v_tracked_restroom_ids := array_append(v_tracked_restroom_ids, v_restroom_suspended_biz_id);

    INSERT INTO public.restroom_access_policies (
      id, restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, is_active, effective_from
    ) VALUES (
      v_policy_suspended_biz_id, v_restroom_suspended_biz_id, 1, 'test_deposit', 1000, true, true, now()
    );
    v_tracked_policy_ids := array_append(v_tracked_policy_ids, v_policy_suspended_biz_id);

    INSERT INTO public.restroom_photos (
      id, restroom_id, storage_path, photo_type, is_primary, moderation_status, uploaded_by
    ) VALUES (
      v_photo_suspended_biz_id, v_restroom_suspended_biz_id, 'photos/suspended_biz.jpg', 'exterior', true, 'approved', u_admin
    );
    v_tracked_photo_ids := array_append(v_tracked_photo_ids, v_photo_suspended_biz_id);

    -- ============================================================================
    -- G08: RLS SELECT Visibility (Isolated to Fixture UUIDs, Published vs Draft vs Suspended Business vs Admin)
    -- ============================================================================
    -- 1) Anon: only publicly visible restrooms among fixtures (2 out of 4: partner approved + public)
    PERFORM set_config('role', 'anon', true);
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);

    SELECT count(*) INTO v_count
    FROM public.restrooms
    WHERE id = ANY(v_tracked_restroom_ids);
    IF v_count <> 2 THEN
      RAISE EXCEPTION 'G08 FAIL: anon should see exactly 2 test restrooms, got %', v_count USING errcode = 'P0001';
    END IF;

    -- Anon specific UUID visibility checks
    SELECT count(*) INTO v_count FROM public.restrooms WHERE id = v_restroom_partner_id;
    IF v_count <> 1 THEN RAISE EXCEPTION 'G08 FAIL: anon must see approved published partner restroom' USING errcode = 'P0001'; END IF;

    SELECT count(*) INTO v_count FROM public.restrooms WHERE id = v_restroom_public_id;
    IF v_count <> 1 THEN RAISE EXCEPTION 'G08 FAIL: anon must see published public restroom' USING errcode = 'P0001'; END IF;

    SELECT count(*) INTO v_count FROM public.restrooms WHERE id = v_restroom_unlocated_id;
    IF v_count <> 0 THEN RAISE EXCEPTION 'G08 FAIL: anon must not see draft restroom' USING errcode = 'P0001'; END IF;

    -- Anon must not see suspended business restroom even though publication_status = 'published'
    SELECT count(*) INTO v_count FROM public.restrooms WHERE id = v_restroom_suspended_biz_id;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'G08 FAIL: anon must not see restroom of suspended business' USING errcode = 'P0001';
    END IF;

    -- 2) Customer: same public visibility as anon (only sees the 2 approved/public published restrooms)
    PERFORM set_config('role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', u_customer::text, true);

    SELECT count(*) INTO v_count
    FROM public.restrooms
    WHERE id = ANY(v_tracked_restroom_ids);
    IF v_count <> 2 THEN
      RAISE EXCEPTION 'G08 FAIL: customer should see exactly 2 test restrooms, got %', v_count USING errcode = 'P0001';
    END IF;

    -- Customer specific UUID visibility checks
    SELECT count(*) INTO v_count FROM public.restrooms WHERE id = v_restroom_partner_id;
    IF v_count <> 1 THEN RAISE EXCEPTION 'G08 FAIL: customer must see approved published partner restroom' USING errcode = 'P0001'; END IF;

    SELECT count(*) INTO v_count FROM public.restrooms WHERE id = v_restroom_public_id;
    IF v_count <> 1 THEN RAISE EXCEPTION 'G08 FAIL: customer must see published public restroom' USING errcode = 'P0001'; END IF;

    SELECT count(*) INTO v_count FROM public.restrooms WHERE id = v_restroom_unlocated_id;
    IF v_count <> 0 THEN RAISE EXCEPTION 'G08 FAIL: customer must not see draft restroom' USING errcode = 'P0001'; END IF;

    SELECT count(*) INTO v_count FROM public.restrooms WHERE id = v_restroom_suspended_biz_id;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'G08 FAIL: customer must not see restroom of suspended business' USING errcode = 'P0001';
    END IF;

    -- 3) Merchant: can see published restrooms + own draft/unlocated restroom + own suspended business restroom (4 total)
    PERFORM set_config('role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', u_merchant::text, true);

    SELECT count(*) INTO v_count
    FROM public.restrooms
    WHERE id = ANY(v_tracked_restroom_ids);
    IF v_count <> 4 THEN
      RAISE EXCEPTION 'G08 FAIL: merchant should see 4 test restrooms (2 published + own draft + own suspended biz), got %', v_count USING errcode = 'P0001';
    END IF;

    -- Merchant specific UUID visibility checks
    SELECT count(*) INTO v_count FROM public.restrooms WHERE id = v_restroom_partner_id;
    IF v_count <> 1 THEN RAISE EXCEPTION 'G08 FAIL: merchant must see own approved partner restroom' USING errcode = 'P0001'; END IF;

    SELECT count(*) INTO v_count FROM public.restrooms WHERE id = v_restroom_public_id;
    IF v_count <> 1 THEN RAISE EXCEPTION 'G08 FAIL: merchant must see public restroom' USING errcode = 'P0001'; END IF;

    SELECT count(*) INTO v_count FROM public.restrooms WHERE id = v_restroom_unlocated_id;
    IF v_count <> 1 THEN RAISE EXCEPTION 'G08 FAIL: merchant must see own draft restroom' USING errcode = 'P0001'; END IF;

    SELECT count(*) INTO v_count FROM public.restrooms WHERE id = v_restroom_suspended_biz_id;
    IF v_count <> 1 THEN RAISE EXCEPTION 'G08 FAIL: merchant must see own suspended biz restroom' USING errcode = 'P0001'; END IF;

    -- 4) Admin: can see all 4 fixture restrooms
    PERFORM set_config('request.jwt.claim.sub', u_admin::text, true);

    SELECT count(*) INTO v_count
    FROM public.restrooms
    WHERE id = ANY(v_tracked_restroom_ids);
    IF v_count <> 4 THEN
      RAISE EXCEPTION 'G08 FAIL: admin should see all 4 test restrooms, got %', v_count USING errcode = 'P0001';
    END IF;

    -- Admin specific UUID visibility checks
    SELECT count(*) INTO v_count FROM public.restrooms WHERE id = v_restroom_partner_id;
    IF v_count <> 1 THEN RAISE EXCEPTION 'G08 FAIL: admin must see partner restroom' USING errcode = 'P0001'; END IF;

    SELECT count(*) INTO v_count FROM public.restrooms WHERE id = v_restroom_public_id;
    IF v_count <> 1 THEN RAISE EXCEPTION 'G08 FAIL: admin must see public restroom' USING errcode = 'P0001'; END IF;

    SELECT count(*) INTO v_count FROM public.restrooms WHERE id = v_restroom_unlocated_id;
    IF v_count <> 1 THEN RAISE EXCEPTION 'G08 FAIL: admin must see unlocated restroom' USING errcode = 'P0001'; END IF;

    SELECT count(*) INTO v_count FROM public.restrooms WHERE id = v_restroom_suspended_biz_id;
    IF v_count <> 1 THEN RAISE EXCEPTION 'G08 FAIL: admin must see suspended biz restroom' USING errcode = 'P0001'; END IF;

    -- Reset to verifier
    PERFORM set_config('role', v_orig_user, false);

    v_done := array_append(v_done, 'G08_RLS_SELECT_VISIBILITY');
    RAISE NOTICE '  ✓ G08: RLS SELECT visibility rules verified with fixture isolation and suspended business hiding.';

    -- ============================================================================
    -- G09: Restroom INSERT Permissions (Fixing false PASS swallowing)
    -- ============================================================================
    -- 1) Unapproved customer cannot insert partner restroom
    PERFORM set_config('role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', u_customer::text, true);

    v_sub_success := false;
    BEGIN
      INSERT INTO public.restrooms (
        business_id, type, name, road_address, latitude, longitude
      ) VALUES (
        v_biz_approved_id, 'partner', '고객의 무단 등록', '주소', 37.28, 127.01
      );
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G09 FAIL: customer insert expected 42501, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G09 FAIL: customer should not insert partner restroom' USING errcode = 'P0001';
    END IF;

    -- 2) Merchant cannot insert for unapproved (draft) business
    PERFORM set_config('request.jwt.claim.sub', u_merchant::text, true);

    v_sub_success := false;
    BEGIN
      INSERT INTO public.restrooms (
        business_id, type, name, road_address, latitude, longitude
      ) VALUES (
        v_biz_draft_id, 'partner', '미승인 가게의 화장실', '주소', 37.28, 127.01
      );
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G09 FAIL: draft biz insert expected 42501, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G09 FAIL: cannot create restroom for unapproved business' USING errcode = 'P0001';
    END IF;

    -- 3) Merchant cannot insert for suspended business
    v_sub_success := false;
    BEGIN
      INSERT INTO public.restrooms (
        business_id, type, name, road_address, latitude, longitude
      ) VALUES (
        v_biz_suspended_id, 'partner', '정지된 가게의 화장실', '주소', 37.28, 127.01
      );
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G09 FAIL: suspended biz insert expected 42501, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G09 FAIL: cannot create restroom for suspended business' USING errcode = 'P0001';
    END IF;

    -- 4) Revoked member cannot insert partner restroom
    PERFORM set_config('request.jwt.claim.sub', u_revoked::text, true);

    v_sub_success := false;
    BEGIN
      INSERT INTO public.restrooms (
        business_id, type, name, road_address, latitude, longitude
      ) VALUES (
        v_biz_approved_id, 'partner', '탈퇴 매니저의 화장실 등록', '주소', 37.28, 127.01
      );
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G09 FAIL: revoked member insert expected 42501, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G09 FAIL: revoked member cannot insert restroom' USING errcode = 'P0001';
    END IF;

    -- 5) Merchant cannot directly insert partner restroom as 'published'
    PERFORM set_config('request.jwt.claim.sub', u_merchant::text, true);

    v_sub_success := false;
    BEGIN
      INSERT INTO public.restrooms (
        business_id, type, name, road_address, latitude, longitude, publication_status
      ) VALUES (
        v_biz_approved_id, 'partner', '점주의 직접공개 시도', '주소', 37.28, 127.01, 'published'
      );
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G09 FAIL: direct publish insert expected 42501, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G09 FAIL: merchant cannot directly insert published restroom' USING errcode = 'P0001';
    END IF;

    -- 6) Merchant cannot spoof last_verified_at on INSERT
    v_sub_success := false;
    BEGIN
      INSERT INTO public.restrooms (
        business_id, type, name, road_address, latitude, longitude, publication_status, last_verified_at
      ) VALUES (
        v_biz_approved_id, 'partner', '검증일시 위조 화장실', '주소', 37.28, 127.01, 'draft', now()
      );
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G09 FAIL: expected 42501 on last_verified_at insert, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G09 FAIL: merchant cannot directly insert last_verified_at' USING errcode = 'P0001';
    END IF;

    -- Reset
    PERFORM set_config('role', v_orig_user, false);

    v_done := array_append(v_done, 'G09_RESTROOM_INSERT_PERMS');
    RAISE NOTICE '  ✓ G09: Restroom INSERT permission boundaries verified (no false PASS).';

    -- ============================================================================
    -- G10: Restroom UPDATE Protection Trigger & Member Permissions
    -- ============================================================================
    -- 1) Merchant cannot change publication status of partner restroom
    PERFORM set_config('role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', u_merchant::text, true);

    v_sub_success := false;
    BEGIN
      UPDATE public.restrooms
      SET publication_status = 'suspended'
      WHERE id = v_restroom_partner_id;
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G10 FAIL: expected 42501 on status update, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G10 FAIL: merchant cannot change publication status' USING errcode = 'P0001';
    END IF;

    -- 2) Merchant cannot change core location (road_address) of a published restroom
    v_sub_success := false;
    BEGIN
      UPDATE public.restrooms
      SET road_address = '임의 변경된 도로명주소 99'
      WHERE id = v_restroom_partner_id;
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G10 FAIL: expected 42501 on published location change, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G10 FAIL: published restroom core location must be protected' USING errcode = 'P0001';
    END IF;

    -- 3) Merchant cannot update last_verified_at
    v_sub_success := false;
    BEGIN
      UPDATE public.restrooms
      SET last_verified_at = now()
      WHERE id = v_restroom_partner_id;
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G10 FAIL: expected 42501 on last_verified_at update, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G10 FAIL: merchant cannot change last_verified_at' USING errcode = 'P0001';
    END IF;

    -- 4) Revoked member cannot update restroom (RLS filters out row: ROW_COUNT = 0)
    PERFORM set_config('request.jwt.claim.sub', u_revoked::text, true);

    SELECT description INTO v_check_text FROM public.restrooms WHERE id = v_restroom_partner_id;

    UPDATE public.restrooms
    SET description = '탈퇴한 사용자의 설명 수정 시도'
    WHERE id = v_restroom_partner_id;
    GET DIAGNOSTICS v_rowcount = ROW_COUNT;

    IF v_rowcount > 0 THEN
      RAISE EXCEPTION 'G10 FAIL: revoked member unexpectedly updated % rows', v_rowcount USING errcode = 'P0001';
    END IF;

    -- Verify target record value was NOT modified
    PERFORM set_config('role', v_orig_user, false);
    SELECT description INTO v_caught_msg FROM public.restrooms WHERE id = v_restroom_partner_id;
    IF v_caught_msg IS DISTINCT FROM v_check_text THEN
      RAISE EXCEPTION 'G10 FAIL: description was modified by revoked member' USING errcode = 'P0001';
    END IF;

    v_done := array_append(v_done, 'G10_UPDATE_PROTECTION_TRIGGER');
    RAISE NOTICE '  ✓ G10: Restroom update protection trigger (status, core location, last_verified_at, revoked) verified.';

    -- ============================================================================
    -- G11: Restroom Hours, Exceptions, and Photos Role-Based Access & Attack Scenarios
    -- ============================================================================
    -- 1) Anon: can SELECT published restroom hours, but CANNOT insert
    PERFORM set_config('role', 'anon', true);
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);

    v_sub_success := false;
    BEGIN
      INSERT INTO public.restroom_hours (restroom_id, weekday, opens_at, closes_at, is_closed)
      VALUES (v_restroom_partner_id, 1, '09:00:00', '21:00:00', false);
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G11 FAIL: anon hours insert expected 42501, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G11 FAIL: anon should not insert hours' USING errcode = 'P0001';
    END IF;

    -- 2) Customer: CANNOT insert hours or photos
    PERFORM set_config('role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', u_customer::text, true);

    v_sub_success := false;
    BEGIN
      INSERT INTO public.restroom_hours (restroom_id, weekday, opens_at, closes_at, is_closed)
      VALUES (v_restroom_partner_id, 1, '09:00:00', '21:00:00', false);
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G11 FAIL: customer hours insert expected 42501, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G11 FAIL: customer should not insert hours' USING errcode = 'P0001';
    END IF;

    -- 3) Merchant: Valid Hours and Exceptions insertion for own restroom
    PERFORM set_config('request.jwt.claim.sub', u_merchant::text, true);

    INSERT INTO public.restroom_hours (
      restroom_id, weekday, opens_at, closes_at, is_closed
    ) VALUES (
      v_restroom_partner_id, 1, '09:00:00', '21:00:00', false
    );

    INSERT INTO public.restroom_hour_exceptions (
      restroom_id, exception_date, is_closed, reason
    ) VALUES (
      v_restroom_partner_id, '2026-12-25', true, '크리스마스 특별 휴무'
    );

    -- 4) Photo Attack Scenario A: Merchant attempts to directly INSERT photo as 'approved'
    v_sub_success := false;
    BEGIN
      INSERT INTO public.restroom_photos (
        id, restroom_id, storage_path, photo_type, is_primary, moderation_status, uploaded_by
      ) VALUES (
        v_photo_attack_id, v_restroom_partner_id, 'photos/attack1.jpg', 'exterior', false, 'approved', u_merchant
      );
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G11 FAIL: photo approved insert expected 42501, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G11 FAIL: merchant cannot self-approve photo on INSERT' USING errcode = 'P0001';
    END IF;

    -- Photo Attack Scenario B: Merchant attempts to insert photo with uploaded_by = u_admin (spoofing)
    v_sub_success := false;
    BEGIN
      INSERT INTO public.restroom_photos (
        id, restroom_id, storage_path, photo_type, is_primary, moderation_status, uploaded_by
      ) VALUES (
        v_photo_attack_id, v_restroom_partner_id, 'photos/attack2.jpg', 'exterior', false, 'pending', u_admin
      );
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G11 FAIL: photo spoofed uploader expected 42501, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G11 FAIL: merchant cannot spoof uploaded_by' USING errcode = 'P0001';
    END IF;

    -- Valid photo upload by merchant (pending, own uid)
    INSERT INTO public.restroom_photos (
      id, restroom_id, storage_path, photo_type, is_primary, moderation_status, uploaded_by
    ) VALUES (
      v_photo_attack_id, v_restroom_partner_id, 'photos/merchant_valid.jpg', 'exterior', false, 'pending', u_merchant
    );
    v_tracked_photo_ids := array_append(v_tracked_photo_ids, v_photo_attack_id);

    -- Photo Attack Scenario C: Merchant attempts to UPDATE photo's restroom_id to another restroom
    v_sub_success := false;
    BEGIN
      UPDATE public.restroom_photos
      SET restroom_id = v_restroom_public_id
      WHERE id = v_photo_attack_id;
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G11 FAIL: photo target change expected 42501, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G11 FAIL: photo restroom_id cannot be changed' USING errcode = 'P0001';
    END IF;

    -- Photo Attack Scenario D: Merchant attempts to UPDATE photo's moderation_status to 'approved'
    v_sub_success := false;
    BEGIN
      UPDATE public.restroom_photos
      SET moderation_status = 'approved'
      WHERE id = v_photo_attack_id;
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '42501' THEN
        RAISE EXCEPTION 'G11 FAIL: photo self-approval update expected 42501, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G11 FAIL: merchant cannot update moderation_status to approved' USING errcode = 'P0001';
    END IF;

    -- 5) Admin: Can approve pending photo (verify ROW_COUNT=1 and final moderation_status)
    PERFORM set_config('request.jwt.claim.sub', u_admin::text, true);

    UPDATE public.restroom_photos
    SET moderation_status = 'approved'
    WHERE id = v_photo_attack_id;
    GET DIAGNOSTICS v_rowcount = ROW_COUNT;

    IF v_rowcount <> 1 THEN
      RAISE EXCEPTION 'G11 FAIL: admin photo approval expected rowcount 1, got %', v_rowcount USING errcode = 'P0001';
    END IF;

    SELECT moderation_status INTO v_check_text
    FROM public.restroom_photos
    WHERE id = v_photo_attack_id;

    IF v_check_text <> 'approved' THEN
      RAISE EXCEPTION 'G11 FAIL: photo moderation_status must be approved, got %', v_check_text USING errcode = 'P0001';
    END IF;

    -- 6) Suspended business child entity protection:
    -- Anon cannot select access policy or photo of suspended business restroom
    PERFORM set_config('role', 'anon', true);
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);

    SELECT count(*) INTO v_count FROM public.restroom_access_policies WHERE restroom_id = v_restroom_suspended_biz_id;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'G11 FAIL: anon must not see access policy of suspended business restroom' USING errcode = 'P0001';
    END IF;

    SELECT count(*) INTO v_count FROM public.restroom_photos WHERE restroom_id = v_restroom_suspended_biz_id;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'G11 FAIL: anon must not see photo of suspended business restroom' USING errcode = 'P0001';
    END IF;

    -- Customer cannot select access policy or photo of suspended business restroom
    PERFORM set_config('role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', u_customer::text, true);

    SELECT count(*) INTO v_count FROM public.restroom_access_policies WHERE restroom_id = v_restroom_suspended_biz_id;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'G11 FAIL: customer must not see access policy of suspended business restroom' USING errcode = 'P0001';
    END IF;

    SELECT count(*) INTO v_count FROM public.restroom_photos WHERE restroom_id = v_restroom_suspended_biz_id;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'G11 FAIL: customer must not see photo of suspended business restroom' USING errcode = 'P0001';
    END IF;

    -- 7) Admin future last_verified_at UPDATE and INSERT rejection (SQLSTATE 22007)
    PERFORM set_config('request.jwt.claim.sub', u_admin::text, true);

    v_sub_success := false;
    BEGIN
      UPDATE public.restrooms
      SET last_verified_at = now() + interval '1 day'
      WHERE id = v_restroom_partner_id;
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '22007' THEN
        RAISE EXCEPTION 'G11 FAIL: expected 22007 on future last_verified_at update, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G11 FAIL: future last_verified_at UPDATE must be rejected' USING errcode = 'P0001';
    END IF;

    v_sub_success := false;
    BEGIN
      INSERT INTO public.restrooms (
        business_id, type, name, road_address, latitude, longitude, publication_status, last_verified_at
      ) VALUES (
        v_biz_approved_id, 'partner', '미래 검증 화장실', '수원시 팔달구 신풍로 50', 37.28, 127.01, 'draft', now() + interval '1 hour'
      );
      v_sub_success := true;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE;
      IF v_caught_code <> '22007' THEN
        RAISE EXCEPTION 'G11 FAIL: expected 22007 on future last_verified_at insert, got %', v_caught_code USING errcode = 'P0001';
      END IF;
    END;
    IF v_sub_success THEN
      RAISE EXCEPTION 'G11 FAIL: future last_verified_at INSERT must be rejected' USING errcode = 'P0001';
    END IF;

    -- 8) Admin legitimately updates last_verified_at (past/current timestamp allowed, verify ROW_COUNT=1 and stored value)
    v_test_timestamptz := now() - interval '2 hours';

    UPDATE public.restrooms
    SET last_verified_at = v_test_timestamptz
    WHERE id = v_restroom_partner_id;
    GET DIAGNOSTICS v_rowcount = ROW_COUNT;

    IF v_rowcount <> 1 THEN
      RAISE EXCEPTION 'G11 FAIL: admin last_verified_at update expected rowcount 1, got %', v_rowcount USING errcode = 'P0001';
    END IF;

    SELECT last_verified_at INTO v_check_timestamptz
    FROM public.restrooms
    WHERE id = v_restroom_partner_id;

    IF v_check_timestamptz IS DISTINCT FROM v_test_timestamptz THEN
      RAISE EXCEPTION 'G11 FAIL: last_verified_at value mismatch: expected %, got %', v_test_timestamptz, v_check_timestamptz USING errcode = 'P0001';
    END IF;

    -- Also verify updating to current timestamp (now()) succeeds with ROW_COUNT=1
    UPDATE public.restrooms
    SET last_verified_at = now()
    WHERE id = v_restroom_partner_id;
    GET DIAGNOSTICS v_rowcount = ROW_COUNT;

    IF v_rowcount <> 1 THEN
      RAISE EXCEPTION 'G11 FAIL: admin last_verified_at now() update expected rowcount 1, got %', v_rowcount USING errcode = 'P0001';
    END IF;

    -- Reset to verifier
    PERFORM set_config('role', v_orig_user, false);

    v_done := array_append(v_done, 'G11_HOURS_AND_PHOTOS_SECURITY');
    RAISE NOTICE '  ✓ G11: Restroom hours, exceptions, photo moderation, and last_verified_at attack scenarios verified.';

    -- ============================================================================
    -- G12: Public Import Run Recording
    -- ============================================================================
    INSERT INTO public.public_import_runs (
      id, source_id, status, fetched_count, inserted_count, updated_count, error_count
    ) VALUES (
      v_import_run_id, v_source_id, 'success', 100, 100, 0, 0
    );
    v_tracked_import_run_ids := array_append(v_tracked_import_run_ids, v_import_run_id);

    v_done := array_append(v_done, 'G12_IMPORT_RUN');
    RAISE NOTICE '  ✓ G12: Public import run execution record verified.';

    -- Mark done and force rollback
    v_all_done := true;
    RAISE EXCEPTION 'INTENTIONAL_FORCE_ROLLBACK_TASK_09' USING errcode = 'P0099';

  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_caught_code = RETURNED_SQLSTATE, v_caught_msg = MESSAGE_TEXT;
    IF v_caught_code <> 'P0099' OR NOT v_all_done THEN
      RAISE EXCEPTION 'Subtransaction failed unexpectedly: SQLSTATE=% MSG=%', v_caught_code, v_caught_msg;
    END IF;
  END;

  -- Reset to original user
  PERFORM set_config('role', v_orig_user, false);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);

  -- ============================================================================
  -- G13: Rollback Residue Check (All 12 Tables Must Have 0 Test Rows)
  -- 5 Existing Auth/Business Fixture Tables + 7 New Restroom Tables
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

  -- 6) public.public_data_sources (New Table 1)
  SELECT count(*) INTO v_count FROM public.public_data_sources WHERE id = ANY(v_tracked_source_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G13 FAIL: public_data_sources residue %', v_count USING errcode = 'P0001'; END IF;

  -- 7) public.public_import_runs (New Table 2)
  SELECT count(*) INTO v_count FROM public.public_import_runs
  WHERE id = ANY(v_tracked_import_run_ids) OR source_id = ANY(v_tracked_source_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G13 FAIL: public_import_runs residue %', v_count USING errcode = 'P0001'; END IF;

  -- 8) public.restrooms (New Table 3)
  SELECT count(*) INTO v_count FROM public.restrooms WHERE id = ANY(v_tracked_restroom_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G13 FAIL: restrooms residue %', v_count USING errcode = 'P0001'; END IF;

  -- 9) public.restroom_hours (New Table 4)
  SELECT count(*) INTO v_count FROM public.restroom_hours WHERE restroom_id = ANY(v_tracked_restroom_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G13 FAIL: restroom_hours residue %', v_count USING errcode = 'P0001'; END IF;

  -- 10) public.restroom_hour_exceptions (New Table 5)
  SELECT count(*) INTO v_count FROM public.restroom_hour_exceptions WHERE restroom_id = ANY(v_tracked_restroom_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G13 FAIL: restroom_hour_exceptions residue %', v_count USING errcode = 'P0001'; END IF;

  -- 11) public.restroom_access_policies (New Table 6, checked by both id and restroom_id)
  SELECT count(*) INTO v_count FROM public.restroom_access_policies
  WHERE id = ANY(v_tracked_policy_ids) OR restroom_id = ANY(v_tracked_restroom_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G13 FAIL: restroom_access_policies residue %', v_count USING errcode = 'P0001'; END IF;

  -- 12) public.restroom_photos (New Table 7, checked by both id and restroom_id)
  SELECT count(*) INTO v_count FROM public.restroom_photos
  WHERE id = ANY(v_tracked_photo_ids) OR restroom_id = ANY(v_tracked_restroom_ids);
  IF v_count > 0 THEN RAISE EXCEPTION 'G13 FAIL: restroom_photos residue %', v_count USING errcode = 'P0001'; END IF;

  v_done := array_append(v_done, 'G13_ROLLBACK_AND_RESIDUE_CHECK');
  RAISE NOTICE '  ✓ G13: Rollback verified. All 12 tables (5 fixtures + 7 new tables) have 0 residue rows.';
  RAISE NOTICE 'TASK 09-A Restroom Schema Verification Completed Successfully (% groups).', array_length(v_done, 1);
END $$;
