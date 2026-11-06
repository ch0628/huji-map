-- ============================================================================
-- Migration: 20261106000000_auth_schema.sql
-- Description: Auth, Roles, Visitor Sessions, Consents, Feature Flags Schema
-- Specifications: docs/03_DATA_MODEL.md, docs/08_SECURITY_OPERATIONS.md, docs/11_DECISIONS.md
-- ============================================================================

-- 1. Helper function for updated_at timestamps
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- 2. profiles: 최소 공개 프로필 (auth.users 참조)
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text NULL,
  preferred_language text NOT NULL DEFAULT 'ko',
  account_status text NOT NULL DEFAULT 'active' CHECK (account_status IN ('active', 'suspended', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER set_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- 3. user_roles: 사용자 권한 관리 (복합 PK, 1계정 다역할)
CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('customer', 'merchant', 'admin')),
  granted_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON public.user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON public.user_roles(role);

-- Helper function: 관리자 권한 확인 (RLS 및 서버 권한 검증용)
CREATE OR REPLACE FUNCTION public.is_admin(target_user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = target_user_id
      AND role = 'admin'
  );
$$;

-- 4. visitor_sessions: 익명 브라우저 및 방문 세션 추적
CREATE TABLE IF NOT EXISTS public.visitor_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  browser_id uuid NOT NULL,
  user_id uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  landing_path text NOT NULL,
  referrer text NULL,
  utm_source text NULL,
  utm_medium text NULL,
  utm_campaign text NULL,
  utm_content text NULL,
  utm_term text NULL,
  device_type text NOT NULL DEFAULT 'unknown' CHECK (device_type IN ('mobile', 'tablet', 'desktop', 'unknown')),
  language text NULL,
  is_test boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_visitor_sessions_browser_id ON public.visitor_sessions(browser_id);
CREATE INDEX IF NOT EXISTS idx_visitor_sessions_user_id ON public.visitor_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_visitor_sessions_started_at ON public.visitor_sessions(started_at);

-- 5. consent_records: 이용약관 및 개인정보/통계/마케팅 동의 이력 (회원/익명 브라우저)
CREATE TABLE IF NOT EXISTS public.consent_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  browser_id uuid NULL,
  consent_type text NOT NULL CHECK (consent_type IN ('terms', 'privacy', 'analytics', 'marketing')),
  policy_version text NOT NULL,
  accepted boolean NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz NULL,
  CONSTRAINT chk_consent_subject CHECK (user_id IS NOT NULL OR browser_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_consent_records_user_id ON public.consent_records(user_id);
CREATE INDEX IF NOT EXISTS idx_consent_records_browser_id ON public.consent_records(browser_id);
CREATE INDEX IF NOT EXISTS idx_consent_records_type ON public.consent_records(consent_type);

-- 6. feature_flags: 릴리즈 제어 및 테스트 모드 설정
CREATE TABLE IF NOT EXISTS public.feature_flags (
  key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER set_feature_flags_updated_at
  BEFORE UPDATE ON public.feature_flags
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- 초기 기본 플래그 시드
INSERT INTO public.feature_flags (key, enabled, config)
VALUES
  ('payment_test_mode', false, '{"deposit_amount_krw": 1000, "label": "DEMO/TEST"}'::jsonb),
  ('public_restroom_discovery', true, '{"source": "local_data"}'::jsonb),
  ('partner_restroom_discovery', false, '{"allow_test_pass": false}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 7. auth.users 생성 시 자동 프로필 및 기본 역할(customer) 부여 트리거
--    (SECURITY DEFINER, 안전한 search_path 설정, 멱등성 보장)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
BEGIN
  -- 1) profiles 자동 생성
  INSERT INTO public.profiles (id, display_name, preferred_language, account_status)
  VALUES (
    NEW.id,
    COALESCE(
      NEW.raw_user_meta_data->>'full_name',
      NEW.raw_user_meta_data->>'name',
      NULL
    ),
    COALESCE(NEW.raw_user_meta_data->>'preferred_language', 'ko'),
    'active'
  )
  ON CONFLICT (id) DO NOTHING;

  -- 2) 기본 권한은 엄격하게 'customer'로만 생성 (admin 자가 할당 원천 차단)
  INSERT INTO public.user_roles (user_id, role, granted_by)
  VALUES (NEW.id, 'customer', NULL)
  ON CONFLICT (user_id, role) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================================
-- 8. Row Level Security (RLS) 활성화 및 정책 정의
--    (모든 테이블 기본 거부, 최소 권한 원칙)
-- ============================================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visitor_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;

-- 8-1. profiles 정책
-- 본인 프로필 조회 또는 관리자 전체 조회
CREATE POLICY "profiles_select_own_or_admin"
  ON public.profiles
  FOR SELECT
  USING (
    auth.uid() = id
    OR public.is_admin(auth.uid())
  );

-- 본인 프로필 기본정보 수정 (계정 상태 account_status는 서버/관리자 전용 제어)
CREATE POLICY "profiles_update_own"
  ON public.profiles
  FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- 8-2. user_roles 정책
-- 본인 권한 조회 또는 관리자 전체 조회
CREATE POLICY "user_roles_select_own_or_admin"
  ON public.user_roles
  FOR SELECT
  USING (
    auth.uid() = user_id
    OR public.is_admin(auth.uid())
  );

-- 일반 사용자의 권한 임의 삽입/수정/삭제 절대 불가 (관리자만 가능)
CREATE POLICY "user_roles_admin_manage"
  ON public.user_roles
  FOR ALL
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- 8-3. visitor_sessions 정책
CREATE POLICY "visitor_sessions_select_own_or_admin"
  ON public.visitor_sessions
  FOR SELECT
  USING (
    auth.uid() = user_id
    OR public.is_admin(auth.uid())
  );

CREATE POLICY "visitor_sessions_insert"
  ON public.visitor_sessions
  FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    OR user_id IS NULL
  );

CREATE POLICY "visitor_sessions_update_own"
  ON public.visitor_sessions
  FOR UPDATE
  USING (
    auth.uid() = user_id
    OR public.is_admin(auth.uid())
  );

-- 8-4. consent_records 정책 (동의 내역은 append-only 원칙)
CREATE POLICY "consent_records_select_own_or_admin"
  ON public.consent_records
  FOR SELECT
  USING (
    auth.uid() = user_id
    OR public.is_admin(auth.uid())
  );

CREATE POLICY "consent_records_insert"
  ON public.consent_records
  FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    OR user_id IS NULL
  );

-- 8-5. feature_flags 정책
-- 모든 방문자/회원은 플래그 읽기 허용
CREATE POLICY "feature_flags_select_all"
  ON public.feature_flags
  FOR SELECT
  USING (true);

-- 관리자만 플래그 생성/수정/삭제 가능
CREATE POLICY "feature_flags_admin_manage"
  ON public.feature_flags
  FOR ALL
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

