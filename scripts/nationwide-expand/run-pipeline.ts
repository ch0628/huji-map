import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  buildTask2AndTask3Packages,
  OFFICIAL_SOURCE_SPECS,
  type ExistingOfficialRef,
  type PreparedCandidateRow,
  type PreparedOfficialRestroom,
} from "./pipeline-lib";

function sqlStr(v: string | null | undefined): string {
  if (v === null || v === undefined) return "NULL";
  return `'${v.replace(/'/g, "''")}'`;
}

function sqlBool(v: boolean | null | undefined): string {
  if (v === null || v === undefined) return "NULL";
  return v ? "true" : "false";
}

function sqlNum(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "NULL";
  return String(v);
}

function fetchRemoteExistingRows(): ExistingOfficialRef[] {
  const raw = execSync(
    `npx supabase db query --remote --read-only --output json "SELECT id, source_id, source_record_id, type, name, road_address, latitude, longitude, coordinate_source FROM public.restrooms ORDER BY id;"`,
    { encoding: "utf8", maxBuffer: 40 * 1024 * 1024 }
  );
  const idx = raw.indexOf("{");
  const parsed = JSON.parse(raw.slice(idx));
  return parsed.rows || [];
}

function generateOfficialBatchSql(
  items: PreparedOfficialRestroom[],
  sourceIdByDatasetKey: Map<string, string>,
  batchSize = 250
): string[] {
  const files: string[] = [];

  // 00: Upsert public_data_sources
  const srcStatements: string[] = ["BEGIN;"];
  for (const [key, spec] of Object.entries(OFFICIAL_SOURCE_SPECS)) {
    const srcUuid = sourceIdByDatasetKey.get(key)!;
    srcStatements.push(`
INSERT INTO public.public_data_sources (
  id, provider_name, dataset_name, source_url, license_name, license_url, attribution_text, last_synced_at
) VALUES (
  ${sqlStr(srcUuid)}::uuid,
  ${sqlStr(spec.providerName)},
  ${sqlStr(spec.datasetName)},
  ${sqlStr(spec.sourceUrl)},
  ${sqlStr(spec.licenseName)},
  ${sqlStr(spec.licenseUrl)},
  ${sqlStr(spec.attributionText)},
  now()
)
ON CONFLICT (id) DO UPDATE SET
  source_url = EXCLUDED.source_url,
  license_name = EXCLUDED.license_name,
  license_url = EXCLUDED.license_url,
  attribution_text = EXCLUDED.attribution_text,
  last_synced_at = now();`);
  }
  srcStatements.push("COMMIT;");
  files.push(srcStatements.join("\n"));

  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize);
    const valuesRestrooms = chunk
      .map((r) => {
        const srcUuid = sourceIdByDatasetKey.get(r.datasetKey)!;
        return `(
  ${sqlStr(r.id)}::uuid,
  'public',
  NULL::uuid,
  ${sqlStr(srcUuid)}::uuid,
  ${sqlStr(r.sourceRecordId)},
  ${sqlStr(r.coordinateSource)},
  ${sqlStr(srcUuid)}::uuid,
  ${sqlStr(r.coordinateSourceRecordId)},
  'facility_official',
  'VERIFIED',
  ${sqlStr(r.verificationBasis)},
  ${sqlStr(r.sourceVersion)},
  ${sqlStr(r.name)},
  ${sqlStr(r.description)},
  ${sqlStr(r.roadAddress)},
  ${sqlStr(r.addressDetail)},
  ${sqlNum(r.latitude)},
  ${sqlNum(r.longitude)},
  ${sqlStr(r.floor)},
  ${sqlStr(r.entranceInstructions)},
  ${sqlStr(r.genderType)},
  ${sqlBool(r.wheelchairAccessible)},
  ${sqlBool(r.babyChangingAvailable)},
  'open',
  'published',
  ${sqlStr(r.lastVerifiedAt)}::timestamptz
)`;
      })
      .join(",\n");

    const valuesPolicies = chunk
      .map(
        (r) => `(
  ${sqlStr(r.id)}::uuid,
  1,
  'free',
  0,
  false,
  NULL::integer,
  0,
  true,
  now()
)`
      )
      .join(",\n");

    const sql = `BEGIN;
INSERT INTO public.restrooms (
  id, type, business_id, source_id, source_record_id,
  coordinate_source, coordinate_source_id, coordinate_source_record_id,
  coordinate_type, coordinate_verification_status, coordinate_verification_basis, coordinate_source_version,
  name, description, road_address, address_detail, latitude, longitude,
  floor, entrance_instructions, gender_type, wheelchair_accessible, baby_changing_available,
  access_method, publication_status, last_verified_at
) VALUES
${valuesRestrooms}
ON CONFLICT (source_id, source_record_id) WHERE source_id IS NOT NULL AND source_record_id IS NOT NULL DO NOTHING;

INSERT INTO public.restroom_access_policies (
  restroom_id, version, access_mode, deposit_amount_krw, refund_eligible,
  receipt_window_hours, min_purchase_krw, is_active, effective_from
)
SELECT v.restroom_id, v.version, v.access_mode, v.deposit_amount_krw, v.refund_eligible,
       v.receipt_window_hours, v.min_purchase_krw, v.is_active, v.effective_from
FROM (VALUES
${valuesPolicies}
) AS v(restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, receipt_window_hours, min_purchase_krw, is_active, effective_from)
WHERE EXISTS (SELECT 1 FROM public.restrooms r WHERE r.id = v.restroom_id)
  AND NOT EXISTS (SELECT 1 FROM public.restroom_access_policies p WHERE p.restroom_id = v.restroom_id AND p.is_active = true);
COMMIT;`;
    files.push(sql);
  }

  return files;
}

