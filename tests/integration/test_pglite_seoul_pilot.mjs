import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

async function run() {
  console.log("1. Initializing isolated PGlite database for Phase 3-B Seoul pilot...");
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
    const sql = fs.readFileSync(path.join(ROOT, "supabase/migrations", mf), "utf8");
    await db.exec(sql);
  }
  console.log(`   Applied ${migrationFiles.length} migrations (including 20261124000000).`);

  // 2. Seed Suwon 502 baseline + 1 approved partner restroom (test_deposit)
  const suwonExport = JSON.parse(
    fs.readFileSync(path.join(ROOT, "local-data/suwon_remote_export.json"), "utf8")
  );
  const pilotPkg = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, "local-data/address-db-poc/phase3b/seoul_pilot_50_package.json"),
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

  const suwonPolicies = suwonExport.restroomAccessPolicies ?? [];
  for (const p of suwonPolicies) {
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

  // Seed 1 approved DEMO/TEST partner restroom in Suwon to guard partner policy integrity
  const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const businessId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  const partnerRestroomId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
  await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'demo-owner@example.test')`, [
    ownerId,
  ]);
  await db.query(
    `INSERT INTO public.profiles (id, display_name, account_status)
     VALUES ($1, 'DEMO Partner', 'active')
     ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`,
    [ownerId]
  );
  await db.query(
    `INSERT INTO public.businesses (
       id, name, category, road_address, latitude, longitude,
       registration_status, created_by, approved_at
     ) VALUES ($1, 'DEMO/TEST 제휴카페', 'cafe', '경기도 수원시 팔달구 정조로 800', 37.2841, 127.0121, 'approved', $2, now())`,
    [businessId, ownerId]
  );
  await db.query(
    `INSERT INTO public.restrooms (
       id, business_id, source_id, type, name, road_address,
       latitude, longitude, gender_type, access_method, publication_status,
       coordinate_source, coordinate_type, coordinate_verification_status
     ) VALUES (
       $1, $2, NULL, 'partner', 'DEMO/TEST 제휴카페 화장실', '경기도 수원시 팔달구 정조로 800',
       37.2841, 127.0121, 'separate', 'pin', 'published',
       'admin_manual', 'manual', 'VERIFIED'
     )`,
    [partnerRestroomId, businessId]
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
    [partnerRestroomId, ownerId]
  );

  // Baseline Suwon RPC snapshot BEFORE Seoul pilot load
  const suwonSample = suwonExport.restrooms[0];
  const beforeHaenggung = (
    await db.query(
      `SELECT * FROM public.list_nearby_public_restrooms(37.284, 127.012, 400, 'all', 20, 0)`
    )
  ).rows;
  const beforeSuwonSample = (
    await db.query(
      `SELECT * FROM public.list_nearby_public_restrooms($1, $2, 400, 'all', 20, 0)`,
      [suwonSample.latitude, suwonSample.longitude]
    )
  ).rows;
  assert.ok(beforeHaenggung.length > 0, "Expected Suwon Haenggung baseline results > 0");
  assert.ok(beforeSuwonSample.length > 0, "Expected Suwon sample baseline results > 0");
  console.log(
    `2. Seeded Suwon baseline (502 public + 1 DEMO partner). RPC baseline rows: Haenggung=${beforeHaenggung.length}, SuwonSample=${beforeSuwonSample.length}.`
  );

  // 3. Batch failure & atomic rollback simulation
  const seoulSourceId = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
  const failedRunId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
  await db.exec("BEGIN");
  try {
    await db.query(
      `INSERT INTO public.public_data_sources (
         id, provider_name, dataset_name, source_url, api_endpoint,
         license_name, license_url, attribution_text
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        seoulSourceId,
        pilotPkg.publicDataSource.providerName,
        pilotPkg.publicDataSource.datasetName,
        pilotPkg.publicDataSource.sourceUrl,
        pilotPkg.publicDataSource.apiEndpoint,
        pilotPkg.publicDataSource.licenseName,
        pilotPkg.publicDataSource.licenseUrl,
        pilotPkg.publicDataSource.attributionText,
      ]
    );
    await db.query(
      `INSERT INTO public.public_import_runs (id, source_id, status, fetched_count)
       VALUES ($1, $2, 'running', $3)`,
      [failedRunId, seoulSourceId, pilotPkg.restrooms.length]
    );
    const first = pilotPkg.restrooms[0];
    await db.query(
      `INSERT INTO public.restrooms (
         id, source_id, source_record_id, type, name, road_address,
         latitude, longitude, gender_type, access_method, publication_status,
         coordinate_source, coordinate_source_id, coordinate_source_record_id,
         coordinate_type, coordinate_verification_status
       ) VALUES ($1,$2,$3,'public',$4,$5,$6,$7,$8,'open','published',$9,$2,$10,$11,$12)`,
      [
        first.id,
        seoulSourceId,
        first.source_record_id,
        first.name,
        first.road_address,
        first.latitude,
        first.longitude,
        first.gender_type,
        first.coordinate_source,
        first.coordinate_source_record_id,
        first.coordinate_type,
        first.coordinate_verification_status,
      ]
    );
    // Deliberate policy failure: try inserting public restroom with pin access
    await db.query(
      `INSERT INTO public.restrooms (
         id, source_id, source_record_id, type, name, road_address,
         latitude, longitude, access_method, publication_status,
         coordinate_source, coordinate_type, coordinate_verification_status
       ) VALUES (
         gen_random_uuid(), $1, 'FAIL-SIM', 'public', 'FAIL', '서울시 중구',
         37.56, 126.98, 'pin', 'published',
         'seoul_public_toilet_info', 'facility_official', 'VERIFIED'
       )`,
      [seoulSourceId]
    );
    assert.fail("Expected public restroom with pin access to violate DB constraint");
  } catch (err) {
    assert.equal(err.code, "23514", `Expected check violation 23514, got ${err.code}`);
    await db.exec("ROLLBACK");
  }
  const postFailedPublicCount = Number(
    (await db.query(`SELECT count(*) AS cnt FROM public.restrooms WHERE type = 'public'`)).rows[0]
      .cnt
  );
  assert.equal(postFailedPublicCount, 502, "Failed batch rollback must leave 0 partial Seoul rows");
  console.log("3. Simulated batch failure rolled back cleanly (0 partial rows retained).");

  // 4. Execute clean pilot load transaction (50 restrooms + 50 policies + 50 candidate audits)
  const successRunId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2";
  await db.exec("BEGIN");
  await db.query(
    `INSERT INTO public.public_data_sources (
       id, provider_name, dataset_name, source_url, api_endpoint,
       license_name, license_url, attribution_text, last_synced_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
    [
      seoulSourceId,
      pilotPkg.publicDataSource.providerName,
      pilotPkg.publicDataSource.datasetName,
      pilotPkg.publicDataSource.sourceUrl,
      pilotPkg.publicDataSource.apiEndpoint,
      pilotPkg.publicDataSource.licenseName,
      pilotPkg.publicDataSource.licenseUrl,
      pilotPkg.publicDataSource.attributionText,
    ]
  );
  await db.query(
    `INSERT INTO public.public_import_runs (id, source_id, status, fetched_count)
     VALUES ($1, $2, 'running', $3)`,
    [successRunId, seoulSourceId, pilotPkg.restrooms.length]
  );

  for (const r of pilotPkg.restrooms) {
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
       )`,
      [
        r.id,
        seoulSourceId,
        r.source_record_id,
        r.type,
        r.name,
        r.description,
        r.road_address,
        r.address_detail,
        r.latitude,
        r.longitude,
        r.gender_type,
        r.wheelchair_accessible,
        r.baby_changing_available,
        r.sanitary_products_available,
        r.access_method,
        r.publication_status,
        r.last_verified_at,
        r.coordinate_source,
        seoulSourceId,
        r.coordinate_source_record_id,
        r.coordinate_type,
        r.coordinate_verification_status,
        r.coordinate_verification_basis,
        r.coordinate_source_version,
      ]
    );
  }

  for (const p of pilotPkg.restroomAccessPolicies) {
    await db.query(
      `INSERT INTO public.restroom_access_policies (
         restroom_id, version, access_mode, deposit_amount_krw,
         refund_eligible, receipt_window_hours, min_purchase_krw, is_active
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
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

  for (const c of pilotPkg.restroomCoordinateCandidates) {
    await db.query(
      `INSERT INTO public.restroom_coordinate_candidates (
         restroom_id, candidate_source, candidate_source_record_id,
         candidate_coord_type, source_version, latitude, longitude,
         verification_status, verification_basis, review_reasons, is_selected
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        c.restroom_id,
        c.candidate_source,
        c.candidate_source_record_id,
        c.candidate_coord_type,
        c.source_version,
        c.latitude,
        c.longitude,
        c.verification_status,
        c.verification_basis,
        c.review_reasons,
        c.is_selected,
      ]
    );
  }

  await db.query(
    `UPDATE public.public_import_runs
     SET status = 'success', finished_at = now(), inserted_count = $2
     WHERE id = $1`,
    [successRunId, pilotPkg.restrooms.length]
  );
  await db.exec("COMMIT");
  console.log("4. Loaded 50 Seoul pilot restrooms + 50 free policies + 50 candidate audit rows.");

  // 5. Post-load assertions
  const counts = (
    await db.query(`
      SELECT
        count(*) FILTER (WHERE type = 'public') AS public_cnt,
        count(*) FILTER (WHERE type = 'partner') AS partner_cnt,
        count(*) FILTER (WHERE coordinate_source = 'seoul_public_toilet_info') AS seoul_cnt,
        count(*) FILTER (WHERE coordinate_source = 'gg_publtolt_15011425') AS suwon_cnt,
        count(*) FILTER (WHERE coordinate_source IN ('kakao_geocode', 'mois_address_nav_db', 'mois_address_summary_db')) AS forbidden_src_cnt
      FROM public.restrooms
    `)
  ).rows[0];
  assert.equal(Number(counts.public_cnt), 552);
  assert.equal(Number(counts.partner_cnt), 1);
  assert.equal(Number(counts.seoul_cnt), 50);
  assert.equal(Number(counts.suwon_cnt), 502);
  assert.equal(Number(counts.forbidden_src_cnt), 0);

  const policyCheck = (
    await db.query(`
      SELECT
        count(*) FILTER (WHERE r.type = 'public' AND p.is_active = true AND p.access_mode = 'free' AND p.deposit_amount_krw = 0) AS public_free_cnt,
        count(*) FILTER (WHERE r.type = 'partner' AND p.is_active = true AND p.access_mode = 'test_deposit' AND p.deposit_amount_krw = 1000) AS partner_deposit_cnt
      FROM public.restrooms r
      JOIN public.restroom_access_policies p ON p.restroom_id = r.id
    `)
  ).rows[0];
  assert.equal(Number(policyCheck.public_free_cnt), 552);
  assert.equal(Number(policyCheck.partner_deposit_cnt), 1);

  const pinSecretsPublicCount = Number(
    (
      await db.query(`
        SELECT count(*) AS cnt
        FROM public.restroom_lock_secrets ls
        JOIN public.restrooms r ON r.id = ls.restroom_id
        WHERE r.type = 'public'
      `)
    ).rows[0].cnt
  );
  assert.equal(pinSecretsPublicCount, 0);

  // Suwon 502 regression test via list_nearby_public_restrooms RPC
  const afterHaenggung = (
    await db.query(
      `SELECT * FROM public.list_nearby_public_restrooms(37.284, 127.012, 400, 'all', 20, 0)`
    )
  ).rows;
  const afterSuwonSample = (
    await db.query(
      `SELECT * FROM public.list_nearby_public_restrooms($1, $2, 400, 'all', 20, 0)`,
      [suwonSample.latitude, suwonSample.longitude]
    )
  ).rows;
  assert.deepEqual(
    afterHaenggung,
    beforeHaenggung,
    "Suwon Haenggung nearby RPC results must remain byte-for-byte identical"
  );
  assert.deepEqual(
    afterSuwonSample,
    beforeSuwonSample,
    "Suwon sample nearby RPC results must remain byte-for-byte identical"
  );

  // Seoul RPC nearby search test across sample loaded pilot points
  for (const idx of [0, 10, 25, 49]) {
    const sampleSeoul = pilotPkg.restrooms[idx];
    const seoulNearby = (
      await db.query(
        `SELECT * FROM public.list_nearby_public_restrooms($1, $2, 400, 'public', 20, 0)`,
        [sampleSeoul.latitude, sampleSeoul.longitude]
      )
    ).rows;
    assert.ok(
      seoulNearby.some(
        (row) => row.id === sampleSeoul.id && Number(row.distance_meters) < 1
      ),
      `Expected Seoul nearby RPC to return loaded restroom ${sampleSeoul.name}, got: ${JSON.stringify(seoulNearby)}`
    );
  }

  // Verify anon cannot read internal coordinate audit table
  await db.exec("BEGIN; SET LOCAL ROLE anon;");
  let anonBlocked = false;
  try {
    await db.query(`SELECT count(*) FROM public.restroom_coordinate_candidates`);
  } catch (err) {
    if (err.code === "42501") anonBlocked = true;
  }
  await db.exec("ROLLBACK;");
  assert.ok(anonBlocked, "anon SELECT on restroom_coordinate_candidates must be denied");

  console.log(
    `5. Post-load assertions passed: Suwon 502 & partner RPC identical; 4 sampled Seoul pilot points found at distance_meters=0; anon audit RLS blocked.`
  );

  // 6. Idempotent re-run verification (ON CONFLICT DO NOTHING)
  let insertedOnRetry = 0;
  for (const r of pilotPkg.restrooms) {
    const res = await db.query(
      `INSERT INTO public.restrooms (
         id, source_id, source_record_id, type, name, road_address,
         latitude, longitude, access_method, publication_status,
         coordinate_source, coordinate_type, coordinate_verification_status
       ) VALUES ($1,$2,$3,'public',$4,$5,$6,$7,'open','published',$8,$9,$10)
       ON CONFLICT DO NOTHING`,
      [
        r.id,
        seoulSourceId,
        r.source_record_id,
        r.name,
        r.road_address,
        r.latitude,
        r.longitude,
        r.coordinate_source,
        r.coordinate_type,
        r.coordinate_verification_status,
      ]
    );
    insertedOnRetry += res.affectedRows ?? 0;
  }
  assert.equal(insertedOnRetry, 0, "Idempotent re-run must insert 0 duplicate rows");
  console.log("6. Idempotent re-run check passed (0 duplicate inserts).");

  // 7. Rollback procedure verification (delete Seoul pilot by source_id)
  await db.exec("BEGIN");
  await db.query(
    `DELETE FROM public.restrooms WHERE source_id = $1`,
    [seoulSourceId]
  );
  await db.query(`DELETE FROM public.public_import_runs WHERE source_id = $1`, [seoulSourceId]);
  await db.query(`DELETE FROM public.public_data_sources WHERE id = $1`, [seoulSourceId]);
  await db.exec("COMMIT");

  const afterRollback = (
    await db.query(`
      SELECT
        count(*) FILTER (WHERE type = 'public') AS public_cnt,
        count(*) FILTER (WHERE type = 'partner') AS partner_cnt,
        count(*) FILTER (WHERE coordinate_source = 'seoul_public_toilet_info') AS seoul_cnt
      FROM public.restrooms
    `)
  ).rows[0];
  assert.equal(Number(afterRollback.public_cnt), 502);
  assert.equal(Number(afterRollback.partner_cnt), 1);
  assert.equal(Number(afterRollback.seoul_cnt), 0);
  console.log("7. Rollback delete by source_id restored exact pre-load state (502 public, 1 partner, 0 Seoul).");

  console.log("SUCCESS: All Phase 3-B PGlite pilot checks passed!");
  await db.close();
}

run().catch((err) => {
  console.error("Phase 3-B PGlite pilot test FAILED:", err);
  process.exit(1);
});
