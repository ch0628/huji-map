import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

async function run() {
  console.log("1. Initializing PGlite instance for TASK 21 payment atomic operations...");
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

  console.log("\nExecuting Verification SQL: verify_payment_atomic_rollback.sql");
  const vSql = fs.readFileSync(
    path.join(ROOT, "tests/integration/sql/verify_payment_atomic_rollback.sql"),
    "utf8"
  );

  await db.exec(vSql);
  console.log("✓ Verification SQL DO block completed cleanly (P0099 caught internally and 0 residue verified)!");
  console.log("\nAll PGlite checks passed!");
}

run().catch((err) => {
  console.error("FATAL ERROR:", err);
  process.exit(1);
});

