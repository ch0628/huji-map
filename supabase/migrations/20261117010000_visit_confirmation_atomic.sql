-- ============================================================================
-- Migration: 20261117010000_visit_confirmation_atomic.sql
-- Purpose: TASK 25 — Atomic & idempotent customer visit confirmation RPC and unique index
-- References: docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, tasks/25_pin_ui.md
--
-- Security & Concurrency Invariants:
--   1. Serializes concurrent requests for the same access_session_id via
--      transaction-scoped advisory lock (pg_advisory_xact_lock) AND
--      row-level lock (SELECT ... FROM public.access_sessions FOR UPDATE).
--   2. Enforces DB-level uniqueness on (access_session_id, verification_method,
--      usage_status, COALESCE(failure_reason, '')) to prevent duplicate records
--      under any race condition.
--   3. Verifies active profile, strict customer session ownership (403 FORBIDDEN),
--      approved payment order (422 PAYMENT_REQUIRED / PAYMENT_NOT_APPROVED),
--      and absence of active/completed refunds (422 PAYMENT_REFUNDED).
--   4. SECURITY DEFINER with safe search_path = pg_catalog, pg_temp;
--      EXECUTE granted exclusively to service_role.
-- ============================================================================

-- 1. Unique index preventing duplicate identical confirmations per session/method/status/reason
CREATE UNIQUE INDEX IF NOT EXISTS idx_visit_confirmations_uq_session_method_status_reason
  ON public.visit_confirmations (
    access_session_id,
    verification_method,
    usage_status,
    COALESCE(failure_reason, '')
  );

-- 2. Atomic RPC: public.record_customer_visit_confirmation
DROP FUNCTION IF EXISTS public.record_customer_visit_confirmation(uuid, uuid, text, text);

