/**
 * Phase 3-B Seoul Official Public Restroom (OA-22586) 50-Item Pilot Load Package Library.
 *
 * Strictly uses official Seoul facility coordinates (`seoul_public_toilet_info` / OA-22586).
 * Excludes MOIS building coordinates (`mois_address_*`) and Kakao coordinates (`kakao_geocode`).
 * Zero remote DB writes and zero Kakao API calls.
 */

import { haversineMeters, isValidKoreaWgs84 } from "./lib";
import type { PublicSourceConfig } from "../../src/lib/imports/types";

export const SEOUL_OA22586_SOURCE_CONFIG: PublicSourceConfig = {
  providerName: "서울특별시",
  datasetName: "서울시 공중화장실 위치정보 (OA-22586)",
  sourceUrl: "https://data.seoul.go.kr/dataList/OA-22586/S/1/datasetView.do",
  apiEndpoint: null,
  licenseName: "이용허락범위 제한 없음",
  licenseUrl: "https://data.seoul.go.kr",
  attributionText: "출처: 서울특별시 / 서울 열린데이터광장(OA-22586)",
};

export interface SeoulOaRawRecord {
  seq: string;
  roadAddress: string;
  jibunAddress: string;
  lat: number;
  lng: number;
  buildingName: string;
  guName: string;
  phone: string;
  categoryType: string; // 유형: 공공개방| / 민간개방|
  openHours: string;
  siteUse: string; // 소재지 용도
  toiletInfo: string; // 화장실 현황
  disabledInfo: string; // 장애인화장실 현황
  extraFacilities: string; // 편의시설
  signage: string;
  siteType: string; // 소재지
  notes: string;
}

export interface SeoulPilotCandidateInput {
  restroomId: string;
  sourceRecordId: string | null;
  name: string;
  sido: string;
  sigungu: string;
  roadAddress: string;
  jibunAddress: string;
  baselineStatus: string;
  exposureTier: string;
  coordSource: string | null;
  officialLat: number | null;
  officialLng: number | null;
  officialToMoisDistM: number | null;
  matchedBuildingMgmtNo: string | null;
  genderType: string | null;
  wheelchairAccessible: boolean | null;
  babyChangingAvailable: boolean | null;
  sanitaryProductsAvailable: boolean | null;
  description: string | null;
}

export interface SeoulPilotRestroomRow {
  id: string;
  source_record_id: string;
  type: "public";
  name: string;
  description: string | null;
  road_address: string;
  address_detail: string | null;
  latitude: number;
  longitude: number;
  gender_type: "male" | "female" | "separate" | "unisex" | "unknown";
  wheelchair_accessible: boolean | null;
  baby_changing_available: boolean | null;
  sanitary_products_available: boolean | null;
  access_method: "open";
  publication_status: "published";
  last_verified_at: string;
  coordinate_source: "seoul_public_toilet_info";
  coordinate_source_record_id: string;
  coordinate_type: "facility_official";
  coordinate_verification_status: "VERIFIED";
  coordinate_verification_basis: string;
  coordinate_source_version: string;
  gu_name: string;
  oa_category_type: string;
  official_to_mois_dist_m: number;
  matched_building_mgmt_no: string | null;
}

export interface SeoulPilotPolicyRow {
  restroom_id: string;
  version: 1;
  access_mode: "free";
  deposit_amount_krw: 0;
  refund_eligible: false;
  receipt_window_hours: null;
  min_purchase_krw: 0;
  is_active: true;
}

export interface SeoulPilotCandidateAuditRow {
  restroom_id: string;
  candidate_source: "seoul_public_toilet_info";
  candidate_source_record_id: string;
  candidate_coord_type: "facility_official";
  source_version: string;
  latitude: number;
  longitude: number;
  verification_status: "VERIFIED";
  verification_basis: string;
  review_reasons: string[];
  is_selected: true;
}

export interface SeoulPilotLoadPackage {
  generatedAt: string;
  pilotTarget: "seoul_oa22586";
  sourceVersion: string;
  publicDataSource: PublicSourceConfig;
  counts: {
    restrooms: number;
    policies: number;
    candidates: number;
    distinctGus: number;
  };
  restrooms: SeoulPilotRestroomRow[];
  restroomAccessPolicies: SeoulPilotPolicyRow[];
  restroomCoordinateCandidates: SeoulPilotCandidateAuditRow[];
}

