import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

async function run() {
  console.log("1. Initializing isolated PGlite for Phase 3-D final Canary deployment rehearsal...");
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
  const remoteBaseline = allMigrations.filter((f) => f <= "20261123010000_z");
  const pendingMigrations = allMigrations.filter((f) => f > "20261123010000_z");

  for (const mf of remoteBaseline) {
    await db.exec(fs.readFileSync(path.join(ROOT, "supabase/migrations", mf), "utf8"));
  }
  await db.exec(`
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    GRANT SELECT ON public.feature_flags TO anon, authenticated, service_role;
    UPDATE public.feature_flags SET enabled = true WHERE key = 'partner_restroom_discovery';
  `);

  const suwonExport = JSON.parse(
    fs.readFileSync(path.join(ROOT, "local-data/suwon_remote_export.json"), "utf8")
  );
  const finalPkg = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, "local-data/address-db-poc/phase3d/seoul_canary_final_package.json"),
      "utf8"
    )
  );
  assert.ok(finalPkg.restrooms.length > 0, "Expected non-empty Phase 3-D final package");

  // Seed Suwon 502 baseline
  for (const src of suwonExport.publicDataSources) {
    await db.query(
      `INSERT INTO public.public_data_sources (
         id, provider_name, dataset_name, source_url, api_endpoint,
         license_name, license_url, attribution_text, last_synced_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        src.id,
        src.provider_name,
        src.dataset_name,
        src.source_url,
        src.api_endpoint,
        src.license_name,
        src.license_url,
        src.attribution_text,
        src.last_synced_at,
      ]
    );
  }
  for (const r of suwonExport.restrooms) {
    await db.query(
      `INSERT INTO public.restrooms (
         id, business_id, source_id, source_record_id,
         coordinate_source, coordinate_source_id, coordinate_source_record_id,
         type, name, description, road_address, address_detail,
         latitude, longitude, floor, entrance_instructions,
         gender_type, wheelchair_accessible, baby_changing_available,
         sanitary_products_available, access_method, publication_status, last_verified_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
       )`,
      [
        r.id, r.business_id, r.source_id, r.source_record_id,
        r.coordinate_source, r.coordinate_source_id, r.coordinate_source_record_id,
        r.type, r.name, r.description, r.road_address, r.address_detail,
        r.latitude, r.longitude, r.floor, r.entrance_instructions,
        r.gender_type, r.wheelchair_accessible, r.baby_changing_available,
        r.sanitary_products_available, r.access_method, r.publication_status, r.last_verified_at,
      ]
    );
  }
  for (const p of suwonExport.restroomAccessPolicies ?? []) {
    await db.query(
      `INSERT INTO public.restroom_access_policies (
         id, restroom_id, version, access_mode, deposit_amount_krw,
         refund_eligible, receipt_window_hours, min_purchase_krw, is_active
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        p.id, p.restroom_id, p.version, p.access_mode, p.deposit_amount_krw,
        p.refund_eligible, p.receipt_window_hours, p.min_purchase_krw, p.is_active,
      ]
    );
  }

  // Seed remote partner '진미 통닭' (coordinate_source=null) + test_deposit + PIN secret
  const partnerOwnerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const partnerBizId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  const partnerRestroomId = "f633c2d1-0455-4fe0-b947-a68dd2aa23d9";
  await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'jinmi@example.test')`, [partnerOwnerId]);
  await db.query(
    `INSERT INTO public.businesses (
       id, name, category, road_address, latitude, longitude,
       registration_status, created_by, approved_at
     ) VALUES ($1, '진미 통닭', '음식점', '경기 수원시 팔달구 정조로800번길 21', 37.2796601767608, 127.018105958305, 'approved', $2, now())`,
    [partnerBizId, partnerOwnerId]
  );
  await db.query(
    `INSERT INTO public.restrooms (
       id, business_id, source_id, type, name, road_address,
       latitude, longitude, gender_type, access_method, publication_status, coordinate_source
     ) VALUES (
       $1, $2, NULL, 'partner', '진미 통닭', '경기 수원시 팔달구 정조로800번길 21',
       37.2796601767608, 127.018105958305, 'separate', 'pin', 'published', NULL
     )`,
    [partnerRestroomId, partnerBizId]
  );
  await db.query(
    `INSERT INTO public.restroom_access_policies (
       restroom_id, version, access_mode, deposit_amount_krw,
       refund_eligible, receipt_window_hours, min_purchase_krw, is_active
     ) VALUES ($1, 1, 'test_deposit', 1000, true, 24, 3000, true)`,
    [partnerRestroomId]
  );
  await db.query(
    `INSERT INTO public.restroom_lock_secrets (
       restroom_id, ciphertext_b64, iv_b64, auth_tag_b64,
       key_version, code_version, status, created_by
     ) VALUES ($1, 'ZHVtbXktY2lwaGVydGV4dA==', 'ZHVtbXktaXY=', 'ZHVtbXktdGFn', 1, 1, 'active', $2)`,
    [partnerRestroomId, partnerOwnerId]
  );

  await db.exec("BEGIN; SET LOCAL ROLE anon;");
  const preBaselineSnapshot = (
    await db.query(`
      SELECT
        r.id, r.type, r.name, r.road_address, r.latitude, r.longitude,
        r.access_method, p.access_mode, p.deposit_amount_krw
      FROM public.restrooms r
      JOIN public.restroom_access_policies p ON p.restroom_id = r.id AND p.is_active = true
      ORDER BY r.id ASC
    `)
  ).rows;
  const preRpc = (
    await db.query(`SELECT * FROM public.list_nearby_public_restrooms(37.27966, 127.0181, 400, 'all', 100, 0)`)
  ).rows;
  await db.exec("COMMIT;");
  assert.equal(preBaselineSnapshot.length, 503);

  // Apply 20261124000000 + 20261125000000
  for (const mf of pendingMigrations) {
    await db.exec(fs.readFileSync(path.join(ROOT, "supabase/migrations", mf), "utf8"));
  }
  console.log(`2. Applied ${pendingMigrations.length} pending migrations on top of 22 baseline migrations.`);

  // Verify old-runtime compatibility + adversarial leak prevention
  const leakSrcId = "ffffffff-ffff-4fff-8fff-fffffffffff1";
  await db.query(
    `INSERT INTO public.public_data_sources (id, provider_name, dataset_name, source_url)
     VALUES ($1, 'LEAK', 'LEAK', 'https://example.test')`,
    [leakSrcId]
  );
  for (const [id, src, ctype, vs] of [
    ["ffffffff-ffff-4fff-8fff-fffffffffff2", "mois_address_nav_db", "building_centroid", "VERIFIED"],
    ["ffffffff-ffff-4fff-8fff-fffffffffff3", "kakao_geocode", "geocoded", "VERIFIED"],
    ["ffffffff-ffff-4fff-8fff-fffffffffff4", "seoul_public_toilet_info", "facility_official", "REVIEW_REQUIRED"],
    ["ffffffff-ffff-4fff-8fff-fffffffffff5", null, null, null],
  ]) {
    await db.query(
      `INSERT INTO public.restrooms (
         id, source_id, source_record_id, type, name, road_address,
         latitude, longitude, access_method, publication_status,
         coordinate_source, coordinate_type, coordinate_verification_status
       ) VALUES ($1,$2,$6,'public','LEAK_ROW','테스트',37.28,127.018,'open','published',$3,$4,$5)`,
      [id, leakSrcId, src, ctype, vs, id]
    );
  }
  await db.exec("BEGIN; SET LOCAL ROLE anon;");
  const postFilterCheck = (
    await db.query(`SELECT id FROM public.restrooms ORDER BY id ASC`)
  ).rows;
  assert.equal(postFilterCheck.length, 503, "All 4 adversarial published rows must be blocked by RLS");
  await db.exec("COMMIT;");
  await db.query(`DELETE FROM public.restrooms WHERE source_id = $1`, [leakSrcId]);
  await db.query(`DELETE FROM public.public_data_sources WHERE id = $1`, [leakSrcId]);
  console.log("3. Old-runtime SELECT & adversarial published leak guard verified (0/4 leaked).");

  // Failed batch rollback test
  const seoulSourceId = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
  await db.exec("BEGIN");
  try {
    await db.query(
      `INSERT INTO public.public_data_sources (
         id, provider_name, dataset_name, source_url, api_endpoint,
         license_name, license_url, attribution_text
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        seoulSourceId,
        finalPkg.publicDataSource.providerName,
        finalPkg.publicDataSource.datasetName,
        finalPkg.publicDataSource.sourceUrl,
        finalPkg.publicDataSource.apiEndpoint,
        finalPkg.publicDataSource.licenseName,
        finalPkg.publicDataSource.licenseUrl,
        finalPkg.publicDataSource.attributionText,
      ]
    );
    const first = finalPkg.restrooms[0];
    await db.query(
      `INSERT INTO public.restrooms (
         id, source_id, source_record_id, type, name, road_address,
         latitude, longitude, access_method, publication_status,
         coordinate_source, coordinate_type, coordinate_verification_status
       ) VALUES ($1,$2,$3,'public',$4,$5,$6,$7,'open','published',$8,$9,$10)`,
      [
        first.id, seoulSourceId, first.source_record_id, first.name, first.road_address,
        first.latitude, first.longitude, first.coordinate_source, first.coordinate_type, first.coordinate_verification_status,
      ]
    );
    // Deliberate error: invalid source check violation
    await db.query(
      `INSERT INTO public.restrooms (
         id, source_id, source_record_id, type, name, road_address,
         latitude, longitude, access_method, publication_status, coordinate_source
       ) VALUES (gen_random_uuid(), $1, 'ERR', 'public', 'ERR', 'ERR', 37.5, 127.0, 'open', 'published', 'illegal_src')`,
      [seoulSourceId]
    );
    assert.fail("Expected constraint error");
  } catch (err) {
    assert.equal(err.code, "23514");
    await db.exec("ROLLBACK");
  }
  const postAbortCnt = Number((await db.query(`SELECT count(*) AS cnt FROM public.restrooms`)).rows[0].cnt);
  assert.equal(postAbortCnt, 503);
  console.log("4. Single-transaction batch failure rollback passed (0 partial rows retained).");

  // Live single-transaction load of Phase 3-D final package
  const runId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee9";
  await db.exec("BEGIN");
  await db.query(
    `INSERT INTO public.public_data_sources (
       id, provider_name, dataset_name, source_url, api_endpoint,
       license_name, license_url, attribution_text, last_synced_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
    [
      seoulSourceId,
      finalPkg.publicDataSource.providerName,
      finalPkg.publicDataSource.datasetName,
      finalPkg.publicDataSource.sourceUrl,
      finalPkg.publicDataSource.apiEndpoint,
      finalPkg.publicDataSource.licenseName,
      finalPkg.publicDataSource.licenseUrl,
      finalPkg.publicDataSource.attributionText,
    ]
  );
  await db.query(
    `INSERT INTO public.public_import_runs (id, source_id, status, fetched_count)
     VALUES ($1, $2, 'running', $3)`,
    [runId, seoulSourceId, finalPkg.restrooms.length]
  );

  for (const r of finalPkg.restrooms) {
    await db.query(
      `INSERT INTO public.restrooms (
         id, business_id, source_id, source_record_id, type, name, description,
         road_address, address_detail, latitude, longitude, gender_type,
         wheelchair_accessible, baby_changing_available, sanitary_products_available,
         access_method, publication_status, last_verified_at,
         coordinate_source, coordinate_source_id, coordinate_source_record_id,
         coordinate_type, coordinate_verification_status,
         coordinate_verification_basis, coordinate_source_version
       ) VALUES (
         $1, NULL, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11,
         $12, $13, $14,
         $15, $16, $17,
         $18, $19, $20,
         $21, $22, $23, $24
       )
       ON CONFLICT (source_id, source_record_id) WHERE source_id IS NOT NULL AND source_record_id IS NOT NULL DO NOTHING`,
      [
        r.id, seoulSourceId, r.source_record_id, r.type, r.name, r.description,
        r.road_address, r.address_detail, r.latitude, r.longitude, r.gender_type,
        r.wheelchair_accessible, r.baby_changing_available, r.sanitary_products_available,
        r.access_method, r.publication_status, r.last_verified_at,
        r.coordinate_source, seoulSourceId, r.coordinate_source_record_id,
        r.coordinate_type, r.coordinate_verification_status,
        r.coordinate_verification_basis, r.coordinate_source_version,
      ]
    );
  }
  for (const p of finalPkg.restroomAccessPolicies) {
    await db.query(
      `INSERT INTO public.restroom_access_policies (
         restroom_id, version, access_mode, deposit_amount_krw,
         refund_eligible, receipt_window_hours, min_purchase_krw, is_active
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT DO NOTHING`,
      [p.restroom_id, p.version, p.access_mode, p.deposit_amount_krw, p.refund_eligible, p.receipt_window_hours, p.min_purchase_krw, p.is_active]
    );
  }
  for (const c of finalPkg.restroomCoordinateCandidates) {
    await db.query(
      `INSERT INTO public.restroom_coordinate_candidates (
         restroom_id, candidate_source, candidate_source_record_id,
         candidate_coord_type, source_version, latitude, longitude,
         verification_status, verification_basis, review_reasons, is_selected
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT DO NOTHING`,
      [c.restroom_id, c.candidate_source, c.candidate_source_record_id, c.candidate_coord_type, c.source_version, c.latitude, c.longitude, c.verification_status, c.verification_basis, c.review_reasons, c.is_selected]
    );
  }
  await db.query(
    `UPDATE public.public_import_runs SET status = 'success', finished_at = now(), inserted_count = $2 WHERE id = $1`,
    [runId, finalPkg.restrooms.length]
  );
  await db.exec("COMMIT");
  console.log(`5. Loaded Phase 3-D final package (${finalPkg.restrooms.length} OFFICIAL_SOURCE_VALIDATED Seoul restrooms).`);

  // Verify ALL 10 loaded Seoul rows via anon RLS + RPC + policy + basis + Suwon 502 full regression
  await db.exec("BEGIN; SET LOCAL ROLE anon;");
  const suwonPost = (
    await db.query(`
      SELECT
        r.id, r.type, r.name, r.road_address, r.latitude, r.longitude,
        r.access_method, p.access_mode, p.deposit_amount_krw
      FROM public.restrooms r
      JOIN public.restroom_access_policies p ON p.restroom_id = r.id AND p.is_active = true
      WHERE r.coordinate_source IS DISTINCT FROM 'seoul_public_toilet_info'
      ORDER BY r.id ASC
    `)
  ).rows;
  const seoulLoadedRows = (
    await db.query(`
      SELECT r.id, r.name, r.coordinate_source, r.coordinate_type, r.coordinate_verification_status, r.coordinate_verification_basis, r.description, p.access_mode
      FROM public.restrooms r
      JOIN public.restroom_access_policies p ON p.restroom_id = r.id AND p.is_active = true
      WHERE r.coordinate_source = 'seoul_public_toilet_info'
      ORDER BY r.name ASC
    `)
  ).rows;
  const postRpc = (
    await db.query(`SELECT * FROM public.list_nearby_public_restrooms(37.27966, 127.0181, 400, 'all', 100, 0)`)
  ).rows;

  // Verify every loaded Seoul point is searchable via nearby RPC + valid coordinates for directions
  for (const r of finalPkg.restrooms) {
    const hits = (
      await db.query(`SELECT * FROM public.list_nearby_public_restrooms($1, $2, 400, 'public', 20, 0)`, [
        r.latitude,
        r.longitude,
      ])
    ).rows;
    assert.ok(hits.some((h) => h.id === r.id && Number(h.distance_meters) < 1));
  }
  await db.exec("COMMIT;");

  assert.deepEqual(suwonPost, preBaselineSnapshot, "Suwon 502 + 진미 통닭 must be byte-for-byte identical");
  assert.deepEqual(postRpc, preRpc, "Suwon RPC results must be byte-for-byte identical");
  assert.equal(seoulLoadedRows.length, finalPkg.restrooms.length);
  for (const row of seoulLoadedRows) {
    assert.equal(row.access_mode, "free");
    assert.ok(row.coordinate_verification_basis.includes("POLICY=OFFICIAL_SOURCE_VALIDATED"));
    assert.ok(row.coordinate_verification_basis.includes("FIELD_VERIFIED=false"));
    assert.ok(row.description.includes("공공누리 제1유형"));
  }

  // Idempotent re-run check
  let retryInserted = 0;
  for (const r of finalPkg.restrooms) {
    const res = await db.query(
      `INSERT INTO public.restrooms (
         id, source_id, source_record_id, type, name, road_address,
         latitude, longitude, access_method, publication_status,
         coordinate_source, coordinate_type, coordinate_verification_status
       ) VALUES ($1,$2,$3,'public',$4,$5,$6,$7,'open','published',$8,$9,$10)
       ON CONFLICT (source_id, source_record_id) WHERE source_id IS NOT NULL AND source_record_id IS NOT NULL DO NOTHING`,
      [
        r.id, seoulSourceId, r.source_record_id, r.name, r.road_address,
        r.latitude, r.longitude, r.coordinate_source, r.coordinate_type, r.coordinate_verification_status,
      ]
    );
    retryInserted += res.affectedRows ?? 0;
  }
  assert.equal(retryInserted, 0, "Idempotent re-run must insert 0 rows");

  // Clean data rollback check
  await db.exec("BEGIN");
  await db.query(`DELETE FROM public.restrooms WHERE source_id = $1`, [seoulSourceId]);
  await db.query(`DELETE FROM public.public_import_runs WHERE source_id = $1`, [seoulSourceId]);
  await db.query(`DELETE FROM public.public_data_sources WHERE id = $1`, [seoulSourceId]);
  await db.exec("COMMIT");

  const finalCnt = Number((await db.query(`SELECT count(*) AS cnt FROM public.restrooms`)).rows[0].cnt);
  assert.equal(finalCnt, 503);
  console.log("6. Post-load search/detail/Suwon 502 regression, idempotent re-run (0 dup), and rollback (503 restored) passed!");

  console.log("SUCCESS: All Phase 3-D rehearsal checks passed!");
  await db.close();
}

run().catch((err) => {
  console.error("Phase 3-D rehearsal FAILED:", err);
  process.exit(1);
});
