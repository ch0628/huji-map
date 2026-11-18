-- Migration: 20261116000000_pin_storage.sql
-- Purpose: TASK 23 — Doorlock PIN secure storage, AES-256-GCM metadata, persistent DB idempotency, rotation RPC, and RLS
-- References: docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/07_PAYMENT_ACCESS_REFUND.md,
--             docs/08_SECURITY_OPERATIONS.md, docs/11_DECISIONS.md, tasks/23_pin_storage.md

-- ============================================================================
-- 1. RESTROOM LOCK SECRETS TABLE (docs/03_DATA_MODEL.md line 266)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.restroom_lock_secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restroom_id uuid NOT NULL REFERENCES public.restrooms(id) ON DELETE CASCADE,
  ciphertext_b64 text NOT NULL,
  iv_b64 text NOT NULL,
  auth_tag_b64 text NOT NULL,
  key_version integer NOT NULL CHECK (key_version > 0),
  code_version integer NOT NULL CHECK (code_version > 0),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz NULL,
  status text NOT NULL CHECK (status IN ('active', 'rotated', 'revoked')),
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text NULL,
  pin_hmac_b64 text NULL,
  CONSTRAINT chk_restroom_lock_secrets_valid_window
    CHECK (valid_until IS NULL OR valid_until > valid_from),
  CONSTRAINT chk_restroom_lock_secrets_idempotency_hmac
    CHECK (idempotency_key IS NULL OR pin_hmac_b64 IS NOT NULL)
);

-- Invariant 1: At most one active PIN secret per restroom
CREATE UNIQUE INDEX IF NOT EXISTS idx_restroom_lock_secrets_single_active
  ON public.restroom_lock_secrets (restroom_id)
  WHERE status = 'active';

-- Invariant 2: PIN version (code_version) is unique per restroom
CREATE UNIQUE INDEX IF NOT EXISTS idx_restroom_lock_secrets_restroom_code_version
  ON public.restroom_lock_secrets (restroom_id, code_version);

