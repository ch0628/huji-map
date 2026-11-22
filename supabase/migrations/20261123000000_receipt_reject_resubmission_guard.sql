-- Migration: 20261123000000_receipt_reject_resubmission_guard.sql
-- Purpose: TASK-02 B — Reject new receipt upload/submission when the latest submission
--          for the access session has already been rejected (only allow resubmission
--          when status is 'resubmission_requested' or no receipt has been submitted yet).
--
-- Note: Local migration only (remote DB application awaits user approval).

CREATE OR REPLACE FUNCTION public.validate_receipt_upload_intent(
  p_access_session_id uuid,
  p_caller_user_id uuid,
  p_file_size_bytes integer,
  p_mime_type text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_session record;
  v_payment_order_id uuid;
  v_refund_id uuid;
  v_pending_sub_id uuid;
  v_approved_sub_id uuid;
  v_latest_status text;
  v_window_hours integer;
  v_window_deadline timestamptz;
BEGIN
  -- 1) 입력 유효성 검증
  IF p_access_session_id IS NULL OR p_caller_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR', 'message', '필수 식별자가 누락되었습니다.', 'status', 400);
  END IF;

  IF p_file_size_bytes IS NULL OR p_file_size_bytes <= 0 OR p_file_size_bytes > 10485760 THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'INVALID_FILE_SIZE', 'message', '파일 크기는 1바이트 이상 10MB 이하여야 합니다.', 'status', 400);
  END IF;

  IF p_mime_type NOT IN ('image/jpeg', 'image/png', 'image/webp') THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'INVALID_MIME_TYPE', 'message', 'JPG, PNG, WebP 이미지만 업로드 가능합니다.', 'status', 400);
  END IF;

  -- 2) 호출자 활성 계정 검증
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_caller_user_id AND account_status = 'active'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'UNAUTHORIZED', 'message', '활성 상태의 회원만 이용 가능합니다.', 'status', 401);
  END IF;

  -- 3) 이용권 조회 및 소유권 검증
  SELECT s.id, s.user_id, s.status, s.authorized_at, s.expires_at, s.restroom_id, s.policy_id,
         p.receipt_window_hours, p.access_mode
  INTO v_session
  FROM public.access_sessions s
  JOIN public.restroom_access_policies p ON p.id = s.policy_id
  WHERE s.id = p_access_session_id;

  IF v_session.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'ACCESS_SESSION_NOT_FOUND', 'message', '이용권 정보를 찾을 수 없습니다.', 'status', 404);
  END IF;

  IF v_session.user_id <> p_caller_user_id THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'FORBIDDEN', 'message', '본인의 이용권에 대해서만 영수증을 제출할 수 있습니다.', 'status', 403);
  END IF;

  -- 4) 이용권 상태 검증
  IF v_session.status NOT IN ('authorized', 'code_revealed', 'completed') THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'INVALID_ACCESS_STATUS', 'message', '승인 완료된 이용권에 대해서만 영수증을 제출할 수 있습니다.', 'status', 422);
  END IF;

  -- 5) 결제 승인 완료 여부 검증
  SELECT id INTO v_payment_order_id
  FROM public.payment_orders
  WHERE access_session_id = p_access_session_id
    AND status = 'approved'
    AND payment_mode = 'test'
  LIMIT 1;

  IF v_payment_order_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'PAYMENT_NOT_APPROVED', 'message', '결제 승인이 완료되지 않은 이용권입니다.', 'status', 422);
  END IF;

  -- 6) 취소/환불 여부 검증
  SELECT pr.id INTO v_refund_id
  FROM public.payment_refunds pr
  WHERE pr.payment_order_id = v_payment_order_id
    AND pr.status IN ('succeeded', 'requested', 'processing')
  LIMIT 1;

  IF v_refund_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'PAYMENT_ALREADY_REFUNDED', 'message', '이미 취소 또는 환급 처리된 결제입니다.', 'status', 422);
  END IF;

  -- 7) 영수증 제출 기한(receipt_window_hours) 검증
  v_window_hours := COALESCE(v_session.receipt_window_hours, 24);
  IF v_session.authorized_at IS NOT NULL THEN
    v_window_deadline := v_session.authorized_at + (v_window_hours * INTERVAL '1 hour');
    IF clock_timestamp() > v_window_deadline THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error_code', 'RECEIPT_WINDOW_EXPIRED',
        'message', '영수증 제출 기한(' || v_window_hours || '시간)이 만료되었습니다.',
        'status', 422,
        'deadline', v_window_deadline
      );
    END IF;
  END IF;

  -- 8) 이미 승인된 영수증이 있는지 확인
  SELECT id INTO v_approved_sub_id
  FROM public.receipt_submissions
  WHERE access_session_id = p_access_session_id
    AND submission_status = 'approved'
  LIMIT 1;

  IF v_approved_sub_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'RECEIPT_ALREADY_APPROVED', 'message', '이미 승인 완료된 영수증이 존재합니다.', 'status', 409);
  END IF;

  -- 9) 현재 검토 중인 영수증이 있는지 확인 (중복 제출 방지)
  SELECT id INTO v_pending_sub_id
  FROM public.receipt_submissions
  WHERE access_session_id = p_access_session_id
    AND submission_status IN ('submitted', 'review_required')
  LIMIT 1;

  IF v_pending_sub_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'RECEIPT_UNDER_REVIEW', 'message', '현재 검토 중인 영수증이 있습니다. 심사 완료 후 재제출이 가능합니다.', 'status', 409);
  END IF;

  -- 10) 최신 제출 건이 반려(rejected)된 경우 재제출 차단 (관리자 재제출 요청 시에만 허용)
  SELECT submission_status INTO v_latest_status
  FROM public.receipt_submissions
  WHERE access_session_id = p_access_session_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  IF v_latest_status = 'rejected' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'RECEIPT_REJECTED',
      'message', '반려된 영수증은 다시 제출할 수 없습니다.',
      'status', 409
    );
  END IF;

  -- 모든 검증 통과
  RETURN jsonb_build_object(
    'ok', true,
    'access_session_id', v_session.id,
    'restroom_id', v_session.restroom_id,
    'receipt_window_hours', v_window_hours,
    'deadline', v_window_deadline
  );
END;
$$;

REVOKE ALL ON FUNCTION public.validate_receipt_upload_intent(uuid, uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_receipt_upload_intent(uuid, uuid, integer, text) TO service_role;
