import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

async function run() {
  console.log("1. Initializing PGlite instance for TASK 26 Receipt Backend...");
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
  const files = fs.readdirSync(migrationDir).filter((f) => f.endsWith(".sql")).sort();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    console.log(`Applying Migration ${i + 1}/${files.length}: ${file}`);
    const sql = fs.readFileSync(path.join(migrationDir, file), "utf-8");
    await db.exec(sql);
  }

  console.log("\n2. Executing Verification SQL: verify_receipt_backend_rollback.sql");
  const verifySql = fs.readFileSync(
    path.join(ROOT, "tests/integration/sql/verify_receipt_backend_rollback.sql"),
    "utf-8"
  );
  await db.exec(verifySql);
  console.log("✓ Verification SQL DO block completed cleanly (P0099 caught internally and 0 residue verified)!");

  console.log("\n==================================================");
  console.log("TASK 26 ALL INTEGRATION & SQL VERIFICATIONS PASSED!");
  console.log("==================================================");
}

run().catch((err) => {
  console.error("FATAL ERROR in test_pglite_receipt_backend:", err);
  process.exit(1);
});

