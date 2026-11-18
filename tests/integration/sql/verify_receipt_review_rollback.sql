-- ============================================================================
-- Verification SQL: verify_receipt_review_rollback.sql
-- Purpose: TASK 28 — Administrator Manual Review RPC, Privilege Hardening,
--          Legacy 8-Param Overload Removal, Spoofing Prevention, Idempotency,
--          Immutability, and Atomic Audit Logging Verification
-- ============================================================================

DO $$
DECLARE
  v_secdef boolean;
  v_config text[];
  v_fn_cnt int;
  v_admin_id uuid := 'fa280000-0000-4000-a000-000000000001';
  v_cust_id uuid := 'fa280000-0000-4000-a000-000000000002';
  v_merch_id uuid := 'fa280000-0000-4000-a000-000000000003';
  v_biz_id uuid := 'fa280000-0000-4000-b000-000000000001';
  v_rest_id uuid := 'fa280000-0000-4000-b000-000000000002';
  v_pol_id uuid := 'fa280000-0000-4000-b000-000000000003';
  v_sess1_id uuid := 'fa280000-0000-4000-c000-000000000001';
  v_sess2_id uuid := 'fa280000-0000-4000-c000-000000000002';
  v_ord1_id uuid := 'fa280000-0000-4000-c000-000000000011';
  v_ord2_id uuid := 'fa280000-0000-4000-c000-000000000012';
  v_sub1_id uuid := 'fa280000-0000-4000-d000-000000000001';
  v_sub2_id uuid := 'fa280000-0000-4000-d000-000000000002';
  v_res_appr jsonb;
  v_res_rej jsonb;
  v_sub_row record;
  v_audit_cnt int;
  v_audit_log_cnt int;
  v_refund_cnt int;
  v_caught boolean;
  v_cnt int;
