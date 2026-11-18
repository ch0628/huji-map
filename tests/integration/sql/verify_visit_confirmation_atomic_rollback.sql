-- ============================================================================
-- Verification SQL: verify_visit_confirmation_atomic_rollback.sql
-- Purpose: TASK 25 — Atomic visit confirmation RPC & unique constraint rollback verification
-- ============================================================================

DO $$
DECLARE
  v_idx_exists boolean;
  v_secdef boolean;
  v_config text[];
  v_cust_id uuid := 'f2500000-0000-4000-8000-000000000001';
  v_other_id uuid := 'f2500000-0000-4000-8000-000000000002';
  v_merch_id uuid := 'f2500000-0000-4000-8000-000000000003';
  v_biz_id uuid := 'f2500000-0000-4000-8000-000000000010';
  v_rest_id uuid := 'f2500000-0000-4000-8000-000000000020';
  v_pol_id uuid := 'f2500000-0000-4000-8000-000000000030';
  v_sess_ok uuid := 'f2500000-0000-4000-8000-000000000040';
  v_sess_unpaid uuid := 'f2500000-0000-4000-8000-000000000041';
  v_ord_ok uuid := 'f2500000-0000-4000-8000-000000000050';
  v_res1 jsonb;
  v_res2 jsonb;
  v_res3 jsonb;
  v_res_other jsonb;
  v_res_unpaid jsonb;
  v_cnt int;