function generateCandidateBatchSql(
  candidates: PreparedCandidateRow[],
  batchSize = 1000
): string[] {
  const files: string[] = [];
  for (let i = 0; i < candidates.length; i += batchSize) {
    const chunk = candidates.slice(i, i + batchSize);
    const values = chunk
      .map(
        (c) => `(
  ${sqlStr(c.sourceProvider)},
  ${sqlStr(c.sourceDatasetId)},
  ${sqlStr(c.sourceRecordId)},
  ${sqlStr(c.name)},
  ${sqlStr(c.normalizedName)},
  ${sqlStr(c.roadAddress)},
  ${sqlStr(c.jibunAddress)},
  ${sqlStr(c.normalizedAddress)},
  ${sqlStr(c.sidoCode)},
  ${sqlStr(c.sigunguCode)},
  ${sqlStr(c.eupmyeondongCode)},
  ${sqlStr(c.sidoName)},
  ${sqlStr(c.sigunguName)},
  ${sqlStr(c.eupmyeondongName)},
  ${sqlStr(c.adminOrgCode)},
  ${sqlStr(c.facilityType)},
  ${sqlStr(c.openHours)},
  ${sqlStr(c.closedDays)},
  ${sqlStr(c.genderType)},
  ${sqlBool(c.wheelchairAccessible)},
  ${sqlBool(c.babyChangingAvailable)},
  ${sqlStr(c.managingAgency)},
  ${sqlStr(c.phone)},
  ${sqlStr(JSON.stringify(c.publicMetadata))}::jsonb,
  ${sqlStr(c.coordinateStatus)},
  ${sqlStr(c.matchedRestroomId)}::uuid,
  ${sqlStr(c.facilityHash)},
  ${c.sourceBaseDate ? `${sqlStr(c.sourceBaseDate)}::date` : "NULL::date"},
  ${sqlStr(c.licenseName)},
  ${sqlStr(c.licenseUrl)},
  ${sqlStr(c.attributionText)}
)`
      )
      .join(",\n");

    const sql = `BEGIN;
INSERT INTO public.public_restroom_candidates (
  source_provider, source_dataset_id, source_record_id,
  name, normalized_name, road_address, jibun_address, normalized_address,
  sido_code, sigungu_code, eupmyeondong_code, sido_name, sigungu_name, eupmyeondong_name,
  admin_org_code, facility_type, open_hours, closed_days, gender_type,
  wheelchair_accessible, baby_changing_available, managing_agency, phone,
  public_metadata, coordinate_status, matched_restroom_id, facility_hash,
  source_base_date, license_name, license_url, attribution_text
) VALUES
${values}
ON CONFLICT (source_dataset_id, source_record_id) DO UPDATE SET
  name = EXCLUDED.name,
  normalized_name = EXCLUDED.normalized_name,
  road_address = EXCLUDED.road_address,
  jibun_address = EXCLUDED.jibun_address,
  normalized_address = EXCLUDED.normalized_address,
  sido_code = EXCLUDED.sido_code,
  sigungu_code = EXCLUDED.sigungu_code,
  sido_name = EXCLUDED.sido_name,
  sigungu_name = EXCLUDED.sigungu_name,
  eupmyeondong_name = EXCLUDED.eupmyeondong_name,
  coordinate_status = EXCLUDED.coordinate_status,
  matched_restroom_id = EXCLUDED.matched_restroom_id,
  facility_hash = EXCLUDED.facility_hash,
  updated_at = now();
COMMIT;`;
    files.push(sql);
  }
  return files;
}

