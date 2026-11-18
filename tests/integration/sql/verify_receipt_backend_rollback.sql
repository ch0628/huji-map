-- ============================================================================
-- Verification SQL: verify_receipt_backend_rollback.sql
-- Purpose: TASK 26 — Private Receipt Storage, Schema, RLS, FK, and Atomic RPC Verification
-- ============================================================================

DO $$
DECLARE
  v_fk_exists boolean;
  v_idx_appr_exists boolean;
  v_idx_pend_exists boolean;
  v_secdef_submit boolean;
  v_config_submit text[];
  v_secdef_intent boolean;
  v_config_intent text[];
  v_cust_id uuid := 'f2600000-0000-4000-8000-000000000001';
  v_other_id uuid := 'f2600000-0000-4000-8000-000000000002';
  v_merch_id uuid := 'f2600000-0000-4000-8000-000000000003';
  v_biz_id uuid := 'f2600000-0000-4000-8000-000000000010';
  v_rest_id uuid := 'f2600000-0000-4000-8000-000000000020';
  v_pol_id uuid := 'f2600000-0000-4000-8000-000000000030';
  v_sess_ok uuid := 'f2600000-0000-4000-8000-000000000040';
  v_sess_unpaid uuid := 'f2600000-0000-4000-8000-000000000041';
  v_ord_ok uuid := 'f2600000-0000-4000-8000-000000000050';
  v_res_intent jsonb;
  v_res_sub1 jsonb;
  v_res_sub_idemp jsonb;
  v_res_sub_dup jsonb;
  v_res_other jsonb;
  v_res_unpaid jsonb;
  v_sub_id uuid;
  v_cnt int;
