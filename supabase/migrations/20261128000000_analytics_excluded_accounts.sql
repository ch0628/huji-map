-- ==============================================================================
-- Migration: 20261128000000_analytics_excluded_accounts.sql
-- Description: 관리자 전용 테스트 계정 이용 통계 제외 설정 테이블 및 RLS/인덱스
-- Security:
--   - 관리자(admin)만 조회·등록·변경 가능 (비회원/일반회원 완전 차단)
--   - profiles / user_roles의 회원 상태·권한과 독립 동작
--   - 기본 이용 통계 조회 핫패스를 위한 부분 인덱스(user_id WHERE is_active = true)
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.analytics_excluded_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT true,
  note text NULL CHECK (note IS NULL OR char_length(note) <= 200),
  created_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.analytics_excluded_accounts IS
  'Admin-managed user accounts excluded from basic usage counts and detailed service analytics.';

-- 기본 이용 통계 핫패스(단건 user_id 활성 여부 조회) 전용 부분 인덱스
CREATE INDEX IF NOT EXISTS idx_analytics_excluded_accounts_active_user
  ON public.analytics_excluded_accounts(user_id)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_analytics_excluded_accounts_updated_at
  ON public.analytics_excluded_accounts(updated_at DESC);

DROP TRIGGER IF EXISTS set_analytics_excluded_accounts_updated_at ON public.analytics_excluded_accounts;
CREATE TRIGGER set_analytics_excluded_accounts_updated_at
  BEFORE UPDATE ON public.analytics_excluded_accounts
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- RLS 활성화 및 최소 권한 설정 (기본 거부, 관리자만 허용)
ALTER TABLE public.analytics_excluded_accounts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.analytics_excluded_accounts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.analytics_excluded_accounts TO authenticated;
GRANT ALL ON TABLE public.analytics_excluded_accounts TO service_role;

DROP POLICY IF EXISTS "analytics_excluded_accounts_admin_select" ON public.analytics_excluded_accounts;
CREATE POLICY "analytics_excluded_accounts_admin_select"
  ON public.analytics_excluded_accounts
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "analytics_excluded_accounts_admin_insert" ON public.analytics_excluded_accounts;
CREATE POLICY "analytics_excluded_accounts_admin_insert"
  ON public.analytics_excluded_accounts
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "analytics_excluded_accounts_admin_update" ON public.analytics_excluded_accounts;
CREATE POLICY "analytics_excluded_accounts_admin_update"
  ON public.analytics_excluded_accounts
  FOR UPDATE
  TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));
