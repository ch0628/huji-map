-- ==============================================================================
-- Verification SQL: verify_payment_atomic_rollback.sql
-- Description: TASK 21 - 토스 결제 원자적 승인 및 주문 생성 RPC 롤백 검증
-- Spec: docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/07_PAYMENT_ACCESS_REFUND.md,
--       docs/08_SECURITY_OPERATIONS.md, docs/11_DECISIONS.md, tasks/21_toss_server.md
-- Verification Groups:
--   G00: 충돌 사전 점검 (fa210000- 접두사 사전 잔류 레코드 부재 확인)
--   G01: RPC 존재 및 반환형 검증
--   G02: 실행 권한 검증 (anon, authenticated 권한 배제, service_role 허용)
--   G03: 테스트 픽스처 설정 (사용자, 점포, 화장실, 정책)
--   G04: create_payment_order_session 원자적 생성 및 제약조건 검증
--   G05: complete_payment_approval 원자적 승인 및 멱등/위변조 방어 검증
--   G06: record_payment_failure 및 승인 불변성 방어 검증
--   G07: P0099 의도적 서브트랜잭션 롤백 실행
--   G08: 롤백 후 잔류 데이터 0건 무결성 검증
-- ==============================================================================

DO $$
DECLARE
  v_test_prefix text := 'fa210000-';
  v_user_id uuid := 'fa210000-0000-0000-0000-000000000001'::uuid;
  v_biz_owner_id uuid := 'fa210000-0000-0000-0000-000000000002'::uuid;
  v_admin_id uuid := 'fa210000-0000-0000-0000-000000000003'::uuid;

  v_biz_id uuid := 'fa210000-0000-0000-0000-000000000010'::uuid;
  v_partner_restroom_1_id uuid := 'fa210000-0000-0000-0000-000000000020'::uuid;
  v_partner_policy_1_id uuid := 'fa210000-0000-0000-0000-000000000030'::uuid;

  v_partner_restroom_2_id uuid := 'fa210000-0000-0000-0000-000000000021'::uuid;
  v_partner_policy_2_id uuid := 'fa210000-0000-0000-0000-000000000031'::uuid;

  v_public_source_id uuid := 'fa210000-0000-0000-0000-000000000040'::uuid;
  v_public_restroom_id uuid := 'fa210000-0000-0000-0000-000000000050'::uuid;
  v_public_policy_id uuid := 'fa210000-0000-0000-0000-000000000060'::uuid;

  v_count integer;
  v_res jsonb;
  v_order_id text := 'ord_fa21_test_001';
  v_payment_key text := 'tpay_key_test_001_abc123';
  v_idem_key text := 'idem_fa21_order_001_xxxx';
  v_caught boolean;
