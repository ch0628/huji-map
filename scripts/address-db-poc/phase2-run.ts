#!/usr/bin/env node
/**
 * Phase 2 Runner: Classifies 51,260 local public restrooms into
 * VERIFIED / CANDIDATE / REVIEW_REQUIRED / UNMATCHED, verifies Suwon review cases,
 * generates regional summaries & Gyeonggi expansion recommendations, and runs
 * zero-write selective DRY-RUN validation.
 *
 * Usage:
 *   npx tsx scripts/address-db-poc/phase2-run.ts
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { decodeCsvBuffer, parseCsv } from "../../src/lib/imports/parser";
import { isValidKoreaWgs84, normalizeNameToken } from "./lib";
import {
  OfficialFacilityIndex,
  classifyRestroomRecord,
  runSelectiveDryRun,
  normalizeStrictName,
  buildCanonicalAddressKeys,
  type CachedMoisMatchRecord,
  type ClassificationResult,
} from "./phase2-lib";

const PHASE2_DIR = path.resolve(
  process.cwd(),
  "local-data/address-db-poc/phase2"
);
const CACHE_PATH = path.join(PHASE2_DIR, "_cache_local_db_matches.jsonl");
const SUWON_EXPORT_PATH = path.resolve(
  process.cwd(),
  "local-data/suwon_remote_export.json"
);

// Public publishable key for read-only GET of published rows on remote Supabase (wddnbycimcixskemssct)
const REMOTE_REST_URL = "https://wddnbycimcixskemssct.supabase.co";
const REMOTE_PUBLISHABLE_KEY =
  "sb_publishable_uG_cnLgtCuBfcRVIB_ktJA_HFpEEtWS";

function csvEscape(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function loadCp949Csv(relPath: string): Array<Record<string, string | undefined>> {
  const full = path.resolve(process.cwd(), relPath);
  if (!fs.existsSync(full)) return [];
  const buf = fs.readFileSync(full);
  const txt = decodeCsvBuffer(buf, "cp949");
  return parseCsv(txt);
}

function buildOfficialFacilityIndex(): {
  index: OfficialFacilityIndex;
  datasetCounts: Record<string, number>;
} {
  const index = new OfficialFacilityIndex();
  const datasetCounts: Record<string, number> = {};

  // 1) Suwon remote export (502 verified baseline)
  if (fs.existsSync(SUWON_EXPORT_PATH)) {
    const exp = JSON.parse(fs.readFileSync(SUWON_EXPORT_PATH, "utf8"));
    let cnt = 0;
    for (const r of exp.restrooms || []) {
      if (typeof r.latitude === "number" && typeof r.longitude === "number") {
        index.add({
          datasetKey: "suwon_remote_export",
          sourceRecordId: r.id,
          name: r.name || "",
          roadAddress: r.road_address || "",
          jibunAddress: r.address_detail || "",
          lat: r.latitude,
          lng: r.longitude,
          dataStdDate: (r.last_verified_at || "").slice(0, 10) || "2026-02-20",
          sidoHint: "경기도",
        });
        cnt += 1;
      }
    }
    datasetCounts.suwon_remote_export = cnt;
  }

  // 2) Gyeonggi Publtolt (15011425) — all 31 Gyeonggi cities
  const ggRows = loadCp949Csv("local-data/공중화장실현황(제공표준).csv");
  let ggCnt = 0;
  ggRows.forEach((raw, idx) => {
    const lat = Number.parseFloat((raw["위도"] || "").trim());
    const lng = Number.parseFloat((raw["경도"] || "").trim());
    if (!isValidKoreaWgs84(lat, lng)) return;
    index.add({
      datasetKey: "gg_publtolt_15011425",
      sourceRecordId: `GG-15011425-R${idx + 1}`,
      name: (raw["화장실명"] || "").trim(),
      roadAddress: (raw["소재지도로명주소"] || "").trim(),
      jibunAddress: (raw["소재지지번주소"] || "").trim(),
      lat,
      lng,
      dataStdDate: (raw["데이터기준일자"] || "").trim() || "20231219",
      sidoHint: "경기도",
    });
    ggCnt += 1;
  });
  datasetCounts.gg_publtolt_15011425 = ggCnt;

  // 3) Seoul Metro 2026 (note trailing spaces in headers)
  const smRows = loadCp949Csv(
    "local-data/서울교통공사_역사공중화장실정보_20260212.csv"
  );
  let smCnt = 0;
  smRows.forEach((raw, idx) => {
    const lat = Number.parseFloat((raw["위도 "] || raw["위도"] || "").trim());
    const lng = Number.parseFloat((raw["경도 "] || raw["경도"] || "").trim());
    if (!isValidKoreaWgs84(lat, lng)) return;
    const station = (raw["역명"] || "").trim();
    const name = station ? (station.endsWith("역") ? station : `${station}역`) : "";
    index.add({
      datasetKey: "seoul_metro_2026",
      sourceRecordId: `SEOUL-METRO-${(raw["연번 "] || raw["연번"] || String(idx + 1)).trim()}`,
      name,
      roadAddress: (raw["소재지도로명주소 "] || raw["소재지도로명주소"] || "").trim(),
      jibunAddress: (raw["소재지지번주소 "] || raw["소재지지번주소"] || "").trim(),
      lat,
      lng,
      dataStdDate: (raw["데이터기준일자"] || "").trim() || "2026-02-12",
      sidoHint: "서울특별시",
    });
    smCnt += 1;
  });
  datasetCounts.seoul_metro_2026 = smCnt;

  // 4) Seoul City Public Toilet Location Info
  const scRows = loadCp949Csv("local-data/서울시 공중화장실 위치정보.csv");
  let scCnt = 0;
  scRows.forEach((raw, idx) => {
    const lat = Number.parseFloat((raw["y 좌표"] || "").trim());
    const lng = Number.parseFloat((raw["x 좌표"] || "").trim());
    if (!isValidKoreaWgs84(lat, lng)) return;
    index.add({
      datasetKey: "seoul_city_location",
      sourceRecordId: `SEOUL-LOC-${(raw["연번"] || String(idx + 1)).trim()}`,
      name: (raw["건물명"] || "").trim(),
      roadAddress: (raw["도로명주소"] || "").trim(),
      jibunAddress: (raw["지번주소"] || "").trim(),
      lat,
      lng,
      dataStdDate: "seoul_city_csv",
      sidoHint: "서울특별시",
    });
    scCnt += 1;
  });
  datasetCounts.seoul_city_location = scCnt;

  // 5) Incheon Michuhol-gu & Yeonsu-gu
  const miRows = loadCp949Csv(
    "local-data/인천광역시 미추홀구_공중및개방화장실현황_20260731.csv"
  );
  let miCnt = 0;
  miRows.forEach((raw, idx) => {
    const lat = Number.parseFloat((raw["위도"] || "").trim());
    const lng = Number.parseFloat((raw["경도"] || "").trim());
    if (!isValidKoreaWgs84(lat, lng)) return;
    index.add({
      datasetKey: "incheon_michuhol_2026",
      sourceRecordId: `ICN-MCH-${(raw["연번"] || String(idx + 1)).trim()}`,
      name: (raw["명칭"] || "").trim(),
      roadAddress: (raw["도로명주소"] || "").trim(),
      jibunAddress: (raw["지번주소"] || "").trim(),
      lat,
      lng,
      dataStdDate: (raw["데이터기준일자"] || "").trim() || "2026-07-31",
      sidoHint: "인천광역시",
    });
    miCnt += 1;
  });
  datasetCounts.incheon_michuhol_2026 = miCnt;

  const ysRows = loadCp949Csv(
    "local-data/인천광역시 연수구_공중 및 개방화장실_20250630.csv"
  );
  let ysCnt = 0;
  ysRows.forEach((raw, idx) => {
    const lat = Number.parseFloat((raw["위도"] || "").trim());
    const lng = Number.parseFloat((raw["경도"] || "").trim());
    if (!isValidKoreaWgs84(lat, lng)) return;
    index.add({
      datasetKey: "incheon_yeonsu_2025",
      sourceRecordId: `ICN-YS-${idx + 1}`,
      name: (raw["화장실명"] || "").trim(),
      roadAddress: "",
      jibunAddress: (raw["지번주소"] || "").trim(),
      lat,
      lng,
      dataStdDate: "2025-06-30",
      sidoHint: "인천광역시",
    });
    ysCnt += 1;
  });
  datasetCounts.incheon_yeonsu_2025 = ysCnt;

  return { index, datasetCounts };
}

async function fetchRemoteExistingReadOnly(): Promise<{
  existingIds: Set<string>;
  existingSourceRecordIds: Set<string>;
  totalRemoteRows: number;
  remotePublicCount: number;
  remotePartnerCount: number;
}> {
  const existingIds = new Set<string>();
  const existingSourceRecordIds = new Set<string>();
  let totalRemoteRows = 0;
  let remotePublicCount = 0;
  let remotePartnerCount = 0;

  let offset = 0;
  const PAGE = 1000;
  while (true) {
    const url = `${REMOTE_REST_URL}/rest/v1/restrooms?select=id,source_record_id,type&order=id.asc&offset=${offset}&limit=${PAGE}`;
    const res = await fetch(url, {
      headers: { apikey: REMOTE_PUBLISHABLE_KEY },
    });
    if (!res.ok) {
      throw new Error(`Remote read-only query failed: HTTP ${res.status}`);
    }
    const batch = (await res.json()) as Array<Record<string, any>>;
    if (!batch || batch.length === 0) break;
    for (const r of batch) {
      totalRemoteRows += 1;
      existingIds.add(r.id);
      if (r.source_record_id) existingSourceRecordIds.add(r.source_record_id);
      if (r.type === "public") remotePublicCount += 1;
      else if (r.type === "partner") remotePartnerCount += 1;
    }
    if (batch.length < PAGE) break;
    offset += PAGE;
  }
  return {
    existingIds,
    existingSourceRecordIds,
    totalRemoteRows,
    remotePublicCount,
    remotePartnerCount,
  };
}

async function main() {
  if (!fs.existsSync(CACHE_PATH)) {
    throw new Error(`Missing MOIS match cache: ${CACHE_PATH}`);
  }

  const t0 = Date.now();
  const records: CachedMoisMatchRecord[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(CACHE_PATH, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as CachedMoisMatchRecord;
    if (rec.sido === "세종특별자치시" && (!rec.sigungu || rec.sigungu === "(시군구미상)")) {
      rec.sigungu = "세종특별자치시";
    }
    records.push(rec);
  }
  console.log(`Loaded ${records.length} cached MOIS match records.`);

  // Precompute shared address counts and duplicate suspect counts across all 51,260 rows
  const sharedAddrFreq = new Map<string, number>();
  const dupFreq = new Map<string, number>();

  const getAddressGroupKey = (r: CachedMoisMatchRecord): string => {
    if (r.matched_road_pk) return `pk:${r.matched_road_pk}`;
    const { roadKey, jibunKey } = buildCanonicalAddressKeys(
      r.road_address,
      r.jibun_address,
      r.sido !== "(시도미상/누락)" ? r.sido : undefined
    );
    if (roadKey) return `rk:${roadKey}`;
    if (jibunKey) return `jk:${jibunKey}`;
    return `raw:${(r.road_address || r.jibun_address).replace(/\s+/g, "")}`;
  };

  const getDupKey = (r: CachedMoisMatchRecord): string =>
    `${normalizeStrictName(r.name)}::${getAddressGroupKey(r)}`;

  for (const r of records) {
    const ak = getAddressGroupKey(r);
    sharedAddrFreq.set(ak, (sharedAddrFreq.get(ak) ?? 0) + 1);
    const dk = getDupKey(r);
    dupFreq.set(dk, (dupFreq.get(dk) ?? 0) + 1);
  }

  const { index: officialIndex, datasetCounts } = buildOfficialFacilityIndex();
  console.log("Loaded official municipal datasets:", datasetCounts);

  const remoteInfo = await fetchRemoteExistingReadOnly();
  console.log(
    `Remote Supabase read-only check: total=${remoteInfo.totalRemoteRows} (public=${remoteInfo.remotePublicCount}, partner=${remoteInfo.remotePartnerCount})`
  );

  // Classify all 51,260 records
  const classified: ClassificationResult[] = [];
  for (const r of records) {
    const offMatch = officialIndex.lookup({
      id: r.id,
      name: r.name,
      roadAddress: r.road_address,
      jibunAddress: r.jibun_address,
      sido: r.sido,
    });
    const res = classifyRestroomRecord(r, offMatch, {
      sharedAddressCount: sharedAddrFreq.get(getAddressGroupKey(r)) ?? 1,
      duplicateGroupCount: dupFreq.get(getDupKey(r)) ?? 1,
      existingRemoteIds: remoteInfo.existingIds,
      moisLicenseCleared: false,
    });
    classified.push(res);
  }

  // Write nationwide_classification.csv
  const classCsvLines = [
    [
      "restroom_id",
      "source_record_id",
      "name",
      "sido",
      "sigungu",
      "road_address",
      "jibun_address",
      "verification_status",
      "coord_source",
      "coord_type",
      "source_version",
      "recommended_lat",
      "recommended_lng",
      "mois_candidate_lat",
      "mois_candidate_lng",
      "official_lat",
      "official_lng",
      "official_to_mois_dist_m",
      "existing_kakao_to_mois_dist_m",
      "building_count",
      "shared_address_count",
      "duplicate_group_count",
      "is_existing_remote_suwon",
      "publishable_now",
      "publish_block_reason",
      "review_reasons",
      "verification_basis",
    ].join(","),
  ];

  for (const c of classified) {
    classCsvLines.push(
      [
        c.id,
        c.sourceRecordId,
        c.name,
        c.sido,
        c.sigungu,
        c.roadAddress,
        c.jibunAddress,
        c.verificationStatus,
        c.coordSource,
        c.coordType,
        c.sourceVersion,
        c.recommendedLat,
        c.recommendedLng,
        c.moisCandidateLat,
        c.moisCandidateLng,
        c.officialLat,
        c.officialLng,
        c.officialToMoisDistM !== null ? c.officialToMoisDistM.toFixed(2) : "",
        c.existingKakaoToMoisDistM !== null
          ? c.existingKakaoToMoisDistM.toFixed(2)
          : "",
        c.buildingCount,
        c.sharedAddressCount,
        c.duplicateGroupCount,
        c.isExistingRemoteSuwon,
        c.publishableNow,
        c.publishBlockReason,
        c.reviewReasons.join(";"),
        c.verificationBasis,
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  fs.writeFileSync(
    path.join(PHASE2_DIR, "nationwide_classification.csv"),
    "\uFEFF" + classCsvLines.join("\n"),
    "utf8"
  );

  // Aggregate summary & subset (43,778 MOIS unique matches)
  const recordById = new Map(records.map((r) => [r.id, r]));
  const statusCounts: Record<string, number> = {
    VERIFIED: 0,
    CANDIDATE: 0,
    REVIEW_REQUIRED: 0,
    UNMATCHED: 0,
  };
  const moisMatchedStatusCounts: Record<string, number> = {
    VERIFIED: 0,
    CANDIDATE: 0,
    REVIEW_REQUIRED: 0,
    UNMATCHED: 0,
  };
  const suwon502Counts: Record<string, number> = {
    VERIFIED: 0,
    CANDIDATE: 0,
    REVIEW_REQUIRED: 0,
    UNMATCHED: 0,
  };
  const reviewReasonCounts: Record<string, number> = {};
  const officialSourceCounts: Record<string, number> = {};
  const verifiedBySource: Record<string, number> = {};

  const byRegion = new Map<
    string,
    {
      sido: string;
      sigungu: string;
      total: number;
      VERIFIED: number;
      newNonRemoteVerified: number;
      CANDIDATE: number;
      REVIEW_REQUIRED: number;
      UNMATCHED: number;
      sharedAddrCount: number;
      outlierCount: number;
    }
  >();

  for (const c of classified) {
    statusCounts[c.verificationStatus] += 1;
    const raw = recordById.get(c.id)!;
    if (raw.combined_status === "unique_match") {
      moisMatchedStatusCounts[c.verificationStatus] += 1;
    }
    if (c.isExistingRemoteSuwon) {
      suwon502Counts[c.verificationStatus] += 1;
    }
    for (const rr of c.reviewReasons) {
      reviewReasonCounts[rr] = (reviewReasonCounts[rr] ?? 0) + 1;
    }
    if (c.coordSource) {
      officialSourceCounts[c.coordSource] =
        (officialSourceCounts[c.coordSource] ?? 0) + 1;
    }
    if (c.verificationStatus === "VERIFIED" && c.coordSource) {
      verifiedBySource[c.coordSource] =
        (verifiedBySource[c.coordSource] ?? 0) + 1;
    }

    const regKey = `${c.sido}||${c.sigungu}`;
    let rb = byRegion.get(regKey);
    if (!rb) {
      rb = {
        sido: c.sido,
        sigungu: c.sigungu,
        total: 0,
        VERIFIED: 0,
        newNonRemoteVerified: 0,
        CANDIDATE: 0,
        REVIEW_REQUIRED: 0,
        UNMATCHED: 0,
        sharedAddrCount: 0,
        outlierCount: 0,
      };
      byRegion.set(regKey, rb);
    }
    rb.total += 1;
    rb[c.verificationStatus] += 1;
    if (c.verificationStatus === "VERIFIED" && !c.isExistingRemoteSuwon) {
      rb.newNonRemoteVerified += 1;
    }
    if (c.sharedAddressCount > 1) rb.sharedAddrCount += 1;
    if (
      c.reviewReasons.includes("LARGE_OFFICIAL_MOIS_DISCREPANCY") ||
      c.reviewReasons.includes("LARGE_KAKAO_MOIS_DISCREPANCY")
    ) {
      rb.outlierCount += 1;
    }
  }

  // Write regional_summary.csv
  const regRows = Array.from(byRegion.values()).sort(
    (a, b) => b.newNonRemoteVerified - a.newNonRemoteVerified || b.total - a.total
  );
  const regCsvLines = [
    [
      "sido",
      "sigungu",
      "total",
      "VERIFIED",
      "new_non_remote_VERIFIED",
      "CANDIDATE",
      "REVIEW_REQUIRED",
      "UNMATCHED",
      "verified_pct",
      "shared_addr_pct",
      "outlier_pct",
    ].join(","),
  ];
  for (const r of regRows) {
    regCsvLines.push(
      [
        r.sido,
        r.sigungu,
        r.total,
        r.VERIFIED,
        r.newNonRemoteVerified,
        r.CANDIDATE,
        r.REVIEW_REQUIRED,
        r.UNMATCHED,
        ((r.VERIFIED / r.total) * 100).toFixed(2),
        ((r.sharedAddrCount / r.total) * 100).toFixed(2),
        ((r.outlierCount / r.total) * 100).toFixed(2),
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  fs.writeFileSync(
    path.join(PHASE2_DIR, "regional_summary.csv"),
    "\uFEFF" + regCsvLines.join("\n"),
    "utf8"
  );

  // Recommend top Gyeonggi sigungus (excluding Suwon already on remote)
  const gyeonggiSigunguRanking = regRows
    .filter(
      (r) =>
        r.sido === "경기도" &&
        !r.sigungu.startsWith("수원시") &&
        r.newNonRemoteVerified > 0
    )
    .map((r) => ({
      sigungu: r.sigungu,
      total: r.total,
      newVerified: r.newNonRemoteVerified,
      verifiedPct: Number(((r.newNonRemoteVerified / r.total) * 100).toFixed(2)),
      candidateCount: r.CANDIDATE,
      reviewRequiredCount: r.REVIEW_REQUIRED,
      sharedAddrPct: Number(((r.sharedAddrCount / r.total) * 100).toFixed(2)),
      outlierPct: Number(((r.outlierCount / r.total) * 100).toFixed(2)),
    }))
    .sort((a, b) => b.newVerified - a.newVerified);

  const recommendedFirstWaveSigungus = gyeonggiSigunguRanking
    .filter((g) => g.newVerified >= 40 && g.outlierPct <= 10 && g.sharedAddrPct <= 30)
    .slice(0, 5)
    .map((g) => g.sigungu);

  // Build Suwon 40 representative review cases (TASK-03)
  const suwonItems = classified.filter((c) => c.isExistingRemoteSuwon);
  const suwonSelected: ClassificationResult[] = [];
  const suwonSeen = new Set<string>();
  const addSuwonPick = (fn: (c: ClassificationResult) => boolean, limit: number) => {
    let added = 0;
    for (const c of suwonItems) {
      if (added >= limit) break;
      if (suwonSeen.has(c.id)) continue;
      if (fn(c)) {
        suwonSeen.add(c.id);
        suwonSelected.push(c);
        added += 1;
      }
    }
  };

  // Explicit named key outliers first
  addSuwonPick((c) => c.name.includes("e타운1빌딩"), 1);
  addSuwonPick((c) => c.name === "신대호수" || c.name === "원천호수" || c.name === "행복한들", 3);
  addSuwonPick((c) => c.name.startsWith("축구공"), 3);
  addSuwonPick((c) => c.name.startsWith("영흥수목원"), 2);
  addSuwonPick((c) => c.reviewReasons.includes("AMBIGUOUS_ADDRESS_MATCH"), 3);
  addSuwonPick((c) => c.reviewReasons.includes("REDACTED_OR_INVALID_COORD"), 3);
  addSuwonPick((c) => c.reviewReasons.includes("OFFICIAL_COORD_UNVERIFIED_IN_MOIS"), 5);
  addSuwonPick((c) => c.reviewReasons.includes("MULTI_BUILDING_COMPLEX"), 6);
  addSuwonPick((c) => c.reviewReasons.includes("SHARED_ADDRESS_MULTI_RESTROOM"), 4);
  addSuwonPick((c) => c.verificationStatus === "VERIFIED", 12);

  const suwonCsvLines = [
    [
      "restroom_id",
      "name",
      "sigungu",
      "road_address",
      "jibun_address",
      "verification_status",
      "coord_source",
      "official_lat",
      "official_lng",
      "mois_candidate_lat",
      "mois_candidate_lng",
      "official_to_mois_dist_m",
      "building_count",
      "shared_address_count",
      "review_reasons",
      "verification_basis",
    ].join(","),
  ];
  for (const c of suwonSelected) {
    suwonCsvLines.push(
      [
        c.id,
        c.name,
        c.sigungu,
        c.roadAddress,
        c.jibunAddress,
        c.verificationStatus,
        c.coordSource,
        c.officialLat,
        c.officialLng,
        c.moisCandidateLat,
        c.moisCandidateLng,
        c.officialToMoisDistM !== null ? c.officialToMoisDistM.toFixed(2) : "",
        c.buildingCount,
        c.sharedAddressCount,
        c.reviewReasons.join(";"),
        c.verificationBasis,
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  fs.writeFileSync(
    path.join(PHASE2_DIR, "suwon_review_cases.csv"),
    "\uFEFF" + suwonCsvLines.join("\n"),
    "utf8"
  );

  // Run DRY-RUN Scenarios (TASK-07)
  const dryRunFirstWave = runSelectiveDryRun(classified, {
    existingRemoteIds: remoteInfo.existingIds,
    existingRemoteSourceRecordIds: remoteInfo.existingSourceRecordIds,
    sigunguFilter: recommendedFirstWaveSigungus,
    moisLicenseCleared: false,
  });

  const dryRunAllVerified = runSelectiveDryRun(classified, {
    existingRemoteIds: remoteInfo.existingIds,
    existingRemoteSourceRecordIds: remoteInfo.existingSourceRecordIds,
    sigunguFilter: null,
    moisLicenseCleared: false,
  });

  // Also test Suwon-only DRY-RUN to prove existing 502 are protected & 0 duplicates generated
  const dryRunSuwonProtect = runSelectiveDryRun(classified, {
    existingRemoteIds: remoteInfo.existingIds,
    existingRemoteSourceRecordIds: remoteInfo.existingSourceRecordIds,
    sigunguFilter: [
      "수원시 장안구",
      "수원시 권선구",
      "수원시 팔달구",
      "수원시 영통구",
    ],
    moisLicenseCleared: false,
  });

  const summary = {
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    totalLocalRestrooms: classified.length,
    moisUniqueMatchedCount:
      moisMatchedStatusCounts.VERIFIED +
      moisMatchedStatusCounts.CANDIDATE +
      moisMatchedStatusCounts.REVIEW_REQUIRED +
      moisMatchedStatusCounts.UNMATCHED,
    officialDatasetsLoaded: datasetCounts,
    remoteBaseline: {
      totalRows: remoteInfo.totalRemoteRows,
      publicCount: remoteInfo.remotePublicCount,
      partnerCount: remoteInfo.remotePartnerCount,
    },
    overallClassification: statusCounts,
    among43778MoisMatched: moisMatchedStatusCounts,
    suwon502Classification: suwon502Counts,
    suwonReviewSampleCount: suwonSelected.length,
    verifiedBySource,
    coordSourceDistribution: officialSourceCounts,
    reviewReasonCounts,
    topGyeonggiSigunguCandidates: gyeonggiSigunguRanking.slice(0, 15),
    recommendedFirstWaveSigungus,
    dryRunResults: {
      firstWaveGyeonggi: dryRunFirstWave,
      allVerifiedNationwide: dryRunAllVerified,
      suwonProtectionCheck: dryRunSuwonProtect,
    },
  };

  fs.writeFileSync(
    path.join(PHASE2_DIR, "classification_summary.json"),
    JSON.stringify(summary, null, 2),
    "utf8"
  );

  console.log("Phase 2 classification & DRY-RUN finished!");
  console.log("Overall 51,260:", statusCounts);
  console.log("Among 43,778 MOIS matched:", moisMatchedStatusCounts);
  console.log("Suwon 502 breakdown:", suwon502Counts);
  console.log("Verified by source:", verifiedBySource);
  console.log("Recommended first-wave sigungus:", recommendedFirstWaveSigungus);
  console.log(
    `DRY-RUN First-Wave newToLoad=${dryRunFirstWave.newToLoadCount}, idempotent2nd=${dryRunFirstWave.idempotentSecondRunNewCount}`
  );
  console.log(
    `DRY-RUN All-Verified newToLoad=${dryRunAllVerified.newToLoadCount}, alreadyRemote=${dryRunAllVerified.alreadyOnRemoteCount}, idempotent2nd=${dryRunAllVerified.idempotentSecondRunNewCount}`
  );
  console.log(
    `DRY-RUN Suwon-Protect alreadyRemote=${dryRunSuwonProtect.alreadyOnRemoteCount}, newToLoad=${dryRunSuwonProtect.newToLoadCount}`
  );
}

main().catch((err) => {
  console.error("Phase 2 run failed:", err);
  process.exit(1);
});
