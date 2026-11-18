-- TASK 26: Post-Deployment Catalog Verification SQL (Read-Only)
-- Target: Remote Supabase Production DB (wddnbycimcixskemssct)
-- Pure SELECT catalog inspection. NO DDL, NO DML, NO TRANSACTION MODIFICATION.

SELECT jsonb_build_object(
  -- 1. 마이그레이션 14건 Local/Remote 일치
  'migrations_count', (SELECT count(*) FROM supabase_migrations.schema_migrations),
  'migrations_list', (SELECT jsonb_agg(version ORDER BY version ASC) FROM supabase_migrations.schema_migrations),

  -- 2. receipt_submissions 테이블 및 제약
  'receipt_submissions_table', (
    SELECT jsonb_build_object(
      'exists', EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'receipt_submissions'),
      'rls_enabled', (SELECT relrowsecurity FROM pg_class WHERE relname = 'receipt_submissions' AND relnamespace = 'public'::regnamespace),
      'columns_count', (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'receipt_submissions'),
      'has_mime_check', EXISTS (
        SELECT 1 FROM information_schema.check_constraints cc
        JOIN information_schema.table_constraints tc ON cc.constraint_name = tc.constraint_name
        WHERE tc.table_schema = 'public' AND tc.table_name = 'receipt_submissions'
          AND cc.check_clause LIKE '%mime_type%'
      ),
      'has_size_check', EXISTS (
        SELECT 1 FROM information_schema.check_constraints cc
        JOIN information_schema.table_constraints tc ON cc.constraint_name = tc.constraint_name
        WHERE tc.table_schema = 'public' AND tc.table_name = 'receipt_submissions'
          AND cc.check_clause LIKE '%file_size_bytes%'
      ),
      'has_status_check', EXISTS (
        SELECT 1 FROM information_schema.check_constraints cc
        JOIN information_schema.table_constraints tc ON cc.constraint_name = tc.constraint_name
        WHERE tc.table_schema = 'public' AND tc.table_name = 'receipt_submissions'
          AND cc.check_clause LIKE '%submission_status%'
      )
    )
  ),

  -- 3. receipt_review_audits 테이블 및 불변 트리거
  'receipt_review_audits_table', (
    SELECT jsonb_build_object(
      'exists', EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'receipt_review_audits'),
      'rls_enabled', (SELECT relrowsecurity FROM pg_class WHERE relname = 'receipt_review_audits' AND relnamespace = 'public'::regnamespace),
      'has_immutable_trigger', EXISTS (
        SELECT 1 FROM pg_trigger tg
        JOIN pg_class cl ON tg.tgrelid = cl.oid
        WHERE cl.relname = 'receipt_review_audits'
          AND tg.tgname = 'trg_prevent_receipt_review_audits_mutation'
          AND tg.tgenabled = 'O'
      )
    )
  ),

  -- 4. payment_refunds 외래키 존재
  'payment_refunds_fk', (
    SELECT jsonb_build_object(
      'has_fk_constraint', EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = 'public' AND table_name = 'payment_refunds'
          AND constraint_name = 'fk_payment_refunds_receipt_submission'
      ),
      'conf_del_type', (
        SELECT confdeltype::text FROM pg_constraint
        WHERE conname = 'fk_payment_refunds_receipt_submission'
      ) -- 'r' = RESTRICT
    )
  ),

  -- 5. UNIQUE 인덱스 정상 생성
  'unique_indexes', (
    SELECT jsonb_build_object(
      'has_client_sub_unique', EXISTS (
        SELECT 1 FROM pg_index i
        JOIN pg_class c ON i.indexrelid = c.oid
        JOIN pg_class t ON i.indrelid = t.oid
        WHERE t.relname = 'receipt_submissions'
          AND i.indisunique = true
          AND pg_get_indexdef(c.oid) LIKE '%client_submission_id%'
      ),
      'has_single_approved_per_session', EXISTS (
        SELECT 1 FROM pg_index i
        JOIN pg_class c ON i.indexrelid = c.oid
        WHERE c.relname = 'idx_receipt_submissions_single_approved_per_session'
          AND i.indisunique = true
      ),
      'has_single_pending_per_session', EXISTS (
        SELECT 1 FROM pg_index i
        JOIN pg_class c ON i.indexrelid = c.oid
        WHERE c.relname = 'idx_receipt_submissions_single_pending_per_session'
          AND i.indisunique = true
      )
    )
  ),

  -- 6 & 7 & 8 & 9. 영수증 RPC, SECURITY DEFINER, search_path, 실행 권한
  'rpc_functions', (
    SELECT jsonb_agg(
      jsonb_build_object(
        'proname', p.proname,
        'prosecdef', p.prosecdef,
        'search_path', p.proconfig,
        'anon_can_execute', has_function_privilege('anon', p.oid, 'EXECUTE'),
        'authenticated_can_execute', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
        'service_role_can_execute', has_function_privilege('service_role', p.oid, 'EXECUTE')
      )
    )
    FROM pg_proc p
    WHERE p.proname IN (
      'validate_receipt_upload_intent',
      'submit_customer_receipt',
      'prevent_receipt_review_audits_mutation',
      'enforce_receipt_submission_rules'
    )
    AND p.pronamespace = 'public'::regnamespace
  ),

  -- 10 & 11. receipts Bucket 비공개 상태 및 용량/MIME 제한
  'receipts_bucket', (
    SELECT jsonb_build_object(
      'id', id,
      'public', public,
      'file_size_limit', file_size_limit,
      'allowed_mime_types', allowed_mime_types
    )
    FROM storage.buckets
    WHERE id = 'receipts'
  ),

  -- 12 & 13. Storage SELECT / INSERT / DELETE RLS 정책 (일반 고객 직접 INSERT 차단 확인)
  'storage_policies', (
    SELECT jsonb_agg(
      jsonb_build_object(
        'policyname', policyname,
        'cmd', cmd,
        'roles', roles,
        'qual', qual,
        'with_check', with_check
      )
    )
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname IN (
        'receipts_select_own_or_admin',
        'receipts_insert_admin_only',
        'receipts_insert_own_or_admin',
        'receipts_delete_admin_only'
      )
  ),

  -- 14. 기존 TASK 23~25 객체 보존 확인
  'legacy_objects_preserved', (
    SELECT jsonb_build_object(
      'has_restroom_lock_secrets', EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'restroom_lock_secrets'),
      'has_pin_reveal_audits', EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'pin_reveal_audits'),
      'has_visit_confirmations', EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'visit_confirmations'),
      'has_rotate_restroom_pin', EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'rotate_restroom_pin' AND pronamespace = 'public'::regnamespace),
      'has_reveal_access_pin', EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'reveal_access_pin' AND pronamespace = 'public'::regnamespace),
      'has_confirm_pin_revealed', EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'confirm_pin_revealed' AND pronamespace = 'public'::regnamespace),
      'has_record_customer_visit_confirmation', EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'record_customer_visit_confirmation' AND pronamespace = 'public'::regnamespace),
      'feature_flags_count', (SELECT count(*) FROM public.feature_flags)
    )
  ),

  -- 15. 원격 실운영/테스트 데이터 무변경 및 잔류 0건 확인
  'data_integrity', (
    SELECT jsonb_build_object(
      'receipt_submissions_count', (SELECT count(*) FROM public.receipt_submissions),
      'receipt_review_audits_count', (SELECT count(*) FROM public.receipt_review_audits)
    )
  )
) AS verification_report;