async function main() {
  const args = process.argv.slice(2);
  const isLive = args.includes("--live") && args.includes("--confirm");
  const isCanaryPglite = args.includes("--canary-pglite");
  const writeSqlOnly = args.includes("--write-sql");

  console.log("1. Fetching existing remote restrooms for strict deduplication...");
  const existingRows = fetchRemoteExistingRows();
  console.log(`   Existing remote restrooms: ${existingRows.length}`);

  console.log("2. Running TASK 2 & TASK 3 verification + deduplication + candidate indexing...");
  const pkg = buildTask2AndTask3Packages({ existingRemoteRows: existingRows });

  // Deterministic source UUIDs per dataset
  const sourceIdMap = new Map<string, string>();
  let idx = 1;
  for (const key of Object.keys(OFFICIAL_SOURCE_SPECS)) {
    const suffix = String(idx++).padStart(12, "0");
    sourceIdMap.set(key, `eeeeeeee-eeee-4eee-8eee-${suffix}`);
  }

  const outDir = path.resolve("local-data/nationwide_sql_batches");
  fs.mkdirSync(outDir, { recursive: true });

  const officialSqls = generateOfficialBatchSql(pkg.approvedRestrooms, sourceIdMap, 250);
  const candidateSqls = generateCandidateBatchSql(pkg.candidates, 1000);

  if (writeSqlOnly || isLive || isCanaryPglite) {
    for (const f of fs.readdirSync(outDir)) {
      if (f.endsWith(".sql")) fs.unlinkSync(path.join(outDir, f));
    }
    officialSqls.forEach((sql, i) => {
      fs.writeFileSync(
        path.join(outDir, `01_official_${String(i).padStart(3, "0")}.sql`),
        sql,
        "utf8"
      );
    });
    candidateSqls.forEach((sql, i) => {
      fs.writeFileSync(
        path.join(outDir, `02_candidates_${String(i).padStart(3, "0")}.sql`),
        sql,
        "utf8"
      );
    });
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    existingRemoteTotal: existingRows.length,
    stats: pkg.stats,
    datasetAudits: pkg.datasetAudits,
    heldDatasets: pkg.heldDatasets,
    sqlBatches: {
      officialFiles: officialSqls.length,
      candidateFiles: candidateSqls.length,
    },
  };
  fs.writeFileSync(
    path.resolve("local-data/nationwide_expand_summary.json"),
    JSON.stringify(summary, null, 2),
    "utf8"
  );

  console.log("=== SUMMARY ===");
  console.log(JSON.stringify(summary.stats, null, 2));
  for (const a of pkg.datasetAudits) {
    console.log(
      `  ${a.key}: total=${a.totalRows}, approved=${a.approvedCount}, matched51k=${a.matchedNationalCount}, held=${a.heldCount}`
    );
  }

  if (isCanaryPglite) {
    const { PGlite } = await import("@electric-sql/pglite");
    console.log("\n3. Running PGlite Canary Rehearsal on generated SQL batches...");
    const db = new PGlite();
    await db.exec(`
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE SCHEMA IF NOT EXISTS storage;
      CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text UNIQUE, raw_user_meta_data jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
      CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text, public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
      CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid);
      CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]; $$;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid; $$;
      CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), current_setting('role', true), 'anon'); $$;
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin; END IF;
      END $$;
      GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;
    `);
    const migrations = fs.readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort();
    for (const mf of migrations) {
      await db.exec(fs.readFileSync(path.join("supabase/migrations", mf), "utf8"));
    }
    // Insert minimal existing remote rows (excluding those without matched source_id: seed dummy source for existing)
    await db.exec(`
      INSERT INTO public.public_data_sources (id, provider_name, dataset_name, source_url)
      VALUES ('20135dca-dd0d-46be-ad67-6af8b084cd43', '경기도 수원시', '공중화장실 현황', 'https://data.go.kr/15012892'),
             ('dddddddd-dddd-4ddd-8ddd-ddddddddddd1', '서울특별시', '서울시 공중화장실 위치정보', 'https://data.seoul.go.kr')
      ON CONFLICT DO NOTHING;
    `);
    for (const r of existingRows) {
      if (r.type === "public" && r.source_id && r.latitude !== null && r.longitude !== null) {
        await db.query(
          `INSERT INTO public.restrooms (id, type, source_id, source_record_id, name, road_address, latitude, longitude, publication_status, coordinate_source, coordinate_type, coordinate_verification_status)
           VALUES ($1::uuid, 'public', $2::uuid, $3, $4, $5, $6, $7, 'published', $8, $9, $10)
           ON CONFLICT DO NOTHING`,
          [
            r.id,
            r.source_id,
            r.source_record_id || r.id,
            r.name,
            r.road_address,
            r.latitude,
            r.longitude,
            r.coordinate_source,
            r.coordinate_source === "seoul_public_toilet_info" ? "facility_official" : null,
            r.coordinate_source === "seoul_public_toilet_info" ? "VERIFIED" : null,
          ]
        );
      }
    }

    for (const sql of officialSqls) {
      await db.exec(sql);
    }
    for (const sql of candidateSqls) {
      await db.exec(sql);
    }

    const rCount = await db.query("SELECT count(*)::int AS c FROM public.restrooms");
    const cCount = await db.query(
      "SELECT coordinate_status, count(*)::int AS c FROM public.public_restroom_candidates GROUP BY 1 ORDER BY 1"
    );
    console.log("PGlite Canary Result:", {
      restroomsCount: (rCount.rows[0] as { c: number }).c,
      candidatesByStatus: cCount.rows,
    });
    return;
  }

  if (isLive) {
    console.log("\n3. Executing SQL batches against linked remote DB...");
    const batchFiles = fs
      .readdirSync(outDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (let i = 0; i < batchFiles.length; i++) {
      const f = batchFiles[i];
      const full = path.join(outDir, f);
      console.log(`   [${i + 1}/${batchFiles.length}] Applying ${f}...`);
      execSync(`npx supabase db query --remote --yes --file "${full}"`, {
        stdio: "inherit",
      });
    }
    console.log("   All remote batches applied successfully!");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
