-- ============================================================================
-- TASK 25: Remote Supabase Read-Only Catalog Post-Deployment Verification
-- Target: wddnbycimcixskemssct (production)
-- Migration: 20261117010000_visit_confirmation_atomic.sql
-- ZERO MUTATIONS - SINGLE CONSOLIDATED READ-ONLY JSON REPORT
-- ============================================================================

WITH
-- 1. Applied migrations check (expect 13 total, latest = 20261117010000)
mig AS (
  SELECT
    count(*)::int AS total_migrations,
    max(version) AS latest_version,
    bool_or(version = '20261117010000') AS has_20261117010000,
    jsonb_agg(version ORDER BY version) AS versions
  FROM supabase_migrations.schema_migrations
),

-- 2. Unique index idx_visit_confirmations_uq_session_method_status_reason check
uq_idx AS (
  SELECT
    c.relname AS index_name,
    i.indisunique AS is_unique,
    i.indisvalid AS is_valid,
    pg_catalog.pg_get_indexdef(i.indexrelid) AS index_def
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
  JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'visit_confirmations'
    AND c.relname = 'idx_visit_confirmations_uq_session_method_status_reason'
),

-- 3. RPC record_customer_visit_confirmation check (signature, prosecdef, proconfig, privileges)
rpc_check AS (
  SELECT
    p.proname AS rpc_name,
    pg_catalog.pg_get_function_identity_arguments(p.oid) AS arg_signature,
    pg_catalog.pg_get_function_result(p.oid) AS return_type,
    p.prosecdef AS is_security_definer,
    p.proconfig AS proconfig,
    has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute,
    has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_can_execute
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'record_customer_visit_confirmation'
),

-- 4. visit_confirmations RLS status & policies
rls_check AS (
  SELECT
    c.relrowsecurity AS rls_enabled,
    c.relforcerowsecurity AS rls_forced,
    (
      SELECT count(*)::int
      FROM pg_catalog.pg_policy pol
      WHERE pol.polrelid = c.oid
    ) AS policy_count,
    (
      SELECT jsonb_agg(pol.polname ORDER BY pol.polname)
      FROM pg_catalog.pg_policy pol
      WHERE pol.polrelid = c.oid
    ) AS policies
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'visit_confirmations'
),

-- 5. Preservation of TASK 23 ~ 24 tables and RPCs
preserved AS (
  SELECT
    (
      SELECT jsonb_object_agg(c.relname, c.relrowsecurity)
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN (
          'restroom_lock_secrets',
          'pin_reveal_audits',
          'visit_confirmations',
          'access_sessions',
          'payment_orders',
          'payment_refunds'
        )
    ) AS tables_rls,
    (
      SELECT jsonb_agg(p.proname ORDER BY p.proname)
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN (
          'rotate_restroom_pin',
          'reveal_access_pin',
          'confirm_pin_revealed',
          'record_pin_reveal_audit',
          'record_customer_visit_confirmation'
        )
    ) AS rpcs_present
),

-- 6. Existing visit_confirmations data & duplicate groups count
data_check AS (
  SELECT
    (SELECT count(*)::int FROM public.visit_confirmations) AS total_rows,
    (
      SELECT count(*)::int
      FROM (
        SELECT
          access_session_id,
          verification_method,
          usage_status,
          COALESCE(failure_reason, '')
        FROM public.visit_confirmations
        GROUP BY 1, 2, 3, 4
        HAVING count(*) > 1
      ) dup
    ) AS duplicate_group_count
)

SELECT jsonb_build_object(
  'migrations', (SELECT row_to_json(mig) FROM mig),
  'unique_index', (SELECT row_to_json(uq_idx) FROM uq_idx),
  'rpc', (SELECT row_to_json(rpc_check) FROM rpc_check),
  'visit_confirmations_rls', (SELECT row_to_json(rls_check) FROM rls_check),
  'preserved_task23_24', (SELECT row_to_json(preserved) FROM preserved),
  'visit_confirmations_data', (SELECT row_to_json(data_check) FROM data_check)
) AS verification_report;

