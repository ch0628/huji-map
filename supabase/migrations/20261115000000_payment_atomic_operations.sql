-- ==============================================================================
-- Migration: 20261115000000_payment_atomic_operations.sql
-- Description: TASK 21 - 토스페이먼츠 테스트 결제 원자적 승인 및 주문 생성 RPC
-- Spec: docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/07_PAYMENT_ACCESS_REFUND.md,
--       docs/08_SECURITY_OPERATIONS.md, docs/11_DECISIONS.md, tasks/21_toss_server.md
-- Functions:
--   1. complete_payment_approval: 결제 승인과 이용권 활성화를 단일 트랜잭션(FOR UPDATE)으로 원자적 처리
--   2. create_payment_order_session: 제휴 화장실 이용권 및 결제 주문을 트랜잭션 단위 advisory lock 및
--      단일 트랜잭션으로 원자적 생성 및 멱등 재사용 (동시성 경합 시 안전한 재사용 보장)
--   3. record_payment_failure: PG 확정 실패 시 결제 주문 상태를 안전하게 failed로 전이
-- Security:
--   - SECURITY DEFINER 및 search_path = public, pg_temp 고정
--   - service_role 전용 (PUBLIC, anon, authenticated 실행 권한 완전 박탈)
-- ==============================================================================

-- 1. complete_payment_approval (결제 승인 원자적 반영 RPC)
CREATE OR REPLACE FUNCTION public.complete_payment_approval(
  p_order_id text,
  p_payment_key text,
  p_amount_krw integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.payment_orders%ROWTYPE;
  v_session public.access_sessions%ROWTYPE;
  v_now timestamptz := now();
BEGIN
  -- 1) 입력 유효성 검증
  IF p_order_id IS NULL OR trim(p_order_id) = '' THEN
    RAISE EXCEPTION 'HM052: order_id is required' USING ERRCODE = '22023';
  END IF;

  IF p_payment_key IS NULL OR trim(p_payment_key) = '' THEN
    RAISE EXCEPTION 'HM053: payment_key is required' USING ERRCODE = '22023';
  END IF;

  IF p_amount_krw IS NULL OR p_amount_krw <= 0 THEN
    RAISE EXCEPTION 'HM054: amount_krw must be strictly positive' USING ERRCODE = '23514';
  END IF;

  -- 2) 행 잠금(FOR UPDATE)으로 결제 주문 조회
  SELECT * INTO v_order
  FROM public.payment_orders
  WHERE order_id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'HM055: Payment order not found for order_id %', p_order_id USING ERRCODE = 'P0002';
  END IF;

  -- 3) 멱등성 검사: 이미 approved 상태인 경우
  IF v_order.status = 'approved' THEN
    IF v_order.provider_payment_key IS NOT DISTINCT FROM p_payment_key
       AND v_order.amount_krw IS NOT DISTINCT FROM p_amount_krw THEN
      -- 기존과 동일한 키와 금액으로 승인된 건은 안전하게 기존 결과 반환
      SELECT * INTO v_session
      FROM public.access_sessions
      WHERE id = v_order.access_session_id;

      RETURN jsonb_build_object(
        'success', true,
        'already_approved', true,
        'order', to_jsonb(v_order),
        'access_session', to_jsonb(v_session)
      );
    ELSE
      -- 이미 승인되었으나 결제키 또는 금액이 다른 경우 위변조/충돌 거부
      RAISE EXCEPTION 'HM056: Payment order already approved with different key or amount' USING ERRCODE = '23505';
    END IF;
  END IF;

  -- 4) 승인 가능한 상태인지 검증 (created 또는 pending만 가능)
  IF v_order.status NOT IN ('created', 'pending') THEN
    RAISE EXCEPTION 'HM057: Cannot approve order in terminal status %', v_order.status USING ERRCODE = '22023';
  END IF;

  -- 5) DB에 저장된 주문 금액과 요청 금액 일치 검증
  IF v_order.amount_krw IS DISTINCT FROM p_amount_krw THEN
    RAISE EXCEPTION 'HM058: Amount mismatch: requested %, stored %', p_amount_krw, v_order.amount_krw USING ERRCODE = '22023';
  END IF;

  -- 6) 행 잠금(FOR UPDATE)으로 이용권 세션 조회
  SELECT * INTO v_session
  FROM public.access_sessions
  WHERE id = v_order.access_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'HM059: Access session % not found', v_order.access_session_id USING ERRCODE = '23503';
  END IF;

  IF v_session.status NOT IN ('created') THEN
    RAISE EXCEPTION 'HM060: Access session cannot be authorized from status %', v_session.status USING ERRCODE = '22023';
  END IF;

  -- 7) 원자적 갱신 A: payment_orders를 먼저 approved로 갱신 (HM022 검증 통과 필수 선행)
  UPDATE public.payment_orders
  SET
    status = 'approved',
    provider_payment_key = p_payment_key,
    approved_at = v_now,
    updated_at = v_now
  WHERE id = v_order.id
  RETURNING * INTO v_order;

  -- 8) 원자적 갱신 B: access_sessions를 authorized로 갱신 (트리거가 approved 결제 존재 확인)
  UPDATE public.access_sessions
  SET
    status = 'authorized',
    authorized_at = v_now,
    updated_at = v_now
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  RETURN jsonb_build_object(
    'success', true,
    'already_approved', false,
    'order', to_jsonb(v_order),
    'access_session', to_jsonb(v_session)
  );
