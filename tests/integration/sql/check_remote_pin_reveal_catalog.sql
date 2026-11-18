-- ============================================================================
-- TASK 24: Remote Supabase Read-Only Catalog Post-Deployment Verification
-- Target: wddnbycimcixskemssct
-- ZERO MUTATIONS - SINGLE CONSOLIDATED READ-ONLY JSON REPORT
-- ============================================================================

WITH
-- 1. Schema Migrations Check
m AS (
  SELECT
    count(*)::int AS total_applied,
    max(version) AS latest_version,
    bool_or(version = '20261117000000') AS is_task24_applied,
    jsonb_agg(version ORDER BY version) AS all_versions
  FROM supabase_migrations.schema_migrations
),

-- 2. Tables and Column Counts
t AS (
  SELECT
    bool_or(table_name = 'pin_reveal_audits') AS pin_reveal_audits_exists,
    count(*) FILTER (WHERE table_name = 'pin_reveal_audits')::int AS pin_reveal_audits_cols,
    bool_or(table_name = 'visit_confirmations') AS visit_confirmations_exists,
    count(*) FILTER (WHERE table_name = 'visit_confirmations')::int AS visit_confirmations_cols
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name IN ('pin_reveal_audits', 'visit_confirmations')
),

-- 3. Detailed Column Specs for pin_reveal_audits & visit_confirmations
cols AS (
  SELECT jsonb_object_agg(
    table_name,
    col_list
  ) AS table_columns
  FROM (
    SELECT
      table_name,
      jsonb_agg(jsonb_build_object(
        'column_name', column_name,
        'data_type', data_type,
        'is_nullable', is_nullable
      ) ORDER BY ordinal_position) AS col_list
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('pin_reveal_audits', 'visit_confirmations')
    GROUP BY table_name
  ) sub
),

-- 4. Constraints (PK, FK, CHECK) on TASK 24 tables via pg_constraint
cons AS (
  SELECT jsonb_agg(jsonb_build_object(
    'table_name', c.relname,
    'constraint_name', con.conname,
    'constraint_type', CASE con.contype
      WHEN 'p' THEN 'PRIMARY KEY'
      WHEN 'f' THEN 'FOREIGN KEY'
      WHEN 'c' THEN 'CHECK'
      WHEN 'u' THEN 'UNIQUE'
      ELSE con.contype::text
    END,
    'definition', pg_get_constraintdef(con.oid)
  ) ORDER BY c.relname, con.conname) AS constraints_list
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class c ON con.conrelid = c.oid
  JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
  WHERE n.nspname = 'public'
    AND c.relname IN ('pin_reveal_audits', 'visit_confirmations')
),

-- 5. Mutation Prevention Trigger on pin_reveal_audits
trg AS (
  SELECT jsonb_agg(jsonb_build_object(
    'trigger_name', tg.tgname,
    'table_name', c.relname,
    'is_enabled', (tg.tgenabled = 'O'),
    'is_function_definer', p.prosecdef,
    'function_search_path', p.proconfig
  )) AS trigger_info
  FROM pg_catalog.pg_trigger tg
  JOIN pg_catalog.pg_class c ON tg.tgrelid = c.oid
  JOIN pg_catalog.pg_proc p ON tg.tgfoid = p.oid
  JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
  WHERE n.nspname = 'public'
    AND c.relname = 'pin_reveal_audits'
    AND tg.tgname = 'trg_prevent_pin_reveal_audits_mutation'
),

-- 6. RPCs existence, SECURITY DEFINER, search_path
rpcs AS (
  SELECT jsonb_agg(jsonb_build_object(
    'rpc_name', p.proname,
    'is_security_definer', p.prosecdef,
    'search_path', p.proconfig,
    'arg_types', pg_catalog.pg_get_function_arguments(p.oid),
    'return_type', pg_catalog.pg_get_function_result(p.oid)
  ) ORDER BY p.proname) AS rpc_info
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public'
    AND p.proname IN ('reveal_access_pin', 'confirm_pin_revealed', 'record_pin_reveal_audit')
),

-- 7. RPC Permissions (EXECUTE privileges for anon, authenticated, service_role)
rpc_perms AS (
  SELECT jsonb_agg(jsonb_build_object(
    'rpc_name', p.proname,
    'anon_execute', has_function_privilege('anon', p.oid, 'EXECUTE'),
    'authenticated_execute', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
    'service_role_execute', has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) ORDER BY p.proname) AS rpc_permissions
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public'
    AND p.proname IN ('reveal_access_pin', 'confirm_pin_revealed', 'record_pin_reveal_audit')
),

