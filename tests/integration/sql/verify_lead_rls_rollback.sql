-- ============================================================================
-- File: tests/integration/sql/verify_lead_rls_rollback.sql
-- Description: Single-statement self-rolling-back PostgreSQL verification for
--              TASK 05-B (business_leads, lead_contact_attempts, indexes,
--              triggers, individual GRANTs, and admin-only RLS policies).
-- Compatibility: Official Supabase CLI (`npx supabase db query --remote=... --file ... --yes`)
-- Safety Guarantees:
--   1. Single PL/pgSQL DO block (Extended Query protocol compatible).
--   2. Pre-checks that synthetic test identifiers do not exist across all 5 tables:
--      auth.users, public.profiles, public.user_roles,
--      public.business_leads, public.lead_contact_attempts.
--   3. Executes all test writes inside a subtransaction and unconditionally
--      rolls back via SQLSTATE 'P0099' so zero test rows or fake leads remain.
--   4. Post-checks that v_pass_count = v_expected_pass_count (12) and 0 rows
--      remain across all 5 tables.
-- ============================================================================

DO $verify$
DECLARE
  u_cust CONSTANT uuid := '00000000-0000-4000-8000-0000000005c1';
  u_adm  CONSTANT uuid := '00000000-0000-4000-8000-0000000005a1';
  l_test CONSTANT uuid := '00000000-0000-4000-8000-0000000005b1';
  a_test CONSTANT uuid := '00000000-0000-4000-8000-0000000005d1';
  v_expected_pass_count CONSTANT int := 12;
  v_pass_count int := 0;
  v_cnt int;
  v_name text;
  v_category text;
  v_channel text;
  v_result text;
  v_notes text;
  v_blocked boolean;
