-- ==============================================================================
-- TASK-06 Rollback Verification SQL
-- Verifies:
--   1. 20261123000000_receipt_reject_resubmission_guard.sql (validate_receipt_upload_intent)
--   2. 20261123010000_prevent_duplicate_restroom_policy.sql (create_merchant_restroom_policy)
-- Zero residual data guaranteed via subtransaction P0099 forced rollback.
-- ==============================================================================

DO $$
DECLARE
  v_cust_id uuid := 'f6000000-0000-4000-8000-000000000001';
  v_other_id uuid := 'f6000000-0000-4000-8000-000000000002';
  v_merch_id uuid := 'f6000000-0000-4000-8000-000000000003';
  v_admin_id uuid := 'f6000000-0000-4000-8000-000000000004';
  v_biz_id uuid := 'f6000000-0000-4000-8000-000000000010';
  v_rest_id uuid := 'f6000000-0000-4000-8000-000000000020';
  v_pol_id uuid := 'f6000000-0000-4000-8000-000000000030';
  v_sess_main uuid := 'f6000000-0000-4000-8000-000000000041';
  v_sess_rej uuid := 'f6000000-0000-4000-8000-000000000042';
  v_sess_exp uuid := 'f6000000-0000-4000-8000-000000000043';
  v_sess_ref uuid := 'f6000000-0000-4000-8000-000000000044';
  v_ord_main uuid := 'f6000000-0000-4000-8000-000000000051';
  v_ord_rej uuid := 'f6000000-0000-4000-8000-000000000052';
  v_ord_exp uuid := 'f6000000-0000-4000-8000-000000000053';
  v_ord_ref uuid := 'f6000000-0000-4000-8000-000000000054';

  v_cnt integer;
  v_res jsonb;
  v_sub1_id uuid;
  v_sub2_id uuid;
  v_sub_rej_id uuid;
  v_pol_rec public.restroom_access_policies;
  v_err_code text;
