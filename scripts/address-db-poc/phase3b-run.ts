#!/usr/bin/env node
/**
 * Phase 3-B Runner: Builds & validates the Seoul OA-22586 50-item pilot load package
 * (DRY-RUN only, zero remote DB writes, zero Kakao API calls).
 *
 * Usage:
 *   npx tsx scripts/address-db-poc/phase3b-run.ts
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { decodeCsvBuffer, parseCsv } from "../../src/lib/imports/parser";
import type { CachedMoisMatchRecord } from "./phase2-lib";
import { buildStaticMapReviewLinks } from "./phase3a-lib";
import {
  isValidSeoulWgs84,
  selectSeoulPilotCandidates,
  validateSeoulPilotPackage,
  type SeoulOaRawRecord,
  type SeoulPilotCandidateInput,
} from "./phase3b-lib";

const PHASE2_DIR = path.resolve(
  process.cwd(),
  "local-data/address-db-poc/phase2"
);
const PHASE25_DIR = path.resolve(
  process.cwd(),
  "local-data/address-db-poc/phase25"
);
const PHASE3B_DIR = path.resolve(
  process.cwd(),
  "local-data/address-db-poc/phase3b"
);

const REMOTE_REST_URL = "https://wddnbycimcixskemssct.supabase.co";
const REMOTE_PUBLISHABLE_KEY =
  "sb_publishable_uG_cnLgtCuBfcRVIB_ktJA_HFpEEtWS";

function csvEscape(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function readUtf8Csv(filePath: string): Array<Record<string, string | undefined>> {
  const txt = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return parseCsv(txt);
}

function loadSeoulOaRecords(): SeoulOaRawRecord[] {
  const p = path.resolve(process.cwd(), "local-data/서울시 공중화장실 위치정보.csv");
  const txt = decodeCsvBuffer(fs.readFileSync(p), "cp949");
  const rows = parseCsv(txt);
  const out: SeoulOaRawRecord[] = [];
  for (const r of rows) {
    const lat = Number.parseFloat((r["y 좌표"] || "").trim());
    const lng = Number.parseFloat((r["x 좌표"] || "").trim());
    if (!isValidSeoulWgs84(lat, lng)) continue;
    out.push({
      seq: (r["연번"] || "").trim(),
      roadAddress: (r["도로명주소"] || "").trim(),
      jibunAddress: (r["지번주소"] || "").trim(),
      lat,
      lng,
      buildingName: (r["건물명"] || "").trim(),
      guName: (r["구 명칭"] || "").trim(),
      phone: (r["전화번호"] || "").trim(),
      categoryType: (r["유형"] || "").trim(),
      openHours: (r["개방시간"] || "").trim(),
      siteUse: (r["소재지 용도"] || "").trim(),
      toiletInfo: (r["화장실 현황"] || "").trim(),
      disabledInfo: (r["장애인화장실 현황"] || "").trim(),
      extraFacilities: (r["편의시설 (기타설비)"] || "").trim(),
      signage: (r["안내표지"] || "").trim(),
      siteType: (r["소재지"] || "").trim(),
      notes: (r["비고"] || "").trim(),
    });
  }
  return out;
}

async function loadCacheMap(): Promise<Map<string, CachedMoisMatchRecord>> {
  const map = new Map<string, CachedMoisMatchRecord>();
  const rl = readline.createInterface({
    input: fs.createReadStream(
      path.join(PHASE2_DIR, "_cache_local_db_matches.jsonl"),
      { encoding: "utf8" }
    ),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as CachedMoisMatchRecord;
    map.set(rec.id, rec);
  }
  return map;
}

async function fetchRemoteDedupSetReadOnly(): Promise<{
  source: "remote_rest" | "local_suwon_export_fallback";
  existingIds: Set<string>;
  existingSourceRecordIds: Set<string>;
  totalRemoteRows: number;
}> {
  const existingIds = new Set<string>();
  const existingSourceRecordIds = new Set<string>();
  let totalRemoteRows = 0;
  try {
    let offset = 0;
    const PAGE = 1000;
    while (true) {
      const url = `${REMOTE_REST_URL}/rest/v1/restrooms?select=id,source_record_id&order=id.asc&offset=${offset}&limit=${PAGE}`;
      const res = await fetch(url, {
        headers: { apikey: REMOTE_PUBLISHABLE_KEY },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const batch = (await res.json()) as Array<Record<string, any>>;
      if (!batch || batch.length === 0) break;
      for (const r of batch) {
        totalRemoteRows += 1;
        existingIds.add(r.id);
        if (r.source_record_id) existingSourceRecordIds.add(r.source_record_id);
      }
      if (batch.length < PAGE) break;
      offset += PAGE;
    }
    return {
      source: "remote_rest",
      existingIds,
      existingSourceRecordIds,
      totalRemoteRows,
    };
  } catch {
    const fallbackPath = path.resolve(
      process.cwd(),
      "local-data/suwon_remote_export.json"
    );
    const exp = JSON.parse(fs.readFileSync(fallbackPath, "utf8"));
    for (const r of exp.restrooms || []) {
      totalRemoteRows += 1;
      existingIds.add(r.id);
      if (r.source_record_id) existingSourceRecordIds.add(r.source_record_id);
    }
    return {
      source: "local_suwon_export_fallback",
      existingIds,
      existingSourceRecordIds,
      totalRemoteRows,
    };
  }
}

async function main() {
  const t0 = Date.now();
  fs.mkdirSync(PHASE3B_DIR, { recursive: true });

  const oaRecords = loadSeoulOaRecords();
  const p2Rows = readUtf8Csv(
    path.join(PHASE2_DIR, "nationwide_classification.csv")
  );
  const p25Rows = readUtf8Csv(
    path.join(PHASE25_DIR, "phase25_classification.csv")
  );
  const cacheById = await loadCacheMap();
  const remoteDedup = await fetchRemoteDedupSetReadOnly();

  const p2ById = new Map(p2Rows.map((r) => [r["restroom_id"] || "", r]));

  // All Phase 2/2.5 rows matching seoul_city_location
  const seoulPoolInputs: SeoulPilotCandidateInput[] = [];
  for (const r of p25Rows) {
    const id = r["restroom_id"] || "";
    const p2 = p2ById.get(id);
    const isSeoulSource =
      r["coord_source"] === "seoul_city_location" ||
      p2?.["coord_source"] === "seoul_city_location";
    if (!isSeoulSource) continue;

    const c = cacheById.get(id);
    const offLatStr = p2?.["official_lat"] || r["recommended_lat"] || "";
    const offLngStr = p2?.["official_lng"] || r["recommended_lng"] || "";
    const distStr = p2?.["official_to_mois_dist_m"] || "";

    seoulPoolInputs.push({
      restroomId: id,
      sourceRecordId: r["source_record_id"] || null,
      name: r["name"] || "",
      sido: r["sido"] || "",
      sigungu: r["sigungu"] || "",
      roadAddress: r["road_address"] || "",
      jibunAddress: r["jibun_address"] || "",
      baselineStatus: r["baseline_verification_status"] || "UNMATCHED",
      exposureTier: r["exposure_tier"] || "HIDDEN",
      coordSource: r["coord_source"] || p2?.["coord_source"] || null,
      officialLat: offLatStr ? Number(offLatStr) : null,
      officialLng: offLngStr ? Number(offLngStr) : null,
      officialToMoisDistM: distStr ? Number(distStr) : null,
      matchedBuildingMgmtNo: r["matched_building_mgmt_no"] || null,
      genderType: c?.gender_type ?? null,
      wheelchairAccessible: c?.wheelchair_accessible ?? null,
      babyChangingAvailable: c?.baby_changing_available ?? null,
      sanitaryProductsAvailable: c?.sanitary_products_available ?? null,
      description: c?.description ?? null,
    });
  }

  const { pkg, excluded, cleanPoolCount } = selectSeoulPilotCandidates(
    seoulPoolInputs,
    oaRecords,
    {
      limit: 50,
      remoteExistingIds: remoteDedup.existingIds,
      remoteExistingSourceRecordIds: remoteDedup.existingSourceRecordIds,
      sourceVersion: "2026-11-22",
      lastVerifiedAt: "2026-11-22T00:00:00Z",
    }
  );

  const validation = validateSeoulPilotPackage(
    pkg,
    remoteDedup.existingIds,
    remoteDedup.existingSourceRecordIds
  );
  if (!validation.valid) {
    throw new Error(
      `Seoul pilot package validation failed: ${validation.errors.join(" | ")}`
    );
  }

  // Write load package JSON
  fs.writeFileSync(
    path.join(PHASE3B_DIR, "seoul_pilot_50_package.json"),
    JSON.stringify(pkg, null, 2),
    "utf8"
  );

  // Write human-readable pilot 50 summary CSV with review links
  const summaryLines = [
    [
      "idx",
      "restroom_id",
      "source_record_id",
      "coordinate_source_record_id",
      "gu_name",
      "name",
      "road_address",
      "latitude",
      "longitude",
      "official_to_mois_dist_m",
      "oa_category_type",
      "gender_type",
      "wheelchair_accessible",
      "coordinate_source",
      "coordinate_type",
      "coordinate_verification_status",
      "kakao_map_review_url",
      "naver_map_review_url",
      "human_spot_check_required",
    ].join(","),
  ];
  pkg.restrooms.forEach((r, idx) => {
    const links = buildStaticMapReviewLinks(r.name, r.latitude, r.longitude);
    summaryLines.push(
      [
        idx + 1,
        r.id,
        r.source_record_id,
        r.coordinate_source_record_id,
        r.gu_name,
        r.name,
        r.road_address,
        r.latitude,
        r.longitude,
        r.official_to_mois_dist_m.toFixed(2),
        r.oa_category_type,
        r.gender_type,
        r.wheelchair_accessible,
        r.coordinate_source,
        r.coordinate_type,
        r.coordinate_verification_status,
        links.kakaoMapLink,
        links.naverSearchLink,
        true,
      ]
        .map(csvEscape)
        .join(",")
    );
  });
  fs.writeFileSync(
    path.join(PHASE3B_DIR, "seoul_pilot_50_summary.csv"),
    "\uFEFF" + summaryLines.join("\n"),
    "utf8"
  );

  // Excluded breakdown
  const excludedReasons: Record<string, number> = {};
  for (const e of excluded) {
    const key = e.reason.split(":")[0];
    excludedReasons[key] = (excludedReasons[key] ?? 0) + 1;
  }

  fs.writeFileSync(
    path.join(PHASE3B_DIR, "seoul_excluded_and_review_summary.json"),
    JSON.stringify(
      {
        oa22586RawCsvTotal: oaRecords.length,
        phase2MatchedSeoulCityLocation: seoulPoolInputs.length,
        phase25FacilityPinSeoulCityLocation: seoulPoolInputs.filter(
          (x) => x.exposureTier === "FACILITY_PIN"
        ).length,
        phase25Step0VerifiedSeoulCityLocation: seoulPoolInputs.filter(
          (x) =>
            x.baselineStatus === "VERIFIED" &&
            x.exposureTier === "FACILITY_PIN"
        ).length,
        strictCleanPublicOpenPool: cleanPoolCount,
        selectedPilotCount: pkg.restrooms.length,
        excludedTotalCount: excluded.length,
        excludedReasonCounts: excludedReasons,
      },
      null,
      2
    ),
    "utf8"
  );

  const excludedSampleLines = [
    ["restroom_id", "name", "sigungu", "reason"].join(","),
    ...excluded
      .slice(0, 120)
      .map((e) => [e.restroomId, e.name, e.sigungu, e.reason].map(csvEscape).join(",")),
  ];
  fs.writeFileSync(
    path.join(PHASE3B_DIR, "seoul_excluded_sample.csv"),
    "\uFEFF" + excludedSampleLines.join("\n"),
    "utf8"
  );

  const guCounts: Record<string, number> = {};
  for (const r of pkg.restrooms) {
    guCounts[r.gu_name] = (guCounts[r.gu_name] ?? 0) + 1;
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    remoteDedupSource: remoteDedup.source,
    remoteExistingCount: remoteDedup.totalRemoteRows,
    oa22586TotalRows: oaRecords.length,
    phase2MatchedSeoul: seoulPoolInputs.length,
    phase25FacilityPinSeoul: seoulPoolInputs.filter(
      (x) => x.exposureTier === "FACILITY_PIN"
    ).length,
    phase2Step0VerifiedSeoul: seoulPoolInputs.filter(
      (x) =>
        x.baselineStatus === "VERIFIED" && x.exposureTier === "FACILITY_PIN"
    ).length,
    strictCleanPublicOpenPool: cleanPoolCount,
    pilotSelectedCount: pkg.restrooms.length,
    distinctGusSelected: pkg.counts.distinctGus,
    guDistribution: guCounts,
    validationPassed: validation.valid,
    excludedTotal: excluded.length,
    excludedReasons,
  };
  fs.writeFileSync(
    path.join(PHASE3B_DIR, "phase3b_summary.json"),
    JSON.stringify(summary, null, 2),
    "utf8"
  );

  console.log("Phase 3-B Seoul pilot package built in", summary.elapsedMs, "ms");
  console.log("Funnel:", {
    oa22586Total: summary.oa22586TotalRows,
    phase2Matched: summary.phase2MatchedSeoul,
    phase25FacilityPin: summary.phase25FacilityPinSeoul,
    step0Verified: summary.phase2Step0VerifiedSeoul,
    strictCleanPool: summary.strictCleanPublicOpenPool,
    pilotSelected: summary.pilotSelectedCount,
    distinctGus: summary.distinctGusSelected,
  });
  console.log("Excluded reasons:", excludedReasons);
}

main().catch((err) => {
  console.error("Phase 3-B run failed:", err);
  process.exit(1);
});
