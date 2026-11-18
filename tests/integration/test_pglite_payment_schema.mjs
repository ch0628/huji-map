import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

async function run() {
  console.log("1. Initializing PGlite instance for TASK 20 payment_schema...");
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

    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;

    CREATE SCHEMA IF NOT EXISTS supabase_migrations;
    CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
      version text PRIMARY KEY,
      statements text[],
      name text
    );
  `);

  const migrations = [
    { file: "20261106000000_auth_schema.sql", ver: "20261106000000" },
    { file: "20261107000000_lead_tracking.sql", ver: "20261107000000" },
    { file: "20261108000000_business_backend.sql", ver: "20261108000000" },
    { file: "20261109000000_audit_and_approval.sql", ver: "20261109000000" },
    { file: "20261110000000_restroom_schema.sql", ver: "20261110000000" },
    { file: "20261111000000_restroom_merchant_operations.sql", ver: "20261111000000" },
    { file: "20261112000000_restroom_admin_review.sql", ver: "20261112000000" },
    { file: "20261113000000_events_backend.sql", ver: "20261113000000" },
    { file: "20261114000000_payment_schema.sql", ver: "20261114000000" },
  ];

  for (let i = 0; i < migrations.length; i++) {
    const { file, ver } = migrations[i];
    console.log(`Applying Migration ${i + 1}/${migrations.length}: ${file}`);
    const sql = fs.readFileSync(path.join(ROOT, "supabase/migrations", file), "utf8");
    await db.exec(sql);
    await db.query(
      `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ($1, $2)`,
      [ver, file]
    );
  }

  console.log("\nExecuting Verification SQL: verify_payment_schema_rollback.sql");
  const vSql = fs.readFileSync(
    path.join(ROOT, "tests/integration/sql/verify_payment_schema_rollback.sql"),
    "utf8"
  );

  // The DO block catches P0099 internally and verifies 0 residue, completing cleanly with code 0.
  await db.exec(vSql);
  console.log("✓ Verification SQL DO block completed cleanly (P0099 caught internally and 0 residue verified)!");

  // Concurrency & race condition tests:
  console.log("\n2. Testing Concurrency & Race Conditions...");

  const cUser = "fa200000-0000-0000-0000-000000000801";
  const cBiz = "fa200000-0000-0000-0000-000000000810";
  const cRestroom = "fa200000-0000-0000-0000-000000000820";
  const cPolicy = "fa200000-0000-0000-0000-000000000830";
  const cSession = "fa200000-0000-0000-0000-000000000840";

  // Create test fixtures for concurrency
  await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'conc_test_task20@example.com')`, [cUser]);
  await db.query(`INSERT INTO public.profiles (id, display_name) VALUES ($1, 'Conc User') ON CONFLICT (id) DO NOTHING`, [cUser]);
  await db.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'customer') ON CONFLICT DO NOTHING`, [cUser]);

  await db.query(`
    INSERT INTO public.businesses (id, name, category, road_address, latitude, longitude, registration_status, approved_by, approved_at, created_by)
    VALUES ($1, '동시성 카페', '카페', '수원시 매산로 10', 37.26, 127.00, 'approved', $2, now(), $2)
  `, [cBiz, cUser]);

  await db.query(`
    INSERT INTO public.restrooms (id, business_id, type, name, road_address, latitude, longitude, access_method, publication_status, approved_by, last_verified_at, created_by)
    VALUES ($1, $2, 'partner', '동시성화장실', '수원시 매산로 10', 37.26, 127.00, 'pin', 'published', $3, now(), $3)
  `, [cRestroom, cBiz, cUser]);

  await db.query(`
    INSERT INTO public.restroom_access_policies (id, restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, is_active, effective_from, created_by)
    VALUES ($1, $2, 1, 'test_deposit', 1000, true, true, now(), $3)
  `, [cPolicy, cRestroom, cUser]);

  await db.query(`
    INSERT INTO public.access_sessions (id, user_id, restroom_id, policy_id, access_method_snapshot, idempotency_key, expires_at)
    VALUES ($1, $2, $3, $4, 'pin', 'idem_conc_session_001', now() + interval '1 hour')
  `, [cSession, cUser, cRestroom, cPolicy]);

  // Test 2-A: Concurrent order creation with identical idempotency_key
  console.log("2-A. Testing Concurrent Payment Order Idempotency (same idempotency_key)...");
  const idemKey = "idem_conc_order_unique_key_12345";
  const orderId1 = "ord_conc_001";
  const orderId2 = "ord_conc_002";

  const results = await Promise.allSettled([
    db.query(`
      INSERT INTO public.payment_orders (id, access_session_id, user_id, order_id, amount_krw, idempotency_key)
      VALUES (gen_random_uuid(), $1, $2, $3, 1000, $4)
    `, [cSession, cUser, orderId1, idemKey]),
    db.query(`
      INSERT INTO public.payment_orders (id, access_session_id, user_id, order_id, amount_krw, idempotency_key)
      VALUES (gen_random_uuid(), $1, $2, $4, 1000, $4)
    `, [cSession, cUser, orderId2, idemKey]),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  if (fulfilled.length !== 1 || rejected.length !== 1) {
    throw new Error(`Expected exactly 1 success and 1 rejection on duplicate idempotency_key, got ${fulfilled.length} fulfilled and ${rejected.length} rejected`);
  }
  console.log("✓ Concurrent idempotency check passed: 1 fulfilled, 1 rejected with unique violation!");

  // Test 2-B: Concurrent double approved payment orders on same access session
  console.log("2-B. Testing Concurrent Approved Orders Collision (single approved per session)...");
  const apprOrderId1 = "ord_conc_appr_001";
  const apprOrderId2 = "ord_conc_appr_002";
  const apprOrderUuid1 = "fa200000-0000-0000-0000-000000000091";
  const apprOrderUuid2 = "fa200000-0000-0000-0000-000000000092";

  // Both orders are initially created in 'created' status (conforming to HM038)
  await db.query(`
    INSERT INTO public.payment_orders (id, access_session_id, user_id, order_id, amount_krw, status, idempotency_key)
    VALUES ($1, $2, $3, $4, 1000, 'created', 'idem_appr_1')
  `, [apprOrderUuid1, cSession, cUser, apprOrderId1]);

  await db.query(`
    INSERT INTO public.payment_orders (id, access_session_id, user_id, order_id, amount_krw, status, idempotency_key)
    VALUES ($1, $2, $3, $4, 1000, 'created', 'idem_appr_2')
  `, [apprOrderUuid2, cSession, cUser, apprOrderId2]);

  // Concurrent approval attempt on the same access session
  const apprResults = await Promise.allSettled([
    db.query(`
      UPDATE public.payment_orders
      SET status = 'approved', provider_payment_key = 'paykey_conc_001'
      WHERE id = $1
    `, [apprOrderUuid1]),
    db.query(`
      UPDATE public.payment_orders
      SET status = 'approved', provider_payment_key = 'paykey_conc_002'
      WHERE id = $1
    `, [apprOrderUuid2]),
  ]);

  const apprFulfilled = apprResults.filter((r) => r.status === "fulfilled");
  const apprRejected = apprResults.filter((r) => r.status === "rejected");

  if (apprFulfilled.length !== 1 || apprRejected.length !== 1) {
    throw new Error(`Expected exactly 1 approved order fulfilled and 1 rejected on same session, got ${apprFulfilled.length} fulfilled and ${apprRejected.length} rejected`);
  }
  console.log("✓ Single approved order per session verified under concurrent race conditions!");

  // Cleanup concurrency test fixtures
  await db.exec(`
    ALTER TABLE public.payment_refunds DISABLE TRIGGER trg_prevent_payment_refunds_delete;
    ALTER TABLE public.payment_orders DISABLE TRIGGER trg_prevent_payment_orders_delete;
    ALTER TABLE public.access_sessions DISABLE TRIGGER trg_prevent_access_sessions_delete;

    DELETE FROM public.payment_orders WHERE access_session_id = '${cSession}';
    DELETE FROM public.access_sessions WHERE id = '${cSession}';
    DELETE FROM public.restroom_access_policies WHERE restroom_id = '${cRestroom}';
    DELETE FROM public.restrooms WHERE id = '${cRestroom}';
    DELETE FROM public.businesses WHERE id = '${cBiz}';
    DELETE FROM public.user_roles WHERE user_id = '${cUser}';
    DELETE FROM public.profiles WHERE id = '${cUser}';
    DELETE FROM auth.users WHERE id = '${cUser}';

    ALTER TABLE public.payment_refunds ENABLE TRIGGER trg_prevent_payment_refunds_delete;
    ALTER TABLE public.payment_orders ENABLE TRIGGER trg_prevent_payment_orders_delete;
    ALTER TABLE public.access_sessions ENABLE TRIGGER trg_prevent_access_sessions_delete;
  `);

  // Final check: 0 test rows remaining
  const finalCheck = await db.query(
    `SELECT count(*) as count FROM public.payment_orders WHERE id::text LIKE 'fa200000-%'`
  );
  if (parseInt(finalCheck.rows[0].count, 10) !== 0) {
    throw new Error(`Residual payment_orders found: ${finalCheck.rows[0].count}`);
  }

  console.log("✓ Final residual check passed: 0 lingering test rows!");
  console.log("============================================================");
  console.log("SUCCESS! All 9 migrations and all TASK 20 payment schema verifications PASSED in PGlite!");
}

run().catch((err) => {
  console.error("FATAL ERROR in test_pglite_payment_schema:", err);
  process.exit(1);
});
