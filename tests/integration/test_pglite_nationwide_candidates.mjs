import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

async function run() {
  console.log("1. Booting PGlite and applying all migrations through 20261126000000...");
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

  // Verify no coordinate/geohash columns on public_restroom_candidates
  const colsRes = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'public_restroom_candidates'`
  );
  const colNames = new Set(colsRes.rows.map((r) => r.column_name));
  assert.ok(!colNames.has("latitude"), "Candidate table must NOT store latitude");
  assert.ok(!colNames.has("longitude"), "Candidate table must NOT store longitude");
  assert.ok(!colNames.has("geohash"), "Candidate table must NOT store geohash");
  assert.ok(colNames.has("facility_hash"));
  assert.ok(colNames.has("coordinate_status"));
  assert.ok(colNames.has("sido_code"));
  assert.ok(colNames.has("sigungu_code"));
  assert.ok(colNames.has("eupmyeondong_code"));

  // Verify new official sources work ONLY with facility_official + VERIFIED
  const srcId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  await db.query(
    `INSERT INTO public.public_data_sources (id, provider_name, dataset_name, source_url, license_name)
     VALUES ($1, '전북특별자치도', '전북특별자치도_공중화장실현황', 'https://www.data.go.kr/data/15134318/fileData.do', '이용허락범위 제한 없음')`,
    [srcId]
  );

  // Allowed official restroom
  await db.query(
    `INSERT INTO public.restrooms (
      id, type, source_id, source_record_id, name, road_address, latitude, longitude,
      publication_status, coordinate_source, coordinate_type, coordinate_verification_status
    ) VALUES (
      '11111111-1111-4111-8111-111111111101', 'public', $1, 'JB-1', '전주 한옥마을 화장실',
      '전북특별자치도 전주시 완산구 기린대로 99', 35.815, 127.152,
      'published', 'jeonbuk_public_toilet', 'facility_official', 'VERIFIED'
    )`,
    [srcId]
  );

  // Blocked MOIS restroom even if published
  await db.query(
    `INSERT INTO public.restrooms (
      id, type, source_id, source_record_id, name, road_address, latitude, longitude,
      publication_status, coordinate_source, coordinate_type, coordinate_verification_status
    ) VALUES (
      '11111111-1111-4111-8111-111111111102', 'public', $1, 'MOIS-1', '차단 테스트',
      '전북특별자치도 전주시 완산구 기린대로 100', 35.8151, 127.1521,
      'published', 'mois_address_nav_db', 'building_centroid', 'CANDIDATE'
    )`,
    [srcId]
  );

  await db.exec("SET ROLE anon;");
  const visibleRestrooms = await db.query("SELECT id FROM public.restrooms");
  assert.equal(visibleRestrooms.rows.length, 1);
  assert.equal(visibleRestrooms.rows[0].id, "11111111-1111-4111-8111-111111111101");
  await db.exec("RESET ROLE;");

  // Insert candidate records (including duplicate facility_hash rows to verify non-unique hash)
  const sharedHash = crypto.createHash("sha256").update("공원화장실::전북전주시").digest("hex").slice(0, 32);
  await db.query(
    `INSERT INTO public.public_restroom_candidates (
      source_provider, source_dataset_id, source_record_id,
      name, normalized_name, road_address, jibun_address, normalized_address,
      sido_code, sigungu_code, eupmyeondong_code, sido_name, sigungu_name, eupmyeondong_name,
      coordinate_status, facility_hash, license_name
    ) VALUES
      ('행정안전부', '15012892', 'CAND-1', '공원화장실 A', '공원화장실a', '전북특별자치도 전주시 완산구 팔달로 1', NULL, '전북특별자치도전주시완산구팔달로1',
       '52', '35011', NULL, '전북특별자치도', '전주시 완산구', '중앙동', 'unlocated', $1, '이용허락범위 제한 없음'),
      ('행정안전부', '15012892', 'CAND-2', '공원화장실 B', '공원화장실b', '전북특별자치도 전주시 완산구 팔달로 1', NULL, '전북특별자치도전주시완산구팔달로1',
       '52', '35011', NULL, '전북특별자치도', '전주시 완산구', '중앙동', 'unlocated', $1, '이용허락범위 제한 없음'),
      ('행정안전부', '15012892', 'CAND-3', '전주 한옥마을 화장실', '전주한옥마을화장실', '전북특별자치도 전주시 완산구 기린대로 99', NULL, '전북특별자치도전주시완산구기린대로99',
       '52', '35011', NULL, '전북특별자치도', '전주시 완산구', '풍남동', 'official_matched', $1, '이용허락범위 제한 없음')`,
    [sharedHash]
  );

  // Verify anon sees ONLY unlocated (2 rows), NOT official_matched
  await db.exec("SET ROLE anon;");
  const anonCands = await db.query("SELECT source_record_id FROM public.public_restroom_candidates ORDER BY source_record_id");
  assert.deepEqual(anonCands.rows.map((r) => r.source_record_id), ["CAND-1", "CAND-2"]);

  // Verify anon cannot write to public_restroom_candidates
  let writeBlocked = false;
  try {
    await db.query(
      `INSERT INTO public.public_restroom_candidates (
        source_provider, source_dataset_id, source_record_id,
        name, normalized_name, road_address, normalized_address,
        sido_code, sigungu_code, sido_name, sigungu_name, facility_hash
      ) VALUES ('x','x','x','x','x','x','x','11','11010','서울','종로구','0123456789abcdef')`
    );
  } catch (e) {
    writeBlocked = true;
  }
  assert.ok(writeBlocked, "anon write to public_restroom_candidates must fail");
  await db.exec("RESET ROLE;");

  console.log("PGlite migration 20261126000000 verification PASSED!");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
