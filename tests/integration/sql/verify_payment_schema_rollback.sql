-- ==============================================================================
-- Verification SQL: verify_payment_schema_rollback.sql
-- Description: TASK 20 - 테스트 보증금 주문 및 화장실 이용권 DB 스키마 롤백 검증 (보안 및 무결성 보완)
-- Spec: docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/07_PAYMENT_ACCESS_REFUND.md,
--       docs/08_SECURITY_OPERATIONS.md, docs/11_DECISIONS.md, tasks/20_payment_schema.md
-- Verification Groups:
--   G00: 충돌 사전 점검 (fa200000- 접두사 사전 잔류 레코드 부재 확인)
--   G01: 스키마 및 제약조건 검증 (테이블, 컬럼, 인덱스, FK)
--   G02: 테이블 및 컬럼 권한 분리 검증 (민감 컬럼 SELECT 차단, DML 차단)
--   G03: 테스트 픽스처 설정 (사용자, 가게, 화장실, 정책)
--   G04: access_sessions 무결성 및 상태 전이 검증 (approved 결제 부재 시 authorized 차단)
--   G05: payment_orders 무결성 및 승인 후 불변성 강화 검증 (key/시각 변경 차단)
--   G06: payment_refunds 무결성 및 완료 후 감사정보 불변성 검증 (cancel_id/시각 변경 차단)
--   G07: 감사 레코드 물리 삭제 차단 검증
--   G08: RLS 및 민감 컬럼 직접 SELECT 거부 검증 (SQL 42501 차단 및 본인 격리)
--   G09: event_logs.access_session_id 외래키 연동 검증
--   G10: P0099 의도적 서브트랜잭션 롤백 실행
--   G11: 롤백 후 잔류 데이터 0건 무결성 검증
-- ==============================================================================

DO $$
DECLARE
  v_test_prefix text := 'fa200000-';
  v_user_a_id uuid := 'fa200000-0000-0000-0000-000000000001'::uuid;
  v_user_b_id uuid := 'fa200000-0000-0000-0000-000000000002'::uuid;
  v_admin_id uuid := 'fa200000-0000-0000-0000-000000000003'::uuid;

  v_biz_id uuid := 'fa200000-0000-0000-0000-000000000010'::uuid;
  v_partner_restroom_id uuid := 'fa200000-0000-0000-0000-000000000020'::uuid;
  v_partner_policy_id uuid := 'fa200000-0000-0000-0000-000000000030'::uuid;

  v_public_source_id uuid := 'fa200000-0000-0000-0000-000000000040'::uuid;
  v_public_restroom_id uuid := 'fa200000-0000-0000-0000-000000000050'::uuid;
  v_public_policy_id uuid := 'fa200000-0000-0000-0000-000000000060'::uuid;

  v_session_1_id uuid := 'fa200000-0000-0000-0000-000000000101'::uuid;
  v_session_2_id uuid := 'fa200000-0000-0000-0000-000000000102'::uuid;

  v_order_1_id uuid := 'fa200000-0000-0000-0000-000000000201'::uuid;
  v_order_2_id uuid := 'fa200000-0000-0000-0000-000000000202'::uuid;

  v_refund_1_id uuid := 'fa200000-0000-0000-0000-000000000301'::uuid;
  v_receipt_dummy_id uuid := 'fa200000-0000-0000-0000-000000000350'::uuid;

  v_event_1_id uuid := 'fa200000-0000-0000-0000-000000000401'::uuid;

  v_orig_user text := current_user;
  v_count integer;
  v_caught_exception boolean;
  v_order_status text;
  v_refund_status text;
  v_authorized_at timestamptz;
  v_code_revealed_at timestamptz;
  v_completed_at timestamptz;