BEGIN
  -- G01: Verify unique index exists
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'visit_confirmations'
      AND indexname = 'idx_visit_confirmations_uq_session_method_status_reason'
  ) INTO v_idx_exists;

  IF NOT v_idx_exists THEN
    RAISE EXCEPTION 'G01 FAILED: idx_visit_confirmations_uq_session_method_status_reason missing';
  END IF;

  -- G02: Verify RPC security definer & search_path
  SELECT prosecdef, proconfig
  INTO v_secdef, v_config
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'record_customer_visit_confirmation';

  IF v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'G02 FAILED: record_customer_visit_confirmation must be SECURITY DEFINER';
  END IF;

  IF v_config IS NULL OR NOT ('search_path=pg_catalog, pg_temp' = ANY(v_config)) THEN
    RAISE EXCEPTION 'G02 FAILED: search_path must be pg_catalog, pg_temp (got %)', v_config;
  END IF;

  -- G03: Verify EXECUTE privilege isolation
  IF has_function_privilege('anon', 'public.record_customer_visit_confirmation(uuid,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G03 FAILED: anon must not have EXECUTE on record_customer_visit_confirmation';
  END IF;

  IF has_function_privilege('authenticated', 'public.record_customer_visit_confirmation(uuid,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G03 FAILED: authenticated must not have EXECUTE on record_customer_visit_confirmation';
  END IF;

  IF NOT has_function_privilege('service_role', 'public.record_customer_visit_confirmation(uuid,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G03 FAILED: service_role must have EXECUTE on record_customer_visit_confirmation';
  END IF;

  -- G04: Setup isolated fixtures inside subtransaction and force P0099 rollback
  BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
    VALUES
      (v_cust_id, 'f25_cust@test.local', '{"display_name":"고객1"}'::jsonb, now(), now()),
      (v_other_id, 'f25_other@test.local', '{"display_name":"고객2"}'::jsonb, now(), now()),
      (v_merch_id, 'f25_merch@test.local', '{"display_name":"점주"}'::jsonb, now(), now());

    INSERT INTO public.user_roles (user_id, role)
    VALUES (v_merch_id, 'merchant')
    ON CONFLICT DO NOTHING;

    INSERT INTO public.businesses (
      id, name, category, road_address, latitude, longitude,
      registration_status, created_by, approved_by, approved_at
    ) VALUES (
      v_biz_id, '[TEST] 방문확인 제휴카페', '카페', '수원시 팔달구 정조로 1',
      37.28, 127.01, 'approved', v_merch_id, v_merch_id, now()
    );

    INSERT INTO public.restrooms (
      id, business_id, type, name, road_address, latitude, longitude,
      gender_type, access_method, publication_status, created_by, approved_by
    ) VALUES (
      v_rest_id, v_biz_id, 'partner', '[TEST] 방문확인 화장실', '수원시 팔달구 정조로 1',
      37.28, 127.01, 'unisex', 'pin', 'published', v_merch_id, v_merch_id
    );

    INSERT INTO public.restroom_access_policies (
      id, restroom_id, version, access_mode, deposit_amount_krw,
      refund_eligible, receipt_window_hours, min_purchase_krw, is_active, created_by
    ) VALUES (
      v_pol_id, v_rest_id, 1, 'test_deposit', 1000, true, 24, 0, true, v_merch_id
    );

    -- Session 1: authorized with approved order
    INSERT INTO public.access_sessions (
      id, user_id, restroom_id, policy_id, status, access_method_snapshot,
      idempotency_key, expires_at
    ) VALUES (
      v_sess_ok, v_cust_id, v_rest_id, v_pol_id, 'created', 'pin',
      'idem_f25_sess_ok', now() + interval '1 hour'
    );

    INSERT INTO public.payment_orders (
      id, access_session_id, user_id, order_id, provider, payment_mode,
      amount_krw, status, idempotency_key
    ) VALUES (
      v_ord_ok, v_sess_ok, v_cust_id, 'ord_f25_ok', 'toss', 'test',
      1000, 'created', 'idem_f25_ord_ok'
    );

    UPDATE public.payment_orders
    SET status = 'approved', provider_payment_key = 'pk_f25_ok', approved_at = now()
    WHERE id = v_ord_ok;

    UPDATE public.access_sessions
    SET status = 'authorized', authorized_at = now()
    WHERE id = v_sess_ok;

    -- Session 2: unpaid ('created')
    INSERT INTO public.access_sessions (
      id, user_id, restroom_id, policy_id, status, access_method_snapshot,
      idempotency_key, expires_at
    ) VALUES (
      v_sess_unpaid, v_cust_id, v_rest_id, v_pol_id, 'created', 'pin',
      'idem_f25_sess_unpaid', now() + interval '1 hour'
    );

    -- G05: Other customer rejected with 403 FORBIDDEN
    v_res_other := public.record_customer_visit_confirmation(v_sess_ok, v_other_id, 'success', NULL);
    IF (v_res_other->>'ok')::boolean IS DISTINCT FROM false
       OR (v_res_other->>'status')::int IS DISTINCT FROM 403
       OR (v_res_other->>'error_code') IS DISTINCT FROM 'FORBIDDEN' THEN
      RAISE EXCEPTION 'G05 FAILED: Expected 403 FORBIDDEN for other user, got %', v_res_other;
    END IF;

    -- G06: Unpaid session rejected with 422 PAYMENT_REQUIRED
    v_res_unpaid := public.record_customer_visit_confirmation(v_sess_unpaid, v_cust_id, 'success', NULL);
    IF (v_res_unpaid->>'ok')::boolean IS DISTINCT FROM false
       OR (v_res_unpaid->>'status')::int IS DISTINCT FROM 422
       OR (v_res_unpaid->>'error_code') IS DISTINCT FROM 'PAYMENT_REQUIRED' THEN
      RAISE EXCEPTION 'G06 FAILED: Expected 422 PAYMENT_REQUIRED for unpaid session, got %', v_res_unpaid;
    END IF;

    -- G07: First valid submission -> reused = false
    v_res1 := public.record_customer_visit_confirmation(v_sess_ok, v_cust_id, 'success', NULL);
    IF (v_res1->>'ok')::boolean IS DISTINCT FROM true
       OR (v_res1->>'reused')::boolean IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'G07 FAILED: Expected ok=true, reused=false on 1st call, got %', v_res1;
    END IF;

    -- G08: Second identical submission -> reused = true, same confirmation ID, 1 row in table
    v_res2 := public.record_customer_visit_confirmation(v_sess_ok, v_cust_id, 'success', NULL);
    IF (v_res2->>'ok')::boolean IS DISTINCT FROM true
       OR (v_res2->>'reused')::boolean IS DISTINCT FROM true
       OR (v_res2->'confirmation'->>'id') IS DISTINCT FROM (v_res1->'confirmation'->>'id') THEN
      RAISE EXCEPTION 'G08 FAILED: Expected idempotent reuse with same id, got %', v_res2;
    END IF;

    SELECT count(*)::int INTO v_cnt
    FROM public.visit_confirmations
    WHERE access_session_id = v_sess_ok AND usage_status = 'success';

    IF v_cnt <> 1 THEN
      RAISE EXCEPTION 'G08 FAILED: Expected 1 success row, found %', v_cnt;
    END IF;

    -- G09: Distinct status ('failed' with reason) is allowed and recorded separately
    v_res3 := public.record_customer_visit_confirmation(v_sess_ok, v_cust_id, 'failed', '도어락 문 잠김');
    IF (v_res3->>'ok')::boolean IS DISTINCT FROM true
       OR (v_res3->>'reused')::boolean IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'G09 FAILED: Expected ok=true, reused=false for distinct failed status, got %', v_res3;
    END IF;

    RAISE EXCEPTION 'ROLLBACK_OK' USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN
    NULL;
  END;

  -- G10: Verify 0 residual rows after rollback
  SELECT count(*)::int INTO v_cnt
  FROM public.visit_confirmations
  WHERE access_session_id IN (v_sess_ok, v_sess_unpaid);

  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'G10 FAILED: Residual visit_confirmations rows found: %', v_cnt;
  END IF;
END;
$$;

