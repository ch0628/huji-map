-- ==============================================================================
-- Migration: 20261113000000_events_backend.sql
-- Description: 사용자 행동 관찰(event_logs), PMF 실험(experiments), 세션 여행 응답(traveling_now)
-- Security: Server-only RPC execution, session ownership verification, recursive PII check,
--           event property allowlists, append-only trigger with cascade anonymization support.
-- Spec: docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/06_EVENTS_AND_PMF.md, tasks/17_events_backend.md
-- ==============================================================================

-- 1. experiments: PMF 판정 버전 및 관찰 기간
CREATE TABLE IF NOT EXISTS public.experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_key text NOT NULL,
  name text NOT NULL,
  rules_version text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'closed')),
  notes text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_experiments_key UNIQUE (experiment_key)
);

CREATE INDEX IF NOT EXISTS idx_experiments_key_status ON public.experiments(experiment_key, status);

-- 2. visitor_sessions: 여행 중 여부(traveling_now) 및 익명 소유 증명(session_token_hash) 추가
ALTER TABLE public.visitor_sessions
  ADD COLUMN IF NOT EXISTS traveling_now boolean NULL,
  ADD COLUMN IF NOT EXISTS session_token_hash text NULL;

-- 3. 금지 키(PII/보안값/정밀 GPS) 재귀 검사 헬퍼 함수 (배열 속 배열 포함 다차원 재귀 검사)
CREATE OR REPLACE FUNCTION public.has_forbidden_keys(p_json jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key text;
  v_val jsonb;
  v_elem jsonb;
  v_forbidden text[] := ARRAY[
    'pin', 'password', 'secret', 'secret_key', 'token',
    'card', 'card_number', 'cvv', 'payment_key', 'provider_payment_key',
    'receipt_image', 'receipt_data', 'email', 'phone', 'phone_number',
    'lat', 'lng', 'latitude', 'longitude', 'coords', 'gps_trail'
  ];
BEGIN
  IF p_json IS NULL THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(p_json) = 'object' THEN
    FOR v_key, v_val IN SELECT * FROM jsonb_each(p_json) LOOP
      IF lower(v_key) = ANY(v_forbidden) THEN
        RETURN true;
      END IF;
      IF jsonb_typeof(v_val) IN ('object', 'array') THEN
        IF public.has_forbidden_keys(v_val) THEN
          RETURN true;
        END IF;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(p_json) = 'array' THEN
    FOR v_elem IN SELECT * FROM jsonb_array_elements(p_json) LOOP
      IF jsonb_typeof(v_elem) IN ('object', 'array') THEN
        IF public.has_forbidden_keys(v_elem) THEN
          RETURN true;
        END IF;
      END IF;
    END LOOP;
  END IF;

  RETURN false;
END;
$$;

-- 4. 이벤트 타입별 허용 속성 검사 함수
CREATE OR REPLACE FUNCTION public.validate_event_properties(p_event_name text, p_properties jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key text;
  v_allowed text[];
BEGIN
  IF p_properties IS NULL OR p_properties = '{}'::jsonb THEN
    RETURN true;
  END IF;

  CASE p_event_name
    WHEN 'landing_view' THEN
      v_allowed := ARRAY['landing_path', 'referrer', 'device_type', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
    WHEN 'map_loaded' THEN
      v_allowed := ARRAY['zoom', 'restroom_count', 'filter', 'center_region'];
    WHEN 'restroom_marker_clicked' THEN
      v_allowed := ARRAY['restroom_id', 'type', 'marker_index', 'access_method'];
    WHEN 'restroom_card_viewed' THEN
      v_allowed := ARRAY['card_type', 'visibility_rule_version', 'restroom_id', 'source'];
    WHEN 'restroom_detail_opened' THEN
      v_allowed := ARRAY['restroom_id', 'type', 'source_component'];
    WHEN 'directions_clicked' THEN
      v_allowed := ARRAY['service', 'restroom_id', 'type', 'has_origin'];
    WHEN 'payment_button_clicked' THEN
      v_allowed := ARRAY['restroom_id', 'policy_id', 'deposit_amount_krw'];
    WHEN 'payment_unavailable_shown' THEN
      v_allowed := ARRAY['restroom_id', 'reason'];
    WHEN 'checkout_opened' THEN
      v_allowed := ARRAY['restroom_id', 'policy_id', 'deposit_amount_krw'];
    WHEN 'receipt_upload_clicked' THEN
      v_allowed := ARRAY['restroom_id', 'access_session_id'];
    WHEN 'business_registration_submitted' THEN
      v_allowed := ARRAY['business_id'];
    WHEN 'travel_answer_submitted' THEN
      v_allowed := ARRAY['traveling_now', 'server_verified'];
    ELSE
      -- 서버 전용 권위적 이벤트는 시스템 전달 속성 허용
      RETURN true;
  END CASE;

  FOR v_key IN SELECT jsonb_object_keys(p_properties) LOOP
    IF NOT (v_key = ANY(v_allowed)) THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN true;
END;
$$;

-- 5. event_logs: 사용자 행동 관찰 로그 (append-only)
CREATE TABLE IF NOT EXISTS public.event_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_event_id uuid NOT NULL,
  event_name text NOT NULL,
  event_version integer NOT NULL DEFAULT 1 CHECK (event_version >= 1),
  browser_id uuid NULL,
  session_id uuid NULL REFERENCES public.visitor_sessions(id) ON DELETE SET NULL,
  user_id uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  business_id uuid NULL REFERENCES public.businesses(id) ON DELETE SET NULL,
  restroom_id uuid NULL REFERENCES public.restrooms(id) ON DELETE SET NULL,
  access_session_id uuid NULL, -- payment_schema 이전이므로 FK 없이 선언
  experiment_key text NULL,
  page_path text NULL,
  component_id text NULL,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'client' CHECK (source IN ('client', 'server')),
  is_test boolean NOT NULL DEFAULT false,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_event_logs_client_event_id UNIQUE (client_event_id),
  CONSTRAINT chk_event_logs_properties_object CHECK (jsonb_typeof(properties) = 'object'),
  CONSTRAINT chk_event_logs_properties_size CHECK (octet_length(properties::text) <= 4096),
  CONSTRAINT chk_event_logs_event_name_length CHECK (char_length(trim(event_name)) > 0),
  CONSTRAINT chk_event_logs_page_path_length CHECK (page_path IS NULL OR char_length(page_path) <= 500)
);

-- 인덱스 구성
CREATE INDEX IF NOT EXISTS idx_event_logs_analysis
  ON public.event_logs(experiment_key, received_at, event_name, browser_id);
CREATE INDEX IF NOT EXISTS idx_event_logs_browser_id
  ON public.event_logs(browser_id);
CREATE INDEX IF NOT EXISTS idx_event_logs_session_id
  ON public.event_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_event_logs_user_id
  ON public.event_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_event_logs_restroom_id
  ON public.event_logs(restroom_id);
CREATE INDEX IF NOT EXISTS idx_event_logs_business_id
  ON public.event_logs(business_id);
CREATE INDEX IF NOT EXISTS idx_event_logs_access_session_id
  ON public.event_logs(access_session_id);
CREATE INDEX IF NOT EXISTS idx_event_logs_occurred_at
  ON public.event_logs(occurred_at);
CREATE INDEX IF NOT EXISTS idx_event_logs_received_at
  ON public.event_logs(received_at);

-- 6. 불변성 보장 및 외래키 ON DELETE SET NULL 익명화 허용 트리거
-- 누락된 일반 텔레메트리 컬럼(browser_id, experiment_key, page_path, component_id)의 변경도 완벽 차단
CREATE OR REPLACE FUNCTION public.prevent_event_logs_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'event_logs table is append-only. DELETE is prohibited.'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- 외래키 삭제 시 ON DELETE SET NULL에 의한 익명화 연쇄 동작만 예외적으로 허용
    -- 일반 텔레메트리 컬럼(id, client_event_id, event_name, event_version, browser_id, experiment_key,
    -- page_path, component_id, properties, source, is_test, occurred_at, received_at)은 일체 변조 불가.
    -- 외래키 컬럼(user_id, session_id, business_id, restroom_id, access_session_id)은
    -- 기존 값 유지 또는 기존 값이 NULL로만 전이되는 ON DELETE SET NULL 동작만 허용.
    IF NEW.id = OLD.id
       AND NEW.client_event_id = OLD.client_event_id
       AND NEW.event_name = OLD.event_name
       AND NEW.event_version = OLD.event_version
       AND (NEW.browser_id IS NOT DISTINCT FROM OLD.browser_id)
       AND (NEW.experiment_key IS NOT DISTINCT FROM OLD.experiment_key)
       AND (NEW.page_path IS NOT DISTINCT FROM OLD.page_path)
       AND (NEW.component_id IS NOT DISTINCT FROM OLD.component_id)
       AND NEW.properties = OLD.properties
       AND NEW.source = OLD.source
       AND NEW.is_test = OLD.is_test
       AND NEW.occurred_at = OLD.occurred_at
       AND NEW.received_at = OLD.received_at
       AND (NEW.user_id IS NOT DISTINCT FROM OLD.user_id OR (OLD.user_id IS NOT NULL AND NEW.user_id IS NULL))
       AND (NEW.session_id IS NOT DISTINCT FROM OLD.session_id OR (OLD.session_id IS NOT NULL AND NEW.session_id IS NULL))
       AND (NEW.business_id IS NOT DISTINCT FROM OLD.business_id OR (OLD.business_id IS NOT NULL AND NEW.business_id IS NULL))
       AND (NEW.restroom_id IS NOT DISTINCT FROM OLD.restroom_id OR (OLD.restroom_id IS NOT NULL AND NEW.restroom_id IS NULL))
       AND (NEW.access_session_id IS NOT DISTINCT FROM OLD.access_session_id OR (OLD.access_session_id IS NOT NULL AND NEW.access_session_id IS NULL)) THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'event_logs table is append-only. Modification of event telemetry is prohibited.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_event_logs_mutation ON public.event_logs;
CREATE TRIGGER trg_prevent_event_logs_mutation
  BEFORE UPDATE OR DELETE ON public.event_logs
  FOR EACH ROW EXECUTE FUNCTION public.prevent_event_logs_mutation();

-- 7. Row Level Security (RLS)
ALTER TABLE public.experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "experiments_select_all" ON public.experiments;
CREATE POLICY "experiments_select_all"
  ON public.experiments
  FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "experiments_admin_manage" ON public.experiments;
CREATE POLICY "experiments_admin_manage"
  ON public.experiments
  FOR ALL
  TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- event_logs는 직접 PostgREST 클라이언트 조회 불가, 관리자만 SELECT 가능
DROP POLICY IF EXISTS "event_logs_admin_select" ON public.event_logs;
CREATE POLICY "event_logs_admin_select"
  ON public.event_logs
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

-- 8. 초기 1차 PMF 실험 시드 데이터 등록
INSERT INTO public.experiments (experiment_key, name, rules_version, starts_at, ends_at, status, notes)
VALUES (
  'pmf_r1',
  'PMF 1차 검증 실험 (수원 권역)',
  '2026-11-04-draft',
  '2026-11-05 00:00:00+00',
  '2026-11-18 14:59:59+00',
  'running',
  '{"rulesComplete": false, "notes": "19개 세부 판정 원문 확정 전까지 잠정 집계용"}'
)
ON CONFLICT (experiment_key) DO NOTHING;

-- 9. 원자적 이벤트 기록 및 멱등 처리 RPC: log_client_event
-- 보안 강화: anon/authenticated 직접 호출 차단(service_role 전용), 권한 검사 선행, 동시성 멱등 안전성 확보
CREATE OR REPLACE FUNCTION public.log_client_event(
  p_client_event_id uuid,
  p_event_name text,
  p_event_version integer DEFAULT 1,
  p_browser_id uuid DEFAULT NULL,
  p_session_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_business_id uuid DEFAULT NULL,
  p_restroom_id uuid DEFAULT NULL,
  p_access_session_id uuid DEFAULT NULL,
  p_experiment_key text DEFAULT NULL,
  p_page_path text DEFAULT NULL,
  p_component_id text DEFAULT NULL,
  p_properties jsonb DEFAULT '{}'::jsonb,
  p_source text DEFAULT 'client',
  p_is_test boolean DEFAULT false,
  p_occurred_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_existing record;
  v_received_at timestamptz := now();
  v_is_test boolean := coalesce(p_is_test, false);
  v_source text := coalesce(nullif(trim(p_source), ''), 'client');
  v_session record;
  v_allowed_client_events text[] := ARRAY[
    'landing_view',
    'map_loaded',
    'restroom_marker_clicked',
    'restroom_card_viewed',
    'restroom_detail_opened',
    'directions_clicked',
    'payment_button_clicked',
    'payment_unavailable_shown',
    'checkout_opened',
    'receipt_upload_clicked',
    'business_registration_submitted'
  ];
  v_server_events text[] := ARRAY[
    'travel_answer_submitted',
    'business_registration_approved',
    'payment_order_created',
    'payment_confirmed',
    'payment_failed',
    'access_authorized',
    'pin_reveal_requested',
    'pin_reveal_succeeded',
    'pin_reveal_denied',
    'receipt_submitted',
    'receipt_review_approved',
    'receipt_review_rejected',
    'receipt_resubmission_requested',
    'refund_requested',
    'refund_succeeded',
    'refund_failed',
    'visit_confirmation_recorded'
  ];
BEGIN
  -- 1. [보안] 직접 클라이언트(anon/authenticated) 실행 차단. 오직 Next.js 서버(service_role)만 호출 가능
  IF coalesce(auth.role(), '') IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'Direct client execution of event RPCs is prohibited. Use Next.js API endpoints.'
      USING ERRCODE = '42501';
  END IF;

  -- 2. 필수 인자 유효성 검증
  IF p_client_event_id IS NULL THEN
    RAISE EXCEPTION 'client_event_id is required' USING ERRCODE = '22023';
  END IF;

  IF p_event_name IS NULL OR trim(p_event_name) = '' THEN
    RAISE EXCEPTION 'event_name is required' USING ERRCODE = '22023';
  END IF;

  -- 3. page_path 길이 및 민감정보 유출 검증
  IF p_page_path IS NOT NULL THEN
    IF char_length(p_page_path) > 500 THEN
      RAISE EXCEPTION 'page_path exceeds 500 characters' USING ERRCODE = '22023';
    END IF;
    IF lower(p_page_path) ~ '(pin=|password=|token=|secret=)' THEN
      RAISE EXCEPTION 'page_path contains sensitive query parameters' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- 4. properties 4KB 제한 및 금지 키(PII/보안값/실시간 정밀 좌표) 재귀 검사
  IF p_properties IS NOT NULL THEN
    IF octet_length(p_properties::text) > 4096 THEN
      RAISE EXCEPTION 'properties exceeds 4096 bytes limit' USING ERRCODE = '22023';
    END IF;
    IF public.has_forbidden_keys(p_properties) THEN
      RAISE EXCEPTION 'Properties contain forbidden PII or secret key' USING ERRCODE = '22023';
    END IF;
    IF NOT public.validate_event_properties(p_event_name, p_properties) THEN
      RAISE EXCEPTION 'Properties contain unapproved keys for event "%"', p_event_name USING ERRCODE = '22023';
    END IF;
  END IF;

  -- 5. [권한/소유권 선행 검증]
  -- A. 이벤트 소스 및 허용 목록 검증 (서버 전용 이벤트 위조 차단 및 미등록 서버 이벤트 차단)
  IF v_source = 'client' THEN
    IF p_event_name = ANY(v_server_events) THEN
      RAISE EXCEPTION 'Client cannot emit server-only event "%"', p_event_name USING ERRCODE = '42501';
    END IF;
    IF NOT (p_event_name = ANY(v_allowed_client_events)) THEN
      RAISE EXCEPTION 'Unknown or disallowed client event "%"', p_event_name USING ERRCODE = '22023';
    END IF;
  ELSIF v_source = 'server' THEN
    IF NOT (p_event_name = ANY(v_server_events)) THEN
      RAISE EXCEPTION 'Unknown or disallowed server event "%"', p_event_name USING ERRCODE = '22023';
    END IF;
  ELSE
    RAISE EXCEPTION 'Invalid event source "%"', v_source USING ERRCODE = '22023';
  END IF;

  -- B. H2 권위적 이벤트(travel_answer_submitted) 생성 경로 무결성 검증
  IF p_event_name = 'travel_answer_submitted' THEN
    IF v_source <> 'server' THEN
      RAISE EXCEPTION 'Client cannot emit server-only event "%"', p_event_name USING ERRCODE = '42501';
    END IF;
    IF p_properties IS NULL OR p_properties->>'server_verified' IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'H2 authoritative event "%" must be server-verified', p_event_name USING ERRCODE = '42501';
    END IF;
    IF p_session_id IS NULL THEN
      RAISE EXCEPTION 'H2 authoritative event "%" requires a valid session_id', p_event_name USING ERRCODE = '22023';
    END IF;
  END IF;

  -- C. 세션-사용자-브라우저 일치 정합성 검증
  IF p_session_id IS NOT NULL THEN
    SELECT id, browser_id, user_id, traveling_now, is_test
    INTO v_session
    FROM public.visitor_sessions
    WHERE id = p_session_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Referenced visitor_session not found' USING ERRCODE = '22023';
    END IF;

    -- 회원 세션에 타인 user_id 연결 차단
    IF v_session.user_id IS NOT NULL AND p_user_id IS NOT NULL AND v_session.user_id <> p_user_id THEN
      RAISE EXCEPTION 'Session belongs to a different authenticated user' USING ERRCODE = '42501';
    END IF;

    -- 회원 세션에 비회원(익명) 이벤트 위장 차단
    IF v_session.user_id IS NOT NULL AND p_user_id IS NULL THEN
      RAISE EXCEPTION 'Cannot record anonymous event on authenticated user session' USING ERRCODE = '42501';
    END IF;

    -- 브라우저 불일치 차단
    IF v_session.browser_id IS NOT NULL AND p_browser_id IS NOT NULL AND v_session.browser_id <> p_browser_id THEN
      RAISE EXCEPTION 'Session belongs to a different browser_id' USING ERRCODE = '42501';
    END IF;

    -- H2 권위적 이벤트: 세션에 이미 저장된 traveling_now 상태와 일치하는지 검증
    IF p_event_name = 'travel_answer_submitted' THEN
      IF v_session.traveling_now IS NULL OR (p_properties->>'traveling_now')::boolean IS DISTINCT FROM v_session.traveling_now THEN
        RAISE EXCEPTION 'H2 authoritative event does not match session traveling_now state' USING ERRCODE = '42501';
      END IF;
    END IF;

    -- is_test는 세션의 권위적 상태 계승 (클라이언트 임의 조작 방지)
    IF v_session.is_test IS TRUE THEN
      v_is_test := true;
    ELSIF v_session.is_test IS FALSE THEN
      v_is_test := false;
    END IF;
  END IF;

  -- 6. [멱등성 및 동시성 안전 처리: 전 컬럼 비교]
  -- 사전 조회: 동일 ID 확인
  SELECT
    event_name,
    event_version,
    browser_id,
    session_id,
    user_id,
    business_id,
    restroom_id,
    access_session_id,
    experiment_key,
    page_path,
    component_id,
    properties,
    source,
    is_test,
    received_at
  INTO v_existing
  FROM public.event_logs
  WHERE client_event_id = p_client_event_id;

  IF FOUND THEN
    IF v_existing.event_name = p_event_name
       AND v_existing.event_version = coalesce(p_event_version, 1)
       AND (v_existing.session_id IS NOT DISTINCT FROM p_session_id)
       AND (v_existing.user_id IS NOT DISTINCT FROM p_user_id)
       AND (v_existing.browser_id IS NOT DISTINCT FROM p_browser_id)
       AND (v_existing.business_id IS NOT DISTINCT FROM p_business_id)
       AND (v_existing.restroom_id IS NOT DISTINCT FROM p_restroom_id)
       AND (v_existing.access_session_id IS NOT DISTINCT FROM p_access_session_id)
       AND (v_existing.experiment_key IS NOT DISTINCT FROM p_experiment_key)
       AND (v_existing.page_path IS NOT DISTINCT FROM p_page_path)
       AND (v_existing.component_id IS NOT DISTINCT FROM p_component_id)
       AND (v_existing.properties = coalesce(p_properties, '{}'::jsonb))
       AND (v_existing.source = v_source)
       AND (v_existing.is_test = v_is_test) THEN
      RETURN jsonb_build_object(
        'client_event_id', p_client_event_id,
        'event_name', p_event_name,
        'received_at', v_existing.received_at,
        'deduplicated', true
      );
    ELSE
      RAISE EXCEPTION 'client_event_id collision with differing event data' USING ERRCODE = '23505';
    END IF;
  END IF;

  -- 7. event_logs 저장 (동시성 경합 시 unique_violation 안전 처리)
  BEGIN
    INSERT INTO public.event_logs (
      client_event_id,
      event_name,
      event_version,
      browser_id,
      session_id,
      user_id,
      business_id,
      restroom_id,
      access_session_id,
      experiment_key,
      page_path,
      component_id,
      properties,
      source,
      is_test,
      occurred_at,
      received_at
    ) VALUES (
      p_client_event_id,
      p_event_name,
      coalesce(p_event_version, 1),
      p_browser_id,
      p_session_id,
      p_user_id,
      p_business_id,
      p_restroom_id,
      p_access_session_id,
      p_experiment_key,
      p_page_path,
      p_component_id,
      coalesce(p_properties, '{}'::jsonb),
      v_source,
      v_is_test,
      coalesce(p_occurred_at, now()),
      v_received_at
    )
    RETURNING id INTO v_id;

    RETURN jsonb_build_object(
      'id', v_id,
      'client_event_id', p_client_event_id,
      'event_name', p_event_name,
      'received_at', v_received_at,
      'deduplicated', false
    );
  EXCEPTION
    WHEN unique_violation THEN
      SELECT
        event_name,
        event_version,
        browser_id,
        session_id,
        user_id,
        business_id,
        restroom_id,
        access_session_id,
        experiment_key,
        page_path,
        component_id,
        properties,
        source,
        is_test,
        received_at
      INTO v_existing
      FROM public.event_logs
      WHERE client_event_id = p_client_event_id;

      IF v_existing.event_name = p_event_name
         AND v_existing.event_version = coalesce(p_event_version, 1)
         AND (v_existing.session_id IS NOT DISTINCT FROM p_session_id)
         AND (v_existing.user_id IS NOT DISTINCT FROM p_user_id)
         AND (v_existing.browser_id IS NOT DISTINCT FROM p_browser_id)
         AND (v_existing.business_id IS NOT DISTINCT FROM p_business_id)
         AND (v_existing.restroom_id IS NOT DISTINCT FROM p_restroom_id)
         AND (v_existing.access_session_id IS NOT DISTINCT FROM p_access_session_id)
         AND (v_existing.experiment_key IS NOT DISTINCT FROM p_experiment_key)
         AND (v_existing.page_path IS NOT DISTINCT FROM p_page_path)
         AND (v_existing.component_id IS NOT DISTINCT FROM p_component_id)
         AND (v_existing.properties = coalesce(p_properties, '{}'::jsonb))
         AND (v_existing.source = v_source)
         AND (v_existing.is_test = v_is_test) THEN
        RETURN jsonb_build_object(
          'client_event_id', p_client_event_id,
          'event_name', p_event_name,
          'received_at', v_existing.received_at,
          'deduplicated', true
        );
      ELSE
        RAISE EXCEPTION 'client_event_id collision with differing event data' USING ERRCODE = '23505';
      END IF;
  END;
END;
$$;

-- 10. 여행 중 응답 및 서버 생성 이벤트 원자적 기록 RPC: record_travel_answer
-- 보안 강화: 세션 조회 시 FOR UPDATE 잠금, 익명 세션의 토큰 및 browser_id 필수화, 토큰 없는 레거시 세션 안전 거부
CREATE OR REPLACE FUNCTION public.record_travel_answer(
  p_session_id uuid,
  p_traveling_now boolean,
  p_browser_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_session_token_hash text DEFAULT NULL,
  p_client_event_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session record;
  v_event_id uuid := coalesce(p_client_event_id, gen_random_uuid());
  v_now timestamptz := now();
  v_event_res jsonb;
BEGIN
  -- 1. [보안] 직접 클라이언트 실행 차단
  IF coalesce(auth.role(), '') IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'Direct client execution of event RPCs is prohibited. Use Next.js API endpoints.'
      USING ERRCODE = '42501';
  END IF;

  IF p_session_id IS NULL THEN
    RAISE EXCEPTION 'session_id is required' USING ERRCODE = '22023';
  END IF;

  IF p_traveling_now IS NULL THEN
    RAISE EXCEPTION 'traveling_now is required' USING ERRCODE = '22023';
  END IF;

  -- 2. 방문 세션 확인 (FOR UPDATE 잠금으로 동시성 레이스 및 중복 기록 방지)
  SELECT id, browser_id, user_id, session_token_hash, traveling_now, is_test
  INTO v_session
  FROM public.visitor_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'visitor_session not found' USING ERRCODE = 'P0002';
  END IF;

  -- 3. [보안] 세션 소유권 검증
  -- 회원 세션: 실제 인증 회원 ID 일치 강제
  IF v_session.user_id IS NOT NULL THEN
    IF p_user_id IS NULL OR v_session.user_id <> p_user_id THEN
      RAISE EXCEPTION 'Session belongs to a different authenticated user' USING ERRCODE = '42501';
    END IF;
  ELSE
    -- 익명 세션: browser_id 누락 및 불일치 차단
    IF p_browser_id IS NULL OR v_session.browser_id IS DISTINCT FROM p_browser_id THEN
      RAISE EXCEPTION 'Session belongs to a different browser_id or browser_id is missing' USING ERRCODE = '42501';
    END IF;
    -- 토큰 없는 기존 익명 세션의 여행 응답 수정 차단 (안전한 거부)
    IF v_session.session_token_hash IS NULL THEN
      RAISE EXCEPTION 'Legacy session without token cannot be modified. Session re-issue required.' USING ERRCODE = '42501';
    END IF;
    -- 세션 토큰 해시 일치 검증
    IF p_session_token_hash IS NULL OR v_session.session_token_hash <> p_session_token_hash THEN
      RAISE EXCEPTION 'Invalid session token for anonymous session' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 4. 멱등 처리: 이미 동일한 traveling_now 응답이 기록된 경우
  IF v_session.traveling_now IS NOT NULL AND v_session.traveling_now = p_traveling_now THEN
    RETURN jsonb_build_object(
      'session_id', v_session.id,
      'browser_id', v_session.browser_id,
      'traveling_now', p_traveling_now,
      'deduplicated', true,
      'updated_at', v_now
    );
  END IF;

  -- 5. visitor_sessions 여행 응답 업데이트
  UPDATE public.visitor_sessions
  SET traveling_now = p_traveling_now,
      last_seen_at = v_now
  WHERE id = p_session_id;

  -- 6. travel_answer_submitted 권위적 서버 이벤트 기록 (source = 'server')
  v_event_res := public.log_client_event(
    p_client_event_id := v_event_id,
    p_event_name := 'travel_answer_submitted',
    p_event_version := 1,
    p_browser_id := v_session.browser_id,
    p_session_id := v_session.id,
    p_user_id := v_session.user_id,
    p_properties := jsonb_build_object(
      'traveling_now', p_traveling_now,
      'server_verified', true
    ),
    p_source := 'server',
    p_is_test := v_session.is_test,
    p_occurred_at := v_now
  );

  RETURN jsonb_build_object(
    'session_id', v_session.id,
    'browser_id', v_session.browser_id,
    'traveling_now', p_traveling_now,
    'event', v_event_res,
    'deduplicated', false,
    'updated_at', v_now
  );
END;
$$;

-- 11. 권한 통제: service_role 전용 실행 권한 부여 (anon/authenticated 직접 실행 절대 불가)
GRANT ALL ON public.experiments TO service_role;
GRANT SELECT ON public.experiments TO anon, authenticated;

GRANT ALL ON public.event_logs TO service_role;
GRANT SELECT ON public.event_logs TO authenticated;

REVOKE ALL ON FUNCTION public.has_forbidden_keys FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_forbidden_keys TO service_role;

REVOKE ALL ON FUNCTION public.validate_event_properties FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_event_properties TO service_role;

REVOKE ALL ON FUNCTION public.log_client_event FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_client_event FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_client_event TO service_role;

REVOKE ALL ON FUNCTION public.record_travel_answer FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_travel_answer FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_travel_answer TO service_role;
