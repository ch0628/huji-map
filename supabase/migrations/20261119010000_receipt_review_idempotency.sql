-- Migration: 20261119010000_receipt_review_idempotency.sql
-- Purpose: TASK 28 — Persistent Database-Level Idempotency for Receipt Review Decisions
-- Spec: docs/04_API_CONTRACT.md, docs/07_PAYMENT_ACCESS_REFUND.md, tasks/28_manual_review_backend.md
--
-- Enhancements:
--   1. Adds persistent idempotency_key and payload_hash columns to receipt_review_audits.
--   2. Adds unique index on receipt_review_audits(idempotency_key) to ensure exactly 1 audit row.
--   3. Overloads/replaces decide_receipt_review with DB-level atomic idempotency:
--      - Advisory transaction lock pg_advisory_xact_lock on idempotency_key
--      - Identical re-request replays prior decision without creating duplicate audit records (reused: true)
--      - Conflicting re-request with different payload or submission throws 23505 (HM094)
--      - Row-level lock FOR UPDATE on receipt_submissions eliminates race conditions
-- ==============================================================================

-- 1. Add persistent idempotency columns to receipt_review_audits
ALTER TABLE public.receipt_review_audits
  ADD COLUMN IF NOT EXISTS idempotency_key text NULL,
  ADD COLUMN IF NOT EXISTS payload_hash text NULL;

-- 2. Partial unique index on idempotency_key
CREATE UNIQUE INDEX IF NOT EXISTS idx_receipt_review_audits_idempotency_key
  ON public.receipt_review_audits (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 3. Enhance decide_receipt_review with DB-level atomic idempotency and advisory locks
CREATE OR REPLACE FUNCTION public.decide_receipt_review(
  p_submission_id uuid,
  p_reviewer_id uuid,
  p_decision text,
  p_reason text,
  p_store_name_confirmed text DEFAULT NULL,
  p_purchase_at_confirmed timestamptz DEFAULT NULL,
  p_purchase_amount_krw integer DEFAULT NULL,
  p_receipt_reference text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_payload_hash text DEFAULT NULL
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
  -- 1. Reviewer identity & authentication check
  v_reviewer_id := COALESCE(p_reviewer_id, auth.uid());

  IF v_reviewer_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED: reviewer identity is required'
      USING ERRCODE = '28000';
  END IF;

  -- 2. Administrator role verification (must be verified admin, not client-claimed)
  IF NOT COALESCE(public.is_admin(v_reviewer_id), false) THEN
    RAISE EXCEPTION 'FORBIDDEN_ADMIN_ONLY: only administrators can review receipts'
      USING ERRCODE = '42501';
  END IF;

  -- 3. Reviewer active account verification
  SELECT account_status INTO v_reviewer_status
  FROM public.profiles
  WHERE id = v_reviewer_id;

  IF v_reviewer_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'INACTIVE_ADMIN: administrator account is not active'
      USING ERRCODE = '42501';
  END IF;

  -- 4. Submission ID validation
  IF p_submission_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_SUBMISSION_ID: submission ID is required'
      USING ERRCODE = '22023';
  END IF;

  -- 5. Decision validation (approved, rejected, resubmission_requested)
  IF p_decision IS NULL OR trim(p_decision) = '' THEN
    RAISE EXCEPTION 'INVALID_DECISION: decision is required'
      USING ERRCODE = '22023';
  END IF;

  v_decision := lower(trim(p_decision));
  IF v_decision NOT IN ('approved', 'rejected', 'resubmission_requested') THEN
    RAISE EXCEPTION 'INVALID_DECISION_TYPE: decision must be approved, rejected, or resubmission_requested'
      USING ERRCODE = '22023';
  END IF;

  -- 6. Reason validation (mandatory, trimmed length 2 ~ 500 chars)
  IF p_reason IS NULL THEN
    RAISE EXCEPTION 'REASON_REQUIRED: review reason is mandatory'
      USING ERRCODE = '22023';
  END IF;

  v_reason := trim(p_reason);
  IF char_length(v_reason) < 2 OR char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'INVALID_REVIEW_REASON: reason must be between 2 and 500 characters'
      USING ERRCODE = '22023';
  END IF;

  -- 7. Persistent Idempotency Check & Advisory Transaction Lock
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
      -- Validate that the target submission matches and payload hash matches
      IF v_existing_audit.submission_id = p_submission_id AND
         (v_clean_payload_hash IS NULL OR v_existing_audit.payload_hash IS NULL OR v_existing_audit.payload_hash = v_clean_payload_hash) THEN
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

  -- 8. Acquire exclusive row-level lock on receipt_submissions to serialize concurrent reviews
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

  -- 9. Strict status transition & conflict checks
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

  -- 10. For approval: ensure no other receipt for the same access_session is already approved
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

  -- 11. Atomic update on receipt_submissions
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

  -- 12. Append-only record to receipt_review_audits with persistent idempotency data
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

        IF v_existing_audit.id IS NOT NULL AND v_existing_audit.submission_id = p_submission_id AND
           (v_clean_payload_hash IS NULL OR v_existing_audit.payload_hash IS NULL OR v_existing_audit.payload_hash = v_clean_payload_hash) THEN
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

  -- 13. Persist to system audit_logs for unified administrative observability
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

  -- 14. Return structured JSONB
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

-- Permissions: revoke from public/anon, grant execute to authenticated and service_role
REVOKE ALL ON FUNCTION public.decide_receipt_review(uuid, uuid, text, text, text, timestamptz, integer, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_receipt_review(uuid, uuid, text, text, text, timestamptz, integer, text, text, text) TO authenticated, service_role;

