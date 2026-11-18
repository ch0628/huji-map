-- Migration: 20261118000000_receipt_backend.sql
-- Purpose: TASK 26 — Private Receipt Storage, DB Schema, Access Control, and Backend API
-- Spec: docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/07_PAYMENT_ACCESS_REFUND.md,
--       docs/08_SECURITY_OPERATIONS.md, docs/11_DECISIONS.md, tasks/26_receipt_backend.md
--
-- Tables created/modified:
--   1. receipt_submissions: Customer store purchase receipt submissions (manual review, no OCR)
--   2. receipt_review_audits: Append-only manual review audit trail
--   3. payment_refunds: Add foreign key constraint to receipt_submissions(id)
--   4. Storage: 'receipts' private bucket & RLS policies (conditional on storage schema)
--
-- Security Invariants:
--   - Receipts bucket is strictly PRIVATE (public = false). 0 public URLs.
--   - Plaintext receipts can only be uploaded and read by verified access owner or admin.
--   - Receipts can only be submitted for valid, approved test payment orders of owned sessions.
--   - Receipt window (receipt_window_hours) is strictly enforced server-side.
--   - Duplicate submissions during review are rejected; approved sessions cannot submit new receipts.
--   - Submissions cannot self-approve; status starts at 'submitted' and can only be reviewed by admin.
--   - Mutation of completed review audits is strictly forbidden.
-- ==============================================================================

