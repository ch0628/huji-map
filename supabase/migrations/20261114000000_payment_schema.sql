-- ==============================================================================
-- Migration: 20261114000000_payment_schema.sql
-- Description: TASK 20 - 테스트 보증금 주문 및 화장실 이용권 DB 스키마 (보안 및 무결성 보완)
-- Spec: docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/07_PAYMENT_ACCESS_REFUND.md,
--       docs/08_SECURITY_OPERATIONS.md, docs/11_DECISIONS.md, tasks/20_payment_schema.md
-- Tables:
--   1. access_sessions (실제 화장실 접근 권한 및 출입 세션)
--   2. payment_orders (토스페이먼츠 테스트 보증금 주문 및 승인 스냅샷)
--   3. payment_refunds (1회 전액 환급 관리자 요청 및 상태)
-- Constraints & Triggers:
--   - 민감 컬럼(provider_payment_key, provider_cancel_id, idempotency_key) 직접 조회 원천 차단
--   - 승인된 결제 주문의 불변성 강화 (approved_at, provider_payment_key 사후 변조 차단)
--   - 완료된 환급의 감사정보 보호 (completed_at, provider_cancel_id 사후 변조 차단)
--   - 이용권의 결제 승인 연계 무결성 (approved 결제 부재 시 authorized 전이 차단)
--   - 1이용권 1성공결제 (idx_payment_orders_single_approved_per_session)
--   - 1결제 1전액환불 (payment_order_id UNIQUE)
--   - 제휴 화장실 전용 이용권 (공공 화장실 이용권 발급 원천 차단)
--   - event_logs.access_session_id FK 연결 (ON DELETE SET NULL)
-- RLS & Privileges:
--   - 기본 거부, service_role 전용 DML, authenticated 안전 컬럼 SELECT 전용 (RLS 본인 격리)
-- ==============================================================================

-- 1. access_sessions (실제 화장실 접근 권한 및 출입 세션)
CREATE TABLE IF NOT EXISTS public.access_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  restroom_id uuid NOT NULL REFERENCES public.restrooms(id) ON DELETE RESTRICT,
  policy_id uuid NOT NULL REFERENCES public.restroom_access_policies(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'authorized', 'code_revealed', 'completed', 'failed', 'expired', 'canceled')),
  access_method_snapshot text NOT NULL CHECK (access_method_snapshot IN ('open', 'ask_staff', 'pin')),
  idempotency_key text NOT NULL UNIQUE,
  authorized_at timestamptz NULL,
  code_revealed_at timestamptz NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_access_sessions_expiry CHECK (expires_at > created_at)
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_access_sessions_user_id_created_at
  ON public.access_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_sessions_restroom_id
  ON public.access_sessions(restroom_id);
CREATE INDEX IF NOT EXISTS idx_access_sessions_policy_id
  ON public.access_sessions(policy_id);
CREATE INDEX IF NOT EXISTS idx_access_sessions_status
  ON public.access_sessions(status);
CREATE INDEX IF NOT EXISTS idx_access_sessions_expires_at
  ON public.access_sessions(expires_at);

