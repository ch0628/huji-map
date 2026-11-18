import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

async function run() {
  console.log("1. Initializing PGlite instance...");
  const db = new PGlite();

  db.onNotification((msg) => {
    console.log("NOTIF:", msg);
  });

  // Setup Supabase auth mock infrastructure
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
        CREATE ROLE service_role;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
        CREATE ROLE supabase_auth_admin;
      END IF;
    END $$;
  `);

  console.log("2. Applying Migration 1: 20261106000000_auth_schema.sql");
  const m1 = fs.readFileSync(path.join(ROOT, "supabase/migrations/20261106000000_auth_schema.sql"), "utf8");
  await db.exec(m1);

  console.log("3. Applying Migration 2: 20261107000000_lead_tracking.sql");
  const m2 = fs.readFileSync(path.join(ROOT, "supabase/migrations/20261107000000_lead_tracking.sql"), "utf8");
  await db.exec(m2);

  console.log("4. Applying Migration 3: 20261108000000_business_backend.sql");
  const m3 = fs.readFileSync(path.join(ROOT, "supabase/migrations/20261108000000_business_backend.sql"), "utf8");
  await db.exec(m3);

  console.log("5. Applying Migration 4: 20261109000000_audit_and_approval.sql");
  const m4 = fs.readFileSync(path.join(ROOT, "supabase/migrations/20261109000000_audit_and_approval.sql"), "utf8");
  await db.exec(m4);

  console.log("6. Executing Verification SQL: verify_approval_rls_rollback.sql");
  const vSql = fs.readFileSync(path.join(ROOT, "tests/integration/sql/verify_approval_rls_rollback.sql"), "utf8");
  await db.exec(vSql);

  console.log("SUCCESS! All 4 migrations and all 14 verification groups PASSED in PGlite!");
  await db.close();
}

run().catch((err) => {
  console.error("PGlite execution failed:", err);
  process.exit(1);
});
