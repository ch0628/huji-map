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
        CREATE ROLE service_role;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
        CREATE ROLE supabase_auth_admin;
      END IF;
    END $$;
  `);

  console.log("2. Applying auth schema (20261106000000_auth_schema.sql)...");
  await db.exec(
    fs.readFileSync(
      path.join(ROOT, "supabase/migrations/20261106000000_auth_schema.sql"),
      "utf8"
    )
  );

  console.log("3. Applying daily usage counts migration (20261127000000_anonymous_daily_usage_counts.sql)...");
  await db.exec(
    fs.readFileSync(
      path.join(
        ROOT,
        "supabase/migrations/20261127000000_anonymous_daily_usage_counts.sql"
      ),
      "utf8"
    )
  );

  console.log("4. Running rollback & security verification SQL...");
  await db.exec(
    fs.readFileSync(
      path.join(
        ROOT,
        "tests/integration/sql/verify_anonymous_daily_usage_counts_rollback.sql"
      ),
      "utf8"
    )
  );

  console.log("SUCCESS! Anonymous daily usage counts migration & RLS/RPC verification PASSED in PGlite!");
  await db.close();
}

run().catch((err) => {
  console.error("PGlite daily usage verification failed:", err);
  process.exit(1);
});