BEGIN
  RAISE NOTICE '>>> Starting TASK 21 Payment Atomic Operations Verification';

  -- ============================================================================
  -- G00: 사전 충돌 점검
  -- ============================================================================
  SELECT count(*) INTO v_count
  FROM public.access_sessions
  WHERE id::text LIKE v_test_prefix || '%';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G00 Failed: Pre-existing access_sessions found' USING ERRCODE = '23505';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.payment_orders
  WHERE id::text LIKE v_test_prefix || '%';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G00 Failed: Pre-existing payment_orders found' USING ERRCODE = '23505';
  END IF;

  RAISE NOTICE '✓ G00 Passed: No pre-existing test records';

  -- ============================================================================
  -- G01: RPC 존재 검증
  -- ============================================================================
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'complete_payment_approval'
  ) THEN
    RAISE EXCEPTION 'G01 Failed: complete_payment_approval RPC missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'create_payment_order_session'
  ) THEN
    RAISE EXCEPTION 'G01 Failed: create_payment_order_session RPC missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'record_payment_failure'
  ) THEN
    RAISE EXCEPTION 'G01 Failed: record_payment_failure RPC missing';
  END IF;

  RAISE NOTICE '✓ G01 Passed: All 3 RPCs exist';

  -- ============================================================================
  -- G02: 실행 권한 분리 검증 (service_role만 허용, anon/authenticated 차단)
  -- ============================================================================
  IF has_function_privilege('anon', 'public.complete_payment_approval(text, text, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G02 Failed: anon must NOT have EXECUTE on complete_payment_approval';
  END IF;

  IF has_function_privilege('authenticated', 'public.complete_payment_approval(text, text, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G02 Failed: authenticated must NOT have EXECUTE on complete_payment_approval';
  END IF;

  IF NOT has_function_privilege('service_role', 'public.complete_payment_approval(text, text, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G02 Failed: service_role MUST have EXECUTE on complete_payment_approval';
  END IF;

  IF has_function_privilege('anon', 'public.create_payment_order_session(uuid, uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G02 Failed: anon must NOT have EXECUTE on create_payment_order_session';
  END IF;

  IF has_function_privilege('authenticated', 'public.create_payment_order_session(uuid, uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G02 Failed: authenticated must NOT have EXECUTE on create_payment_order_session';
  END IF;

  IF NOT has_function_privilege('service_role', 'public.create_payment_order_session(uuid, uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G02 Failed: service_role MUST have EXECUTE on create_payment_order_session';
  END IF;

  IF has_function_privilege('anon', 'public.record_payment_failure(text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G02 Failed: anon must NOT have EXECUTE on record_payment_failure';
  END IF;

  IF has_function_privilege('authenticated', 'public.record_payment_failure(text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G02 Failed: authenticated must NOT have EXECUTE on record_payment_failure';
  END IF;

  IF NOT has_function_privilege('service_role', 'public.record_payment_failure(text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G02 Failed: service_role MUST have EXECUTE on record_payment_failure';
  END IF;

  RAISE NOTICE '✓ G02 Passed: EXECUTE privilege correctly restricted to service_role';

  -- ============================================================================
  -- 서브트랜잭션: 테스트 데이터 생성, 비즈니스 규칙 검증 및 롤백
  -- ============================================================================
  BEGIN
    -- G03: 픽스처 생성
    -- 1) 사용자 계정
    INSERT INTO auth.users (id, email) VALUES
      (v_user_id, 'user_fa21@test.com'),
      (v_biz_owner_id, 'owner_fa21@test.com'),
      (v_admin_id, 'admin_fa21@test.com');

    INSERT INTO public.profiles (id, display_name, preferred_language, account_status) VALUES
      (v_user_id, '결제테스트회원', 'ko', 'active'),
      (v_biz_owner_id, '제휴가게점주', 'ko', 'active'),
      (v_admin_id, '운영관리자', 'ko', 'active')
    ON CONFLICT (id) DO UPDATE SET account_status = 'active';

    INSERT INTO public.user_roles (user_id, role) VALUES
      (v_user_id, 'customer'),
      (v_biz_owner_id, 'customer'),
      (v_biz_owner_id, 'merchant'),
      (v_admin_id, 'admin')
    ON CONFLICT (user_id, role) DO NOTHING;

    -- 2) 제휴 점포
    INSERT INTO public.businesses (
      id, name, category, road_address, latitude, longitude, registration_status, approved_by, approved_at, created_by
    ) VALUES (
      v_biz_id, 'DEMO-수원화장실카페', '카페', '경기도 수원시 팔달구 매산로 1',
      37.2660, 127.0010, 'approved', v_admin_id, now(), v_user_id
    );

    INSERT INTO public.business_members (business_id, user_id, role)
    VALUES (v_biz_id, v_biz_owner_id, 'owner');

    -- 3) 제휴 화장실 1
    INSERT INTO public.restrooms (
      id, business_id, type, name, road_address, latitude, longitude,
      access_method, publication_status, approved_by, last_verified_at, created_by
    ) VALUES (
      v_partner_restroom_1_id, v_biz_id, 'partner', 'DEMO-수원카페 화장실 1',
      '경기도 수원시 팔달구 매산로 1', 37.2660, 127.0010, 'pin', 'published', v_admin_id, now(), v_user_id
    );

    INSERT INTO public.restroom_access_policies (
      id, restroom_id, version, access_mode, deposit_amount_krw,
      refund_eligible, receipt_window_hours, min_purchase_krw, is_active, effective_from, created_by
    ) VALUES (
      v_partner_policy_1_id, v_partner_restroom_1_id, 1, 'test_deposit', 1000,
      true, 24, 0, true, now(), v_user_id
    );

    -- 4) 제휴 화장실 2
    INSERT INTO public.restrooms (
      id, business_id, type, name, road_address, latitude, longitude,
      access_method, publication_status, approved_by, last_verified_at, created_by
    ) VALUES (
      v_partner_restroom_2_id, v_biz_id, 'partner', 'DEMO-수원카페 화장실 2',
      '경기도 수원시 팔달구 매산로 1', 37.2660, 127.0010, 'ask_staff', 'published', v_admin_id, now(), v_user_id
    );

    INSERT INTO public.restroom_access_policies (
      id, restroom_id, version, access_mode, deposit_amount_krw,
      refund_eligible, receipt_window_hours, min_purchase_krw, is_active, effective_from, created_by
    ) VALUES (
      v_partner_policy_2_id, v_partner_restroom_2_id, 1, 'test_deposit', 1000,
      true, 24, 0, true, now(), v_user_id
    );

    -- 5) 공공 화장실
    INSERT INTO public.public_data_sources (
      id, provider_name, dataset_name, source_url
    ) VALUES (
      v_public_source_id, '수원시', '공중화장실', 'https://example.com'
    );

    INSERT INTO public.restrooms (
      id, source_id, type, name, road_address, latitude, longitude,
      access_method, publication_status
    ) VALUES (
      v_public_restroom_id, v_public_source_id, 'public', 'DEMO-수원역 공공화장실',
      '경기도 수원시 팔달구 덕영대로 924', 37.2655, 127.0005, 'open', 'published'
    );

    INSERT INTO public.restroom_access_policies (
      id, restroom_id, version, access_mode, deposit_amount_krw,
      refund_eligible, is_active, effective_from
    ) VALUES (
      v_public_policy_id, v_public_restroom_id, 1, 'free', 0,
      false, true, now()
    );

    RAISE NOTICE '✓ G03 Passed: Fixtures established';

    -- ============================================================================
    -- G04: create_payment_order_session 검증
    -- ============================================================================
    -- 1) 공공 화장실 주문 차단 (HM065)
    v_caught := false;
    BEGIN
      PERFORM public.create_payment_order_session(v_user_id, v_public_restroom_id, 'ord_pub_err', 'idem_pub_err_123');
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '22023' THEN
        v_caught := true;
      END IF;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G04 Failed: Expected 22023 when creating payment order for public restroom';
    END IF;

    -- 2) 정상 제휴 화장실 주문 원자적 생성
    v_res := public.create_payment_order_session(v_user_id, v_partner_restroom_1_id, v_order_id, v_idem_key);
    IF (v_res->>'reused')::boolean IS NOT FALSE THEN
      RAISE EXCEPTION 'G04 Failed: First call must not be reused';
    END IF;
    IF v_res->'order'->>'order_id' != v_order_id THEN
      RAISE EXCEPTION 'G04 Failed: order_id mismatch in returned object';
    END IF;
    IF (v_res->'order'->>'amount_krw')::int != 1000 THEN
      RAISE EXCEPTION 'G04 Failed: amount_krw must be 1000 from policy';
    END IF;
    IF v_res->'order'->>'status' != 'created' THEN
      RAISE EXCEPTION 'G04 Failed: order status must be created';
    END IF;
    IF v_res->'access_session'->>'status' != 'created' THEN
      RAISE EXCEPTION 'G04 Failed: access session status must be created';
    END IF;

    -- 3) 동일 멱등키 재시도 -> 기존 주문 재사용 (reused: true)
    v_res := public.create_payment_order_session(v_user_id, v_partner_restroom_1_id, 'another_order_id', v_idem_key);
    IF (v_res->>'reused')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'G04 Failed: Repeated call with same idempotency key must return reused: true';
    END IF;
    IF v_res->'order'->>'order_id' != v_order_id THEN
      RAISE EXCEPTION 'G04 Failed: Reused order must preserve original order_id %', v_order_id;
    END IF;

    -- 멱등성 재사용 후 DB 주문·이용권 건수가 각각 정확히 1건인지 검증
    SELECT count(*) INTO v_count FROM public.payment_orders WHERE idempotency_key = v_idem_key;
    IF v_count != 1 THEN
      RAISE EXCEPTION 'G04 Failed: Expected exactly 1 payment_order for idempotency key %, found %', v_idem_key, v_count;
    END IF;

    SELECT count(*) INTO v_count FROM public.access_sessions WHERE idempotency_key = 'ses_' || v_idem_key;
    IF v_count != 1 THEN
      RAISE EXCEPTION 'G04 Failed: Expected exactly 1 access_session for idempotency key %, found %', v_idem_key, v_count;
    END IF;

    -- 4) 동일 멱등키로 다른 화장실 요청 시 충돌 거부 (HM063)
    v_caught := false;
    BEGIN
      PERFORM public.create_payment_order_session(v_user_id, v_partner_restroom_2_id, 'diff_ord_id', v_idem_key);
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '23505' THEN
        v_caught := true;
      END IF;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G04 Failed: Expected 23505 when using same idempotency key on different restroom';
    END IF;

    -- 4-1) 정지(suspended) 사용자의 기존 멱등키 주문 재사용 시도 차단 음성 테스트 (HM062)
    UPDATE public.profiles SET account_status = 'suspended' WHERE id = v_user_id;

    v_caught := false;
    BEGIN
      PERFORM public.create_payment_order_session(v_user_id, v_partner_restroom_1_id, 'ord_susp_reuse', v_idem_key);
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '42501' THEN
        v_caught := true;
      END IF;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G04 Failed: Expected 42501 when suspended user attempts order reuse with existing idempotency key';
    END IF;

    -- 계정 상태 active 원복
    UPDATE public.profiles SET account_status = 'active' WHERE id = v_user_id;

    -- 4-2) 존재하지 않는 사용자의 기존 멱등키 주문 재사용 시도 차단 음성 테스트 (HM061)
    v_caught := false;
    BEGIN
      PERFORM public.create_payment_order_session('fa210000-0000-0000-0000-999999999999'::uuid, v_partner_restroom_1_id, 'ord_ghost_reuse', v_idem_key);
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '23503' THEN
        v_caught := true;
      END IF;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G04 Failed: Expected 23503 when non-existent user attempts order reuse with existing idempotency key';
    END IF;

    -- 5) 입력 유효성 검사 (HM061, HM064, HM052, HM073)
    v_caught := false;
    BEGIN
      PERFORM public.create_payment_order_session(NULL, v_partner_restroom_1_id, 'ord_null_u', 'idem_null_u');
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '22023' THEN v_caught := true; END IF;
    END;
    IF NOT v_caught THEN RAISE EXCEPTION 'G04 Failed: Expected 22023 for NULL user_id'; END IF;

    v_caught := false;
    BEGIN
      PERFORM public.create_payment_order_session(v_user_id, NULL, 'ord_null_r', 'idem_null_r');
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '22023' THEN v_caught := true; END IF;
    END;
    IF NOT v_caught THEN RAISE EXCEPTION 'G04 Failed: Expected 22023 for NULL restroom_id'; END IF;

    v_caught := false;
    BEGIN
      PERFORM public.create_payment_order_session(v_user_id, v_partner_restroom_1_id, '', 'idem_empty_o');
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '22023' THEN v_caught := true; END IF;
    END;
    IF NOT v_caught THEN RAISE EXCEPTION 'G04 Failed: Expected 22023 for empty order_id'; END IF;

    v_caught := false;
    BEGIN
      PERFORM public.create_payment_order_session(v_user_id, v_partner_restroom_1_id, 'ord_empty_i', '');
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '22023' THEN v_caught := true; END IF;
    END;
    IF NOT v_caught THEN RAISE EXCEPTION 'G04 Failed: Expected 22023 for empty idempotency_key'; END IF;

    RAISE NOTICE '✓ G04 Passed: create_payment_order_session atomic creation & idempotency verified';

    -- ============================================================================
    -- G05: complete_payment_approval 검증
    -- ============================================================================
    -- 1) 금액 불일치 시 승인 거부 (HM058)
    v_caught := false;
    BEGIN
      PERFORM public.complete_payment_approval(v_order_id, v_payment_key, 2000);
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '22023' THEN
        v_caught := true;
      END IF;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G05 Failed: Expected 22023 when approving with mismatched amount';
    END IF;

    -- 2) 미존재 order_id 승인 거부 (HM055)
    v_caught := false;
    BEGIN
      PERFORM public.complete_payment_approval('non_existent_order_id', v_payment_key, 1000);
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = 'P0002' THEN
        v_caught := true;
      END IF;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G05 Failed: Expected P0002 when approving non-existent order';
    END IF;

    -- 3) 정상 승인 처리: payment_orders approved + access_sessions authorized 원자적 반영
    v_res := public.complete_payment_approval(v_order_id, v_payment_key, 1000);
    IF (v_res->>'success')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'G05 Failed: complete_payment_approval must succeed';
    END IF;
    IF (v_res->>'already_approved')::boolean IS NOT FALSE THEN
      RAISE EXCEPTION 'G05 Failed: First approval must have already_approved: false';
    END IF;
    IF v_res->'order'->>'status' != 'approved' THEN
      RAISE EXCEPTION 'G05 Failed: order status must be approved';
    END IF;
    IF v_res->'order'->>'provider_payment_key' != v_payment_key THEN
      RAISE EXCEPTION 'G05 Failed: provider_payment_key mismatch';
    END IF;
    IF v_res->'access_session'->>'status' != 'authorized' THEN
      RAISE EXCEPTION 'G05 Failed: access session status must be authorized';
    END IF;

    -- 4) 동일 키/금액 재시도 -> 멱등하게 성공 반환 (already_approved: true)
    v_res := public.complete_payment_approval(v_order_id, v_payment_key, 1000);
    IF (v_res->>'already_approved')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'G05 Failed: Repeated approval must have already_approved: true';
    END IF;

    -- 5) 다른 결제키로 동일 order_id 승인 시도 -> 23505 위변조 충돌 거부 (HM056)
    v_caught := false;
    BEGIN
      PERFORM public.complete_payment_approval(v_order_id, 'different_tampered_key', 1000);
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '23505' THEN
        v_caught := true;
      END IF;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G05 Failed: Expected 23505 when re-approving with different payment key';
    END IF;

    RAISE NOTICE '✓ G05 Passed: complete_payment_approval atomic approval & idempotency verified';

    -- ============================================================================
    -- G06: record_payment_failure 검증
    -- ============================================================================
    -- 1) 이미 approved 된 주문은 failed 로 전이 불가 (HM072)
    v_caught := false;
    BEGIN
      PERFORM public.record_payment_failure(v_order_id, 'REJECT_CARD');
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '22023' THEN
        v_caught := true;
      END IF;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G06 Failed: Expected 22023 when marking approved order as failed';
    END IF;

    -- 2) 새 주문 생성 후 정상 failed 처리
    v_res := public.create_payment_order_session(v_user_id, v_partner_restroom_2_id, 'ord_failed_test_002', 'idem_failed_test_002');
    v_res := public.record_payment_failure('ord_failed_test_002', 'PAY_PROCESS_CANCELED');
    IF v_res->'order'->>'status' != 'failed' THEN
      RAISE EXCEPTION 'G06 Failed: order status must be failed';
    END IF;
    IF v_res->'order'->>'failure_code' != 'PAY_PROCESS_CANCELED' THEN
      RAISE EXCEPTION 'G06 Failed: failure_code mismatch';
    END IF;

    -- 3) failed 상태 주문은 complete_payment_approval 승인 불가 (HM057)
    v_caught := false;
    BEGIN
      PERFORM public.complete_payment_approval('ord_failed_test_002', 'tpay_key_late_002', 1000);
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '22023' THEN
        v_caught := true;
      END IF;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'G06 Failed: Expected 22023 when attempting to approve failed order';
    END IF;

    RAISE NOTICE '✓ G06 Passed: record_payment_failure verified';

    -- 의도적 롤백 트리거
    RAISE EXCEPTION 'P0099_ROLLBACK_INTENTIONAL' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLSTATE = 'P0099' THEN
        RAISE NOTICE '✓ Subtransaction intentionally caught and rolled back via P0099';
      ELSE
        RAISE;
      END IF;
  END;

  -- ============================================================================
  -- G08: 롤백 후 잔류 데이터 0건 검증 (UUID 접두사 및 비즈니스 키/ID 기준)
  -- ============================================================================
  SELECT count(*) INTO v_count
  FROM public.access_sessions
  WHERE id::text LIKE v_test_prefix || '%'
     OR user_id = v_user_id
     OR idempotency_key LIKE 'ses_idem_fa21_%'
     OR idempotency_key LIKE 'ses_idem_failed_test_%'
     OR idempotency_key LIKE 'ses_idem_pub_err_%';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G08 Failed: access_sessions residue found: %', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.payment_orders
  WHERE id::text LIKE v_test_prefix || '%'
     OR user_id = v_user_id
     OR order_id LIKE 'ord_fa21_%'
     OR order_id LIKE 'ord_failed_test_%'
     OR order_id IN ('another_order_id', 'ord_pub_err', 'diff_ord_id', 'ord_null_u', 'ord_null_r', 'ord_empty_i', 'ord_susp_reuse', 'ord_ghost_reuse')
     OR idempotency_key LIKE 'idem_fa21_%'
     OR idempotency_key LIKE 'idem_failed_test_%'
     OR idempotency_key IN ('idem_pub_err_123', 'idem_null_u', 'idem_null_r', 'idem_empty_o');
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G08 Failed: payment_orders residue found: %', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.restrooms
  WHERE id::text LIKE v_test_prefix || '%';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G08 Failed: restrooms residue found: %', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.businesses
  WHERE id::text LIKE v_test_prefix || '%';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G08 Failed: businesses residue found: %', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.profiles
  WHERE id::text LIKE v_test_prefix || '%';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G08 Failed: profiles residue found: %', v_count;
  END IF;

  RAISE NOTICE '✓ G08 Passed: 0 residue across all tables after rollback!';
  RAISE NOTICE '>>> All TASK 21 Verification Groups (G00-G08) PASSED cleanly!';
END;
$$;
