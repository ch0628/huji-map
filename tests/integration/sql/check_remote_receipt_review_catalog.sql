-- TASK 28: Pre-deployment Remote Catalog Inspection SQL (Read-Only)
-- Purpose: Verify remote database state before deploying TASK 28 migrations:
--   1. 20261119000000_receipt_review_decision.sql
--   2. 20261119010000_receipt_review_idempotency.sql
--
-- Target: wddnbycimcixskemssct
-- Safety: READ-ONLY transaction. Zero writes, zero modifications, zero deletes.

SELECT jsonb_build_object(
  'migrations_history', (
    SELECT jsonb_agg(version ORDER BY version ASC)
    FROM supabase_migrations.schema_migrations
  ),
  'migration_14_applied', EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261118000000'
  ),
  'migration_15_already_applied', EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261119000000'
  ),
  'migration_16_already_applied', EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261119010000'
  ),
  'conflicting_new_rpc', (
    SELECT jsonb_agg(p.proname)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'decide_receipt_review'
  ),
  'conflicting_new_indexes', (
    SELECT jsonb_agg(indexname)
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'idx_receipt_review_audits_idempotency_key'
  ),
  'receipt_review_audits_existing_columns', (
    SELECT jsonb_agg(jsonb_build_object(
      'column_name', column_name,
      'data_type', data_type,
      'is_nullable', is_nullable
    ) ORDER BY ordinal_position)
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'receipt_review_audits'
  ),
  'has_idempotency_columns_already', (
    SELECT jsonb_build_object(
      'idempotency_key', EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'receipt_review_audits' AND column_name = 'idempotency_key'
      ),
      'payload_hash', EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'receipt_review_audits' AND column_name = 'payload_hash'
      )
    )
  ),
  'receipt_review_audits_row_count', (
    SELECT count(*)::int
    FROM public.receipt_review_audits
  ),
  'receipt_submissions_row_count', (
    SELECT count(*)::int
    FROM public.receipt_submissions
  ),
  'task26_objects_intact', (
    SELECT jsonb_build_object(
      'receipt_submissions_table', EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'receipt_submissions'
      ),
      'receipt_submissions_rls', (
        SELECT c.relrowsecurity
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'receipt_submissions'
      ),
      'receipt_review_audits_table', EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'receipt_review_audits'
      ),
      'receipt_review_audits_rls', (
        SELECT c.relrowsecurity
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'receipt_review_audits'
      ),
      'trigger_prevent_audits_mutation', (
        SELECT t.tgenabled = 'O'
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'receipt_review_audits'
          AND t.tgname = 'trg_prevent_receipt_review_audits_mutation'
      ),
      'trigger_enforce_submissions_rules', (
        SELECT t.tgenabled = 'O'
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'receipt_submissions'
          AND t.tgname = 'trg_enforce_receipt_submission_rules'
      ),
      'fk_payment_refunds_receipt_submission', EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = 'public' AND table_name = 'payment_refunds'
          AND constraint_name = 'fk_payment_refunds_receipt_submission'
      ),
      'receipts_bucket_exists', EXISTS (
        SELECT 1 FROM storage.buckets WHERE id = 'receipts' AND public = false
      ),
      'task26_rpc_validate_upload_intent', EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'validate_receipt_upload_intent'
          AND p.prosecdef = true AND 'search_path=pg_catalog, pg_temp' = ANY(p.proconfig)
      ),
      'task26_rpc_submit_receipt', EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'submit_customer_receipt'
          AND p.prosecdef = true AND 'search_path=pg_catalog, pg_temp' = ANY(p.proconfig)
      )
    )
  ),
  'audit_logs_table_intact', (
    SELECT jsonb_build_object(
      'table_exists', EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'audit_logs'
      ),
      'rls_enabled', (
        SELECT c.relrowsecurity
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'audit_logs'
      ),
      'row_count', (SELECT count(*)::int FROM public.audit_logs)
    )
  )
) AS inspection_result;

