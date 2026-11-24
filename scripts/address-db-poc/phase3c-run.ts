#!/usr/bin/env node
/**
 * Phase 3-C Runner: Builds MOIS-free Seoul OA-22586 Canary-10 & Pilot-50 packages,
 * KOGL Type 1 attribution, full 503-row remote duplicate/proximity audit,
 * and human visual verification checklists (read-only on remote DB, zero Kakao API).
 *
 * Usage:
 *   npx tsx scripts/address-db-poc/phase3c-run.ts
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { decodeCsvBuffer, parseCsv } from "../../src/lib/imports/parser";
import { isValidSeoulWgs84, type SeoulOaRawRecord, validateSeoulPilotPackage } from "./phase3b-lib";
import {
  buildPhase3cMoisFreePackages,
  type NationalCatalogLink,
  type RemoteRestroomRef,
  type VerificationChecklistRow,
} from "./phase3c-lib";

const PHASE2_DIR = path.resolve(
  process.cwd(),
  "local-data/address-db-poc/phase2"
);
const PHASE3B_DIR = path.resolve(
  process.cwd(),
  "local-data/address-db-poc/phase3b"
);
const PHASE3C_DIR = path.resolve(
  process.cwd(),
  "local-data/address-db-poc/phase3c"
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

function writeChecklistCsv(filePath: string, rows: VerificationChecklistRow[]) {
  const headers: Array<keyof VerificationChecklistRow> = [
    "idx",
    "tier",
    "restroom_id",
    "source_record_id",
    "coordinate_source_record_id",
    "gu_name",
    "name",
    "landmark_category",
    "road_address",
    "address_detail",
    "latitude",
    "longitude",
    "kakao_map_review_url",
    "naver_map_review_url",
    "vworld_review_url",
    "map_building_match",
    "pin_on_building_or_entrance",
    "road_address_match",
    "public_signage_visible",
    "open_hours_claimed",
    "open_hours_verifiable_by_roadview",
    "toilet_info_claimed",
    "toilet_counts_verifiable_by_roadview",
    "wheelchair_claimed",
    "wheelchair_verifiable_by_roadview",
    "non_roadview_fields_status",
    "visual_review_status",
    "human_verified_complete",
    "reviewer_name",
    "reviewed_at",
    "review_decision",
    "review_notes",
  ];
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  fs.writeFileSync(filePath, "\uFEFF" + lines.join("\n"), "utf8");
}

function loadSeoulOaRecords(): {
  records: SeoulOaRawRecord[];
  sourceVersion: string;
  sourceFileSha256: string;
  fileSizeBytes: number;
} {
  const p = path.resolve(process.cwd(), "local-data/서울시 공중화장실 위치정보.csv");
  const buf = fs.readFileSync(p);
  const stat = fs.statSync(p);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  const sourceVersion = stat.mtime.toISOString().slice(0, 10);
  const txt = decodeCsvBuffer(buf, "cp949");
  const rows = parseCsv(txt);
  const records: SeoulOaRawRecord[] = [];
  for (const r of rows) {
    const lat = Number.parseFloat((r["y 좌표"] || "").trim());
    const lng = Number.parseFloat((r["x 좌표"] || "").trim());
    if (!isValidSeoulWgs84(lat, lng)) continue;
    records.push({
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
  return { records, sourceVersion, sourceFileSha256: sha256, fileSizeBytes: buf.length };
}

function loadNationalCatalogLinksOnly(): NationalCatalogLink[] {
  const txt = fs
    .readFileSync(path.join(PHASE2_DIR, "nationwide_classification.csv"), "utf8")
    .replace(/^\uFEFF/, "");
  const rows = parseCsv(txt);
  // Intentionally read ONLY official facility fields; ignore MOIS columns completely.
  return rows
    .filter((r) => (r["coord_source"] || "") === "seoul_city_location")
    .map((r) => ({
      restroomId: r["restroom_id"] || "",
      sourceRecordId: r["source_record_id"] || null,
      name: r["name"] || "",
      sigungu: r["sigungu"] || "",
      roadAddress: r["road_address"] || "",
      jibunAddress: r["jibun_address"] || "",
      officialLat: r["official_lat"] ? Number(r["official_lat"]) : null,
      officialLng: r["official_lng"] ? Number(r["official_lng"]) : null,
      coordSource: r["coord_source"] || null,
    }));
}

async function fetchRemoteRestroomsReadOnly(): Promise<{
  source: "remote_rest" | "local_suwon_export_fallback";
  rows: RemoteRestroomRef[];
}> {
  try {
    const out: RemoteRestroomRef[] = [];
    let offset = 0;
    const PAGE = 1000;
    while (true) {
      const url = `${REMOTE_REST_URL}/rest/v1/restrooms?select=id,source_record_id,type,name,road_address,latitude,longitude,coordinate_source&order=id.asc&offset=${offset}&limit=${PAGE}`;
      const res = await fetch(url, {
        headers: { apikey: REMOTE_PUBLISHABLE_KEY },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const batch = (await res.json()) as RemoteRestroomRef[];
      if (!Array.isArray(batch) || batch.length === 0) break;
      out.push(...batch);
      if (batch.length < PAGE) break;
      offset += PAGE;
    }
    return { source: "remote_rest", rows: out };
  } catch {
    const exp = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "local-data/suwon_remote_export.json"), "utf8")
    );
    return {
      source: "local_suwon_export_fallback",
      rows: (exp.restrooms || []).map((r: any) => ({
        id: r.id,
        source_record_id: r.source_record_id ?? null,
        type: r.type,
        name: r.name,
        road_address: r.road_address,
        latitude: r.latitude,
        longitude: r.longitude,
        coordinate_source: r.coordinate_source ?? null,
      })),
    };
  }
}

async function main() {
  const t0 = Date.now();
  fs.mkdirSync(PHASE3C_DIR, { recursive: true });

  const { records: oaRecords, sourceVersion, sourceFileSha256, fileSizeBytes } =
    loadSeoulOaRecords();
  const nationalLinks = loadNationalCatalogLinksOnly();
  const remoteRes = await fetchRemoteRestroomsReadOnly();

  const phase3bPkg = JSON.parse(
    fs.readFileSync(path.join(PHASE3B_DIR, "seoul_pilot_50_package.json"), "utf8")
  );
  const phase3bSelectedIds = new Set<string>(
    (phase3bPkg.restrooms || []).map((r: any) => String(r.id))
  );

  const result = buildPhase3cMoisFreePackages({
    oaRecords,
    nationalLinks,
    remoteRows: remoteRes.rows,
    sourceVersion,
    sourceFileSha256,
    lastVerifiedAt: `${sourceVersion}T00:00:00Z`,
    phase3bSelectedIds,
  });

  const remoteIdSet = new Set(remoteRes.rows.map((r) => r.id));
  const remoteSrcSet = new Set(
    remoteRes.rows.map((r) => r.source_record_id).filter((v): v is string => Boolean(v))
  );

  // Reuse Phase 3-B package validator as structural/policy invariant gate
  const validate50 = validateSeoulPilotPackage(
    result.pilot50Pkg as any,
    remoteIdSet,
    remoteSrcSet
  );
  const validate10 = validateSeoulPilotPackage(
    result.canary10Pkg as any,
    remoteIdSet,
    remoteSrcSet
  );
  if (!validate50.valid || !validate10.valid) {
    throw new Error(
      `Phase 3-C validation failed: pilot50=${JSON.stringify(validate50.errors)} canary10=${JSON.stringify(validate10.errors)}`
    );
  }

  fs.writeFileSync(
    path.join(PHASE3C_DIR, "seoul_pilot_10_package.json"),
    JSON.stringify(result.canary10Pkg, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(PHASE3C_DIR, "seoul_pilot_50_package.json"),
    JSON.stringify(result.pilot50Pkg, null, 2),
    "utf8"
  );
  writeChecklistCsv(
    path.join(PHASE3C_DIR, "seoul_pilot_10_verification_checklist.csv"),
    result.canary10Checklist
  );
  writeChecklistCsv(
    path.join(PHASE3C_DIR, "seoul_pilot_50_verification_checklist.csv"),
    result.pilot50Checklist
  );
  fs.writeFileSync(
    path.join(PHASE3C_DIR, "seoul_quarantined_holds.json"),
    JSON.stringify(result.quarantinedHolds, null, 2),
    "utf8"
  );

  const summary = {
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    remoteDedupSource: remoteRes.source,
    remoteExistingCount: remoteRes.rows.length,
    sourceFile: {
      path: "local-data/서울시 공중화장실 위치정보.csv",
      sizeBytes: fileSizeBytes,
      sha256: sourceFileSha256,
      sourceVersion,
      licenseName: result.pilot50Pkg.publicDataSource.licenseName,
      licenseUrl: result.pilot50Pkg.publicDataSource.licenseUrl,
    },
    moisDependencyRemoved: true,
    funnel: result.funnel,
    canary10Count: result.canary10Pkg.counts.restrooms,
    canary10DistinctGus: result.canary10Pkg.counts.distinctGus,
    pilot50Count: result.pilot50Pkg.counts.restrooms,
    pilot50DistinctGus: result.pilot50Pkg.counts.distinctGus,
    humanReviewStatus: {
      canary10Pending: result.canary10Checklist.filter((r) => !r.human_verified_complete).length,
      canary10Complete: result.canary10Checklist.filter((r) => r.human_verified_complete).length,
      pilot50Pending: result.pilot50Checklist.filter((r) => !r.human_verified_complete).length,
      pilot50Complete: result.pilot50Checklist.filter((r) => r.human_verified_complete).length,
    },
    validationPassed: {
      canary10: validate10.valid,
      pilot50: validate50.valid,
    },
    quarantinedHoldCount: result.quarantinedHolds.length,
  };
  fs.writeFileSync(
    path.join(PHASE3C_DIR, "phase3c_summary.json"),
    JSON.stringify(summary, null, 2),
    "utf8"
  );

  console.log("Phase 3-C packages & checklists built:", JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error("Phase 3-C failed:", err);
  process.exit(1);
});
