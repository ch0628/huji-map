import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

async function run() {
  console.log("1. Initializing PGlite instance for TASK 17 events_backend...");
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
  ];

  for (let i = 0; i < migrations.length; i++) {
    const { file, ver } = migrations[i];
    console.log(`Applying Migration ${i + 1}/${migrations.length}: ${file}`);
    const sql = fs.readFileSync(path.join(ROOT, "supabase/migrations", file), "utf8");
    await db.exec(sql);
    await db.query(`INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ($1, $2)`, [ver, file]);
  }

  console.log("Executing Verification SQL: verify_events_backend_rollback.sql");
  const vSql = fs.readFileSync(
    path.join(ROOT, "tests/integration/sql/verify_events_backend_rollback.sql"),
    "utf8"
  );

  // The DO block catches P0099 internally and verifies 0 residue, completing cleanly with code 0.
  await db.exec(vSql);
  console.log("✓ Verification SQL DO block completed cleanly (P0099 caught internally and 0 residue verified)!");

  // Concurrency & race condition tests:
  console.log("\n2. Testing Concurrency & Race Conditions...");

  // Test 1: Concurrent ingestion with identical payload via Promise.all
  console.log("2-A. Testing Concurrent Ingestion Idempotency (identical payload)...");
  const concurrentEventId = "fa170000-0000-0000-0000-000000000999";
  const [resA, resB] = await Promise.all([
    db.query(`SELECT public.log_client_event($1::uuid, 'map_loaded', 1, null, null, null, null, null, null, null, null, null, '{"zoom": 16}'::jsonb, 'client') as res`, [concurrentEventId]),
    db.query(`SELECT public.log_client_event($1::uuid, 'map_loaded', 1, null, null, null, null, null, null, null, null, null, '{"zoom": 16}'::jsonb, 'client') as res`, [concurrentEventId]),
  ]);

  const dataA = typeof resA.rows[0].res === "string" ? JSON.parse(resA.rows[0].res) : resA.rows[0].res;
  const dataB = typeof resB.rows[0].res === "string" ? JSON.parse(resB.rows[0].res) : resB.rows[0].res;

  const dedupStates = [Boolean(dataA.deduplicated), Boolean(dataB.deduplicated)];
  if (!dedupStates.includes(false) || !dedupStates.includes(true)) {
    throw new Error(`Expected one concurrent call to have deduplicated=false and one to have deduplicated=true, got: ${JSON.stringify(dedupStates)}`);
  }

  const countRes = await db.query(
    `SELECT count(*) as count FROM public.event_logs WHERE client_event_id = $1`,
    [concurrentEventId]
  );
  if (parseInt(countRes.rows[0].count, 10) !== 1) {
    throw new Error(`Expected exactly 1 row in event_logs for concurrent event, got: ${countRes.rows[0].count}`);
  }

  // Cleanup concurrent test row
  await db.exec(`
    ALTER TABLE public.event_logs DISABLE TRIGGER trg_prevent_event_logs_mutation;
    DELETE FROM public.event_logs WHERE client_event_id = '${concurrentEventId}';
    ALTER TABLE public.event_logs ENABLE TRIGGER trg_prevent_event_logs_mutation;
  `);
  console.log("✓ Concurrent identical ingestion passed: exactly 1 stored, exactly 1 deduplicated!");

  // Test 2: Concurrent ingestion with differing properties collision
  console.log("2-B. Testing Concurrent Ingestion Collision (differing properties)...");
  const collisionEventId = "fa170000-0000-0000-0000-000000000998";
  let collisionCaught = false;

  const results = await Promise.allSettled([
    db.query(`SELECT public.log_client_event($1::uuid, 'map_loaded', 1, null, null, null, null, null, null, null, null, null, '{"zoom": 16}'::jsonb, 'client') as res`, [collisionEventId]),
    db.query(`SELECT public.log_client_event($1::uuid, 'map_loaded', 1, null, null, null, null, null, null, null, null, null, '{"zoom": 17}'::jsonb, 'client') as res`, [collisionEventId]),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  if (fulfilled.length === 1 && rejected.length === 1) {
    if (rejected[0].reason?.message?.includes("collision") || rejected[0].reason?.message?.includes("23505")) {
      collisionCaught = true;
    }
  }

  if (!collisionCaught) {
    throw new Error(`Expected one call to succeed and one to fail with 23505 collision, got results: ${JSON.stringify(results.map(r => r.status === "fulfilled" ? "ok" : r.reason?.message))}`);
  }

  // Cleanup collision test row
  await db.exec(`
    ALTER TABLE public.event_logs DISABLE TRIGGER trg_prevent_event_logs_mutation;
    DELETE FROM public.event_logs WHERE client_event_id = '${collisionEventId}';
    ALTER TABLE public.event_logs ENABLE TRIGGER trg_prevent_event_logs_mutation;
  `);
  console.log("✓ Concurrent differing ingestion passed: 23505 collision thrown on conflicting payload!");

  // Test 3: Concurrent travel answer on same session with different event IDs
  console.log("2-C. Testing Concurrent Travel Answer Single Recording (FOR UPDATE row lock)...");
  const raceSessionId = "fa170000-0000-0000-0000-000000000888";
  const raceBrowserId = "fa170000-0000-0000-0000-000000000889";
  const raceTokenHash = "race_token_hash_value_1234567890abcdef1234567890abcdef";
  const raceEventId1 = "fa170000-0000-0000-0000-000000000881";
  const raceEventId2 = "fa170000-0000-0000-0000-000000000882";

  // Insert fixture session
  await db.query(
    `INSERT INTO public.visitor_sessions (id, browser_id, session_token_hash, landing_path, is_test) VALUES ($1, $2, $3, '/map', true)`,
    [raceSessionId, raceBrowserId, raceTokenHash]
  );

  const [tResA, tResB] = await Promise.all([
    db.query(`SELECT public.record_travel_answer($1::uuid, true, $2::uuid, null, $3, $4::uuid) as res`, [raceSessionId, raceBrowserId, raceTokenHash, raceEventId1]),
    db.query(`SELECT public.record_travel_answer($1::uuid, true, $2::uuid, null, $3, $4::uuid) as res`, [raceSessionId, raceBrowserId, raceTokenHash, raceEventId2]),
  ]);

  const tDataA = typeof tResA.rows[0].res === "string" ? JSON.parse(tResA.rows[0].res) : tResA.rows[0].res;
  const tDataB = typeof tResB.rows[0].res === "string" ? JSON.parse(tResB.rows[0].res) : tResB.rows[0].res;

  const tDedupStates = [Boolean(tDataA.deduplicated), Boolean(tDataB.deduplicated)];
  if (!tDedupStates.includes(false) || !tDedupStates.includes(true)) {
    throw new Error(`Expected one travel answer to have deduplicated=false and one to have deduplicated=true, got: ${JSON.stringify(tDedupStates)}`);
  }

  const travelEventCount = await db.query(
    `SELECT count(*) as count FROM public.event_logs WHERE session_id = $1 AND event_name = 'travel_answer_submitted'`,
    [raceSessionId]
  );
  if (parseInt(travelEventCount.rows[0].count, 10) !== 1) {
    throw new Error(`Expected exactly 1 travel_answer_submitted event in event_logs, got: ${travelEventCount.rows[0].count}`);
  }

  // Cleanup race session and events
  await db.exec(`
    ALTER TABLE public.event_logs DISABLE TRIGGER trg_prevent_event_logs_mutation;
    DELETE FROM public.event_logs WHERE session_id = '${raceSessionId}';
    ALTER TABLE public.event_logs ENABLE TRIGGER trg_prevent_event_logs_mutation;
    DELETE FROM public.visitor_sessions WHERE id = '${raceSessionId}';
  `);
  console.log("✓ Concurrent travel answer passed: exactly 1 event row created, duplicate deduplicated!");

  // Verify that test records were rolled back across all tables
  const userCheck = await db.query(
    `SELECT count(*) as count FROM auth.users WHERE email LIKE '%@hujimap.local' OR id::text LIKE 'fa170000-%'`
  );
  if (parseInt(userCheck.rows[0].count, 10) !== 0) {
    throw new Error(`Residual test users found in auth.users: ${userCheck.rows[0].count}`);
  }

  const eventCheck = await db.query(
    `SELECT count(*) as count FROM public.event_logs WHERE client_event_id::text LIKE 'fa170000-%'`
  );
  if (parseInt(eventCheck.rows[0].count, 10) !== 0) {
    throw new Error(`Residual test events found: ${eventCheck.rows[0].count}`);
  }

  const sessionCheck = await db.query(
    `SELECT count(*) as count FROM public.visitor_sessions WHERE id::text LIKE 'fa170000-%'`
  );
  if (parseInt(sessionCheck.rows[0].count, 10) !== 0) {
    throw new Error(`Residual test visitor sessions found: ${sessionCheck.rows[0].count}`);
  }

  console.log("✓ Residual data check passed: 0 lingering test rows!");
  console.log("============================================================");
  console.log("SUCCESS! All 8 migrations and all events backend verifications PASSED in PGlite!");
}

run().catch((err) => {
  console.error("FATAL ERROR in test_pglite_events_backend:", err);
  process.exit(1);
});
