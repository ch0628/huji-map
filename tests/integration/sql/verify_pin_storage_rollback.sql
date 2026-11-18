-- ==============================================================================
-- Verification SQL: verify_pin_storage_rollback.sql
-- Description: TASK 23 - 도어락 PIN 보안 저장, 교체, RLS 및 롤백 검증
-- Spec: docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/07_PAYMENT_ACCESS_REFUND.md,
--       docs/08_SECURITY_OPERATIONS.md, docs/11_DECISIONS.md, tasks/23_pin_storage.md
-- Verification Groups:
--   G00: 충돌 사전 점검 (fa230000- 접두사 사전 잔류 레코드 부재 확인)
--   G01: 테이블, 인덱스, 트리거, RPC 스키마 검증
--   G02: 실행 권한 검증 (anon, authenticated 직접 접근 차단 T19, service_role 허용)
--   G03: 테스트 픽스처 설정 (점주 A/B, 일반고객, 정지회원, 관리자, 제휴/공공 화장실)
--   G04: 최초 PIN 등록 성공 검증 (T07: code_version = 1, status = active, valid_from 설정)
--   G05: 감사로그 비밀값 비노출 검증 (T17: 평문, 암호문, IV, 태그, 키 비포함)
--   G06: PIN 교체 및 버전 관리 검증 (T08, T10: 기존 rotated 처리, 새 버전 2 생성)
--   G07: DB 차원 제약조건 검증 (T09: 활성 PIN 최대 1개, 버전 중복 불가, 체크 제약)
--   G08: 인가 음성 테스트 (T11 타인 점포 차단, T12 고객/비인증 차단, T13 미승인/공공/정지 차단)
--   G09: 트랜잭션 원자성 및 오류 시 롤백 검증 (T16)
--   G10: P0099 의도적 서브트랜잭션 롤백 실행
--   G11: 롤백 후 잔류 데이터 0건 무결성 검증
-- ==============================================================================

DO $$
DECLARE
  v_test_prefix text := 'fa230000-';
  v_merchant_a uuid := 'fa230000-0000-0000-0000-000000000001'::uuid;
  v_merchant_b uuid := 'fa230000-0000-0000-0000-000000000002'::uuid;
  v_customer uuid := 'fa230000-0000-0000-0000-000000000003'::uuid;
  v_suspended_merchant uuid := 'fa230000-0000-0000-0000-000000000004'::uuid;
  v_admin uuid := 'fa230000-0000-0000-0000-000000000005'::uuid;
  v_manager_a uuid := 'fa230000-0000-0000-0000-000000000006'::uuid;
  v_revoked_merchant uuid := 'fa230000-0000-0000-0000-000000000007'::uuid;

  v_biz_a_approved uuid := 'fa230000-0000-0000-0000-000000000010'::uuid;
  v_biz_b_approved uuid := 'fa230000-0000-0000-0000-000000000011'::uuid;
  v_biz_unapproved uuid := 'fa230000-0000-0000-0000-000000000012'::uuid;

  v_restroom_a1_partner uuid := 'fa230000-0000-0000-0000-000000000020'::uuid;
  v_restroom_b1_partner uuid := 'fa230000-0000-0000-0000-000000000021'::uuid;
  v_restroom_unapproved uuid := 'fa230000-0000-0000-0000-000000000022'::uuid;

  v_public_source uuid := 'fa230000-0000-0000-0000-000000000030'::uuid;
  v_public_restroom uuid := 'fa230000-0000-0000-0000-000000000040'::uuid;

  v_count integer;
  v_res jsonb;
  v_secret_1_id uuid;
  v_secret_2_id uuid;
  v_caught boolean;
  v_audit_record record;
  v_secret_record record;
  v_prosecdef boolean;
  v_proconfig text[];
  v_trg_prosecdef boolean;
  v_trg_proconfig text[];
  v_tgenabled "char";
