import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

async function run() {
  console.log("1. Initializing PGlite instance for TASK 28 Receipt Review Backend...");
  const db = new PGlite();

  db.onNotification((msg) => {
    console.log("NOTICE:", msg);
  });

  // Setup Supabase auth mock infrastructure & roles
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

  const migrationDir = path.join(ROOT, "supabase/migrations");
  const files = fs
    .readdirSync(migrationDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    console.log(`Applying Migration ${i + 1}/${files.length}: ${file}`);
    const sql = fs.readFileSync(path.join(migrationDir, file), "utf-8");
    await db.exec(sql);
  }

  console.log("\n2. Executing Verification SQL: verify_receipt_review_rollback.sql");
  const verifySql = fs.readFileSync(
    path.join(ROOT, "tests/integration/sql/verify_receipt_review_rollback.sql"),
    "utf-8"
  );
  await db.exec(verifySql);
  console.log(
    "✓ Verification SQL DO block completed cleanly (P0099 caught internally and 0 residue verified)!"
  );

  console.log("\n3. Testing Concurrency & Mutex in PGlite");
  // Test concurrent calls to decide_receipt_review on same submission
  const adminId = "fa280000-0000-4000-a000-000000000001";
  const custId = "fa280000-0000-4000-a000-000000000002";
  const merchId = "fa280000-0000-4000-a000-000000000003";
  const bizId = "fa280000-0000-4000-b000-000000000001";
  const restId = "fa280000-0000-4000-b000-000000000002";
  const polId = "fa280000-0000-4000-b000-000000000003";
  const sessId = "fa280000-0000-4000-c000-000000000001";
  const ordId = "fa280000-0000-4000-c000-000000000011";
  const subId = "fa280000-0000-4000-d000-000000000001";

  await db.exec(`
    INSERT INTO auth.users (id, email) VALUES
      ('${adminId}', 'conc_admin@test.local'),
      ('${custId}', 'conc_cust@test.local'),
      ('${merchId}', 'conc_merch@test.local')
    ON CONFLICT DO NOTHING;

    INSERT INTO public.user_roles (user_id, role) VALUES
      ('${adminId}', 'admin'),
      ('${merchId}', 'merchant')
    ON CONFLICT DO NOTHING;

    INSERT INTO public.businesses (id, name, category, road_address, latitude, longitude, registration_status, created_by, approved_at)
    VALUES ('${bizId}', '동시성카페', '카페', '수원', 37.26, 127.00, 'approved', '${merchId}', now())
    ON CONFLICT DO NOTHING;

    INSERT INTO public.business_members (business_id, user_id, role, membership_status)
    VALUES ('${bizId}', '${merchId}', 'owner', 'active')
    ON CONFLICT DO NOTHING;

    INSERT INTO public.restrooms (id, business_id, name, type, access_method, road_address, latitude, longitude, publication_status)
    VALUES ('${restId}', '${bizId}', '동시성화장실', 'partner', 'pin', '수원', 37.26, 127.00, 'published')
    ON CONFLICT DO NOTHING;

    INSERT INTO public.restroom_access_policies (id, restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, receipt_window_hours, is_active, effective_from, created_by)
    VALUES ('${polId}', '${restId}', 1, 'test_deposit', 1000, true, 24, true, now() - interval '1 hour', '${merchId}')
    ON CONFLICT DO NOTHING;

    INSERT INTO public.access_sessions (id, user_id, restroom_id, policy_id, status, access_method_snapshot, idempotency_key, expires_at)
    VALUES ('${sessId}', '${custId}', '${restId}', '${polId}', 'created', 'pin', 'conc_idem_sess', now() + interval '1 hour')
    ON CONFLICT DO NOTHING;

    INSERT INTO public.payment_orders (id, access_session_id, user_id, order_id, provider, payment_mode, amount_krw, status, idempotency_key)
    VALUES ('${ordId}', '${sessId}', '${custId}', 'conc_ord_1', 'toss', 'test', 1000, 'created', 'conc_ord_idem1')
    ON CONFLICT DO NOTHING;

    UPDATE public.payment_orders
    SET status = 'approved', provider_payment_key = 'pk_conc_1', approved_at = now() - interval '1 hour'
    WHERE id = '${ordId}';

    UPDATE public.access_sessions
    SET status = 'authorized', authorized_at = now() - interval '1 hour'
    WHERE id = '${sessId}';

    INSERT INTO public.receipt_submissions (id, access_session_id, user_id, storage_path, mime_type, file_size_bytes, original_filename, client_submission_id, submission_status)
    VALUES ('${subId}', '${sessId}', '${custId}', 'receipts/${custId}/${sessId}/conc.jpg', 'image/jpeg', 102400, 'conc.jpg', 'conc_client_sub1', 'submitted')
    ON CONFLICT DO NOTHING;
  `);

  // Verify legacy 8-parameter signature call fails with 42883
  let legacyCallFailed = false;
  try {
    await db.query(
      `SELECT public.decide_receipt_review($1, $2, $3, $4, NULL, NULL, NULL, NULL) as result`,
      [subId, adminId, "approved", "레거시 8인자 호출"]
    );
  } catch (err) {
    if (err.code === "42883" || err.message?.includes("does not exist")) {
      legacyCallFailed = true;
      console.log("✓ Legacy 8-parameter call properly rejected (42883 undefined_function)");
    } else {
      throw err;
    }
  }
  if (!legacyCallFailed) {
    throw new Error("Expected legacy 8-parameter call to fail with 42883");
  }

  // Execute two concurrent decisions on the exact same submission using the 10-param signature
  const p1 = db.query(
    `SELECT public.decide_receipt_review($1, $2, $3, $4, NULL, NULL, NULL, NULL, NULL, NULL) as result`,
    [subId, adminId, "approved", "동시성 승인 1차 시도"]
  );
  const p2 = db.query(
    `SELECT public.decide_receipt_review($1, $2, $3, $4, NULL, NULL, NULL, NULL, NULL, NULL) as result`,
    [subId, adminId, "approved", "동시성 승인 2차 시도"]
  );

  const results = await Promise.allSettled([p1, p2]);
  const succeeded = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  console.log(
    `Concurrent review results: ${succeeded.length} succeeded, ${rejected.length} rejected with conflict.`
  );
  if (succeeded.length !== 1 || rejected.length !== 1) {
    throw new Error(
      `Concurrency test failed: expected exactly 1 succeeded and 1 rejected, got ${succeeded.length} and ${rejected.length}`
    );
  }

  const errMessage = rejected[0]?.reason?.message || "";
  console.log(`Rejection error message as expected: ${errMessage}`);
  if (!errMessage.includes("ALREADY_APPROVED") && !errMessage.includes("HM002")) {
    throw new Error(`Expected HM002 ALREADY_APPROVED error, got: ${errMessage}`);
  }

  // Verify only 1 audit record was created
  const auditRes = await db.query(
    `SELECT COUNT(*) as cnt FROM public.receipt_review_audits WHERE submission_id = $1`,
    [subId]
  );
  const auditCnt = Number(auditRes.rows[0]?.cnt);
  console.log(`Audit records count for submission: ${auditCnt}`);
  if (auditCnt !== 1) {
    throw new Error(`Expected exactly 1 audit record, found ${auditCnt}`);
  }

  console.log("\n4. Testing DB-Level Atomic Idempotency Replay & Conflict in PGlite");
  const idemKey = "test_idem_pglite_1";
  const payloadHash = "hash_pglite_a1";

  // First call with idempotency key
  const subId2 = "fa280000-0000-4000-d000-000000000002";
  await db.exec(`
    INSERT INTO public.access_sessions (id, user_id, restroom_id, policy_id, status, access_method_snapshot, idempotency_key, expires_at)
    VALUES ('fa280000-0000-4000-c000-000000000002', '${custId}', '${restId}', '${polId}', 'created', 'pin', 'conc_idem_sess2', now() + interval '1 hour')
    ON CONFLICT DO NOTHING;
    INSERT INTO public.payment_orders (id, access_session_id, user_id, order_id, provider, payment_mode, amount_krw, status, idempotency_key)
    VALUES ('fa280000-0000-4000-c000-000000000012', 'fa280000-0000-4000-c000-000000000002', '${custId}', 'conc_ord_2', 'toss', 'test', 1000, 'created', 'conc_ord_idem2')
    ON CONFLICT DO NOTHING;
    UPDATE public.payment_orders SET status = 'approved', provider_payment_key = 'pk_conc_2', approved_at = now() - interval '1 hour' WHERE id = 'fa280000-0000-4000-c000-000000000012';
    UPDATE public.access_sessions SET status = 'authorized', authorized_at = now() - interval '1 hour' WHERE id = 'fa280000-0000-4000-c000-000000000002';
    INSERT INTO public.receipt_submissions (id, access_session_id, user_id, storage_path, mime_type, file_size_bytes, original_filename, client_submission_id, submission_status)
    VALUES ('${subId2}', 'fa280000-0000-4000-c000-000000000002', '${custId}', 'receipts/${custId}/fa280000-0000-4000-c000-000000000002/conc2.jpg', 'image/jpeg', 102400, 'conc2.jpg', 'conc_client_sub2', 'submitted')
    ON CONFLICT DO NOTHING;
  `);

  const initialRes = await db.query(
    `SELECT public.decide_receipt_review($1, $2, $3, $4, NULL, NULL, NULL, NULL, $5, $6) as result`,
    [subId2, adminId, "approved", "멱등성 최초 승인", idemKey, payloadHash]
  );
  const initObj = initialRes.rows[0]?.result;
  console.log("Initial idempotent decision:", initObj?.ok, "reused:", initObj?.reused);
  if (!initObj?.ok || initObj?.reused !== false) {
    throw new Error(`Initial idempotent decision failed: ${JSON.stringify(initObj)}`);
  }

  // Replay call with exact same idempotency key and hash
  const replayRes = await db.query(
    `SELECT public.decide_receipt_review($1, $2, $3, $4, NULL, NULL, NULL, NULL, $5, $6) as result`,
    [subId2, adminId, "approved", "멱등성 최초 승인", idemKey, payloadHash]
  );
  const replayObj = replayRes.rows[0]?.result;
  console.log("Replay decision:", replayObj?.ok, "reused:", replayObj?.reused);
  if (!replayObj?.ok || replayObj?.reused !== true) {
    throw new Error(`Replay idempotent decision failed: ${JSON.stringify(replayObj)}`);
  }

  // Verify exactly 1 audit record exists for subId2
  const auditRes2 = await db.query(
    `SELECT COUNT(*) as cnt FROM public.receipt_review_audits WHERE submission_id = $1`,
    [subId2]
  );
  if (Number(auditRes2.rows[0]?.cnt) !== 1) {
    throw new Error(`Audit record duplicated on replay: ${auditRes2.rows[0]?.cnt}`);
  }

  // Conflict call with same idempotency key but different hash
  let conflictCaught = false;
  try {
    await db.query(
      `SELECT public.decide_receipt_review($1, $2, $3, $4, NULL, NULL, NULL, NULL, $5, $6) as result`,
      [subId2, adminId, "approved", "다른 사유", idemKey, "DIFFERENT_HASH"]
    );
  } catch (err) {
    if (err.message.includes("HM094") || err.message.includes("23505") || err.code === "23505") {
      conflictCaught = true;
      console.log("✓ Expected 409/HM094 conflict caught when payload hash mismatches!");
    } else {
      throw err;
    }
  }
  if (!conflictCaught) {
    throw new Error("Expected conflict on mismatched payload hash with same idempotency key");
  }

  console.log("\n==================================================");
  console.log("TASK 28 ALL INTEGRATION & SQL VERIFICATIONS PASSED!");
  console.log("==================================================");
}

run().catch((err) => {
  console.error("FATAL VERIFICATION ERROR:", err);
  process.exit(1);
});