-- updated_at 자동 갱신 트리거
DROP TRIGGER IF EXISTS set_access_sessions_updated_at ON public.access_sessions;
CREATE TRIGGER set_access_sessions_updated_at
  BEFORE UPDATE ON public.access_sessions
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- 2. payment_orders (토스페이먼츠 테스트 보증금 주문 및 승인 스냅샷)
CREATE TABLE IF NOT EXISTS public.payment_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_session_id uuid NOT NULL REFERENCES public.access_sessions(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  order_id text NOT NULL UNIQUE,
  provider text NOT NULL DEFAULT 'toss' CHECK (provider = 'toss'),
  payment_mode text NOT NULL DEFAULT 'test' CHECK (payment_mode = 'test'),
  amount_krw integer NOT NULL CHECK (amount_krw > 0),
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'pending', 'approved', 'failed', 'canceled')),
  provider_payment_key text NULL UNIQUE,
  idempotency_key text NOT NULL UNIQUE,
  approved_at timestamptz NULL,
  failure_code text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_payment_orders_user_id_created_at
  ON public.payment_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_orders_access_session_id
  ON public.payment_orders(access_session_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_status
  ON public.payment_orders(status);

-- 핵심 불변식: 한 이용권당 성공(approved) 결제는 최대 하나만 존재 가능 (부분 UNIQUE 인덱스)
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_single_approved_per_session
  ON public.payment_orders(access_session_id)
  WHERE status = 'approved';

-- updated_at 자동 갱신 트리거
DROP TRIGGER IF EXISTS set_payment_orders_updated_at ON public.payment_orders;
CREATE TRIGGER set_payment_orders_updated_at
  BEFORE UPDATE ON public.payment_orders
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- 3. payment_refunds (1회 전액 환급 관리자 요청 및 상태)
-- receipt_submission_id FK는 TASK 26 receipt_backend 작성까지 유보 (docs/03, tasks/20 명세)
CREATE TABLE IF NOT EXISTS public.payment_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_order_id uuid NOT NULL REFERENCES public.payment_orders(id) ON DELETE RESTRICT UNIQUE,
  receipt_submission_id uuid NULL,
  amount_krw integer NOT NULL CHECK (amount_krw > 0),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'processing', 'succeeded', 'failed')),
  idempotency_key text NOT NULL UNIQUE,
  requested_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  provider_cancel_id text NULL,
  failure_reason text NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_payment_refunds_status
  ON public.payment_refunds(status);
CREATE INDEX IF NOT EXISTS idx_payment_refunds_requested_by
  ON public.payment_refunds(requested_by);

-- 4. event_logs.access_session_id FK 추가 (ON DELETE SET NULL)
-- events_backend(TASK 17)에서 생성된 컬럼에 외래키 제약조건 연결
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'event_logs'
      AND constraint_name = 'fk_event_logs_access_session_id'
  ) THEN
    ALTER TABLE public.event_logs
      ADD CONSTRAINT fk_event_logs_access_session_id
      FOREIGN KEY (access_session_id)
      REFERENCES public.access_sessions(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- ==============================================================================
-- 5. 비즈니스 불변식 및 상태 전이 트리거 함수
-- ==============================================================================

-- 5.1 access_sessions 무결성 트리거
CREATE OR REPLACE FUNCTION public.enforce_access_session_rules()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_restroom_type text;
  v_policy_restroom_id uuid;
  v_policy_mode text;
  v_policy_amount integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- 0) 신규 이용권은 항상 created 상태로 시작 (결제 확인 전 직접 authorized 생성 원천 차단)
    IF NEW.status IS DISTINCT FROM 'created' THEN
      RAISE EXCEPTION 'HM029: New access sessions must start in created status (found: %)', NEW.status
        USING ERRCODE = '22023';
    END IF;

    -- 1) 대상 화장실이 제휴(partner) 화장실인지 검증
    SELECT type INTO v_restroom_type
    FROM public.restrooms
    WHERE id = NEW.restroom_id;

    IF v_restroom_type IS NULL THEN
      RAISE EXCEPTION 'Restroom % not found', NEW.restroom_id USING ERRCODE = '23503';
    END IF;

    IF v_restroom_type IS DISTINCT FROM 'partner' THEN
      RAISE EXCEPTION 'HM021: Access sessions are only permitted for partner restrooms (found: %)', v_restroom_type
        USING ERRCODE = '22023';
    END IF;

    -- 2) 정책 버전이 동일 화장실에 속하는지 검증
    SELECT restroom_id INTO v_policy_restroom_id
    FROM public.restroom_access_policies
    WHERE id = NEW.policy_id;

    IF v_policy_restroom_id IS NULL THEN
      RAISE EXCEPTION 'Policy % not found', NEW.policy_id USING ERRCODE = '23503';
    END IF;

    IF v_policy_restroom_id IS DISTINCT FROM NEW.restroom_id THEN
      RAISE EXCEPTION 'HM020: Policy % does not belong to restroom %', NEW.policy_id, NEW.restroom_id
        USING ERRCODE = '22023';
    END IF;

    -- 3) 만료 시각 검증
    IF NEW.expires_at <= NEW.created_at THEN
      RAISE EXCEPTION 'HM028: expires_at must be strictly after created_at'
        USING ERRCODE = '22023';
    END IF;

    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    -- 1) 불변 컬럼 변조 차단 (IS DISTINCT FROM 사용)
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.restroom_id IS DISTINCT FROM OLD.restroom_id
       OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
       OR NEW.access_method_snapshot IS DISTINCT FROM OLD.access_method_snapshot
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'HM024: Access session immutable columns cannot be modified'
        USING ERRCODE = '42501';
    END IF;

    -- 2) 상태 전이 규칙 검증
    -- 종료 상태(terminal states)에서는 전이 불가
    IF OLD.status IN ('completed', 'failed', 'canceled', 'expired') AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'HM025: Terminal access session status cannot be changed (current: %, requested: %)', OLD.status, NEW.status
        USING ERRCODE = '22023';
    END IF;

    -- authorized 전이는 created 상태에서만 가능하며,
    -- test_deposit 정책인 경우 승인된(approved) 결제 주문이 반드시 존재해야 함
    IF NEW.status = 'authorized' AND OLD.status IS DISTINCT FROM 'authorized' THEN
      IF OLD.status IS DISTINCT FROM 'created' THEN
        RAISE EXCEPTION 'HM026: Invalid access session transition to authorized from %', OLD.status
          USING ERRCODE = '22023';
      END IF;

      -- 유료 보증금 정책인 경우 approved 결제 주문 존재 필수 검증
      SELECT access_mode, deposit_amount_krw INTO v_policy_mode, v_policy_amount
      FROM public.restroom_access_policies
      WHERE id = NEW.policy_id;

      IF v_policy_mode = 'test_deposit' AND v_policy_amount > 0 THEN
        IF NOT EXISTS (
          SELECT 1 FROM public.payment_orders
          WHERE access_session_id = NEW.id
            AND status = 'approved'
        ) THEN
          RAISE EXCEPTION 'HM022: Authorized access session requires an approved payment order'
            USING ERRCODE = '22023';
        END IF;
      END IF;

      IF NEW.authorized_at IS NULL THEN
        NEW.authorized_at := now();
      END IF;
    END IF;

    -- code_revealed 전이는 authorized 상태에서만 가능
    IF NEW.status = 'code_revealed' AND OLD.status IS DISTINCT FROM 'code_revealed' THEN
      IF OLD.status IS DISTINCT FROM 'authorized' THEN
        RAISE EXCEPTION 'HM027: Code revealed status is only allowed from authorized status (current: %)', OLD.status
          USING ERRCODE = '22023';
      END IF;

      IF NEW.code_revealed_at IS NULL THEN
        NEW.code_revealed_at := now();
      END IF;
    END IF;

    -- completed 전이는 authorized 또는 code_revealed 상태에서만 가능
    IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
      IF OLD.status NOT IN ('authorized', 'code_revealed') THEN
        RAISE EXCEPTION 'HM023: Completed status is only allowed from authorized or code_revealed status (current: %)', OLD.status
          USING ERRCODE = '22023';
      END IF;
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_access_session_rules ON public.access_sessions;
CREATE TRIGGER trg_enforce_access_session_rules
  BEFORE INSERT OR UPDATE ON public.access_sessions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_access_session_rules();