export function isValidSeoulWgs84(lat: number, lng: number): boolean {
  return (
    isValidKoreaWgs84(lat, lng) &&
    lat >= 37.41 &&
    lat <= 37.72 &&
    lng >= 126.76 &&
    lng <= 127.19
  );
}

function normStrict(s: string): string {
  return (s || "").replace(/\s+/g, "").toLowerCase();
}

export function inferGenderFromOa(
  toiletInfo: string,
  fallback: string | null
): "male" | "female" | "separate" | "unisex" | "unknown" {
  const t = (toiletInfo || "").trim();
  if (t.includes("공용")) return "unisex";
  if (t.includes("남자") && t.includes("여자")) return "separate";
  if (t.includes("남자") && !t.includes("여자")) return "male";
  if (t.includes("여자") && !t.includes("남자")) return "female";
  if (
    fallback === "male" ||
    fallback === "female" ||
    fallback === "separate" ||
    fallback === "unisex"
  ) {
    return fallback;
  }
  return "unknown";
}

export function inferWheelchairFromOa(
  disabledInfo: string,
  fallback: boolean | null
): boolean | null {
  const t = (disabledInfo || "").replace(/\|/g, "").trim();
  if (t.includes("남자") || t.includes("여자") || t.includes("공용") || t.includes("유")) {
    return true;
  }
  return fallback;
}

export function buildSeoulDescription(
  oa: SeoulOaRawRecord,
  existingDesc: string | null
): string | null {
  const parts: string[] = [];
  const hours = oa.openHours.replace(/\|/g, " ").replace(/\s+/g, " ").trim();
  if (hours) parts.push(`개방시간: ${hours}`);
  const notes = oa.notes.trim();
  if (notes) parts.push(`관리: ${notes}`);
  const phone = oa.phone.trim();
  if (phone) parts.push(`전화: ${phone}`);
  parts.push(SEOUL_OA22586_SOURCE_CONFIG.attributionText || "서울특별시");
  const combined = parts.join(" / ");
  if (combined.length <= 2000) return combined;
  return existingDesc ? existingDesc.slice(0, 2000) : combined.slice(0, 2000);
}

/**
 * Selects up to `limit` clean Seoul OA-22586 public restrooms balanced across gu's,
 * rejecting duplicates, proximity (<30m) pairs, gu mismatches, private (`민간개방|`),
 * >15m discrepancies, or non-VERIFIED records.
 */