BEGIN
  -- [G00] Precheck zero collisions
  SELECT count(*) INTO v_cnt FROM auth.users
  WHERE id IN (v_cust_id, v_other_id, v_merch_id, v_admin_id);
  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'PRECHECK_ABORT: synthetic test users already exist';
  END IF;

  -- [G01] Function & permission verification
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'validate_receipt_upload_intent' AND p.prosecdef = true
  ) THEN
    RAISE EXCEPTION 'FAIL [G01]: validate_receipt_upload_intent SECURITY DEFINER missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'create_merchant_restroom_policy' AND p.prosecdef = true
  ) THEN
    RAISE EXCEPTION 'FAIL [G01]: create_merchant_restroom_policy SECURITY DEFINER missing';
  END IF;

  IF has_function_privilege('anon', 'public.validate_receipt_upload_intent(uuid, uuid, integer, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.validate_receipt_upload_intent(uuid, uuid, integer, text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.validate_receipt_upload_intent(uuid, uuid, integer, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL [G01]: validate_receipt_upload_intent execute grants mismatch';
  END IF;

  IF has_function_privilege('anon', 'public.create_merchant_restroom_policy(uuid, text, integer, boolean, integer, integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.create_merchant_restroom_policy(uuid, text, integer, boolean, integer, integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.create_merchant_restroom_policy(uuid, text, integer, boolean, integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL [G01]: create_merchant_restroom_policy execute grants mismatch';
  END IF;

  -- Subtransaction block rolled back at end via P0099
  BEGIN
    -- [G02] Fixture setup
    INSERT INTO auth.users (id, email, raw_user_meta_data)
    VALUES
      (v_cust_id, 'task06_cust@test.local', '{"display_name":"고객"}'::jsonb),
      (v_other_id, 'task06_other@test.local', '{"display_name":"타인"}'::jsonb),
      (v_merch_id, 'task06_merch@test.local', '{"display_name":"점주"}'::jsonb),
      (v_admin_id, 'task06_admin@test.local', '{"display_name":"관리자"}'::jsonb);

    INSERT INTO public.user_roles (user_id, role)
    VALUES (v_merch_id, 'merchant'), (v_admin_id, 'admin')
    ON CONFLICT DO NOTHING;

    INSERT INTO public.businesses (id, name, category, road_address, latitude, longitude, registration_status, created_by, approved_at)
    VALUES (v_biz_id, 'TASK06테스트점포', '카페', '수원시 팔달구 매산로 10', 37.2661, 127.0011, 'approved', v_merch_id, now());

    INSERT INTO public.business_members (business_id, user_id, role, membership_status)
    VALUES (v_biz_id, v_merch_id, 'owner', 'active');

    INSERT INTO public.restrooms (id, business_id, name, type, access_method, road_address, latitude, longitude, publication_status)
    VALUES (v_rest_id, v_biz_id, 'TASK06화장실', 'partner', 'pin', '수원시 팔달구 매산로 10', 37.2661, 127.0011, 'published');

    INSERT INTO public.restroom_access_policies (id, restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, receipt_window_hours, min_purchase_krw, is_active, effective_from, created_by)
    VALUES (v_pol_id, v_rest_id, 1, 'test_deposit', 1000, true, 24, 0, true, now() - interval '1 hour', v_merch_id);

    -- Sessions & approved orders
    INSERT INTO public.access_sessions (id, user_id, restroom_id, policy_id, status, access_method_snapshot, idempotency_key, expires_at)
    VALUES
      (v_sess_main, v_cust_id, v_rest_id, v_pol_id, 'created', 'pin', 'task06_s_main', now() + interval '1 hour'),
      (v_sess_rej, v_cust_id, v_rest_id, v_pol_id, 'created', 'pin', 'task06_s_rej', now() + interval '1 hour'),
      (v_sess_exp, v_cust_id, v_rest_id, v_pol_id, 'created', 'pin', 'task06_s_exp', now() + interval '1 hour'),
      (v_sess_ref, v_cust_id, v_rest_id, v_pol_id, 'created', 'pin', 'task06_s_ref', now() + interval '1 hour');

    INSERT INTO public.payment_orders (id, access_session_id, user_id, order_id, provider, payment_mode, amount_krw, status, idempotency_key)
    VALUES
      (v_ord_main, v_sess_main, v_cust_id, 'task06_ord_main', 'toss', 'test', 1000, 'created', 'task06_o_main'),
      (v_ord_rej, v_sess_rej, v_cust_id, 'task06_ord_rej', 'toss', 'test', 1000, 'created', 'task06_o_rej'),
      (v_ord_exp, v_sess_exp, v_cust_id, 'task06_ord_exp', 'toss', 'test', 1000, 'created', 'task06_o_exp'),
      (v_ord_ref, v_sess_ref, v_cust_id, 'task06_ord_ref', 'toss', 'test', 1000, 'created', 'task06_o_ref');

    UPDATE public.payment_orders SET status = 'approved', provider_payment_key = 'pk_t06_1', approved_at = now() - interval '10 minutes' WHERE id = v_ord_main;
    UPDATE public.payment_orders SET status = 'approved', provider_payment_key = 'pk_t06_2', approved_at = now() - interval '10 minutes' WHERE id = v_ord_rej;
    UPDATE public.payment_orders SET status = 'approved', provider_payment_key = 'pk_t06_3', approved_at = now() - interval '30 hours' WHERE id = v_ord_exp;
    UPDATE public.payment_orders SET status = 'approved', provider_payment_key = 'pk_t06_4', approved_at = now() - interval '10 minutes' WHERE id = v_ord_ref;

    UPDATE public.access_sessions SET status = 'authorized', authorized_at = now() - interval '10 minutes' WHERE id IN (v_sess_main, v_sess_rej, v_sess_ref);
    UPDATE public.access_sessions SET status = 'authorized', authorized_at = now() - interval '30 hours' WHERE id = v_sess_exp;

    -- Refunded order check fixture (must start in 'requested' then transition to 'succeeded')
    INSERT INTO public.payment_refunds (payment_order_id, amount_krw, status, idempotency_key, requested_by)
    VALUES (v_ord_ref, 1000, 'requested', 'task06_ref_1', v_admin_id);
    UPDATE public.payment_refunds
    SET status = 'succeeded', provider_cancel_id = 'cancel_t06_1', completed_at = now()
    WHERE payment_order_id = v_ord_ref;

    -- [G03] Receipt Resubmission Guard Tests
    -- 1) Cross-user attempt -> 403 FORBIDDEN
    v_res := public.validate_receipt_upload_intent(v_sess_main, v_other_id, 1024, 'image/jpeg');
    IF (v_res->>'ok')::boolean OR v_res->>'error_code' <> 'FORBIDDEN' THEN
      RAISE EXCEPTION 'FAIL [G03.1]: expected FORBIDDEN for other user, got %', v_res;
    END IF;

    -- 2) Refunded session -> 422 PAYMENT_ALREADY_REFUNDED
    v_res := public.validate_receipt_upload_intent(v_sess_ref, v_cust_id, 1024, 'image/jpeg');
    IF (v_res->>'ok')::boolean OR v_res->>'error_code' <> 'PAYMENT_ALREADY_REFUNDED' THEN
      RAISE EXCEPTION 'FAIL [G03.2]: expected PAYMENT_ALREADY_REFUNDED, got %', v_res;
    END IF;

    -- 3) Expired window -> 422 RECEIPT_WINDOW_EXPIRED
    v_res := public.validate_receipt_upload_intent(v_sess_exp, v_cust_id, 1024, 'image/jpeg');
    IF (v_res->>'ok')::boolean OR v_res->>'error_code' <> 'RECEIPT_WINDOW_EXPIRED' THEN
      RAISE EXCEPTION 'FAIL [G03.3]: expected RECEIPT_WINDOW_EXPIRED, got %', v_res;
    END IF;

    -- 4) Unsubmitted -> allowed, submit -> submitted
    v_res := public.validate_receipt_upload_intent(v_sess_main, v_cust_id, 1024, 'image/jpeg');
    IF NOT (v_res->>'ok')::boolean THEN
      RAISE EXCEPTION 'FAIL [G03.4a]: expected ok=true for unsubmitted session, got %', v_res;
    END IF;

    v_res := public.submit_customer_receipt(v_sess_main, v_cust_id, 'receipts/' || v_cust_id || '/' || v_sess_main || '/1.jpg', 'image/jpeg', 1024, 'r1.jpg', 't06_idem_1');
    IF NOT (v_res->>'ok')::boolean THEN
      RAISE EXCEPTION 'FAIL [G03.4b]: initial submit failed: %', v_res;
    END IF;
    v_sub1_id := (v_res->'receipt'->>'id')::uuid;

    -- Idempotent replay with same client_submission_id -> reused=true
    v_res := public.submit_customer_receipt(v_sess_main, v_cust_id, 'receipts/' || v_cust_id || '/' || v_sess_main || '/1.jpg', 'image/jpeg', 1024, 'r1.jpg', 't06_idem_1');
    IF NOT (v_res->>'ok')::boolean OR NOT (v_res->>'reused')::boolean THEN
      RAISE EXCEPTION 'FAIL [G03.4c]: idempotent replay failed: %', v_res;
    END IF;

    -- Cross-session idempotency conflict -> 409 IDEMPOTENCY_CONFLICT
    v_res := public.submit_customer_receipt(v_sess_rej, v_cust_id, 'receipts/' || v_cust_id || '/' || v_sess_rej || '/1.jpg', 'image/jpeg', 1024, 'r1.jpg', 't06_idem_1');
    IF (v_res->>'ok')::boolean OR v_res->>'error_code' <> 'IDEMPOTENCY_CONFLICT' THEN
      RAISE EXCEPTION 'FAIL [G03.4d]: expected IDEMPOTENCY_CONFLICT, got %', v_res;
    END IF;

    -- 5) While submitted -> blocked 409 RECEIPT_UNDER_REVIEW
    v_res := public.validate_receipt_upload_intent(v_sess_main, v_cust_id, 1024, 'image/jpeg');
    IF (v_res->>'ok')::boolean OR v_res->>'error_code' <> 'RECEIPT_UNDER_REVIEW' THEN
      RAISE EXCEPTION 'FAIL [G03.5]: expected RECEIPT_UNDER_REVIEW, got %', v_res;
    END IF;

    -- 6) review_required -> blocked 409 RECEIPT_UNDER_REVIEW
    UPDATE public.receipt_submissions SET submission_status = 'review_required' WHERE id = v_sub1_id;
    v_res := public.validate_receipt_upload_intent(v_sess_main, v_cust_id, 1024, 'image/jpeg');
    IF (v_res->>'ok')::boolean OR v_res->>'error_code' <> 'RECEIPT_UNDER_REVIEW' THEN
      RAISE EXCEPTION 'FAIL [G03.6]: expected RECEIPT_UNDER_REVIEW for review_required, got %', v_res;
    END IF;

    -- 7) resubmission_requested -> allowed, then approved -> blocked
    UPDATE public.receipt_submissions SET submission_status = 'submitted' WHERE id = v_sub1_id;
    v_res := public.decide_receipt_review(v_sub1_id, v_admin_id, 'resubmission_requested', '다시 찍어주세요', NULL, NULL, NULL, NULL, 't06_rev_1', 't06_hash_1');
    IF NOT (v_res->>'ok')::boolean THEN
      RAISE EXCEPTION 'FAIL [G03.7a]: resubmission_requested decision failed: %', v_res;
    END IF;

    v_res := public.validate_receipt_upload_intent(v_sess_main, v_cust_id, 2048, 'image/png');
    IF NOT (v_res->>'ok')::boolean THEN
      RAISE EXCEPTION 'FAIL [G03.7b]: expected ok=true after resubmission_requested, got %', v_res;
    END IF;

    v_res := public.submit_customer_receipt(v_sess_main, v_cust_id, 'receipts/' || v_cust_id || '/' || v_sess_main || '/2.png', 'image/png', 2048, 'r2.png', 't06_idem_2');
    v_sub2_id := (v_res->'receipt'->>'id')::uuid;

    v_res := public.decide_receipt_review(v_sub2_id, v_admin_id, 'approved', '승인 확인', NULL, NULL, NULL, NULL, 't06_rev_2', 't06_hash_2');
    v_res := public.validate_receipt_upload_intent(v_sess_main, v_cust_id, 1024, 'image/jpeg');
    IF (v_res->>'ok')::boolean OR v_res->>'error_code' <> 'RECEIPT_ALREADY_APPROVED' THEN
      RAISE EXCEPTION 'FAIL [G03.7c]: expected RECEIPT_ALREADY_APPROVED, got %', v_res;
    END IF;

    -- 8) rejected -> permanently blocked with 409 RECEIPT_REJECTED
    v_res := public.submit_customer_receipt(v_sess_rej, v_cust_id, 'receipts/' || v_cust_id || '/' || v_sess_rej || '/1.jpg', 'image/jpeg', 1024, 'rej.jpg', 't06_idem_rej_1');
    v_sub_rej_id := (v_res->'receipt'->>'id')::uuid;
    v_res := public.decide_receipt_review(v_sub_rej_id, v_admin_id, 'rejected', '타 매장 영수증', NULL, NULL, NULL, NULL, 't06_rev_3', 't06_hash_3');

    v_res := public.validate_receipt_upload_intent(v_sess_rej, v_cust_id, 1024, 'image/jpeg');
    IF (v_res->>'ok')::boolean OR v_res->>'error_code' <> 'RECEIPT_REJECTED' OR (v_res->>'status')::integer <> 409 THEN
      RAISE EXCEPTION 'FAIL [G03.8a]: expected 409 RECEIPT_REJECTED, got %', v_res;
    END IF;

    v_res := public.submit_customer_receipt(v_sess_rej, v_cust_id, 'receipts/' || v_cust_id || '/' || v_sess_rej || '/2.jpg', 'image/jpeg', 1024, 'rej2.jpg', 't06_idem_rej_2');
    IF (v_res->>'ok')::boolean OR v_res->>'error_code' <> 'RECEIPT_REJECTED' THEN
      RAISE EXCEPTION 'FAIL [G03.8b]: expected RECEIPT_REJECTED on submit, got %', v_res;
    END IF;

    -- [G04] Duplicate Policy Guard Tests (as merchant JWT)
    PERFORM set_config('request.jwt.claim.sub', v_merch_id::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

    -- 1) Identical 5 conditions -> HM002 POLICY_UNCHANGED, still version 1
    BEGIN
      PERFORM public.create_merchant_restroom_policy(v_rest_id, 'test_deposit', 1000, true, 24, 0);
      RAISE EXCEPTION 'FAIL [G04.1]: expected HM002 for identical policy';
    EXCEPTION WHEN SQLSTATE 'HM002' THEN
      NULL;
    END;

    SELECT count(*) INTO v_cnt FROM public.restroom_access_policies WHERE restroom_id = v_rest_id;
    IF v_cnt <> 1 THEN
      RAISE EXCEPTION 'FAIL [G04.1b]: expected 1 policy version, got %', v_cnt;
    END IF;

    -- 2) Different deposit_amount_krw (2000) -> creates version 2
    v_pol_rec := public.create_merchant_restroom_policy(v_rest_id, 'test_deposit', 2000, true, 24, 0);
    IF v_pol_rec.version <> 2 OR v_pol_rec.deposit_amount_krw <> 2000 OR NOT v_pol_rec.is_active THEN
      RAISE EXCEPTION 'FAIL [G04.2]: expected active version 2 with 2000원, got %', v_pol_rec;
    END IF;

    -- 3) Switch to free -> creates version 3, re-applying free raises HM002
    v_pol_rec := public.create_merchant_restroom_policy(v_rest_id, 'free', 0, false, NULL, 0);
    IF v_pol_rec.version <> 3 OR v_pol_rec.access_mode <> 'free' THEN
      RAISE EXCEPTION 'FAIL [G04.3a]: expected version 3 free, got %', v_pol_rec;
    END IF;

    BEGIN
      PERFORM public.create_merchant_restroom_policy(v_rest_id, 'free', 0, false, NULL, 0);
      RAISE EXCEPTION 'FAIL [G04.3b]: expected HM002 when re-applying free';
    EXCEPTION WHEN SQLSTATE 'HM002' THEN
      NULL;
    END;

    -- 4) Unauthorized customer caller -> 42501
    PERFORM set_config('request.jwt.claim.sub', v_other_id::text, true);
    BEGIN
      PERFORM public.create_merchant_restroom_policy(v_rest_id, 'test_deposit', 1500, true, 24, 0);
      RAISE EXCEPTION 'FAIL [G04.4]: expected 42501 for non-member';
    EXCEPTION WHEN SQLSTATE '42501' THEN
      NULL;
    END;

    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);

    RAISE EXCEPTION 'TASK06_ROLLBACK_OK' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0099' THEN
      NULL;
  END;

  -- [G05] Zero residue verification
  SELECT count(*) INTO v_cnt FROM auth.users
  WHERE id IN (v_cust_id, v_other_id, v_merch_id, v_admin_id);
  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'POSTCHECK_FAIL: synthetic test users remain after rollback (% rows)', v_cnt;
  END IF;

  SELECT count(*) INTO v_cnt FROM public.restrooms WHERE id = v_rest_id;
  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'POSTCHECK_FAIL: synthetic restroom remains after rollback (% rows)', v_cnt;
  END IF;

  RAISE NOTICE 'TASK-06 ALL ROLLBACK VERIFICATION GROUPS PASSED WITH 0 RESIDUE!';
END $$;