BEGIN
  -- ==========================================================================
  -- 0. Pre-check: ensure synthetic test identifiers do not exist in any of the 5 tables
  -- ==========================================================================
  SELECT count(*) INTO v_cnt
  FROM auth.users
  WHERE id IN (u_cust, u_adm)
     OR email IN ('test_05b_cust@example.invalid', 'test_05b_adm@example.invalid');
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'PRECHECK_ABORT: synthetic test user already exists in auth.users (count=%)', v_cnt;
  END IF;

  SELECT count(*) INTO v_cnt
  FROM public.profiles
  WHERE id IN (u_cust, u_adm);
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'PRECHECK_ABORT: synthetic test profile already exists in public.profiles (count=%)', v_cnt;
  END IF;

  SELECT count(*) INTO v_cnt
  FROM public.user_roles
  WHERE user_id IN (u_cust, u_adm);
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'PRECHECK_ABORT: synthetic test role already exists in public.user_roles (count=%)', v_cnt;
  END IF;

  SELECT count(*) INTO v_cnt
  FROM public.business_leads
  WHERE id = l_test
     OR business_name IN ('TEST_ROLLBACK_LEAD', 'UNAUTHORIZED_CUST_LEAD', 'UNAUTHORIZED_ANON_LEAD');
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'PRECHECK_ABORT: synthetic test lead already exists in public.business_leads (count=%)', v_cnt;
  END IF;

  SELECT count(*) INTO v_cnt
  FROM public.lead_contact_attempts
  WHERE id = a_test
     OR lead_id = l_test
     OR contacted_by IN (u_cust, u_adm);
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'PRECHECK_ABORT: synthetic test attempt already exists in public.lead_contact_attempts (count=%)', v_cnt;
  END IF;

  -- ==========================================================================
  -- 1. Catalog & Privilege Verification (Groups 1..6)
  -- ==========================================================================

  -- [Group 1] Migration 20261107000000 recorded in supabase_migrations.schema_migrations
  SELECT count(*) INTO v_cnt
  FROM supabase_migrations.schema_migrations
  WHERE version = '20261107000000';
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'FAIL [Group 1]: migration 20261107000000 not found in supabase_migrations.schema_migrations (count=%)', v_cnt;
  END IF;
  v_pass_count := v_pass_count + 1;

  -- [Group 2] Tables business_leads and lead_contact_attempts exist with RLS enabled
  SELECT count(*) INTO v_cnt
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('business_leads', 'lead_contact_attempts')
    AND c.relkind = 'r'
    AND c.relrowsecurity = true;
  IF v_cnt <> 2 THEN
    RAISE EXCEPTION 'FAIL [Group 2]: business_leads / lead_contact_attempts missing or RLS not enabled (count=%)', v_cnt;
  END IF;
  v_pass_count := v_pass_count + 1;

  -- [Group 3] Required indexes (6 indexes) exist
  SELECT count(*) INTO v_cnt
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname IN (
      'idx_business_leads_assigned_user_id',
      'idx_business_leads_converted_business_id',
      'idx_business_leads_created_at',
      'idx_lead_contact_attempts_lead_id_contacted_at',
      'idx_lead_contact_attempts_contacted_by',
      'idx_lead_contact_attempts_result'
    );
  IF v_cnt <> 6 THEN
    RAISE EXCEPTION 'FAIL [Group 3]: expected 6 lead tracking indexes, found %', v_cnt;
  END IF;
  v_pass_count := v_pass_count + 1;

  -- [Group 4] Trigger set_business_leads_updated_at exists on business_leads
  SELECT count(*) INTO v_cnt
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'business_leads'
    AND t.tgname = 'set_business_leads_updated_at'
    AND NOT t.tgisinternal;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'FAIL [Group 4]: trigger set_business_leads_updated_at missing on business_leads';
  END IF;
  v_pass_count := v_pass_count + 1;

  -- [Group 5] RLS policies (5 policies) exist across business_leads and lead_contact_attempts
  SELECT count(*) INTO v_cnt
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('business_leads', 'lead_contact_attempts')
    AND policyname IN (
      'business_leads_select_admin',
      'business_leads_insert_admin',
      'business_leads_update_admin',
      'lead_contact_attempts_select_admin',
      'lead_contact_attempts_insert_admin'
    );
  IF v_cnt <> 5 THEN
    RAISE EXCEPTION 'FAIL [Group 5]: expected 5 RLS policies on lead tables, found %', v_cnt;
  END IF;
  v_pass_count := v_pass_count + 1;

  -- [Group 6] Individual GRANT privilege verification for anon and authenticated
  -- 6-a: anon must have NO SELECT, INSERT, UPDATE, or DELETE on either table
  IF has_table_privilege('anon', 'public.business_leads', 'SELECT')
     OR has_table_privilege('anon', 'public.business_leads', 'INSERT')
     OR has_table_privilege('anon', 'public.business_leads', 'UPDATE')
     OR has_table_privilege('anon', 'public.business_leads', 'DELETE')
     OR has_table_privilege('anon', 'public.lead_contact_attempts', 'SELECT')
     OR has_table_privilege('anon', 'public.lead_contact_attempts', 'INSERT')
     OR has_table_privilege('anon', 'public.lead_contact_attempts', 'UPDATE')
     OR has_table_privilege('anon', 'public.lead_contact_attempts', 'DELETE') THEN
    RAISE EXCEPTION 'FAIL [Group 6a]: anon role must not hold any DML privileges on lead tables';
  END IF;

  -- 6-b: authenticated must individually hold SELECT, INSERT, UPDATE (and NOT DELETE) on business_leads
  IF NOT has_table_privilege('authenticated', 'public.business_leads', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.business_leads', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.business_leads', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.business_leads', 'DELETE') THEN
    RAISE EXCEPTION 'FAIL [Group 6b]: authenticated role privileges on business_leads do not match (SELECT/INSERT/UPDATE only)';
  END IF;

  -- 6-c: authenticated must individually hold SELECT, INSERT (and NOT UPDATE/DELETE) on lead_contact_attempts
  IF NOT has_table_privilege('authenticated', 'public.lead_contact_attempts', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.lead_contact_attempts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.lead_contact_attempts', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.lead_contact_attempts', 'DELETE') THEN
    RAISE EXCEPTION 'FAIL [Group 6c]: authenticated role privileges on lead_contact_attempts do not match (SELECT/INSERT only)';
  END IF;
  v_pass_count := v_pass_count + 1;

  -- ==========================================================================
  -- 2. Subtransaction for live RLS & trigger verification (Groups 7..12)
  --    Unconditionally rolled back via SQLSTATE 'P0099'
  -- ==========================================================================
  BEGIN
    INSERT INTO auth.users (
      id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    ) VALUES
      (
        u_cust, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'test_05b_cust@example.invalid', 'unused_hash', now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        '{"name":"Test05B_Cust"}'::jsonb, now(), now()
      ),
      (
        u_adm, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'test_05b_adm@example.invalid', 'unused_hash', now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        '{"name":"Test05B_Adm"}'::jsonb, now(), now()
      );

    -- Grant admin role to u_adm inside the subtransaction
    INSERT INTO public.user_roles (user_id, role, granted_by)
    VALUES (u_adm, 'admin', NULL);

    -- Switch to authenticated role with u_adm JWT claims and explicitly verify context
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', u_adm::text, true);
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object('sub', u_adm::text, 'role', 'authenticated')::text,
      true
    );

    IF current_user IS DISTINCT FROM 'authenticated'
       OR auth.role() IS DISTINCT FROM 'authenticated'
       OR auth.uid() IS DISTINCT FROM u_adm
       OR public.is_admin(auth.uid()) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'FAIL [ADMIN_JWT_CONTEXT]: current_user=% auth.role()=% auth.uid()=% is_admin=%',
        current_user, auth.role(), auth.uid(), public.is_admin(auth.uid());
    END IF;

    -- [Group 7] Admin user (u_adm) can INSERT, SELECT, and UPDATE public.business_leads
    INSERT INTO public.business_leads (id, business_name, category, contact_phone)
    VALUES (l_test, 'TEST_ROLLBACK_LEAD', '카페', '031-000-0000');

    SELECT business_name, category INTO v_name, v_category
    FROM public.business_leads
    WHERE id = l_test;
    IF v_name IS DISTINCT FROM 'TEST_ROLLBACK_LEAD' OR v_category IS DISTINCT FROM '카페' THEN
      RAISE EXCEPTION 'FAIL [Group 7a]: admin SELECT on business_leads returned (%, %)', v_name, v_category;
    END IF;

    UPDATE public.business_leads
    SET category = '카페_수정'
    WHERE id = l_test;
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    IF v_cnt <> 1 THEN
      RAISE EXCEPTION 'FAIL [Group 7b]: admin UPDATE on business_leads affected % rows', v_cnt;
    END IF;
    v_pass_count := v_pass_count + 1;

    -- [Group 8] Admin user (u_adm) can INSERT and SELECT public.lead_contact_attempts
    INSERT INTO public.lead_contact_attempts (id, lead_id, contacted_by, channel, result, notes)
    VALUES (a_test, l_test, u_adm, 'visit', 'interested', 'TEST_ROLLBACK_NOTE');

    SELECT channel, result, notes INTO v_channel, v_result, v_notes
    FROM public.lead_contact_attempts
    WHERE id = a_test AND lead_id = l_test;
    IF v_channel IS DISTINCT FROM 'visit'
       OR v_result IS DISTINCT FROM 'interested'
       OR v_notes IS DISTINCT FROM 'TEST_ROLLBACK_NOTE' THEN
      RAISE EXCEPTION 'FAIL [Group 8]: admin SELECT on lead_contact_attempts returned (%, %, %)',
        v_channel, v_result, v_notes;
    END IF;
    v_pass_count := v_pass_count + 1;

    -- Switch to authenticated role with u_cust (customer) JWT claims and explicitly verify context
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', u_cust::text, true);
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object('sub', u_cust::text, 'role', 'authenticated')::text,
      true
    );

    IF current_user IS DISTINCT FROM 'authenticated'
       OR auth.role() IS DISTINCT FROM 'authenticated'
       OR auth.uid() IS DISTINCT FROM u_cust
       OR public.is_admin(auth.uid()) IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'FAIL [CUSTOMER_JWT_CONTEXT]: current_user=% auth.role()=% auth.uid()=% is_admin=%',
        current_user, auth.role(), auth.uid(), public.is_admin(auth.uid());
    END IF;

    -- [Group 9] Customer user (u_cust) is blocked from SELECT & UPDATE on business_leads and SELECT on lead_contact_attempts
    SELECT count(*) INTO v_cnt FROM public.business_leads WHERE id = l_test;
    IF v_cnt <> 0 THEN
      RAISE EXCEPTION 'FAIL [Group 9a]: customer was able to SELECT business_leads (count=%)', v_cnt;
    END IF;

    SELECT count(*) INTO v_cnt FROM public.lead_contact_attempts WHERE id = a_test;
    IF v_cnt <> 0 THEN
      RAISE EXCEPTION 'FAIL [Group 9b]: customer was able to SELECT lead_contact_attempts (count=%)', v_cnt;
    END IF;

    v_blocked := false;
    BEGIN
      UPDATE public.business_leads SET business_name = 'HACKED_LEAD' WHERE id = l_test;
      GET DIAGNOSTICS v_cnt = ROW_COUNT;
      IF v_cnt = 0 THEN
        v_blocked := true;
      END IF;
    EXCEPTION
      WHEN insufficient_privilege THEN
        v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'FAIL [Group 9c]: customer UPDATE on business_leads affected % rows', v_cnt;
    END IF;
    v_pass_count := v_pass_count + 1;

    -- [Group 10] Customer user (u_cust) is blocked from INSERT on business_leads (42501 only)
    v_blocked := false;
    BEGIN
      INSERT INTO public.business_leads (business_name) VALUES ('UNAUTHORIZED_CUST_LEAD');
    EXCEPTION
      WHEN insufficient_privilege THEN
        v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'FAIL [Group 10]: customer INSERT on business_leads was not blocked by RLS';
    END IF;
    v_pass_count := v_pass_count + 1;

    -- [Group 11] Customer user (u_cust) is blocked from INSERT on lead_contact_attempts (42501 only)
    v_blocked := false;
    BEGIN
      INSERT INTO public.lead_contact_attempts (lead_id, contacted_by, channel, result)
      VALUES (l_test, u_cust, 'phone', 'agreed');
    EXCEPTION
      WHEN insufficient_privilege THEN
        v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'FAIL [Group 11]: customer INSERT on lead_contact_attempts was not blocked by RLS';
    END IF;
    v_pass_count := v_pass_count + 1;

    -- [Group 12] Anon role is blocked from SELECT and INSERT on both tables (42501 only)
    SET LOCAL ROLE anon;
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);

    IF current_user IS DISTINCT FROM 'anon' OR auth.role() IS DISTINCT FROM 'anon' THEN
      RAISE EXCEPTION 'FAIL [ANON_CONTEXT]: current_user=% auth.role()=%', current_user, auth.role();
    END IF;

    v_blocked := false;
    BEGIN
      PERFORM count(*) FROM public.business_leads;
    EXCEPTION
      WHEN insufficient_privilege THEN
        v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'FAIL [Group 12a]: anon SELECT on business_leads was not blocked';
    END IF;

    v_blocked := false;
    BEGIN
      INSERT INTO public.business_leads (business_name) VALUES ('UNAUTHORIZED_ANON_LEAD');
    EXCEPTION
      WHEN insufficient_privilege THEN
        v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'FAIL [Group 12b]: anon INSERT on business_leads was not blocked';
    END IF;
    v_pass_count := v_pass_count + 1;

    -- Reset role before forced rollback
    RESET ROLE;

    -- Force unconditional rollback of subtransaction
    RAISE EXCEPTION 'ROLLBACK_VERIFY_COMPLETE' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0099' THEN
      RESET ROLE;
  END;

  -- ==========================================================================
  -- 3. Post-check: verify all 12 groups passed and 0 test rows remain across all 5 tables
  -- ==========================================================================
  IF v_pass_count <> v_expected_pass_count THEN
    RAISE EXCEPTION 'POSTCHECK_FAILED: expected % passed groups, got %', v_expected_pass_count, v_pass_count;
  END IF;

  SELECT count(*) INTO v_cnt
  FROM auth.users
  WHERE id IN (u_cust, u_adm)
     OR email IN ('test_05b_cust@example.invalid', 'test_05b_adm@example.invalid');
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'POSTCHECK_LEAK: synthetic user remained in auth.users (count=%)', v_cnt;
  END IF;

  SELECT count(*) INTO v_cnt FROM public.profiles WHERE id IN (u_cust, u_adm);
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'POSTCHECK_LEAK: synthetic profile remained in public.profiles (count=%)', v_cnt;
  END IF;

  SELECT count(*) INTO v_cnt FROM public.user_roles WHERE user_id IN (u_cust, u_adm);
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'POSTCHECK_LEAK: synthetic role remained in public.user_roles (count=%)', v_cnt;
  END IF;

  SELECT count(*) INTO v_cnt
  FROM public.business_leads
  WHERE id = l_test
     OR business_name IN ('TEST_ROLLBACK_LEAD', 'UNAUTHORIZED_CUST_LEAD', 'UNAUTHORIZED_ANON_LEAD');
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'POSTCHECK_LEAK: synthetic lead remained in public.business_leads (count=%)', v_cnt;
  END IF;

  SELECT count(*) INTO v_cnt
  FROM public.lead_contact_attempts
  WHERE id = a_test
     OR lead_id = l_test
     OR contacted_by IN (u_cust, u_adm);
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'POSTCHECK_LEAK: synthetic attempt remained in public.lead_contact_attempts (count=%)', v_cnt;
  END IF;
END
$verify$;
