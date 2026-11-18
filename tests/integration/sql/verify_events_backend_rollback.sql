-- ==============================================================================
-- Verification SQL: verify_events_backend_rollback.sql
-- Description: TASK 17 사용자 행동 이벤트 수집 백엔드 보안 강화 검증
-- 검증 항목:
-- 1. anon/authenticated의 RPC 직접 호출 차단 (service_role 전용)
-- 2. 방문 세션 소유권 검증 (회원 세션 격리, 익명 토큰 검증, 타인 세션 변조 차단)
-- 3. H2 여행 응답의 권위성 (client 위조 차단, server 소스 기록)
-- 4. 멱등성 및 선행 권한 검사 (완전 일치 deduplicated, 상이한 데이터 collision)
-- 5. 개인정보·입력값 검증 (재귀적 PII 차단, 이벤트별 허용 속성 검사, 4KB 제한, page_path 검증)
-- 6. append-only 불변성 및 ON DELETE SET NULL 외래키 익명화 연쇄 정상 동작
-- 7. P0099 강제 롤백 및 잔류 0건 무결성
-- ==============================================================================

DO $$
DECLARE
  v_test_prefix text := 'fa170000-';
  v_admin_id uuid := 'fa170000-0000-0000-0000-000000000001'::uuid;
  v_user_a_id uuid := 'fa170000-0000-0000-0000-000000000002'::uuid;
  v_user_b_id uuid := 'fa170000-0000-0000-0000-000000000003'::uuid;
  v_user_c_id uuid := 'fa170000-0000-0000-0000-000000000004'::uuid;
  v_browser_a_id uuid := 'fa170000-0000-0000-0000-000000000010'::uuid;
  v_browser_b_id uuid := 'fa170000-0000-0000-0000-000000000011'::uuid;
  v_session_a_id uuid := 'fa170000-0000-0000-0000-000000000020'::uuid;
  v_session_anon_id uuid := 'fa170000-0000-0000-0000-000000000021'::uuid;
  v_session_c_id uuid := 'fa170000-0000-0000-0000-000000000022'::uuid;
  v_session_legacy_anon_id uuid := 'fa170000-0000-0000-0000-000000000023'::uuid;
  v_client_event_id_1 uuid := 'fa170000-0000-0000-0000-000000000101'::uuid;
  v_client_event_id_2 uuid := 'fa170000-0000-0000-0000-000000000102'::uuid;
  v_client_event_id_3 uuid := 'fa170000-0000-0000-0000-000000000103'::uuid;
  v_client_event_id_4 uuid := 'fa170000-0000-0000-0000-000000000104'::uuid;
  v_client_event_id_5 uuid := 'fa170000-0000-0000-0000-000000000105'::uuid;
  v_client_event_id_6 uuid := 'fa170000-0000-0000-0000-000000000106'::uuid;
  v_client_event_id_7 uuid := 'fa170000-0000-0000-0000-000000000107'::uuid;

  v_raw_token text := 'test_token_secret_1234567890abcdef';
  v_token_hash text := 'abbff4226baa8c91966a0a984e6298ed3293929ae82f0bca27bc418a7e3c621c';
  v_orig_user text := current_user;

  v_res jsonb;
  v_count integer;
  v_travel_res jsonb;
  v_caught_exception boolean;
