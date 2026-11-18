-- ==============================================================================
-- Migration: 20261119020000_receipt_review_rpc_hardening.sql
-- Purpose: TASK 28 — Hardening decide_receipt_review RPC Privileges & Removing Legacy 8-Param Overload
-- Spec: docs/04_API_CONTRACT.md, docs/07_PAYMENT_ACCESS_REFUND.md,
--       docs/08_SECURITY_OPERATIONS.md, tasks/28_manual_review_backend.md
--
-- Security Hardening:
--   1. Drops legacy 8-parameter overload public.decide_receipt_review(uuid, uuid, text, text, text, timestamptz, integer, text)
--      using RESTRICT after verifying zero dependent objects, preventing idempotency bypass.
--   2. Replaces 10-parameter public.decide_receipt_review without parameter defaults so that
--      8-argument calls cannot silently fall back to NULL idempotency parameters.
--   3. Enforces defense-in-depth inside decide_receipt_review:
--      - Blocks direct execution from anon/authenticated roles (42501 FORBIDDEN_DIRECT_RPC)
--      - Blocks reviewer_id spoofing when JWT sub claim is present (42501 FORBIDDEN_ACTOR_SPOOFING)
--      - Verifies admin role via public.is_admin(v_reviewer_id) and active profile status
--      - Enforces strict payload_hash (IS NOT DISTINCT FROM), decision, reason, and submission_id
--        matching on idempotency replay (23505 HM094 on mismatch)
--   4. Revokes EXECUTE from PUBLIC, anon, and authenticated; grants EXECUTE exclusively to service_role.
-- ==============================================================================

-- 1. Drop legacy 8-parameter overload with RESTRICT (fails safely if any dependent object exists)
DROP FUNCTION IF EXISTS public.decide_receipt_review(
  uuid, uuid, text, text, text, timestamptz, integer, text
) RESTRICT;

-- 2. Drop 10-parameter version with parameter defaults using RESTRICT so we can recreate
--    without defaults (making 8-argument calls impossible at the SQL signature level)
DROP FUNCTION IF EXISTS public.decide_receipt_review(
  uuid, uuid, text, text, text, timestamptz, integer, text, text, text
) RESTRICT;

