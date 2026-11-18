-- Migration: 20261117000000_pin_reveal.sql
-- Purpose: TASK 24 — Customer doorlock PIN reveal API schema, pin_reveal_audits, visit_confirmations, and atomic reveal RPC
-- References: docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/07_PAYMENT_ACCESS_REFUND.md,
--             docs/08_SECURITY_OPERATIONS.md, docs/11_DECISIONS.md, tasks/24_pin_reveal.md

-- ============================================================================
-- 1. PIN REVEAL AUDITS TABLE (docs/03_DATA_MODEL.md line 300)
-- ============================================================================
-- Invariant: Plaintext PIN, ciphertext, IV, auth_tag, and keys are NEVER stored here!
-- Append-only audit log for tracking all successful and denied PIN reveal requests.

CREATE TABLE IF NOT EXISTS public.pin_reveal_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_session_id uuid NULL REFERENCES public.access_sessions(id) ON DELETE SET NULL,
  user_id uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  restroom_id uuid NULL REFERENCES public.restrooms(id) ON DELETE SET NULL,
  code_version integer NULL CHECK (code_version IS NULL OR code_version > 0),
  result text NOT NULL CHECK (result IN ('success', 'denied', 'error')),
  reason text NULL,
  request_id text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pin_reveal_audits_access_session_id
  ON public.pin_reveal_audits(access_session_id);
CREATE INDEX IF NOT EXISTS idx_pin_reveal_audits_user_id
  ON public.pin_reveal_audits(user_id);
CREATE INDEX IF NOT EXISTS idx_pin_reveal_audits_restroom_id
  ON public.pin_reveal_audits(restroom_id);
CREATE INDEX IF NOT EXISTS idx_pin_reveal_audits_result
  ON public.pin_reveal_audits(result);
CREATE INDEX IF NOT EXISTS idx_pin_reveal_audits_created_at
  ON public.pin_reveal_audits(created_at DESC);

-- Append-only invariant trigger: prevent UPDATE and DELETE on pin_reveal_audits
CREATE OR REPLACE FUNCTION public.prevent_pin_reveal_audits_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'HM100: pin_reveal_audits is append-only and cannot be modified or deleted'
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_pin_reveal_audits_mutation ON public.pin_reveal_audits;
CREATE TRIGGER trg_prevent_pin_reveal_audits_mutation
  BEFORE UPDATE OR DELETE ON public.pin_reveal_audits
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_pin_reveal_audits_mutation();

REVOKE ALL ON FUNCTION public.prevent_pin_reveal_audits_mutation() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_pin_reveal_audits_mutation() TO service_role;

-- ============================================================================
-- 2. VISIT CONFIRMATIONS TABLE (docs/03_DATA_MODEL.md line 312)
-- ============================================================================
-- Tracks user/merchant/operator assertions of arrival/usage without physical enforcement.

CREATE TABLE IF NOT EXISTS public.visit_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_session_id uuid NOT NULL REFERENCES public.access_sessions(id) ON DELETE RESTRICT,
  usage_status text NOT NULL CHECK (usage_status IN ('success', 'failed', 'unknown')),
  verification_method text NOT NULL CHECK (verification_method IN ('user', 'merchant', 'operator')),
  verified_by uuid NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  arrival_confirmed_at timestamptz NULL,
  failure_reason text NULL,
  verified_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_visit_confirmations_access_session_id
  ON public.visit_confirmations(access_session_id);
CREATE INDEX IF NOT EXISTS idx_visit_confirmations_verified_by
  ON public.visit_confirmations(verified_by);

DROP TRIGGER IF EXISTS set_visit_confirmations_updated_at ON public.visit_confirmations;
CREATE TRIGGER set_visit_confirmations_updated_at
  BEFORE UPDATE ON public.visit_confirmations
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

-- ============================================================================
-- 3. RLS & PERMISSIONS
-- ============================================================================

ALTER TABLE public.pin_reveal_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visit_confirmations ENABLE ROW LEVEL SECURITY;

-- pin_reveal_audits: default deny all clients. Only admin can select.
REVOKE ALL ON TABLE public.pin_reveal_audits FROM public, anon, authenticated;
GRANT SELECT ON TABLE public.pin_reveal_audits TO authenticated;
GRANT ALL ON TABLE public.pin_reveal_audits TO service_role;

DROP POLICY IF EXISTS pin_reveal_audits_admin_select ON public.pin_reveal_audits;
CREATE POLICY pin_reveal_audits_admin_select
  ON public.pin_reveal_audits
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