BEGIN
  RAISE NOTICE '>>> Starting TASK 20 Payment Schema & Integrity Verification (Refined)';

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

  SELECT count(*) INTO v_count
  FROM public.payment_refunds
  WHERE id::text LIKE v_test_prefix || '%';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G00 Failed: Pre-existing payment_refunds found' USING ERRCODE = '23505';
  END IF;

  RAISE NOTICE '✓ G00 Passed: No pre-existing test records';

  -- ============================================================================
  -- G01: 스키마 및 제약조건 검증
  -- ============================================================================
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'access_sessions') THEN
    RAISE EXCEPTION 'G01 Failed: public.access_sessions does not exist';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'payment_orders') THEN
    RAISE EXCEPTION 'G01 Failed: public.payment_orders does not exist';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'payment_refunds') THEN
    RAISE EXCEPTION 'G01 Failed: public.payment_refunds does not exist';
  END IF;

  -- 1이용권 1성공결제 부분 고유 인덱스 확인
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'payment_orders'
      AND indexname = 'idx_payment_orders_single_approved_per_session'
  ) THEN
    RAISE EXCEPTION 'G01 Failed: idx_payment_orders_single_approved_per_session index does not exist';
  END IF;

  -- 1결제 1전액환불 UNIQUE 제약조건 확인
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'payment_refunds'
      AND constraint_type = 'UNIQUE'
  ) THEN
    RAISE EXCEPTION 'G01 Failed: payment_refunds unique constraint does not exist';
  END IF;

  -- event_logs.access_session_id 외래키 확인
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'event_logs'
      AND constraint_name = 'fk_event_logs_access_session_id'
  ) THEN
    RAISE EXCEPTION 'G01 Failed: fk_event_logs_access_session_id foreign key does not exist';
  END IF;

  RAISE NOTICE '✓ G01 Passed: Schema, indexes, and foreign keys verified';

  -- ============================================================================
  -- G02: 권한 분리 및 컬럼 보안 검증 (민감 컬럼 직접 접근 차단)
  -- ============================================================================
  -- 1) anon은 테이블 일체 접근 불가
  IF has_table_privilege('anon', 'public.access_sessions', 'SELECT') THEN
    RAISE EXCEPTION 'G02 Failed: anon should not have SELECT on access_sessions';
  END IF;
  IF has_table_privilege('anon', 'public.payment_orders', 'SELECT') THEN
    RAISE EXCEPTION 'G02 Failed: anon should not have SELECT on payment_orders';
  END IF;
  IF has_table_privilege('anon', 'public.payment_refunds', 'SELECT') THEN
    RAISE EXCEPTION 'G02 Failed: anon should not have SELECT on payment_refunds';
  END IF;

  -- 2) authenticated는 INSERT, UPDATE, DELETE 권한 일체 없음
  IF has_table_privilege('authenticated', 'public.access_sessions', 'INSERT')
     OR has_table_privilege('authenticated', 'public.access_sessions', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.access_sessions', 'DELETE') THEN
    RAISE EXCEPTION 'G02 Failed: authenticated should not have DML on access_sessions';
  END IF;

  IF has_table_privilege('authenticated', 'public.payment_orders', 'INSERT')
     OR has_table_privilege('authenticated', 'public.payment_orders', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.payment_orders', 'DELETE') THEN
    RAISE EXCEPTION 'G02 Failed: authenticated should not have DML on payment_orders';
  END IF;

  IF has_table_privilege('authenticated', 'public.payment_refunds', 'INSERT')
     OR has_table_privilege('authenticated', 'public.payment_refunds', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.payment_refunds', 'DELETE') THEN
    RAISE EXCEPTION 'G02 Failed: authenticated should not have DML on payment_refunds';
  END IF;

  -- 3) authenticated는 민감 컬럼 SELECT 권한이 없어야 함
  IF has_column_privilege('authenticated', 'public.payment_orders', 'provider_payment_key', 'SELECT') THEN
    RAISE EXCEPTION 'G02 Failed: authenticated MUST NOT have SELECT on payment_orders.provider_payment_key';
  END IF;

  IF has_column_privilege('authenticated', 'public.payment_orders', 'idempotency_key', 'SELECT') THEN
    RAISE EXCEPTION 'G02 Failed: authenticated MUST NOT have SELECT on payment_orders.idempotency_key';
  END IF;

  IF has_column_privilege('authenticated', 'public.payment_refunds', 'provider_cancel_id', 'SELECT') THEN
    RAISE EXCEPTION 'G02 Failed: authenticated MUST NOT have SELECT on payment_refunds.provider_cancel_id';
  END IF;

  IF has_column_privilege('authenticated', 'public.payment_refunds', 'idempotency_key', 'SELECT') THEN
    RAISE EXCEPTION 'G02 Failed: authenticated MUST NOT have SELECT on payment_refunds.idempotency_key';
  END IF;

  IF has_column_privilege('authenticated', 'public.access_sessions', 'idempotency_key', 'SELECT') THEN
    RAISE EXCEPTION 'G02 Failed: authenticated MUST NOT have SELECT on access_sessions.idempotency_key';
  END IF;

  -- 4) 안전한 컬럼은 정상 SELECT 권한 보유 확인
  IF NOT has_column_privilege('authenticated', 'public.payment_orders', 'order_id', 'SELECT') THEN
    RAISE EXCEPTION 'G02 Failed: authenticated should have SELECT on payment_orders.order_id';
  END IF;

  IF NOT has_column_privilege('authenticated', 'public.access_sessions', 'status', 'SELECT') THEN
    RAISE EXCEPTION 'G02 Failed: authenticated should have SELECT on access_sessions.status';
  END IF;

  RAISE NOTICE '✓ G02 Passed: Column-level permissions strictly restrict sensitive keys';

  -- ============================================================================
  -- 서브트랜잭션: 테스트 데이터 생성, 비즈니스 규칙 검증 및 롤백
  -- ============================================================================
  BEGIN
    -- G03: 테스트 픽스처 생성
    -- 1) 사용자 계정
    INSERT INTO auth.users (id, email) VALUES
      (v_user_a_id, 'user_a_task20@example.com'),
      (v_user_b_id, 'user_b_task20@example.com'),
      (v_admin_id, 'admin_task20@example.com');

    INSERT INTO public.profiles (id, display_name, preferred_language, account_status) VALUES
      (v_user_a_id, 'User A', 'ko', 'active'),
      (v_user_b_id, 'User B', 'ko', 'active'),
      (v_admin_id, 'Admin User', 'ko', 'active')
    ON CONFLICT (id) DO UPDATE SET account_status = 'active';

    INSERT INTO public.user_roles (user_id, role) VALUES
      (v_user_a_id, 'customer'),
      (v_user_b_id, 'customer'),
      (v_admin_id, 'admin')
    ON CONFLICT (user_id, role) DO NOTHING;

    -- 2) 제휴 점포 및 제휴 화장실, 정책
    INSERT INTO public.businesses (
      id, name, category, road_address, latitude, longitude, registration_status, approved_by, approved_at, created_by
    ) VALUES (
      v_biz_id, '테스트 제휴카페 20', '카페', '경기도 수원시 팔달구 매산로 1',
      37.2660, 127.0010, 'approved', v_admin_id, now(), v_user_a_id
    );

    INSERT INTO public.restrooms (
      id, business_id, type, name, road_address, latitude, longitude,
      access_method, publication_status, approved_by, last_verified_at, created_by
    ) VALUES (
      v_partner_restroom_id, v_biz_id, 'partner', '제휴카페 전용화장실',
      '경기도 수원시 팔달구 매산로 1', 37.2660, 127.0010, 'pin', 'published', v_admin_id, now(), v_user_a_id
    );

    INSERT INTO public.restroom_access_policies (
      id, restroom_id, version, access_mode, deposit_amount_krw,
      refund_eligible, receipt_window_hours, min_purchase_krw, is_active, effective_from, created_by
    ) VALUES (
      v_partner_policy_id, v_partner_restroom_id, 1, 'test_deposit', 1000,
      true, 24, 0, true, now(), v_user_a_id
    );

    -- 3) 공공 화장실 및 정책
    INSERT INTO public.public_data_sources (
      id, provider_name, dataset_name, source_url
    ) VALUES (
      v_public_source_id, '수원시', '공중화장실', 'https://example.com'
    );

    INSERT INTO public.restrooms (
      id, source_id, type, name, road_address, latitude, longitude,
      access_method, publication_status
    ) VALUES (
      v_public_restroom_id, v_public_source_id, 'public', '수원역 공공화장실',
      '경기도 수원시 팔달구 덕영대로 924', 37.2655, 127.0005, 'open', 'published'
    );

    INSERT INTO public.restroom_access_policies (
      id, restroom_id, version, access_mode, deposit_amount_krw,
      refund_eligible, is_active, effective_from
    ) VALUES (
      v_public_policy_id, v_public_restroom_id, 1, 'free', 0,
      false, true, now()
    );

    RAISE NOTICE '✓ G03 Passed: Test fixtures created';

    -- ============================================================================
    -- G04: access_sessions 무결성 및 상태 전이 검증
    -- ============================================================================
    -- 0) 결제 전 직접 authorized 상태로 이용권 생성 시도 차단 (HM029)
    v_caught_exception := false;
    BEGIN
      INSERT INTO public.access_sessions (
        id, user_id, restroom_id, policy_id, status, access_method_snapshot, idempotency_key, expires_at
      ) VALUES (
        gen_random_uuid(), v_user_a_id, v_partner_restroom_id, v_partner_policy_id, 'authorized', 'pin',
        'idem_direct_auth_001', now() + interval '1 hour'
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '22023' AND SQLERRM LIKE '%HM029%' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G04 Failed: Direct authorized access session creation was not rejected';
    END IF;

    -- 1) 공공 화장실에 대한 이용권 생성 시도 차단 (HM021)
    v_caught_exception := false;
    BEGIN
      INSERT INTO public.access_sessions (
        id, user_id, restroom_id, policy_id, access_method_snapshot, idempotency_key, expires_at
      ) VALUES (
        gen_random_uuid(), v_user_a_id, v_public_restroom_id, v_public_policy_id, 'open',
        'idem_public_session_001', now() + interval '1 hour'
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '22023' AND SQLERRM LIKE '%HM021%' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G04 Failed: Public restroom access session was not rejected';
    END IF;

    -- 2) 타 화장실 정책과의 불일치 생성 차단 (HM020)
    v_caught_exception := false;
    BEGIN
      INSERT INTO public.access_sessions (
        id, user_id, restroom_id, policy_id, access_method_snapshot, idempotency_key, expires_at
      ) VALUES (
        gen_random_uuid(), v_user_a_id, v_partner_restroom_id, v_public_policy_id, 'pin',
        'idem_mismatch_policy_001', now() + interval '1 hour'
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '22023' AND SQLERRM LIKE '%HM020%' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G04 Failed: Mismatched policy access session was not rejected';
    END IF;

    -- 3) 만료시각이 생성시각보다 이전/동일한 경우 차단 (HM028 / chk_access_sessions_expiry)
    v_caught_exception := false;
    BEGIN
      INSERT INTO public.access_sessions (
        id, user_id, restroom_id, policy_id, access_method_snapshot, idempotency_key, expires_at
      ) VALUES (
        gen_random_uuid(), v_user_a_id, v_partner_restroom_id, v_partner_policy_id, 'pin',
        'idem_invalid_expiry_001', now() - interval '1 hour'
      );
    EXCEPTION WHEN OTHERS THEN
      v_caught_exception := true;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G04 Failed: Expired creation was not rejected';
    END IF;

    -- 4) 정상 제휴 이용권 1 생성 (status: created)
    INSERT INTO public.access_sessions (
      id, user_id, restroom_id, policy_id, access_method_snapshot, idempotency_key, expires_at
    ) VALUES (
      v_session_1_id, v_user_a_id, v_partner_restroom_id, v_partner_policy_id, 'pin',
      'idem_session_1_valid', now() + interval '1 hour'
    );

    -- 5) 중복 idempotency_key 차단 (23505)
    v_caught_exception := false;
    BEGIN
      INSERT INTO public.access_sessions (
        id, user_id, restroom_id, policy_id, access_method_snapshot, idempotency_key, expires_at
      ) VALUES (
        gen_random_uuid(), v_user_a_id, v_partner_restroom_id, v_partner_policy_id, 'pin',
        'idem_session_1_valid', now() + interval '1 hour'
      );
    EXCEPTION WHEN unique_violation THEN
      v_caught_exception := true;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G04 Failed: Duplicate idempotency_key was not rejected';
    END IF;

    -- 6) 승인된 결제 주문이 없는 상태에서 authorized 상태 전이 시도 차단 (HM022)
    v_caught_exception := false;
    BEGIN
      UPDATE public.access_sessions
      SET status = 'authorized'
      WHERE id = v_session_1_id;
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '22023' AND SQLERRM LIKE '%HM022%' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G04 Failed: Transition to authorized without approved payment order was not rejected';
    END IF;

    -- 7) 불변 컬럼 수정 시도 차단 (HM024)
    v_caught_exception := false;
    BEGIN
      UPDATE public.access_sessions
      SET user_id = v_user_b_id
      WHERE id = v_session_1_id;
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '42501' AND SQLERRM LIKE '%HM024%' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G04 Failed: Access session user_id update was not rejected';
    END IF;

    RAISE NOTICE '✓ G04 Passed: Access sessions invariants and transitions verified';

    -- ============================================================================
    -- G05: payment_orders 무결성, 승인 불변성 및 1이용권 1성공결제 검증
    -- ============================================================================
    -- 1) 금액 <= 0 차단 (CHECK constraint / HM037)
    v_caught_exception := false;
    BEGIN
      INSERT INTO public.payment_orders (
        id, access_session_id, user_id, order_id, amount_krw, idempotency_key
      ) VALUES (
        gen_random_uuid(), v_session_1_id, v_user_a_id, 'ord_zero_amount_001', 0, 'idem_ord_zero'
      );
    EXCEPTION WHEN check_violation THEN
      v_caught_exception := true;
    WHEN OTHERS THEN
      IF SQLSTATE IN ('23514', '22023') THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G05 Failed: Zero amount payment order was not rejected';
    END IF;

    -- 2) 타인 이용권 결제 시도 차단 (User B가 User A 이용권 결제 시도 -> HM030)
    v_caught_exception := false;
    BEGIN
      INSERT INTO public.payment_orders (
        id, access_session_id, user_id, order_id, amount_krw, idempotency_key
      ) VALUES (
        gen_random_uuid(), v_session_1_id, v_user_b_id, 'ord_mismatch_owner_001', 1000, 'idem_ord_mismatch'
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '22023' AND SQLERRM LIKE '%HM030%' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G05 Failed: Mismatched order owner was not rejected';
    END IF;

    -- 3) 정책 스냅샷 금액 불일치 차단 (HM031: 정책은 1000원인데 2000원 시도)
    v_caught_exception := false;
    BEGIN
      INSERT INTO public.payment_orders (
        id, access_session_id, user_id, order_id, amount_krw, idempotency_key
      ) VALUES (
        gen_random_uuid(), v_session_1_id, v_user_a_id, 'ord_mismatch_amount_001', 2000, 'idem_ord_bad_amount'
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '22023' AND SQLERRM LIKE '%HM031%' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G05 Failed: Amount mismatch against policy was not rejected';
    END IF;

    -- 4) 정상 주문 1 생성 (status: created, amount: 1000)
    INSERT INTO public.payment_orders (
      id, access_session_id, user_id, order_id, amount_krw, idempotency_key
    ) VALUES (
      v_order_1_id, v_session_1_id, v_user_a_id, 'order_toss_20261114_001', 1000, 'idem_order_1_key'
    );

    -- 5) 중복 order_id 차단 (23505)
    v_caught_exception := false;
    BEGIN
      INSERT INTO public.payment_orders (
        id, access_session_id, user_id, order_id, amount_krw, idempotency_key
      ) VALUES (
        gen_random_uuid(), v_session_1_id, v_user_a_id, 'order_toss_20261114_001', 1000, 'idem_order_dup_id'
      );
    EXCEPTION WHEN unique_violation THEN
      v_caught_exception := true;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G05 Failed: Duplicate order_id was not rejected';
    END IF;

    -- 6) 불변 컬럼(amount_krw) 수정 시도 차단 (HM032)
    v_caught_exception := false;
    BEGIN
      UPDATE public.payment_orders
      SET amount_krw = 500
      WHERE id = v_order_1_id;
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '42501' AND SQLERRM LIKE '%HM032%' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G05 Failed: Payment amount modification was not rejected';
    END IF;

    -- 7) 결제 승인 전이: created -> approved
    -- provider_payment_key 없이 approved 시도 차단 (HM035)
    v_caught_exception := false;
    BEGIN
      UPDATE public.payment_orders
      SET status = 'approved'
      WHERE id = v_order_1_id;
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '22023' AND SQLERRM LIKE '%HM035%' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G05 Failed: Approved without payment_key was not rejected';
    END IF;

    -- 정상 approved 전이 (provider_payment_key 제공)
    UPDATE public.payment_orders
    SET status = 'approved',
        provider_payment_key = 'toss_paykey_test_0001'
    WHERE id = v_order_1_id;

    SELECT status, approved_at INTO v_order_status, v_authorized_at
    FROM public.payment_orders
    WHERE id = v_order_1_id;
    IF v_order_status <> 'approved' OR v_authorized_at IS NULL THEN
      RAISE EXCEPTION 'G05 Failed: Payment order status or approved_at invalid';
    END IF;

    -- 8) 승인 완료 후 불변성 강화 검증:
    --    8-A) approved 상태에서 provider_payment_key 변경 시도 차단 (HM036)
    v_caught_exception := false;
    BEGIN
      UPDATE public.payment_orders
      SET provider_payment_key = 'toss_paykey_mutated_0001'
      WHERE id = v_order_1_id;
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '42501' AND SQLERRM LIKE '%HM036%' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G05 Failed: provider_payment_key mutation on approved order was not rejected';
    END IF;

    --    8-B) approved 상태에서 approved_at 변경 시도 차단 (HM039)
    v_caught_exception := false;
    BEGIN
      UPDATE public.payment_orders
      SET approved_at = now() - interval '2 days'
      WHERE id = v_order_1_id;
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '42501' AND SQLERRM LIKE '%HM039%' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G05 Failed: approved_at mutation on approved order was not rejected';
    END IF;

    --    8-C) approved 상태에서 failed 등으로 불법 전이 차단 (HM033)
    v_caught_exception := false;
    BEGIN
      UPDATE public.payment_orders
      SET status = 'failed'
      WHERE id = v_order_1_id;
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '22023' AND SQLERRM LIKE '%HM033%' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G05 Failed: Mutating approved order status was not rejected';
    END IF;

    -- 9) 이제 approved 결제 주문이 존재하므로 v_session_1_id의 authorized 전이 정상 성공
    UPDATE public.access_sessions
    SET status = 'authorized'
    WHERE id = v_session_1_id;

    SELECT status, authorized_at INTO v_order_status, v_authorized_at
    FROM public.access_sessions
    WHERE id = v_session_1_id;
    IF v_order_status <> 'authorized' OR v_authorized_at IS NULL THEN
      RAISE EXCEPTION 'G05 Failed: access_session was not authorized after payment approval';
    END IF;

    -- authorized -> code_revealed 전이
    UPDATE public.access_sessions
    SET status = 'code_revealed'
    WHERE id = v_session_1_id;

    SELECT code_revealed_at INTO v_code_revealed_at
    FROM public.access_sessions
    WHERE id = v_session_1_id;
    IF v_code_revealed_at IS NULL THEN
      RAISE EXCEPTION 'G05 Failed: code_revealed_at was not populated';
    END IF;

    -- code_revealed -> completed 전이
    UPDATE public.access_sessions
    SET status = 'completed'
    WHERE id = v_session_1_id;

    -- completed 종료 상태 변경 차단 (HM025)
    v_caught_exception := false;
    BEGIN
      UPDATE public.access_sessions
      SET status = 'authorized'
      WHERE id = v_session_1_id;
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '22023' AND SQLERRM LIKE '%HM025%' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G05 Failed: Transitioning completed session was not rejected';
    END IF;

    -- 10) 결제 주문 초기 생성 상태 강제 및 세션당 단일 approved 불변식 검증
    -- 10-A) approved 상태로 직접 생성 시도 차단 (HM038)
    v_caught_exception := false;
    BEGIN
      INSERT INTO public.payment_orders (
        id, access_session_id, user_id, order_id, amount_krw, status,
        provider_payment_key, idempotency_key
      ) VALUES (
        v_order_2_id, v_session_1_id, v_user_a_id, 'order_toss_20261114_002', 1000, 'approved',
        'toss_paykey_test_0002', 'idem_order_2_key'
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '22023' AND SQLERRM LIKE '%HM038%' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G05 Failed: Creating payment order directly in approved status was not rejected';
    END IF;

    -- 10-B) 한 이용권당 성공 결제는 최대 하나만 허용 (idx_payment_orders_single_approved_per_session)
    -- created로 정상 삽입 후, 동일 세션 v_session_1_id에 대해 두 번째 approved 전이 시도 차단
    INSERT INTO public.payment_orders (
      id, access_session_id, user_id, order_id, amount_krw, status,
      provider_payment_key, idempotency_key
    ) VALUES (
      v_order_2_id, v_session_1_id, v_user_a_id, 'order_toss_20261114_002', 1000, 'created',
      NULL, 'idem_order_2_key'
    );

    v_caught_exception := false;
    BEGIN
      UPDATE public.payment_orders
      SET status = 'approved',
          provider_payment_key = 'toss_paykey_test_0002'
      WHERE id = v_order_2_id;
    EXCEPTION WHEN unique_violation THEN
      v_caught_exception := true;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G05 Failed: Multiple approved payment orders on single session was not rejected';
    END IF;

    RAISE NOTICE '✓ G05 Passed: Payment orders invariants, approved immutability, and single approved rule verified';

    -- ============================================================================
    -- G06: payment_refunds 무결성 및 완료 후 감사정보 불변성 검증
    -- ============================================================================
    -- 0) 직접 succeeded 상태로 환급 생성 시도 차단 (HM048: requested 상태로 시작 필수)
    v_caught_exception := false;
    BEGIN
      INSERT INTO public.payment_refunds (
        id, payment_order_id, amount_krw, status, idempotency_key, requested_by
      ) VALUES (
        gen_random_uuid(), v_order_1_id, 1000, 'succeeded', 'refund_direct_succ_001', v_admin_id
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '22023' AND SQLERRM LIKE '%HM048%' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G06 Failed: Direct succeeded refund creation was not rejected';
    END IF;

    -- 1) 일반 회원(customer)의 환급 요청 차단 (HM042)
    v_caught_exception := false;
    BEGIN
      INSERT INTO public.payment_refunds (
        id, payment_order_id, amount_krw, idempotency_key, requested_by
      ) VALUES (
        gen_random_uuid(), v_order_1_id, 1000, 'refund_idem_cust_001', v_user_a_id
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '42501' AND SQLERRM LIKE '%HM042%' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G06 Failed: Customer refund request was not rejected';
    END IF;

    -- 2) 전액이 아닌 부분 환급 시도 차단 (HM041: 500원 시도)
    v_caught_exception := false;
    BEGIN
      INSERT INTO public.payment_refunds (
        id, payment_order_id, amount_krw, idempotency_key, requested_by
      ) VALUES (
        gen_random_uuid(), v_order_1_id, 500, 'refund_idem_partial_001', v_admin_id
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '22023' AND SQLERRM LIKE '%HM041%' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G06 Failed: Partial refund amount was not rejected';
    END IF;

    -- 3) 관리자에 의한 정상 전액 환급 생성 (status: requested, amount: 1000, receipt_submission_id 할당)
    INSERT INTO public.payment_refunds (
      id, payment_order_id, receipt_submission_id, amount_krw, status, idempotency_key, requested_by
    ) VALUES (
      v_refund_1_id, v_order_1_id, v_receipt_dummy_id, 1000, 'requested', 'refund_idem_valid_001', v_admin_id
    );

    -- 4) 동일 payment_order에 대한 두 번째 환급 생성 차단 (1결제 1전액환급 원칙: UNIQUE 제약)
    v_caught_exception := false;
    BEGIN
      INSERT INTO public.payment_refunds (
        id, payment_order_id, amount_krw, status, idempotency_key, requested_by
      ) VALUES (
        gen_random_uuid(), v_order_1_id, 1000, 'requested', 'refund_idem_dup_order', v_admin_id
      );
    EXCEPTION WHEN unique_violation THEN
      v_caught_exception := true;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G06 Failed: Second refund for payment order was not rejected';
    END IF;

    -- 5) receipt_submission_id 사후 변경 시도 차단 (HM049)
    v_caught_exception := false;
    BEGIN
      UPDATE public.payment_refunds
      SET receipt_submission_id = gen_random_uuid()
      WHERE id = v_refund_1_id;
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '42501' AND SQLERRM LIKE '%HM049%' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G06 Failed: Modifying assigned receipt_submission_id was not rejected';
    END IF;

    -- 5-B) provider_cancel_id 없이 succeeded 전이 시도 차단 (HM051: NULL 거부)
    v_caught_exception := false;
    BEGIN
      UPDATE public.payment_refunds
      SET status = 'succeeded',
          provider_cancel_id = NULL
      WHERE id = v_refund_1_id;
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '22023' AND SQLERRM LIKE '%HM051%' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G06 Failed: Succeeded refund without provider_cancel_id was not rejected';
    END IF;

    -- 5-C) provider_cancel_id 빈 공백 문자열로 succeeded 전이 시도 차단 (HM051: 공백 거부)
    v_caught_exception := false;
    BEGIN
      UPDATE public.payment_refunds
      SET status = 'succeeded',
          provider_cancel_id = '   '
      WHERE id = v_refund_1_id;
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '22023' AND SQLERRM LIKE '%HM051%' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G06 Failed: Succeeded refund with blank provider_cancel_id was not rejected';
    END IF;

    -- 6) 환급 완료 전이: requested -> succeeded (provider_cancel_id 제공 및 completed_at 설정 확인)
    UPDATE public.payment_refunds
    SET status = 'succeeded',
        provider_cancel_id = 'cancel_trans_toss_001'
    WHERE id = v_refund_1_id;

    SELECT status, completed_at INTO v_refund_status, v_completed_at
    FROM public.payment_refunds
    WHERE id = v_refund_1_id;
    IF v_refund_status <> 'succeeded' OR v_completed_at IS NULL THEN
      RAISE EXCEPTION 'G06 Failed: completed_at was not populated on succeeded refund';
    END IF;

    -- 7) 완료 후 감사정보 보호 검증:
    --    7-A) succeeded 상태에서 provider_cancel_id 변경 시도 차단 (HM046)
    v_caught_exception := false;
    BEGIN
      UPDATE public.payment_refunds
      SET provider_cancel_id = 'cancel_trans_mutated_002'
      WHERE id = v_refund_1_id;
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '42501' AND SQLERRM LIKE '%HM046%' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G06 Failed: provider_cancel_id mutation on succeeded refund was not rejected';
    END IF;

    --    7-B) succeeded 상태에서 completed_at 변경 시도 차단 (HM050)
    v_caught_exception := false;
    BEGIN
      UPDATE public.payment_refunds
      SET completed_at = now() - interval '5 days'
      WHERE id = v_refund_1_id;
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '42501' AND SQLERRM LIKE '%HM050%' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G06 Failed: completed_at mutation on succeeded refund was not rejected';
    END IF;

    --    7-C) succeeded 상태에서 failed 상태로 역전이 차단 (HM044)
    v_caught_exception := false;
    BEGIN
      UPDATE public.payment_refunds
      SET status = 'failed'
      WHERE id = v_refund_1_id;
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '22023' AND SQLERRM LIKE '%HM044%' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G06 Failed: Transitioning succeeded refund was not rejected';
    END IF;

    RAISE NOTICE '✓ G06 Passed: Payment refunds invariants and completed audit immutability verified';

    -- ============================================================================
    -- G07: 감사 레코드 물리 삭제 차단 검증
    -- ============================================================================
    v_caught_exception := false;
    BEGIN
      DELETE FROM public.payment_refunds WHERE id = v_refund_1_id;
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '42501' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G07 Failed: payment_refunds deletion was not blocked';
    END IF;

    v_caught_exception := false;
    BEGIN
      DELETE FROM public.payment_orders WHERE id = v_order_1_id;
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '42501' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G07 Failed: payment_orders deletion was not blocked';
    END IF;

    v_caught_exception := false;
    BEGIN
      DELETE FROM public.access_sessions WHERE id = v_session_1_id;
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '42501' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G07 Failed: access_sessions deletion was not blocked';
    END IF;

    RAISE NOTICE '✓ G07 Passed: Physical deletion strictly prohibited';

    -- ============================================================================
    -- G08: RLS 및 민감 컬럼 직접 SELECT 차단 검증
    -- ============================================================================
    -- 1) User B (타인) 컨텍스트로 조회 시 User A의 레코드 0건 반환 확인
    PERFORM set_config('role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', v_user_b_id::text, true);

    SELECT count(*) INTO v_count
    FROM public.access_sessions
    WHERE id = v_session_1_id;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'G08 Failed: User B was able to see User A access_session';
    END IF;

    SELECT count(*) INTO v_count
    FROM public.payment_orders
    WHERE id = v_order_1_id;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'G08 Failed: User B was able to see User A payment_order';
    END IF;

    SELECT count(*) INTO v_count
    FROM public.payment_refunds
    WHERE id = v_refund_1_id;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'G08 Failed: User B was able to see User A payment_refund';
    END IF;

    -- 2) User A (본인) 컨텍스트:
    PERFORM set_config('role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', v_user_a_id::text, true);

    -- 2-A) 본인 안전 컬럼 정상 조회 확인
    SELECT count(*) INTO v_count
    FROM public.access_sessions
    WHERE id = v_session_1_id;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'G08 Failed: User A could not see own access_session';
    END IF;

    SELECT count(*) INTO v_count
    FROM public.payment_orders
    WHERE id = v_order_1_id;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'G08 Failed: User A could not see own payment_order';
    END IF;

    SELECT count(*) INTO v_count
    FROM public.payment_refunds
    WHERE id = v_refund_1_id;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'G08 Failed: User A could not see own payment_refund';
    END IF;

    -- 2-B) 일반 회원의 민감 컬럼 직접 SELECT 차단 검증 (PostgreSQL 42501 거부)
    -- provider_payment_key 직접 조회 시도 차단
    v_caught_exception := false;
    BEGIN
      EXECUTE 'SELECT provider_payment_key FROM public.payment_orders WHERE id = ' || quote_literal(v_order_1_id);
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '42501' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G08 Failed: Direct SELECT of provider_payment_key by authenticated was not blocked';
    END IF;

    -- SELECT * 시도 차단 (미부여 컬럼 포함으로 42501)
    v_caught_exception := false;
    BEGIN
      EXECUTE 'SELECT * FROM public.payment_orders WHERE id = ' || quote_literal(v_order_1_id);
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '42501' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G08 Failed: Direct SELECT * on payment_orders by authenticated was not blocked';
    END IF;

    -- provider_cancel_id 직접 조회 시도 차단
    v_caught_exception := false;
    BEGIN
      EXECUTE 'SELECT provider_cancel_id FROM public.payment_refunds WHERE id = ' || quote_literal(v_refund_1_id);
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '42501' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G08 Failed: Direct SELECT of provider_cancel_id by authenticated was not blocked';
    END IF;

    -- idempotency_key 직접 조회 시도 차단
    v_caught_exception := false;
    BEGIN
      EXECUTE 'SELECT idempotency_key FROM public.access_sessions WHERE id = ' || quote_literal(v_session_1_id);
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = '42501' THEN
        v_caught_exception := true;
      END IF;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G08 Failed: Direct SELECT of access_sessions.idempotency_key by authenticated was not blocked';
    END IF;

    -- 3) Admin 컨텍스트로 안전 컬럼 전체 조회 확인
    PERFORM set_config('role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', v_admin_id::text, true);

    SELECT count(*) INTO v_count
    FROM public.access_sessions
    WHERE id = v_session_1_id;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'G08 Failed: Admin could not see access_sessions';
    END IF;

    SELECT count(*) INTO v_count
    FROM public.payment_orders
    WHERE id = v_order_1_id;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'G08 Failed: Admin could not see payment_orders';
    END IF;

    SELECT count(*) INTO v_count
    FROM public.payment_refunds
    WHERE id = v_refund_1_id;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'G08 Failed: Admin could not see payment_refunds';
    END IF;

    -- 컨텍스트 복구
    PERFORM set_config('role', v_orig_user, false);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);

    RAISE NOTICE '✓ G08 Passed: RLS segregation and sensitive column SELECT blocking verified';

    -- ============================================================================
    -- G09: event_logs.access_session_id 외래키 연동 검증
    -- ============================================================================
    -- 유효한 access_session_id를 가진 event_logs 정상 삽입
    INSERT INTO public.event_logs (
      id, client_event_id, event_name, event_version, user_id, restroom_id,
      access_session_id, source, occurred_at
    ) VALUES (
      v_event_1_id, gen_random_uuid(), 'receipt_upload_clicked', 1, v_user_a_id,
      v_partner_restroom_id, v_session_1_id, 'client', now()
    );

    SELECT count(*) INTO v_count
    FROM public.event_logs
    WHERE id = v_event_1_id AND access_session_id = v_session_1_id;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'G09 Failed: event_log with access_session_id was not inserted';
    END IF;

    -- 미존재 access_session_id 삽입 시 외래키 위반(23503) 차단
    v_caught_exception := false;
    BEGIN
      INSERT INTO public.event_logs (
        id, client_event_id, event_name, event_version, access_session_id, source, occurred_at
      ) VALUES (
        gen_random_uuid(), gen_random_uuid(), 'receipt_upload_clicked', 1,
        gen_random_uuid(), 'client', now()
      );
    EXCEPTION WHEN foreign_key_violation THEN
      v_caught_exception := true;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G09 Failed: Invalid access_session_id foreign key was not rejected';
    END IF;

    RAISE NOTICE '✓ G09 Passed: event_logs.access_session_id foreign key verified';

    -- ============================================================================
    -- G10: P0099 의도적 롤백 트리거
    -- ============================================================================
    RAISE EXCEPTION 'P0099: Intentional rollback for TASK 20 verification'
      USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0099' THEN
      RAISE NOTICE '✓ G10 Passed: P0099 caught: Test subtransaction cleanly rolled back';
  END;

  -- ============================================================================
  -- G11: 롤백 후 잔류 레코드 0건 무결성 검증
  -- ============================================================================
  SELECT count(*) INTO v_count
  FROM public.access_sessions
  WHERE id::text LIKE v_test_prefix || '%';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'G11 Failed: Residual access_sessions found (% rows)', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.payment_orders
  WHERE id::text LIKE v_test_prefix || '%';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'G11 Failed: Residual payment_orders found (% rows)', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.payment_refunds
  WHERE id::text LIKE v_test_prefix || '%';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'G11 Failed: Residual payment_refunds found (% rows)', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.event_logs
  WHERE id::text LIKE v_test_prefix || '%';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'G11 Failed: Residual event_logs found (% rows)', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.restrooms
  WHERE id::text LIKE v_test_prefix || '%';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'G11 Failed: Residual restrooms found (% rows)', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.businesses
  WHERE id::text LIKE v_test_prefix || '%';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'G11 Failed: Residual businesses found (% rows)', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM auth.users
  WHERE id::text LIKE v_test_prefix || '%';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'G11 Failed: Residual auth.users found (% rows)', v_count;
  END IF;

  RAISE NOTICE '✓ G11 Passed: Zero residual test rows verified across all tables';
  RAISE NOTICE '>>> ALL TASK 20 PAYMENT SCHEMA & INTEGRITY VERIFICATIONS PASSED!';
END $$;