-- 3. Create hardened 10-parameter decide_receipt_review RPC (all 10 arguments required)
CREATE FUNCTION public.decide_receipt_review(
  p_submission_id uuid,
  p_reviewer_id uuid,
  p_decision text,
  p_reason text,
  p_store_name_confirmed text,
  p_purchase_at_confirmed timestamptz,
  p_purchase_amount_krw integer,
  p_receipt_reference text,
  p_idempotency_key text,
  p_payload_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_reviewer_id uuid;
  v_reviewer_status text;
  v_decision text;
  v_reason text;
  v_clean_idem_key text;
  v_clean_payload_hash text;
  v_existing_audit record;
  v_sub public.receipt_submissions%ROWTYPE;
  v_old_status text;
  v_old_reviewed_by uuid;
  v_old_reviewed_at timestamptz;
  v_audit_id uuid;
BEGIN
  -- 1. Defense-in-depth: block direct execution by client roles even if privileges were misconfigured
  IF COALESCE(auth.role(), '') IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'FORBIDDEN_DIRECT_RPC: direct client execution is not permitted'
      USING ERRCODE = '42501';
  END IF;

  -- 2. Prevent reviewer_id spoofing when a JWT sub claim is present in session context
  IF auth.uid() IS NOT NULL AND p_reviewer_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'FORBIDDEN_ACTOR_SPOOFING: reviewer_id does not match authenticated user'
      USING ERRCODE = '42501';
  END IF;

  -- 3. Reviewer identity check
  v_reviewer_id := p_reviewer_id;

  IF v_reviewer_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED: reviewer identity is required'
      USING ERRCODE = '28000';
  END IF;

  -- 4. Administrator role verification (must be verified admin in user_roles, never client-claimed)
  IF NOT COALESCE(public.is_admin(v_reviewer_id), false) THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: only administrators can review receipts'
      USING ERRCODE = '42501';
  END IF;

  -- 5. Reviewer active account verification
  SELECT account_status INTO v_reviewer_status
  FROM public.profiles
  WHERE id = v_reviewer_id;

  IF v_reviewer_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'INACTIVE_ADMIN: administrator account is not active'
      USING ERRCODE = '42501';
  END IF;

  -- 6. Submission ID validation
  IF p_submission_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_SUBMISSION_ID: submission ID is required'
      USING ERRCODE = '22023';
  END IF;

  -- 7. Decision validation (approved, rejected, resubmission_requested)
  IF p_decision IS NULL OR trim(p_decision) = '' THEN
    RAISE EXCEPTION 'INVALID_DECISION: decision is required'
      USING ERRCODE = '22023';
  END IF;

  v_decision := lower(trim(p_decision));
  IF v_decision NOT IN ('approved', 'rejected', 'resubmission_requested') THEN
    RAISE EXCEPTION 'INVALID_DECISION_TYPE: decision must be approved, rejected, or resubmission_requested'
      USING ERRCODE = '22023';
  END IF;

  -- 8. Reason validation (mandatory, trimmed length 2 ~ 500 chars)
  IF p_reason IS NULL THEN
    RAISE EXCEPTION 'REASON_REQUIRED: review reason is mandatory'
      USING ERRCODE = '22023';
  END IF;

  v_reason := trim(p_reason);
  IF char_length(v_reason) < 2 OR char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'INVALID_REVIEW_REASON: reason must be between 2 and 500 characters'
      USING ERRCODE = '22023';
  END IF;

  -- 9. Persistent Idempotency Check & Advisory Transaction Lock
  v_clean_idem_key := NULLIF(btrim(p_idempotency_key), '');
  v_clean_payload_hash := NULLIF(btrim(p_payload_hash), '');

  IF v_clean_idem_key IS NOT NULL THEN
    -- Serialize concurrent requests using the same idempotency key across all instances
    PERFORM pg_advisory_xact_lock(hashtext('receipt_review_idempotency'), hashtext(v_clean_idem_key));

    -- Check if this idempotency key was already processed and persisted
    SELECT * INTO v_existing_audit
    FROM public.receipt_review_audits
    WHERE idempotency_key = v_clean_idem_key;

    IF v_existing_audit.id IS NOT NULL THEN
      -- Validate that the target submission, decision, reason, and payload hash match
      IF v_existing_audit.submission_id = p_submission_id
         AND v_existing_audit.decision = v_decision
         AND v_existing_audit.reason = v_reason
         AND v_existing_audit.payload_hash IS NOT DISTINCT FROM v_clean_payload_hash THEN
        -- Fetch existing submission state
        SELECT * INTO v_sub
        FROM public.receipt_submissions
        WHERE id = p_submission_id;

        -- Return prior result with reused: true; NO duplicate audit log created
        RETURN jsonb_build_object(
          'ok', true,
          'reused', true,
          'receipt', jsonb_build_object(
            'id', v_sub.id,
            'access_session_id', v_sub.access_session_id,
            'user_id', v_sub.user_id,
            'storage_path', v_sub.storage_path,
            'mime_type', v_sub.mime_type,
            'file_size_bytes', v_sub.file_size_bytes,
            'original_filename', v_sub.original_filename,
            'submission_status', v_sub.submission_status,
            'store_name_confirmed', v_sub.store_name_confirmed,
            'purchase_at_confirmed', v_sub.purchase_at_confirmed,
            'purchase_amount_krw', v_sub.purchase_amount_krw,
            'receipt_reference', v_sub.receipt_reference,
            'reviewed_by', v_sub.reviewed_by,
            'reviewed_at', v_sub.reviewed_at,
            'review_reason', v_sub.review_reason,
            'created_at', v_sub.created_at,
            'updated_at', v_sub.updated_at
          ),
          'audit_id', v_existing_audit.id
        );
      ELSE
        -- Same idempotency key used with conflicting payload or different submission -> 409 Conflict
        RAISE EXCEPTION 'HM094: Idempotency key conflict with different payload or submission'
          USING ERRCODE = '23505';
      END IF;
    END IF;
  END IF;

  -- 10. Acquire exclusive row-level lock on receipt_submissions to serialize concurrent reviews
  SELECT * INTO v_sub
  FROM public.receipt_submissions
  WHERE id = p_submission_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RECEIPT_NOT_FOUND: receipt submission does not exist'
      USING ERRCODE = 'P0002';
  END IF;

  v_old_status := v_sub.submission_status;
  v_old_reviewed_by := v_sub.reviewed_by;
  v_old_reviewed_at := v_sub.reviewed_at;

  -- 11. Strict status transition & conflict checks
  IF v_old_status = 'approved' THEN
    RAISE EXCEPTION 'ALREADY_APPROVED: receipt has already been approved'
      USING ERRCODE = 'HM002';
  END IF;

  IF v_old_status IN ('rejected', 'resubmission_requested') THEN
    RAISE EXCEPTION 'ALREADY_FINALIZED: receipt review has already been finalized'
      USING ERRCODE = 'HM006';
  END IF;

  IF v_old_status NOT IN ('submitted', 'review_required') THEN
    RAISE EXCEPTION 'INVALID_STATUS_TRANSITION: can only review receipts in submitted or review_required status'
      USING ERRCODE = 'HM001';
  END IF;

  -- 12. For approval: ensure no other receipt for the same access_session is already approved
  IF v_decision = 'approved' THEN
    IF EXISTS (
      SELECT 1 FROM public.receipt_submissions
      WHERE access_session_id = v_sub.access_session_id
        AND submission_status = 'approved'
        AND id <> p_submission_id
    ) THEN
      RAISE EXCEPTION 'SESSION_ALREADY_HAS_APPROVED_RECEIPT: session already has an approved receipt'
        USING ERRCODE = 'HM002';
    END IF;
  END IF;

  -- 13. Atomic update on receipt_submissions
  UPDATE public.receipt_submissions
  SET
    submission_status = v_decision,
    reviewed_by = v_reviewer_id,
    reviewed_at = clock_timestamp(),
    review_reason = v_reason,
    store_name_confirmed = COALESCE(p_store_name_confirmed, store_name_confirmed),
    purchase_at_confirmed = COALESCE(p_purchase_at_confirmed, purchase_at_confirmed),
    purchase_amount_krw = COALESCE(p_purchase_amount_krw, purchase_amount_krw),
    receipt_reference = COALESCE(p_receipt_reference, receipt_reference)
  WHERE id = p_submission_id
  RETURNING * INTO v_sub;

  -- 14. Append-only record to receipt_review_audits with persistent idempotency data
  BEGIN
    INSERT INTO public.receipt_review_audits (
      submission_id,
      reviewer_id,
      decision,
      reason,
      idempotency_key,
      payload_hash,
      created_at
    ) VALUES (
      p_submission_id,
      v_reviewer_id,
      v_decision,
      v_reason,
      v_clean_idem_key,
      v_clean_payload_hash,
      clock_timestamp()
    )
    RETURNING id INTO v_audit_id;
  EXCEPTION
    WHEN unique_violation THEN
      -- If duplicate idempotency_key was committed concurrently by another transaction
      IF v_clean_idem_key IS NOT NULL THEN
        SELECT * INTO v_existing_audit
        FROM public.receipt_review_audits
        WHERE idempotency_key = v_clean_idem_key;

        IF v_existing_audit.id IS NOT NULL
           AND v_existing_audit.submission_id = p_submission_id
           AND v_existing_audit.decision = v_decision
           AND v_existing_audit.reason = v_reason
           AND v_existing_audit.payload_hash IS NOT DISTINCT FROM v_clean_payload_hash THEN
          RETURN jsonb_build_object(
            'ok', true,
            'reused', true,
            'receipt', row_to_json(v_sub),
            'audit_id', v_existing_audit.id
          );
        ELSE
          RAISE EXCEPTION 'HM094: Idempotency key conflict with different payload or submission'
            USING ERRCODE = '23505';
        END IF;
      ELSE
        RAISE;
      END IF;
  END;

  -- 15. Persist to system audit_logs for unified administrative observability
  INSERT INTO public.audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    before_data,
    after_data,
    reason
  ) VALUES (
    v_reviewer_id,
    'receipt_review_' || v_decision,
    'receipt_submissions',
    p_submission_id,
    jsonb_build_object(
      'submission_status', v_old_status,
      'reviewed_by', v_old_reviewed_by,
      'reviewed_at', v_old_reviewed_at
    ),
    jsonb_build_object(
      'submission_status', v_decision,
      'reviewed_by', v_reviewer_id,
      'reviewed_at', v_sub.reviewed_at,
      'review_reason', v_reason,
      'store_name_confirmed', v_sub.store_name_confirmed,
      'purchase_amount_krw', v_sub.purchase_amount_krw,
      'purchase_at_confirmed', v_sub.purchase_at_confirmed,
      'receipt_reference', v_sub.receipt_reference,
      'idempotency_key', v_clean_idem_key
    ),
    v_reason
  );

  -- 16. Return structured JSONB
  RETURN jsonb_build_object(
    'ok', true,
    'reused', false,
    'receipt', jsonb_build_object(
      'id', v_sub.id,
      'access_session_id', v_sub.access_session_id,
      'user_id', v_sub.user_id,
      'storage_path', v_sub.storage_path,
      'mime_type', v_sub.mime_type,
      'file_size_bytes', v_sub.file_size_bytes,
      'original_filename', v_sub.original_filename,
      'submission_status', v_sub.submission_status,
      'store_name_confirmed', v_sub.store_name_confirmed,
      'purchase_at_confirmed', v_sub.purchase_at_confirmed,
      'purchase_amount_krw', v_sub.purchase_amount_krw,
      'receipt_reference', v_sub.receipt_reference,
      'reviewed_by', v_sub.reviewed_by,
      'reviewed_at', v_sub.reviewed_at,
      'review_reason', v_sub.review_reason,
      'created_at', v_sub.created_at,
      'updated_at', v_sub.updated_at
    ),
    'audit_id', v_audit_id
  );
END;
$$;

-- 4. Strict Privilege Isolation:
--    - PUBLIC: REVOKE EXECUTE
--    - anon: REVOKE EXECUTE
--    - authenticated: REVOKE EXECUTE
--    - service_role: GRANT EXECUTE ONLY
REVOKE ALL ON FUNCTION public.decide_receipt_review(
  uuid, uuid, text, text, text, timestamptz, integer, text, text, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.decide_receipt_review(
  uuid, uuid, text, text, text, timestamptz, integer, text, text, text
) TO service_role;

