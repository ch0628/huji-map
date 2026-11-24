#!/usr/bin/env node
/**
 * Phase 3-A Runner: Pre-Publication Verification, License Governance,
 * Suwon 502 Protection, DB/API Compatibility Check, and Pilot Candidate DRY-RUN.
 *
 * Reuses Phase 2.5 outputs without re-running nationwide classification.
 * Strictly read-only: zero remote DB writes, zero Kakao API calls.
 *
 * Usage:
 *   npx tsx scripts/address-db-poc/phase3a-run.ts
 */

import fs from "node:fs";
import path from "node:path";
import { parseCsv } from "../../src/lib/imports/parser";
import { isValidKoreaWgs84 } from "./lib";
import {
  SOURCE_LICENSE_MATRIX,
  MIGRATION_20261124_ALLOWED_SOURCES,
  REMOTE_20261122_ALLOWED_SOURCES,
  assessSuwon502Row,
  buildStaticMapReviewLinks,
  mapPhase2SourceToDbSource,
  resolveCompatibleExposureTier,
  type SuwonProtectionAssessment,
} from "./phase3a-lib";
import type { CoordType, VerificationStatus } from "./phase2-lib";
import type { ExposureTier } from "./phase25-lib";

const PHASE25_DIR = path.resolve(
  process.cwd(),
  "local-data/address-db-poc/phase25"
);
const PHASE3A_DIR = path.resolve(
  process.cwd(),
  "local-data/address-db-poc/phase3a"
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

function readCsvFile(filePath: string): Array<Record<string, string | undefined>> {
  const txt = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return parseCsv(txt);
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

function getReviewQuestionForStratum(stratum: string, tier: string): string {
  if (stratum === "1_OFFICIAL_MBC_COMPLEX") {
    return tier === "FACILITY_PIN"
      ? "복합단지 내 해당 동/시설의 실제 위치와 공식 좌표가 일치하는지 지도·로드뷰로 확인"
      : "공유좌표 의심 또는 보류 건 — 단지 내 개별 화장실 위치 확인 필요";
  }
  if (stratum === "2_SHARED_ADDRESS") {
    return tier === "HIDDEN"
      ? "동일 주소 공유 다중 화장실 — 야외/개별 건물 분산 여부 확인 필요"
      : "단일 건물 내 복수 등록(층/성별 구분)이 맞는지 건물 외관·안내표지 확인";
  }
  if (stratum === "3_SINGLE_BLDG_CANDIDATE") {
    return "행안부 단일 건물 중심점에 실제 공중/개방화장실이 존재하는지 지도·로드뷰로 확인";
  }
  return tier === "FACILITY_PIN"
    ? "공원 관리사무소가 아닌 실제 공원 화장실 시설 위치인지 위성·로드뷰로 확인"
    : tier === "BUILDING_PIN"
      ? "전용 공중화장실 건물 좌표가 실제 화장실 위치와 일치하는지 위성·로드뷰로 확인"
      : "공원·야외 보류 건 — 현장/공식 자료를 통한 실제 좌표 확보 필요";
}

async function main() {
  fs.mkdirSync(PHASE3A_DIR, { recursive: true });
  const t0 = Date.now();

  const classRows = readCsvFile(
    path.join(PHASE25_DIR, "phase25_classification.csv")
  );
  const sampleRows = readCsvFile(
    path.join(PHASE25_DIR, "sample_verification_80.csv")
  );
  const remoteDedup = await fetchRemoteDedupSetReadOnly();

  // Task 1: License Audit
  fs.writeFileSync(
    path.join(PHASE3A_DIR, "license_audit.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sources: SOURCE_LICENSE_MATRIX,
        facilityPinVsBuildingPinSummary: {
          facilityPinOfficialSourcesCount: 6104,
          buildingPinMoisSourcesCount: 22658,
          moisBuildingPinAllowedNow: false,
          moisBlockers: [
            "business.juso.go.kr 활용신청서/승인서/약관상 상업적 공개 및 변환좌표 DB 영구저장 허용 여부 UNCONFIRMED",
            "원격 Supabase 풀러 리전(aws-0-ap-southeast-2, 시드니)과 국내 공간정보 국외반출 제한 저촉 여부 UNCONFIRMED",
          ],
          gyeonggi15011425Note:
            "공공데이터포털(15011425)은 '이용허락범위 제한 없음'이나 경기데이터드림(data.gg.go.kr/portal/termsPolicyPage.do) 제12조 ⑥항 및 제14조 ②항 9호가 상업/영리 이용 시 사전 승인을 요구하여 상충 해소 확인 필요",
        },
      },
      null,
      2
    ),
    "utf8"
  );

  // Task 2: Independent Sample 80 Review Workbook
  let verifiedCompleteCount = 0;
  let pendingHumanReviewCount = 0;
  const reviewCsvLines = [
    [
      "stratum",
      "random_seed",
      "restroom_id",
      "source_record_id",
      "name",
      "sido",
      "sigungu",
      "road_address",
      "baseline_status",
      "phase25_exposure_tier",
      "phase25_rule_tag",
      "coord_source",
      "recommended_lat",
      "recommended_lng",
      "min_building_dist_m",
      "matched_building_mgmt_no",
      "matched_building_name",
      "raw_agency",
      "raw_open_hours",
      "kakao_map_review_url",
      "naver_map_review_url",
      "vworld_review_url",
      "review_checklist_question",
      "human_visual_review_required",
      "verified_complete",
    ].join(","),
  ];

  for (const s of sampleRows) {
    const humanReq = s["human_visual_review_required"] === "true";
    const verifiedComplete = !humanReq;
    if (verifiedComplete) verifiedCompleteCount += 1;
    else pendingHumanReviewCount += 1;

    const latStr = s["recommended_lat"] || "";
    const lngStr = s["recommended_lng"] || "";
    const lat = latStr ? Number(latStr) : null;
    const lng = lngStr ? Number(lngStr) : null;
    const links = buildStaticMapReviewLinks(s["name"] || "", lat, lng);

    reviewCsvLines.push(
      [
        s["stratum"],
        s["random_seed"],
        s["restroom_id"],
        s["source_record_id"],
        s["name"],
        s["sido"],
        s["sigungu"],
        s["road_address"],
        s["baseline_status"],
        s["phase25_exposure_tier"],
        s["phase25_rule_tag"],
        s["coord_source"],
        latStr,
        lngStr,
        s["min_building_dist_m"],
        s["matched_building_mgmt_no"],
        s["matched_building_name"],
        s["raw_agency"],
        s["raw_open_hours"],
        links.kakaoMapLink,
        links.naverSearchLink,
        links.vworldLink,
        getReviewQuestionForStratum(
          s["stratum"] || "",
          s["phase25_exposure_tier"] || "HIDDEN"
        ),
        humanReq,
        verifiedComplete,
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  fs.writeFileSync(
    path.join(PHASE3A_DIR, "independent_sample_review_80.csv"),
    "\uFEFF" + reviewCsvLines.join("\n"),
    "utf8"
  );

  // Task 3: Existing Suwon 502 Protection & Correction Proposals
  const suwonRemoteRows = classRows.filter(
    (r) => r["is_existing_remote_suwon"] === "true"
  );
  const suwonAssessments: SuwonProtectionAssessment[] = [];
  const suwonRiskCounts: Record<string, number> = {};

  for (const r of suwonRemoteRows) {
    const assessment = assessSuwon502Row({
      restroomId: r["restroom_id"] || "",
      name: r["name"] || "",
      exposureTier: (r["exposure_tier"] || "HIDDEN") as ExposureTier,
      minBuildingDistM: r["min_building_dist_m"]
        ? Number(r["min_building_dist_m"])
        : null,
      baselineReviewReasons: (r["baseline_review_reasons"] || "")
        .split(";")
        .filter(Boolean),
    });
    suwonAssessments.push(assessment);
    suwonRiskCounts[assessment.riskCategory] =
      (suwonRiskCounts[assessment.riskCategory] ?? 0) + 1;
  }

  const suwonById = new Map(
    suwonRemoteRows.map((r) => [r["restroom_id"] || "", r])
  );
  const suwonReviewLines = [
    [
      "restroom_id",
      "name",
      "sigungu",
      "road_address",
      "baseline_status",
      "phase25_exposure_tier",
      "protection_action",
      "risk_category",
      "min_building_dist_m",
      "baseline_review_reasons",
      "correction_proposal",
    ].join(","),
  ];

  for (const a of suwonAssessments) {
    if (a.riskCategory === "SAFE_FACILITY_PIN") continue;
    const raw = suwonById.get(a.restroomId)!;
    suwonReviewLines.push(
      [
        a.restroomId,
        a.name,
        raw["sigungu"],
        raw["road_address"],
        raw["baseline_verification_status"],
        a.exposureTier,
        a.protectionAction,
        a.riskCategory,
        raw["min_building_dist_m"],
        raw["baseline_review_reasons"],
        a.correctionProposal,
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  fs.writeFileSync(
    path.join(PHASE3A_DIR, "suwon_502_protection_review.csv"),
    "\uFEFF" + suwonReviewLines.join("\n"),
    "utf8"
  );

  // Task 4: DB/API Compatibility Verification across all 51,260 Phase 2.5 classifications
  let compatFacilityPinCount = 0;
  let compatBuildingPinBlockedByMoisLicense = 0;
  let compatHiddenCount = 0;
  let remote20261122BlockedSources = 0;
  let migration20261124AllowedSources = 0;

  for (const r of classRows) {
    const tier = (r["exposure_tier"] || "HIDDEN") as ExposureTier;
    if (tier === "HIDDEN") {
      compatHiddenCount += 1;
      continue;
    }
    const dbSource = mapPhase2SourceToDbSource(r["coord_source"] || null);
    if (dbSource) {
      if (!REMOTE_20261122_ALLOWED_SOURCES.has(dbSource)) {
        remote20261122BlockedSources += 1;
      }
      if (MIGRATION_20261124_ALLOWED_SOURCES.has(dbSource)) {
        migration20261124AllowedSources += 1;
      }
    }
    const lat = r["recommended_lat"] ? Number(r["recommended_lat"]) : null;
    const lng = r["recommended_lng"] ? Number(r["recommended_lng"]) : null;
    const resolved = resolveCompatibleExposureTier(
      {
        type: "public",
        publication_status: "published",
        latitude: lat,
        longitude: lng,
        coordinate_source: dbSource,
        coordinate_type: (r["coord_type"] || "none") as CoordType,
        coordinate_verification_status: (r["baseline_verification_status"] ||
          null) as VerificationStatus | null,
      },
      { moisLicenseCleared: false }
    );
    if (resolved.exposureTier === "FACILITY_PIN") {
      compatFacilityPinCount += 1;
    } else if (resolved.blockReason === "mois_license_unconfirmed") {
      compatBuildingPinBlockedByMoisLicense += 1;
    } else {
      compatHiddenCount += 1;
    }
  }

  // Task 5: First Pilot Selection & DRY-RUN Readiness Check
  const haenggungRe =
    /(행궁|화성|팔달문|화홍문|장안문|창룡문|서장대|연무대|화서문|남수동|북수동|신풍동|장안동|팔달로|지동|화서동)/;
  const suwonAll = classRows.filter((r) =>
    (r["sigungu"] || "").startsWith("수원시")
  );
  const haenggungAll = suwonAll.filter((r) =>
    haenggungRe.test(
      `${r["name"] || ""} ${r["road_address"] || ""} ${r["jibun_address"] || ""}`
    )
  );
  const haenggungNonRemote = haenggungAll.filter(
    (r) =>
      r["is_existing_remote_suwon"] !== "true" &&
      !remoteDedup.existingIds.has(r["restroom_id"] || "") &&
      !(
        r["source_record_id"] &&
        remoteDedup.existingSourceRecordIds.has(r["source_record_id"])
      )
  );
  const suwonNonRemoteFacility = suwonAll.filter(
    (r) =>
      r["is_existing_remote_suwon"] !== "true" &&
      r["exposure_tier"] === "FACILITY_PIN" &&
      !remoteDedup.existingIds.has(r["restroom_id"] || "")
  );

  // Also inspect non-Suwon Step-0 VERIFIED candidates from portal "이용허락범위 제한 없음" sources
  // (seoul_city_location, seoul_metro_2026, incheon_michuhol_2026) as pre-verification DRY-RUN inspection queue
  const licenseClearSources = new Set([
    "seoul_city_location",
    "seoul_metro_2026",
    "incheon_michuhol_2026",
  ]);
  const portalClearStep0Candidates = classRows.filter((r) => {
    const id = r["restroom_id"] || "";
    const srcRecId = r["source_record_id"] || "";
    const lat = r["recommended_lat"] ? Number(r["recommended_lat"]) : null;
    const lng = r["recommended_lng"] ? Number(r["recommended_lng"]) : null;
    return (
      r["is_existing_remote_suwon"] !== "true" &&
      !remoteDedup.existingIds.has(id) &&
      !(srcRecId && remoteDedup.existingSourceRecordIds.has(srcRecId)) &&
      r["baseline_verification_status"] === "VERIFIED" &&
      r["exposure_tier"] === "FACILITY_PIN" &&
      licenseClearSources.has(r["coord_source"] || "") &&
      lat !== null &&
      lng !== null &&
      isValidKoreaWgs84(lat, lng)
    );
  });

  // Sort deterministically by sigungu, name and slice <= 50 for DRY-RUN pre-verification inspection only
  const preCheckQueue50 = [...portalClearStep0Candidates]
    .sort((a, b) =>
      `${a["sido"]}|${a["sigungu"]}|${a["name"]}`.localeCompare(
        `${b["sido"]}|${b["sigungu"]}|${b["name"]}`,
        "ko"
      )
    )
    .slice(0, 50)
    .map((r) => ({
      restroom_id: r["restroom_id"],
      source_record_id: r["source_record_id"],
      name: r["name"],
      sido: r["sido"],
      sigungu: r["sigungu"],
      road_address: r["road_address"],
      phase2_status: r["baseline_verification_status"],
      exposure_tier: r["exposure_tier"],
      coord_source_raw: r["coord_source"],
      db_coordinate_source: mapPhase2SourceToDbSource(r["coord_source"] || null),
      coordinate_type: r["coord_type"],
      latitude: Number(r["recommended_lat"]),
      longitude: Number(r["recommended_lng"]),
      access_mode: "free",
      ready_for_live_load: false,
      blockers: [
        "human_visual_review_pending (Task 2 미완료)",
        "remote_migration_20261124000000_not_applied (원격 DB 미적용)",
        "regional_expansion_beyond_suwon_unapproved (서울/인천 확장 승인 필요)",
      ],
    }));

  const pilotPackage = {
    generatedAt: new Date().toISOString(),
    remoteDedupSource: remoteDedup.source,
    remoteExistingCount: remoteDedup.totalRemoteRows,
    actualLoadEligibleNowCount: 0,
    actualLoadBlockReason:
      "이용 조건 확인(경기 15011425 약관 상충, 행안부 UNCONFIRMED) 및 독립 표본 사람 육안 위치 검증(80건 중 0건 완료), 원격 20261124000000 마이그레이션 미적용으로 현 시점 실제 원격 적재 가능 대상은 0건",
    haenggungHwaseongAudit: {
      totalInArea: haenggungAll.length,
      alreadyOnRemote: haenggungAll.length - haenggungNonRemote.length,
      nonRemoteRemaining: haenggungNonRemote.length,
      nonRemoteBreakdown: haenggungNonRemote.map((r) => ({
        restroom_id: r["restroom_id"],
        name: r["name"],
        exposure_tier: r["exposure_tier"],
        coord_source: r["coord_source"] || null,
        blocker:
          r["exposure_tier"] === "HIDDEN"
            ? "position_hidden_review_required"
            : "mois_license_unconfirmed",
      })),
      readyForLiveLoadCount: 0,
    },
    suwonNonRemoteFacilityPinAudit: {
      count: suwonNonRemoteFacility.length,
      items: suwonNonRemoteFacility.map((r) => ({
        restroom_id: r["restroom_id"],
        name: r["name"],
        sigungu: r["sigungu"],
        coord_source: r["coord_source"],
        blockers: [
          "경기데이터드림 약관 제12조 ⑥항·제14조 9호 상용/영리 사전확인 미완료",
          "사람 육안 위치 확인 미완료",
        ],
      })),
      readyForLiveLoadCount: 0,
    },
    portalNoRestrictionNonSuwonStep0PoolCount: portalClearStep0Candidates.length,
    preCheckDryRunInspectionQueueCount: preCheckQueue50.length,
    preCheckDryRunInspectionQueue: preCheckQueue50,
  };

  fs.writeFileSync(
    path.join(PHASE3A_DIR, "pilot_dryrun_candidates_50.json"),
    JSON.stringify(pilotPackage, null, 2),
    "utf8"
  );

  const summary = {
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    task1LicenseReadiness: {
      confirmedNoRestrictionPortalCount: SOURCE_LICENSE_MATRIX.filter(
        (s) => s.status === "CONFIRMED_NO_RESTRICTION"
      ).length,
      termsConflictNeedingConfirmationCount: SOURCE_LICENSE_MATRIX.filter(
        (s) => s.status === "PORTAL_NO_RESTRICTION_WITH_TERMS_CONFLICT"
      ).length,
      unconfirmedCount: SOURCE_LICENSE_MATRIX.filter(
        (s) => s.status === "UNCONFIRMED"
      ).length,
      prohibitedCount: SOURCE_LICENSE_MATRIX.filter(
        (s) => s.status === "PROHIBITED_FOR_DB_STORAGE"
      ).length,
    },
    task2IndependentSampleStatus: {
      totalSampled: sampleRows.length,
      verifiedCompleteCount,
      pendingHumanReviewCount,
    },
    task3Suwon502Protection: {
      totalRemoteProtected: suwonRemoteRows.length,
      deletedOrUnpublishedCount: 0,
      riskCategoryCounts: suwonRiskCounts,
      nonFacilityPinReviewRowsCount: suwonAssessments.filter(
        (a) => a.riskCategory !== "SAFE_FACILITY_PIN"
      ).length,
    },
    task4DbApiCompatibility: {
      totalEvaluated: classRows.length,
      compatibleFacilityPinCount: compatFacilityPinCount,
      buildingPinBlockedByMoisLicenseCount: compatBuildingPinBlockedByMoisLicense,
      compatibleHiddenCount: compatHiddenCount,
      rowsBlockedByRemote20261122Constraint: remote20261122BlockedSources,
      rowsAllowedAfter20261124Constraint: migration20261124AllowedSources,
    },
    task5PilotSelection: {
      actualLoadEligibleNowCount: 0,
      haenggungNonRemoteCount: haenggungNonRemote.length,
      suwonNonRemoteFacilityPinCount: suwonNonRemoteFacility.length,
      portalNoRestrictionStep0PoolCount: portalClearStep0Candidates.length,
      preCheckDryRunQueueCount: preCheckQueue50.length,
    },
  };

  fs.writeFileSync(
    path.join(PHASE3A_DIR, "phase3a_summary.json"),
    JSON.stringify(summary, null, 2),
    "utf8"
  );

  console.log("Phase 3-A verification complete in", summary.elapsedMs, "ms");
  console.log("Sample status:", summary.task2IndependentSampleStatus);
  console.log("Suwon 502 risk categories:", summary.task3Suwon502Protection.riskCategoryCounts);
  console.log("DB/API compat:", summary.task4DbApiCompatibility);
  console.log("Pilot selection:", summary.task5PilotSelection);
}

main().catch((err) => {
  console.error("Phase 3-A run failed:", err);
  process.exit(1);
});