BEGIN
  -- G01: Verify legacy 8-parameter overload is removed and only 10-parameter decide_receipt_review exists
  IF to_regprocedure('public.decide_receipt_review(uuid,uuid,text,text,text,timestamptz,integer,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'G01 FAILED: legacy 8-parameter decide_receipt_review overload must be dropped';
  END IF;

  SELECT COUNT(*) INTO v_fn_cnt
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'decide_receipt_review';

  IF v_fn_cnt <> 1 THEN
    RAISE EXCEPTION 'G01 FAILED: expected exactly 1 decide_receipt_review function (10-param), found %', v_fn_cnt;
  END IF;

  SELECT prosecdef, proconfig
  INTO v_secdef, v_config
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'decide_receipt_review'
    AND p.pronargs = 10;

  IF v_secdef IS NOT TRUE OR NOT ('search_path=pg_catalog, pg_temp' = ANY(v_config)) THEN
    RAISE EXCEPTION 'G01 FAILED: decide_receipt_review must be SECURITY DEFINER with search_path=pg_catalog, pg_temp';
  END IF;

  -- Verify columns idempotency_key and payload_hash exist on receipt_review_audits
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'receipt_review_audits' AND column_name = 'idempotency_key'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'receipt_review_audits' AND column_name = 'payload_hash'
  ) THEN
    RAISE EXCEPTION 'G01 FAILED: receipt_review_audits missing idempotency_key or payload_hash column';
  END IF;

  -- G02: Verify EXECUTE privilege isolation: PUBLIC, anon, and authenticated must be revoked; service_role granted
  IF has_function_privilege('public', 'public.decide_receipt_review(uuid,uuid,text,text,text,timestamptz,integer,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G02 FAILED: PUBLIC must not have EXECUTE privilege on decide_receipt_review';
  END IF;

  IF has_function_privilege('anon', 'public.decide_receipt_review(uuid,uuid,text,text,text,timestamptz,integer,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G02 FAILED: anon must not have EXECUTE privilege on decide_receipt_review';
  END IF;

  IF has_function_privilege('authenticated', 'public.decide_receipt_review(uuid,uuid,text,text,text,timestamptz,integer,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G02 FAILED: authenticated must not have EXECUTE privilege on decide_receipt_review';
  END IF;

  IF NOT has_function_privilege('service_role', 'public.decide_receipt_review(uuid,uuid,text,text,text,timestamptz,integer,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G02 FAILED: service_role must have EXECUTE privilege on decide_receipt_review';
  END IF;

  -- G03: Run subtransaction tests
  BEGIN
    -- Setup test users
    INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
    VALUES
      (v_admin_id, 'fa28_admin@test.local', '{"display_name":"관리자"}'::jsonb, now(), now()),
      (v_cust_id, 'fa28_cust@test.local', '{"display_name":"고객"}'::jsonb, now(), now()),
      (v_merch_id, 'fa28_merch@test.local', '{"display_name":"점주"}'::jsonb, now(), now());

    INSERT INTO public.user_roles (user_id, role)
    VALUES
      (v_admin_id, 'admin'),
      (v_merch_id, 'merchant')
    ON CONFLICT DO NOTHING;

    -- Setup partner business and restroom
    INSERT INTO public.businesses (
      id, name, category, road_address, latitude, longitude,
      registration_status, created_by, approved_at
    ) VALUES (
      v_biz_id, 'DEMO-TASK28카페', '카페', '경기 수원시 팔달구 매산로 10',
      37.2661, 127.0011, 'approved', v_merch_id, now()
    );

    INSERT INTO public.business_members (business_id, user_id, role, membership_status)
    VALUES (v_biz_id, v_merch_id, 'owner', 'active');

    INSERT INTO public.restrooms (
      id, business_id, name, type, access_method,
      road_address, latitude, longitude, publication_status
    ) VALUES (
      v_rest_id, v_biz_id, 'DEMO-TASK28화장실', 'partner', 'pin',
      '경기 수원시 팔달구 매산로 10', 37.2661, 127.0011, 'published'
    );

    INSERT INTO public.restroom_access_policies (
      id, restroom_id, version, access_mode, deposit_amount_krw,
      refund_eligible, receipt_window_hours, is_active, effective_from, created_by
    ) VALUES (
      v_pol_id, v_rest_id, 1, 'test_deposit', 1000,
      true, 24, true, now() - interval '2 hours', v_merch_id
    );

    -- Setup Access Sessions & Approved Payment Orders
    INSERT INTO public.access_sessions (
      id, user_id, restroom_id, policy_id, status, access_method_snapshot,
      idempotency_key, expires_at
    ) VALUES
      (v_sess1_id, v_cust_id, v_rest_id, v_pol_id, 'created', 'pin', 'fa28_idem_s1', now() + interval '1 hour'),
      (v_sess2_id, v_cust_id, v_rest_id, v_pol_id, 'created', 'pin', 'fa28_idem_s2', now() + interval '1 hour');

    INSERT INTO public.payment_orders (
      id, access_session_id, user_id, order_id, provider, payment_mode,
      amount_krw, status, idempotency_key
    ) VALUES
      (v_ord1_id, v_sess1_id, v_cust_id, 'hm_ord_fa28_1', 'toss', 'test', 1000, 'created', 'fa28_ord_idem1'),
      (v_ord2_id, v_sess2_id, v_cust_id, 'hm_ord_fa28_2', 'toss', 'test', 1000, 'created', 'fa28_ord_idem2');

    UPDATE public.payment_orders
    SET status = 'approved', provider_payment_key = 'pk_fa28_1', approved_at = now() - interval '1 hour'
    WHERE id = v_ord1_id;

    UPDATE public.payment_orders
    SET status = 'approved', provider_payment_key = 'pk_fa28_2', approved_at = now() - interval '1 hour'
    WHERE id = v_ord2_id;

    UPDATE public.access_sessions
    SET status = 'authorized', authorized_at = now() - interval '1 hour'
    WHERE id = v_sess1_id;

    UPDATE public.access_sessions
    SET status = 'authorized', authorized_at = now() - interval '1 hour'
    WHERE id = v_sess2_id;

    -- Insert Initial Receipt Submissions
    INSERT INTO public.receipt_submissions (
      id, access_session_id, user_id, storage_path, mime_type, file_size_bytes,
      original_filename, client_submission_id, submission_status
    ) VALUES
      (v_sub1_id, v_sess1_id, v_cust_id, 'receipts/' || v_cust_id::text || '/' || v_sess1_id::text || '/sub1.jpg', 'image/jpeg', 102400, 'sub1.jpg', 'client_fa28_sub1', 'submitted'),
      (v_sub2_id, v_sess2_id, v_cust_id, 'receipts/' || v_cust_id::text || '/' || v_sess2_id::text || '/sub2.jpg', 'image/jpeg', 102400, 'sub2.jpg', 'client_fa28_sub2', 'submitted');

    -- Test 1-A: Direct RPC execution by 'anon' and 'authenticated' roles must fail with 42501
    v_caught := false;
    BEGIN
      SET LOCAL ROLE anon;
      PERFORM public.decide_receipt_review(
        v_sub1_id, v_admin_id, 'approved', '익명 직접 호출 시도', NULL, NULL, NULL, NULL, NULL, NULL
      );
      RESET ROLE;
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        RESET ROLE;
        v_caught := true;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'Test 1-A FAILED: anon direct RPC execution must be blocked with 42501';
    END IF;

    v_caught := false;
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM public.decide_receipt_review(
        v_sub1_id, v_admin_id, 'approved', '인증 사용자 직접 호출 시도', NULL, NULL, NULL, NULL, NULL, NULL
      );
      RESET ROLE;
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        RESET ROLE;
        v_caught := true;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'Test 1-A FAILED: authenticated direct RPC execution must be blocked with 42501';
    END IF;

    -- Test 1-B: Non-admin user ID or spoofed admin ID with customer JWT claim must fail with 42501
    v_caught := false;
    BEGIN
      PERFORM public.decide_receipt_review(
        v_sub1_id,
        v_cust_id, -- customer trying to self-approve
        'approved',
        '고객 자가 승인 시도',
        NULL, NULL, NULL, NULL, NULL, NULL
      );
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        v_caught := true;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'Test 1-B FAILED: non-admin review decision must be blocked with 42501';
    END IF;

    v_caught := false;
    BEGIN
      PERFORM set_config('request.jwt.claim.sub', v_cust_id::text, true);
      PERFORM public.decide_receipt_review(
        v_sub1_id,
        v_admin_id, -- spoofing admin_id while JWT sub is v_cust_id
        'approved',
        '관리자 ID 위조 승인 시도',
        NULL, NULL, NULL, NULL, NULL, NULL
      );
      PERFORM set_config('request.jwt.claim.sub', '', true);
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        PERFORM set_config('request.jwt.claim.sub', '', true);
        v_caught := true;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'Test 1-B FAILED: spoofed admin ID with customer JWT claim must be blocked with 42501';
    END IF;

    -- Test 1-C: Legacy 8-parameter function call must fail with 42883 (undefined_function)
    v_caught := false;
    BEGIN
      EXECUTE 'SELECT public.decide_receipt_review($1, $2, $3, $4, $5, $6, $7, $8)'
        USING v_sub1_id, v_admin_id, 'approved', '레거시 8인자 호출 시도', 'DEMO-TASK28카페', now(), 5000, 'REF-LEGACY';
    EXCEPTION
      WHEN SQLSTATE '42883' THEN
        v_caught := true;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'Test 1-C FAILED: 8-parameter decide_receipt_review call must fail with 42883';
    END IF;

    -- Test 2: Missing reason (< 2 chars) must fail with 22023
    v_caught := false;
    BEGIN
      PERFORM public.decide_receipt_review(
        v_sub1_id,
        v_admin_id,
        'approved',
        ' ', -- empty reason
        NULL, NULL, NULL, NULL, NULL, NULL
      );
    EXCEPTION
      WHEN SQLSTATE '22023' THEN
        v_caught := true;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'Test 2 FAILED: empty reason must be blocked with 22023';
    END IF;

    -- Test 3: Invalid decision enum must fail with 22023
    v_caught := false;
    BEGIN
      PERFORM public.decide_receipt_review(
        v_sub1_id,
        v_admin_id,
        'invalid_status',
        '사유는 정상이나 결정이 이상함',
        NULL, NULL, NULL, NULL, NULL, NULL
      );
    EXCEPTION
      WHEN SQLSTATE '22023' THEN
        v_caught := true;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'Test 3 FAILED: invalid decision must be blocked with 22023';
    END IF;

    -- Test 4: Normal Approval of Submission 1 via service_role with Idempotency Key
    SET LOCAL ROLE service_role;
    v_res_appr := public.decide_receipt_review(
      v_sub1_id,
      v_admin_id,
      'approved',
      '영수증 상호 및 결제금액 5000원 정상 확인',
      'DEMO-TASK28카페',
      now() - interval '40 minutes',
      5000,
      'REF-REC-001',
      'fa28_test_key_1',
      'hash_fa28_test_1'
    );
    RESET ROLE;

    IF (v_res_appr->>'ok')::boolean IS NOT TRUE OR (v_res_appr->>'reused')::boolean IS NOT FALSE THEN
      RAISE EXCEPTION 'Test 4 FAILED: admin approval initial call failed: %', v_res_appr;
    END IF;

    -- Verify submission status is approved and confirmations are recorded
    SELECT * INTO v_sub_row FROM public.receipt_submissions WHERE id = v_sub1_id;
    IF v_sub_row.submission_status <> 'approved' OR
       v_sub_row.reviewed_by <> v_admin_id OR
       v_sub_row.store_name_confirmed <> 'DEMO-TASK28카페' OR
       v_sub_row.purchase_amount_krw <> 5000 OR
       v_sub_row.receipt_reference <> 'REF-REC-001' THEN
      RAISE EXCEPTION 'Test 4 FAILED: receipt_submissions state incorrect after approval: %', row_to_json(v_sub_row);
    END IF;

    -- Verify receipt_review_audits has record
    SELECT COUNT(*) INTO v_audit_cnt
    FROM public.receipt_review_audits
    WHERE submission_id = v_sub1_id AND decision = 'approved';
    IF v_audit_cnt <> 1 THEN
      RAISE EXCEPTION 'Test 4 FAILED: receipt_review_audits entry missing for approved receipt';
    END IF;

    -- Verify audit_logs has record
    SELECT COUNT(*) INTO v_audit_log_cnt
    FROM public.audit_logs
    WHERE entity_type = 'receipt_submissions' AND entity_id = v_sub1_id AND action = 'receipt_review_approved';
    IF v_audit_log_cnt <> 1 THEN
      RAISE EXCEPTION 'Test 4 FAILED: audit_logs entry missing for approved receipt';
    END IF;

    -- Test 4-A: Idempotent Replay with same key and same hash must return reused=true without duplicate audit
    DECLARE
      v_res_replay jsonb;
    BEGIN
      SET LOCAL ROLE service_role;
      v_res_replay := public.decide_receipt_review(
        v_sub1_id,
        v_admin_id,
        'approved',
        '영수증 상호 및 결제금액 5000원 정상 확인',
        'DEMO-TASK28카페',
        now() - interval '40 minutes',
        5000,
        'REF-REC-001',
        'fa28_test_key_1',
        'hash_fa28_test_1'
      );
      RESET ROLE;

      IF (v_res_replay->>'ok')::boolean IS NOT TRUE OR (v_res_replay->>'reused')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Test 4-A FAILED: replay must succeed with reused: true: %', v_res_replay;
      END IF;
    END;

    -- Verify receipt_review_audits still has EXACTLY 1 record after replay!
    SELECT COUNT(*) INTO v_audit_cnt
    FROM public.receipt_review_audits
    WHERE submission_id = v_sub1_id AND decision = 'approved';
    IF v_audit_cnt <> 1 THEN
      RAISE EXCEPTION 'Test 4-A FAILED: receipt_review_audits must have exactly 1 record after replay, found %', v_audit_cnt;
    END IF;

    -- Test 4-B: Replay with same idempotency key but DIFFERENT payload hash (or NULL hash) must fail with 23505 (HM094)
    v_caught := false;
    BEGIN
      PERFORM public.decide_receipt_review(
        v_sub1_id,
        v_admin_id,
        'approved',
        '다른 사유로 요청 본문이 달라짐',
        'DEMO-TASK28카페',
        now() - interval '40 minutes',
        5000,
        'REF-REC-001',
        'fa28_test_key_1',
        'hash_DIFFERENT_PAYLOAD'
      );
    EXCEPTION
      WHEN SQLSTATE '23505' THEN
        v_caught := true;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'Test 4-B FAILED: different payload with same idempotency key must fail with 23505';
    END IF;

    v_caught := false;
    BEGIN
      PERFORM public.decide_receipt_review(
        v_sub1_id,
        v_admin_id,
        'approved',
        '영수증 상호 및 결제금액 5000원 정상 확인',
        'DEMO-TASK28카페',
        now() - interval '40 minutes',
        5000,
        'REF-REC-001',
        'fa28_test_key_1',
        NULL -- attempting to bypass hash verification by passing NULL
      );
    EXCEPTION
      WHEN SQLSTATE '23505' THEN
        v_caught := true;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'Test 4-B FAILED: NULL payload hash replay against hashed record must fail with 23505';
    END IF;

    -- Test 5: Re-decision on already approved receipt must be rejected with HM002
    v_caught := false;
    BEGIN
      PERFORM public.decide_receipt_review(
        v_sub1_id,
        v_admin_id,
        'approved',
        '중복 승인 재시도',
        NULL, NULL, NULL, NULL, NULL, NULL
      );
    EXCEPTION
      WHEN SQLSTATE 'HM002' THEN
        v_caught := true;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'Test 5 FAILED: duplicate approval must be rejected with HM002';
    END IF;

    -- Test 6: Normal Rejection of Submission 2
    v_res_rej := public.decide_receipt_review(
      v_sub2_id,
      v_admin_id,
      'rejected',
      '제휴 매장이 아닌 타 매장 영수증이 첨부되었습니다.',
      NULL, NULL, NULL, NULL, 'fa28_test_key_2', 'hash_fa28_test_2'
    );

    IF (v_res_rej->>'ok')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'Test 6 FAILED: admin rejection failed: %', v_res_rej;
    END IF;

    SELECT * INTO v_sub_row FROM public.receipt_submissions WHERE id = v_sub2_id;
    IF v_sub_row.submission_status <> 'rejected' OR v_sub_row.reviewed_by <> v_admin_id THEN
      RAISE EXCEPTION 'Test 6 FAILED: receipt_submissions state incorrect after rejection: %', row_to_json(v_sub_row);
    END IF;

    -- Test 7: Re-decision on already rejected receipt must be rejected with HM006
    v_caught := false;
    BEGIN
      PERFORM public.decide_receipt_review(
        v_sub2_id,
        v_admin_id,
        'approved',
        '반려된 건 재승인 시도',
        NULL, NULL, NULL, NULL, NULL, NULL
      );
    EXCEPTION
      WHEN SQLSTATE 'HM006' THEN
        v_caught := true;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'Test 7 FAILED: modifying already rejected receipt must be rejected with HM006';
    END IF;

    -- Test 8: Immutability of receipt_review_audits: UPDATE must fail with 42501
    v_caught := false;
    BEGIN
      UPDATE public.receipt_review_audits
      SET reason = '위조된 감사 사유'
      WHERE submission_id = v_sub1_id;
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        v_caught := true;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'Test 8 FAILED: direct UPDATE on receipt_review_audits must be blocked by trigger with 42501';
    END IF;

    -- Test 9: Immutability of receipt_review_audits: DELETE must fail with 42501
    v_caught := false;
    BEGIN
      DELETE FROM public.receipt_review_audits
      WHERE submission_id = v_sub1_id;
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        v_caught := true;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'Test 9 FAILED: direct DELETE on receipt_review_audits must be blocked by trigger with 42501';
    END IF;

    -- Test 10: Invariant check: No automatic refund or payment_orders mutation occurred
    SELECT COUNT(*) INTO v_refund_cnt
    FROM public.payment_refunds
    WHERE payment_order_id IN (v_ord1_id, v_ord2_id);
    IF v_refund_cnt > 0 THEN
      RAISE EXCEPTION 'Test 10 FAILED: payment_refunds must NOT be automatically generated on receipt approval';
    END IF;

    SELECT COUNT(*) INTO v_cnt
    FROM public.payment_orders
    WHERE id = v_ord1_id AND status = 'approved';
    IF v_cnt <> 1 THEN
      RAISE EXCEPTION 'Test 10 FAILED: payment_orders status must remain approved and unmodified';
    END IF;

    -- Force P0099 rollback to keep DB clean
    RAISE EXCEPTION 'FORCE_ROLLBACK_TASK28' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0099' THEN
      NULL; -- Caught successfully
  END;

  -- G10: Verify 0 residual test records in receipt_submissions
  SELECT COUNT(*) INTO v_cnt
  FROM public.receipt_submissions
  WHERE id IN (v_sub1_id, v_sub2_id);

  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'G10 FAILED: residual test rows found in receipt_submissions (cnt=%)', v_cnt;
  END IF;

  RAISE NOTICE 'TASK 28 ALL SQL, RPC HARDENING & AUDIT VERIFICATIONS COMPLETED SUCCESSFULLY!';
END $$;