-- 1. receipt_submissions (영수증 비공개 제출 및 수동 심사 정보)
CREATE TABLE IF NOT EXISTS public.receipt_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_session_id uuid NOT NULL REFERENCES public.access_sessions(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  storage_path text NOT NULL CHECK (char_length(trim(storage_path)) > 0 AND char_length(storage_path) <= 500),
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  file_size_bytes integer NOT NULL CHECK (file_size_bytes > 0 AND file_size_bytes <= 10485760),
  original_filename text NULL CHECK (original_filename IS NULL OR char_length(original_filename) <= 255),
  client_submission_id text NOT NULL UNIQUE CHECK (char_length(trim(client_submission_id)) >= 8 AND char_length(client_submission_id) <= 128),
  submission_status text NOT NULL DEFAULT 'submitted' CHECK (submission_status IN ('submitted', 'review_required', 'approved', 'rejected', 'resubmission_requested')),
  store_name_confirmed text NULL CHECK (store_name_confirmed IS NULL OR char_length(store_name_confirmed) <= 100),
  purchase_at_confirmed timestamptz NULL,
  purchase_amount_krw integer NULL CHECK (purchase_amount_krw IS NULL OR purchase_amount_krw >= 0),
  receipt_reference text NULL CHECK (receipt_reference IS NULL OR char_length(receipt_reference) <= 100),
  reviewed_by uuid NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reviewed_at timestamptz NULL,
  review_reason text NULL CHECK (review_reason IS NULL OR char_length(review_reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- 인덱스 및 무결성 제약
-- docs/03: 유효한 승인 영수증은 access_session당 최대 하나
CREATE UNIQUE INDEX IF NOT EXISTS idx_receipt_submissions_single_approved_per_session
  ON public.receipt_submissions (access_session_id)
  WHERE (submission_status = 'approved');

-- 진행 중인 심사(submitted 또는 review_required)가 있을 때 중복 제출 방지
CREATE UNIQUE INDEX IF NOT EXISTS idx_receipt_submissions_single_pending_per_session
  ON public.receipt_submissions (access_session_id)
  WHERE (submission_status IN ('submitted', 'review_required'));

-- 상태별/생성일별 조회 인덱스 (docs/03 #12)
CREATE INDEX IF NOT EXISTS idx_receipt_submissions_status_created
  ON public.receipt_submissions (submission_status, created_at);

-- 사용자별 조회 인덱스 (마이페이지용)
CREATE INDEX IF NOT EXISTS idx_receipt_submissions_user_id
  ON public.receipt_submissions (user_id);

-- 이용권별 조회 인덱스
CREATE INDEX IF NOT EXISTS idx_receipt_submissions_session_id
  ON public.receipt_submissions (access_session_id);

-- updated_at 트리거
DROP TRIGGER IF EXISTS set_receipt_submissions_updated_at ON public.receipt_submissions;
CREATE TRIGGER set_receipt_submissions_updated_at
  BEFORE UPDATE ON public.receipt_submissions
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- 2. receipt_review_audits (영수증 심사 변경 이력: append-only)
CREATE TABLE IF NOT EXISTS public.receipt_review_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES public.receipt_submissions(id) ON DELETE RESTRICT,
  reviewer_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected', 'resubmission_requested')),
  reason text NOT NULL CHECK (char_length(trim(reason)) >= 2 AND char_length(reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_receipt_review_audits_submission_id
  ON public.receipt_review_audits (submission_id);

CREATE INDEX IF NOT EXISTS idx_receipt_review_audits_reviewer_id
  ON public.receipt_review_audits (reviewer_id);

-- 불변 감사 로그 트리거 함수
CREATE OR REPLACE FUNCTION public.prevent_receipt_review_audits_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'HM115: receipt_review_audits is an append-only audit trail and cannot be updated or deleted'
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_receipt_review_audits_mutation ON public.receipt_review_audits;
CREATE TRIGGER trg_prevent_receipt_review_audits_mutation
  BEFORE UPDATE OR DELETE ON public.receipt_review_audits
  FOR EACH ROW EXECUTE FUNCTION public.prevent_receipt_review_audits_mutation();

-- 3. payment_refunds.receipt_submission_id 컬럼 보장 및 FK 연결
ALTER TABLE public.payment_refunds
  ADD COLUMN IF NOT EXISTS receipt_submission_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_payment_refunds_receipt_submission'
      AND table_name = 'payment_refunds'
  ) THEN
    ALTER TABLE public.payment_refunds
      ADD CONSTRAINT fk_payment_refunds_receipt_submission
      FOREIGN KEY (receipt_submission_id)
      REFERENCES public.receipt_submissions(id)
      ON DELETE RESTRICT;
  END IF;
END $$;

-- 4. receipt_submissions 무결성 검증 트리거
CREATE OR REPLACE FUNCTION public.enforce_receipt_submission_rules()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_session_user_id uuid;
  v_expected_prefix text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- 초기 제출 상태는 오직 submitted 만 가능
    IF NEW.submission_status <> 'submitted' THEN
      RAISE EXCEPTION 'HM111: initial receipt submission status must be submitted'
        USING ERRCODE = '22023';
    END IF;

    -- 초기 제출 시 관리자 확인 컬럼 및 검수 정보는 반드시 NULL
    IF NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR
       NEW.store_name_confirmed IS NOT NULL OR NEW.purchase_at_confirmed IS NOT NULL OR
       NEW.purchase_amount_krw IS NOT NULL OR NEW.receipt_reference IS NOT NULL OR
       NEW.review_reason IS NOT NULL THEN
      RAISE EXCEPTION 'HM112: cannot specify review confirmations on initial submission'
        USING ERRCODE = '42501';
    END IF;

    -- 소유권 무결성: access_sessions.user_id 와 일치해야 함
    SELECT user_id INTO v_session_user_id
    FROM public.access_sessions
    WHERE id = NEW.access_session_id;

    IF v_session_user_id IS NULL THEN
      RAISE EXCEPTION 'HM102: access session not found'
        USING ERRCODE = 'P0002';
    END IF;

    IF v_session_user_id <> NEW.user_id THEN
      RAISE EXCEPTION 'HM103: receipt submitter must match access session owner'
        USING ERRCODE = '42501';
    END IF;

    -- storage_path 형식 검증: receipts/{user_id}/{access_session_id}/...
    v_expected_prefix := 'receipts/' || NEW.user_id::text || '/' || NEW.access_session_id::text || '/';
    IF NOT (NEW.storage_path LIKE (v_expected_prefix || '%')) THEN
      RAISE EXCEPTION 'HM110: invalid storage path pattern for receipt submission'
        USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- 불변 핵심 식별자 및 제출 데이터 변조 원천 차단
    IF NEW.id <> OLD.id OR
       NEW.access_session_id <> OLD.access_session_id OR
       NEW.user_id <> OLD.user_id OR
       NEW.storage_path <> OLD.storage_path OR
       NEW.mime_type <> OLD.mime_type OR
       NEW.file_size_bytes <> OLD.file_size_bytes OR
       NEW.client_submission_id <> OLD.client_submission_id OR
       NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'HM113: immutable receipt submission fields cannot be modified'
        USING ERRCODE = '42501';
    END IF;

    -- 심사 완료(approved, rejected, resubmission_requested) 전이 시 검수자 및 검수시각 필수
    IF NEW.submission_status IN ('approved', 'rejected', 'resubmission_requested') THEN
      IF NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL THEN
        RAISE EXCEPTION 'HM116: reviewed_by and reviewed_at are required for review decisions'
          USING ERRCODE = '22023';
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HM114: receipt submissions cannot be deleted'
      USING ERRCODE = '42501';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_receipt_submission_rules ON public.receipt_submissions;
CREATE TRIGGER trg_enforce_receipt_submission_rules
  BEFORE INSERT OR UPDATE OR DELETE ON public.receipt_submissions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_receipt_submission_rules();

-- 5. 원자적 검증 함수: validate_receipt_upload_intent
--    업로드 인텐트 발급 전 서버 측에서 이용권 소유권, 결제 승인, 환불 여부, 제출 기한, 진행 중인 심사 여부를 종합 검증
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

-- 6. 원자적 제출 RPC: submit_customer_receipt
--    트랜잭션 락, 멱등키 처리, 정합성 검증, 단일 행 생성을 단일 트랜잭션으로 원자적 보장
CREATE OR REPLACE FUNCTION public.submit_customer_receipt(
  p_access_session_id uuid,
  p_caller_user_id uuid,
  p_storage_path text,
  p_mime_type text,
  p_file_size_bytes integer,
  p_original_filename text,
  p_client_submission_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_intent_check jsonb;
  v_existing_sub record;
  v_new_sub record;
BEGIN
  -- 1) 입력 유효성 검증
  IF p_access_session_id IS NULL OR p_caller_user_id IS NULL OR
     p_storage_path IS NULL OR trim(p_storage_path) = '' OR
     p_client_submission_id IS NULL OR trim(p_client_submission_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR', 'message', '필수 제출 정보가 누락되었습니다.', 'status', 400);
  END IF;

  -- 2) 세션 단위 트랜잭션 자문 잠금 (동시 다중 제출 레이스 컨디션 차단)
  PERFORM pg_advisory_xact_lock(hashtext('receipt_sub:' || p_access_session_id::text));

  -- 3) client_submission_id 전역 멱등성 검사
  SELECT * INTO v_existing_sub
  FROM public.receipt_submissions
  WHERE client_submission_id = p_client_submission_id;

  IF v_existing_sub.id IS NOT NULL THEN
    -- 기존 요청과 동일한 이용권 및 소유자 호출인지 확인
    IF v_existing_sub.access_session_id = p_access_session_id AND v_existing_sub.user_id = p_caller_user_id THEN
      RETURN jsonb_build_object(
        'ok', true,
        'reused', true,
        'receipt', jsonb_build_object(
          'id', v_existing_sub.id,
          'access_session_id', v_existing_sub.access_session_id,
          'user_id', v_existing_sub.user_id,
          'storage_path', v_existing_sub.storage_path,
          'mime_type', v_existing_sub.mime_type,
          'file_size_bytes', v_existing_sub.file_size_bytes,
          'original_filename', v_existing_sub.original_filename,
          'submission_status', v_existing_sub.submission_status,
          'created_at', v_existing_sub.created_at
        )
      );
    ELSE
      RETURN jsonb_build_object('ok', false, 'error_code', 'IDEMPOTENCY_CONFLICT', 'message', '동일한 제출 식별자가 이미 다른 세션에 사용되었습니다.', 'status', 409);
    END IF;
  END IF;

  -- 4) 공통 정책 및 자격 조건 사전 검증
  v_intent_check := public.validate_receipt_upload_intent(
    p_access_session_id,
    p_caller_user_id,
    p_file_size_bytes,
    p_mime_type
  );

  IF NOT (v_intent_check->>'ok')::boolean THEN
    RETURN v_intent_check;
  END IF;

  -- 5) 영수증 행 원자적 삽입 (트리거 enforce_receipt_submission_rules 에서 소유권/경로 추가 검증)
  BEGIN
    INSERT INTO public.receipt_submissions (
      access_session_id,
      user_id,
      storage_path,
      mime_type,
      file_size_bytes,
      original_filename,
      client_submission_id,
      submission_status
    ) VALUES (
      p_access_session_id,
      p_caller_user_id,
      p_storage_path,
      p_mime_type,
      p_file_size_bytes,
      p_original_filename,
      p_client_submission_id,
      'submitted'
    )
    RETURNING * INTO v_new_sub;
  EXCEPTION
    WHEN unique_violation THEN
      -- 동시성 경합으로 인한 고유 제약 위반 포착
      RETURN jsonb_build_object('ok', false, 'error_code', 'SUBMISSION_COLLISION', 'message', '이미 처리 중이거나 중복된 영수증 제출입니다.', 'status', 409);
  END;

  RETURN jsonb_build_object(
    'ok', true,
    'reused', false,
    'receipt', jsonb_build_object(
      'id', v_new_sub.id,
      'access_session_id', v_new_sub.access_session_id,
      'user_id', v_new_sub.user_id,
      'storage_path', v_new_sub.storage_path,
      'mime_type', v_new_sub.mime_type,
      'file_size_bytes', v_new_sub.file_size_bytes,
      'original_filename', v_new_sub.original_filename,
      'submission_status', v_new_sub.submission_status,
      'created_at', v_new_sub.created_at
    )
  );
END;
$$;

-- 7. 권한 회수 및 RLS 활성화
ALTER TABLE public.receipt_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receipt_review_audits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.receipt_submissions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.receipt_review_audits FROM PUBLIC, anon, authenticated;

-- authenticated(로그인 고객): 본인 제출 영수증 또는 관리자만 안전 컬럼 SELECT 가능
GRANT SELECT (
  id,
  access_session_id,
  user_id,
  storage_path,
  mime_type,
  file_size_bytes,
  original_filename,
  submission_status,
  store_name_confirmed,
  purchase_at_confirmed,
  purchase_amount_krw,
  reviewed_at,
  review_reason,
  created_at,
  updated_at
) ON public.receipt_submissions TO authenticated;

-- RLS SELECT 정책
DROP POLICY IF EXISTS receipt_submissions_select_own_or_admin ON public.receipt_submissions;
CREATE POLICY receipt_submissions_select_own_or_admin
  ON public.receipt_submissions
  FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_admin(auth.uid())
  );

-- receipt_review_audits: 관리자만 SELECT 가능
GRANT SELECT ON public.receipt_review_audits TO authenticated;

DROP POLICY IF EXISTS receipt_review_audits_select_admin ON public.receipt_review_audits;
CREATE POLICY receipt_review_audits_select_admin
  ON public.receipt_review_audits
  FOR SELECT
  TO authenticated
  USING (
    public.is_admin(auth.uid())
  );

-- service_role(서버 프로세스): 전체 테이블 ALL 권한 부여
GRANT ALL ON public.receipt_submissions TO service_role;
GRANT ALL ON public.receipt_review_audits TO service_role;

-- RPC 실행 권한: 외부 직접 호출 차단, service_role 전용
REVOKE ALL ON FUNCTION public.validate_receipt_upload_intent(uuid, uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_receipt_upload_intent(uuid, uuid, integer, text) TO service_role;

REVOKE ALL ON FUNCTION public.submit_customer_receipt(uuid, uuid, text, text, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_customer_receipt(uuid, uuid, text, text, integer, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.prevent_receipt_review_audits_mutation() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prevent_receipt_review_audits_mutation() TO service_role;

REVOKE ALL ON FUNCTION public.enforce_receipt_submission_rules() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enforce_receipt_submission_rules() TO service_role;

-- 8. Supabase Storage 비공개 버킷 설정 (storage 스키마가 존재하는 환경에서만 적용)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'storage') THEN
    -- receipts 버킷을 private (public = false)으로 등록
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'receipts',
      'receipts',
      false,
      10485760,
      ARRAY['image/jpeg', 'image/png', 'image/webp']
    )
    ON CONFLICT (id) DO UPDATE SET
      public = false,
      file_size_limit = 10485760,
      allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];

    -- 본인 폴더(receipts/{auth.uid()}/... 또는 {auth.uid()}/...) 또는 관리자만 조회 허용
    DROP POLICY IF EXISTS "receipts_select_own_or_admin" ON storage.objects;
    CREATE POLICY "receipts_select_own_or_admin"
      ON storage.objects
      FOR SELECT
      TO authenticated
      USING (
        bucket_id = 'receipts'
        AND (
          public.is_admin(auth.uid())
          OR (
            (storage.foldername(name))[1] = 'receipts'
            AND (storage.foldername(name))[2] = auth.uid()::text
          )
          OR (
            (storage.foldername(name))[1] = auth.uid()::text
          )
        )
      );

    -- 영수증 업로드는 서버가 발급한 signed upload URL을 통해서만 수행 (일반 사용자의 직접 Storage INSERT 차단, 관리자만 허용)
    DROP POLICY IF EXISTS "receipts_insert_own_or_admin" ON storage.objects;
    DROP POLICY IF EXISTS "receipts_insert_admin_only" ON storage.objects;
    CREATE POLICY "receipts_insert_admin_only"
      ON storage.objects
      FOR INSERT
      TO authenticated
      WITH CHECK (
        bucket_id = 'receipts'
        AND public.is_admin(auth.uid())
      );

    -- 영수증 이미지 삭제는 관리자만 허용 (고객의 임의 삭제 증적 은닉 방지)
    DROP POLICY IF EXISTS "receipts_delete_admin_only" ON storage.objects;
    CREATE POLICY "receipts_delete_admin_only"
      ON storage.objects
      FOR DELETE
      TO authenticated
      USING (
        bucket_id = 'receipts'
        AND public.is_admin(auth.uid())
      );
  END IF;
END $$;

