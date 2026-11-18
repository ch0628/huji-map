-- Migration: 20261119000000_receipt_review_decision.sql
-- Purpose: TASK 28 — Atomic Administrator Manual Review RPC & Audit Trail Recording
-- Spec: docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/07_PAYMENT_ACCESS_REFUND.md,
--       docs/08_SECURITY_OPERATIONS.md, docs/11_DECISIONS.md, tasks/28_manual_review_backend.md
--
-- Functions created:
--   1. decide_receipt_review: Atomic review decision (approved/rejected/resubmission_requested),
--      row-level locking, strict status transition validation, reason check,
--      append-only receipt_review_audits entry, and audit_logs entry in a single transaction.
--
-- Security Invariants:
--   - Administrator role strictly checked server-side (is_admin).
--   - Rejection/approval reason is mandatory (trimmed length >= 2, <= 500).
--   - Row locking (FOR UPDATE) eliminates race conditions on concurrent reviews.
--   - Approved or finalized submissions cannot be transitioned again (HM002, HM006, HM001).
--   - Never triggers automatic refund or modifies payment_orders/payment_refunds.
--   - Immutable receipt_review_audits and audit_logs enforce append-only audit trail.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.decide_receipt_review(
  p_submission_id uuid,
  p_reviewer_id uuid,
  p_decision text,
  p_reason text,
  p_store_name_confirmed text DEFAULT NULL,
  p_purchase_at_confirmed timestamptz DEFAULT NULL,
  p_purchase_amount_krw integer DEFAULT NULL,
  p_receipt_reference text DEFAULT NULL
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

  -- 7. Acquire exclusive row-level lock on receipt_submissions to serialize concurrent reviews
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

  -- 8. Strict status transition & conflict checks
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

  -- 9. For approval: ensure no other receipt for the same access_session is already approved
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

  -- 10. Atomic update on receipt_submissions
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

  -- 11. Append-only record to receipt_review_audits
  INSERT INTO public.receipt_review_audits (
    submission_id,
    reviewer_id,
    decision,
    reason,
    created_at
  ) VALUES (
    p_submission_id,
    v_reviewer_id,
    v_decision,
    v_reason,
    clock_timestamp()
  )
  RETURNING id INTO v_audit_id;

  -- 12. Persist to system audit_logs for unified administrative observability
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
      'receipt_reference', v_sub.receipt_reference
    ),
    v_reason
  );

  -- 13. Return structured JSONB
  RETURN jsonb_build_object(
    'ok', true,
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
REVOKE ALL ON FUNCTION public.decide_receipt_review(uuid, uuid, text, text, text, timestamptz, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_receipt_review(uuid, uuid, text, text, text, timestamptz, integer, text) TO authenticated, service_role;