BEGIN
  RAISE NOTICE '>>> Starting TASK 17 Security & Data Consistency Verification';

  -- ============================================================================
  -- G00: Precheck conflicts
  -- ============================================================================
  SELECT count(*) INTO v_count
  FROM public.event_logs
  WHERE client_event_id::text LIKE v_test_prefix || '%';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'G00 Failed: Pre-existing test records found in event_logs' USING ERRCODE = '23505';
  END IF;

  -- ============================================================================
  -- G01: Schema check (experiments, event_logs, visitor_sessions columns)
  -- ============================================================================
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'experiments') THEN
    RAISE EXCEPTION 'G01 Failed: public.experiments table does not exist';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'event_logs') THEN
    RAISE EXCEPTION 'G01 Failed: public.event_logs table does not exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'visitor_sessions' AND column_name = 'session_token_hash'
  ) THEN
    RAISE EXCEPTION 'G01 Failed: visitor_sessions.session_token_hash column does not exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'visitor_sessions' AND column_name = 'traveling_now'
  ) THEN
    RAISE EXCEPTION 'G01 Failed: visitor_sessions.traveling_now column does not exist';
  END IF;

  RAISE NOTICE '✓ G01 Passed: Schema and columns verification';

  -- ============================================================================
  -- G02: Test fixtures setup (within transactional block)
  -- ============================================================================
  BEGIN
    -- Insert test users
    INSERT INTO auth.users (id, email) VALUES
      (v_admin_id, 'admin17@hujimap.local'),
      (v_user_a_id, 'user17a@hujimap.local'),
      (v_user_b_id, 'user17b@hujimap.local'),
      (v_user_c_id, 'user17c@hujimap.local')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.profiles (id, display_name, account_status) VALUES
      (v_admin_id, 'Admin 17', 'active'),
      (v_user_a_id, 'User 17A', 'active'),
      (v_user_b_id, 'User 17B', 'active'),
      (v_user_c_id, 'User 17C', 'active')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.user_roles (user_id, role) VALUES
      (v_admin_id, 'admin'),
      (v_user_a_id, 'customer'),
      (v_user_b_id, 'customer'),
      (v_user_c_id, 'customer')
    ON CONFLICT (user_id, role) DO NOTHING;

    -- Insert test visitor sessions:
    -- session_a: 회원 v_user_a_id의 세션
    -- session_anon: 익명 세션 (v_token_hash 등록)
    -- session_c: 외래키 연쇄 삭제 테스트용 v_user_c_id의 세션
    -- session_legacy_anon: 토큰 없는 기존 익명 세션 (수정 거부 테스트용)
    INSERT INTO public.visitor_sessions (id, browser_id, user_id, landing_path, is_test, session_token_hash) VALUES
      (v_session_a_id, v_browser_a_id, v_user_a_id, '/map', false, NULL),
      (v_session_anon_id, v_browser_b_id, NULL, '/map?utm_source=ad', true, v_token_hash),
      (v_session_c_id, v_browser_a_id, v_user_c_id, '/map', false, NULL),
      (v_session_legacy_anon_id, v_browser_b_id, NULL, '/map', true, NULL)
    ON CONFLICT (id) DO NOTHING;

    -- ============================================================================
    -- G03: RPC 권한 격리 검증 (anon/authenticated 직접 호출 차단)
    -- ============================================================================
    -- A. anon 역할 설정 후 log_client_event 호출 -> 42501 차단
    v_caught_exception := false;
    BEGIN
      PERFORM set_config('role', 'anon', true);
      PERFORM set_config('request.jwt.claim.role', 'anon', true);
      PERFORM public.log_client_event(
        p_client_event_id := v_client_event_id_1,
        p_event_name := 'map_loaded'
      );
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        v_caught_exception := true;
    END;
    PERFORM set_config('role', v_orig_user, false);
    PERFORM set_config('request.jwt.claim.role', '', true);

    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G03 Failed: anon direct execution of log_client_event was not blocked';
    END IF;

    -- B. authenticated 역할 설정 후 record_travel_answer 호출 -> 42501 차단
    v_caught_exception := false;
    BEGIN
      PERFORM set_config('role', 'authenticated', true);
      PERFORM set_config('request.jwt.claim.sub', v_user_a_id::text, true);
      PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
      PERFORM public.record_travel_answer(
        p_session_id := v_session_a_id,
        p_traveling_now := true
      );
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        v_caught_exception := true;
    END;
    PERFORM set_config('role', v_orig_user, false);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);

    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G03 Failed: authenticated direct execution of record_travel_answer was not blocked';
    END IF;

    RAISE NOTICE '✓ G03 Passed: Direct client execution of RPCs blocked (service_role required)';

    -- ============================================================================
    -- G04: log_client_event — 소유권 검증 및 세션 정합성
    -- ============================================================================
    -- A. 타인 user_id 세션에 이벤트 삽입 시도 차단 (42501)
    v_caught_exception := false;
    BEGIN
      PERFORM public.log_client_event(
        p_client_event_id := v_client_event_id_1,
        p_event_name := 'map_loaded',
        p_session_id := v_session_a_id,
        p_user_id := v_user_b_id, -- session_a belongs to user_a!
        p_browser_id := v_browser_a_id
      );
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        v_caught_exception := true;
    END;

    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G04 Failed: Logging event with mismatched session user_id was not blocked';
    END IF;

    -- B. 회원 세션에 익명(user_id=null) 이벤트 위장 차단 (42501)
    v_caught_exception := false;
    BEGIN
      PERFORM public.log_client_event(
        p_client_event_id := v_client_event_id_1,
        p_event_name := 'map_loaded',
        p_session_id := v_session_a_id,
        p_user_id := NULL,
        p_browser_id := v_browser_a_id
      );
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        v_caught_exception := true;
    END;

    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G04 Failed: Logging anonymous event to authenticated user session was not blocked';
    END IF;

    -- C. 브라우저 식별자 불일치 차단 (42501)
    v_caught_exception := false;
    BEGIN
      PERFORM public.log_client_event(
        p_client_event_id := v_client_event_id_1,
        p_event_name := 'map_loaded',
        p_session_id := v_session_a_id,
        p_user_id := v_user_a_id,
        p_browser_id := v_browser_b_id -- session_a belongs to browser_a!
      );
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        v_caught_exception := true;
    END;

    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G04 Failed: Logging event with mismatched session browser_id was not blocked';
    END IF;

    RAISE NOTICE '✓ G04 Passed: Session ownership and relation consistency enforcement';

    -- ============================================================================
    -- G05: H2 여행 응답 권위성 및 서버 이벤트 허용 목록 검증
    -- ============================================================================
    -- A. 클라이언트 source='client'로 travel_answer_submitted 발행 시 차단 (42501)
    v_caught_exception := false;
    BEGIN
      PERFORM public.log_client_event(
        p_client_event_id := v_client_event_id_1,
        p_event_name := 'travel_answer_submitted',
        p_source := 'client'
      );
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        v_caught_exception := true;
    END;

    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G05 Failed: Direct client emission of travel_answer_submitted was not blocked';
    END IF;

    -- B. [회귀 검증 6] 미등록 서버 이벤트 차단 (22023)
    v_caught_exception := false;
    BEGIN
      PERFORM public.log_client_event(
        p_client_event_id := v_client_event_id_6,
        p_event_name := 'unregistered_hack_event',
        p_source := 'server'
      );
    EXCEPTION
      WHEN SQLSTATE '22023' THEN
        v_caught_exception := true;
    END;

    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'Regression 6 Failed: Unregistered server event was not blocked';
    END IF;

    -- C. 등록된 서버 이벤트(business_registration_approved)는 정상 기록 성공
    v_res := public.log_client_event(
      p_client_event_id := v_client_event_id_6,
      p_event_name := 'business_registration_approved',
      p_source := 'server'
    );
    IF (v_res->>'deduplicated')::boolean IS NOT FALSE THEN
      RAISE EXCEPTION 'G05 Failed: Expected deduplicated=false on registered server event';
    END IF;

    RAISE NOTICE '✓ G05 Passed: Direct client travel_answer forging blocked & server allowlist enforced';

    -- ============================================================================
    -- G06: 개인정보·속성 검증 (재귀적 PII, 4KB, 이벤트별 허용 속성, page_path, 중첩 배열)
    -- ============================================================================
    -- A. 중첩 JSON 속의 PIN 키 차단 (22023)
    v_caught_exception := false;
    BEGIN
      PERFORM public.log_client_event(
        p_client_event_id := v_client_event_id_5,
        p_event_name := 'map_loaded',
        p_properties := '{"nested": {"inner": {"pin": "1234"}}}'::jsonb
      );
    EXCEPTION
      WHEN SQLSTATE '22023' THEN
        v_caught_exception := true;
    END;

    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G06 Failed: Deeply nested PIN property was not blocked';
    END IF;

    -- B. [회귀 검증 5] 다차원 중첩 배열 속 금지 개인정보 키 차단 (22023)
    -- 배열 안의 배열 속 PIN 차단
    v_caught_exception := false;
    BEGIN
      PERFORM public.log_client_event(
        p_client_event_id := v_client_event_id_5,
        p_event_name := 'map_loaded',
        p_properties := '{"items": [ [ {"pin": "1234"} ] ]}'::jsonb
      );
    EXCEPTION
      WHEN SQLSTATE '22023' THEN
        v_caught_exception := true;
    END;

    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'Regression 5 Failed: Array-in-array with PIN was not blocked';
    END IF;

    -- 3차원 배열 속 전화번호(phone) 차단
    v_caught_exception := false;
    BEGIN
      PERFORM public.log_client_event(
        p_client_event_id := v_client_event_id_5,
        p_event_name := 'map_loaded',
        p_properties := '{"contacts": [ [ [ {"phone": "010-1234-5678"} ] ] ]}'::jsonb
      );
    EXCEPTION
      WHEN SQLSTATE '22023' THEN
        v_caught_exception := true;
    END;

    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'Regression 5 Failed: 3-level array with phone was not blocked';
    END IF;

    -- C. 이벤트 타입별 미허용 속성 차단 (22023)
    -- map_loaded에는 zoom, restroom_count, filter, center_region만 허용
    v_caught_exception := false;
    BEGIN
      PERFORM public.log_client_event(
        p_client_event_id := v_client_event_id_5,
        p_event_name := 'map_loaded',
        p_properties := '{"zoom": 16, "unapproved_custom_field": "injected"}'::jsonb
      );
    EXCEPTION
      WHEN SQLSTATE '22023' THEN
        v_caught_exception := true;
    END;

    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G06 Failed: Unapproved property key for event type was not blocked';
    END IF;

    -- D. page_path 내 민감 쿼리 파라미터 차단 (22023)
    v_caught_exception := false;
    BEGIN
      PERFORM public.log_client_event(
        p_client_event_id := v_client_event_id_5,
        p_event_name := 'landing_view',
        p_page_path := '/map?token=secret_jwt_string'
      );
    EXCEPTION
      WHEN SQLSTATE '22023' THEN
        v_caught_exception := true;
    END;

    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G06 Failed: page_path with token query parameter was not blocked';
    END IF;

    RAISE NOTICE '✓ G06 Passed: Recursive PII (nested arrays), property allowlist & page_path validation';

    -- ============================================================================
    -- G07: 정상 이벤트 수집 및 멱등성 검증 (전 컬럼 완전일치 vs 충돌 거부)
    -- ============================================================================
    -- 정상 삽입
    v_res := public.log_client_event(
      p_client_event_id := v_client_event_id_1,
      p_event_name := 'map_loaded',
      p_session_id := v_session_a_id,
      p_user_id := v_user_a_id,
      p_browser_id := v_browser_a_id,
      p_properties := '{"zoom": 16}'::jsonb,
      p_source := 'client'
    );

    IF (v_res->>'deduplicated')::boolean IS NOT FALSE THEN
      RAISE EXCEPTION 'G07 Failed: Expected deduplicated=false on first insert';
    END IF;

    -- 동일 ID 완전 동일 데이터 재호출 -> 멱등 성공 (deduplicated=true)
    v_res := public.log_client_event(
      p_client_event_id := v_client_event_id_1,
      p_event_name := 'map_loaded',
      p_session_id := v_session_a_id,
      p_user_id := v_user_a_id,
      p_browser_id := v_browser_a_id,
      p_properties := '{"zoom": 16}'::jsonb,
      p_source := 'client'
    );

    IF (v_res->>'deduplicated')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'G07 Failed: Expected deduplicated=true on duplicate insert';
    END IF;

    -- [회귀 검증 3] 동일 이벤트 ID에 다른 properties 전송 시 -> 23505 충돌 거부
    v_caught_exception := false;
    BEGIN
      PERFORM public.log_client_event(
        p_client_event_id := v_client_event_id_1,
        p_event_name := 'map_loaded',
        p_session_id := v_session_a_id,
        p_user_id := v_user_a_id,
        p_browser_id := v_browser_a_id,
        p_properties := '{"zoom": 17}'::jsonb, -- differing properties!
        p_source := 'client'
      );
    EXCEPTION
      WHEN SQLSTATE '23505' THEN
        v_caught_exception := true;
    END;

    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'Regression 3 Failed: Same client_event_id with differing properties did not throw 23505';
    END IF;

    -- 동일 ID에 다른 이벤트명 전송 시 -> 23505 충돌 거부
    v_caught_exception := false;
    BEGIN
      PERFORM public.log_client_event(
        p_client_event_id := v_client_event_id_1,
        p_event_name := 'landing_view', -- different event name!
        p_source := 'client'
      );
    EXCEPTION
      WHEN SQLSTATE '23505' THEN
        v_caught_exception := true;
    END;

    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G07 Failed: Differing event_name with same client_event_id was not rejected';
    END IF;

    RAISE NOTICE '✓ G07 Passed: Normal ingestion, exact duplicate deduplication & differing properties 23505 collision';

    -- ============================================================================
    -- G08: record_travel_answer — 소유권 검증, 잠금, 멱등성 및 권위적 서버 이벤트
    -- ============================================================================
    -- A. 타인 회원 세션에 여행 응답 시도 차단 (42501)
    v_caught_exception := false;
    BEGIN
      PERFORM public.record_travel_answer(
        p_session_id := v_session_a_id,
        p_traveling_now := true,
        p_user_id := v_user_b_id -- session_a belongs to user_a!
      );
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        v_caught_exception := true;
    END;

    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G08 Failed: Modifying other user travel answer was not blocked';
    END IF;

    -- B. [회귀 검증 1] 토큰 없는 기존 익명 세션의 여행 응답 수정 차단 (42501)
    v_caught_exception := false;
    BEGIN
      PERFORM public.record_travel_answer(
        p_session_id := v_session_legacy_anon_id,
        p_traveling_now := true,
        p_browser_id := v_browser_b_id,
        p_session_token_hash := v_token_hash
      );
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        v_caught_exception := true;
    END;

    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'Regression 1 Failed: Modifying legacy anonymous session without token was not blocked';
    END IF;

    -- C. [회귀 검증 2] browser_id 누락 시 익명 세션 접근 차단 (42501)
    v_caught_exception := false;
    BEGIN
      PERFORM public.record_travel_answer(
        p_session_id := v_session_anon_id,
        p_traveling_now := true,
        p_browser_id := NULL, -- missing browser_id
        p_session_token_hash := v_token_hash
      );
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        v_caught_exception := true;
    END;

    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'Regression 2 Failed: Anonymous travel answer with missing browser_id was not blocked';
    END IF;

    -- D. 익명 세션 토큰 해시 불일치 차단 (42501)
    v_caught_exception := false;
    BEGIN
      PERFORM public.record_travel_answer(
        p_session_id := v_session_anon_id,
        p_traveling_now := true,
        p_browser_id := v_browser_b_id,
        p_session_token_hash := 'wrong_invalid_token_hash'
      );
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        v_caught_exception := true;
    END;

    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G08 Failed: Invalid session token hash on anonymous session was not blocked';
    END IF;

    -- E. 정상 소유권 증명 하에 익명 세션 여행 응답 성공
    v_travel_res := public.record_travel_answer(
      p_session_id := v_session_anon_id,
      p_traveling_now := true,
      p_browser_id := v_browser_b_id,
      p_session_token_hash := v_token_hash,
      p_client_event_id := v_client_event_id_2
    );

    IF (v_travel_res->>'traveling_now')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'G08 Failed: record_travel_answer returned traveling_now != true';
    END IF;

    -- 권위적 서버 이벤트(source='server') 확인
    SELECT count(*) INTO v_count
    FROM public.event_logs
    WHERE client_event_id = v_client_event_id_2
      AND event_name = 'travel_answer_submitted'
      AND source = 'server'
      AND is_test = true;

    IF v_count <> 1 THEN
      RAISE EXCEPTION 'G08 Failed: Authoritative server event travel_answer_submitted was not recorded';
    END IF;

    -- F. 동일 여행 응답 재호출 -> 멱등 성공 (deduplicated=true)
    v_travel_res := public.record_travel_answer(
      p_session_id := v_session_anon_id,
      p_traveling_now := true,
      p_browser_id := v_browser_b_id,
      p_session_token_hash := v_token_hash
    );

    IF (v_travel_res->>'deduplicated')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'G08 Failed: Expected deduplicated=true on duplicate travel answer';
    END IF;

    -- G. [회귀 검증 4] 같은 세션에 다른 이벤트 ID로 여행 응답 시 한 건만 기록 (deduplicated=true)
    v_travel_res := public.record_travel_answer(
      p_session_id := v_session_anon_id,
      p_traveling_now := true,
      p_browser_id := v_browser_b_id,
      p_session_token_hash := v_token_hash,
      p_client_event_id := v_client_event_id_4 -- different event ID!
    );

    IF (v_travel_res->>'deduplicated')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'Regression 4 Failed: Expected deduplicated=true when session already answered';
    END IF;

    SELECT count(*) INTO v_count
    FROM public.event_logs
    WHERE client_event_id = v_client_event_id_4;

    IF v_count <> 0 THEN
      RAISE EXCEPTION 'Regression 4 Failed: Secondary event was inserted for already answered session';
    END IF;

    SELECT count(*) INTO v_count
    FROM public.event_logs
    WHERE session_id = v_session_anon_id AND event_name = 'travel_answer_submitted';

    IF v_count <> 1 THEN
      RAISE EXCEPTION 'Regression 4 Failed: Expected exactly 1 travel_answer_submitted event, found %', v_count;
    END IF;

    RAISE NOTICE '✓ G08 Passed: record_travel_answer ownership enforcement, token requirement & single event guarantee';

    -- ============================================================================
    -- G09: Append-Only 불변성 및 ON DELETE SET NULL 외래키 연쇄 익명화 검증
    -- ============================================================================
    -- A. 직접 UPDATE 변조 시도 차단 (42501)
    v_caught_exception := false;
    BEGIN
      UPDATE public.event_logs
      SET event_name = 'hacked'
      WHERE client_event_id = v_client_event_id_1;
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        v_caught_exception := true;
    END;

    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G09 Failed: Direct UPDATE on event_logs was not blocked';
    END IF;

    -- B. [회귀 검증 7] append-only 누락 컬럼(browser_id, experiment_key, page_path, component_id) 변경 차단
    -- 1) browser_id 변경 차단
    v_caught_exception := false;
    BEGIN
      UPDATE public.event_logs
      SET browser_id = 'fa170000-0000-0000-0000-000000000099'::uuid
      WHERE client_event_id = v_client_event_id_1;
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        v_caught_exception := true;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'Regression 7 Failed: Modifying browser_id was not blocked';
    END IF;

    -- 2) experiment_key 변경 차단
    v_caught_exception := false;
    BEGIN
      UPDATE public.event_logs
      SET experiment_key = 'hacked_key'
      WHERE client_event_id = v_client_event_id_1;
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        v_caught_exception := true;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'Regression 7 Failed: Modifying experiment_key was not blocked';
    END IF;

    -- 3) page_path 변경 차단
    v_caught_exception := false;
    BEGIN
      UPDATE public.event_logs
      SET page_path = '/hacked_path'
      WHERE client_event_id = v_client_event_id_1;
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        v_caught_exception := true;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'Regression 7 Failed: Modifying page_path was not blocked';
    END IF;

    -- 4) component_id 변경 차단
    v_caught_exception := false;
    BEGIN
      UPDATE public.event_logs
      SET component_id = 'hacked_comp'
      WHERE client_event_id = v_client_event_id_1;
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        v_caught_exception := true;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'Regression 7 Failed: Modifying component_id was not blocked';
    END IF;

    -- C. 직접 DELETE 시도 차단 (42501)
    v_caught_exception := false;
    BEGIN
      DELETE FROM public.event_logs
      WHERE client_event_id = v_client_event_id_1;
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        v_caught_exception := true;
    END;

    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'G09 Failed: Direct DELETE on event_logs was not blocked';
    END IF;

    -- D. [회귀 검증 8] 외래키 연쇄 익명화 검증:
    -- v_user_c_id에 대한 이벤트를 기록한 후, profiles에서 v_user_c_id를 삭제했을 때
    -- event_logs.user_id가 NULL로 안전하게 변경되고 42501 오류가 발생하지 않는지 검증
    PERFORM public.log_client_event(
      p_client_event_id := v_client_event_id_3,
      p_event_name := 'map_loaded',
      p_session_id := v_session_c_id,
      p_user_id := v_user_c_id,
      p_browser_id := v_browser_a_id,
      p_properties := '{"zoom": 15}'::jsonb
    );

    -- profiles에서 v_user_c_id 삭제 -> ON DELETE SET NULL 트리거 연쇄 동작
    DELETE FROM public.profiles WHERE id = v_user_c_id;

    -- event_logs의 user_id가 NULL로 익명화되었는지 확인
    SELECT user_id INTO v_admin_id -- reuse var for checking null
    FROM public.event_logs
    WHERE client_event_id = v_client_event_id_3;

    IF v_admin_id IS NOT NULL THEN
      RAISE EXCEPTION 'Regression 8 Failed: user_id was not set to NULL upon profile deletion';
    END IF;

    -- 외래키를 다른 비NULL UUID로 임의 변조하려는 시도는 42501 차단
    v_caught_exception := false;
    BEGIN
      UPDATE public.event_logs
      SET user_id = v_user_a_id
      WHERE client_event_id = v_client_event_id_3;
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        v_caught_exception := true;
    END;
    IF NOT v_caught_exception THEN
      RAISE EXCEPTION 'Regression 8 Failed: Mutating NULL user_id to new user was not blocked';
    END IF;

    RAISE NOTICE '✓ G09 Passed: Append-only immutability (all telemetry columns) & ON DELETE SET NULL cascade anonymization';

    -- 의도적 P0099 강제 롤백
    RAISE EXCEPTION 'P0099: Intentional rollback for cleanup' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0099' THEN
      RAISE NOTICE 'P0099 caught: Test subtransaction rolled back cleanly';
  END;

  -- ============================================================================
  -- G10: 롤백 후 잔류 레코드 0건 검증
  -- ============================================================================
  SELECT count(*) INTO v_count
  FROM public.event_logs
  WHERE client_event_id::text LIKE v_test_prefix || '%';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'G10 Failed: Residual event_logs found (% rows)', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.visitor_sessions
  WHERE id::text LIKE v_test_prefix || '%';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'G10 Failed: Residual visitor_sessions found (% rows)', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM auth.users
  WHERE id::text LIKE v_test_prefix || '%';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'G10 Failed: Residual auth.users found (% rows)', v_count;
  END IF;

  RAISE NOTICE '✓ G10 Passed: Zero residual test rows verified';
  RAISE NOTICE '>>> ALL TASK 17 SECURITY & CONSISTENCY VERIFICATIONS PASSED!';
END $$;