-- Invariant 3: Idempotency key uniqueness across persisted lock secret records
CREATE UNIQUE INDEX IF NOT EXISTS idx_restroom_lock_secrets_idempotency_key
  ON public.restroom_lock_secrets (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_restroom_lock_secrets_restroom_status
  ON public.restroom_lock_secrets (restroom_id, status);

CREATE INDEX IF NOT EXISTS idx_restroom_lock_secrets_created_by
  ON public.restroom_lock_secrets (created_by);

-- ============================================================================
-- 2. PARTNER-ONLY INTEGRITY TRIGGER (DB INVARIANT 7)
-- ============================================================================
-- Public restrooms cannot have doorlock PIN secrets under any circumstances.
CREATE OR REPLACE FUNCTION public.enforce_restroom_lock_secrets_rules()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_restroom RECORD;
BEGIN
  SELECT id, type, access_method INTO v_restroom
  FROM public.restrooms
  WHERE id = NEW.restroom_id;

  IF v_restroom.id IS NULL THEN
    RAISE EXCEPTION 'HM081: Restroom % not found', NEW.restroom_id USING ERRCODE = '23503';
  END IF;

  IF v_restroom.type <> 'partner' THEN
    RAISE EXCEPTION 'HM082: Cannot register doorlock PIN secret on non-partner restroom' USING ERRCODE = '22023';
  END IF;

  IF NEW.idempotency_key IS NOT NULL AND (NEW.pin_hmac_b64 IS NULL OR length(btrim(NEW.pin_hmac_b64)) = 0) THEN
    RAISE EXCEPTION 'HM090: pin_hmac_b64 is required when idempotency_key is present' USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_restroom_lock_secrets_rules ON public.restroom_lock_secrets;
CREATE TRIGGER trg_enforce_restroom_lock_secrets_rules
  BEFORE INSERT OR UPDATE ON public.restroom_lock_secrets
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_restroom_lock_secrets_rules();

REVOKE ALL ON FUNCTION public.enforce_restroom_lock_secrets_rules() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_restroom_lock_secrets_rules() TO service_role;

-- ============================================================================
-- 3. RLS & PERMISSIONS (DEFAULT DENY TO BROWSER / CLIENTS)
-- ============================================================================
-- AGENTS.md Rule 9 & 10: Lock secrets contain sensitive encrypted keys.
-- Client browsers (anon, authenticated) must NEVER directly SELECT, INSERT, UPDATE, or DELETE.
-- Strictly restricted to service_role (Node.js server backend only).
ALTER TABLE public.restroom_lock_secrets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.restroom_lock_secrets FROM public, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.restroom_lock_secrets TO service_role;

-- ============================================================================
-- 4. ATOMIC PIN ROTATION & PERSISTENT IDEMPOTENCY RPC (SECURITY DEFINER)
-- ============================================================================
-- Atomically:
-- 1) Sanitizes and validates all inputs (p_idempotency_key requires non-null, non-empty p_pin_hmac_b64)
-- 2) Acquires advisory transaction lock on idempotency key if provided
-- 3) Verifies caller user status (fails closed if suspended, preventing replay bypass)
-- 4) Row-locks target restroom and validates partner type & pin access method
-- 5) Verifies owning business registration status ('approved') - applies to ALL callers including admin
-- 6) Verifies caller is active 'owner' in business_members (or admin)
-- 7) Checks DB-persistent idempotency record:
--    - Replay rejected if caller revoked / unapproved (guaranteed by preceding permission checks)
--    - Replay rejected if existing record has NULL HMAC (HM092)
--    - Replay rejected if HMAC does not match (HM092, 409 Conflict)
--    - Replay rejected if caller or restroom differs (HM091, 409 Conflict)
--    - Same idempotency key + same request -> replays existing code_version without creating new secret
-- 8) Rotates any existing active PIN (status = 'rotated', valid_until = now())
-- 9) Accurate before_data audit metadata captures actual state before modification
-- 10) Calculates next code_version (old + 1, or 1 if first)
-- 11) Inserts new active PIN secret with idempotency_key and server-derived pin_hmac_b64
-- 12) Appends audit log entry (actor, target, versions, timestamps; NO PIN/CIPHER/TAG/KEY/HMAC!)
-- 13) Returns { success: true, secret_id: uuid, code_version: int, valid_from: timestamptz, action: text }
CREATE OR REPLACE FUNCTION public.rotate_restroom_pin(
  p_restroom_id uuid,
  p_caller_user_id uuid,
  p_ciphertext_b64 text,
  p_iv_b64 text,
  p_auth_tag_b64 text,
  p_key_version integer,
  p_idempotency_key text default null,
  p_pin_hmac_b64 text default null
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_restroom public.restrooms;
  v_business public.businesses;
  v_existing_active public.restroom_lock_secrets;
  v_existing_idem public.restroom_lock_secrets;
  v_next_code_version integer;
  v_new_secret public.restroom_lock_secrets;
  v_user_status text;
  v_is_admin boolean := false;
  v_action text;
  v_audit_before jsonb := null;
  v_audit_after jsonb;
  v_retire_at timestamptz;
  v_effective_from timestamptz;
  v_clean_idem_key text := null;
  v_clean_hmac text := null;
BEGIN
  -- 1) Validate caller user existence and sanitize inputs
  IF p_caller_user_id IS NULL THEN
    RAISE EXCEPTION 'HM083: Caller user id is required' USING ERRCODE = '28000';
  END IF;

  IF p_restroom_id IS NULL THEN
    RAISE EXCEPTION 'HM086: Restroom id is required' USING ERRCODE = '22023';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    IF length(btrim(p_idempotency_key)) = 0 THEN
      RAISE EXCEPTION 'HM093: Idempotency key cannot be whitespace only' USING ERRCODE = '22023';
    END IF;
    v_clean_idem_key := btrim(p_idempotency_key);
  END IF;

  IF p_pin_hmac_b64 IS NOT NULL THEN
    IF length(btrim(p_pin_hmac_b64)) = 0 THEN
      RAISE EXCEPTION 'HM090: PIN HMAC cannot be whitespace only' USING ERRCODE = '22023';
    END IF;
    v_clean_hmac := btrim(p_pin_hmac_b64);
  END IF;

  -- Requirement 2: 멱등키가 존재하면 HMAC을 반드시 요구
  IF v_clean_idem_key IS NOT NULL AND v_clean_hmac IS NULL THEN
    RAISE EXCEPTION 'HM090: PIN HMAC is required when idempotency key is provided' USING ERRCODE = '22023';
  END IF;

  -- 2) Advisory transaction lock for idempotency key to coordinate concurrent multi-instance requests
  IF v_clean_idem_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('rotate_restroom_pin_idempotency'), hashtext(v_clean_idem_key));
  END IF;

  -- 3) Validate caller user existence and active account status BEFORE returning any result
  SELECT account_status INTO v_user_status
  FROM public.profiles
  WHERE id = p_caller_user_id;

  IF v_user_status IS NULL THEN
    RAISE EXCEPTION 'HM084: User profile % not found', p_caller_user_id USING ERRCODE = '23503';
  END IF;

  IF v_user_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'HM085: Caller account is suspended or inactive' USING ERRCODE = '42501';
  END IF;

  -- 4) Row-lock the restroom to prevent concurrent rotation race conditions & verify partner type
  SELECT * INTO v_restroom
  FROM public.restrooms
  WHERE id = p_restroom_id
  FOR UPDATE;

  IF v_restroom.id IS NULL THEN
    RAISE EXCEPTION 'HM086: Restroom % not found', p_restroom_id USING ERRCODE = 'P0002';
  END IF;

  IF v_restroom.type <> 'partner' OR v_restroom.business_id IS NULL THEN
    RAISE EXCEPTION 'HM087: Cannot register PIN on non-partner or unlinked restroom' USING ERRCODE = '42501';
  END IF;

  IF v_restroom.access_method <> 'pin' THEN
    RAISE EXCEPTION 'HM087: Restroom does not use PIN access method' USING ERRCODE = '42501';
  END IF;

  -- 5) Verify owning business registration status ('approved')
  -- Requirement 3: 관리자도 미승인 가게의 PIN을 등록할 수 없도록 가게 승인 상태 검사를 공통으로 적용
  SELECT * INTO v_business
  FROM public.businesses
  WHERE id = v_restroom.business_id;

  IF v_business.id IS NULL OR v_business.registration_status <> 'approved' THEN
    RAISE EXCEPTION 'HM088: Business owning this restroom is not approved' USING ERRCODE = '42501';
  END IF;

  -- 6) Check caller role & active ownership membership
  -- Requirement 3: 일반 구성원의 PIN 변경 가능 역할은 owner로 한정 (manager/staff 차단)
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = p_caller_user_id AND role = 'admin'
  ) INTO v_is_admin;

  IF NOT v_is_admin THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.business_members bm
      WHERE bm.business_id = v_restroom.business_id
        AND bm.user_id = p_caller_user_id
        AND bm.role = 'owner'
        AND bm.membership_status = 'active'
    ) THEN
      RAISE EXCEPTION 'HM088: Caller is not an active owner of the approved business owning this restroom'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 7) Check persistent database idempotency record (ONLY after all authorization checks pass!)
  -- Requirement 1: 가게 소속 권한이 해제된 사용자가 과거 멱등키로 replay를 시도하면 상기 권한검사에서 42501 차단됨
  IF v_clean_idem_key IS NOT NULL THEN
    SELECT * INTO v_existing_idem
    FROM public.restroom_lock_secrets
    WHERE idempotency_key = v_clean_idem_key;

    IF v_existing_idem.id IS NOT NULL THEN
      -- Requirement 1: Check same user and same restroom
      IF v_existing_idem.created_by <> p_caller_user_id OR v_existing_idem.restroom_id <> p_restroom_id THEN
        RAISE EXCEPTION 'HM091: Idempotency key collision across user or restroom' USING ERRCODE = '23505';
      END IF;

      -- Requirement 2: 기존 레코드 HMAC NULL인 경우 replay 거부
      IF v_existing_idem.pin_hmac_b64 IS NULL THEN
        RAISE EXCEPTION 'HM092: Replay not allowed for record without HMAC' USING ERRCODE = '23505';
      END IF;

      -- Requirement 2: HMAC 불일치는 HM092 / 23505
      IF v_existing_idem.pin_hmac_b64 <> v_clean_hmac THEN
        RAISE EXCEPTION 'HM092: Idempotency key collision with different PIN payload' USING ERRCODE = '23505';
      END IF;

      -- Replay existing code_version without creating new secret version or audit log
      RETURN jsonb_build_object(
        'success', true,
        'secret_id', v_existing_idem.id,
        'restroom_id', v_existing_idem.restroom_id,
        'code_version', v_existing_idem.code_version,
        'key_version', v_existing_idem.key_version,
        'valid_from', v_existing_idem.valid_from,
        'action', 'replay'
      );
    END IF;
  END IF;

  -- 8) Validate crypto parameters
  IF p_ciphertext_b64 IS NULL OR length(btrim(p_ciphertext_b64)) = 0 OR
     p_iv_b64 IS NULL OR length(btrim(p_iv_b64)) = 0 OR
     p_auth_tag_b64 IS NULL OR length(btrim(p_auth_tag_b64)) = 0 OR
     p_key_version IS NULL OR p_key_version <= 0 THEN
    RAISE EXCEPTION 'HM089: Invalid encryption payload parameters' USING ERRCODE = '22023';
  END IF;

  -- 9) Check current active secret for this restroom
  SELECT * INTO v_existing_active
  FROM public.restroom_lock_secrets
  WHERE restroom_id = p_restroom_id
    AND status = 'active'
  FOR UPDATE;

  IF v_existing_active.id IS NOT NULL THEN
    -- Rotating existing active PIN
    -- Ensure valid_until is strictly greater than valid_from even in same millisecond
    v_retire_at := GREATEST(clock_timestamp(), v_existing_active.valid_from + interval '1 millisecond');
    v_effective_from := v_retire_at;
    v_next_code_version := v_existing_active.code_version + 1;
    v_action := 'rotate_pin';

    -- Requirement 4: 감사로그 before_data는 실제 변경 이전 상태를 정확히 기록
    v_audit_before := jsonb_build_object(
      'code_version', v_existing_active.code_version,
      'key_version', v_existing_active.key_version,
      'status', v_existing_active.status,
      'valid_from', v_existing_active.valid_from,
      'valid_until', v_existing_active.valid_until
    );

    UPDATE public.restroom_lock_secrets
    SET status = 'rotated',
        valid_until = v_retire_at
    WHERE id = v_existing_active.id;
  ELSE
    -- Initial PIN registration
    v_effective_from := clock_timestamp();
    v_next_code_version := COALESCE((
      SELECT max(code_version)
      FROM public.restroom_lock_secrets
      WHERE restroom_id = p_restroom_id
    ), 0) + 1;
    v_action := 'register_pin';
    v_audit_before := NULL;
  END IF;

  -- 10) Insert new active secret (with persistent idempotency key & server-derived HMAC)
  INSERT INTO public.restroom_lock_secrets (
    restroom_id,
    ciphertext_b64,
    iv_b64,
    auth_tag_b64,
    key_version,
    code_version,
    valid_from,
    valid_until,
    status,
    created_by,
    created_at,
    idempotency_key,
    pin_hmac_b64
  ) VALUES (
    p_restroom_id,
    p_ciphertext_b64,
    p_iv_b64,
    p_auth_tag_b64,
    p_key_version,
    v_next_code_version,
    v_effective_from,
    NULL,
    'active',
    p_caller_user_id,
    v_effective_from,
    v_clean_idem_key,
    v_clean_hmac
  ) RETURNING * INTO v_new_secret;

  -- 11) Record append-only audit log
  -- STRICT INVARIANT: Never record PIN, ciphertext, IV, auth tag, HMAC, or key in audit logs!
  v_audit_after := jsonb_build_object(
    'code_version', v_new_secret.code_version,
    'key_version', v_new_secret.key_version,
    'status', 'active',
    'valid_from', v_new_secret.valid_from
  );

  INSERT INTO public.audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    before_data,
    after_data,
    reason,
    created_at
  ) VALUES (
    p_caller_user_id,
    v_action,
    'restroom_lock_secret',
    v_new_secret.id,
    v_audit_before,
    v_audit_after,
    NULL,
    v_effective_from
  );

  RETURN jsonb_build_object(
    'success', true,
    'secret_id', v_new_secret.id,
    'restroom_id', p_restroom_id,
    'code_version', v_new_secret.code_version,
    'key_version', v_new_secret.key_version,
    'valid_from', v_new_secret.valid_from,
    'action', v_action
  );

