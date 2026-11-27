import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

async function run() {
  console.log("1. Booting PGlite and applying all migrations including 20261130000000...");
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

  // Apply Wave 2 batches first, then apply Wave 2 Supplement exclusions + official batches
  const w2Dir = path.join(ROOT, "local-data/nationwide_sql_batches_wave2");
  for (const sf of fs.readdirSync(w2Dir).filter((f) => f.startsWith("00_") || f.startsWith("01_")).sort()) {
    await db.exec(fs.readFileSync(path.join(w2Dir, sf), "utf8"));
  }
  const beforeExcl = await db.query(
    "SELECT count(*)::int AS cnt FROM public.restrooms WHERE publication_status = 'published'"
  );

  const supDir = path.join(ROOT, "local-data/nationwide_sql_batches_wave2_supplement");
  const supFiles = fs
    .readdirSync(supDir)
    .filter((f) => f.startsWith("00_") || f.startsWith("01_") || f.startsWith("02_"))
    .sort();
  assert.ok(supFiles.length >= 3, "Expected supplement exclusion, source, and official batches");

  for (const sf of supFiles) {
    await db.exec(fs.readFileSync(path.join(supDir, sf), "utf8"));
  }

  const afterPublished = await db.query(
    "SELECT count(*)::int AS cnt FROM public.restrooms WHERE publication_status = 'published'"
  );
  const archivedCount = await db.query(
    "SELECT count(*)::int AS cnt FROM public.restrooms WHERE publication_status = 'archived'"
  );
  const policyCount = await db.query(
    "SELECT count(*)::int AS cnt FROM public.restroom_access_policies WHERE is_active = true"
  );
  const totalRows = await db.query("SELECT count(*)::int AS cnt FROM public.restrooms");

  assert.equal(archivedCount.rows[0].cnt, 687, `Expected 687 archived Wave 2 rows (201 KEX + 152 MOF + 334 KNPS), got ${archivedCount.rows[0].cnt}`);
  assert.equal(totalRows.rows[0].cnt, policyCount.rows[0].cnt, "Every restroom must have 1 active policy");

  // Verify anon visibility matches published non-excluded rows and blocks archived KEX/MOF/KNPS rows
  await db.exec("SET ROLE anon;");
  const anonVisible = await db.query("SELECT count(*)::int AS cnt FROM public.restrooms");
  assert.equal(anonVisible.rows[0].cnt, afterPublished.rows[0].cnt);

  // Verify Gyeongbuk (Pohang) and Haeundae and Daejeon Metro and Forest Trail nearby RPC
  const gbNearby = await db.query(
    "SELECT * FROM public.list_nearby_public_restrooms(36.0042562::double precision, 129.3227469::double precision, 400, 'all'::text, 10, 0)"
  );
  assert.ok(gbNearby.rows.length > 0, "Expected Gyeongbuk public restroom near Yeonil-eup");
  const hdNearby = await db.query(
    "SELECT * FROM public.list_nearby_public_restrooms(35.15893::double precision, 129.15969::double precision, 400, 'all'::text, 10, 0)"
  );
  assert.ok(hdNearby.rows.length > 0, "Expected Haeundae public restroom near Beach No.1");
  const djmNearby = await db.query(
    "SELECT * FROM public.list_nearby_public_restrooms(36.316896::double precision, 127.458264::double precision, 400, 'all'::text, 10, 0)"
  );
  assert.ok(djmNearby.rows.length > 0, "Expected Daejeon Metro Panam Station restroom");
  await db.exec("RESET ROLE;");

  // Verify idempotency: re-running supplement files changes 0 counts
  for (const sf of supFiles) {
    await db.exec(fs.readFileSync(path.join(supDir, sf), "utf8"));
  }
  const rerunPublished = await db.query(
    "SELECT count(*)::int AS cnt FROM public.restrooms WHERE publication_status = 'published'"
  );
  assert.equal(rerunPublished.rows[0].cnt, afterPublished.rows[0].cnt, "Supplement batches must be idempotent");

  console.log(
    `PGlite Wave 2 Supplement PASSED! (before=${beforeExcl.rows[0].cnt}, archived=${archivedCount.rows[0].cnt}, published=${afterPublished.rows[0].cnt}, idempotent)`
  );
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