END;
$$;

-- 2. create_payment_order_session (원자적 주문 및 이용권 생성 RPC - 동시성 제어 강화)
CREATE OR REPLACE FUNCTION public.create_payment_order_session(
  p_user_id uuid,
  p_restroom_id uuid,
  p_order_id text,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_status text;
  v_restroom_type text;
  v_publication_status text;
  v_business_id uuid;
  v_is_business_approved boolean;
  v_access_method text;
  v_policy public.restroom_access_policies%ROWTYPE;
  v_existing_order public.payment_orders%ROWTYPE;
  v_existing_session public.access_sessions%ROWTYPE;
  v_new_session public.access_sessions%ROWTYPE;
  v_new_order public.payment_orders%ROWTYPE;
  v_session_idempotency_key text;
  v_expires_at timestamptz;
  v_now timestamptz := now();
BEGIN
  -- 0) 인자 유효성 검증
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'HM061: user_id is required' USING ERRCODE = '22023';
  END IF;

  IF p_restroom_id IS NULL THEN
    RAISE EXCEPTION 'HM064: restroom_id is required' USING ERRCODE = '22023';
  END IF;

  IF p_order_id IS NULL OR trim(p_order_id) = '' THEN
    RAISE EXCEPTION 'HM052: order_id is required' USING ERRCODE = '22023';
  END IF;

  IF p_idempotency_key IS NULL OR trim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'HM073: idempotency_key is required' USING ERRCODE = '22023';
  END IF;

  -- 1) 트랜잭션 단위 Advisory Lock 획득 (동일 멱등키 병렬 요청 직렬화)
  --    존재하지 않는 행에 대해 FOR UPDATE가 잠금을 걸지 못하는 한계를 보완하여,
  --    동일 멱등키의 동시 요청 중 첫 번째 트랜잭션이 커밋될 때까지 두 번째 트랜잭션이 안전하게 대기하도록 함
  PERFORM pg_advisory_xact_lock(hashtext('payment_order_session'), hashtext(p_idempotency_key));

  -- 2) 사용자 존재 여부 및 계정 상태 검증
  --    멱등키 재사용 반환보다 먼저 실행하여 정지(suspended) 사용자의 기존 주문 재사용을 차단
  SELECT account_status INTO v_user_status
  FROM public.profiles
  WHERE id = p_user_id;

  IF v_user_status IS NULL THEN
    RAISE EXCEPTION 'HM061: User % not found', p_user_id USING ERRCODE = '23503';
  END IF;

  IF v_user_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'HM062: User account is not active' USING ERRCODE = '42501';
  END IF;

  -- 3) 동일 멱등키 기존 주문 검사 (재시도 및 멱등 처리)
  SELECT * INTO v_existing_order
  FROM public.payment_orders
  WHERE idempotency_key = p_idempotency_key;

  IF FOUND THEN
    SELECT * INTO v_existing_session
    FROM public.access_sessions
    WHERE id = v_existing_order.access_session_id;

    IF v_existing_order.user_id = p_user_id AND v_existing_session.restroom_id = p_restroom_id THEN
      -- 동일 사용자 및 동일 화장실이면 기존 주문 재사용
      RETURN jsonb_build_object(
        'reused', true,
        'order', to_jsonb(v_existing_order),
        'access_session', to_jsonb(v_existing_session),
        'business_id', (SELECT business_id FROM public.restrooms WHERE id = p_restroom_id)
      );
    ELSE
      -- 타인 또는 다른 화장실에 대해 동일 멱등키 사용 시 충돌 거부
      RAISE EXCEPTION 'HM063: Idempotency key collision' USING ERRCODE = '23505';
    END IF;
  END IF;

  -- 4) 화장실 상태 및 제휴 여부 검증
  SELECT type, publication_status, business_id, access_method
  INTO v_restroom_type, v_publication_status, v_business_id, v_access_method
  FROM public.restrooms
  WHERE id = p_restroom_id;

  IF v_restroom_type IS NULL THEN
    RAISE EXCEPTION 'HM064: Restroom % not found', p_restroom_id USING ERRCODE = 'P0002';
  END IF;

  IF v_restroom_type IS DISTINCT FROM 'partner' THEN
    RAISE EXCEPTION 'HM065: Payment orders are only allowed for partner restrooms (found: %)', v_restroom_type USING ERRCODE = '22023';
  END IF;

  IF v_publication_status IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'HM066: Restroom is not published (found: %)', v_publication_status USING ERRCODE = '22023';
  END IF;

  -- 점포 승인 상태 검증
  SELECT public.is_partner_business_approved(v_business_id) INTO v_is_business_approved;
  IF v_is_business_approved IS NOT TRUE THEN
    RAISE EXCEPTION 'HM067: Partner business is not approved' USING ERRCODE = '22023';
  END IF;

  -- 5) 활성 이용 정책 조회
  SELECT * INTO v_policy
  FROM public.restroom_access_policies
  WHERE restroom_id = p_restroom_id AND is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'HM068: Active access policy not found for restroom' USING ERRCODE = '22023';
  END IF;

  IF v_policy.access_mode IS DISTINCT FROM 'test_deposit' THEN
    RAISE EXCEPTION 'HM069: Active policy is not test_deposit mode' USING ERRCODE = '22023';
  END IF;

  IF v_policy.deposit_amount_krw <= 0 THEN
    RAISE EXCEPTION 'HM070: Deposit amount must be positive' USING ERRCODE = '23514';
  END IF;

  -- 6) 이용권 만료 시각 계산 (정책 윈도우 또는 기본 24시간)
  v_expires_at := v_now + (COALESCE(v_policy.receipt_window_hours, 24) || ' hours')::interval;
  v_session_idempotency_key := 'ses_' || p_idempotency_key;

  -- 7) 원자적 생성 및 UNIQUE 충돌 방어 서브블록
  BEGIN
    -- access_sessions 원자적 생성
    INSERT INTO public.access_sessions (
      user_id,
      restroom_id,
      policy_id,
      status,
      access_method_snapshot,
      idempotency_key,
      expires_at,
      created_at,
      updated_at
    ) VALUES (
      p_user_id,
      p_restroom_id,
      v_policy.id,
      'created',
      v_access_method,
      v_session_idempotency_key,
      v_expires_at,
      v_now,
      v_now
    )
    RETURNING * INTO v_new_session;

    -- payment_orders 원자적 생성
    INSERT INTO public.payment_orders (
      access_session_id,
      user_id,
      order_id,
      provider,
      payment_mode,
      amount_krw,
      status,
      idempotency_key,
      created_at,
      updated_at
    ) VALUES (
      v_new_session.id,
      p_user_id,
      p_order_id,
      'toss',
      'test',
      v_policy.deposit_amount_krw,
      'created',
      p_idempotency_key,
      v_now,
      v_now
    )
    RETURNING * INTO v_new_order;

    RETURN jsonb_build_object(
      'reused', false,
      'order', to_jsonb(v_new_order),
      'access_session', to_jsonb(v_new_session),
      'business_id', v_business_id
    );
  EXCEPTION
    WHEN unique_violation THEN
      -- 동시성 경합으로 병렬 트랜잭션이 먼저 커밋한 경우 재조회하여 안전하게 반환
      SELECT * INTO v_existing_order
      FROM public.payment_orders
      WHERE idempotency_key = p_idempotency_key;

      IF FOUND THEN
        SELECT * INTO v_existing_session
        FROM public.access_sessions
        WHERE id = v_existing_order.access_session_id;

        IF v_existing_order.user_id = p_user_id AND v_existing_session.restroom_id = p_restroom_id THEN
          RETURN jsonb_build_object(
            'reused', true,
            'order', to_jsonb(v_existing_order),
            'access_session', to_jsonb(v_existing_session),
            'business_id', (SELECT business_id FROM public.restrooms WHERE id = p_restroom_id)
          );
        ELSE
          RAISE EXCEPTION 'HM063: Idempotency key collision' USING ERRCODE = '23505';
        END IF;
      ELSE
        RAISE;
      END IF;
  END;