EXCEPTION
  WHEN unique_violation THEN
    -- If duplicate idempotency_key was committed concurrently by another transaction
    IF v_clean_idem_key IS NOT NULL THEN
      SELECT * INTO v_existing_idem
      FROM public.restroom_lock_secrets
      WHERE idempotency_key = v_clean_idem_key;

      IF v_existing_idem.id IS NOT NULL THEN
        IF v_existing_idem.created_by <> p_caller_user_id OR v_existing_idem.restroom_id <> p_restroom_id THEN
          RAISE EXCEPTION 'HM091: Idempotency key collision across user or restroom' USING ERRCODE = '23505';
        END IF;

        IF v_existing_idem.pin_hmac_b64 IS NULL THEN
          RAISE EXCEPTION 'HM092: Replay not allowed for record without HMAC' USING ERRCODE = '23505';
        END IF;

        IF v_existing_idem.pin_hmac_b64 <> v_clean_hmac THEN
          RAISE EXCEPTION 'HM092: Idempotency key collision with different PIN payload' USING ERRCODE = '23505';
        END IF;

        RETURN jsonb_build_object(
          'success', true,
          'secret_id', v_existing_idem.id,
          'restroom_id', v_existing_idem.restroom_id,
          'code_version', v_existing_idem.code_version,
          'key_version', v_existing_idem.key_version,
          'valid_from', v_existing_idem.valid_from,
          'action', 'replay'
        );
      END IF;
    END IF;
    RAISE;
END;
$$;

-- Grant execute only to service_role (Node.js server process)
REVOKE ALL ON FUNCTION public.rotate_restroom_pin(uuid, uuid, text, text, text, integer, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_restroom_pin(uuid, uuid, text, text, text, integer, text, text) TO service_role;
