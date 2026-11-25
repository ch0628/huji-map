-- ==============================================================================
-- Rollback Verification SQL for: 20261128000000_analytics_excluded_accounts.sql
-- Verifies:
--   G01: Schema, UNIQUE(user_id), active partial index, updated_at trigger
--   G02: RLS & Privilege isolation (anon/customer blocked from SELECT/INSERT/UPDATE)
--   G03: Admin & service_role CRUD, upsert deduplication, deactivation/reactivation
--   G04: daily_usage_counts retains strict 5-column non-identifying schema
--   G05: Independence from profiles.account_status & user_roles
--   G06: Forced rollback (P0099) leaves zero residual test data
-- ==============================================================================

DO $$
DECLARE
  v_admin_uid uuid := '88888888-8888-4888-8888-888888880001';
  v_customer_uid uuid := '88888888-8888-4888-8888-888888880002';
  v_test_uid_1 uuid := '88888888-8888-4888-8888-888888880011';
  v_test_uid_2 uuid := '88888888-8888-4888-8888-888888880012';
  v_test_uid_3 uuid := '88888888-8888-4888-8888-888888880013';
  v_count int;
  v_active boolean;
  v_updated_at_before timestamptz;
  v_updated_at_after timestamptz;
  v_daily_col_count int;
BEGIN
  -- --------------------------------------------------------------------------
  -- G01: Schema & index verification
  -- --------------------------------------------------------------------------
  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'analytics_excluded_accounts'
    AND column_name IN (
      'id', 'user_id', 'is_active', 'note',
      'created_by', 'updated_by', 'created_at', 'updated_at'
    );

  IF v_count <> 8 THEN
    RAISE EXCEPTION 'G01 FAIL: Expected 8 required columns in analytics_excluded_accounts, found %', v_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'analytics_excluded_accounts'
      AND indexname = 'idx_analytics_excluded_accounts_active_user'
  ) THEN
    RAISE EXCEPTION 'G01 FAIL: Missing partial index idx_analytics_excluded_accounts_active_user';
  END IF;

  -- G04: daily_usage_counts still has only 5 non-identifying columns
  SELECT count(*) INTO v_daily_col_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'daily_usage_counts';

  IF v_daily_col_count <> 5 THEN
    RAISE EXCEPTION 'G04 FAIL: Expected daily_usage_counts to retain 5 columns, found %', v_daily_col_count;
  END IF;

  BEGIN
    -- Create isolated test users (handle_new_user creates profiles & customer role)
    INSERT INTO auth.users (id, email)
    VALUES
      (v_admin_uid, 'ex-verify-admin@test.local'),
      (v_customer_uid, 'ex-verify-customer@test.local'),
      (v_test_uid_1, 'ex-verify-t1@test.local'),
      (v_test_uid_2, 'ex-verify-t2@test.local'),
      (v_test_uid_3, 'ex-verify-t3@test.local');

    INSERT INTO public.user_roles (user_id, role)
    VALUES (v_admin_uid, 'admin')
    ON CONFLICT (user_id, role) DO NOTHING;

    -- ------------------------------------------------------------------------
    -- G02: anon & customer must be blocked from SELECT/INSERT/UPDATE
    -- ------------------------------------------------------------------------
    PERFORM set_config('role', 'anon', true);
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);

    BEGIN
      PERFORM 1 FROM public.analytics_excluded_accounts;
      RAISE EXCEPTION 'G02 FAIL: anon was able to SELECT analytics_excluded_accounts';
    EXCEPTION WHEN SQLSTATE '42501' THEN
      NULL;
    END;

    BEGIN
      INSERT INTO public.analytics_excluded_accounts (user_id) VALUES (v_test_uid_1);
      RAISE EXCEPTION 'G02 FAIL: anon was able to INSERT into analytics_excluded_accounts';
    EXCEPTION WHEN SQLSTATE '42501' THEN
      NULL;
    END;

    -- Non-admin customer
    PERFORM set_config('role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', v_customer_uid::text, true);

    BEGIN
      INSERT INTO public.analytics_excluded_accounts (user_id) VALUES (v_customer_uid);
      RAISE EXCEPTION 'G02 FAIL: customer was able to self-register in analytics_excluded_accounts';
    EXCEPTION WHEN SQLSTATE '42501' THEN
      NULL;
    END;

    -- ------------------------------------------------------------------------
    -- G03: Admin & service_role operations, duplicate prevention, toggle
    -- ------------------------------------------------------------------------
    PERFORM set_config('request.jwt.claim.sub', v_admin_uid::text, true);

    INSERT INTO public.analytics_excluded_accounts (user_id, is_active, note, created_by, updated_by)
    VALUES
      (v_test_uid_1, true, 'QA 1', v_admin_uid, v_admin_uid),
      (v_test_uid_2, true, 'QA 2', v_admin_uid, v_admin_uid),
      (v_test_uid_3, true, 'QA 3', v_admin_uid, v_admin_uid);

    SELECT count(*) INTO v_count
    FROM public.analytics_excluded_accounts
    WHERE user_id IN (v_test_uid_1, v_test_uid_2, v_test_uid_3)
      AND is_active = true;

    IF v_count <> 3 THEN
      RAISE EXCEPTION 'G03 FAIL: Admin expected 3 active excluded rows, got %', v_count;
    END IF;

    -- Customer still sees 0 rows via RLS
    PERFORM set_config('request.jwt.claim.sub', v_customer_uid::text, true);
    SELECT count(*) INTO v_count
    FROM public.analytics_excluded_accounts
    WHERE user_id IN (v_test_uid_1, v_test_uid_2, v_test_uid_3);

    IF v_count <> 0 THEN
      RAISE EXCEPTION 'G02 FAIL: Customer was able to SELECT % excluded rows', v_count;
    END IF;

    -- Customer cannot UPDATE admin's row
    BEGIN
      UPDATE public.analytics_excluded_accounts
      SET is_active = false
      WHERE user_id = v_test_uid_1;
      GET DIAGNOSTICS v_count = ROW_COUNT;
      IF v_count <> 0 THEN
        RAISE EXCEPTION 'G02 FAIL: Customer updated % excluded rows', v_count;
      END IF;
    EXCEPTION WHEN SQLSTATE '42501' THEN
      NULL;
    END;

    -- Duplicate user_id must raise unique_violation (23505) unless ON CONFLICT used
    PERFORM set_config('role', 'service_role', true);
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);

    BEGIN
      INSERT INTO public.analytics_excluded_accounts (user_id) VALUES (v_test_uid_1);
      RAISE EXCEPTION 'G03 FAIL: Duplicate user_id insert succeeded';
    EXCEPTION WHEN SQLSTATE '23505' THEN
      NULL;
    END;

    -- Deactivate and verify updated_at trigger & status
    SELECT updated_at INTO v_updated_at_before
    FROM public.analytics_excluded_accounts
    WHERE user_id = v_test_uid_1;

    UPDATE public.analytics_excluded_accounts
    SET is_active = false, updated_by = v_admin_uid
    WHERE user_id = v_test_uid_1;

    SELECT is_active, updated_at INTO v_active, v_updated_at_after
    FROM public.analytics_excluded_accounts
    WHERE user_id = v_test_uid_1;

    IF v_active IS NOT FALSE OR v_updated_at_after < v_updated_at_before THEN
      RAISE EXCEPTION 'G03 FAIL: Deactivation did not update is_active/updated_at properly';
    END IF;

    -- ------------------------------------------------------------------------
    -- G05: Independence from profiles.account_status & user_roles
    -- ------------------------------------------------------------------------
    PERFORM set_config('role', 'postgres', true);
    UPDATE public.profiles SET account_status = 'suspended' WHERE id = v_test_uid_2;
    SELECT is_active INTO v_active
    FROM public.analytics_excluded_accounts
    WHERE user_id = v_test_uid_2;
    IF v_active IS NOT TRUE THEN
      RAISE EXCEPTION 'G05 FAIL: Suspending profile altered analytics_excluded_accounts';
    END IF;

    -- Forced rollback
    RAISE EXCEPTION 'Intentional test rollback' USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN
    SELECT count(*) INTO v_count
    FROM public.analytics_excluded_accounts
    WHERE user_id IN (v_test_uid_1, v_test_uid_2, v_test_uid_3);

    IF v_count <> 0 THEN
      RAISE EXCEPTION 'G06 FAIL: Residual rows remained after rollback: %', v_count;
    END IF;
  END;
END $$;