-- 5.2 payment_orders 무결성 트리거 (불변성 및 감사정보 강화)
CREATE OR REPLACE FUNCTION public.enforce_payment_order_rules()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session_user_id uuid;
  v_policy_id uuid;
  v_deposit_amount integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- 0) 금액 양수 검증 (체크 제약과 일관성 유지)
    IF NEW.amount_krw <= 0 THEN
      RAISE EXCEPTION 'HM037: Payment amount must be strictly positive (found: %)', NEW.amount_krw
        USING ERRCODE = '23514';
    END IF;

    -- 1) 초기 생성 상태는 created 또는 pending이어야 함 (승인은 결제 확인 시 전이로만 가능)
    IF NEW.status NOT IN ('created', 'pending') THEN
      RAISE EXCEPTION 'HM038: Payment orders must be created in created or pending status (found: %)', NEW.status
        USING ERRCODE = '22023';
    END IF;

    -- 2) 세션 존재 및 소유자 일치 검증
    SELECT user_id, policy_id INTO v_session_user_id, v_policy_id
    FROM public.access_sessions
    WHERE id = NEW.access_session_id;

    IF v_session_user_id IS NULL THEN
      RAISE EXCEPTION 'Access session % not found', NEW.access_session_id USING ERRCODE = '23503';
    END IF;

    IF NEW.user_id IS DISTINCT FROM v_session_user_id THEN
      RAISE EXCEPTION 'HM030: Payment order user % does not match access session owner %', NEW.user_id, v_session_user_id
        USING ERRCODE = '22023';
    END IF;

    -- 3) 금액 스냅샷이 이용권 정책의 보증금 금액과 일치하는지 검증
    SELECT deposit_amount_krw INTO v_deposit_amount
    FROM public.restroom_access_policies
    WHERE id = v_policy_id;

    IF v_deposit_amount IS NULL OR NEW.amount_krw IS DISTINCT FROM v_deposit_amount THEN
      RAISE EXCEPTION 'HM031: Payment amount % does not match policy deposit amount %', NEW.amount_krw, v_deposit_amount
        USING ERRCODE = '22023';
    END IF;

    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    -- 1) 불변 컬럼 변조 차단 (IS DISTINCT FROM 사용)
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.access_session_id IS DISTINCT FROM OLD.access_session_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.order_id IS DISTINCT FROM OLD.order_id
       OR NEW.provider IS DISTINCT FROM OLD.provider
       OR NEW.payment_mode IS DISTINCT FROM OLD.payment_mode
       OR NEW.amount_krw IS DISTINCT FROM OLD.amount_krw
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'HM032: Payment order immutable columns cannot be modified'
        USING ERRCODE = '42501';
    END IF;

    -- 2) 이미 approved된 결제 주문의 불변성 강화:
    --    approved 상태에서는 상태 전이 불가 (환급은 payment_refunds로 처리)
    IF OLD.status = 'approved' AND NEW.status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'HM033: Approved payment order cannot transition to another status (use payment_refunds)'
        USING ERRCODE = '22023';
    END IF;

    --    approved 상태 이후 provider_payment_key 변경 차단
    IF OLD.status = 'approved' AND NEW.provider_payment_key IS DISTINCT FROM OLD.provider_payment_key THEN
      RAISE EXCEPTION 'HM036: provider_payment_key cannot be modified on approved payment orders'
        USING ERRCODE = '42501';
    END IF;

    --    approved 상태 이후 approved_at 변경 차단
    IF OLD.status = 'approved' AND NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
      RAISE EXCEPTION 'HM039: approved_at cannot be modified on approved payment orders'
        USING ERRCODE = '42501';
    END IF;

    -- 3) 종료 상태(failed, canceled)에서는 다른 상태로 전이 불가
    IF OLD.status IN ('failed', 'canceled') AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'HM034: Terminal payment order status cannot be modified (current: %, requested: %)', OLD.status, NEW.status
        USING ERRCODE = '22023';
    END IF;

    -- 4) 승인 전이(created/pending -> approved) 시 결제키 필수 검증 및 approved_at 설정
    IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved' THEN
      IF NEW.provider_payment_key IS NULL OR trim(NEW.provider_payment_key) = '' THEN
        RAISE EXCEPTION 'HM035: Approved payment order requires provider_payment_key'
          USING ERRCODE = '22023';
      END IF;
      IF NEW.approved_at IS NULL THEN
        NEW.approved_at := now();
      END IF;
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_payment_order_rules ON public.payment_orders;
CREATE TRIGGER trg_enforce_payment_order_rules
  BEFORE INSERT OR UPDATE ON public.payment_orders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_payment_order_rules();

