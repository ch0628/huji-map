-- ==============================================================================
-- Rollback Verification SQL for: 20261127000000_anonymous_daily_usage_counts.sql
-- Verifies:
--   G01: Schema contains ONLY non-identifying columns (zero PII/identifier columns)
--   G02: RLS & Privilege isolation (anon/authenticated blocked from direct write & RPC)
--   G03: Non-admin authenticated user cannot SELECT; admin CAN SELECT
--   G04: service_role atomic counter increments & allowlist enforcement (22023)
--   G05: Forced rollback (P0099) leaves zero residual test data
-- ==============================================================================

DO $$
DECLARE
  v_admin_uid uuid := '99999999-9999-4999-8999-999999990001';
  v_customer_uid uuid := '99999999-9999-4999-8999-999999990002';
  v_col_count int;
  v_forbidden_col_count int;
  v_rpc_res jsonb;
  v_selected_count bigint;
  v_sqlstate text;
BEGIN
  -- --------------------------------------------------------------------------
  -- G01: Column allowlist & PII column absence check
  -- --------------------------------------------------------------------------
  SELECT count(*) INTO v_col_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'daily_usage_counts';

  IF v_col_count <> 5 THEN
    RAISE EXCEPTION 'G01 FAIL: Expected exactly 5 columns in daily_usage_counts, found %', v_col_count;
  END IF;

  SELECT count(*) INTO v_forbidden_col_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'daily_usage_counts'
    AND column_name IN (
      'id', 'user_id', 'browser_id', 'session_id', 'client_event_id',
      'ip', 'ip_address', 'lat', 'lng', 'latitude', 'longitude',
      'query', 'keyword', 'search_query', 'restroom_id', 'business_id',
      'occurred_at', 'sequence', 'user_agent'
    );

  IF v_forbidden_col_count <> 0 THEN
    RAISE EXCEPTION 'G01 FAIL: Forbidden identifying/detail columns found in daily_usage_counts';
  END IF;

  -- Begin subtransaction for isolated fixture + P0099 rollback
  BEGIN
    -- Create isolated admin & customer test fixtures
    INSERT INTO auth.users (id, email)
    VALUES
      (v_admin_uid, 'usage-verify-admin@test.local'),
      (v_customer_uid, 'usage-verify-customer@test.local');

    INSERT INTO public.user_roles (user_id, role)
    VALUES (v_admin_uid, 'admin')
    ON CONFLICT (user_id, role) DO NOTHING;

    -- ------------------------------------------------------------------------
    -- G02: Direct anon & authenticated RPC/table write must be denied (42501)
    -- ------------------------------------------------------------------------
    PERFORM set_config('role', 'anon', true);
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);

    BEGIN
      PERFORM public.increment_daily_usage_count('map_opened', true);
      RAISE EXCEPTION 'G02 FAIL: anon was able to execute increment_daily_usage_count';
    EXCEPTION WHEN SQLSTATE '42501' THEN
      NULL;
    END;

    BEGIN
      INSERT INTO public.daily_usage_counts (stat_date, feature_key, is_test, total_count)
      VALUES (current_date, 'map_opened', true, 999);
      RAISE EXCEPTION 'G02 FAIL: anon was able to INSERT directly into daily_usage_counts';
    EXCEPTION WHEN SQLSTATE '42501' THEN
      NULL;
    END;

    PERFORM set_config('role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', v_customer_uid::text, true);

    BEGIN
      PERFORM public.increment_daily_usage_count('search_executed', true);
      RAISE EXCEPTION 'G02 FAIL: authenticated customer was able to execute increment_daily_usage_count';
    EXCEPTION WHEN SQLSTATE '42501' THEN
      NULL;
    END;

    -- ------------------------------------------------------------------------
    -- G04: service_role atomic increment & allowlist enforcement
    -- ------------------------------------------------------------------------
    PERFORM set_config('role', 'service_role', true);
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);

    v_rpc_res := public.increment_daily_usage_count('map_opened', true);
    IF (v_rpc_res->>'total_count')::bigint <> 1 THEN
      RAISE EXCEPTION 'G04 FAIL: Expected first count 1, got %', v_rpc_res;
    END IF;

    v_rpc_res := public.increment_daily_usage_count('map_opened', true);
    IF (v_rpc_res->>'total_count')::bigint <> 2 THEN
      RAISE EXCEPTION 'G04 FAIL: Expected incremented count 2, got %', v_rpc_res;
    END IF;

    PERFORM public.increment_daily_usage_count('search_executed', true);
    PERFORM public.increment_daily_usage_count('restroom_marker_clicked', true);
    PERFORM public.increment_daily_usage_count('restroom_detail_opened', true);
    PERFORM public.increment_daily_usage_count('directions_clicked', true);
    PERFORM public.increment_daily_usage_count('payment_button_clicked', true);

    BEGIN
      PERFORM public.increment_daily_usage_count('unknown_feature', true);
      RAISE EXCEPTION 'G04 FAIL: Disallowed feature_key should raise 22023';
    EXCEPTION WHEN SQLSTATE '22023' THEN
      NULL;
    END;

    -- ------------------------------------------------------------------------
    -- G03: Customer cannot SELECT; Admin CAN SELECT
    -- ------------------------------------------------------------------------
    PERFORM set_config('role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', v_customer_uid::text, true);

    SELECT coalesce(sum(total_count), 0) INTO v_selected_count
    FROM public.daily_usage_counts
    WHERE is_test = true;

    IF v_selected_count <> 0 THEN
      RAISE EXCEPTION 'G03 FAIL: Non-admin customer was able to read % rows', v_selected_count;
    END IF;

    PERFORM set_config('request.jwt.claim.sub', v_admin_uid::text, true);

    SELECT coalesce(sum(total_count), 0) INTO v_selected_count
    FROM public.daily_usage_counts
    WHERE is_test = true;

    IF v_selected_count <> 7 THEN
      RAISE EXCEPTION 'G03 FAIL: Admin expected sum=7, got %', v_selected_count;
    END IF;

    -- Reset role before forced rollback
    PERFORM set_config('role', 'postgres', true);
    RAISE EXCEPTION 'Intentional test rollback' USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN
    -- G05: Verify zero residual rows remain after rollback
    SELECT count(*) INTO v_selected_count
    FROM public.daily_usage_counts
    WHERE is_test = true;

    IF v_selected_count <> 0 THEN
      RAISE EXCEPTION 'G05 FAIL: Residual rows remained after P0099 rollback: %', v_selected_count;
    END IF;
  END;
END $$;
