import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

async function run() {
  console.log("1. Initializing PGlite for Phase 3-C deployment & rollback rehearsal...");
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

  const remoteBaselineMigrations = allMigrations.filter((f) => f <= "20261123010000_z");
  const pendingMigrations = allMigrations.filter((f) => f > "20261123010000_z");
  assert.deepEqual(pendingMigrations, [
    "20261124000000_restroom_coordinate_verification.sql",
    "20261125000000_restroom_public_exposure_filter.sql",
  ]);

  // Step 1A: Apply exact remote baseline (22 migrations: 20261106..20261123010000)
  for (const mf of remoteBaselineMigrations) {
    await db.exec(fs.readFileSync(path.join(ROOT, "supabase/migrations", mf), "utf8"));
  }
  await db.exec(`
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    GRANT SELECT ON public.feature_flags TO anon, authenticated, service_role;
    UPDATE public.feature_flags SET enabled = true WHERE key = 'partner_restroom_discovery';
  `);
  console.log(`   Applied remote baseline migrations (${remoteBaselineMigrations.length} files).`);

  // Seed all 502 Suwon public restrooms + remote partner '진미 통닭' (coordinate_source=null)
  const suwonExport = JSON.parse(
    fs.readFileSync(path.join(ROOT, "local-data/suwon_remote_export.json"), "utf8")
  );
  const canary10Pkg = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, "local-data/address-db-poc/phase3c/seoul_pilot_10_package.json"),
      "utf8"
    )
  );
  const pilot50Pkg = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, "local-data/address-db-poc/phase3c/seoul_pilot_50_package.json"),
      "utf8"
    )
  );

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
        r.id,
        r.business_id,
        r.source_id,
        r.source_record_id,
        r.coordinate_source,
        r.coordinate_source_id,
        r.coordinate_source_record_id,
        r.type,
        r.name,
        r.description,
        r.road_address,
        r.address_detail,
        r.latitude,
        r.longitude,
        r.floor,
        r.entrance_instructions,
        r.gender_type,
        r.wheelchair_accessible,
        r.baby_changing_available,
        r.sanitary_products_available,
        r.access_method,
        r.publication_status,
        r.last_verified_at,
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
        p.id,
        p.restroom_id,
        p.version,
        p.access_mode,
        p.deposit_amount_krw,
        p.refund_eligible,
        p.receipt_window_hours,
        p.min_purchase_krw,
        p.is_active,
      ]
    );
  }

  // Exact shape of remote partner '진미 통닭' (coordinate_source=null) + test_deposit + active lock secret
  const partnerOwnerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const partnerBizId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  const partnerRestroomId = "f633c2d1-0455-4fe0-b947-a68dd2aa23d9";
  await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'jinmi@example.test')`, [
    partnerOwnerId,
  ]);
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
       latitude, longitude, gender_type, access_method, publication_status,
       coordinate_source
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

  // Full 502 Suwon + 1 Partner pre-migration snapshot as anon!
  await db.exec("BEGIN; SET LOCAL ROLE anon;");
  const preSuwonSnapshot = (
    await db.query(`
      SELECT
        r.id, r.type, r.name, r.road_address, r.latitude, r.longitude,
        r.access_method, p.access_mode, p.deposit_amount_krw
      FROM public.restrooms r
      JOIN public.restroom_access_policies p ON p.restroom_id = r.id AND p.is_active = true
      ORDER BY r.id ASC
    `)
  ).rows;
  const preHaenggungRpc = (
    await db.query(
      `SELECT * FROM public.list_nearby_public_restrooms(37.27966, 127.0181, 400, 'all', 100, 0)`
    )
  ).rows;
  await db.exec("COMMIT;");

  assert.equal(preSuwonSnapshot.length, 503, "Expected all 502 Suwon + 1 partner visible pre-migration");
  console.log(`2. Pre-migration anon snapshot captured: ${preSuwonSnapshot.length} rows (502 Suwon + 1 진미 통닭), Haenggung RPC=${preHaenggungRpc.length}.`);

  // Step 2: Apply 20261124000000 and 20261125000000
  for (const mf of pendingMigrations) {
    await db.exec(fs.readFileSync(path.join(ROOT, "supabase/migrations", mf), "utf8"));
  }
  console.log(`3. Applied pending migrations (${pendingMigrations.join(", ")}).`);

  // Insert 4 adversarial 'published' rows that MUST NEVER be publicly exposed!
  const advSourceId = "ffffffff-ffff-4fff-8fff-fffffffffff1";
  const moisLeakId = "ffffffff-ffff-4fff-8fff-fffffffffff2";
  const kakaoLeakId = "ffffffff-ffff-4fff-8fff-fffffffffff3";
  const seoulUnverifiedLeakId = "ffffffff-ffff-4fff-8fff-fffffffffff4";
  const nullSourcePublicLeakId = "ffffffff-ffff-4fff-8fff-fffffffffff5";

  await db.query(
    `INSERT INTO public.public_data_sources (id, provider_name, dataset_name, source_url)
     VALUES ($1, 'LEAK TEST', 'Adversarial Source', 'https://example.test')`,
    [advSourceId]
  );
  const advRows = [
    [moisLeakId, "LEAK_MOIS_PUBLISHED", 37.2797, 127.0182, "mois_address_nav_db", "building_centroid", "VERIFIED"],
    [kakaoLeakId, "LEAK_KAKAO_PUBLISHED", 37.2798, 127.0183, "kakao_geocode", "geocoded", "VERIFIED"],
    [seoulUnverifiedLeakId, "LEAK_SEOUL_REVIEW_REQ", 37.2799, 127.0184, "seoul_public_toilet_info", "facility_official", "REVIEW_REQUIRED"],
    [nullSourcePublicLeakId, "LEAK_NULL_SOURCE_PUBLIC", 37.2800, 127.0185, null, null, null],
  ];
  for (const [id, name, lat, lng, src, ctype, vstatus] of advRows) {
    await db.query(
      `INSERT INTO public.restrooms (
         id, source_id, source_record_id, type, name, road_address,
         latitude, longitude, access_method, publication_status,
         coordinate_source, coordinate_type, coordinate_verification_status
       ) VALUES ($1,$2,$3,'public',$4,'테스트 주소',$5,$6,'open','published',$7,$8,$9)`,
      [id, advSourceId, id, name, lat, lng, src, ctype, vstatus]
    );
    await db.query(
      `INSERT INTO public.restroom_access_policies (
         restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, is_active
       ) VALUES ($1, 1, 'free', 0, false, true)`,
      [id]
    );
  }

  // Test post-migration visibility as anon (all 4 leak rows MUST be blocked; all 502 Suwon + 1 partner MUST remain identical!)
  await db.exec("BEGIN; SET LOCAL ROLE anon;");
  const postFilterSnapshot = (
    await db.query(`
      SELECT
        r.id, r.type, r.name, r.road_address, r.latitude, r.longitude,
        r.access_method, p.access_mode, p.deposit_amount_krw
      FROM public.restrooms r
      JOIN public.restroom_access_policies p ON p.restroom_id = r.id AND p.is_active = true
      ORDER BY r.id ASC
    `)
  ).rows;
  const postFilterRpc = (
    await db.query(
      `SELECT * FROM public.list_nearby_public_restrooms(37.27966, 127.0181, 400, 'all', 100, 0)`
    )
  ).rows;
  // Also simulate pre-runtime-update old columns query (`SELECT id, type, name...` without coordinate_type)
  const legacyRuntimeQuery = (
    await db.query(
      `SELECT id, type, name, road_address, latitude, longitude, business_id FROM public.restrooms ORDER BY id ASC`
    )
  ).rows;
  const childPolicyLeak = (
    await db.query(
      `SELECT restroom_id FROM public.restroom_access_policies WHERE restroom_id = ANY($1::uuid[])`,
      [[moisLeakId, kakaoLeakId, seoulUnverifiedLeakId, nullSourcePublicLeakId]]
    )
  ).rows;
  await db.exec("COMMIT;");

  assert.deepEqual(postFilterSnapshot, preSuwonSnapshot, "All 502 Suwon + 1 partner must be byte-for-byte identical after filter migration");
  assert.deepEqual(postFilterRpc, preHaenggungRpc, "list_nearby_public_restrooms must block all 4 published leak rows & keep Suwon+partner identical");
  assert.equal(legacyRuntimeQuery.length, 503, "Pre-update runtime columns query sees ONLY safe 503 rows via RLS");
  assert.equal(childPolicyLeak.length, 0, "Child access policies of hidden rows must also be blocked by RLS");
  console.log("4. Exposure filter & RLS verified: 0/4 published leak rows exposed; all 502 Suwon + 진미 통닭 preserved; old-runtime SELECT safe.");

  // Clean up adversarial fixture before staged Seoul rollout
  await db.query(`DELETE FROM public.restrooms WHERE source_id = $1`, [advSourceId]);
  await db.query(`DELETE FROM public.public_data_sources WHERE id = $1`, [advSourceId]);

  // Step 3: Stage 1 Load — Canary 10
  const seoulSourceId = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
  const canaryRunId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
  await db.exec("BEGIN");
  await db.query(
    `INSERT INTO public.public_data_sources (
       id, provider_name, dataset_name, source_url, api_endpoint,
       license_name, license_url, attribution_text, last_synced_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
    [
      seoulSourceId,
      canary10Pkg.publicDataSource.providerName,
      canary10Pkg.publicDataSource.datasetName,
      canary10Pkg.publicDataSource.sourceUrl,
      canary10Pkg.publicDataSource.apiEndpoint,
      canary10Pkg.publicDataSource.licenseName,
      canary10Pkg.publicDataSource.licenseUrl,
      canary10Pkg.publicDataSource.attributionText,
    ]
  );
  await db.query(
    `INSERT INTO public.public_import_runs (id, source_id, status, fetched_count)
     VALUES ($1, $2, 'running', $3)`,
    [canaryRunId, seoulSourceId, canary10Pkg.restrooms.length]
  );
  for (const r of canary10Pkg.restrooms) {
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
  for (const p of canary10Pkg.restroomAccessPolicies) {
    await db.query(
      `INSERT INTO public.restroom_access_policies (
         restroom_id, version, access_mode, deposit_amount_krw,
         refund_eligible, receipt_window_hours, min_purchase_krw, is_active
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT DO NOTHING`,
      [p.restroom_id, p.version, p.access_mode, p.deposit_amount_krw, p.refund_eligible, p.receipt_window_hours, p.min_purchase_krw, p.is_active]
    );
  }
  for (const c of canary10Pkg.restroomCoordinateCandidates) {
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
    `UPDATE public.public_import_runs SET status = 'success', finished_at = now(), inserted_count = 10 WHERE id = $1`,
    [canaryRunId]
  );
  await db.exec("COMMIT");

  await db.exec("BEGIN; SET LOCAL ROLE anon;");
  const afterCanaryCount = Number((await db.query(`SELECT count(*) AS cnt FROM public.restrooms`)).rows[0].cnt);
  const canarySampleRpc = (
    await db.query(
      `SELECT * FROM public.list_nearby_public_restrooms($1, $2, 400, 'public', 20, 0)`,
      [canary10Pkg.restrooms[0].latitude, canary10Pkg.restrooms[0].longitude]
    )
  ).rows;
  await db.exec("COMMIT;");
  assert.equal(afterCanaryCount, 513, "Expected 502 Suwon + 1 partner + 10 Canary Seoul = 513 visible");
  assert.ok(canarySampleRpc.some((r) => r.id === canary10Pkg.restrooms[0].id));
  console.log(`5. Stage 1 Canary-10 rehearsal passed: visible=${afterCanaryCount}, RPC found '${canary10Pkg.restrooms[0].name}'.`);

  // Step 4: Stage 2 Expand Canary-10 -> Pilot-50 (idempotent ON CONFLICT skips already-loaded 10, inserts 40)
  const pilotRunId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2";
  await db.exec("BEGIN");
  await db.query(
    `INSERT INTO public.public_import_runs (id, source_id, status, fetched_count)
     VALUES ($1, $2, 'running', $3)`,
    [pilotRunId, seoulSourceId, pilot50Pkg.restrooms.length]
  );
  let inserted50 = 0;
  for (const r of pilot50Pkg.restrooms) {
    const res = await db.query(
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
    inserted50 += res.affectedRows ?? 0;
  }
  for (const p of pilot50Pkg.restroomAccessPolicies) {
    await db.query(
      `INSERT INTO public.restroom_access_policies (
         restroom_id, version, access_mode, deposit_amount_krw,
         refund_eligible, receipt_window_hours, min_purchase_krw, is_active
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT DO NOTHING`,
      [p.restroom_id, p.version, p.access_mode, p.deposit_amount_krw, p.refund_eligible, p.receipt_window_hours, p.min_purchase_krw, p.is_active]
    );
  }
  for (const c of pilot50Pkg.restroomCoordinateCandidates) {
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
    [pilotRunId, inserted50]
  );
  await db.exec("COMMIT");
  assert.equal(inserted50, 40, "Expanding Canary-10 -> Pilot-50 must skip existing 10 and insert exactly 40");

  // Full post-50 verification: Suwon 502 + partner untouched, all 50 Seoul visible, 0 MOIS/Kakao, 0 public PINs
  await db.exec("BEGIN; SET LOCAL ROLE anon;");
  const post50SuwonAndPartner = (
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
  const post50TotalVisible = Number((await db.query(`SELECT count(*) AS cnt FROM public.restrooms`)).rows[0].cnt);
  const post50SeoulVisible = Number(
    (await db.query(`SELECT count(*) AS cnt FROM public.restrooms WHERE coordinate_source = 'seoul_public_toilet_info'`)).rows[0].cnt
  );
  const post50Rpc = (
    await db.query(
      `SELECT * FROM public.list_nearby_public_restrooms(37.27966, 127.0181, 400, 'all', 100, 0)`
    )
  ).rows;
  await db.exec("COMMIT;");

  assert.deepEqual(post50SuwonAndPartner, preSuwonSnapshot);
  assert.deepEqual(post50Rpc, preHaenggungRpc);
  assert.equal(post50TotalVisible, 553);
  assert.equal(post50SeoulVisible, 50);

  // Full Rollback check: delete Seoul pilot + drop 20261125 objects -> exact baseline restored
  await db.exec("BEGIN");
  await db.query(`DELETE FROM public.restrooms WHERE source_id = $1`, [seoulSourceId]);
  await db.query(`DELETE FROM public.public_import_runs WHERE source_id = $1`, [seoulSourceId]);
  await db.query(`DELETE FROM public.public_data_sources WHERE id = $1`, [seoulSourceId]);
  await db.exec("COMMIT");

  const restoredCnt = Number((await db.query(`SELECT count(*) AS cnt FROM public.restrooms`)).rows[0].cnt);
  const secretCnt = Number((await db.query(`SELECT count(*) AS cnt FROM public.restroom_lock_secrets`)).rows[0].cnt);
  assert.equal(restoredCnt, 503);
  assert.equal(secretCnt, 1);
  console.log("6. Stage 2 Pilot-50 (10+40), full 502 Suwon regression, and data rollback passed!");

  // Step 7: Verify 20261125/20261124 SQL migration rollback preserves all 502 Suwon + 진미 통닭
  const m20261120 = fs.readFileSync(
    path.join(ROOT, "supabase/migrations/20261120000000_restroom_nearby_search_rpc.sql"),
    "utf8"
  );
  await db.exec(`
    BEGIN;
    DROP POLICY IF EXISTS "restrooms_select_anon" ON public.restrooms;
    CREATE POLICY "restrooms_select_anon" ON public.restrooms FOR SELECT TO anon
      USING (public.is_restroom_publicly_visible(type, business_id, publication_status));

    DROP POLICY IF EXISTS "restrooms_select_authenticated" ON public.restrooms;
    CREATE POLICY "restrooms_select_authenticated" ON public.restrooms FOR SELECT TO authenticated
      USING (
        public.is_restroom_publicly_visible(type, business_id, publication_status)
        OR public.is_admin(auth.uid())
        OR (type = 'partner' AND public.is_business_member(business_id, false))
      );

    CREATE OR REPLACE FUNCTION public.is_restroom_publicly_visible(p_restroom_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
      SELECT coalesce(
        (
          SELECT public.is_restroom_publicly_visible(r.type, r.business_id, r.publication_status)
          FROM public.restrooms r
          WHERE r.id = p_restroom_id
        ),
        false
      );
    $$;
    COMMIT;
  `);
  await db.exec(m20261120);
  await db.exec(`
    BEGIN;
    DROP FUNCTION IF EXISTS public.is_restroom_publicly_visible(text, uuid, text, text, text, text);
    DROP FUNCTION IF EXISTS public.is_restroom_coordinate_publicly_allowed(text, text, text, text);
    DROP TABLE IF EXISTS public.restroom_coordinate_candidates;
    COMMIT;
  `);
  await db.exec("BEGIN; SET LOCAL ROLE anon;");
  const postSqlRollback = (
    await db.query(`
      SELECT
        r.id, r.type, r.name, r.road_address, r.latitude, r.longitude,
        r.access_method, p.access_mode, p.deposit_amount_krw
      FROM public.restrooms r
      JOIN public.restroom_access_policies p ON p.restroom_id = r.id AND p.is_active = true
      ORDER BY r.id ASC
    `)
  ).rows;
  await db.exec("COMMIT;");
  assert.deepEqual(postSqlRollback, preSuwonSnapshot);
  console.log("7. SQL rollback check passed: all 502 Suwon + 진미 통닭 remain identical.");

  console.log("SUCCESS: All Phase 3-C rehearsal checks passed!");
  await db.close();
}

run().catch((err) => {
  console.error("Phase 3-C rehearsal FAILED:", err);
  process.exit(1);
});