BEGIN
  RAISE NOTICE '>>> Starting TASK 23 Doorlock PIN Storage & Rotation Verification';

  -- ============================================================================
  -- G00: 사전 충돌 점검
  -- ============================================================================
  SELECT count(*) INTO v_count
  FROM public.restroom_lock_secrets
  WHERE id::text LIKE v_test_prefix || '%' OR restroom_id::text LIKE v_test_prefix || '%';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G00 Failed: Pre-existing restroom_lock_secrets found' USING ERRCODE = '23505';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.audit_logs
  WHERE entity_id::text LIKE v_test_prefix || '%';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G00 Failed: Pre-existing audit_logs found' USING ERRCODE = '23505';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.restrooms
  WHERE id::text LIKE v_test_prefix || '%';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G00 Failed: Pre-existing restrooms found' USING ERRCODE = '23505';
  END IF;

  RAISE NOTICE '✓ G00 Passed: No pre-existing test records';

  -- ============================================================================
  -- G01: 테이블, 인덱스, 트리거, RPC 스키마 검증
  -- ============================================================================
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'restroom_lock_secrets'
  ) THEN
    RAISE EXCEPTION 'G01 Failed: public.restroom_lock_secrets table does not exist';
  END IF;

  -- Verify unique partial index: idx_restroom_lock_secrets_single_active
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'restroom_lock_secrets'
      AND indexname = 'idx_restroom_lock_secrets_single_active'
  ) THEN
    RAISE EXCEPTION 'G01 Failed: idx_restroom_lock_secrets_single_active index does not exist';
  END IF;

  -- Verify unique index: idx_restroom_lock_secrets_restroom_code_version
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'restroom_lock_secrets'
      AND indexname = 'idx_restroom_lock_secrets_restroom_code_version'
  ) THEN
    RAISE EXCEPTION 'G01 Failed: idx_restroom_lock_secrets_restroom_code_version index does not exist';
  END IF;

  -- Verify unique partial index: idx_restroom_lock_secrets_idempotency_key
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'restroom_lock_secrets'
      AND indexname = 'idx_restroom_lock_secrets_idempotency_key'
  ) THEN
    RAISE EXCEPTION 'G01 Failed: idx_restroom_lock_secrets_idempotency_key index does not exist';
  END IF;

  -- Verify check constraint: chk_restroom_lock_secrets_idempotency_hmac
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_restroom_lock_secrets_idempotency_hmac'
  ) THEN
    RAISE EXCEPTION 'G01 Failed: chk_restroom_lock_secrets_idempotency_hmac constraint does not exist';
  END IF;

  -- Verify RPC: rotate_restroom_pin existence, SECURITY DEFINER, search_path = pg_catalog, pg_temp
  SELECT p.prosecdef, p.proconfig
  INTO v_prosecdef, v_proconfig
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' AND p.proname = 'rotate_restroom_pin';

  IF v_prosecdef IS NULL THEN
    RAISE EXCEPTION 'G01 Failed: public.rotate_restroom_pin RPC does not exist';
  END IF;

  IF NOT v_prosecdef THEN
    RAISE EXCEPTION 'G01 Failed: public.rotate_restroom_pin must be SECURITY DEFINER';
  END IF;

  IF v_proconfig IS NULL OR NOT ('search_path=pg_catalog, pg_temp' = ANY(v_proconfig)) THEN
    RAISE EXCEPTION 'G01 Failed: public.rotate_restroom_pin search_path must be pg_catalog, pg_temp (found: %)', v_proconfig;
  END IF;

  -- Verify trigger function: enforce_restroom_lock_secrets_rules existence, SECURITY DEFINER, search_path = pg_catalog, pg_temp
  SELECT p.prosecdef, p.proconfig
  INTO v_trg_prosecdef, v_trg_proconfig
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' AND p.proname = 'enforce_restroom_lock_secrets_rules';

  IF v_trg_prosecdef IS NULL THEN
    RAISE EXCEPTION 'G01 Failed: public.enforce_restroom_lock_secrets_rules function does not exist';
  END IF;

  IF NOT v_trg_prosecdef THEN
    RAISE EXCEPTION 'G01 Failed: public.enforce_restroom_lock_secrets_rules must be SECURITY DEFINER';
  END IF;

  IF v_trg_proconfig IS NULL OR NOT ('search_path=pg_catalog, pg_temp' = ANY(v_trg_proconfig)) THEN
    RAISE EXCEPTION 'G01 Failed: public.enforce_restroom_lock_secrets_rules search_path must be pg_catalog, pg_temp (found: %)', v_trg_proconfig;
  END IF;

  -- Verify integrity trigger: existence and active/enabled status on public.restroom_lock_secrets
  SELECT t.tgenabled
  INTO v_tgenabled
  FROM pg_trigger t
  WHERE t.tgname = 'trg_enforce_restroom_lock_secrets_rules'
    AND t.tgrelid = 'public.restroom_lock_secrets'::regclass
    AND NOT t.tgisinternal;

  IF v_tgenabled IS NULL THEN
    RAISE EXCEPTION 'G01 Failed: Trigger trg_enforce_restroom_lock_secrets_rules does not exist';
  END IF;

  IF v_tgenabled <> 'O' THEN
    RAISE EXCEPTION 'G01 Failed: Trigger trg_enforce_restroom_lock_secrets_rules is not enabled (status: %)', v_tgenabled;
  END IF;

  RAISE NOTICE '✓ G01 Passed: Schema, indexes, trigger (active), and RPC (SECURITY DEFINER, pg_catalog, pg_temp) exist';

  -- ============================================================================
  -- G02: 실행 권한 검증 (T19: anon/authenticated 차단, service_role 허용)
  -- ============================================================================
  IF has_table_privilege('anon', 'public.restroom_lock_secrets', 'SELECT') OR
     has_table_privilege('anon', 'public.restroom_lock_secrets', 'INSERT') OR
     has_table_privilege('anon', 'public.restroom_lock_secrets', 'UPDATE') OR
     has_table_privilege('anon', 'public.restroom_lock_secrets', 'DELETE') THEN
    RAISE EXCEPTION 'G02 Failed: anon role must not have DML privileges on restroom_lock_secrets';
  END IF;

  IF has_table_privilege('authenticated', 'public.restroom_lock_secrets', 'SELECT') OR
     has_table_privilege('authenticated', 'public.restroom_lock_secrets', 'INSERT') OR
     has_table_privilege('authenticated', 'public.restroom_lock_secrets', 'UPDATE') OR
     has_table_privilege('authenticated', 'public.restroom_lock_secrets', 'DELETE') THEN
    RAISE EXCEPTION 'G02 Failed: authenticated role must not have direct DML privileges on restroom_lock_secrets';
  END IF;

  IF NOT has_table_privilege('service_role', 'public.restroom_lock_secrets', 'SELECT') OR
     NOT has_table_privilege('service_role', 'public.restroom_lock_secrets', 'INSERT') OR
     NOT has_table_privilege('service_role', 'public.restroom_lock_secrets', 'UPDATE') THEN
    RAISE EXCEPTION 'G02 Failed: service_role must have SELECT, INSERT, UPDATE privileges on restroom_lock_secrets';
  END IF;

  IF has_function_privilege('anon', 'public.rotate_restroom_pin(uuid, uuid, text, text, text, integer, text, text)', 'EXECUTE') OR
     has_function_privilege('authenticated', 'public.rotate_restroom_pin(uuid, uuid, text, text, text, integer, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G02 Failed: anon and authenticated must not have EXECUTE privilege on rotate_restroom_pin';
  END IF;

  IF NOT has_function_privilege('service_role', 'public.rotate_restroom_pin(uuid, uuid, text, text, text, integer, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G02 Failed: service_role must have EXECUTE privilege on rotate_restroom_pin';
  END IF;

  IF has_function_privilege('anon', 'public.enforce_restroom_lock_secrets_rules()', 'EXECUTE') OR
     has_function_privilege('authenticated', 'public.enforce_restroom_lock_secrets_rules()', 'EXECUTE') THEN
    RAISE EXCEPTION 'G02 Failed: anon and authenticated must not have EXECUTE privilege on enforce_restroom_lock_secrets_rules';
  END IF;

  IF NOT has_function_privilege('service_role', 'public.enforce_restroom_lock_secrets_rules()', 'EXECUTE') THEN
    RAISE EXCEPTION 'G02 Failed: service_role must have EXECUTE privilege on enforce_restroom_lock_secrets_rules';
  END IF;

  RAISE NOTICE '✓ G02 Passed: Table and RPC privileges strictly isolated to service_role (T19)';

  -- ============================================================================
  -- Begin Isolated Fixture Subtransaction
  -- ============================================================================
  BEGIN
    -- G03: 테스트 픽스처 생성
    INSERT INTO auth.users (id, email) VALUES
      (v_merchant_a, 'fa23_merchant_a@test.com'),
      (v_merchant_b, 'fa23_merchant_b@test.com'),
      (v_customer, 'fa23_customer@test.com'),
      (v_suspended_merchant, 'fa23_suspended@test.com'),
      (v_admin, 'fa23_admin@test.com'),
      (v_manager_a, 'fa23_manager_a@test.com'),
      (v_revoked_merchant, 'fa23_revoked@test.com');

    INSERT INTO public.profiles (id, display_name, account_status) VALUES
      (v_merchant_a, '점주A', 'active'),
      (v_merchant_b, '점주B', 'active'),
      (v_customer, '일반고객', 'active'),
      (v_suspended_merchant, '정지점주', 'suspended'),
      (v_admin, '관리자', 'active'),
      (v_manager_a, '매니저A', 'active'),
      (v_revoked_merchant, '탈퇴점주', 'active')
    ON CONFLICT (id) DO UPDATE SET
      account_status = EXCLUDED.account_status,
      display_name = EXCLUDED.display_name;

    INSERT INTO public.user_roles (user_id, role) VALUES
      (v_merchant_a, 'merchant'),
      (v_merchant_b, 'merchant'),
      (v_customer, 'customer'),
      (v_suspended_merchant, 'merchant'),
      (v_admin, 'admin'),
      (v_manager_a, 'merchant'),
      (v_revoked_merchant, 'merchant')
    ON CONFLICT (user_id, role) DO NOTHING;

    INSERT INTO public.businesses (
      id, name, category, road_address, latitude, longitude, registration_status, approved_by, approved_at, created_by
    ) VALUES
      (v_biz_a_approved, '점포A (승인)', '카페', '수원시 팔달구 1', 37.2800, 127.0100, 'approved', v_admin, now(), v_merchant_a),
      (v_biz_b_approved, '점포B (승인)', '카페', '수원시 팔달구 2', 37.2810, 127.0110, 'approved', v_admin, now(), v_merchant_b),
      (v_biz_unapproved, '점포 (미승인)', '카페', '수원시 팔달구 3', 37.2820, 127.0120, 'pending', null, null, v_merchant_a);

    INSERT INTO public.business_members (business_id, user_id, role, membership_status) VALUES
      (v_biz_a_approved, v_merchant_a, 'owner', 'active'),
      (v_biz_b_approved, v_merchant_b, 'owner', 'active'),
      (v_biz_unapproved, v_merchant_a, 'owner', 'active'),
      (v_biz_a_approved, v_suspended_merchant, 'manager', 'active'),
      (v_biz_a_approved, v_manager_a, 'manager', 'active'),
      (v_biz_a_approved, v_revoked_merchant, 'owner', 'revoked');

    INSERT INTO public.restrooms (
      id, business_id, type, name, road_address, access_method, publication_status, latitude, longitude
    ) VALUES
      (v_restroom_a1_partner, v_biz_a_approved, 'partner', '점포A 화장실', '수원시 팔달구 1', 'pin', 'published', 37.2800, 127.0100),
      (v_restroom_b1_partner, v_biz_b_approved, 'partner', '점포B 화장실', '수원시 팔달구 2', 'pin', 'published', 37.2810, 127.0110),
      (v_restroom_unapproved, v_biz_unapproved, 'partner', '미승인점 화장실', '수원시 팔달구 3', 'pin', 'draft', 37.2820, 127.0120);

    INSERT INTO public.public_data_sources (
      id, provider_name, dataset_name, source_url
    ) VALUES (
      v_public_source, '수원시', '공중화장실', 'https://example.com'
    );

    INSERT INTO public.restrooms (
      id, source_id, type, name, road_address, access_method, publication_status, latitude, longitude
    ) VALUES
      (v_public_restroom, v_public_source, 'public', '화성행궁 공공화장실', '수원시 팔달구 4', 'open', 'published', 37.2830, 127.0130);

    RAISE NOTICE '✓ G03 Passed: Test fixtures setup successfully';

    -- ============================================================================
    -- G04: 최초 PIN 등록 성공 검증 (T07) 및 영속적 멱등성 재연(Replay) 검증 (T14-DB)
    -- ============================================================================
    v_res := public.rotate_restroom_pin(
      v_restroom_a1_partner,
      v_merchant_a,
      'Y2lwaGVydGV4dF9mYWtlX2Jhc2U2NA==',
      'aXZfZmFrZV9iYXNlNjQ=',
      'YXV0aF90YWdfZmFrZV8xNg==',
      1,
      'fa23_idem_key_001',
      'ZmFrZV9obWFjX2Jhc2U2NA=='
    );

    IF (v_res->>'success')::boolean IS NOT TRUE OR
       (v_res->>'code_version')::integer <> 1 OR
       (v_res->>'action') <> 'register_pin' THEN
      RAISE EXCEPTION 'G04 Failed: Initial PIN registration did not return code_version 1';
    END IF;

    v_secret_1_id := (v_res->>'secret_id')::uuid;

    SELECT * INTO v_secret_record
    FROM public.restroom_lock_secrets
    WHERE id = v_secret_1_id;

    IF v_secret_record.status <> 'active' OR
       v_secret_record.code_version <> 1 OR
       v_secret_record.valid_until IS NOT NULL OR
       v_secret_record.valid_from IS NULL OR
       v_secret_record.created_by <> v_merchant_a OR
       v_secret_record.idempotency_key <> 'fa23_idem_key_001' OR
       v_secret_record.pin_hmac_b64 <> 'ZmFrZV9obWFjX2Jhc2U2NA==' THEN
      RAISE EXCEPTION 'G04 Failed: Initial lock secret fields invalid in database';
    END IF;

    -- T14-DB: Replay with identical idempotency key & identical HMAC
    v_res := public.rotate_restroom_pin(
      v_restroom_a1_partner,
      v_merchant_a,
      'Y2lwaGVydGV4dF9mYWtlX2Jhc2U2NA==',
      'aXZfZmFrZV9iYXNlNjQ=',
      'YXV0aF90YWdfZmFrZV8xNg==',
      1,
      'fa23_idem_key_001',
      'ZmFrZV9obWFjX2Jhc2U2NA=='
    );

    IF (v_res->>'success')::boolean IS NOT TRUE OR
       (v_res->>'code_version')::integer <> 1 OR
       (v_res->>'action') <> 'replay' THEN
      RAISE EXCEPTION 'G04 Failed: Replay with identical idempotency key did not return action replay';
    END IF;

    -- Ensure no second record was created by replay
    SELECT count(*) INTO v_count
    FROM public.restroom_lock_secrets
    WHERE restroom_id = v_restroom_a1_partner;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'G04 Failed: Replay created duplicate secret record';
    END IF;

    RAISE NOTICE '✓ G04 Passed: Initial PIN registration succeeds and identical idempotency key returns replay (T07, T14-DB)';

    -- ============================================================================
    -- G05: 감사로그 비밀값 비노출 검증 (T17) 및 최초 등록 before_data NULL 검증
    -- ============================================================================
    SELECT * INTO v_audit_record
    FROM public.audit_logs
    WHERE entity_id = v_secret_1_id;

    IF v_audit_record.id IS NULL THEN
      RAISE EXCEPTION 'G05 Failed: Audit log not recorded for initial PIN registration';
    END IF;

    IF v_audit_record.action <> 'register_pin' OR
       v_audit_record.actor_user_id <> v_merchant_a OR
       v_audit_record.entity_type <> 'restroom_lock_secret' THEN
      RAISE EXCEPTION 'G05 Failed: Audit log metadata invalid';
    END IF;

    -- Requirement 4: Initial registration must have before_data IS NULL
    IF v_audit_record.before_data IS NOT NULL THEN
      RAISE EXCEPTION 'G05 Failed: Initial registration audit log must have null before_data';
    END IF;

    -- Strict verification: NO pin, ciphertext, iv, auth_tag, or encryption key in audit payload
    IF (v_audit_record.after_data ? 'pin') OR
       (v_audit_record.after_data ? 'ciphertext_b64') OR
       (v_audit_record.after_data ? 'iv_b64') OR
       (v_audit_record.after_data ? 'auth_tag_b64') OR
       (v_audit_record.after_data ? 'key') OR
       (v_audit_record.after_data ? 'PIN_ENCRYPTION_KEY') THEN
      RAISE EXCEPTION 'G05 Failed: Sensitive secret values leaked into audit_logs after_data';
    END IF;

    IF (v_audit_record.after_data->>'code_version')::integer <> 1 OR
       (v_audit_record.after_data->>'status') <> 'active' THEN
      RAISE EXCEPTION 'G05 Failed: Audit log after_data missing expected non-sensitive version metadata';
    END IF;

    RAISE NOTICE '✓ G05 Passed: Audit logs recorded without sensitive keys and before_data is NULL for initial registration (T17)';

    -- ============================================================================
    -- G06: PIN 교체, 버전 관리, 감사로그 before_data 정확성 검증 (T08, T10, Requirement 4)
    -- ============================================================================
    v_res := public.rotate_restroom_pin(
      v_restroom_a1_partner,
      v_merchant_a,
      'bmV3X2NpcGhlcnRleHRfZmFrZV9iYXNlNjQ=',
      'bmV3X2l2X2Zha2VfYmFzZTY0',
      'bmV3X2F1dGhfdGFnX2Zha2VfMTY=',
      1,
      'fa23_idem_key_002',
      'bmV3X2htYWNfYmFzZTY0'
    );

    IF (v_res->>'success')::boolean IS NOT TRUE OR
       (v_res->>'code_version')::integer <> 2 OR
       (v_res->>'action') <> 'rotate_pin' THEN
      RAISE EXCEPTION 'G06 Failed: PIN rotation did not increment code_version to 2';
    END IF;

    v_secret_2_id := (v_res->>'secret_id')::uuid;

    -- Verify previous secret is now rotated with valid_until set (T10)
    SELECT * INTO v_secret_record
    FROM public.restroom_lock_secrets
    WHERE id = v_secret_1_id;

    IF v_secret_record.status <> 'rotated' OR v_secret_record.valid_until IS NULL THEN
      RAISE EXCEPTION 'G06 Failed: Previous PIN secret was not transitioned to rotated with valid_until';
    END IF;

    -- Verify new secret is active with code_version 2 (T08)
    SELECT * INTO v_secret_record
    FROM public.restroom_lock_secrets
    WHERE id = v_secret_2_id;

    IF v_secret_record.status <> 'active' OR
       v_secret_record.code_version <> 2 OR
       v_secret_record.valid_until IS NOT NULL OR
       v_secret_record.idempotency_key <> 'fa23_idem_key_002' OR
       v_secret_record.pin_hmac_b64 <> 'bmV3X2htYWNfYmFzZTY0' THEN
      RAISE EXCEPTION 'G06 Failed: New PIN secret is not active with code_version 2';
    END IF;

    -- Requirement 4: Verify audit log before_data accurately reflects state BEFORE modification
    SELECT * INTO v_audit_record
    FROM public.audit_logs
    WHERE entity_id = v_secret_2_id;

    IF v_audit_record.before_data IS NULL THEN
      RAISE EXCEPTION 'G06 Failed: Audit log before_data must not be null for PIN rotation';
    END IF;

    IF (v_audit_record.before_data->>'code_version')::integer <> 1 OR
       (v_audit_record.before_data->>'status') <> 'active' OR
       (v_audit_record.before_data ? 'valid_until' AND v_audit_record.before_data->>'valid_until' IS NOT NULL) THEN
      RAISE EXCEPTION 'G06 Failed: Audit log before_data does not accurately reflect active predecessor secret (was %)', v_audit_record.before_data;
    END IF;

    IF (v_audit_record.after_data->>'code_version')::integer <> 2 OR
       (v_audit_record.after_data->>'status') <> 'active' THEN
      RAISE EXCEPTION 'G06 Failed: Audit log after_data does not accurately reflect new secret';
    END IF;

    -- Verify exactly 1 active PIN exists for this restroom (T09)
    SELECT count(*) INTO v_count
    FROM public.restroom_lock_secrets
    WHERE restroom_id = v_restroom_a1_partner AND status = 'active';

    IF v_count <> 1 THEN
      RAISE EXCEPTION 'G06 Failed: Expected exactly 1 active secret, found %', v_count;
    END IF;

    -- Verify replay on rotated key 002
    v_res := public.rotate_restroom_pin(
      v_restroom_a1_partner,
      v_merchant_a,
      'bmV3X2NpcGhlcnRleHRfZmFrZV9iYXNlNjQ=',
      'bmV3X2l2X2Zha2VfYmFzZTY0',
      'bmV3X2F1dGhfdGFnX2Zha2VfMTY=',
      1,
      'fa23_idem_key_002',
      'bmV3X2htYWNfYmFzZTY0'
    );
    IF (v_res->>'action') <> 'replay' OR (v_res->>'code_version')::integer <> 2 THEN
      RAISE EXCEPTION 'G06 Failed: Replay of rotation key did not return version 2';
    END IF;

    RAISE NOTICE '✓ G06 Passed: PIN rotation increments version to 2 and marks old as rotated (T08, T10)';

    -- ============================================================================
    -- G07: DB 차원 불변식 및 제약조건 검증 (T09)
    -- ============================================================================
    -- 1) Attempt to manually insert a second 'active' secret for restroom A (must fail due to partial unique index)
    v_caught := false;
    BEGIN
      INSERT INTO public.restroom_lock_secrets (
        restroom_id, ciphertext_b64, iv_b64, auth_tag_b64, key_version, code_version, status, created_by
      ) VALUES (
        v_restroom_a1_partner, 'fake_c', 'fake_iv', 'fake_tag', 1, 999, 'active', v_merchant_a
      );
    EXCEPTION WHEN unique_violation THEN
      v_caught := true;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G07 Failed: DB failed to enforce single active secret invariant (T09)';
    END IF;

    -- 2) Attempt to insert duplicate code_version for same restroom (must fail due to unique index)
    v_caught := false;
    BEGIN
      INSERT INTO public.restroom_lock_secrets (
        restroom_id, ciphertext_b64, iv_b64, auth_tag_b64, key_version, code_version, status, created_by
      ) VALUES (
        v_restroom_a1_partner, 'fake_c', 'fake_iv', 'fake_tag', 1, 1, 'revoked', v_merchant_a
      );
    EXCEPTION WHEN unique_violation THEN
      v_caught := true;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G07 Failed: DB failed to enforce unique code_version per restroom invariant';
    END IF;

    -- 3) Attempt to insert invalid valid_until <= valid_from (must fail check constraint)
    v_caught := false;
    BEGIN
      INSERT INTO public.restroom_lock_secrets (
        restroom_id, ciphertext_b64, iv_b64, auth_tag_b64, key_version, code_version, valid_from, valid_until, status, created_by
      ) VALUES (
        v_restroom_a1_partner, 'fake_c', 'fake_iv', 'fake_tag', 1, 100, now(), now() - interval '1 hour', 'revoked', v_merchant_a
      );
    EXCEPTION WHEN check_violation THEN
      v_caught := true;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G07 Failed: DB failed to enforce valid_until > valid_from check constraint';
    END IF;

    RAISE NOTICE '✓ G07 Passed: DB-level unique indexes and check constraints enforced (T09)';

    -- ============================================================================
    -- G08: 인가 음성 테스트 (T11, T12, T13)
    -- ============================================================================
    -- T11: merchant A attempts to change PIN of merchant B's restroom (must fail HM088 / 42501)
    v_caught := false;
    BEGIN
      PERFORM public.rotate_restroom_pin(
        v_restroom_b1_partner,
        v_merchant_a,
        'fake_cipher', 'fake_iv', 'fake_tag', 1
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '42501' THEN
        v_caught := true;
      END IF;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G08 Failed: merchant A changing merchant B PIN was not rejected with 42501 (T11)';
    END IF;

    -- T12: customer attempts to rotate PIN (must fail 42501)
    v_caught := false;
    BEGIN
      PERFORM public.rotate_restroom_pin(
        v_restroom_a1_partner,
        v_customer,
        'fake_cipher', 'fake_iv', 'fake_tag', 1
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '42501' THEN
        v_caught := true;
      END IF;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G08 Failed: customer rotating PIN was not rejected with 42501 (T12)';
    END IF;

    -- T12: unauthenticated caller (NULL user id) (must fail 28000)
    v_caught := false;
    BEGIN
      PERFORM public.rotate_restroom_pin(
        v_restroom_a1_partner,
        NULL,
        'fake_cipher', 'fake_iv', 'fake_tag', 1
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '28000' THEN
        v_caught := true;
      END IF;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G08 Failed: unauthenticated caller was not rejected with 28000 (T12)';
    END IF;

    -- T13: cannot register PIN on public restroom (must fail HM082 22023 / 42501)
    v_caught := false;
    BEGIN
      PERFORM public.rotate_restroom_pin(
        v_public_restroom,
        v_merchant_a,
        'fake_cipher', 'fake_iv', 'fake_tag', 1
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE IN ('22023', '42501') THEN
        v_caught := true;
      END IF;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G08 Failed: public restroom PIN registration was not rejected (T13)';
    END IF;

    -- Direct table INSERT on public restroom blocked by trigger enforce_restroom_lock_secrets_rules
    v_caught := false;
    BEGIN
      INSERT INTO public.restroom_lock_secrets (
        restroom_id, ciphertext_b64, iv_b64, auth_tag_b64, key_version, code_version, status, created_by
      ) VALUES (
        v_public_restroom, 'fake_c', 'fake_iv', 'fake_tag', 1, 1, 'active', v_admin
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '22023' THEN
        v_caught := true;
      END IF;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G08 Failed: direct INSERT on public restroom was not rejected by trigger HM082';
    END IF;

    -- T13: cannot register PIN on unapproved business restroom (must fail HM088 42501)
    v_caught := false;
    BEGIN
      PERFORM public.rotate_restroom_pin(
        v_restroom_unapproved,
        v_merchant_a,
        'fake_cipher', 'fake_iv', 'fake_tag', 1
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '42501' THEN
        v_caught := true;
      END IF;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G08 Failed: unapproved business restroom PIN was not rejected with 42501 (T13)';
    END IF;

    -- T13: suspended user cannot rotate PIN (HM085 42501)
    v_caught := false;
    BEGIN
      PERFORM public.rotate_restroom_pin(
        v_restroom_a1_partner,
        v_suspended_merchant,
        'fake_cipher', 'fake_iv', 'fake_tag', 1
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '42501' THEN
        v_caught := true;
      END IF;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G08 Failed: suspended user was not rejected with 42501 (T13)';
    END IF;

    -- Requirement 3: Admin also cannot register PIN on unapproved business restroom (HM088 42501)
    v_caught := false;
    BEGIN
      PERFORM public.rotate_restroom_pin(
        v_restroom_unapproved,
        v_admin,
        'fake_cipher', 'fake_iv', 'fake_tag', 1
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '42501' AND SQLERRM LIKE '%HM088%' THEN
        v_caught := true;
      END IF;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G08 Failed: admin was able to register PIN on unapproved business restroom';
    END IF;

    -- Requirement 3: Manager (non-owner) cannot register PIN (HM088 42501)
    v_caught := false;
    BEGIN
      PERFORM public.rotate_restroom_pin(
        v_restroom_a1_partner,
        v_manager_a,
        'fake_cipher', 'fake_iv', 'fake_tag', 1
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '42501' AND SQLERRM LIKE '%HM088%' THEN
        v_caught := true;
      END IF;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G08 Failed: manager was able to register PIN (must require owner role)';
    END IF;

    -- Requirement 1: Revoked business member attempting replay with existing key (must fail HM088 42501)
    v_caught := false;
    BEGIN
      PERFORM public.rotate_restroom_pin(
        v_restroom_a1_partner,
        v_revoked_merchant,
        'Y2lwaGVydGV4dF9mYWtlX2Jhc2U2NA==',
        'aXZfZmFrZV9iYXNlNjQ=',
        'YXV0aF90YWdfZmFrZV8xNg==',
        1,
        'fa23_idem_key_001',
        'ZmFrZV9obWFjX2Jhc2U2NA=='
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '42501' AND SQLERRM LIKE '%HM088%' THEN
        v_caught := true;
      END IF;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G08 Failed: revoked member was able to replay past idempotency key';
    END IF;

    -- Requirement 2: Idempotency key provided with NULL HMAC (must fail HM090 22023)
    v_caught := false;
    BEGIN
      PERFORM public.rotate_restroom_pin(
        v_restroom_a1_partner,
        v_merchant_a,
        'fake_cipher', 'fake_iv', 'fake_tag', 1,
        'fa23_idem_no_hmac',
        NULL
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '22023' AND SQLERRM LIKE '%HM090%' THEN
        v_caught := true;
      END IF;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G08 Failed: idempotency key without HMAC was not rejected with HM090 / 22023';
    END IF;

    -- Requirement 5: Whitespace only idempotency key (must fail HM093 22023)
    v_caught := false;
    BEGIN
      PERFORM public.rotate_restroom_pin(
        v_restroom_a1_partner,
        v_merchant_a,
        'fake_cipher', 'fake_iv', 'fake_tag', 1,
        '   ',
        'valid_hmac'
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '22023' AND SQLERRM LIKE '%HM093%' THEN
        v_caught := true;
      END IF;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G08 Failed: whitespace idempotency key was not rejected with HM093 / 22023';
    END IF;

    -- Requirement 2: Direct table INSERT with idempotency_key and NULL HMAC blocked by trigger
    v_caught := false;
    BEGIN
      INSERT INTO public.restroom_lock_secrets (
        restroom_id, ciphertext_b64, iv_b64, auth_tag_b64, key_version, code_version, status, created_by, idempotency_key, pin_hmac_b64
      ) VALUES (
        v_restroom_a1_partner, 'fake_c', 'fake_iv', 'fake_tag', 1, 998, 'revoked', v_merchant_a, 'test_null_hmac_key', NULL
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '22023' AND SQLERRM LIKE '%HM090%' THEN
        v_caught := true;
      END IF;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G08 Failed: trigger failed to enforce pin_hmac_b64 requirement when idempotency_key is present';
    END IF;


    -- T14-Conflict-1: Same idempotency key with different PIN HMAC (HM092 23505)
    v_caught := false;
    BEGIN
      PERFORM public.rotate_restroom_pin(
        v_restroom_a1_partner,
        v_merchant_a,
        'new_cipher', 'new_iv', 'new_tag', 1,
        'fa23_idem_key_001',
        'ZGlmZmVyZW50X2htYWNfYmFzZTY0'
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '23505' AND SQLERRM LIKE '%HM092%' THEN
        v_caught := true;
      END IF;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G08 Failed: same idempotency key with different PIN HMAC was not rejected with HM092 / 23505';
    END IF;

    -- T14-Conflict-2: Same idempotency key with different restroom / caller (HM091 23505)
    v_caught := false;
    BEGIN
      PERFORM public.rotate_restroom_pin(
        v_restroom_b1_partner,
        v_merchant_b,
        'new_cipher', 'new_iv', 'new_tag', 1,
        'fa23_idem_key_001',
        'ZmFrZV9obWFjX2Jhc2U2NA=='
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '23505' AND SQLERRM LIKE '%HM091%' THEN
        v_caught := true;
      END IF;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G08 Failed: same idempotency key with different restroom was not rejected with HM091 / 23505';
    END IF;

    -- T14-Conflict-3: Suspended user attempting replay with existing key (HM085 42501 must take priority over replay)
    v_caught := false;
    BEGIN
      PERFORM public.rotate_restroom_pin(
        v_restroom_a1_partner,
        v_suspended_merchant,
        'Y2lwaGVydGV4dF9mYWtlX2Jhc2U2NA==',
        'aXZfZmFrZV9iYXNlNjQ=',
        'YXV0aF90YWdfZmFrZV8xNg==',
        1,
        'fa23_idem_key_001',
        'ZmFrZV9obWFjX2Jhc2U2NA=='
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '42501' AND SQLERRM LIKE '%HM085%' THEN
        v_caught := true;
      END IF;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G08 Failed: suspended user replaying key was not rejected with HM085 / 42501';
    END IF;

    RAISE NOTICE '✓ G08 Passed: Negative authorization and idempotency conflict checks succeed (T11, T12, T13, T14)';

    -- ============================================================================
    -- G09: 트랜잭션 원자성 및 오류 시 롤백 검증 (T16)
    -- ============================================================================
    -- Attempt rotation with invalid crypto payload (empty ciphertext -> HM089 22023)
    v_caught := false;
    BEGIN
      PERFORM public.rotate_restroom_pin(
        v_restroom_a1_partner,
        v_merchant_a,
        '', 'valid_iv', 'valid_tag', 1
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '22023' THEN
        v_caught := true;
      END IF;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G09 Failed: Empty ciphertext was not rejected with 22023';
    END IF;

    -- Verify that secret 2 is STILL active and code_version did not increment to 3
    SELECT * INTO v_secret_record
    FROM public.restroom_lock_secrets
    WHERE id = v_secret_2_id;

    IF v_secret_record.status <> 'active' OR v_secret_record.valid_until IS NOT NULL THEN
      RAISE EXCEPTION 'G09 Failed: Failed rotation partially modified prior active secret state';
    END IF;

    SELECT max(code_version) INTO v_count
    FROM public.restroom_lock_secrets
    WHERE restroom_id = v_restroom_a1_partner;

    IF v_count <> 2 THEN
      RAISE EXCEPTION 'G09 Failed: Expected max code_version to remain 2, found %', v_count;
    END IF;

    RAISE NOTICE '✓ G09 Passed: Transaction failure rolls back completely without partial state leak (T16)';

    -- ============================================================================
    -- G10: 의도적 P0099 강제 롤백
    -- ============================================================================
    RAISE EXCEPTION 'P0099: Intentional rollback of test fixture' USING ERRCODE = 'P0099';

  EXCEPTION WHEN SQLSTATE 'P0099' THEN
    RAISE NOTICE '✓ G10 Passed: P0099 Intentional rollback caught cleanly';
  END;

  -- ============================================================================
  -- G11: 롤백 후 잔류 데이터 0건 무결성 검증
  -- ============================================================================
  SELECT count(*) INTO v_count
  FROM public.restroom_lock_secrets
  WHERE id::text LIKE v_test_prefix || '%' OR restroom_id::text LIKE v_test_prefix || '%';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G11 Failed: % residue records found in restroom_lock_secrets', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.audit_logs
  WHERE entity_id::text LIKE v_test_prefix || '%' OR actor_user_id::text LIKE v_test_prefix || '%';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G11 Failed: % residue records found in audit_logs', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.restrooms
  WHERE id::text LIKE v_test_prefix || '%';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G11 Failed: % residue records found in restrooms', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.public_data_sources
  WHERE id::text LIKE v_test_prefix || '%';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G11 Failed: % residue records found in public_data_sources', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.businesses
  WHERE id::text LIKE v_test_prefix || '%';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G11 Failed: % residue records found in businesses', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.profiles
  WHERE id::text LIKE v_test_prefix || '%';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G11 Failed: % residue records found in profiles', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM auth.users
  WHERE id::text LIKE v_test_prefix || '%';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G11 Failed: % residue records found in auth.users', v_count;
  END IF;

  RAISE NOTICE '✓ G11 Passed: 0 residue records across all tables after rollback';
  RAISE NOTICE '================================================================';
  RAISE NOTICE '>>> ALL 12 VERIFICATION GROUPS (G00~G11) COMPLETED SUCCESSFULLY!';
  RAISE NOTICE '================================================================';
END $$;
