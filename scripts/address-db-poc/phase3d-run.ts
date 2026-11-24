#!/usr/bin/env node
/**
 * Phase 3-D Runner: Evaluates Seoul Canary-10 under the Official-Data Pilot Policy,
 * distinguishes OFFICIAL_SOURCE_VALIDATED vs FIELD_VERIFIED vs REVIEW_REQUIRED,
 * never modifies human review decisions, and generates the final deployable load package.
 *
 * Strictly local & read-only on remote DB (zero writes, zero migrations pushed, zero Kakao calls).
 *
 * Usage:
 *   npx tsx scripts/address-db-poc/phase3d-run.ts
 */

import fs from "node:fs";
import path from "node:path";
import { decodeCsvBuffer, parseCsv } from "../../src/lib/imports/parser";
import {
  isValidSeoulWgs84,
  validateSeoulPilotPackage,
  type SeoulOaRawRecord,
} from "./phase3b-lib";
import type {
  CanaryReviewDecision,
  Phase3cLoadPackage,
  RemoteRestroomRef,
} from "./phase3c-lib";
import { evaluatePhase3dCanaryCandidates } from "./phase3d-lib";

const PHASE3C_DIR = path.resolve(
  process.cwd(),
  "local-data/address-db-poc/phase3c"
);
const PHASE3D_DIR = path.resolve(
  process.cwd(),
  "local-data/address-db-poc/phase3d"
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
  fs.mkdirSync(PHASE3D_DIR, { recursive: true });

  const pkg10 = JSON.parse(
    fs.readFileSync(path.join(PHASE3C_DIR, "seoul_pilot_10_package.json"), "utf8")
  ) as Phase3cLoadPackage;

  // Read existing human review decisions STRICTLY read-only (never modify them)
  const humanDecisions = JSON.parse(
    fs.readFileSync(
      path.join(PHASE3C_DIR, "seoul_pilot_10_review_decisions.json"),
      "utf8"
    )
  ) as CanaryReviewDecision[];

  const oaRecords = loadSeoulOaRecords();
  const remoteRes = await fetchRemoteRestroomsReadOnly();

  const { evaluated, finalPackage } = evaluatePhase3dCanaryCandidates({
    pkg: pkg10,
    oaRecords,
    remoteRows: remoteRes.rows,
    humanDecisions,
    sourceVersion: pkg10.sourceVersion,
  });

  const remoteIdSet = new Set(remoteRes.rows.map((r) => r.id));
  const remoteSrcSet = new Set(
    remoteRes.rows
      .map((r) => r.source_record_id)
      .filter((v): v is string => Boolean(v))
  );

  const structuralValidation =
    finalPackage.restrooms.length > 0
      ? validateSeoulPilotPackage(
          finalPackage as any,
          remoteIdSet,
          remoteSrcSet
        )
      : { valid: false, errors: ["empty_approved_package"] };

  if (!structuralValidation.valid) {
    throw new Error(
      `Phase 3-D final package failed structural validation: ${JSON.stringify(structuralValidation.errors)}`
    );
  }

  fs.writeFileSync(
    path.join(PHASE3D_DIR, "seoul_canary_final_package.json"),
    JSON.stringify(finalPackage, null, 2),
    "utf8"
  );

  fs.writeFileSync(
    path.join(PHASE3D_DIR, "seoul_canary_evaluation_report.json"),
    JSON.stringify(evaluated, null, 2),
    "utf8"
  );

  const csvHeaders = [
    "idx",
    "restroom_id",
    "source_record_id",
    "coordinate_source_record_id",
    "gu_name",
    "name",
    "road_address",
    "latitude",
    "longitude",
    "validation_status",
    "field_verified",
    "official_source_validated",
    "approved_for_pilot",
    "nearest_oa_dist_m",
    "nearest_oa_name",
    "nearest_remote_dist_m",
    "human_building_result",
    "human_open_result",
    "needs_field_confirmation_items",
    "failed_checks",
  ];
  const csvLines = [csvHeaders.join(",")];
  for (const e of evaluated) {
    csvLines.push(
      [
        e.idx,
        e.restroomId,
        e.sourceRecordId,
        e.coordinateSourceRecordId,
        e.guName,
        e.name,
        e.roadAddress,
        e.latitude,
        e.longitude,
        e.validationStatus,
        e.fieldVerified,
        e.officialSourceValidated,
        e.approvedForPilot,
        e.nearestOaNeighbor.distM,
        e.nearestOaNeighbor.name,
        e.nearestRemoteDistM,
        e.humanDecisionSummary.buildingLocationResult,
        e.humanDecisionSummary.restroomExistenceOpenResult,
        e.needsFieldConfirmationItems.join(" | "),
        e.checks.failedChecks.join(" | "),
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  fs.writeFileSync(
    path.join(PHASE3D_DIR, "seoul_canary_evaluation_table.csv"),
    "\uFEFF" + csvLines.join("\n"),
    "utf8"
  );

  const summary = {
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    remoteDedupSource: remoteRes.source,
    remoteExistingCount: remoteRes.rows.length,
    sourceVersion: finalPackage.sourceVersion,
    sourceFileSha256: finalPackage.sourceFileSha256,
    policyVersion: finalPackage.policyVersion,
    counts: finalPackage.counts,
    validationPassed: structuralValidation.valid,
  };
  fs.writeFileSync(
    path.join(PHASE3D_DIR, "phase3d_summary.json"),
    JSON.stringify(summary, null, 2),
    "utf8"
  );

  console.log("Phase 3-D official-data canary evaluation complete:", summary);
}

main().catch((err) => {
  console.error("Phase 3-D runner FAILED:", err);
  process.exit(1);
});
