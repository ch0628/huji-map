#!/usr/bin/env node
/**
 * Phase 2.5 Runner: Reclassification & Map Exposure Policy Simulation (PoC).
 *
 * Strictly read-only on local Phase 2 caches & municipal CSVs:
 * - Zero remote Supabase writes
 * - Zero Kakao API calls and zero Kakao coordinate inputs
 * - Outputs exclusively to `local-data/address-db-poc/phase25/` (Git-ignored)
 *
 * Usage:
 *   npx tsx scripts/address-db-poc/phase25-run.ts
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { decodeCsvBuffer, parseCsv } from "../../src/lib/imports/parser";
import type {
  CachedMoisMatchRecord,
  CoordType,
  ReviewReason,
  VerificationStatus,
} from "./phase2-lib";
import {
  analyzeSharedOfficialCoords,
  classifyPhase25Record,
  seededSample,
  type NavBuildingSummary,
  type Phase2BaselineInput,
  type Phase25Result,
} from "./phase25-lib";

const PHASE2_DIR = path.resolve(
  process.cwd(),
  "local-data/address-db-poc/phase2"
);
const PHASE25_DIR = path.resolve(
  process.cwd(),
  "local-data/address-db-poc/phase25"
);

const CACHE_PATH = path.join(PHASE2_DIR, "_cache_local_db_matches.jsonl");
const BASELINE_CSV_PATH = path.join(
  PHASE2_DIR,
  "nationwide_classification.csv"
);
const BLDG_CACHE_PATH = path.join(
  PHASE25_DIR,
  "_cache_road_pk_buildings.jsonl"
);

function csvEscape(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function loadBaselineCsv(): Promise<Phase2BaselineInput[]> {
  const txt = fs
    .readFileSync(BASELINE_CSV_PATH, "utf8")
    .replace(/^\uFEFF/, "");
  const parsed = parseCsv(txt);
  const numOrNull = (v: string | undefined) => {
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return parsed.map((row) => ({
    id: row["restroom_id"] ?? "",
    sourceRecordId: row["source_record_id"] || null,
    name: row["name"] ?? "",
    sido: row["sido"] ?? "",
    sigungu: row["sigungu"] ?? "",
    roadAddress: row["road_address"] ?? "",
    jibunAddress: row["jibun_address"] ?? "",
    baselineStatus: (row["verification_status"] ?? "UNMATCHED") as VerificationStatus,
    baselineReviewReasons: (row["review_reasons"] ?? "")
      .split(";")
      .filter(Boolean) as ReviewReason[],
    baselineCoordSource: row["coord_source"] || null,
    baselineCoordType: (row["coord_type"] || "none") as CoordType,
    officialLat: numOrNull(row["official_lat"]),
    officialLng: numOrNull(row["official_lng"]),
    moisLat: numOrNull(row["mois_candidate_lat"]),
    moisLng: numOrNull(row["mois_candidate_lng"]),
    officialToMoisDistM: numOrNull(row["official_to_mois_dist_m"]),
    buildingCount: Number(row["building_count"] || "0"),
    sharedAddressCount: Number(row["shared_address_count"] || "1"),
    duplicateGroupCount: Number(row["duplicate_group_count"] || "1"),
    isExistingRemoteSuwon: row["is_existing_remote_suwon"] === "true",
  }));
}

async function loadCacheMap(): Promise<Map<string, CachedMoisMatchRecord>> {
  const map = new Map<string, CachedMoisMatchRecord>();
  const rl = readline.createInterface({
    input: fs.createReadStream(CACHE_PATH, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as CachedMoisMatchRecord;
    if (
      rec.sido === "세종특별자치시" &&
      (!rec.sigungu || rec.sigungu === "(시군구미상)")
    ) {
      rec.sigungu = "세종특별자치시";
    }
    map.set(rec.id, rec);
  }
  return map;
}

async function loadBuildingMap(): Promise<Map<string, NavBuildingSummary[]>> {
  const map = new Map<string, NavBuildingSummary[]>();
  const rl = readline.createInterface({
    input: fs.createReadStream(BLDG_CACHE_PATH, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line) as {
      pk: string;
      buildings: NavBuildingSummary[];
    };
    map.set(obj.pk, obj.buildings);
  }
  return map;
}

function loadRawNationalEvidence(): Map<
  string,
  { agency: string; openHours: string; category: string; lawBasis: string }
> {
  const map = new Map<
    string,
    { agency: string; openHours: string; category: string; lawBasis: string }
  >();
  const p = path.resolve(process.cwd(), "local-data/public_restroom_raw.csv");
  if (!fs.existsSync(p)) return map;
  const txt = decodeCsvBuffer(fs.readFileSync(p), "cp949");
  const rows = parseCsv(txt);
  for (const r of rows) {
    const recId = (r["관리번호"] || "").trim();
    if (!recId) continue;
    map.set(recId, {
      agency: (r["관리기관명"] || "").trim(),
      openHours: (r["개방시간상세"] || r["개방시간"] || "").trim(),
      category: (r["구분명"] || "").trim(),
      lawBasis: (r["근거법령명"] || "").trim(),
    });
  }
  return map;
}

function computeWaterfall(
  results: Phase25Result[],
  total: number
): Array<{
  step: number;
  label: string;
  addedFacilityPin: number;
  addedBuildingPin: number;
  addedTotal: number;
  cumFacilityPin: number;
  cumBuildingPin: number;
  cumTotal: number;
  remainingHidden: number;
}> {
  const labels: Array<[number, string]> = [
    [0, "기준선 (기존 VERIFIED)"],
    [1, "공식 시설 좌표 재평가"],
    [2, "복수 건물 개별 식별"],
    [3, "공유 주소 시설 구분"],
    [4, "일반 단일 건물 BUILDING_PIN 평가"],
    [5, "기타 안전한 규칙"],
  ];
  let cumF = 0;
  let cumB = 0;
  return labels.map(([step, label]) => {
    const addF = results.filter(
      (r) => r.waterfallStep === step && r.exposureTier === "FACILITY_PIN"
    ).length;
    const addB = results.filter(
      (r) => r.waterfallStep === step && r.exposureTier === "BUILDING_PIN"
    ).length;
    cumF += addF;
    cumB += addB;
    const cumAll = cumF + cumB;
    return {
      step,
      label,
      addedFacilityPin: addF,
      addedBuildingPin: addB,
      addedTotal: addF + addB,
      cumFacilityPin: cumF,
      cumBuildingPin: cumB,
      cumTotal: cumAll,
      remainingHidden: total - cumAll,
    };
  });
}

async function main() {
  const t0 = Date.now();
  fs.mkdirSync(PHASE25_DIR, { recursive: true });

  const [baselines, cacheById, bldgByPk] = await Promise.all([
    loadBaselineCsv(),
    loadCacheMap(),
    loadBuildingMap(),
  ]);
  console.log(
    `Loaded baseline=${baselines.length}, cache=${cacheById.size}, roadPks=${bldgByPk.size}`
  );

  // TASK 1: Data & Missingness Audit (without imputing)
  const missingAudit = {
    totalRecords: baselines.length,
    baselineStatusCounts: {} as Record<string, number>,
    moisCombinedStatusCounts: {} as Record<string, number>,
    hasIndependentOfficialCoord: 0,
    hasMoisMatchedRoadPk: 0,
    hasMoisBuildingMgmtNo: 0,
    hasMoisBuildingName: 0,
    hasJibunAddress: 0,
    existingCoordSourceMetadata: {} as Record<string, number>,
    publicationStatusBaseline: {} as Record<string, number>,
  };

  for (const b of baselines) {
    missingAudit.baselineStatusCounts[b.baselineStatus] =
      (missingAudit.baselineStatusCounts[b.baselineStatus] ?? 0) + 1;
    if (b.officialLat !== null && b.officialLng !== null) {
      missingAudit.hasIndependentOfficialCoord += 1;
    }
    const c = cacheById.get(b.id)!;
    missingAudit.moisCombinedStatusCounts[c.combined_status] =
      (missingAudit.moisCombinedStatusCounts[c.combined_status] ?? 0) + 1;
    if (c.matched_road_pk) missingAudit.hasMoisMatchedRoadPk += 1;
    if (c.matched_building_mgmt_no) missingAudit.hasMoisBuildingMgmtNo += 1;
    if (c.matched_building_name) missingAudit.hasMoisBuildingName += 1;
    if ((c.jibun_address || "").trim()) missingAudit.hasJibunAddress += 1;
    const src = c.existing_coord_source || "null";
    missingAudit.existingCoordSourceMetadata[src] =
      (missingAudit.existingCoordSourceMetadata[src] ?? 0) + 1;
    missingAudit.publicationStatusBaseline[c.publication_status] =
      (missingAudit.publicationStatusBaseline[c.publication_status] ?? 0) + 1;
  }

  // TASK 2: Flag Overlap & Single-Reason Analysis on REVIEW_REQUIRED (31,261)
  const reviewRows = baselines.filter(
    (b) => b.baselineStatus === "REVIEW_REQUIRED"
  );
  const perFlagTotal: Record<string, number> = {};
  const perFlagSingle: Record<string, number> = {};
  const perFlagMulti: Record<string, number> = {};
  const comboCounts = new Map<string, number>();
  let exact1FlagCount = 0;
  let multi2PlusFlagCount = 0;
  let reviewWithOfficialCoord = 0;
  let reviewWithMgmtNo = 0;
  let reviewWithRoadPk = 0;

  for (const r of reviewRows) {
    const reasons = r.baselineReviewReasons;
    if (reasons.length === 1) {
      exact1FlagCount += 1;
      perFlagSingle[reasons[0]] = (perFlagSingle[reasons[0]] ?? 0) + 1;
    } else if (reasons.length >= 2) {
      multi2PlusFlagCount += 1;
      for (const f of reasons) {
        perFlagMulti[f] = (perFlagMulti[f] ?? 0) + 1;
      }
    }
    for (const f of reasons) {
      perFlagTotal[f] = (perFlagTotal[f] ?? 0) + 1;
    }
    const comboKey = [...reasons].sort().join(" + ");
    comboCounts.set(comboKey, (comboCounts.get(comboKey) ?? 0) + 1);
    if (r.officialLat !== null && r.officialLng !== null) {
      reviewWithOfficialCoord += 1;
    }
    const c = cacheById.get(r.id)!;
    if (c.matched_building_mgmt_no) reviewWithMgmtNo += 1;
    if (c.matched_road_pk) reviewWithRoadPk += 1;
  }

  // Counterfactual: removing a single flag -> how many rows become 0-flag candidates
  const singleFlagRemovalImpact: Record<
    string,
    {
      becomesZeroFlagTotal: number;
      withOfficialCoord: number;
      withMoisMgmtNo: number;
    }
  > = {};
  for (const flag of Object.keys(perFlagTotal)) {
    let zero = 0;
    let off = 0;
    let mgmt = 0;
    for (const r of reviewRows) {
      const rem = r.baselineReviewReasons.filter((x) => x !== flag);
      if (rem.length === 0) {
        zero += 1;
        if (r.officialLat !== null) off += 1;
        if (cacheById.get(r.id)?.matched_building_mgmt_no) mgmt += 1;
      }
    }
    singleFlagRemovalImpact[flag] = {
      becomesZeroFlagTotal: zero,
      withOfficialCoord: off,
      withMoisMgmtNo: mgmt,
    };
  }

  const topCombos = Array.from(comboCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([combo, count]) => ({ combo, count }));

  fs.writeFileSync(
    path.join(PHASE25_DIR, "flag_analysis.json"),
    JSON.stringify(
      {
        reviewRequiredTotal: reviewRows.length,
        exact1FlagCount,
        multi2PlusFlagCount,
        reviewWithOfficialCoord,
        reviewWithMgmtNo,
        reviewWithRoadPk,
        perFlagTotal,
        perFlagSingle,
        perFlagMulti,
        singleFlagRemovalImpact,
        topCombinations: topCombos.slice(0, 35),
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(PHASE25_DIR, "flag_combinations.csv"),
    "\uFEFF" +
      [
        "combination,count",
        ...topCombos.map((t) => [t.combo, t.count].map(csvEscape).join(",")),
      ].join("\n"),
    "utf8"
  );

  // TASK 3, 5, 6: Phase 2.5 Reclassification & Exposure Simulation (NO KAKAO!)
  const sharedOfficialAnalysis = analyzeSharedOfficialCoords(
    baselines,
    cacheById,
    bldgByPk
  );

  const results: Phase25Result[] = [];
  const altOrderResults: Phase25Result[] = [];

  for (const b of baselines) {
    const c = cacheById.get(b.id)!;
    const bldgs = c.matched_road_pk
      ? bldgByPk.get(c.matched_road_pk) ?? []
      : [];
    results.push(
      classifyPhase25Record(b, c, bldgs, sharedOfficialAnalysis, {
        moisLicenseCleared: false,
        municipalCommercialCleared: false,
        steps2Before3: true,
      })
    );
    altOrderResults.push(
      classifyPhase25Record(b, c, bldgs, sharedOfficialAnalysis, {
        moisLicenseCleared: false,
        municipalCommercialCleared: false,
        steps2Before3: false,
      })
    );
  }

  // Verify order invariance of final deduplicated exposure tiers
  let orderDiffCount = 0;
  for (let i = 0; i < results.length; i += 1) {
    if (results[i].exposureTier !== altOrderResults[i].exposureTier) {
      orderDiffCount += 1;
    }
  }

  // Verify unique IDs (no duplicate IDs in results)
  const uniqueResultIds = new Set(results.map((r) => r.id));
  if (uniqueResultIds.size !== baselines.length) {
    throw new Error("Duplicate ID detected in Phase 2.5 results");
  }

  const waterfallPrimary = computeWaterfall(results, baselines.length);
  const waterfallAltOrder = computeWaterfall(altOrderResults, baselines.length);

  fs.writeFileSync(
    path.join(PHASE25_DIR, "waterfall_table.csv"),
    "\uFEFF" +
      [
        "step,label,added_facility_pin,added_building_pin,added_total,cum_facility_pin,cum_building_pin,cum_total,remaining_hidden",
        ...waterfallPrimary.map((w) =>
          [
            w.step,
            w.label,
            w.addedFacilityPin,
            w.addedBuildingPin,
            w.addedTotal,
            w.cumFacilityPin,
            w.cumBuildingPin,
            w.cumTotal,
            w.remainingHidden,
          ]
            .map(csvEscape)
            .join(",")
        ),
      ].join("\n"),
    "utf8"
  );

  // Write nationwide phase25_classification.csv
  fs.writeFileSync(
    path.join(PHASE25_DIR, "phase25_classification.csv"),
    "\uFEFF" +
      [
        [
          "restroom_id",
          "source_record_id",
          "name",
          "sido",
          "sigungu",
          "road_address",
          "jibun_address",
          "baseline_verification_status",
          "baseline_review_reasons",
          "effective_reasons_without_kakao",
          "exposure_tier",
          "waterfall_step",
          "rule_tag",
          "coord_source",
          "coord_type",
          "recommended_lat",
          "recommended_lng",
          "matched_building_mgmt_no",
          "matched_building_name",
          "min_building_dist_m",
          "building_spread_radius_m",
          "is_existing_remote_suwon",
          "license_cleared_now",
          "publication_eligible_now",
          "publication_block_reason",
        ].join(","),
        ...results.map((r) =>
          [
            r.id,
            r.sourceRecordId,
            r.name,
            r.sido,
            r.sigungu,
            r.roadAddress,
            r.jibunAddress,
            r.baselineStatus,
            r.baselineReviewReasons.join(";"),
            r.effectiveReasonsWithoutKakao.join(";"),
            r.exposureTier,
            r.waterfallStep,
            r.ruleTag,
            r.coordSource,
            r.coordType,
            r.recommendedLat,
            r.recommendedLng,
            r.matchedBuildingMgmtNo,
            r.matchedBuildingName,
            r.minBuildingDistM !== null ? r.minBuildingDistM.toFixed(2) : "",
            r.buildingSpreadRadiusM !== null
              ? r.buildingSpreadRadiusM.toFixed(2)
              : "",
            r.isExistingRemoteSuwon,
            r.licenseClearedNow,
            r.publicationEligibleNow,
            r.publicationBlockReason,
          ]
            .map(csvEscape)
            .join(",")
        ),
      ].join("\n"),
    "utf8"
  );

  // TASK 3 Breakdown for MULTI_BUILDING_COMPLEX (16,314)
  const baselineById = new Map(baselines.map((b) => [b.id, b]));
  const mbcResults = results.filter((r) =>
    r.baselineReviewReasons.includes("MULTI_BUILDING_COMPLEX")
  );
  const mbcWithOfficial = mbcResults.filter(
    (r) => baselineById.get(r.id)!.officialLat !== null
  );
  const mbcWithoutOfficial = mbcResults.filter(
    (r) => baselineById.get(r.id)!.officialLat === null
  );
  const parkResults = results.filter((r) =>
    r.baselineReviewReasons.includes("PARK_OR_OPEN_SPACE")
  );

  const countTiers = (arr: Phase25Result[]) => ({
    total: arr.length,
    FACILITY_PIN: arr.filter((x) => x.exposureTier === "FACILITY_PIN").length,
    BUILDING_PIN: arr.filter((x) => x.exposureTier === "BUILDING_PIN").length,
    HIDDEN: arr.filter((x) => x.exposureTier === "HIDDEN").length,
  });

  // TASK 7: Independent Stratified Sample (80 non-Suwon rows, 20 per stratum, seed 20261122)
  const SEED = 20261122;
  const nonSuwon = results.filter((r) => !r.sigungu.startsWith("수원시"));
  const rawNationalEvidence = loadRawNationalEvidence();

  const stratum1Pool = nonSuwon.filter((r) => {
    const b = baselineById.get(r.id)!;
    return (
      b.baselineReviewReasons.includes("MULTI_BUILDING_COMPLEX") &&
      b.officialLat !== null
    );
  });
  const stratum2Pool = nonSuwon.filter((r) => {
    const b = baselineById.get(r.id)!;
    return b.baselineReviewReasons.includes("SHARED_ADDRESS_MULTI_RESTROOM");
  });
  const stratum3Pool = nonSuwon.filter((r) => {
    const b = baselineById.get(r.id)!;
    return b.baselineStatus === "CANDIDATE";
  });
  const stratum4Pool = nonSuwon.filter((r) => {
    const b = baselineById.get(r.id)!;
    return b.baselineReviewReasons.includes("PARK_OR_OPEN_SPACE");
  });

  const usedSampleIds = new Set<string>();
  const pickDistinct = (pool: Phase25Result[], n: number, seedOffset: number) => {
    const filtered = pool.filter((x) => !usedSampleIds.has(x.id));
    const picked = seededSample(filtered, n, SEED + seedOffset);
    for (const p of picked) usedSampleIds.add(p.id);
    return picked;
  };

  const sampleStrata: Array<{ stratum: string; items: Phase25Result[] }> = [
    {
      stratum: "1_OFFICIAL_MBC_COMPLEX",
      items: pickDistinct(stratum1Pool, 20, 1),
    },
    {
      stratum: "2_SHARED_ADDRESS",
      items: pickDistinct(stratum2Pool, 20, 2),
    },
    {
      stratum: "3_SINGLE_BLDG_CANDIDATE",
      items: pickDistinct(stratum3Pool, 20, 3),
    },
    {
      stratum: "4_PARK_OR_OPEN_SPACE",
      items: pickDistinct(stratum4Pool, 20, 4),
    },
  ];

  const sampleCsvLines = [
    [
      "stratum",
      "random_seed",
      "restroom_id",
      "source_record_id",
      "name",
      "sido",
      "sigungu",
      "road_address",
      "jibun_address",
      "baseline_status",
      "phase25_exposure_tier",
      "phase25_rule_tag",
      "coord_source",
      "recommended_lat",
      "recommended_lng",
      "min_building_dist_m",
      "building_count",
      "shared_address_count",
      "matched_building_mgmt_no",
      "matched_building_name",
      "nav_building_use",
      "raw_agency",
      "raw_category",
      "raw_open_hours",
      "offline_check_status",
      "human_visual_review_required",
    ].join(","),
  ];

  const sampleSummaryByStratum: Record<string, unknown> = {};
  for (const s of sampleStrata) {
    sampleSummaryByStratum[s.stratum] = countTiers(s.items);
    for (const r of s.items) {
      const b = baselineById.get(r.id)!;
      const c = cacheById.get(r.id)!;
      const ev = r.sourceRecordId
        ? rawNationalEvidence.get(r.sourceRecordId)
        : undefined;
      let offlineStatus = "OFFLINE_CONSISTENT_NEEDS_VISUAL_CONFIRM";
      if (r.exposureTier === "HIDDEN") {
        offlineStatus = "HELD_HIDDEN_NEEDS_REVIEW";
      } else if (
        r.minBuildingDistM !== null &&
        r.minBuildingDistM > 50 &&
        r.exposureTier === "FACILITY_PIN"
      ) {
        offlineStatus = "OFFSET_50_100M_NEEDS_VISUAL_CONFIRM";
      }
      sampleCsvLines.push(
        [
          s.stratum,
          SEED,
          r.id,
          r.sourceRecordId,
          r.name,
          r.sido,
          r.sigungu,
          r.roadAddress,
          r.jibunAddress,
          r.baselineStatus,
          r.exposureTier,
          r.ruleTag,
          r.coordSource,
          r.recommendedLat,
          r.recommendedLng,
          r.minBuildingDistM !== null ? r.minBuildingDistM.toFixed(2) : "",
          b.buildingCount,
          b.sharedAddressCount,
          r.matchedBuildingMgmtNo,
          r.matchedBuildingName,
          c.nav_building_use,
          ev?.agency ?? "",
          ev?.category ?? "",
          ev?.openHours ?? "",
          offlineStatus,
          true,
        ]
          .map(csvEscape)
          .join(",")
      );
    }
  }
  fs.writeFileSync(
    path.join(PHASE25_DIR, "sample_verification_80.csv"),
    "\uFEFF" + sampleCsvLines.join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(PHASE25_DIR, "human_review_checklist.csv"),
    "\uFEFF" + sampleCsvLines.join("\n"),
    "utf8"
  );

  // TASK 8: Suwon Before / After & Haenggung-dong / Hwaseong Analysis
  const suwonAll = results.filter((r) => r.sigungu.startsWith("수원시"));
  const suwonRemote = suwonAll.filter((r) => r.isExistingRemoteSuwon);
  const suwonNonRemote = suwonAll.filter((r) => !r.isExistingRemoteSuwon);
  const haenggungRe =
    /(행궁|화성|팔달문|화홍문|장안문|창룡문|서장대|연무대|화서문|남수동|북수동|신풍동|장안동|팔달로|지동|화서동)/;
  const suwonHaenggung = suwonAll.filter((r) =>
    haenggungRe.test(`${r.name} ${r.roadAddress} ${r.jibunAddress}`)
  );

  // Select 28 representative Suwon cases (verified baseline, promoted FACILITY_PIN, promoted BUILDING_PIN, still HIDDEN, non-remote, Haenggung)
  const suwonCases: Phase25Result[] = [];
  const suwonSeen = new Set<string>();
  const pickSuwon = (
    pred: (r: Phase25Result) => boolean,
    limit: number
  ) => {
    let added = 0;
    for (const r of suwonAll) {
      if (added >= limit) break;
      if (suwonSeen.has(r.id)) continue;
      if (pred(r)) {
        suwonSeen.add(r.id);
        suwonCases.push(r);
        added += 1;
      }
    }
  };
  pickSuwon((r) => r.name.includes("e타운1빌딩"), 1);
  pickSuwon((r) => r.name === "신대호수" || r.name === "원천호수", 2);
  pickSuwon((r) => r.name.startsWith("축구공"), 2);
  pickSuwon((r) => r.name.startsWith("영흥수목원"), 2);
  pickSuwon(
    (r) =>
      haenggungRe.test(`${r.name} ${r.roadAddress}`) &&
      r.exposureTier === "FACILITY_PIN" &&
      r.waterfallStep === 1,
    5
  );
  pickSuwon(
    (r) =>
      haenggungRe.test(`${r.name} ${r.roadAddress}`) &&
      r.exposureTier === "FACILITY_PIN" &&
      r.waterfallStep === 0,
    3
  );
  pickSuwon(
    (r) =>
      haenggungRe.test(`${r.name} ${r.roadAddress}`) &&
      r.exposureTier === "HIDDEN",
    4
  );
  pickSuwon(
    (r) => !r.isExistingRemoteSuwon && r.exposureTier === "BUILDING_PIN",
    4
  );
  pickSuwon(
    (r) => !r.isExistingRemoteSuwon && r.exposureTier === "FACILITY_PIN",
    2
  );
  pickSuwon((r) => r.isExistingRemoteSuwon && r.exposureTier === "BUILDING_PIN", 3);

  fs.writeFileSync(
    path.join(PHASE25_DIR, "suwon_before_after_cases.csv"),
    "\uFEFF" +
      [
        [
          "restroom_id",
          "name",
          "sigungu",
          "road_address",
          "is_existing_remote_suwon",
          "baseline_status",
          "phase25_exposure_tier",
          "waterfall_step",
          "rule_tag",
          "coord_source",
          "recommended_lat",
          "recommended_lng",
          "min_building_dist_m",
          "baseline_review_reasons",
        ].join(","),
        ...suwonCases.map((r) =>
          [
            r.id,
            r.name,
            r.sigungu,
            r.roadAddress,
            r.isExistingRemoteSuwon,
            r.baselineStatus,
            r.exposureTier,
            r.waterfallStep,
            r.ruleTag,
            r.coordSource,
            r.recommendedLat,
            r.recommendedLng,
            r.minBuildingDistM !== null ? r.minBuildingDistM.toFixed(2) : "",
            r.baselineReviewReasons.join(";"),
          ]
            .map(csvEscape)
            .join(",")
        ),
      ].join("\n"),
    "utf8"
  );

  // Rule tag breakdown
  const ruleTagCounts: Record<string, number> = {};
  for (const r of results) {
    ruleTagCounts[r.ruleTag] = (ruleTagCounts[r.ruleTag] ?? 0) + 1;
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    kakaoCoordsUsedInCorePipeline: false,
    task1MissingAudit: missingAudit,
    task2FlagSummary: {
      reviewRequiredTotal: reviewRows.length,
      exact1FlagCount,
      multi2PlusFlagCount,
      reviewWithOfficialCoord,
      reviewWithMgmtNo,
      reviewWithRoadPk,
      perFlagTotal,
      perFlagSingle,
      perFlagMulti,
    },
    task3MultiBuildingAndParkBreakdown: {
      multiBuildingTotal: countTiers(mbcResults),
      multiBuildingWithOfficial: countTiers(mbcWithOfficial),
      multiBuildingWithoutOfficial: countTiers(mbcWithoutOfficial),
      parkOrOpenSpaceTotal: countTiers(parkResults),
      sharedIdenticalOfficialCoordSuspectCount:
        sharedOfficialAnalysis.suspectIdenticalIds.size,
      sharedIdenticalOfficialCoordLegitSplitCount:
        sharedOfficialAnalysis.sameBuildingSplitIds.size,
    },
    task5ExposureSummary: {
      overall: countTiers(results),
      byLicenseClearenceNow: {
        existingRemoteSuwonPublishedBaseline: suwonRemote.length,
        publicationEligibleNowWithoutNewApprovals: results.filter(
          (r) => r.publicationEligibleNow
        ).length,
        blockedMoisLicenseUnconfirmed: results.filter(
          (r) => r.publicationBlockReason === "mois_license_unconfirmed"
        ).length,
        blockedMunicipalPrecheckRequired: results.filter(
          (r) =>
            r.publicationBlockReason === "municipal_license_precheck_required"
        ).length,
      },
      ruleTagCounts,
    },
    task6Waterfall: {
      orderInvarianceDiffCount: orderDiffCount,
      primaryOrder: waterfallPrimary,
      alternativeOrderStep3Before2: waterfallAltOrder,
    },
    task7SampleVerification: {
      seed: SEED,
      totalSampled: sampleStrata.reduce((s, x) => s + x.items.length, 0),
      byStratum: sampleSummaryByStratum,
    },
    task8SuwonBeforeAfter: {
      suwonTotalLocal: suwonAll.length,
      suwonRemoteBaseline502: countTiers(suwonRemote),
      suwonNonRemote84: countTiers(suwonNonRemote),
      suwonHaenggungHwaseongSubset: countTiers(suwonHaenggung),
      representativeCaseCount: suwonCases.length,
    },
  };

  fs.writeFileSync(
    path.join(PHASE25_DIR, "phase25_summary.json"),
    JSON.stringify(summary, null, 2),
    "utf8"
  );

  console.log("Phase 2.5 simulation complete in", summary.elapsedMs, "ms");
  console.log("Overall exposure tiers:", summary.task5ExposureSummary.overall);
  console.log("Order invariance diff:", orderDiffCount);
  console.log("Waterfall primary:");
  for (const w of waterfallPrimary) {
    console.log(
      `  Step ${w.step} (${w.label}): +FAC=${w.addedFacilityPin}, +BLDG=${w.addedBuildingPin}, cumFAC=${w.cumFacilityPin}, cumBLDG=${w.cumBuildingPin}, cumALL=${w.cumTotal}, HIDDEN=${w.remainingHidden}`
    );
  }
  console.log("Suwon remote 502:", summary.task8SuwonBeforeAfter.suwonRemoteBaseline502);
  console.log("Suwon non-remote 84:", summary.task8SuwonBeforeAfter.suwonNonRemote84);
  console.log("Suwon Haenggung/Hwaseong:", summary.task8SuwonBeforeAfter.suwonHaenggungHwaseongSubset);
}

main().catch((err) => {
  console.error("Phase 2.5 run failed:", err);
  process.exit(1);
});
