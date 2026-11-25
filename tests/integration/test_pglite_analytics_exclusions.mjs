import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

async function run() {
  console.log("1. Initializing PGlite instance...");
  const db = new PGlite();

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
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
        CREATE ROLE supabase_auth_admin;
      END IF;
    END $$;
  `);

  const migrationFiles = [
    "supabase/migrations/20261106000000_auth_schema.sql",
    "supabase/migrations/20261127000000_anonymous_daily_usage_counts.sql",
    "supabase/migrations/20261128000000_analytics_excluded_accounts.sql",
  ];

  for (const file of migrationFiles) {
    console.log(`Applying ${file}...`);
    await db.exec(fs.readFileSync(path.join(ROOT, file), "utf8"));
  }

  console.log("Running verify_analytics_excluded_accounts_rollback.sql...");
  await db.exec(
    fs.readFileSync(
      path.join(ROOT, "tests/integration/sql/verify_analytics_excluded_accounts_rollback.sql"),
      "utf8"
    )
  );

  console.log("SUCCESS! analytics_excluded_accounts migration & RLS/index verification PASSED in PGlite!");
  await db.close();
}

run().catch((err) => {
  console.error("PGlite analytics exclusions verification failed:", err);
  process.exit(1);
});