-- visit_confirmations: owner and admin can view, owner can insert user verification
REVOKE ALL ON TABLE public.visit_confirmations FROM public, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.visit_confirmations TO authenticated;
GRANT ALL ON TABLE public.visit_confirmations TO service_role;

DROP POLICY IF EXISTS visit_confirmations_select ON public.visit_confirmations;
CREATE POLICY visit_confirmations_select
  ON public.visit_confirmations
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.access_sessions s
      WHERE s.id = visit_confirmations.access_session_id
        AND s.user_id = auth.uid()
    )
    OR public.is_admin(auth.uid())
  );

DROP POLICY IF EXISTS visit_confirmations_insert ON public.visit_confirmations;
CREATE POLICY visit_confirmations_insert
  ON public.visit_confirmations
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.access_sessions s
      WHERE s.id = visit_confirmations.access_session_id
        AND s.user_id = auth.uid()
    )
    AND verification_method = 'user'
  );

-- ============================================================================
-- 4. ATOMIC RPC: reveal_access_pin
-- ============================================================================
-- Validates:
--   1. Caller profile active
--   2. Access session exists and belongs to caller
--   3. Restroom is partner, published, and uses PIN
--   4. Access session is active ('authorized' or 'code_revealed') and not expired
--   5. Server-verified payment order status = 'approved' in database
--   6. No active refund/cancellation
--   7. Active lock secret exists and is valid
-- Transitions:
--   - Updates access_sessions status to 'code_revealed' and sets code_revealed_at
--   - Records audit entry in pin_reveal_audits
-- Returns encrypted payload for server-side decryption:
--   { ok: true, ciphertext_b64, iv_b64, auth_tag_b64, key_version, code_version, expires_at, restroom_id }

