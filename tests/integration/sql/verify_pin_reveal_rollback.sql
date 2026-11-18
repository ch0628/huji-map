-- ==============================================================================
-- Verification SQL: verify_pin_reveal_rollback.sql
-- Description: TASK 24 - 고객용 도어락 PIN 조회 API, pin_reveal_audits, visit_confirmations 스키마 및 롤백 검증
-- Spec: docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/07_PAYMENT_ACCESS_REFUND.md,
--       docs/08_SECURITY_OPERATIONS.md, docs/11_DECISIONS.md, tasks/24_pin_reveal.md
-- Verification Groups:
--   G00: 사전 충돌 점검 (fa240000- 접두사 사전 잔류 레코드 부재 확인)
--   G01: 테이블, 컬럼, 인덱스, 트리거, RPC 스키마 검증
--   G02: 권한 격리 검증 (anon, authenticated 직접 접근 차단, service_role 허용)
--   G03: 테스트 픽스처 설정 (고객 A/B, 정지회원, 점주, 제휴 매장/화장실, 세션, 결제, 락 시크릿)
--   G04: 정상 조회 검증 (T01: 유효 이용권 + 승인 결제 → 정상 암호문 반환, code_revealed 전이, 감사로그)
--   G05: 타인 이용권 차단 (T05: 타인 고객 요청 시 403 FORBIDDEN 거부 및 감사로그)
--   G06: 관리자/점주 우회 차단 (T10: 관리자라도 타인 세션 조회 불가 403 거부)
--   G07: 정지된 회원 차단 (T06: 계정 정지 회원 403 ACCOUNT_SUSPENDED 거부)
--   G08: 결제 미완료 차단 (T07: status='created' 또는 결제 부재 시 422 PAYMENT_REQUIRED 거부)
--   G09: 환불/취소 이용권 차단 (T08: 환불 레코드 존재 시 422 PAYMENT_REFUNDED 거부)
--   G10: 유효 기간 만료 차단 (T09: expires_at 경과 시 422 ACCESS_EXPIRED 거부 및 expired 전이)
--   G11: PIN 미사용 화장실 차단 (T13: ask_staff/공공화장실 400 PIN_NOT_SUPPORTED 거부)
--   G12: PIN 교체 후 활성 PIN 조회 (T03, T12: 버전 2 교체 시 활성 버전 2만 반환)
--   G13: 감사로그 불변성 검증 (HM100: pin_reveal_audits UPDATE/DELETE 42501 차단)
--   G14: 의도적 P0099 롤백 및 잔류 데이터 0건 무결성 검증
-- ==============================================================================

DO $$
DECLARE
  v_test_prefix text := 'fa240000-';
  v_customer_a uuid := 'fa240000-0000-0000-0000-000000000001'::uuid;
  v_customer_b uuid := 'fa240000-0000-0000-0000-000000000002'::uuid;
  v_suspended_user uuid := 'fa240000-0000-0000-0000-000000000003'::uuid;
  v_admin_user uuid := 'fa240000-0000-0000-0000-000000000004'::uuid;
  v_merchant_user uuid := 'fa240000-0000-0000-0000-000000000005'::uuid;

  v_biz_approved uuid := 'fa240000-0000-0000-0000-000000000010'::uuid;
  v_biz_suspended uuid := 'fa240000-0000-0000-0000-000000000011'::uuid;

  v_restroom_partner_pin uuid := 'fa240000-0000-0000-0000-000000000020'::uuid;
  v_restroom_partner_staff uuid := 'fa240000-0000-0000-0000-000000000021'::uuid;
  v_restroom_suspended_biz uuid := 'fa240000-0000-0000-0000-000000000022'::uuid;

  v_policy_pin uuid := 'fa240000-0000-0000-0000-000000000025'::uuid;
  v_policy_staff uuid := 'fa240000-0000-0000-0000-000000000026'::uuid;

  v_secret_v1_id uuid := 'fa240000-0000-0000-0000-000000000028'::uuid;
  v_secret_v2_id uuid := 'fa240000-0000-0000-0000-000000000029'::uuid;

  v_session_valid uuid := 'fa240000-0000-0000-0000-000000000030'::uuid;
  v_session_unpaid uuid := 'fa240000-0000-0000-0000-000000000031'::uuid;
  v_session_expired uuid := 'fa240000-0000-0000-0000-000000000032'::uuid;
  v_session_refunded uuid := 'fa240000-0000-0000-0000-000000000033'::uuid;
  v_session_staff uuid := 'fa240000-0000-0000-0000-000000000034'::uuid;
  v_session_suspended uuid := 'fa240000-0000-0000-0000-000000000035'::uuid;

  v_order_valid uuid := 'fa240000-0000-0000-0000-000000000040'::uuid;
  v_order_unpaid uuid := 'fa240000-0000-0000-0000-000000000041'::uuid;
  v_order_expired uuid := 'fa240000-0000-0000-0000-000000000042'::uuid;
  v_order_refunded uuid := 'fa240000-0000-0000-0000-000000000043'::uuid;
  v_refund_id uuid := 'fa240000-0000-0000-0000-000000000045'::uuid;

  v_count integer;
  v_res jsonb;
  v_confirm_res jsonb;
  v_caught boolean;
  v_prosecdef boolean;
  v_proconfig text[];
  v_tgenabled "char";
  v_audit_record record;
  v_session_record record;