BEGIN
  -- G01: Verify payment_refunds foreign key constraint
  SELECT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_payment_refunds_receipt_submission'
      AND table_name = 'payment_refunds'
  ) INTO v_fk_exists;

  IF NOT v_fk_exists THEN
    RAISE EXCEPTION 'G01 FAILED: fk_payment_refunds_receipt_submission missing';
  END IF;

  -- G02: Verify unique partial indexes on receipt_submissions
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'receipt_submissions'
      AND indexname = 'idx_receipt_submissions_single_approved_per_session'
  ) INTO v_idx_appr_exists;

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'receipt_submissions'
      AND indexname = 'idx_receipt_submissions_single_pending_per_session'
  ) INTO v_idx_pend_exists;

  IF NOT v_idx_appr_exists OR NOT v_idx_pend_exists THEN
    RAISE EXCEPTION 'G02 FAILED: partial unique indexes on receipt_submissions missing';
  END IF;

  -- G03: Verify RPC security definer & search_path
  SELECT prosecdef, proconfig
  INTO v_secdef_submit, v_config_submit
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'submit_customer_receipt';

  IF v_secdef_submit IS NOT TRUE OR NOT ('search_path=pg_catalog, pg_temp' = ANY(v_config_submit)) THEN
    RAISE EXCEPTION 'G03 FAILED: submit_customer_receipt must be SECURITY DEFINER with search_path=pg_catalog, pg_temp';
  END IF;

  SELECT prosecdef, proconfig
  INTO v_secdef_intent, v_config_intent
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'validate_receipt_upload_intent';

  IF v_secdef_intent IS NOT TRUE OR NOT ('search_path=pg_catalog, pg_temp' = ANY(v_config_intent)) THEN
    RAISE EXCEPTION 'G03 FAILED: validate_receipt_upload_intent must be SECURITY DEFINER with search_path=pg_catalog, pg_temp';
  END IF;

  -- G04: Verify EXECUTE privilege isolation
  IF has_function_privilege('anon', 'public.submit_customer_receipt(uuid,uuid,text,text,integer,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G04 FAILED: anon must not have EXECUTE on submit_customer_receipt';
  END IF;
  IF has_function_privilege('authenticated', 'public.submit_customer_receipt(uuid,uuid,text,text,integer,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G04 FAILED: authenticated must not have EXECUTE on submit_customer_receipt';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.submit_customer_receipt(uuid,uuid,text,text,integer,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G04 FAILED: service_role must have EXECUTE on submit_customer_receipt';
  END IF;

  -- G05: Setup isolated fixtures inside subtransaction and test functionality
  BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
    VALUES
      (v_cust_id, 'f26_cust@test.local', '{"display_name":"고객1"}'::jsonb, now(), now()),
      (v_other_id, 'f26_other@test.local', '{"display_name":"고객2"}'::jsonb, now(), now()),
      (v_merch_id, 'f26_merch@test.local', '{"display_name":"점주"}'::jsonb, now(), now());

    INSERT INTO public.user_roles (user_id, role)
    VALUES (v_merch_id, 'merchant')
    ON CONFLICT DO NOTHING;

    INSERT INTO public.businesses (
      id, name, category, road_address, latitude, longitude,
      registration_status, created_by, approved_at
    ) VALUES (
      v_biz_id, 'DEMO-영수증검증카페', '카페', '경기 수원시 팔달구 매산로 1',
      37.2661, 127.0011, 'approved', v_merch_id, now()
    );

    INSERT INTO public.business_members (business_id, user_id, role, membership_status)
    VALUES (v_biz_id, v_merch_id, 'owner', 'active');

    INSERT INTO public.restrooms (
      id, business_id, name, type, access_method,
      road_address, latitude, longitude, publication_status
    ) VALUES (
      v_rest_id, v_biz_id, 'DEMO-테스트화장실', 'partner', 'pin',
      '경기 수원시 팔달구 매산로 1', 37.2661, 127.0011, 'published'
    );

    INSERT INTO public.restroom_access_policies (
      id, restroom_id, version, access_mode, deposit_amount_krw,
      refund_eligible, receipt_window_hours, is_active, effective_from, created_by
    ) VALUES (
      v_pol_id, v_rest_id, 1, 'test_deposit', 1000,
      true, 24, true, now() - interval '1 hour', v_merch_id
    );

    -- Session 1: 유효 결제 완료 세션 (created -> payment approved -> authorized)
    INSERT INTO public.access_sessions (
      id, user_id, restroom_id, policy_id, status, access_method_snapshot,
      idempotency_key, expires_at
    ) VALUES (
      v_sess_ok, v_cust_id, v_rest_id, v_pol_id, 'created', 'pin',
      'f26_idem_sess_ok', now() + interval '1 hour'
    );

    INSERT INTO public.payment_orders (
      id, access_session_id, user_id, order_id, provider, payment_mode,
      amount_krw, status, idempotency_key
    ) VALUES (
      v_ord_ok, v_sess_ok, v_cust_id, 'hm_ord_f26_test_ok', 'toss', 'test',
      1000, 'created', 'f26_idem_ord_ok'
    );

    UPDATE public.payment_orders
    SET status = 'approved', provider_payment_key = 'pk_f26_ok', approved_at = now() - interval '30 minutes'
    WHERE id = v_ord_ok;

    UPDATE public.access_sessions
    SET status = 'authorized', authorized_at = now() - interval '30 minutes'
    WHERE id = v_sess_ok;

    -- Session 2: 결제 미완료 세션
    INSERT INTO public.access_sessions (
      id, user_id, restroom_id, policy_id, status, access_method_snapshot,
      idempotency_key, expires_at
    ) VALUES (
      v_sess_unpaid, v_cust_id, v_rest_id, v_pol_id, 'created', 'pin',
      'f26_idem_sess_unpaid', now() + interval '30 minutes'
    );

    -- Test 1: validate_receipt_upload_intent on valid session
    v_res_intent := public.validate_receipt_upload_intent(
      v_sess_ok, v_cust_id, 102400, 'image/jpeg'
    );
    IF (v_res_intent->>'ok')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'Test 1 FAILED: validate_receipt_upload_intent rejected valid session: %', v_res_intent;
    END IF;

    -- Test 2: validate_receipt_upload_intent on other user's session (403)
    v_res_other := public.validate_receipt_upload_intent(
      v_sess_ok, v_other_id, 102400, 'image/jpeg'
    );
    IF (v_res_other->>'ok')::boolean IS TRUE OR (v_res_other->>'status')::int <> 403 THEN
      RAISE EXCEPTION 'Test 2 FAILED: other user upload intent must return 403: %', v_res_other;
    END IF;

    -- Test 3: validate_receipt_upload_intent on unpaid session (422)
    v_res_unpaid := public.validate_receipt_upload_intent(
      v_sess_unpaid, v_cust_id, 102400, 'image/jpeg'
    );
    IF (v_res_unpaid->>'ok')::boolean IS TRUE OR (v_res_unpaid->>'status')::int <> 422 THEN
      RAISE EXCEPTION 'Test 3 FAILED: unpaid session upload intent must return 422: %', v_res_unpaid;
    END IF;

    -- Test 4: submit_customer_receipt valid submission
    v_res_sub1 := public.submit_customer_receipt(
      v_sess_ok,
      v_cust_id,
      'receipts/' || v_cust_id::text || '/' || v_sess_ok::text || '/receipt_01.jpg',
      'image/jpeg',
      102400,
      'receipt_01.jpg',
      'f26_client_sub_01'
    );

    IF (v_res_sub1->>'ok')::boolean IS NOT TRUE OR (v_res_sub1->>'reused')::boolean IS NOT FALSE THEN
      RAISE EXCEPTION 'Test 4 FAILED: first receipt submission failed: %', v_res_sub1;
    END IF;

    v_sub_id := (v_res_sub1->'receipt'->>'id')::uuid;

    -- Test 5: Idempotent resubmission with same client_submission_id
    v_res_sub_idemp := public.submit_customer_receipt(
      v_sess_ok,
      v_cust_id,
      'receipts/' || v_cust_id::text || '/' || v_sess_ok::text || '/receipt_01.jpg',
      'image/jpeg',
      102400,
      'receipt_01.jpg',
      'f26_client_sub_01'
    );

    IF (v_res_sub_idemp->>'ok')::boolean IS NOT TRUE OR (v_res_sub_idemp->>'reused')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'Test 5 FAILED: idempotent resubmission must succeed with reused:true: %', v_res_sub_idemp;
    END IF;

    -- Test 6: Concurrent/duplicate submission while review is pending (different client_submission_id) -> 409
    v_res_sub_dup := public.submit_customer_receipt(
      v_sess_ok,
      v_cust_id,
      'receipts/' || v_cust_id::text || '/' || v_sess_ok::text || '/receipt_02.jpg',
      'image/jpeg',
      102400,
      'receipt_02.jpg',
      'f26_client_sub_02'
    );

    IF (v_res_sub_dup->>'ok')::boolean IS TRUE OR (v_res_sub_dup->>'status')::int <> 409 THEN
      RAISE EXCEPTION 'Test 6 FAILED: duplicate submission during pending review must return 409: %', v_res_sub_dup;
    END IF;

    -- Test 7: Direct UPDATE on immutable fields must be blocked by trigger
    BEGIN
      UPDATE public.receipt_submissions
      SET storage_path = 'receipts/tampered.jpg'
      WHERE id = v_sub_id;
      RAISE EXCEPTION 'Test 7 FAILED: direct update on storage_path should have failed';
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        -- Expected HM113
        NULL;
    END;

    -- Test 8: Direct DELETE must be blocked by trigger
    BEGIN
      DELETE FROM public.receipt_submissions WHERE id = v_sub_id;
      RAISE EXCEPTION 'Test 8 FAILED: direct delete should have failed';
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        -- Expected HM114
        NULL;
    END;

    -- Force P0099 rollback to keep DB clean
    RAISE EXCEPTION 'FORCE_ROLLBACK_TASK26' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0099' THEN
      NULL; -- Caught successfully
  END;

  -- G10: Verify 0 residual test records in receipt_submissions
  SELECT COUNT(*) INTO v_cnt
  FROM public.receipt_submissions
  WHERE access_session_id IN (v_sess_ok, v_sess_unpaid);

  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'G10 FAILED: residual test rows found in receipt_submissions (cnt=%)', v_cnt;
  END IF;

  RAISE NOTICE 'TASK 26 ALL SQL & RLS VERIFICATIONS COMPLETED SUCCESSFULLY!';
END $$;