export function selectSeoulPilotCandidates(
  candidates: SeoulPilotCandidateInput[],
  oaRecords: SeoulOaRawRecord[],
  options: {
    limit?: number;
    remoteExistingIds?: Set<string>;
    remoteExistingSourceRecordIds?: Set<string>;
    sourceVersion?: string;
    lastVerifiedAt?: string;
  } = {}
): {
  pkg: SeoulPilotLoadPackage;
  excluded: Array<{
    restroomId: string;
    name: string;
    sigungu: string;
    reason: string;
  }>;
  cleanPoolCount: number;
} {
  const limit = options.limit ?? 50;
  const remoteIds = options.remoteExistingIds ?? new Set<string>();
  const remoteSrcIds = options.remoteExistingSourceRecordIds ?? new Set<string>();
  const sourceVersion = options.sourceVersion ?? "2026-11-22";
  const lastVerifiedAt = options.lastVerifiedAt ?? "2026-11-22T00:00:00Z";

  // Index OA-22586 by rounded 6-decimal coordinate
  const oaByCoord = new Map<string, SeoulOaRawRecord[]>();
  for (const oa of oaRecords) {
    if (!isValidSeoulWgs84(oa.lat, oa.lng)) continue;
    const key = `${oa.lat.toFixed(6)},${oa.lng.toFixed(6)}`;
    const arr = oaByCoord.get(key);
    if (arr) arr.push(oa);
    else oaByCoord.set(key, [oa]);
  }

  // Detect <30m proximity pairs across all candidates
  const proximityBlocked = new Set<string>();
  const validCoordList = candidates.filter(
    (c) => c.officialLat !== null && c.officialLng !== null
  );
  for (let i = 0; i < validCoordList.length; i += 1) {
    const a = validCoordList[i];
    for (let j = i + 1; j < validCoordList.length; j += 1) {
      const b = validCoordList[j];
      if (
        Math.abs(a.officialLat! - b.officialLat!) < 0.0005 &&
        Math.abs(a.officialLng! - b.officialLng!) < 0.0005
      ) {
        if (
          haversineMeters(
            a.officialLat!,
            a.officialLng!,
            b.officialLat!,
            b.officialLng!
          ) < 30
        ) {
          proximityBlocked.add(a.restroomId);
          proximityBlocked.add(b.restroomId);
        }
      }
    }
  }

  const excluded: Array<{
    restroomId: string;
    name: string;
    sigungu: string;
    reason: string;
  }> = [];

  interface CleanEntry {
    c: SeoulPilotCandidateInput;
    oa: SeoulOaRawRecord;
    dist: number;
  }
  const cleanPool: CleanEntry[] = [];

  for (const c of candidates) {
    if (
      remoteIds.has(c.restroomId) ||
      (c.sourceRecordId && remoteSrcIds.has(c.sourceRecordId))
    ) {
      excluded.push({
        restroomId: c.restroomId,
        name: c.name,
        sigungu: c.sigungu,
        reason: "already_on_remote",
      });
      continue;
    }
    if (c.coordSource !== "seoul_city_location") {
      excluded.push({
        restroomId: c.restroomId,
        name: c.name,
        sigungu: c.sigungu,
        reason: `unsupported_coord_source:${c.coordSource ?? "null"}`,
      });
      continue;
    }
    if (c.baselineStatus !== "VERIFIED" || c.exposureTier !== "FACILITY_PIN") {
      excluded.push({
        restroomId: c.restroomId,
        name: c.name,
        sigungu: c.sigungu,
        reason: `not_step0_verified:${c.baselineStatus}/${c.exposureTier}`,
      });
      continue;
    }
    if (
      c.officialLat === null ||
      c.officialLng === null ||
      !isValidSeoulWgs84(c.officialLat, c.officialLng)
    ) {
      excluded.push({
        restroomId: c.restroomId,
        name: c.name,
        sigungu: c.sigungu,
        reason: "invalid_seoul_wgs84",
      });
      continue;
    }
    if (proximityBlocked.has(c.restroomId)) {
      excluded.push({
        restroomId: c.restroomId,
        name: c.name,
        sigungu: c.sigungu,
        reason: "proximity_lt_30m_duplicate_risk",
      });
      continue;
    }
    if (/demo\/test|qa\b/i.test(c.name)) {
      excluded.push({
        restroomId: c.restroomId,
        name: c.name,
        sigungu: c.sigungu,
        reason: "qa_demo_pattern",
      });
      continue;
    }

    const coordKey = `${c.officialLat.toFixed(6)},${c.officialLng.toFixed(6)}`;
    const oaHits = oaByCoord.get(coordKey) ?? [];
    if (oaHits.length !== 1) {
      excluded.push({
        restroomId: c.restroomId,
        name: c.name,
        sigungu: c.sigungu,
        reason: oaHits.length === 0 ? "oa_coord_not_found" : "oa_multi_coord_ambiguous",
      });
      continue;
    }
    const oa = oaHits[0];
    if (oa.categoryType.trim() !== "공공개방|") {
      excluded.push({
        restroomId: c.restroomId,
        name: c.name,
        sigungu: c.sigungu,
        reason: `non_public_open_category:${oa.categoryType.trim() || "empty"}`,
      });
      continue;
    }
    if (oa.guName.trim() !== c.sigungu.trim()) {
      excluded.push({
        restroomId: c.restroomId,
        name: c.name,
        sigungu: c.sigungu,
        reason: `gu_mismatch:${oa.guName}!=${c.sigungu}`,
      });
      continue;
    }
    if (normStrict(oa.buildingName) !== normStrict(c.name)) {
      excluded.push({
        restroomId: c.restroomId,
        name: c.name,
        sigungu: c.sigungu,
        reason: "name_diff_needs_review",
      });
      continue;
    }
    const dist = c.officialToMoisDistM ?? 999;
    if (dist > 15.0) {
      excluded.push({
        restroomId: c.restroomId,
        name: c.name,
        sigungu: c.sigungu,
        reason: `dist_gt_15m:${dist.toFixed(2)}`,
      });
      continue;
    }
    if (!oa.openHours.trim() || !oa.toiletInfo.trim() || !oa.seq.trim()) {
      excluded.push({
        restroomId: c.restroomId,
        name: c.name,
        sigungu: c.sigungu,
        reason: "missing_oa_hours_or_toilet_info_or_seq",
      });
      continue;
    }

    cleanPool.push({ c, oa, dist });
  }

  // Round-robin balanced selection across Seoul gu's (lowest dist first within each gu)
  const byGu = new Map<string, CleanEntry[]>();
  for (const entry of cleanPool) {
    const gu = entry.oa.guName.trim();
    const arr = byGu.get(gu);
    if (arr) arr.push(entry);
    else byGu.set(gu, [entry]);
  }
  const sortedGus = Array.from(byGu.keys()).sort((a, b) =>
    a.localeCompare(b, "ko")
  );
  for (const gu of sortedGus) {
    byGu.get(gu)!.sort(
      (a, b) => a.dist - b.dist || a.c.name.localeCompare(b.c.name, "ko")
    );
  }

  const selected: CleanEntry[] = [];
  const seenOaSeq = new Set<string>();
  const seenSrcIds = new Set<string>();
  let round = 0;
  while (selected.length < limit) {
    let addedInRound = false;
    for (const gu of sortedGus) {
      if (selected.length >= limit) break;
      const list = byGu.get(gu)!;
      if (round >= list.length) continue;
      const item = list[round];
      const oaSeqKey = `SEOUL-LOC-${item.oa.seq.trim()}`;
      const srcRecId = item.c.sourceRecordId || oaSeqKey;
      if (seenOaSeq.has(oaSeqKey) || seenSrcIds.has(srcRecId)) continue;
      seenOaSeq.add(oaSeqKey);
      seenSrcIds.add(srcRecId);
      selected.push(item);
      addedInRound = true;
    }
    if (!addedInRound) break;
    round += 1;
  }

  const restrooms: SeoulPilotRestroomRow[] = [];
  const policies: SeoulPilotPolicyRow[] = [];
  const candidateAudits: SeoulPilotCandidateAuditRow[] = [];

  for (const { c, oa, dist } of selected) {
    const oaRecordId = `SEOUL-LOC-${oa.seq.trim()}`;
    const srcRecordId = c.sourceRecordId || oaRecordId;
    const basis = `independent_official(seoul_public_toilet_info:${oaRecordId})+oa22586_exact+mois_1to1(${dist.toFixed(1)}m)`;

    restrooms.push({
      id: c.restroomId,
      source_record_id: srcRecordId,
      type: "public",
      name: c.name,
      description: buildSeoulDescription(oa, c.description),
      road_address: c.roadAddress,
      address_detail: c.jibunAddress || null,
      latitude: oa.lat,
      longitude: oa.lng,
      gender_type: inferGenderFromOa(oa.toiletInfo, c.genderType),
      wheelchair_accessible: inferWheelchairFromOa(
        oa.disabledInfo,
        c.wheelchairAccessible
      ),
      baby_changing_available: c.babyChangingAvailable,
      sanitary_products_available: c.sanitaryProductsAvailable,
      access_method: "open",
      publication_status: "published",
      last_verified_at: lastVerifiedAt,
      coordinate_source: "seoul_public_toilet_info",
      coordinate_source_record_id: oaRecordId,
      coordinate_type: "facility_official",
      coordinate_verification_status: "VERIFIED",
      coordinate_verification_basis: basis,
      coordinate_source_version: sourceVersion,
      gu_name: oa.guName.trim(),
      oa_category_type: oa.categoryType.trim(),
      official_to_mois_dist_m: dist,
      matched_building_mgmt_no: c.matchedBuildingMgmtNo,
    });

    policies.push({
      restroom_id: c.restroomId,
      version: 1,
      access_mode: "free",
      deposit_amount_krw: 0,
      refund_eligible: false,
      receipt_window_hours: null,
      min_purchase_krw: 0,
      is_active: true,
    });

    candidateAudits.push({
      restroom_id: c.restroomId,
      candidate_source: "seoul_public_toilet_info",
      candidate_source_record_id: oaRecordId,
      candidate_coord_type: "facility_official",
      source_version: sourceVersion,
      latitude: oa.lat,
      longitude: oa.lng,
      verification_status: "VERIFIED",
      verification_basis: basis,
      review_reasons: [],
      is_selected: true,
    });
  }

  return {
    pkg: {
      generatedAt: new Date().toISOString(),
      pilotTarget: "seoul_oa22586",
      sourceVersion,
      publicDataSource: SEOUL_OA22586_SOURCE_CONFIG,
      counts: {
        restrooms: restrooms.length,
        policies: policies.length,
        candidates: candidateAudits.length,
        distinctGus: new Set(restrooms.map((r) => r.gu_name)).size,
      },
      restrooms,
      restroomAccessPolicies: policies,
      restroomCoordinateCandidates: candidateAudits,
    },
    excluded,
    cleanPoolCount: cleanPool.length,
  };
}

