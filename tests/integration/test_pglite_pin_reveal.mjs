import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

async function run() {
  console.log("1. Initializing PGlite instance for TASK 24 Customer Doorlock PIN Reveal API...");
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
    { file: "20261115000000_payment_atomic_operations.sql", ver: "20261115000000" },
    { file: "20261116000000_pin_storage.sql", ver: "20261116000000" },
    { file: "20261117000000_pin_reveal.sql", ver: "20261117000000" },
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

  console.log("\n2. Executing Verification SQL: verify_pin_reveal_rollback.sql");
  const vSql = fs.readFileSync(
    path.join(ROOT, "tests/integration/sql/verify_pin_reveal_rollback.sql"),
    "utf8"
  );

  await db.exec(vSql);
  console.log("✓ Verification SQL DO block completed cleanly (P0099 caught internally and 0 residue verified)!");

  console.log("\n3. Testing Concurrency & State Consistency (T20)...");
  // Setup isolated fixtures for concurrency test
  const cUser = "fa24c000-0000-0000-0000-000000000001";
  const mUser = "fa24c000-0000-0000-0000-000000000002";
  const cBiz = "fa24c000-0000-0000-0000-000000000010";
  const cRestroom = "fa24c000-0000-0000-0000-000000000020";
  const cPolicy = "fa24c000-0000-0000-0000-000000000025";
  const cSession = "fa24c000-0000-0000-0000-000000000030";
  const cOrder = "fa24c000-0000-0000-0000-000000000040";

  await db.exec(`
    INSERT INTO auth.users (id, email) VALUES
      ('${cUser}', 'conc_user@test.com'),
      ('${mUser}', 'conc_merchant@test.com')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.profiles (id, display_name, account_status) VALUES
      ('${cUser}', 'Conc User', 'active'),
      ('${mUser}', 'Conc Merchant', 'active')
    ON CONFLICT (id) DO UPDATE SET account_status = EXCLUDED.account_status;

    INSERT INTO public.user_roles (user_id, role) VALUES
      ('${cUser}', 'customer'),
      ('${mUser}', 'merchant')
    ON CONFLICT (user_id, role) DO NOTHING;

    INSERT INTO public.businesses (id, name, created_by, category, road_address, latitude, longitude, registration_status, approved_at)
    VALUES ('${cBiz}', 'Conc Cafe', '${mUser}', 'cafe', '매산로 10', 37.266, 127.001, 'approved', now())
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.business_members (business_id, user_id, role)
    VALUES ('${cBiz}', '${mUser}', 'owner')
    ON CONFLICT (business_id, user_id) DO NOTHING;

    INSERT INTO public.restrooms (id, business_id, type, name, road_address, latitude, longitude, access_method, publication_status, created_by)
    VALUES ('${cRestroom}', '${cBiz}', 'partner', 'Conc Restroom', '매산로 10', 37.266, 127.001, 'pin', 'published', '${mUser}')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.restroom_access_policies (id, restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, receipt_window_hours, min_purchase_krw, is_active, effective_from, created_by)
    VALUES ('${cPolicy}', '${cRestroom}', 1, 'test_deposit', 1000, true, 24, 0, true, now(), '${mUser}')
    ON CONFLICT (id) DO NOTHING;

    -- Active PIN version 1
    INSERT INTO public.restroom_lock_secrets (
      restroom_id, ciphertext_b64, iv_b64, auth_tag_b64, key_version, code_version,
      valid_from, valid_until, status, created_by, idempotency_key, pin_hmac_b64
    ) VALUES (
      '${cRestroom}', 'Y2lwaGVydjE=', 'aXYxMTExMTExMTEx', 'YXV0aHRhZzExMTExMTEx',
      1, 1, now() - interval '1 hour', null, 'active', '${mUser}', 'conc-idem-v1', 'aG1hY3Yx'
    );

    INSERT INTO public.access_sessions (id, user_id, restroom_id, policy_id, status, access_method_snapshot, idempotency_key, expires_at)
    VALUES ('${cSession}', '${cUser}', '${cRestroom}', '${cPolicy}', 'created', 'pin', 'conc-idem-sess', now() + interval '2 hours')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.payment_orders (id, access_session_id, user_id, order_id, provider, payment_mode, amount_krw, status, idempotency_key)
    VALUES ('${cOrder}', '${cSession}', '${cUser}', 'conc-order-1', 'toss', 'test', 1000, 'created', 'conc-idem-ord')
    ON CONFLICT (id) DO NOTHING;

    UPDATE public.payment_orders
    SET status = 'approved', provider_payment_key = 'pk_conc', approved_at = now()
    WHERE id = '${cOrder}';

    UPDATE public.access_sessions
    SET status = 'authorized', authorized_at = now()
    WHERE id = '${cSession}';
  `);

  console.log("Simulating concurrent PIN rotation (v2) and PIN reveal requests...");
  const promises = [
    // Reveal 1
    db.query(`SELECT public.reveal_access_pin('${cSession}', '${cUser}', 'conc-req-1') as res`),
    // Rotate to Version 2
    db.query(`
      SELECT public.rotate_restroom_pin(
        '${cRestroom}', '${mUser}', 'Y2lwaGVydjI=', 'aXYyMjIyMjIyMjIy',
        'YXV0aHRhZzIyMjIyMjIy', 1, 'conc-rot-idem', 'aG1hY3Yy'
      ) as res
    `),
    // Reveal 2
    db.query(`SELECT public.reveal_access_pin('${cSession}', '${cUser}', 'conc-req-2') as res`),
  ];

  const results = await Promise.all(promises);

  const reveal1Res = typeof results[0].rows[0].res === "string" ? JSON.parse(results[0].rows[0].res) : results[0].rows[0].res;
  const rotateRes = typeof results[1].rows[0].res === "string" ? JSON.parse(results[1].rows[0].res) : results[1].rows[0].res;
  const reveal2Res = typeof results[2].rows[0].res === "string" ? JSON.parse(results[2].rows[0].res) : results[2].rows[0].res;

  console.log("Reveal 1 Code Version:", reveal1Res.code_version);
  console.log("Rotate Code Version:", rotateRes.code_version);
  console.log("Reveal 2 Code Version:", reveal2Res.code_version);

  // Both reveals MUST succeed and return an active code version (either 1 or 2, never corrupted or rotated)
  if (!reveal1Res.ok || !reveal2Res.ok) {
    throw new Error("Concurrent reveals failed!");
  }
  if (![1, 2].includes(reveal1Res.code_version) || ![1, 2].includes(reveal2Res.code_version)) {
    throw new Error("Invalid code version returned during concurrent rotation!");
  }

  // In-memory PGlite instance will terminate cleanly (pin_reveal_audits is append-only)
  console.log("✓ Concurrency test passed: reveals always returned valid active code version without conflict!");
  console.log("\n==================================================");
  console.log("TASK 24 ALL INTEGRATION & SQL VERIFICATIONS PASSED!");
  console.log("==================================================");
}

run().catch((err) => {
  console.error("FATAL ERROR in TASK 24 PGlite Integration Test:", err);
  process.exit(1);
});