-- 5.3 payment_refunds 무결성 트리거 (감사정보 보호 강화)
CREATE OR REPLACE FUNCTION public.enforce_payment_refund_rules()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order_status text;
  v_order_amount integer;
  v_is_admin boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- 0) 환급 금액 양수 검증
    IF NEW.amount_krw <= 0 THEN
      RAISE EXCEPTION 'HM047: Refund amount must be strictly positive (found: %)', NEW.amount_krw
        USING ERRCODE = '23514';
    END IF;

    -- 1) 초기 생성 상태는 requested여야 함
    IF NEW.status IS DISTINCT FROM 'requested' THEN
      RAISE EXCEPTION 'HM048: Payment refunds must start in requested status (found: %)', NEW.status
        USING ERRCODE = '22023';
    END IF;

    -- 2) 원 주문 존재 및 approved 상태 검증
    SELECT status, amount_krw INTO v_order_status, v_order_amount
    FROM public.payment_orders
    WHERE id = NEW.payment_order_id;

    IF v_order_status IS NULL THEN
      RAISE EXCEPTION 'Payment order % not found', NEW.payment_order_id USING ERRCODE = '23503';
    END IF;

    IF v_order_status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'HM040: Only approved payment orders can be refunded (order status: %)', v_order_status
        USING ERRCODE = '22023';
    END IF;

    -- 3) 원 결제 승인 금액과 100% 일치 강제 (MVP 1회 전액환급 정책)
    IF NEW.amount_krw IS DISTINCT FROM v_order_amount THEN
      RAISE EXCEPTION 'HM041: Refund amount % must equal original approved order amount %', NEW.amount_krw, v_order_amount
        USING ERRCODE = '22023';
    END IF;

    -- 4) 환급 요청자는 관리자(admin) 권한 필수
    SELECT public.is_admin(NEW.requested_by) INTO v_is_admin;
    IF v_is_admin IS NOT TRUE THEN
      RAISE EXCEPTION 'HM042: Only administrators can request a payment refund'
        USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    -- 1) 불변 컬럼 변조 차단 (IS DISTINCT FROM 사용)
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.payment_order_id IS DISTINCT FROM OLD.payment_order_id
       OR NEW.amount_krw IS DISTINCT FROM OLD.amount_krw
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
       OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
      RAISE EXCEPTION 'HM043: Payment refund immutable columns cannot be modified'
        USING ERRCODE = '42501';
    END IF;

    -- 2) receipt_submission_id 불변성: 한번 할당된 영수증 제출 ID는 사후 변조 불가
    IF OLD.receipt_submission_id IS NOT NULL
       AND NEW.receipt_submission_id IS DISTINCT FROM OLD.receipt_submission_id THEN
      RAISE EXCEPTION 'HM049: receipt_submission_id cannot be changed once assigned'
        USING ERRCODE = '42501';
    END IF;

    -- 3) succeeded 완료 상태의 감사정보 보호:
    --    succeeded 상태에서는 다른 상태로 전이 불가
    IF OLD.status = 'succeeded' AND NEW.status IS DISTINCT FROM 'succeeded' THEN
      RAISE EXCEPTION 'HM044: Succeeded refund cannot be transitioned to another status'
        USING ERRCODE = '22023';
    END IF;

    --    succeeded 상태 이후 provider_cancel_id 변경 차단
    IF OLD.status = 'succeeded' AND NEW.provider_cancel_id IS DISTINCT FROM OLD.provider_cancel_id THEN
      RAISE EXCEPTION 'HM046: provider_cancel_id cannot be modified on completed refunds'
        USING ERRCODE = '42501';
    END IF;

    --    succeeded 상태 이후 completed_at 변경 차단
    IF OLD.status = 'succeeded' AND NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
      RAISE EXCEPTION 'HM050: completed_at cannot be modified on completed refunds'
        USING ERRCODE = '42501';
    END IF;

    -- 4) succeeded 전이 시 처리: provider_cancel_id 필수 검증 (HM051) 및 completed_at 설정
    IF NEW.status = 'succeeded' AND OLD.status IS DISTINCT FROM 'succeeded' THEN
      IF NEW.provider_cancel_id IS NULL OR trim(NEW.provider_cancel_id) = '' THEN
        RAISE EXCEPTION 'HM051: Succeeded refund requires valid provider_cancel_id'
          USING ERRCODE = '22023';
      END IF;

      IF NEW.completed_at IS NULL THEN
        NEW.completed_at := now();
      END IF;
    END IF;

    -- 5) failed 전이 시 처리: failure_reason 필수
    IF NEW.status = 'failed' AND (NEW.failure_reason IS NULL OR trim(NEW.failure_reason) = '') THEN
      RAISE EXCEPTION 'HM045: Failed refund requires failure_reason'
        USING ERRCODE = '22023';
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_payment_refund_rules ON public.payment_refunds;
CREATE TRIGGER trg_enforce_payment_refund_rules
  BEFORE INSERT OR UPDATE ON public.payment_refunds
  FOR EACH ROW EXECUTE FUNCTION public.enforce_payment_refund_rules();