-- 8. Table Permissions & RLS
tbl_inner AS (
  SELECT
    c.relname,
    has_table_privilege('anon', c.oid, 'SELECT') AS anon_select,
    has_table_privilege('anon', c.oid, 'INSERT') AS anon_insert,
    has_table_privilege('authenticated', c.oid, 'SELECT') AS auth_select,
    has_table_privilege('authenticated', c.oid, 'INSERT') AS auth_insert,
    has_table_privilege('service_role', c.oid, 'SELECT') AS service_select,
    has_table_privilege('service_role', c.oid, 'INSERT') AS service_insert,
    c.relrowsecurity AS rls_enabled,
    count(pol.oid)::int AS policies_count,
    jsonb_agg(jsonb_build_object(
      'policy_name', pol.polname,
      'cmd', CASE pol.polcmd
        WHEN 'r' THEN 'SELECT'
        WHEN 'a' THEN 'INSERT'
        WHEN 'w' THEN 'UPDATE'
        WHEN 'd' THEN 'DELETE'
        WHEN '*' THEN 'ALL'
      END,
      'roles', pol.polroles
    )) FILTER (WHERE pol.oid IS NOT NULL) AS policies
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
  LEFT JOIN pg_catalog.pg_policy pol ON pol.polrelid = c.oid
  WHERE n.nspname = 'public'
    AND c.relname IN ('pin_reveal_audits', 'visit_confirmations')
  GROUP BY c.relname, c.oid, c.relrowsecurity
),
tbl_perms AS (
  SELECT jsonb_agg(jsonb_build_object(
    'table_name', relname,
    'anon_select', anon_select,
    'anon_insert', anon_insert,
    'auth_select', auth_select,
    'auth_insert', auth_insert,
    'service_select', service_select,
    'service_insert', service_insert,
    'rls_enabled', rls_enabled,
    'policies_count', policies_count,
    'policies', policies
  ) ORDER BY relname) AS table_permissions
  FROM tbl_inner
),

-- 9. Preservation of Previous Schemas (TASK 23 lock secrets & payment/access tables)
preservation AS (
  SELECT jsonb_build_object(
    'restroom_lock_secrets_exists', bool_or(c.relname = 'restroom_lock_secrets'),
    'rotate_restroom_pin_exists', (
      SELECT count(*) > 0
      FROM pg_catalog.pg_proc p2
      JOIN pg_catalog.pg_namespace n2 ON p2.pronamespace = n2.oid
      WHERE n2.nspname = 'public' AND p2.proname = 'rotate_restroom_pin'
    ),
    'payment_orders_exists', bool_or(c.relname = 'payment_orders'),
    'payment_refunds_exists', bool_or(c.relname = 'payment_refunds'),
    'access_sessions_exists', bool_or(c.relname = 'access_sessions'),
    'audit_logs_exists', bool_or(c.relname = 'audit_logs'),
    'feature_flags_exists', bool_or(c.relname = 'feature_flags'),
    'total_public_tables_with_rls', (
      SELECT count(*)::int
      FROM pg_catalog.pg_class c2
      JOIN pg_catalog.pg_namespace n2 ON c2.relnamespace = n2.oid
      WHERE n2.nspname = 'public' AND c2.relkind = 'r' AND c2.relrowsecurity = true
    ),
    'total_public_tables', (
      SELECT count(*)::int
      FROM pg_catalog.pg_class c3
      JOIN pg_catalog.pg_namespace n3 ON c3.relnamespace = n3.oid
      WHERE n3.nspname = 'public' AND c3.relkind = 'r'
    )
  ) AS schema_preservation
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
  WHERE n.nspname = 'public'
    AND c.relname IN (
      'restroom_lock_secrets', 'payment_orders', 'payment_refunds',
      'access_sessions', 'audit_logs', 'feature_flags'
    )
),

-- 10. Production Cleanliness (0 test residue)
counts AS (
  SELECT jsonb_build_object(
    'pin_reveal_audits_count', (SELECT count(*)::int FROM public.pin_reveal_audits),
    'visit_confirmations_count', (SELECT count(*)::int FROM public.visit_confirmations)
  ) AS row_counts
)

SELECT jsonb_build_object(
  '1_migrations', (SELECT to_jsonb(m.*) FROM m),
  '2_tables', (SELECT to_jsonb(t.*) FROM t),
  '3_columns', (SELECT table_columns FROM cols),
  '4_constraints', (SELECT constraints_list FROM cons),
  '5_triggers', (SELECT trigger_info FROM trg),
  '6_rpcs', (SELECT rpc_info FROM rpcs),
  '7_rpc_permissions', (SELECT rpc_permissions FROM rpc_perms),
  '8_table_permissions', (SELECT table_permissions FROM tbl_perms),
  '9_preservation', (SELECT schema_preservation FROM preservation),
  '10_cleanliness', (SELECT row_counts FROM counts)
) AS verification_report;