CREATE OR REPLACE FUNCTION public.reveal_access_pin(
  p_access_session_id uuid,
  p_caller_user_id uuid,
  p_request_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_session RECORD;
  v_profile RECORD;
  v_restroom RECORD;
  v_business RECORD;
  v_order RECORD;
  v_refund RECORD;
  v_secret RECORD;
BEGIN
  -- 1. Validate inputs
  IF p_access_session_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'VALIDATION_ERROR',
      'message', '이용권 ID가 필요합니다.',
      'status', 400
    );
  END IF;

  IF p_caller_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'UNAUTHENTICATED',
      'message', '로그인이 필요한 서비스입니다.',
      'status', 401
    );
  END IF;

  -- 2. Verify caller profile exists and is active
  SELECT id, account_status INTO v_profile
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
    INSERT INTO public.pin_reveal_audits (
      access_session_id, user_id, result, reason, request_id, created_at
    ) VALUES (
      p_access_session_id, p_caller_user_id, 'denied', 'account_suspended', p_request_id, now()
    );
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'ACCOUNT_SUSPENDED',
      'message', '현재 이용이 제한된 계정입니다.',
      'status', 403
    );
  END IF;

  -- 3. Retrieve and lock access session
  SELECT id, user_id, restroom_id, policy_id, status, access_method_snapshot,
         authorized_at, code_revealed_at, expires_at
  INTO v_session
  FROM public.access_sessions
  WHERE id = p_access_session_id
  FOR UPDATE;

  IF v_session.id IS NULL THEN
    INSERT INTO public.pin_reveal_audits (
      access_session_id, user_id, result, reason, request_id, created_at
    ) VALUES (
      NULL, p_caller_user_id, 'denied', 'access_session_not_found', p_request_id, now()
    );
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'ACCESS_NOT_FOUND',
      'message', '화장실 이용권을 찾을 수 없습니다.',
      'status', 404
    );
  END IF;

  -- 4. Verify ownership: must match authenticated caller
  -- Notice: Admin or merchant role alone does NOT grant access to another customer's PIN
  IF v_session.user_id <> p_caller_user_id THEN
    INSERT INTO public.pin_reveal_audits (
      access_session_id, user_id, restroom_id, result, reason, request_id, created_at
    ) VALUES (
      v_session.id, p_caller_user_id, v_session.restroom_id, 'denied', 'ownership_mismatch', p_request_id, now()
    );
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'FORBIDDEN',
      'message', '해당 화장실 이용권의 도어락 PIN 조회 권한이 없습니다.',
      'status', 403
    );
  END IF;

  -- 5. Verify restroom properties (partner, published, pin access method)
  SELECT id, business_id, type, access_method, publication_status
  INTO v_restroom
  FROM public.restrooms
  WHERE id = v_session.restroom_id;

  IF v_restroom.id IS NULL THEN
    INSERT INTO public.pin_reveal_audits (
      access_session_id, user_id, restroom_id, result, reason, request_id, created_at
    ) VALUES (
      v_session.id, p_caller_user_id, v_session.restroom_id, 'denied', 'restroom_not_found', p_request_id, now()
    );
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'RESTROOM_NOT_FOUND',
      'message', '대상 화장실 정보를 찾을 수 없습니다.',
      'status', 404
    );
  END IF;

  IF v_restroom.type <> 'partner' OR v_restroom.access_method <> 'pin' OR v_session.access_method_snapshot <> 'pin' THEN
    INSERT INTO public.pin_reveal_audits (
      access_session_id, user_id, restroom_id, result, reason, request_id, created_at
    ) VALUES (
      v_session.id, p_caller_user_id, v_session.restroom_id, 'denied', 'pin_not_supported', p_request_id, now()
    );
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'PIN_NOT_SUPPORTED',
      'message', '도어락 PIN 출입 방식을 사용하지 않는 화장실입니다.',
      'status', 400
    );
  END IF;

  IF v_restroom.publication_status <> 'published' THEN
    INSERT INTO public.pin_reveal_audits (
      access_session_id, user_id, restroom_id, result, reason, request_id, created_at
    ) VALUES (
      v_session.id, p_caller_user_id, v_session.restroom_id, 'denied', 'restroom_not_published', p_request_id, now()
    );
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'RESTROOM_UNAVAILABLE',
      'message', '현재 공개되지 않았거나 이용할 수 없는 화장실입니다.',
      'status', 422
    );
  END IF;

  -- Verify partner business approval status
  IF v_restroom.business_id IS NOT NULL THEN
    SELECT id, registration_status INTO v_business
    FROM public.businesses
    WHERE id = v_restroom.business_id;

    IF v_business.id IS NULL OR v_business.registration_status <> 'approved' THEN
      INSERT INTO public.pin_reveal_audits (
        access_session_id, user_id, restroom_id, result, reason, request_id, created_at
      ) VALUES (
        v_session.id, p_caller_user_id, v_session.restroom_id, 'denied', 'business_not_approved', p_request_id, now()
      );
      RETURN jsonb_build_object(
        'ok', false,
        'error_code', 'RESTROOM_UNAVAILABLE',
        'message', '제휴 매장의 승인 상태가 유효하지 않습니다.',
        'status', 422
      );
    END IF;
  END IF;

  -- 6. Check access session expiry and status
  IF now() >= v_session.expires_at THEN
    IF v_session.status IN ('created', 'authorized', 'code_revealed') THEN
      UPDATE public.access_sessions
      SET status = 'expired', updated_at = now()
      WHERE id = v_session.id;
    END IF;

    INSERT INTO public.pin_reveal_audits (
      access_session_id, user_id, restroom_id, result, reason, request_id, created_at
    ) VALUES (
      v_session.id, p_caller_user_id, v_session.restroom_id, 'denied', 'access_expired', p_request_id, now()
    );
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'ACCESS_EXPIRED',
      'message', '화장실 이용권의 유효 시간이 만료되었습니다.',
      'status', 422
    );
  END IF;

  IF v_session.status NOT IN ('authorized', 'code_revealed') THEN
    IF v_session.status = 'created' THEN
      INSERT INTO public.pin_reveal_audits (
        access_session_id, user_id, restroom_id, result, reason, request_id, created_at
      ) VALUES (
        v_session.id, p_caller_user_id, v_session.restroom_id, 'denied', 'payment_not_completed', p_request_id, now()
      );
      RETURN jsonb_build_object(
        'ok', false,
        'error_code', 'PAYMENT_REQUIRED',
        'message', '결제가 완료되지 않은 이용권입니다.',
        'status', 422
      );
    ELSIF v_session.status = 'canceled' THEN
      INSERT INTO public.pin_reveal_audits (
        access_session_id, user_id, restroom_id, result, reason, request_id, created_at
      ) VALUES (
        v_session.id, p_caller_user_id, v_session.restroom_id, 'denied', 'access_canceled', p_request_id, now()
      );
      RETURN jsonb_build_object(
        'ok', false,
        'error_code', 'ACCESS_CANCELED',
        'message', '취소되었거나 환불된 이용권입니다.',
        'status', 422
      );
    ELSE
      INSERT INTO public.pin_reveal_audits (
        access_session_id, user_id, restroom_id, result, reason, request_id, created_at
      ) VALUES (
        v_session.id, p_caller_user_id, v_session.restroom_id, 'denied', 'invalid_access_status', p_request_id, now()
      );
      RETURN jsonb_build_object(
        'ok', false,
        'error_code', 'ACCESS_INVALID',
        'message', '유효한 이용권 상태가 아닙니다.',
        'status', 422
      );
    END IF;
  END IF;

  -- 7. Check server-verified payment order in database
  SELECT id, status, payment_mode, amount_krw
  INTO v_order
  FROM public.payment_orders
  WHERE access_session_id = v_session.id
    AND user_id = p_caller_user_id
    AND status = 'approved';

  IF v_order.id IS NULL THEN
    INSERT INTO public.pin_reveal_audits (
      access_session_id, user_id, restroom_id, result, reason, request_id, created_at
    ) VALUES (
      v_session.id, p_caller_user_id, v_session.restroom_id, 'denied', 'no_approved_payment', p_request_id, now()
    );
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'PAYMENT_NOT_APPROVED',
      'message', '서버에서 확인된 정상 결제 승인 내역이 없습니다.',
      'status', 422
    );
  END IF;

  -- Check if order has been refunded or cancel is requested/processing/succeeded
  SELECT id, status
  INTO v_refund
  FROM public.payment_refunds
  WHERE payment_order_id = v_order.id
    AND status IN ('succeeded', 'processing', 'requested');

  IF v_refund.id IS NOT NULL THEN
    INSERT INTO public.pin_reveal_audits (
      access_session_id, user_id, restroom_id, result, reason, request_id, created_at
    ) VALUES (
      v_session.id, p_caller_user_id, v_session.restroom_id, 'denied', 'payment_refunded', p_request_id, now()
    );
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'PAYMENT_REFUNDED',
      'message', '환불되었거나 취소 처리된 결제입니다.',
      'status', 422
    );
  END IF;

  -- 8. Retrieve active doorlock PIN secret for the restroom
  SELECT id, ciphertext_b64, iv_b64, auth_tag_b64, key_version, code_version, valid_from, valid_until
  INTO v_secret
  FROM public.restroom_lock_secrets
  WHERE restroom_id = v_session.restroom_id
    AND status = 'active'
    AND valid_from <= clock_timestamp()
    AND (valid_until IS NULL OR valid_until > clock_timestamp())
  ORDER BY code_version DESC
  LIMIT 1;

  IF v_secret.id IS NULL THEN
    INSERT INTO public.pin_reveal_audits (
      access_session_id, user_id, restroom_id, result, reason, request_id, created_at
    ) VALUES (
      v_session.id, p_caller_user_id, v_session.restroom_id, 'denied', 'no_active_pin', p_request_id, now()
    );
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'PIN_NOT_AVAILABLE',
      'message', '현재 유효한 활성 도어락 PIN이 등록되어 있지 않습니다.',
      'status', 404
    );
  END IF;

  -- 9. Return encrypted payload to Node.js backend
  -- Invariant: access_sessions.status is NOT changed to 'code_revealed' here,
  -- and 'success' audit is NOT inserted here. That must occur only after
  -- successful AES-256-GCM integrity decryption via confirm_pin_revealed()!
  RETURN jsonb_build_object(
    'ok', true,
    'secret_id', v_secret.id,
    'ciphertext_b64', v_secret.ciphertext_b64,
    'iv_b64', v_secret.iv_b64,
    'auth_tag_b64', v_secret.auth_tag_b64,
    'key_version', v_secret.key_version,
    'code_version', v_secret.code_version,
    'expires_at', v_session.expires_at,
    'restroom_id', v_session.restroom_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reveal_access_pin(uuid, uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reveal_access_pin(uuid, uuid, text) TO service_role;

-- ============================================================================
-- 5. ATOMIC RPC: confirm_pin_revealed
-- ============================================================================
-- Called ONLY after successful AES-256-GCM integrity decryption in Node.js backend.
-- Atomically re-verifies:
--   1. Access session validity, ownership, active status, unexpired time
--   2. Payment order approved and no active refund
--   3. Doorlock PIN has NOT been rotated/deactivated in the interim:
--      re-checks active secret in restroom_lock_secrets against p_code_version and p_secret_id.
-- If rotated:
--   - Does NOT transition access_sessions status to 'code_revealed' (leaves it authorized)
--   - Records 'denied' audit log with reason 'pin_stale_rotated'
--   - Returns { ok: false, error_code: 'PIN_STALE_ROTATED', status: 409 }
-- If valid:
--   - Atomically transitions access_sessions status to 'code_revealed'
--   - Records 'success' audit row in pin_reveal_audits
--   - Returns { ok: true, code_version: p_code_version }

DROP FUNCTION IF EXISTS public.confirm_pin_revealed(uuid, uuid, uuid, integer, text);
DROP FUNCTION IF EXISTS public.confirm_pin_revealed(uuid, uuid, uuid, integer, uuid, text);

CREATE OR REPLACE FUNCTION public.confirm_pin_revealed(
  p_access_session_id uuid,
  p_caller_user_id uuid,
  p_restroom_id uuid,
  p_code_version integer,
  p_secret_id uuid DEFAULT NULL,
  p_request_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_session RECORD;
  v_order RECORD;
  v_refund RECORD;
  v_active_secret RECORD;
BEGIN
  -- 1. Validate inputs
  IF p_access_session_id IS NULL OR p_caller_user_id IS NULL OR p_restroom_id IS NULL OR p_code_version IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'VALIDATION_ERROR',
      'message', '필수 확인 인자가 누락되었습니다.',
      'status', 400
    );
  END IF;

  -- 2. Lock and re-verify access session
  SELECT id, user_id, restroom_id, status, expires_at
  INTO v_session
  FROM public.access_sessions
  WHERE id = p_access_session_id
  FOR UPDATE;

  IF v_session.id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'ACCESS_NOT_FOUND',
      'message', '화장실 이용권을 찾을 수 없습니다.',
      'status', 404
    );
  END IF;

  -- Verify ownership
  IF v_session.user_id <> p_caller_user_id THEN
    INSERT INTO public.pin_reveal_audits (
      access_session_id, user_id, restroom_id, code_version, result, reason, request_id, created_at
    ) VALUES (
      v_session.id, p_caller_user_id, p_restroom_id, p_code_version,
      'denied', 'ownership_mismatch', p_request_id, now()
    );
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'FORBIDDEN',
      'message', '해당 화장실 이용권의 도어락 PIN 확정 권한이 없습니다.',
      'status', 403
    );
  END IF;

  -- Re-verify expiration
  IF clock_timestamp() >= v_session.expires_at THEN
    IF v_session.status IN ('created', 'authorized', 'code_revealed') THEN
      UPDATE public.access_sessions
      SET status = 'expired', updated_at = now()
      WHERE id = v_session.id;
    END IF;

    INSERT INTO public.pin_reveal_audits (
      access_session_id, user_id, restroom_id, code_version, result, reason, request_id, created_at
    ) VALUES (
      v_session.id, p_caller_user_id, p_restroom_id, p_code_version,
      'denied', 'access_expired', p_request_id, now()
    );
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'ACCESS_EXPIRED',
      'message', '화장실 이용권의 유효 시간이 만료되었습니다.',
      'status', 422
    );
  END IF;

  -- Re-verify session status (must be active: authorized or already code_revealed)
  IF v_session.status NOT IN ('authorized', 'code_revealed') THEN
    INSERT INTO public.pin_reveal_audits (
      access_session_id, user_id, restroom_id, code_version, result, reason, request_id, created_at
    ) VALUES (
      v_session.id, p_caller_user_id, p_restroom_id, p_code_version,
      'denied', 'invalid_access_status', p_request_id, now()
    );
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'ACCESS_INVALID',
      'message', '유효한 이용권 상태가 아닙니다.',
      'status', 422
    );
  END IF;

  -- 3. Re-verify payment order in database
  SELECT id, status INTO v_order
  FROM public.payment_orders
  WHERE access_session_id = v_session.id
    AND user_id = p_caller_user_id
    AND status = 'approved';

  IF v_order.id IS NULL THEN
    INSERT INTO public.pin_reveal_audits (
      access_session_id, user_id, restroom_id, code_version, result, reason, request_id, created_at
    ) VALUES (
      v_session.id, p_caller_user_id, p_restroom_id, p_code_version,
      'denied', 'no_approved_payment', p_request_id, now()
    );
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'PAYMENT_NOT_APPROVED',
      'message', '서버에서 확인된 정상 결제 승인 내역이 없습니다.',
      'status', 422
    );
  END IF;

  -- Re-verify refund status
  SELECT id INTO v_refund
  FROM public.payment_refunds
  WHERE payment_order_id = v_order.id
    AND status IN ('succeeded', 'processing', 'requested');

  IF v_refund.id IS NOT NULL THEN
    INSERT INTO public.pin_reveal_audits (
      access_session_id, user_id, restroom_id, code_version, result, reason, request_id, created_at
    ) VALUES (
      v_session.id, p_caller_user_id, p_restroom_id, p_code_version,
      'denied', 'payment_refunded', p_request_id, now()
    );
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'PAYMENT_REFUNDED',
      'message', '환불되었거나 취소 처리된 결제입니다.',
      'status', 422
    );
  END IF;

  -- 4. Re-verify active PIN secret (CRITICAL: detect intermediate rotation)
  SELECT id, code_version
  INTO v_active_secret
  FROM public.restroom_lock_secrets
  WHERE restroom_id = p_restroom_id
    AND status = 'active'
    AND valid_from <= clock_timestamp()
    AND (valid_until IS NULL OR valid_until > clock_timestamp())
  ORDER BY code_version DESC
  LIMIT 1;

  IF v_active_secret.id IS NULL THEN
    INSERT INTO public.pin_reveal_audits (
      access_session_id, user_id, restroom_id, code_version, result, reason, request_id, created_at
    ) VALUES (
      v_session.id, p_caller_user_id, p_restroom_id, p_code_version,
      'denied', 'no_active_pin', p_request_id, now()
    );
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'PIN_NOT_AVAILABLE',
      'message', '현재 유효한 활성 도어락 PIN이 등록되어 있지 않습니다.',
      'status', 404
    );
  END IF;

  -- If PIN was rotated during customer decryption: code_version mismatch or secret_id mismatch
  IF v_active_secret.code_version <> p_code_version OR (p_secret_id IS NOT NULL AND v_active_secret.id <> p_secret_id) THEN
    INSERT INTO public.pin_reveal_audits (
      access_session_id, user_id, restroom_id, code_version, result, reason, request_id, created_at
    ) VALUES (
      v_session.id, p_caller_user_id, p_restroom_id, p_code_version,
      'denied', 'pin_stale_rotated', p_request_id, now()
    );
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'PIN_STALE_ROTATED',
      'message', '도어락 PIN이 조회 도중 변경되었습니다. 다시 조회해 주세요.',
      'status', 409
    );
  END IF;

  -- 5. Transition access_session status to 'code_revealed' if it was 'authorized'
  UPDATE public.access_sessions
  SET status = CASE WHEN status = 'authorized' THEN 'code_revealed' ELSE status END,
      code_revealed_at = COALESCE(code_revealed_at, now()),
      updated_at = now()
  WHERE id = v_session.id;

  -- 6. Record SUCCESS in pin_reveal_audits
  -- Invariant: NEVER record plaintext PIN, ciphertext, IV, auth_tag, or keys!
  INSERT INTO public.pin_reveal_audits (
    access_session_id, user_id, restroom_id, code_version, result, reason, request_id, created_at
  ) VALUES (
    v_session.id, p_caller_user_id, p_restroom_id, p_code_version,
    'success', 'authorized_reveal', p_request_id, now()
  );

  RETURN jsonb_build_object(
    'ok', true,
    'code_version', p_code_version
  );
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_pin_revealed(uuid, uuid, uuid, integer, uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_pin_revealed(uuid, uuid, uuid, integer, uuid, text) TO service_role;

-- ============================================================================
-- 6. AUDIT HELPER RPC: record_pin_reveal_audit
-- ============================================================================
-- Allows Node.js backend to record post-decryption errors (e.g. tag tampering / missing key)

CREATE OR REPLACE FUNCTION public.record_pin_reveal_audit(
  p_access_session_id uuid,
  p_caller_user_id uuid,
  p_restroom_id uuid,
  p_code_version integer,
  p_result text,
  p_reason text,
  p_request_id text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_audit_id uuid;
BEGIN
  INSERT INTO public.pin_reveal_audits (
    access_session_id, user_id, restroom_id, code_version, result, reason, request_id, created_at
  ) VALUES (
    p_access_session_id, p_caller_user_id, p_restroom_id, p_code_version,
    p_result, p_reason, p_request_id, now()
  )
  RETURNING id INTO v_audit_id;

  RETURN v_audit_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_pin_reveal_audit(uuid, uuid, uuid, integer, text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_pin_reveal_audit(uuid, uuid, uuid, integer, text, text, text) TO service_role;