-- 5.4 금융/이용권 감사 레코드 물리 삭제 차단 트리거
CREATE OR REPLACE FUNCTION public.prevent_payment_audit_deletion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'Financial and access audit records cannot be deleted from table %', TG_TABLE_NAME
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_access_sessions_delete ON public.access_sessions;
CREATE TRIGGER trg_prevent_access_sessions_delete
  BEFORE DELETE ON public.access_sessions
  FOR EACH ROW EXECUTE FUNCTION public.prevent_payment_audit_deletion();

DROP TRIGGER IF EXISTS trg_prevent_payment_orders_delete ON public.payment_orders;
CREATE TRIGGER trg_prevent_payment_orders_delete
  BEFORE DELETE ON public.payment_orders
  FOR EACH ROW EXECUTE FUNCTION public.prevent_payment_audit_deletion();

DROP TRIGGER IF EXISTS trg_prevent_payment_refunds_delete ON public.payment_refunds;
CREATE TRIGGER trg_prevent_payment_refunds_delete
  BEFORE DELETE ON public.payment_refunds
  FOR EACH ROW EXECUTE FUNCTION public.prevent_payment_audit_deletion();

-- ==============================================================================
-- 6. RLS 및 컬럼 단위 권한 통제 (민감 컬럼 직접 SELECT 차단)
-- ==============================================================================

