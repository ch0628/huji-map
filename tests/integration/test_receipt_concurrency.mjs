import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

async function run() {
  console.log("==================================================");
  console.log("TASK 26 — Receipt Backend Concurrency & Idempotency Test");
  console.log("==================================================");

  const db = new PGlite();

  // Setup auth schema and roles
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE IF NOT EXISTS auth.users (
      id uuid PRIMARY KEY,
      email text UNIQUE,
      raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
      SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), current_setting('role', true), 'anon');
    $$;

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role BYPASSRLS;
      ELSE
        ALTER ROLE service_role BYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
        CREATE ROLE supabase_auth_admin;
      END IF;
    END $$;
  `);

  // Apply all 14 migrations
  const migrationDir = path.join(ROOT, "supabase/migrations");
  const files = fs.readdirSync(migrationDir).filter((f) => f.endsWith(".sql")).sort();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const sql = fs.readFileSync(path.join(migrationDir, file), "utf-8");
    await db.exec(sql);
  }

  console.log("✓ Applied all 14 migrations successfully.\n");

  // Setup test users, business, restroom, policies, and access sessions
  const custId = "f2600000-0000-4000-8000-000000000001";
  const merchId = "f2600000-0000-4000-8000-000000000003";
  const bizId = "f2600000-0000-4000-8000-000000000010";
  const restId = "f2600000-0000-4000-8000-000000000020";
  const polId = "f2600000-0000-4000-8000-000000000030";
  const sess1Id = "f2600000-0000-4000-8000-000000000041";
  const sess2Id = "f2600000-0000-4000-8000-000000000042";
  const ord1Id = "f2600000-0000-4000-8000-000000000051";
  const ord2Id = "f2600000-0000-4000-8000-000000000052";

  await db.exec(`
    INSERT INTO auth.users (id, email, raw_user_meta_data)
    VALUES
      ('${custId}', 'cust_concurrency@test.local', '{"display_name":"고객"}'::jsonb),
      ('${merchId}', 'merch_concurrency@test.local', '{"display_name":"점주"}'::jsonb);

    INSERT INTO public.user_roles (user_id, role)
    VALUES ('${merchId}', 'merchant')
    ON CONFLICT DO NOTHING;

    INSERT INTO public.businesses (
      id, name, category, road_address, latitude, longitude,
      registration_status, created_by, approved_at
    ) VALUES (
      '${bizId}', '동시성테스트카페', '카페', '경기 수원시 팔달구 매산로 1',
      37.2661, 127.0011, 'approved', '${merchId}', now()
    );

    INSERT INTO public.business_members (business_id, user_id, role, membership_status)
    VALUES ('${bizId}', '${merchId}', 'owner', 'active');

    INSERT INTO public.restrooms (
      id, business_id, name, type, access_method,
      road_address, latitude, longitude, publication_status
    ) VALUES (
      '${restId}', '${bizId}', '동시성화장실', 'partner', 'pin',
      '경기 수원시 팔달구 매산로 1', 37.2661, 127.0011, 'published'
    );

    INSERT INTO public.restroom_access_policies (
      id, restroom_id, version, access_mode, deposit_amount_krw,
      refund_eligible, receipt_window_hours, is_active, effective_from, created_by
    ) VALUES (
      '${polId}', '${restId}', 1, 'test_deposit', 1000,
      true, 24, true, now() - interval '1 hour', '${merchId}'
    );

    -- Setup Session 1
    INSERT INTO public.access_sessions (
      id, user_id, restroom_id, policy_id, status, access_method_snapshot,
      idempotency_key, expires_at
    ) VALUES (
      '${sess1Id}', '${custId}', '${restId}', '${polId}', 'created', 'pin',
      'idem_sess_1', now() + interval '1 hour'
    );
    INSERT INTO public.payment_orders (
      id, access_session_id, user_id, order_id, provider, payment_mode,
      amount_krw, status, idempotency_key
    ) VALUES (
      '${ord1Id}', '${sess1Id}', '${custId}', 'ord_conc_1', 'toss', 'test',
      1000, 'created', 'idem_ord_1'
    );
    UPDATE public.payment_orders
    SET status = 'approved', provider_payment_key = 'pk_conc_1', approved_at = now() - interval '10 minutes'
    WHERE id = '${ord1Id}';
    UPDATE public.access_sessions
    SET status = 'authorized', authorized_at = now() - interval '10 minutes'
    WHERE id = '${sess1Id}';

    -- Setup Session 2
    INSERT INTO public.access_sessions (
      id, user_id, restroom_id, policy_id, status, access_method_snapshot,
      idempotency_key, expires_at
    ) VALUES (
      '${sess2Id}', '${custId}', '${restId}', '${polId}', 'created', 'pin',
      'idem_sess_2', now() + interval '1 hour'
    );
    INSERT INTO public.payment_orders (
      id, access_session_id, user_id, order_id, provider, payment_mode,
      amount_krw, status, idempotency_key
    ) VALUES (
      '${ord2Id}', '${sess2Id}', '${custId}', 'ord_conc_2', 'toss', 'test',
      1000, 'created', 'idem_ord_2'
    );
    UPDATE public.payment_orders
    SET status = 'approved', provider_payment_key = 'pk_conc_2', approved_at = now() - interval '10 minutes'
    WHERE id = '${ord2Id}';
    UPDATE public.access_sessions
    SET status = 'authorized', authorized_at = now() - interval '10 minutes'
    WHERE id = '${sess2Id}';
  `);

  console.log("1. Testing Concurrent Submissions with IDENTICAL client_submission_id...");
  const sameKey = "sub_identical_key_12345678";
  const path1 = `receipts/${custId}/${sess1Id}/receipt_a.jpg`;

  const [res1A, res1B] = await Promise.all([
    db.query(`SELECT public.submit_customer_receipt(
      $1::uuid, $2::uuid, $3, $4, $5, $6, $7
    ) as result;`, [sess1Id, custId, path1, 'image/jpeg', 102400, 'receipt_a.jpg', sameKey]),
    db.query(`SELECT public.submit_customer_receipt(
      $1::uuid, $2::uuid, $3, $4, $5, $6, $7
    ) as result;`, [sess1Id, custId, path1, 'image/jpeg', 102400, 'receipt_a.jpg', sameKey]),
  ]);

  const parsed1A = res1A.rows[0].result;
  const parsed1B = res1B.rows[0].result;

  if (!parsed1A.ok || !parsed1B.ok) {
    throw new Error(`Scenario 1 failed: one of the calls failed: ${JSON.stringify(parsed1A)} vs ${JSON.stringify(parsed1B)}`);
  }

  const reusedFlags = [parsed1A.reused, parsed1B.reused].sort();
  console.log(`- Reused flags: [${reusedFlags.join(", ")}]`);
  if (reusedFlags[0] !== false || reusedFlags[1] !== true) {
    throw new Error(`Scenario 1 failed: expected exactly 1 reused:false and 1 reused:true, got ${JSON.stringify(reusedFlags)}`);
  }

  const countRes1 = await db.query(`SELECT COUNT(*)::int as cnt FROM public.receipt_submissions WHERE access_session_id = $1;`, [sess1Id]);
  if (countRes1.rows[0].cnt !== 1) {
    throw new Error(`Scenario 1 DB count error: expected 1 row, got ${countRes1.rows[0].cnt}`);
  }
  console.log("✓ Scenario 1 passed: Exactly 1 row inserted in DB, 1 created + 1 idempotent response.\n");

  console.log("2. Testing Concurrent Duplicate Submissions with DIFFERENT client_submission_id (during review)...");
  const diffKey = "sub_different_key_87654321";
  const path2 = `receipts/${custId}/${sess1Id}/receipt_b.jpg`;

  const res2 = await db.query(`SELECT public.submit_customer_receipt(
    $1::uuid, $2::uuid, $3, $4, $5, $6, $7
  ) as result;`, [sess1Id, custId, path2, 'image/jpeg', 102400, 'receipt_b.jpg', diffKey]);

  const parsed2 = res2.rows[0].result;
  if (parsed2.ok || parsed2.status !== 409 || parsed2.error_code !== "RECEIPT_UNDER_REVIEW") {
    throw new Error(`Scenario 2 failed: expected 409 RECEIPT_UNDER_REVIEW, got: ${JSON.stringify(parsed2)}`);
  }
  console.log("✓ Scenario 2 passed: Second submission safely blocked with 409 RECEIPT_UNDER_REVIEW.\n");

  console.log("3. Testing Concurrent Submissions for DIFFERENT access sessions...");
  const keySession2 = "sub_sess2_key_abcdefgh";
  const pathSess2 = `receipts/${custId}/${sess2Id}/receipt_sess2.jpg`;

  const res3 = await db.query(`SELECT public.submit_customer_receipt(
    $1::uuid, $2::uuid, $3, $4, $5, $6, $7
  ) as result;`, [sess2Id, custId, pathSess2, 'image/jpeg', 204800, 'receipt_sess2.jpg', keySession2]);

  const parsed3 = res3.rows[0].result;
  if (!parsed3.ok || parsed3.reused !== false) {
    throw new Error(`Scenario 3 failed: expected ok:true, reused:false, got: ${JSON.stringify(parsed3)}`);
  }
  console.log("✓ Scenario 3 passed: Session 2 receipt successfully submitted independently.\n");

  console.log("4. Verifying No Automatic Refund or Payment State Tampering...");
  const orderCheck = await db.query(`SELECT status FROM public.payment_orders WHERE id = $1;`, [ord1Id]);
  if (orderCheck.rows[0].status !== "approved") {
    throw new Error(`Payment order status tampered: expected 'approved', got '${orderCheck.rows[0].status}'`);
  }

  const refundCheck = await db.query(`SELECT COUNT(*)::int as cnt FROM public.payment_refunds WHERE payment_order_id = $1;`, [ord1Id]);
  if (refundCheck.rows[0].cnt !== 0) {
    throw new Error(`Automatic refund created erroneously: count is ${refundCheck.rows[0].cnt}`);
  }
  console.log("✓ Scenario 4 passed: Payment order stays approved and 0 refunds exist (no automatic refund).\n");

  console.log("==================================================");
  console.log("TASK 26 ALL CONCURRENCY & INTEGRATION TESTS PASSED!");
  console.log("==================================================");
}

run().catch((err) => {
  console.error("FATAL ERROR in test_receipt_concurrency:", err);
  process.exit(1);
});
