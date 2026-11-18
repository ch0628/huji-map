-- ============================================================================
-- TASK 28: Post-Deployment Remote Catalog Verification SQL (Read-Only)
-- Purpose: Verify production database state after deploying migrations 15 & 16:
--   1. 20261119000000_receipt_review_decision.sql
--   2. 20261119010000_receipt_review_idempotency.sql
--
-- Target: wddnbycimcixskemssct (production)
-- Safety: READ-ONLY transaction. Zero writes, zero modifications, zero deletes.
-- ============================================================================

SELECT jsonb_build_object(
  -- 1. 마이그레이션 17건 적용 여부
  'migrations', jsonb_build_object(
    'total_count', (SELECT count(*)::int FROM supabase_migrations.schema_migrations),
    'latest_version', (SELECT max(version) FROM supabase_migrations.schema_migrations),
    'all_versions', (
      SELECT jsonb_agg(version ORDER BY version ASC)
      FROM supabase_migrations.schema_migrations
    ),
    'is_17_applied', (
      SELECT count(*) = 17 AND max(version) = '20261119020000'
      FROM supabase_migrations.schema_migrations
    )
  ),

  -- 2. decide_receipt_review RPC 존재, 시그니처, 기본 인자 제거, 오버로드 정리 및 권한 격리 여부
  'decide_receipt_review_rpc', (
    SELECT jsonb_agg(jsonb_build_object(
      'proname', p.proname,
      'nargs', p.pronargs,
      'pronargdefaults', p.pronargdefaults,
      'proargdefaults', pg_get_expr(p.proargdefaults, 0),
      'signature', pg_get_function_identity_arguments(p.oid),
      'prosecdef', p.prosecdef,
      'proconfig', p.proconfig,
      'proacl', p.proacl::text,
      'has_search_path_fixed', ('search_path=pg_catalog, pg_temp' = ANY(p.proconfig)),
      'public_execute_privilege', has_function_privilege('public', p.oid, 'EXECUTE'),
      'anon_execute_privilege', has_function_privilege('anon', p.oid, 'EXECUTE'),
      'authenticated_execute_privilege', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
      'service_role_execute_privilege', has_function_privilege('service_role', p.oid, 'EXECUTE')
    ))
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'decide_receipt_review'
  ),
  'legacy_8param_exists', (
    to_regprocedure('public.decide_receipt_review(uuid,uuid,text,text,text,timestamptz,integer,text)') IS NOT NULL
  ),

  -- 3. receipt_review_audits 컬럼 확장 (idempotency_key, payload_hash)
  'receipt_review_audits_columns', (
    SELECT jsonb_agg(jsonb_build_object(
      'column_name', column_name,
      'data_type', data_type,
      'is_nullable', is_nullable
    ) ORDER BY ordinal_position)
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'receipt_review_audits'
  ),

  -- 4. 멱등성 부분 UNIQUE INDEX 존재 및 유효성
  'idempotency_unique_index', (
    SELECT jsonb_agg(jsonb_build_object(
      'index_name', c.relname,
      'is_unique', i.indisunique,
      'is_valid', i.indisvalid,
      'index_def', pg_get_indexdef(c.oid)
    ))
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'receipt_review_audits'
      AND c.relname = 'idx_receipt_review_audits_idempotency_key'
  ),

  -- 5. receipt_review_audits append-only 트리거 활성 상태
  'receipt_review_audits_trigger', (
    SELECT jsonb_agg(jsonb_build_object(
      'trigger_name', t.tgname,
      'enabled', (t.tgenabled = 'O'),
      'function_name', p.proname
    ))
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE n.nspname = 'public'
      AND c.relname = 'receipt_review_audits'
      AND t.tgname = 'trg_prevent_receipt_review_audits_mutation'
  ),

  -- 6. receipt_submissions 테이블 및 RLS, 트리거 보존 상태
  'receipt_submissions_status', jsonb_build_object(
    'table_exists', EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'receipt_submissions'
    ),
    'rls_enabled', (
      SELECT c.relrowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'receipt_submissions'
        AND c.relkind = 'r'
      LIMIT 1
    ),
    'trigger_enforce_active', EXISTS (
      SELECT 1 FROM pg_trigger tg
      JOIN pg_class c ON c.oid = tg.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'receipt_submissions'
        AND c.relkind = 'r'
        AND tg.tgname = 'trg_enforce_receipt_submission_rules'
        AND tg.tgenabled = 'O'
    )
  ),

  -- 7. TASK 26 영수증 관련 RPC 및 Storage 정책 보존
  'task26_preservation', jsonb_build_object(
    'validate_upload_intent_rpc', EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'validate_receipt_upload_intent'
        AND p.prosecdef = true AND 'search_path=pg_catalog, pg_temp' = ANY(p.proconfig)
    ),
    'submit_customer_receipt_rpc', EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'submit_customer_receipt'
        AND p.prosecdef = true AND 'search_path=pg_catalog, pg_temp' = ANY(p.proconfig)
    ),
    'receipts_bucket_private', EXISTS (
      SELECT 1 FROM storage.buckets WHERE id = 'receipts' AND public = false
    ),
    'storage_policies_count', (
      SELECT count(*)::int FROM pg_policies
      WHERE schemaname = 'storage' AND tablename = 'objects'
        AND policyname LIKE '%receipts%'
    ),
    'payment_refunds_fk_intact', EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'payment_refunds'
        AND c.conname = 'fk_payment_refunds_receipt_submission'
    )
  ),

  -- 8. TASK 23~25 핵심 객체 보존 여부
  'legacy_tasks_preservation', jsonb_build_object(
    'task23_lock_secrets_table', EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'restroom_lock_secrets'
    ),
    'task23_rotate_pin_rpc', EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'rotate_restroom_pin'
        AND p.prosecdef = true AND 'search_path=pg_catalog, pg_temp' = ANY(p.proconfig)
    ),
    'task24_pin_reveal_audits_table', EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'pin_reveal_audits'
    ),
    'task24_reveal_pin_rpc', EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'reveal_access_pin'
        AND p.prosecdef = true AND 'search_path=pg_catalog, pg_temp' = ANY(p.proconfig)
    ),
    'task24_confirm_pin_revealed_rpc', EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'confirm_pin_revealed'
        AND p.prosecdef = true AND 'search_path=pg_catalog, pg_temp' = ANY(p.proconfig)
    ),
    'task25_visit_confirmations_table', EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'visit_confirmations'
    ),
    'task25_record_visit_confirmation_rpc', EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'record_customer_visit_confirmation'
        AND p.prosecdef = true AND 'search_path=pg_catalog, pg_temp' = ANY(p.proconfig)
    )
  ),

  -- 9. 기존 운영 데이터 및 감사로그 건수 확인
  'row_counts', jsonb_build_object(
    'receipt_review_audits', (SELECT count(*)::int FROM public.receipt_review_audits),
    'receipt_submissions', (SELECT count(*)::int FROM public.receipt_submissions),
    'payment_orders', (SELECT count(*)::int FROM public.payment_orders),
    'access_sessions', (SELECT count(*)::int FROM public.access_sessions),
    'payment_refunds', (SELECT count(*)::int FROM public.payment_refunds),
    'audit_logs', (SELECT count(*)::int FROM public.audit_logs),
    'profiles', (SELECT count(*)::int FROM public.profiles),
    'businesses', (SELECT count(*)::int FROM public.businesses),
    'restrooms', (SELECT count(*)::int FROM public.restrooms)
  ),

  -- 10. 신규 마이그레이션 적용 후 객체 충돌 및 무효화(invalid) 인덱스 검사
  'catalog_integrity', jsonb_build_object(
    'invalid_indexes_count', (
      SELECT count(*)::int FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND i.indisvalid = false
    ),
    'duplicate_rpc_count', (
      SELECT count(*)::int FROM (
        SELECT proname, count(*)
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND proname = 'decide_receipt_review'
        GROUP BY proname HAVING count(*) > 1
      ) d
    )
  )
) AS post_deploy_verification_result;