ALTER TABLE public.access_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_refunds ENABLE ROW LEVEL SECURITY;

-- 6.1 기본 권한 완전 회수 (default deny)
REVOKE ALL ON public.access_sessions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.payment_orders FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.payment_refunds FROM PUBLIC, anon, authenticated;

-- 6.2 authenticated 역할에 안전한 컬럼만 명시적으로 SELECT 부여
-- provider_payment_key, provider_cancel_id, 내부 idempotency_key 등 민감 컬럼은 배제

-- 1) access_sessions: idempotency_key 제외 안전 컬럼만 부여
GRANT SELECT (
  id,
  user_id,
  restroom_id,
  policy_id,
  status,
  access_method_snapshot,
  authorized_at,
  code_revealed_at,
  expires_at,
  created_at,
  updated_at
) ON public.access_sessions TO authenticated;

-- 2) payment_orders: provider_payment_key 및 idempotency_key 제외 안전 컬럼만 부여
GRANT SELECT (
  id,
  access_session_id,
  user_id,
  order_id,
  provider,
  payment_mode,
  amount_krw,
  status,
  approved_at,
  failure_code,
  created_at,
  updated_at
) ON public.payment_orders TO authenticated;

-- 3) payment_refunds: provider_cancel_id, idempotency_key, requested_by 제외 안전 컬럼만 부여
GRANT SELECT (
  id,
  payment_order_id,
  receipt_submission_id,
  amount_krw,
  status,
  failure_reason,
  requested_at,
  completed_at
) ON public.payment_refunds TO authenticated;

-- 6.3 service_role(서버 프로세스)에만 전체 테이블 ALL 권한 부여
GRANT ALL ON public.access_sessions TO service_role;
GRANT ALL ON public.payment_orders TO service_role;
GRANT ALL ON public.payment_refunds TO service_role;

-- 트리거 함수 실행 권한
REVOKE ALL ON FUNCTION public.enforce_access_session_rules() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enforce_access_session_rules() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.enforce_payment_order_rules() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enforce_payment_order_rules() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.enforce_payment_refund_rules() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enforce_payment_refund_rules() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.prevent_payment_audit_deletion() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prevent_payment_audit_deletion() TO authenticated, service_role;

-- 6.4 RLS SELECT 정책: 고객 본인 레코드 및 관리자 전체 조회만 허용 (타인 격리 차단)
DROP POLICY IF EXISTS access_sessions_select_own_or_admin ON public.access_sessions;
CREATE POLICY access_sessions_select_own_or_admin
  ON public.access_sessions
  FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_admin(auth.uid())
  );

DROP POLICY IF EXISTS payment_orders_select_own_or_admin ON public.payment_orders;
CREATE POLICY payment_orders_select_own_or_admin
  ON public.payment_orders
  FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_admin(auth.uid())
  );

DROP POLICY IF EXISTS payment_refunds_select_own_or_admin ON public.payment_refunds;
CREATE POLICY payment_refunds_select_own_or_admin
  ON public.payment_refunds
  FOR SELECT
  TO authenticated
  USING (
    public.is_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.payment_orders po
      WHERE po.id = payment_refunds.payment_order_id
        AND po.user_id = auth.uid()
    )
  );