END;
$$;

-- 3. record_payment_failure (결제 실패 상태 기록 RPC)
CREATE OR REPLACE FUNCTION public.record_payment_failure(
  p_order_id text,
  p_failure_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.payment_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order
  FROM public.payment_orders
  WHERE order_id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'HM071: Order % not found', p_order_id USING ERRCODE = 'P0002';
  END IF;

  -- 이미 approved 된 주문은 실패로 전이할 수 없음 (HM033 불변식 준수)
  IF v_order.status = 'approved' THEN
    RAISE EXCEPTION 'HM072: Cannot mark approved order as failed' USING ERRCODE = '22023';
  END IF;

  -- 이미 failed 면 멱등하게 유지
  IF v_order.status = 'failed' THEN
    RETURN jsonb_build_object('success', true, 'order', to_jsonb(v_order));
  END IF;

  UPDATE public.payment_orders
  SET
    status = 'failed',
    failure_code = p_failure_code,
    updated_at = now()
  WHERE id = v_order.id
  RETURNING * INTO v_order;

  RETURN jsonb_build_object('success', true, 'order', to_jsonb(v_order));
END;
$$;

-- ==============================================================================
-- 4. 권한 부여 (service_role 전용 실행, anon/authenticated 완전 차단)
-- ==============================================================================
REVOKE ALL ON FUNCTION public.complete_payment_approval(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_payment_approval(text, text, integer) TO service_role;

REVOKE ALL ON FUNCTION public.create_payment_order_session(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_payment_order_session(uuid, uuid, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.record_payment_failure(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_payment_failure(text, text) TO service_role;
