-- TASK 26: Pre-deployment Catalog Inspection SQL (Read-Only)
-- Aggregates all check sections into a single JSON object.

SELECT jsonb_build_object(
  'migrations_history', (
    SELECT jsonb_agg(version ORDER BY version ASC)
    FROM supabase_migrations.schema_migrations
  ),
  'existing_core_tables', (
    SELECT jsonb_agg(table_name ORDER BY table_name)
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'profiles', 'user_roles', 'restrooms', 'access_sessions',
        'payment_orders', 'payment_refunds', 'restroom_lock_secrets',
        'pin_reveal_audits', 'visit_confirmations'
      )
  ),
  'conflicting_tables', (
    SELECT jsonb_agg(table_name)
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('receipt_submissions', 'receipt_review_audits')
  ),
  'conflicting_rpc', (
    SELECT jsonb_agg(proname)
    FROM pg_proc
    WHERE proname IN (
      'validate_receipt_upload_intent',
      'submit_customer_receipt',
      'prevent_receipt_review_audits_mutation',
      'enforce_receipt_submission_rules'
    )
    AND pronamespace = 'public'::regnamespace
  ),
  'receipts_bucket', (
    SELECT jsonb_agg(jsonb_build_object(
      'id', id, 'name', name, 'public', public,
      'file_size_limit', file_size_limit,
      'allowed_mime_types', allowed_mime_types
    ))
    FROM storage.buckets
    WHERE id = 'receipts'
  ),
  'conflicting_storage_policies', (
    SELECT jsonb_agg(policyname)
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname IN (
        'receipts_select_own_or_admin',
        'receipts_insert_own_or_admin',
        'receipts_delete_admin_only'
      )
  ),
  'payment_refunds_fk_col', (
    SELECT jsonb_build_object(
      'has_column', EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'payment_refunds'
          AND column_name = 'receipt_submission_id'
      ),
      'has_fk_constraint', EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = 'public'
          AND table_name = 'payment_refunds'
          AND constraint_name = 'fk_payment_refunds_receipt_submission'
      )
    )
  ),
  'payment_refunds_data', (
    SELECT jsonb_build_object(
      'total_rows', count(*),
      'rows_with_receipt_id', count(receipt_submission_id)
    )
    FROM public.payment_refunds
  )
) AS inspection_result;