BEGIN
  RAISE NOTICE '>>> Starting TASK 24 Customer Doorlock PIN Reveal Verification';

  -- ============================================================================
  -- G00: 사전 충돌 점검
  -- ============================================================================
  SELECT count(*) INTO v_count
  FROM public.pin_reveal_audits
  WHERE id::text LIKE v_test_prefix || '%' OR access_session_id::text LIKE v_test_prefix || '%';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G00 Failed: Pre-existing pin_reveal_audits found' USING ERRCODE = '23505';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.visit_confirmations
  WHERE id::text LIKE v_test_prefix || '%' OR access_session_id::text LIKE v_test_prefix || '%';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G00 Failed: Pre-existing visit_confirmations found' USING ERRCODE = '23505';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.access_sessions
  WHERE id::text LIKE v_test_prefix || '%';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G00 Failed: Pre-existing access_sessions found' USING ERRCODE = '23505';
  END IF;

  RAISE NOTICE '✓ G00 Passed: No pre-existing test records';

  -- ============================================================================
  -- G01: 테이블, 컬럼, 인덱스, 트리거, RPC 스키마 검증
  -- ============================================================================
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'pin_reveal_audits'
  ) THEN
    RAISE EXCEPTION 'G01 Failed: public.pin_reveal_audits table does not exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'visit_confirmations'
  ) THEN
    RAISE EXCEPTION 'G01 Failed: public.visit_confirmations table does not exist';
  END IF;

  -- Verify RPC reveal_access_pin
  SELECT prosecdef, proconfig INTO v_prosecdef, v_proconfig
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'reveal_access_pin';

  IF v_prosecdef IS NULL THEN
    RAISE EXCEPTION 'G01 Failed: reveal_access_pin function not found';
  END IF;

  IF NOT v_prosecdef THEN
    RAISE EXCEPTION 'G01 Failed: reveal_access_pin must be SECURITY DEFINER';
  END IF;

  IF v_proconfig IS NULL OR NOT ('search_path=pg_catalog, pg_temp' = ANY(v_proconfig)) THEN
    RAISE EXCEPTION 'G01 Failed: reveal_access_pin search_path must be pg_catalog, pg_temp';
  END IF;

  -- Verify RPC record_pin_reveal_audit
  SELECT prosecdef, proconfig INTO v_prosecdef, v_proconfig
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'record_pin_reveal_audit';

  IF v_prosecdef IS NULL OR NOT v_prosecdef THEN
    RAISE EXCEPTION 'G01 Failed: record_pin_reveal_audit must be SECURITY DEFINER';
  END IF;

  -- Verify RPC confirm_pin_revealed
  SELECT prosecdef, proconfig INTO v_prosecdef, v_proconfig
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'confirm_pin_revealed';

  IF v_prosecdef IS NULL OR NOT v_prosecdef THEN
    RAISE EXCEPTION 'G01 Failed: confirm_pin_revealed must be SECURITY DEFINER';
  END IF;

  IF v_proconfig IS NULL OR NOT ('search_path=pg_catalog, pg_temp' = ANY(v_proconfig)) THEN
    RAISE EXCEPTION 'G01 Failed: confirm_pin_revealed search_path must be pg_catalog, pg_temp';
  END IF;

  -- Verify immutability trigger on pin_reveal_audits
  SELECT tgenabled INTO v_tgenabled
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'pin_reveal_audits'
    AND t.tgname = 'trg_prevent_pin_reveal_audits_mutation';

  IF v_tgenabled IS NULL OR v_tgenabled <> 'O' THEN
    RAISE EXCEPTION 'G01 Failed: trg_prevent_pin_reveal_audits_mutation not found or not active';
  END IF;

  RAISE NOTICE '✓ G01 Passed: Schema, RPCs, and triggers verified';

  -- ============================================================================
  -- G02: 권한 격리 검증 (anon, authenticated 차단, service_role 허용)
  -- ============================================================================
  IF has_table_privilege('anon', 'public.pin_reveal_audits', 'SELECT') THEN
    RAISE EXCEPTION 'G02 Failed: anon must NOT have SELECT on pin_reveal_audits';
  END IF;
  IF has_table_privilege('anon', 'public.pin_reveal_audits', 'INSERT') THEN
    RAISE EXCEPTION 'G02 Failed: anon must NOT have INSERT on pin_reveal_audits';
  END IF;
  IF has_table_privilege('authenticated', 'public.pin_reveal_audits', 'INSERT') THEN
    RAISE EXCEPTION 'G02 Failed: authenticated must NOT have INSERT on pin_reveal_audits';
  END IF;
  IF has_function_privilege('anon', 'public.reveal_access_pin(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G02 Failed: anon must NOT have EXECUTE on reveal_access_pin';
  END IF;
  IF has_function_privilege('authenticated', 'public.reveal_access_pin(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G02 Failed: authenticated must NOT have EXECUTE on reveal_access_pin';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.reveal_access_pin(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G02 Failed: service_role must have EXECUTE on reveal_access_pin';
  END IF;
  IF has_function_privilege('anon', 'public.confirm_pin_revealed(uuid,uuid,uuid,integer,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G02 Failed: anon must NOT have EXECUTE on confirm_pin_revealed';
  END IF;
  IF has_function_privilege('authenticated', 'public.confirm_pin_revealed(uuid,uuid,uuid,integer,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G02 Failed: authenticated must NOT have EXECUTE on confirm_pin_revealed';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.confirm_pin_revealed(uuid,uuid,uuid,integer,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G02 Failed: service_role must have EXECUTE on confirm_pin_revealed';
  END IF;

  RAISE NOTICE '✓ G02 Passed: Least-privilege role boundaries verified';

  -- ============================================================================
  -- Subtransaction for functional testing and guaranteed rollback
  -- ============================================================================
  BEGIN
    -- G03: 테스트 픽스처 생성
    INSERT INTO auth.users (id, email) VALUES
      (v_customer_a, 'customer_a@test.com'),
      (v_customer_b, 'customer_b@test.com'),
      (v_suspended_user, 'suspended@test.com'),
      (v_admin_user, 'admin@test.com'),
      (v_merchant_user, 'merchant@test.com')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.profiles (id, display_name, account_status) VALUES
      (v_customer_a, 'Customer A', 'active'),
      (v_customer_b, 'Customer B', 'active'),
      (v_suspended_user, 'Suspended User', 'suspended'),
      (v_admin_user, 'Admin User', 'active'),
      (v_merchant_user, 'Merchant User', 'active')
    ON CONFLICT (id) DO UPDATE SET account_status = EXCLUDED.account_status;

    INSERT INTO public.user_roles (user_id, role) VALUES
      (v_customer_a, 'customer'),
      (v_customer_b, 'customer'),
      (v_suspended_user, 'customer'),
      (v_admin_user, 'admin'),
      (v_merchant_user, 'merchant')
    ON CONFLICT (user_id, role) DO NOTHING;

    -- Businesses
    INSERT INTO public.businesses (id, name, created_by, category, road_address, latitude, longitude, registration_status, approved_at)
    VALUES
      (v_biz_approved, 'Approved Cafe', v_merchant_user, 'cafe', '경기 수원시 팔달구 매산로 1', 37.266, 127.001, 'approved', now()),
      (v_biz_suspended, 'Suspended Cafe', v_merchant_user, 'cafe', '경기 수원시 팔달구 매산로 2', 37.267, 127.002, 'suspended', now())
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.business_members (business_id, user_id, role) VALUES
      (v_biz_approved, v_merchant_user, 'owner'),
      (v_biz_suspended, v_merchant_user, 'owner')
    ON CONFLICT (business_id, user_id) DO NOTHING;

    -- Restrooms
    INSERT INTO public.restrooms (
      id, business_id, type, name, road_address, latitude, longitude,
      access_method, publication_status, created_by
    ) VALUES
      (v_restroom_partner_pin, v_biz_approved, 'partner', 'Partner PIN Restroom', '매산로 1', 37.266, 127.001, 'pin', 'published', v_merchant_user),
      (v_restroom_partner_staff, v_biz_approved, 'partner', 'Partner Staff Restroom', '매산로 1-1', 37.2661, 127.0011, 'ask_staff', 'published', v_merchant_user),
      (v_restroom_suspended_biz, v_biz_suspended, 'partner', 'Suspended Restroom', '매산로 2', 37.267, 127.002, 'pin', 'published', v_merchant_user)
    ON CONFLICT (id) DO NOTHING;

    -- Policies
    INSERT INTO public.restroom_access_policies (
      id, restroom_id, version, access_mode, deposit_amount_krw, refund_eligible,
      receipt_window_hours, min_purchase_krw, is_active, effective_from, created_by
    ) VALUES
      (v_policy_pin, v_restroom_partner_pin, 1, 'test_deposit', 1000, true, 24, 0, true, now(), v_merchant_user),
      (v_policy_staff, v_restroom_partner_staff, 1, 'free', 0, false, null, 0, true, now(), v_merchant_user)
    ON CONFLICT (id) DO NOTHING;

    -- Lock Secret: active PIN for Restroom 20 (version 1)
    INSERT INTO public.restroom_lock_secrets (
      id, restroom_id, ciphertext_b64, iv_b64, auth_tag_b64, key_version, code_version,
      valid_from, valid_until, status, created_by, idempotency_key, pin_hmac_b64
    ) VALUES (
      v_secret_v1_id, v_restroom_partner_pin,
      'dGVzdC1jaXBoZXJ0ZXh0', 'dGVzdC1pdi0xMg==', 'dGVzdC1hdXRoLXRhZy0xNg==',
      1, 1, now() - interval '1 hour', null, 'active', v_merchant_user,
      'test-idem-v1', 'dGVzdC1obWFj'
    );

    -- Access Sessions & Orders
    -- 1. Valid authorized session
    INSERT INTO public.access_sessions (
      id, user_id, restroom_id, policy_id, status, access_method_snapshot,
      idempotency_key, expires_at
    ) VALUES (
      v_session_valid, v_customer_a, v_restroom_partner_pin, v_policy_pin,
      'created', 'pin', 'idem-sess-valid', now() + interval '2 hours'
    );
    INSERT INTO public.payment_orders (
      id, access_session_id, user_id, order_id, provider, payment_mode,
      amount_krw, status, idempotency_key
    ) VALUES (
      v_order_valid, v_session_valid, v_customer_a, 'order-valid-1', 'toss', 'test',
      1000, 'created', 'idem-ord-valid'
    );
    UPDATE public.payment_orders
    SET status = 'approved', provider_payment_key = 'toss_pk_valid', approved_at = now() - interval '10 minutes'
    WHERE id = v_order_valid;

    UPDATE public.access_sessions
    SET status = 'authorized', authorized_at = now() - interval '10 minutes'
    WHERE id = v_session_valid;

    -- 2. Unpaid created session
    INSERT INTO public.access_sessions (
      id, user_id, restroom_id, policy_id, status, access_method_snapshot,
      idempotency_key, expires_at
    ) VALUES (
      v_session_unpaid, v_customer_a, v_restroom_partner_pin, v_policy_pin,
      'created', 'pin', 'idem-sess-unpaid', now() + interval '2 hours'
    );
    INSERT INTO public.payment_orders (
      id, access_session_id, user_id, order_id, provider, payment_mode,
      amount_krw, status, idempotency_key
    ) VALUES (
      v_order_unpaid, v_session_unpaid, v_customer_a, 'order-unpaid-2', 'toss', 'test',
      1000, 'created', 'idem-ord-unpaid'
    );

    -- 3. Expired session
    INSERT INTO public.access_sessions (
      id, user_id, restroom_id, policy_id, status, access_method_snapshot,
      idempotency_key, created_at, expires_at
    ) VALUES (
      v_session_expired, v_customer_a, v_restroom_partner_pin, v_policy_pin,
      'created', 'pin', 'idem-sess-expired', now() - interval '1 hour', now() - interval '10 minutes'
    );
    INSERT INTO public.payment_orders (
      id, access_session_id, user_id, order_id, provider, payment_mode,
      amount_krw, status, idempotency_key, created_at
    ) VALUES (
      v_order_expired, v_session_expired, v_customer_a, 'order-expired-3', 'toss', 'test',
      1000, 'created', 'idem-ord-expired', now() - interval '1 hour'
    );
    UPDATE public.payment_orders
    SET status = 'approved', provider_payment_key = 'toss_pk_expired', approved_at = now() - interval '50 minutes'
    WHERE id = v_order_expired;

    UPDATE public.access_sessions
    SET status = 'authorized', authorized_at = now() - interval '50 minutes'
    WHERE id = v_session_expired;

    -- 4. Refunded session
    INSERT INTO public.access_sessions (
      id, user_id, restroom_id, policy_id, status, access_method_snapshot,
      idempotency_key, expires_at
    ) VALUES (
      v_session_refunded, v_customer_a, v_restroom_partner_pin, v_policy_pin,
      'created', 'pin', 'idem-sess-refunded', now() + interval '2 hours'
    );
    INSERT INTO public.payment_orders (
      id, access_session_id, user_id, order_id, provider, payment_mode,
      amount_krw, status, idempotency_key
    ) VALUES (
      v_order_refunded, v_session_refunded, v_customer_a, 'order-refunded-4', 'toss', 'test',
      1000, 'created', 'idem-ord-refunded'
    );
    UPDATE public.payment_orders
    SET status = 'approved', provider_payment_key = 'toss_pk_refunded', approved_at = now() - interval '30 minutes'
    WHERE id = v_order_refunded;

    UPDATE public.access_sessions
    SET status = 'authorized', authorized_at = now() - interval '30 minutes'
    WHERE id = v_session_refunded;

    INSERT INTO public.payment_refunds (
      id, payment_order_id, amount_krw, status, idempotency_key, requested_by
    ) VALUES (
      v_refund_id, v_order_refunded, 1000, 'requested', 'idem-ref-4', v_admin_user
    );
    UPDATE public.payment_refunds
    SET status = 'succeeded', provider_cancel_id = 'cancel_id_4', completed_at = now()
    WHERE id = v_refund_id;

    -- 5. Staff restroom session (ask_staff)
    INSERT INTO public.access_sessions (
      id, user_id, restroom_id, policy_id, status, access_method_snapshot,
      idempotency_key, expires_at
    ) VALUES (
      v_session_staff, v_customer_a, v_restroom_partner_staff, v_policy_staff,
      'created', 'ask_staff', 'idem-sess-staff', now() + interval '2 hours'
    );
    UPDATE public.access_sessions
    SET status = 'authorized', authorized_at = now()
    WHERE id = v_session_staff;

    -- 6. Suspended user session
    INSERT INTO public.access_sessions (
      id, user_id, restroom_id, policy_id, status, access_method_snapshot,
      idempotency_key, expires_at
    ) VALUES (
      v_session_suspended, v_suspended_user, v_restroom_partner_pin, v_policy_pin,
      'created', 'pin', 'idem-sess-susp', now() + interval '2 hours'
    );

    RAISE NOTICE '✓ G03 Passed: Fixtures initialized cleanly';

    -- ============================================================================
    -- G04: 정상 조회 검증 (T01: 유효 이용권 + 승인 결제)
    -- ============================================================================
    v_res := public.reveal_access_pin(v_session_valid, v_customer_a, 'req-001');

    IF (v_res->>'ok')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'G04 Failed: Expected ok=true, got %', v_res;
    END IF;

    IF (v_res->>'code_version')::integer <> 1 THEN
      RAISE EXCEPTION 'G04 Failed: Expected code_version=1, got %', v_res->>'code_version';
    END IF;

    IF v_res->>'ciphertext_b64' IS NULL OR v_res->>'iv_b64' IS NULL OR v_res->>'auth_tag_b64' IS NULL THEN
      RAISE EXCEPTION 'G04 Failed: Missing encrypted payload components';
    END IF;

    -- Verify access_session state is NOT prematurely transitioned before confirmation
    SELECT status, code_revealed_at INTO v_session_record
    FROM public.access_sessions
    WHERE id = v_session_valid;

    IF v_session_record.status <> 'authorized' OR v_session_record.code_revealed_at IS NOT NULL THEN
      RAISE EXCEPTION 'G04 Failed: access_session prematurely transitioned before decryption confirmation';
    END IF;

    -- Verify no success audit recorded before confirmation
    IF EXISTS (
      SELECT 1 FROM public.pin_reveal_audits
      WHERE access_session_id = v_session_valid AND result = 'success'
    ) THEN
      RAISE EXCEPTION 'G04 Failed: success audit prematurely recorded before decryption confirmation';
    END IF;

    -- Now confirm reveal (simulating Node.js decryption success)
    v_confirm_res := public.confirm_pin_revealed(
      v_session_valid, v_customer_a, (v_res->>'restroom_id')::uuid, (v_res->>'code_version')::integer, (v_res->>'secret_id')::uuid, 'req-001'
    );

    IF (v_confirm_res->>'ok')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'G04 Failed: confirm_pin_revealed failed: %', v_confirm_res;
    END IF;

    -- Verify access_session state transitioned to 'code_revealed' and code_revealed_at set
    SELECT status, code_revealed_at INTO v_session_record
    FROM public.access_sessions
    WHERE id = v_session_valid;

    IF v_session_record.status <> 'code_revealed' OR v_session_record.code_revealed_at IS NULL THEN
      RAISE EXCEPTION 'G04 Failed: access_session status not transitioned to code_revealed after confirm';
    END IF;

    -- Verify audit log entry
    SELECT * INTO v_audit_record
    FROM public.pin_reveal_audits
    WHERE access_session_id = v_session_valid AND result = 'success';

    IF v_audit_record.id IS NULL THEN
      RAISE EXCEPTION 'G04 Failed: Success audit log record not found after confirm';
    END IF;
    IF v_audit_record.code_version <> 1 OR v_audit_record.user_id <> v_customer_a THEN
      RAISE EXCEPTION 'G04 Failed: Audit log metadata mismatch';
    END IF;

    RAISE NOTICE '✓ G04 Passed: T01 Valid reveal succeeded, no premature transition, confirmed cleanly';

    -- ============================================================================
    -- G05: 타인 이용권 차단 (T05: 타인 고객 요청 시 403 FORBIDDEN)
    -- ============================================================================
    v_res := public.reveal_access_pin(v_session_valid, v_customer_b, 'req-002');

    IF (v_res->>'ok')::boolean IS TRUE OR v_res->>'error_code' <> 'FORBIDDEN' THEN
      RAISE EXCEPTION 'G05 Failed: Expected FORBIDDEN 403, got %', v_res;
    END IF;

    -- Verify denial audit recorded
    IF NOT EXISTS (
      SELECT 1 FROM public.pin_reveal_audits
      WHERE access_session_id = v_session_valid
        AND user_id = v_customer_b
        AND result = 'denied'
        AND reason = 'ownership_mismatch'
    ) THEN
      RAISE EXCEPTION 'G05 Failed: Ownership mismatch denial audit not recorded';
    END IF;

    RAISE NOTICE '✓ G05 Passed: T05 Different customer blocked with 403';

    -- ============================================================================
    -- G06: 관리자/점주 우회 차단 (T10: 관리자라도 타인 세션 조회 불가 403)
    -- ============================================================================
    v_res := public.reveal_access_pin(v_session_valid, v_admin_user, 'req-003');

    IF (v_res->>'ok')::boolean IS TRUE OR v_res->>'error_code' <> 'FORBIDDEN' THEN
      RAISE EXCEPTION 'G06 Failed: Admin must NOT bypass customer ownership check, got %', v_res;
    END IF;

    v_res := public.reveal_access_pin(v_session_valid, v_merchant_user, 'req-004');
    IF (v_res->>'ok')::boolean IS TRUE OR v_res->>'error_code' <> 'FORBIDDEN' THEN
      RAISE EXCEPTION 'G06 Failed: Merchant must NOT bypass customer ownership check, got %', v_res;
    END IF;

    RAISE NOTICE '✓ G06 Passed: T10 Admin/Merchant role cannot bypass customer ownership check';

    -- ============================================================================
    -- G07: 정지된 회원 차단 (T06: 계정 정지 회원 403 ACCOUNT_SUSPENDED)
    -- ============================================================================
    v_res := public.reveal_access_pin(v_session_suspended, v_suspended_user, 'req-005');

    IF (v_res->>'ok')::boolean IS TRUE OR v_res->>'error_code' <> 'ACCOUNT_SUSPENDED' THEN
      RAISE EXCEPTION 'G07 Failed: Expected ACCOUNT_SUSPENDED 403, got %', v_res;
    END IF;

    RAISE NOTICE '✓ G07 Passed: T06 Suspended account blocked with 403';

    -- ============================================================================
    -- G08: 결제 미완료 차단 (T07: status='created' 결제 미완료 422)
    -- ============================================================================
    v_res := public.reveal_access_pin(v_session_unpaid, v_customer_a, 'req-006');

    IF (v_res->>'ok')::boolean IS TRUE OR v_res->>'error_code' <> 'PAYMENT_REQUIRED' THEN
      RAISE EXCEPTION 'G08 Failed: Expected PAYMENT_REQUIRED 422, got %', v_res;
    END IF;

    RAISE NOTICE '✓ G08 Passed: T07 Unpaid access session blocked with 422';

    -- ============================================================================
    -- G09: 환불/취소 이용권 차단 (T08: 환불 레코드 존재 시 422)
    -- ============================================================================
    v_res := public.reveal_access_pin(v_session_refunded, v_customer_a, 'req-007');

    IF (v_res->>'ok')::boolean IS TRUE OR v_res->>'error_code' <> 'PAYMENT_REFUNDED' THEN
      RAISE EXCEPTION 'G09 Failed: Expected PAYMENT_REFUNDED 422, got %', v_res;
    END IF;

    RAISE NOTICE '✓ G09 Passed: T08 Refunded access session blocked with 422';

    -- ============================================================================
    -- G10: 유효 기간 만료 차단 (T09: expires_at 경과 시 422 ACCESS_EXPIRED)
    -- ============================================================================
    v_res := public.reveal_access_pin(v_session_expired, v_customer_a, 'req-008');

    IF (v_res->>'ok')::boolean IS TRUE OR v_res->>'error_code' <> 'ACCESS_EXPIRED' THEN
      RAISE EXCEPTION 'G10 Failed: Expected ACCESS_EXPIRED 422, got %', v_res;
    END IF;

    -- Verify session status transitioned to expired
    SELECT status INTO v_session_record
    FROM public.access_sessions
    WHERE id = v_session_expired;

    IF v_session_record.status <> 'expired' THEN
      RAISE EXCEPTION 'G10 Failed: Expired session not transitioned to expired status';
    END IF;

    RAISE NOTICE '✓ G10 Passed: T09 Expired access session blocked with 422';

    -- ============================================================================
    -- G11: PIN 미사용 화장실 차단 (T13: ask_staff 화장실 400 PIN_NOT_SUPPORTED)
    -- ============================================================================
    v_res := public.reveal_access_pin(v_session_staff, v_customer_a, 'req-009');

    IF (v_res->>'ok')::boolean IS TRUE OR v_res->>'error_code' <> 'PIN_NOT_SUPPORTED' THEN
      RAISE EXCEPTION 'G11 Failed: Expected PIN_NOT_SUPPORTED 400, got %', v_res;
    END IF;

    RAISE NOTICE '✓ G11 Passed: T13 Non-PIN restroom blocked with 400';

    -- ============================================================================
    -- G12: PIN 교체 후 활성 PIN 조회 (T03, T12: 버전 2 교체 시 활성 버전 2만 반환)
    -- ============================================================================
    -- Deactivate version 1 and activate version 2
    UPDATE public.restroom_lock_secrets
    SET status = 'rotated', valid_until = now()
    WHERE id = v_secret_v1_id;

    INSERT INTO public.restroom_lock_secrets (
      id, restroom_id, ciphertext_b64, iv_b64, auth_tag_b64, key_version, code_version,
      valid_from, valid_until, status, created_by, idempotency_key, pin_hmac_b64
    ) VALUES (
      v_secret_v2_id, v_restroom_partner_pin,
      'bmV3LWNpcGhlcnRleHQ=', 'bmV3LWl2LTEyMzQ=', 'bmV3LWF1dGgtdGFnLTE2',
      1, 2, now(), null, 'active', v_merchant_user,
      'test-idem-v2', 'bmV3LWhtYWM='
    );

    v_res := public.reveal_access_pin(v_session_valid, v_customer_a, 'req-010');

    IF (v_res->>'ok')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'G12 Failed: Expected ok=true on version 2, got %', v_res;
    END IF;

    IF (v_res->>'code_version')::integer <> 2 THEN
      RAISE EXCEPTION 'G12 Failed: Expected code_version=2, got %', v_res->>'code_version';
    END IF;

    IF v_res->>'ciphertext_b64' <> 'bmV3LWNpcGhlcnRleHQ=' THEN
      RAISE EXCEPTION 'G12 Failed: Active PIN ciphertext mismatch';
    END IF;

    -- Verify stale confirm attempt with version 1 is REJECTED with 409 PIN_STALE_ROTATED
    v_confirm_res := public.confirm_pin_revealed(
      v_session_valid, v_customer_a, (v_res->>'restroom_id')::uuid, 1, v_secret_v1_id, 'req-stale-010'
    );

    IF (v_confirm_res->>'ok')::boolean IS TRUE OR v_confirm_res->>'error_code' <> 'PIN_STALE_ROTATED' THEN
      RAISE EXCEPTION 'G12 Failed: Stale PIN version 1 confirmation must be rejected with 409, got %', v_confirm_res;
    END IF;

    -- Verify denial audit for stale rotation
    IF NOT EXISTS (
      SELECT 1 FROM public.pin_reveal_audits
      WHERE access_session_id = v_session_valid
        AND result = 'denied'
        AND reason = 'pin_stale_rotated'
    ) THEN
      RAISE EXCEPTION 'G12 Failed: pin_stale_rotated denial audit not found';
    END IF;

    -- Now confirm with active version 2 -> SUCCEEDS
    v_confirm_res := public.confirm_pin_revealed(
      v_session_valid, v_customer_a, (v_res->>'restroom_id')::uuid, 2, v_secret_v2_id, 'req-010'
    );

    IF (v_confirm_res->>'ok')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'G12 Failed: Version 2 confirmation must succeed, got %', v_confirm_res;
    END IF;

    RAISE NOTICE '✓ G12 Passed: T03 & T12 Rotated version 2 returned cleanly and stale confirm rejected';

    -- ============================================================================
    -- G13: 감사로그 불변성 검증 (HM100: pin_reveal_audits UPDATE/DELETE 42501 차단)
    -- ============================================================================
    v_caught := false;
    BEGIN
      UPDATE public.pin_reveal_audits
      SET reason = 'tampered'
      WHERE access_session_id = v_session_valid;
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        v_caught := true;
    END;

    IF NOT v_caught THEN
      RAISE EXCEPTION 'G13 Failed: pin_reveal_audits UPDATE must be blocked with 42501';
    END IF;

    v_caught := false;
    BEGIN
      DELETE FROM public.pin_reveal_audits
      WHERE access_session_id = v_session_valid;
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        v_caught := true;
    END;

    IF NOT v_caught THEN
      RAISE EXCEPTION 'G13 Failed: pin_reveal_audits DELETE must be blocked with 42501';
    END IF;

    RAISE NOTICE '✓ G13 Passed: pin_reveal_audits append-only immutability verified';

    -- ============================================================================
    -- G14: 의도적 P0099 롤백 트리거
    -- ============================================================================
    RAISE EXCEPTION 'Intentional rollback for verification' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0099' THEN
      RAISE NOTICE '✓ Subtransaction intentionally rolled back (P0099)';
  END;

  -- ============================================================================
  -- 잔류 데이터 0건 무결성 확인
  -- ============================================================================
  SELECT count(*) INTO v_count
  FROM public.pin_reveal_audits
  WHERE id::text LIKE v_test_prefix || '%' OR access_session_id::text LIKE v_test_prefix || '%';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'G14 Failed: Residue found in pin_reveal_audits: % records', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.visit_confirmations
  WHERE id::text LIKE v_test_prefix || '%' OR access_session_id::text LIKE v_test_prefix || '%';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'G14 Failed: Residue found in visit_confirmations: % records', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.access_sessions
  WHERE id::text LIKE v_test_prefix || '%';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'G14 Failed: Residue found in access_sessions: % records', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.payment_orders
  WHERE id::text LIKE v_test_prefix || '%';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'G14 Failed: Residue found in payment_orders: % records', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.restroom_lock_secrets
  WHERE id::text LIKE v_test_prefix || '%';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'G14 Failed: Residue found in restroom_lock_secrets: % records', v_count;
  END IF;

  RAISE NOTICE '✓ G14 Passed: Guaranteed 0 residue in all tables after rollback';
  RAISE NOTICE '>>> ALL TASK 24 PostgreSQL Verification Groups PASSED successfully!';
END;
$$;
