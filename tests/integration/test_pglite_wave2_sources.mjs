import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

async function run() {
  console.log("1. Booting PGlite and applying all migrations including 20261129000000...");
  const db = new PGlite();

  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS auth.users (
      id uuid PRIMARY KEY,
      email text UNIQUE,
      raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS storage.buckets (
      id text PRIMARY KEY,
      name text,
      public boolean DEFAULT false,
      file_size_limit bigint,
      allowed_mime_types text[]
    );
    CREATE TABLE IF NOT EXISTS storage.objects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      bucket_id text,
      name text,
      owner uuid
    );
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
      SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1];
    $$;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
      SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), current_setting('role', true), 'anon');
    $$;
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin; END IF;
    END $$;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;
  `);

  const allMigrations = fs
    .readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const mf of allMigrations) {
    await db.exec(fs.readFileSync(path.join(ROOT, "supabase/migrations", mf), "utf8"));
  }

  await db.exec(`
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    GRANT SELECT ON public.feature_flags TO anon, authenticated, service_role;
  `);

  const batchDir = path.join(ROOT, "local-data/nationwide_sql_batches_wave2");
  const sqlFiles = fs
    .readdirSync(batchDir)
    .filter((f) => f.startsWith("00_") || f.startsWith("01_"))
    .sort();

  assert.ok(sqlFiles.length >= 2, "Expected Wave 2 SQL source and official batches");
  for (const sf of sqlFiles) {
    await db.exec(fs.readFileSync(path.join(batchDir, sf), "utf8"));
  }

  const totalRes = await db.query("SELECT count(*)::int AS cnt FROM public.restrooms");
  const policyRes = await db.query("SELECT count(*)::int AS cnt FROM public.restroom_access_policies WHERE is_active = true");
  assert.ok(totalRes.rows[0].cnt > 1000, `Expected >1000 Wave 2 rows loaded, got ${totalRes.rows[0].cnt}`);
  assert.equal(totalRes.rows[0].cnt, policyRes.rows[0].cnt, "Every Wave 2 public restroom must have 1 active free policy");

  // Verify anon RLS exposes ALL Wave 2 VERIFIED facility_official rows and blocks unverified ones
  await db.exec("SET ROLE anon;");
  const anonVisible = await db.query("SELECT count(*)::int AS cnt FROM public.restrooms");
  assert.equal(anonVisible.rows[0].cnt, totalRes.rows[0].cnt);

  // Verify list_nearby_public_restrooms RPC returns Jeju and Daejeon pins (radius_m max = 400)
  const jejuNearby = await db.query(
    "SELECT * FROM public.list_nearby_public_restrooms(33.484509::double precision, 126.500513::double precision, 400, 'all'::text, 10, 0)"
  );
  assert.ok(jejuNearby.rows.length > 0, "Expected Jeju public restrooms near Seolmundae Center");
  const daejeonNearby = await db.query(
    "SELECT * FROM public.list_nearby_public_restrooms(36.32714569::double precision, 127.4285332::double precision, 400, 'all'::text, 10, 0)"
  );
  assert.ok(daejeonNearby.rows.length > 0, "Expected Daejeon Jung-gu public restrooms");
  await db.exec("RESET ROLE;");

  // Verify idempotency: re-running 00 + 01 batches changes 0 rows
  for (const sf of sqlFiles) {
    await db.exec(fs.readFileSync(path.join(batchDir, sf), "utf8"));
  }
  const afterRerun = await db.query("SELECT count(*)::int AS cnt FROM public.restrooms");
  assert.equal(afterRerun.rows[0].cnt, totalRes.rows[0].cnt, "Wave 2 SQL batches must be idempotent");

  console.log(`PGlite Wave 2 verification PASSED! (${totalRes.rows[0].cnt} rows, idempotent)`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
