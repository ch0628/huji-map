-- ==============================================================================
-- Migration: 20261127000000_anonymous_daily_usage_counts.sql
-- Description: 비식별 일별·기능별 기본 이용 횟수 집계 (동의 불필요, 개인정보·식별자 미저장)
-- Security:
--   - 사용자 ID, 브라우저 ID, 세션 ID, IP, 좌표, 검색어 원문, 화장실 ID, 개별 시각 일체 미저장
--   - 개별 이벤트를 쌓지 않고 서버 전용 RPC가 날짜별·기능별 총횟수만 원자적으로 +1 증가
--   - anon / authenticated 직접 쓰기·RPC 호출 차단 (service_role 전용)
--   - 조회(SELECT)는 관리자(admin)만 가능
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.daily_usage_counts (
  stat_date date NOT NULL,
  feature_key text NOT NULL CHECK (
    feature_key IN (
      'map_opened',
      'restroom_marker_clicked',
      'restroom_detail_opened',
      'search_executed',
      'directions_clicked',
      'payment_button_clicked'
    )
  ),
  is_test boolean NOT NULL DEFAULT false,
  total_count bigint NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stat_date, feature_key, is_test)
);

COMMENT ON TABLE public.daily_usage_counts IS
  'Non-identifying daily feature execution counts (KST date + feature_key + is_test only). Stores no user_id, browser_id, session_id, IP, coordinates, search query, restroom_id, or per-action timestamp.';

CREATE INDEX IF NOT EXISTS idx_daily_usage_counts_stat_date
  ON public.daily_usage_counts(stat_date DESC);

-- RLS 활성화 및 최소 권한 설정 (기본 거부, 관리자만 SELECT 허용)
ALTER TABLE public.daily_usage_counts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.daily_usage_counts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.daily_usage_counts TO authenticated, service_role;

DROP POLICY IF EXISTS "daily_usage_counts_admin_select" ON public.daily_usage_counts;
CREATE POLICY "daily_usage_counts_admin_select"
  ON public.daily_usage_counts
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

-- 원자적 일별·기능별 카운터 증가 RPC (Next.js 서버 service_role 전용)
CREATE OR REPLACE FUNCTION public.increment_daily_usage_count(
  p_feature_key text,
  p_is_test boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_allowed text[] := ARRAY[
    'map_opened',
    'restroom_marker_clicked',
    'restroom_detail_opened',
    'search_executed',
    'directions_clicked',
    'payment_button_clicked'
  ];
  v_date date := (now() AT TIME ZONE 'Asia/Seoul')::date;
  v_is_test boolean := coalesce(p_is_test, false);
  v_total bigint;
BEGIN
  IF coalesce(auth.role(), '') IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'Direct client execution of usage counter RPC is prohibited. Use Next.js API endpoints.'
      USING ERRCODE = '42501';
  END IF;

  IF p_feature_key IS NULL OR NOT (p_feature_key = ANY(v_allowed)) THEN
    RAISE EXCEPTION 'Invalid or disallowed feature_key "%"', coalesce(p_feature_key, '')
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.daily_usage_counts (stat_date, feature_key, is_test, total_count, updated_at)
  VALUES (v_date, p_feature_key, v_is_test, 1, now())
  ON CONFLICT (stat_date, feature_key, is_test)
  DO UPDATE SET
    total_count = public.daily_usage_counts.total_count + 1,
    updated_at = now()
  RETURNING total_count INTO v_total;

  RETURN jsonb_build_object(
    'stat_date', v_date,
    'feature_key', p_feature_key,
    'is_test', v_is_test,
    'total_count', v_total
  );
END;
$$;

REVOKE ALL ON FUNCTION public.increment_daily_usage_count(text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_daily_usage_count(text, boolean) TO service_role;