export function validateSeoulPilotPackage(
  pkg: SeoulPilotLoadPackage,
  remoteExistingIds: Set<string> = new Set(),
  remoteExistingSourceRecordIds: Set<string> = new Set()
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (pkg.restrooms.length === 0 || pkg.restrooms.length > 50) {
    errors.push(`대상 건수 범위 초과(1..50): ${pkg.restrooms.length}`);
  }
  if (pkg.restrooms.length !== pkg.restroomAccessPolicies.length) {
    errors.push("화장실 수와 무료 이용정책 수가 일치하지 않습니다.");
  }
  if (pkg.restrooms.length !== pkg.restroomCoordinateCandidates.length) {
    errors.push("화장실 수와 좌표 후보 감사 레코드 수가 일치하지 않습니다.");
  }

  const seenIds = new Set<string>();
  const seenSrcIds = new Set<string>();
  const seenCoordSrcIds = new Set<string>();

  for (const r of pkg.restrooms) {
    if (seenIds.has(r.id)) errors.push(`중복 restroom id: ${r.id}`);
    seenIds.add(r.id);

    if (seenSrcIds.has(r.source_record_id)) {
      errors.push(`중복 source_record_id: ${r.source_record_id}`);
    }
    seenSrcIds.add(r.source_record_id);

    if (seenCoordSrcIds.has(r.coordinate_source_record_id)) {
      errors.push(
        `중복 coordinate_source_record_id: ${r.coordinate_source_record_id}`
      );
    }
    seenCoordSrcIds.add(r.coordinate_source_record_id);

    if (
      remoteExistingIds.has(r.id) ||
      remoteExistingSourceRecordIds.has(r.source_record_id)
    ) {
      errors.push(`기존 원격 데이터 중복 충돌: ${r.id} / ${r.source_record_id}`);
    }

    if (r.type !== "public") errors.push(`비공공 유형 차단: ${r.id}`);
    if (r.access_method !== "open") errors.push(`PIN/staff 차단: ${r.id}`);
    if (r.publication_status !== "published") {
      errors.push(`공개상태 오류: ${r.id}`);
    }
    if (r.coordinate_source !== "seoul_public_toilet_info") {
      errors.push(`미허용 좌표출처(MOIS/Kakao 등) 차단: ${r.id} (${r.coordinate_source})`);
    }
    if (r.coordinate_type !== "facility_official") {
      errors.push(`좌표유형 facility_official 필수: ${r.id}`);
    }
    if (r.coordinate_verification_status !== "VERIFIED") {
      errors.push(`검증상태 VERIFIED 필수: ${r.id}`);
    }
    if (!isValidSeoulWgs84(r.latitude, r.longitude)) {
      errors.push(`서울 WGS84 영역 이탈: ${r.id} (${r.latitude}, ${r.longitude})`);
    }
    if (/demo\/test|qa\b/i.test(r.name)) {
      errors.push(`QA/DEMO 데이터 혼입 차단: ${r.id}`);
    }
  }

  const policyIds = new Set<string>();
  for (const p of pkg.restroomAccessPolicies) {
    if (!seenIds.has(p.restroom_id)) {
      errors.push(`대상 외 정책 혼입: ${p.restroom_id}`);
    }
    if (policyIds.has(p.restroom_id)) {
      errors.push(`중복 활성 정책: ${p.restroom_id}`);
    }
    policyIds.add(p.restroom_id);
    if (
      p.access_mode !== "free" ||
      p.deposit_amount_krw !== 0 ||
      p.refund_eligible !== false ||
      p.is_active !== true
    ) {
      errors.push(`공공화장실 무료 정책 위반: ${p.restroom_id}`);
    }
  }

  return { valid: errors.length === 0, errors };
}
