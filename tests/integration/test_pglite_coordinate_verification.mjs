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

  const migrationFiles = fs
    .readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const mf of migrationFiles) {
    console.log(`Applying ${mf}...`);
    const sql = fs.readFileSync(path.join(ROOT, "supabase/migrations", mf), "utf8");
    await db.exec(sql);
  }

  // Verify new constraints, columns, RLS, and trigger protections in an isolated transaction
  await db.exec(`
    BEGIN;
    INSERT INTO public.public_data_sources (id, provider_name, dataset_name, source_url)
    VALUES ('00000000-0000-0000-0000-000000000001', '경기도', 'Publtolt', 'https://example.com');

    INSERT INTO public.restrooms (
      id, source_id, source_record_id, type, name, road_address, latitude, longitude,
      access_method, publication_status, coordinate_source, coordinate_source_id,
      coordinate_source_record_id, coordinate_type, coordinate_verification_status,
      coordinate_verification_basis, coordinate_source_version
    ) VALUES (
      '00000000-0000-0000-0000-000000000002',
      '00000000-0000-0000-0000-000000000001',
      'TEST-REC-1',
      'public',
      '테스트화장실',
      '경기도 부천시 원미구 길주로 100',
      37.503,
      126.766,
      'open',
      'draft',
      'gg_publtolt_15011425',
      '00000000-0000-0000-0000-000000000001',
      'GG-1',
      'facility_official',
      'VERIFIED',
      'official_1to1+mois_1to1',
      '2023-12-19'
    );

    INSERT INTO public.restroom_coordinate_candidates (
      restroom_id, candidate_source, candidate_source_record_id,
      candidate_coord_type, source_version, latitude, longitude,
      verification_status, verification_basis, review_reasons
    ) VALUES (
      '00000000-0000-0000-0000-000000000002',
      'mois_address_nav_db',
      '4119210100110000000000001',
      'building_centroid',
      '2026-10',
      37.50301,
      126.76601,
      'CANDIDATE',
      'mois_1to1_only',
      '{}'
    );

    -- Verify anon cannot read restroom_coordinate_candidates
    SET LOCAL ROLE anon;
    DO $$
    BEGIN
      PERFORM count(*) FROM public.restroom_coordinate_candidates;
      RAISE EXCEPTION 'Expected anon SELECT on candidates to fail';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END $$;
    RESET ROLE;

    -- Verify invalid verification_status is rejected
    DO $$
    BEGIN
      UPDATE public.restrooms
      SET coordinate_verification_status = 'INVALID_STATUS'
      WHERE id = '00000000-0000-0000-0000-000000000002';
      RAISE EXCEPTION 'Expected invalid verification status check to fail';
    EXCEPTION WHEN check_violation THEN
      NULL;
    END $$;

    ROLLBACK;
  `);

  console.log("SUCCESS: All migrations + Phase 2 verification schema checks passed in PGlite!");
  await db.close();
}

run().catch((err) => {
  console.error("PGlite Phase 2 verification FAILED:", err);
  process.exit(1);
});