CREATE OR REPLACE FUNCTION public.record_customer_visit_confirmation(
  p_access_session_id uuid,
  p_caller_user_id uuid,
  p_usage_status text,
  p_failure_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_profile RECORD;
  v_session RECORD;
  v_order RECORD;
  v_refund RECORD;
  v_existing RECORD;
  v_inserted RECORD;
  v_reason text;
  v_now timestamptz;
BEGIN
  -- 1. Input validation
  IF p_access_session_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'VALIDATION_ERROR',
      'message', '유효한 이용권 식별자(UUID)가 아닙니다.',
      'status', 400
    );
  END IF;

  IF p_caller_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'UNAUTHORIZED',
      'message', '로그인이 필요한 서비스입니다.',
      'status', 401
    );
  END IF;

  IF p_usage_status IS NULL OR p_usage_status NOT IN ('success', 'failed', 'unknown') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'VALIDATION_ERROR',
      'message', '유효한 이용 결과 상태(success, failed, unknown)를 선택해 주세요.',
      'status', 400
    );
  END IF;

  IF p_usage_status = 'failed' THEN
    v_reason := NULLIF(pg_catalog.btrim(COALESCE(p_failure_reason, '')), '');
    IF v_reason IS NULL OR pg_catalog.char_length(v_reason) < 2 THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error_code', 'VALIDATION_ERROR',
        'message', '이용 실패를 선택한 경우 사유를 2자 이상 입력해 주세요.',
        'status', 400
      );
    END IF;
    IF pg_catalog.char_length(v_reason) > 300 THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error_code', 'VALIDATION_ERROR',
        'message', '실패 사유는 300자 이내로 입력해 주세요.',
        'status', 400
      );
    END IF;
  ELSE
    v_reason := NULL;
  END IF;

  -- 2. Per-session transaction-scoped advisory lock (isolates different sessions while serializing same session)
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('visit_confirm:' || p_access_session_id::text)
  );

  -- 3. Verify caller profile is active
  SELECT id, account_status
  INTO v_profile
  FROM public.profiles
  WHERE id = p_caller_user_id;

  IF v_profile.id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'USER_NOT_FOUND',
      'message', '사용자 프로필을 찾을 수 없습니다.',
      'status', 404
    );
  END IF;

  IF v_profile.account_status <> 'active' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'ACCOUNT_SUSPENDED',
      'message', '현재 이용이 제한된 계정입니다.',
      'status', 403
    );
  END IF;

  -- 4. Lock and verify access session
  SELECT id, user_id, restroom_id, policy_id, status, access_method_snapshot, expires_at
  INTO v_session
  FROM public.access_sessions
  WHERE id = p_access_session_id
  FOR UPDATE;

  IF v_session.id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'ACCESS_NOT_FOUND',
      'message', '해당 화장실 이용권을 찾을 수 없습니다.',
      'status', 404
    );
  END IF;

  -- Strict customer ownership check
  IF v_session.user_id <> p_caller_user_id THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'FORBIDDEN',
      'message', '본인의 이용권에 대해서만 방문 확인을 등록할 수 있습니다.',
      'status', 403
    );
  END IF;

  -- 5. Verify access session status and approved payment
  IF v_session.status = 'created' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'PAYMENT_REQUIRED',
      'message', '결제가 승인되지 않은 이용권에는 방문 확인을 기록할 수 없습니다.',
      'status', 422
    );
  END IF;

  IF v_session.status = 'canceled' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'ACCESS_CANCELED',
      'message', '취소되거나 환불된 이용권에는 방문 확인을 기록할 수 없습니다.',
      'status', 422
    );
  END IF;

  IF v_session.status = 'failed' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'ACCESS_INVALID',
      'message', '유효하지 않은 이용권 상태입니다.',
      'status', 422
    );
  END IF;

  SELECT id, status
  INTO v_order
  FROM public.payment_orders
  WHERE access_session_id = v_session.id
    AND user_id = p_caller_user_id
    AND status = 'approved'
  LIMIT 1;

  IF v_order.id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'PAYMENT_NOT_APPROVED',
      'message', '서버에서 확인된 정상 결제 승인 내역이 없어 방문 확인을 기록할 수 없습니다.',
      'status', 422
    );
  END IF;

  SELECT id, status
  INTO v_refund
  FROM public.payment_refunds
  WHERE payment_order_id = v_order.id
    AND status IN ('succeeded', 'processing', 'requested')
  LIMIT 1;

  IF v_refund.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'PAYMENT_REFUNDED',
      'message', '환불되었거나 취소 처리된 이용권에는 방문 확인을 기록할 수 없습니다.',
      'status', 422
    );
  END IF;

  -- 6. Check existing confirmation under lock (idempotent replay)
  SELECT id, access_session_id, usage_status, verification_method,
         verified_by, arrival_confirmed_at, failure_reason, verified_at,
         created_at, updated_at
  INTO v_existing
  FROM public.visit_confirmations
  WHERE access_session_id = v_session.id
    AND verification_method = 'user'
    AND usage_status = p_usage_status
    AND COALESCE(failure_reason, '') = COALESCE(v_reason, '')
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  IF v_existing.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'reused', true,
      'session_status', v_session.status,
      'confirmation', jsonb_build_object(
        'id', v_existing.id,
        'access_session_id', v_existing.access_session_id,
        'usage_status', v_existing.usage_status,
        'verification_method', v_existing.verification_method,
        'verified_by', v_existing.verified_by,
        'arrival_confirmed_at', v_existing.arrival_confirmed_at,
        'failure_reason', v_existing.failure_reason,
        'verified_at', v_existing.verified_at,
        'created_at', v_existing.created_at,
        'updated_at', v_existing.updated_at
      )
    );
  END IF;

  -- 7. Insert new visit confirmation with unique_violation fallback
  v_now := pg_catalog.clock_timestamp();

  BEGIN
    INSERT INTO public.visit_confirmations (
      access_session_id,
      usage_status,
      verification_method,
      verified_by,
      arrival_confirmed_at,
      failure_reason,
      verified_at,
      created_at,
      updated_at
    ) VALUES (
      v_session.id,
      p_usage_status,
      'user',
      p_caller_user_id,
      v_now,
      v_reason,
      v_now,
      v_now,
      v_now
    )
    RETURNING id, access_session_id, usage_status, verification_method,
              verified_by, arrival_confirmed_at, failure_reason, verified_at,
              created_at, updated_at
    INTO v_inserted;
  EXCEPTION WHEN unique_violation THEN
    SELECT id, access_session_id, usage_status, verification_method,
           verified_by, arrival_confirmed_at, failure_reason, verified_at,
           created_at, updated_at
    INTO v_existing
    FROM public.visit_confirmations
    WHERE access_session_id = v_session.id
      AND verification_method = 'user'
      AND usage_status = p_usage_status
      AND COALESCE(failure_reason, '') = COALESCE(v_reason, '')
    ORDER BY created_at DESC, id DESC
    LIMIT 1;

    RETURN jsonb_build_object(
      'ok', true,
      'reused', true,
      'session_status', v_session.status,
      'confirmation', jsonb_build_object(
        'id', v_existing.id,
        'access_session_id', v_existing.access_session_id,
        'usage_status', v_existing.usage_status,
        'verification_method', v_existing.verification_method,
        'verified_by', v_existing.verified_by,
        'arrival_confirmed_at', v_existing.arrival_confirmed_at,
        'failure_reason', v_existing.failure_reason,
        'verified_at', v_existing.verified_at,
        'created_at', v_existing.created_at,
        'updated_at', v_existing.updated_at
      )
    );
  END;

  -- 8. Best-effort server event logging (no PIN/PII)
  BEGIN
    INSERT INTO public.event_logs (
      client_event_id,
      event_name,
      event_version,
      user_id,
      restroom_id,
      access_session_id,
      properties,
      source,
      is_test,
      occurred_at,
      received_at
    ) VALUES (
      pg_catalog.gen_random_uuid(),
      'visit_confirmation_recorded',
      1,
      p_caller_user_id,
      v_session.restroom_id,
      v_session.id,
      jsonb_build_object(
        'usage_status', p_usage_status,
        'verification_method', 'user'
      ),
      'server',
      true,
      v_now,
      v_now
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'ok', true,
    'reused', false,
    'session_status', v_session.status,
    'confirmation', jsonb_build_object(
      'id', v_inserted.id,
      'access_session_id', v_inserted.access_session_id,
      'usage_status', v_inserted.usage_status,
      'verification_method', v_inserted.verification_method,
      'verified_by', v_inserted.verified_by,
      'arrival_confirmed_at', v_inserted.arrival_confirmed_at,
      'failure_reason', v_inserted.failure_reason,
      'verified_at', v_inserted.verified_at,
      'created_at', v_inserted.created_at,
      'updated_at', v_inserted.updated_at
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_customer_visit_confirmation(uuid, uuid, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_customer_visit_confirmation(uuid, uuid, text, text) TO service_role;

