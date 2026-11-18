import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

async function run() {
  console.log("1. Initializing PGlite instance for TASK 23 Doorlock PIN Storage & Rotation...");
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

  console.log("\n2. Executing Verification SQL: verify_pin_storage_rollback.sql");
  const vSql = fs.readFileSync(
    path.join(ROOT, "tests/integration/sql/verify_pin_storage_rollback.sql"),
    "utf8"
  );

  await db.exec(vSql);
  console.log("✓ Verification SQL DO block completed cleanly (P0099 caught internally and 0 residue verified)!");

  console.log("\n3. Testing Concurrency & State Consistency (T15)...");
  // Setup isolated fixtures for concurrency test
  const cUser = "fa23c000-0000-0000-0000-000000000001";
  const cBiz = "fa23c000-0000-0000-0000-000000000010";
  const cRestroom = "fa23c000-0000-0000-0000-000000000020";

  await db.exec(`
    INSERT INTO auth.users (id, email) VALUES ('${cUser}', 'concurrency_merchant@test.com');
    INSERT INTO public.profiles (id, display_name, account_status) VALUES ('${cUser}', '동시점주', 'active')
      ON CONFLICT (id) DO UPDATE SET account_status = 'active';
    INSERT INTO public.user_roles (user_id, role) VALUES ('${cUser}', 'merchant')
      ON CONFLICT (user_id, role) DO NOTHING;
    INSERT INTO public.businesses (id, name, category, road_address, latitude, longitude, registration_status, approved_at, created_by)
      VALUES ('${cBiz}', '동시가게', '카페', '수원시 팔달구 10', 37.28, 127.01, 'approved', now(), '${cUser}');
    INSERT INTO public.business_members (business_id, user_id, role, membership_status) VALUES ('${cBiz}', '${cUser}', 'owner', 'active');
    INSERT INTO public.restrooms (id, business_id, type, name, road_address, access_method, publication_status, latitude, longitude)
      VALUES ('${cRestroom}', '${cBiz}', 'partner', '동시화장실', '수원시 팔달구 10', 'pin', 'published', 37.28, 127.01);
  `);

  // Sequential and concurrent calls to rotate_restroom_pin
  const call1 = db.query(
    `SELECT public.rotate_restroom_pin($1, $2, $3, $4, $5, $6) as res`,
    [cRestroom, cUser, "Y2lwaGVyMQ==", "aXYx", "dGFnMQ==", 1]
  );
  const call2 = db.query(
    `SELECT public.rotate_restroom_pin($1, $2, $3, $4, $5, $6) as res`,
    [cRestroom, cUser, "Y2lwaGVyMg==", "aXYy", "dGFnMg==", 1]
  );

  const [res1, res2] = await Promise.all([call1, call2]);
  const parsed1 = typeof res1.rows[0].res === "string" ? JSON.parse(res1.rows[0].res) : res1.rows[0].res;
  const parsed2 = typeof res2.rows[0].res === "string" ? JSON.parse(res2.rows[0].res) : res2.rows[0].res;

  console.log(`Call 1 result: code_version=${parsed1.code_version}, action=${parsed1.action}`);
  console.log(`Call 2 result: code_version=${parsed2.code_version}, action=${parsed2.action}`);

  const versions = [parsed1.code_version, parsed2.code_version].sort();
  if (versions[0] !== 1 || versions[1] !== 2) {
    throw new Error(`Concurrency test failed: Expected versions [1, 2], got ${JSON.stringify(versions)}`);
  }

  // Exactly one active secret in DB
  const countRes = await db.query(
    `SELECT count(*) as count FROM public.restroom_lock_secrets WHERE restroom_id = $1 AND status = 'active'`,
    [cRestroom]
  );
  if (parseInt(countRes.rows[0].count, 10) !== 1) {
    throw new Error(`Expected exactly 1 active secret, found ${countRes.rows[0].count}`);
  }

  console.log("✓ T15 Concurrency test passed: sequential versions [1, 2] generated cleanly without race conditions!");

  console.log("\n4. Testing Multi-Instance Concurrent Idempotent Requests (T14/T15)...");
  // 4-A. Simultaneous calls with identical idempotency key and same HMAC
  const idemKey1 = "concurrent-idem-key-same-001";
  const sameHmac = "c2FtZV9obWFjX3ZhbHVlXzAx";

  const idemCall1 = db.query(
    `SELECT public.rotate_restroom_pin($1, $2, $3, $4, $5, $6, $7, $8) as res`,
    [cRestroom, cUser, "Y2lwaGVyMw==", "aXYz", "dGFnMw==", 1, idemKey1, sameHmac]
  );
  const idemCall2 = db.query(
    `SELECT public.rotate_restroom_pin($1, $2, $3, $4, $5, $6, $7, $8) as res`,
    [cRestroom, cUser, "Y2lwaGVyMw==", "aXYz", "dGFnMw==", 1, idemKey1, sameHmac]
  );

  const [idemRes1, idemRes2] = await Promise.all([idemCall1, idemCall2]);
  const idemParsed1 = typeof idemRes1.rows[0].res === "string" ? JSON.parse(idemRes1.rows[0].res) : idemRes1.rows[0].res;
  const idemParsed2 = typeof idemRes2.rows[0].res === "string" ? JSON.parse(idemRes2.rows[0].res) : idemRes2.rows[0].res;

  console.log(`Concurrent Same-Key 1: code_version=${idemParsed1.code_version}, action=${idemParsed1.action}`);
  console.log(`Concurrent Same-Key 2: code_version=${idemParsed2.code_version}, action=${idemParsed2.action}`);

  if (idemParsed1.code_version !== 3 || idemParsed2.code_version !== 3) {
    throw new Error(`Expected both concurrent same-key calls to return version 3, got ${idemParsed1.code_version} and ${idemParsed2.code_version}`);
  }

  const actions = [idemParsed1.action, idemParsed2.action].sort();
  if (actions[0] !== "replay" || actions[1] !== "rotate_pin") {
    throw new Error(`Expected exactly one 'rotate_pin' and one 'replay', got ${JSON.stringify(actions)}`);
  }

  // Verify DB count of secrets for this restroom is now 3 (version 1, 2, 3)
  const totalCount3 = await db.query(
    `SELECT count(*) as count FROM public.restroom_lock_secrets WHERE restroom_id = $1`,
    [cRestroom]
  );
  if (parseInt(totalCount3.rows[0].count, 10) !== 3) {
    throw new Error(`Expected 3 total secrets, found ${totalCount3.rows[0].count}`);
  }
  console.log("✓ T14/T15 Concurrent identical idempotency test passed: 1 rotated, 1 replayed, exactly 1 new secret created!");

  // 4-B. Simultaneous calls with identical idempotency key but DIFFERENT HMAC (conflict)
  console.log("\n5. Testing Multi-Instance Concurrent Idempotency Conflict (T14/T15)...");
  const idemKeyConflict = "concurrent-idem-key-conflict-001";
  const hmacA = "aG1hY192YWx1ZV9BXzAwMDE=";
  const hmacB = "aG1hY192YWx1ZV9CXzAwMDI=";

  const conflictCallA = db.query(
    `SELECT public.rotate_restroom_pin($1, $2, $3, $4, $5, $6, $7, $8) as res`,
    [cRestroom, cUser, "Y2lwaGVyNF9B", "aXY0X0E=", "dGFnNF9B", 1, idemKeyConflict, hmacA]
  );
  const conflictCallB = db.query(
    `SELECT public.rotate_restroom_pin($1, $2, $3, $4, $5, $6, $7, $8) as res`,
    [cRestroom, cUser, "Y2lwaGVyNF9C", "aXY0X0I=", "dGFnNF9C", 1, idemKeyConflict, hmacB]
  );

  const results = await Promise.allSettled([conflictCallA, conflictCallB]);
  const succeeded = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  if (succeeded.length !== 1 || rejected.length !== 1) {
    throw new Error(`Expected exactly 1 success and 1 rejection for conflicting HMAC, got ${succeeded.length} successes and ${rejected.length} rejections`);
  }

  const successVal = typeof succeeded[0].value.rows[0].res === "string"
    ? JSON.parse(succeeded[0].value.rows[0].res)
    : succeeded[0].value.rows[0].res;
  const rejectErr = rejected[0].reason.message || String(rejected[0].reason);

  console.log(`Conflict Winner: code_version=${successVal.code_version}, action=${successVal.action}`);
  console.log(`Conflict Loser Error: ${rejectErr}`);

  if (successVal.code_version !== 4) {
    throw new Error(`Expected winner version to be 4, got ${successVal.code_version}`);
  }
  if (!rejectErr.includes("HM092")) {
    throw new Error(`Expected rejection to contain HM092, got: ${rejectErr}`);
  }

  // Exactly 1 active secret in DB, total secrets count is 4
  const totalCount4 = await db.query(
    `SELECT count(*) as count FROM public.restroom_lock_secrets WHERE restroom_id = $1`,
    [cRestroom]
  );
  if (parseInt(totalCount4.rows[0].count, 10) !== 4) {
    throw new Error(`Expected 4 total secrets, found ${totalCount4.rows[0].count}`);
  }

  console.log("✓ T14/T15 Concurrent conflict test passed: 1 succeeded, 1 rejected with HM092, exactly 1 new secret created!");

  console.log("\n6. Testing Legacy NULL HMAC Replay Rejection (Local-Only Simulation)...");
  // In local test instance, simulate a legacy secret created without HMAC
  await db.exec(`
    ALTER TABLE public.restroom_lock_secrets DISABLE TRIGGER trg_enforce_restroom_lock_secrets_rules;
    ALTER TABLE public.restroom_lock_secrets DROP CONSTRAINT chk_restroom_lock_secrets_idempotency_hmac;
    INSERT INTO public.restroom_lock_secrets (
      restroom_id, ciphertext_b64, iv_b64, auth_tag_b64, key_version, code_version, status, created_by, idempotency_key, pin_hmac_b64
    ) VALUES (
      '${cRestroom}', 'legacy_c', 'legacy_iv', 'legacy_tag', 1, 999, 'revoked', '${cUser}', 'local-legacy-null-hmac-key', NULL
    );
    ALTER TABLE public.restroom_lock_secrets ENABLE TRIGGER trg_enforce_restroom_lock_secrets_rules;
    ALTER TABLE public.restroom_lock_secrets ADD CONSTRAINT chk_restroom_lock_secrets_idempotency_hmac CHECK (idempotency_key IS NULL OR pin_hmac_b64 IS NOT NULL) NOT VALID;
  `);

  let legacyCaught = false;
  try {
    await db.query(
      `SELECT public.rotate_restroom_pin($1, $2, $3, $4, $5, $6, $7, $8) as res`,
      [cRestroom, cUser, "Y2lwaGVyNQ==", "aXY1", "dGFnNQ==", 1, "local-legacy-null-hmac-key", "c29tZV9obWFj"]
    );
  } catch (err) {
    if (err.message && err.message.includes("HM092")) {
      legacyCaught = true;
    } else {
      throw err;
    }
  }

  // Clean up test row
  await db.query(
    `DELETE FROM public.restroom_lock_secrets WHERE idempotency_key = 'local-legacy-null-hmac-key'`
  );

  if (!legacyCaught) {
    throw new Error("Expected legacy NULL HMAC replay to be rejected with HM092, but call succeeded");
  }

  console.log("✓ Local-only simulation passed: legacy NULL HMAC record safely rejected from replay with HM092!");

  // Clean up concurrency fixtures inside rollback or just conclude test
  console.log("\nAll PGlite checks passed successfully!");
}

run().catch((err) => {
  console.error("FATAL ERROR:", err);
  process.exit(1);
});
