/**
 * Phase 3-C Seoul OA-22586 Pre-Deployment Safety Re-Verification Library.
 *
 * Key upgrades over Phase 3-B:
 * 1. Removes dependency on unconfirmed MOIS building coordinates (`mois_address_*`,
 *    `matched_building_mgmt_no`, `official_to_mois_dist_m`).
 * 2. Applies official KOGL Type 1 (공공누리 제1유형: 출처표시) attribution metadata
 *    and explicit OA-22586 CSV source version/hash.
 * 3. Checks duplicate risk against ALL 4,547 OA-22586 rows (not only Phase 2 matched subset)
 *    AND against ALL remote Supabase rows by ID, normalized name/address, and <200m proximity
 *    (quarantining suspects on hold instead of deleting/merging).
 * 4. Selects a 10-item Canary subset of independently verifiable public landmarks and prepares
 *    human review checklists separating roadview-verifiable items from non-verifiable indoor fields.
 */

import { haversineMeters } from "./lib";
import { buildStaticMapReviewLinks } from "./phase3a-lib";
import {
  buildSeoulDescription,
  inferGenderFromOa,
  inferWheelchairFromOa,
  isValidSeoulWgs84,
  type SeoulOaRawRecord,
  type SeoulPilotCandidateAuditRow,
  type SeoulPilotPolicyRow,
} from "./phase3b-lib";
import type { PublicSourceConfig } from "../../src/lib/imports/types";

export const SEOUL_OA22586_KOGL1_SOURCE_CONFIG: PublicSourceConfig = {
  providerName: "서울특별시",
  datasetName: "서울시 공중화장실 위치정보 (OA-22586)",
  sourceUrl: "https://data.seoul.go.kr/dataList/OA-22586/S/1/datasetView.do",
  apiEndpoint: null,
  licenseName: "공공누리 제1유형 (출처표시)",
  licenseUrl: "https://www.kogl.or.kr/info/licenseType1.do",
  attributionText:
    "본 서비스는 '서울특별시'에서 '2026년' 작성하여 공공누리 제1유형으로 개방한 '서울시 공중화장실 위치정보(OA-22586)'를 서울 열린데이터광장(https://data.seoul.go.kr/dataList/OA-22586/S/1/datasetView.do)에서 무료로 내려받아 이용하였습니다.",
};

export interface RemoteRestroomRef {
  id: string;
  source_record_id: string | null;
  type: string;
  name: string;
  road_address: string;
  latitude: number | null;
  longitude: number | null;
  coordinate_source: string | null;
}

export interface NationalCatalogLink {
  restroomId: string;
  sourceRecordId: string | null;
  name: string;
  sigungu: string;
  roadAddress: string;
  jibunAddress: string;
  officialLat: number | null;
  officialLng: number | null;
  coordSource: string | null;
}

export interface Phase3cRestroomRow {
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
  landmark_category: string;
  canary_tier: "canary_10" | "pilot_50";
}

export interface Phase3cLoadPackage {
  generatedAt: string;
  pilotTarget: "seoul_oa22586";
  tier: "canary_10" | "pilot_50";
  moisDependencyRemoved: true;
  sourceVersion: string;
  sourceFileSha256: string;
  publicDataSource: PublicSourceConfig;
  counts: {
    restrooms: number;
    policies: number;
    candidates: number;
    distinctGus: number;
  };
  restrooms: Phase3cRestroomRow[];
  restroomAccessPolicies: SeoulPilotPolicyRow[];
  restroomCoordinateCandidates: SeoulPilotCandidateAuditRow[];
}

export interface VerificationChecklistRow {
  idx: number;
  tier: "canary_10" | "pilot_50";
  restroom_id: string;
  source_record_id: string;
  coordinate_source_record_id: string;
  gu_name: string;
  name: string;
  landmark_category: string;
  road_address: string;
  address_detail: string;
  latitude: number;
  longitude: number;
  kakao_map_review_url: string;
  naver_map_review_url: string;
  vworld_review_url: string;
  // Roadview / map verifiable checks (reviewer fills in)
  map_building_match: string;
  pin_on_building_or_entrance: string;
  road_address_match: string;
  public_signage_visible: string;
  // Explicitly NOT verifiable by remote map/roadview alone
  open_hours_claimed: string;
  open_hours_verifiable_by_roadview: false;
  toilet_info_claimed: string;
  toilet_counts_verifiable_by_roadview: false;
  wheelchair_claimed: string;
  wheelchair_verifiable_by_roadview: false;
  non_roadview_fields_status: "NOT_VERIFIABLE_BY_ROADVIEW";
  // Sign-off state (must stay PENDING until actual human verification)
  visual_review_status: "PENDING_HUMAN_REVIEW" | "VERIFIED_COMPLETE" | "HOLD" | "REJECTED";
  human_verified_complete: boolean;
  reviewer_name: string;
  reviewed_at: string;
  review_decision: string;
  review_notes: string;
}

export interface MismatchOrHoldRecord {
  oaSeq: string;
  name: string;
  guName: string;
  reason: string;
  detail: string;
}

function normStrict(s: string): string {
  return (s || "").replace(/\s+/g, "").toLowerCase();
}

export function buildSeoulKogl1Description(
  oa: SeoulOaRawRecord,
  datasetYear = "2026"
): string {
  const base = buildSeoulDescription(oa, null) || "";
  const koglTag = `출처: 서울특별시(${datasetYear}년) · '서울시 공중화장실 위치정보(OA-22586)' · 공공누리 제1유형 (서울 열린데이터광장)`;
  // Replace old short attribution suffix with explicit KOGL Type 1 attribution
  const stripped = base
    .replace(
      /\s*\/\s*출처:\s*서울특별시\s*\/\s*서울 열린데이터광장\(OA-22586\)\s*$/,
      ""
    )
    .trim();
  const combined = stripped ? `${stripped} / ${koglTag}` : koglTag;
  return combined.slice(0, 2000);
}

/**
 * Classifies whether a facility name represents a clear standalone public landmark
 * easily recognizable via map/roadview for Canary-10 prioritization.
 */
export function classifyPublicLandmark(name: string): {
  category: string;
  canaryPriority: number;
} {
  if (/주민센터|행정복지센터/.test(name)) {
    return { category: "community_center", canaryPriority: 1 };
  }
  if (/구민회관|문화센터|구청/.test(name)) {
    return { category: "civic_hall", canaryPriority: 2 };
  }
  if (/도서관/.test(name)) {
    return { category: "public_library", canaryPriority: 3 };
  }
  if (/경찰서|파출소|지구대/.test(name)) {
    return { category: "police_station", canaryPriority: 4 };
  }
  if (/소방서|안전센터/.test(name)) {
    return { category: "fire_station", canaryPriority: 5 };
  }
  if (/보건소|체육센터|체육관/.test(name)) {
    return { category: "public_health_sports", canaryPriority: 6 };
  }
  if (/역\s*화장실|호선/.test(name)) {
    return { category: "transit_station", canaryPriority: 7 };
  }
  if (/공원|주차장/.test(name)) {
    return { category: "park_or_parking", canaryPriority: 8 };
  }
  return { category: "other_public", canaryPriority: 9 };
}

/**
 * Evaluates OA-22586 official facility records WITHOUT any MOIS (`mois_address_*`)
 * dependency, cross-checking duplicates against all 4,547 OA rows and all remote rows.
 * Suspects are quarantined on hold rather than deleted or merged.
 */
export function buildPhase3cMoisFreePackages(params: {
  oaRecords: SeoulOaRawRecord[];
  nationalLinks: NationalCatalogLink[];
  remoteRows: RemoteRestroomRef[];
  sourceVersion: string;
  sourceFileSha256: string;
  lastVerifiedAt: string;
  phase3bSelectedIds?: Set<string>;
}): {
  canary10Pkg: Phase3cLoadPackage;
  pilot50Pkg: Phase3cLoadPackage;
  canary10Checklist: VerificationChecklistRow[];
  pilot50Checklist: VerificationChecklistRow[];
  cleanPoolCount: number;
  quarantinedHolds: MismatchOrHoldRecord[];
  funnel: {
    oaRawTotal: number;
    oaPublicOpenTotal: number;
    oaValidCoordsAndFields: number;
    oaUniqueCoordAndName: number;
    moisFreeCleanNoProximity50m: number;
    matchedExistingNationalIdCount: number;
    syntheticUuidCount: number;
    remoteOverlapHoldCount: number;
    proximityLt50mHoldCount: number;
    phase3bSelectedCount: number;
    phase3bKeptInMoisFreePool: number;
    phase3bHeldForProximity50m: number;
  };
} {
  const {
    oaRecords,
    nationalLinks,
    remoteRows,
    sourceVersion,
    sourceFileSha256,
    lastVerifiedAt,
    phase3bSelectedIds = new Set<string>(),
  } = params;

  // Build non-MOIS coordinate/name index to reuse stable IDs where available in raw national CSV
  const linkByCoord = new Map<string, NationalCatalogLink[]>();
  for (const nl of nationalLinks) {
    if (nl.coordSource !== "seoul_city_location") continue;
    if (nl.officialLat === null || nl.officialLng === null) continue;
    const k = `${nl.officialLat.toFixed(6)},${nl.officialLng.toFixed(6)}`;
    const arr = linkByCoord.get(k);
    if (arr) arr.push(nl);
    else linkByCoord.set(k, [nl]);
  }

  // Index ALL 4,547 OA-22586 rows for exact coord & gu+name uniqueness + <50m proximity check
  const coordCounts = new Map<string, number>();
  const guNameCounts = new Map<string, number>();
  const addrNameCounts = new Map<string, number>();
  for (const oa of oaRecords) {
    if (isValidSeoulWgs84(oa.lat, oa.lng)) {
      const ck = `${oa.lat.toFixed(6)},${oa.lng.toFixed(6)}`;
      coordCounts.set(ck, (coordCounts.get(ck) ?? 0) + 1);
    }
    const gnk = `${oa.guName.trim()}|${normStrict(oa.buildingName)}`;
    guNameCounts.set(gnk, (guNameCounts.get(gnk) ?? 0) + 1);
    const roadNorm = normStrict(oa.roadAddress);
    if (roadNorm) {
      const ank = `${roadNorm}|${normStrict(oa.buildingName)}`;
      addrNameCounts.set(ank, (addrNameCounts.get(ank) ?? 0) + 1);
    }
  }

  // Build proximity (<50m) blocklist across ALL 4,547 OA-22586 records
  const proximityHoldSeqs = new Map<string, string>();
  for (let i = 0; i < oaRecords.length; i += 1) {
    const a = oaRecords[i];
    if (!isValidSeoulWgs84(a.lat, a.lng)) continue;
    for (let j = i + 1; j < oaRecords.length; j += 1) {
      const b = oaRecords[j];
      if (!isValidSeoulWgs84(b.lat, b.lng)) continue;
      if (
        Math.abs(a.lat - b.lat) > 0.0007 ||
        Math.abs(a.lng - b.lng) > 0.0007
      ) {
        continue;
      }
      const d = haversineMeters(a.lat, a.lng, b.lat, b.lng);
      if (d < 50) {
        if (!proximityHoldSeqs.has(a.seq)) {
          proximityHoldSeqs.set(
            a.seq,
            `OA-22586 seq=${b.seq}(${b.buildingName})과 ${d.toFixed(1)}m 근접`
          );
        }
        if (!proximityHoldSeqs.has(b.seq)) {
          proximityHoldSeqs.set(
            b.seq,
            `OA-22586 seq=${a.seq}(${a.buildingName})과 ${d.toFixed(1)}m 근접`
          );
        }
      }
    }
  }

  // Build remote index for ID, source_record_id, normalized name/address, and <200m proximity
  const remoteIdSet = new Set(remoteRows.map((r) => r.id));
  const remoteSrcIdSet = new Set(
    remoteRows.map((r) => r.source_record_id).filter((v): v is string => Boolean(v))
  );
  const remoteNameSet = new Set(remoteRows.map((r) => normStrict(r.name)));
  const remoteAddrSet = new Set(
    remoteRows.map((r) => normStrict(r.road_address))
  );

  let oaPublicOpenTotal = 0;
  let oaValidCoordsAndFields = 0;
  let oaUniqueCoordAndName = 0;
  let remoteOverlapHoldCount = 0;
  let proximityLt50mHoldCount = 0;
  let matchedExistingNationalIdCount = 0;
  let syntheticUuidCount = 0;
  let phase3bKeptInMoisFreePool = 0;
  let phase3bHeldForProximity50m = 0;

  const quarantinedHolds: MismatchOrHoldRecord[] = [];
  interface MoisFreeCandidate {
    oa: SeoulOaRawRecord;
    restroomId: string;
    sourceRecordId: string;
    hasMatchedNationalLink: boolean;
    landmarkCategory: string;
    canaryPriority: number;
    wasPhase3bSelected: boolean;
  }
  const cleanPool: MoisFreeCandidate[] = [];

  for (const oa of oaRecords) {
    if (oa.categoryType.trim() !== "공공개방|") continue;
    oaPublicOpenTotal += 1;

    const seq = oa.seq.trim();
    const gu = oa.guName.trim();
    const bName = oa.buildingName.trim();
    const primaryAddr = oa.roadAddress.trim() || oa.jibunAddress.trim();
    if (
      !seq ||
      !gu ||
      !bName ||
      !primaryAddr ||
      !oa.openHours.trim() ||
      !oa.toiletInfo.trim() ||
      !isValidSeoulWgs84(oa.lat, oa.lng)
    ) {
      continue;
    }

    // Address must mention the declared guName (self-consistency without MOIS)
    const addrText = `${oa.roadAddress} ${oa.jibunAddress}`;
    if (!addrText.includes(gu)) {
      quarantinedHolds.push({
        oaSeq: seq,
        name: bName,
        guName: gu,
        reason: "gu_address_mismatch",
        detail: `구(${gu})가 주소(${addrText.trim()})에 포함되지 않음`,
      });
      continue;
    }
    oaValidCoordsAndFields += 1;

    const coordKey = `${oa.lat.toFixed(6)},${oa.lng.toFixed(6)}`;
    const guNameKey = `${gu}|${normStrict(bName)}`;
    const roadNorm = normStrict(oa.roadAddress);
    const addrNameKey = roadNorm ? `${roadNorm}|${normStrict(bName)}` : "";
    if (
      (coordCounts.get(coordKey) ?? 0) !== 1 ||
      (guNameCounts.get(guNameKey) ?? 0) !== 1 ||
      (addrNameKey && (addrNameCounts.get(addrNameKey) ?? 0) !== 1)
    ) {
      quarantinedHolds.push({
        oaSeq: seq,
        name: bName,
        guName: gu,
        reason: "oa_duplicate_coord_or_name",
        detail: `좌표(${coordKey}) 또는 구+명칭(${guNameKey}) 중복`,
      });
      continue;
    }
    oaUniqueCoordAndName += 1;

    // Also track how many pure OA-22586 records pass all self-checks + <50m proximity
    // regardless of whether they appear in public_restroom_raw.csv, and link stable IDs where available.
    const proxDetailEarly = proximityHoldSeqs.get(seq);
    if (proxDetailEarly) {
      // Wait for national link check below to also record phase3b hold tracking
    }

    // Link deterministic national catalog record (ignoring MOIS coords/mgmt_no completely)
    const natHits = (linkByCoord.get(coordKey) ?? []).filter(
      (nl) => normStrict(nl.name) === normStrict(bName) && nl.sigungu.trim() === gu
    );
    if (natHits.length !== 1) {
      if (!proxDetailEarly) {
        syntheticUuidCount += 1;
      }
      continue;
    }
    const nat = natHits[0];
    const srcRecordId = nat.sourceRecordId || `SEOUL-LOC-${seq}`;
    const wasPhase3bSelected = phase3bSelectedIds.has(nat.restroomId);

    // Check remote overlap by ID, source_record_id, normalized name, normalized address, and <200m proximity
    let remoteConflict: string | null = null;
    if (remoteIdSet.has(nat.restroomId) || remoteSrcIdSet.has(srcRecordId)) {
      remoteConflict = "id_or_source_record_id_match";
    } else if (
      remoteNameSet.has(normStrict(bName)) ||
      (roadNorm && remoteAddrSet.has(roadNorm))
    ) {
      remoteConflict = "name_or_address_match_with_remote";
    } else {
      for (const rr of remoteRows) {
        if (rr.latitude == null || rr.longitude == null) continue;
        if (Math.abs(rr.latitude - oa.lat) > 0.003 || Math.abs(rr.longitude - oa.lng) > 0.003) {
          continue;
        }
        const d = haversineMeters(oa.lat, oa.lng, rr.latitude, rr.longitude);
        if (d < 200) {
          remoteConflict = `proximity_${d.toFixed(1)}m_to_${rr.name}`;
          break;
        }
      }
    }
    if (remoteConflict) {
      remoteOverlapHoldCount += 1;
      quarantinedHolds.push({
        oaSeq: seq,
        name: bName,
        guName: gu,
        reason: "remote_overlap_hold",
        detail: remoteConflict,
      });
      continue;
    }

    // Strict <50m proximity check across ALL 4,547 OA-22586 rows (MOIS-free safety check)
    const proxDetail = proximityHoldSeqs.get(seq);
    if (proxDetail) {
      proximityLt50mHoldCount += 1;
      if (wasPhase3bSelected) {
        phase3bHeldForProximity50m += 1;
      }
      quarantinedHolds.push({
        oaSeq: seq,
        name: bName,
        guName: gu,
        reason: "oa_proximity_lt_50m_hold",
        detail: proxDetail,
      });
      continue;
    }

    if (nat.restroomId) matchedExistingNationalIdCount += 1;
    else syntheticUuidCount += 1;
    if (wasPhase3bSelected) phase3bKeptInMoisFreePool += 1;

    const landmark = classifyPublicLandmark(bName);
    cleanPool.push({
      oa,
      restroomId: nat.restroomId,
      sourceRecordId: srcRecordId,
      hasMatchedNationalLink: Boolean(nat.sourceRecordId),
      landmarkCategory: landmark.category,
      canaryPriority: landmark.canaryPriority,
      wasPhase3bSelected,
    });
  }

  // Sort deterministically: prioritize landmark clarity, previously selected in 3-B, then gu & name
  const byGu = new Map<string, MoisFreeCandidate[]>();
  for (const item of cleanPool) {
    const gu = item.oa.guName.trim();
    const arr = byGu.get(gu);
    if (arr) arr.push(item);
    else byGu.set(gu, [item]);
  }
  const sortedGus = Array.from(byGu.keys()).sort((a, b) => a.localeCompare(b, "ko"));
  for (const gu of sortedGus) {
    byGu.get(gu)!.sort(
      (a, b) =>
        a.canaryPriority - b.canaryPriority ||
        Number(b.wasPhase3bSelected) - Number(a.wasPhase3bSelected) ||
        (a.oa.roadAddress.length > 0 ? 0 : 1) - (b.oa.roadAddress.length > 0 ? 0 : 1) ||
        a.oa.buildingName.localeCompare(b.oa.buildingName, "ko")
    );
  }

  // Round-robin 50 selection across gu's
  const pilot50Items: MoisFreeCandidate[] = [];
  let round = 0;
  while (pilot50Items.length < 50) {
    let added = false;
    for (const gu of sortedGus) {
      if (pilot50Items.length >= 50) break;
      const list = byGu.get(gu)!;
      if (round >= list.length) continue;
      pilot50Items.push(list[round]);
      added = true;
    }
    if (!added) break;
    round += 1;
  }

  // Canary-10: top 10 distinct gu's with standalone public landmarks (community_center / civic_hall / library / police / fire)
  // AND required non-empty road_address so roadview address check is unambiguous!
  const canaryCandidates = [...pilot50Items]
    .filter((c) => c.oa.roadAddress.trim().length > 0 && c.canaryPriority <= 6)
    .sort(
      (a, b) =>
        a.canaryPriority - b.canaryPriority ||
        a.oa.guName.localeCompare(b.oa.guName, "ko")
    );
  const canary10Items: MoisFreeCandidate[] = [];
  const seenCanaryGu = new Set<string>();
  for (const c of canaryCandidates) {
    if (canary10Items.length >= 10) break;
    const gu = c.oa.guName.trim();
    if (seenCanaryGu.has(gu)) continue;
    seenCanaryGu.add(gu);
    canary10Items.push(c);
  }
  const canaryIdSet = new Set(canary10Items.map((c) => c.restroomId));

  const toPackage = (
    items: MoisFreeCandidate[],
    tier: "canary_10" | "pilot_50"
  ): Phase3cLoadPackage => {
    const restrooms: Phase3cRestroomRow[] = [];
    const policies: SeoulPilotPolicyRow[] = [];
    const candidates: SeoulPilotCandidateAuditRow[] = [];

    for (const item of items) {
      const oa = item.oa;
      const oaCoordId = `SEOUL-LOC-${oa.seq.trim()}`;
      const basis = `independent_official(seoul_public_toilet_info:${oaCoordId})+oa22586_self_unique+no_lt50m_neighbor(mois_independent)`;
      const roadAddr =
        oa.roadAddress.trim() ||
        oa.jibunAddress.trim() ||
        `서울특별시 ${oa.guName.trim()}`;
      const addrDetail =
        oa.roadAddress.trim() && oa.jibunAddress.trim()
          ? `(지번) ${oa.jibunAddress.trim()}`
          : null;

      restrooms.push({
        id: item.restroomId,
        source_record_id: item.sourceRecordId,
        type: "public",
        name: oa.buildingName.trim(),
        description: buildSeoulKogl1Description(oa, "2026"),
        road_address: roadAddr,
        address_detail: addrDetail,
        latitude: oa.lat,
        longitude: oa.lng,
        gender_type: inferGenderFromOa(oa.toiletInfo, null),
        wheelchair_accessible: inferWheelchairFromOa(oa.disabledInfo, null),
        baby_changing_available: oa.extraFacilities.includes("기저귀") ? true : false,
        sanitary_products_available: null,
        access_method: "open",
        publication_status: "published",
        last_verified_at: lastVerifiedAt,
        coordinate_source: "seoul_public_toilet_info",
        coordinate_source_record_id: oaCoordId,
        coordinate_type: "facility_official",
        coordinate_verification_status: "VERIFIED",
        coordinate_verification_basis: basis,
        coordinate_source_version: sourceVersion,
        gu_name: oa.guName.trim(),
        oa_category_type: oa.categoryType.trim(),
        landmark_category: item.landmarkCategory,
        canary_tier: canaryIdSet.has(item.restroomId) ? "canary_10" : "pilot_50",
      });

      policies.push({
        restroom_id: item.restroomId,
        version: 1,
        access_mode: "free",
        deposit_amount_krw: 0,
        refund_eligible: false,
        receipt_window_hours: null,
        min_purchase_krw: 0,
        is_active: true,
      });

      candidates.push({
        restroom_id: item.restroomId,
        candidate_source: "seoul_public_toilet_info",
        candidate_source_record_id: oaCoordId,
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
      generatedAt: new Date().toISOString(),
      pilotTarget: "seoul_oa22586",
      tier,
      moisDependencyRemoved: true,
      sourceVersion,
      sourceFileSha256,
      publicDataSource: SEOUL_OA22586_KOGL1_SOURCE_CONFIG,
      counts: {
        restrooms: restrooms.length,
        policies: policies.length,
        candidates: candidates.length,
        distinctGus: new Set(restrooms.map((r) => r.gu_name)).size,
      },
      restrooms,
      restroomAccessPolicies: policies,
      restroomCoordinateCandidates: candidates,
    };
  };

  const toChecklist = (
    pkg: Phase3cLoadPackage,
    itemMap: Map<string, MoisFreeCandidate>
  ): VerificationChecklistRow[] => {
    return pkg.restrooms.map((r, i) => {
      const oa = itemMap.get(r.id)!.oa;
      const links = buildStaticMapReviewLinks(r.name, r.latitude, r.longitude);
      return {
        idx: i + 1,
        tier: r.canary_tier,
        restroom_id: r.id,
        source_record_id: r.source_record_id,
        coordinate_source_record_id: r.coordinate_source_record_id,
        gu_name: r.gu_name,
        name: r.name,
        landmark_category: r.landmark_category,
        road_address: r.road_address,
        address_detail: r.address_detail ?? "",
        latitude: r.latitude,
        longitude: r.longitude,
        kakao_map_review_url: links.kakaoMapLink,
        naver_map_review_url: links.naverSearchLink,
        vworld_review_url: links.vworldLink,
        map_building_match: "",
        pin_on_building_or_entrance: "",
        road_address_match: "",
        public_signage_visible: "",
        open_hours_claimed: oa.openHours.replace(/\|/g, " ").trim(),
        open_hours_verifiable_by_roadview: false,
        toilet_info_claimed: oa.toiletInfo.replace(/\|/g, " ").trim(),
        toilet_counts_verifiable_by_roadview: false,
        wheelchair_claimed: oa.disabledInfo.replace(/\|/g, " ").trim(),
        wheelchair_verifiable_by_roadview: false,
        non_roadview_fields_status: "NOT_VERIFIABLE_BY_ROADVIEW",
        visual_review_status: "PENDING_HUMAN_REVIEW",
        human_verified_complete: false,
        reviewer_name: "",
        reviewed_at: "",
        review_decision: "",
        review_notes: "",
      };
    });
  };

  const canary10Pkg = toPackage(canary10Items, "canary_10");
  const pilot50Pkg = toPackage(pilot50Items, "pilot_50");
  const itemMap = new Map(cleanPool.map((c) => [c.restroomId, c]));

  return {
    canary10Pkg,
    pilot50Pkg,
    canary10Checklist: toChecklist(canary10Pkg, itemMap),
    pilot50Checklist: toChecklist(pilot50Pkg, itemMap),
    cleanPoolCount: cleanPool.length,
    quarantinedHolds,
    funnel: {
      oaRawTotal: oaRecords.length,
      oaPublicOpenTotal,
      oaValidCoordsAndFields,
      oaUniqueCoordAndName,
      moisFreeCleanNoProximity50m: cleanPool.length,
      matchedExistingNationalIdCount,
      syntheticUuidCount,
      remoteOverlapHoldCount,
      proximityLt50mHoldCount,
      phase3bSelectedCount: phase3bSelectedIds.size,
      phase3bKeptInMoisFreePool,
      phase3bHeldForProximity50m,
    },
  };
}

export type CanaryCheckOutcome = "PASS" | "FAIL" | "확인 불가" | "PENDING";

export interface CanaryReviewDecision {
  idx: number;
  restroomId: string;
  name: string;
  guName: string;
  roadAddress: string;
  /** 1) 건물 실제 위치 확인: 도로명주소·건물명·좌표 핀이 실제 건물과 일치하는지 */
  buildingLocationResult: CanaryCheckOutcome;
  /** 2) 공중화장실 존재·개방 여부 확인: 실제 공중/개방 화장실 존재 및 이용 가능 여부 확인 */
  restroomExistenceOpenResult: CanaryCheckOutcome;
  reviewerName: string;
  reviewedAt: string;
  notes: string;
}

export function createInitialCanaryReviewDecisions(
  pkg: Phase3cLoadPackage
): CanaryReviewDecision[] {
  return pkg.restrooms.map((r, i) => ({
    idx: i + 1,
    restroomId: r.id,
    name: r.name,
    guName: r.gu_name,
    roadAddress: r.road_address,
    buildingLocationResult: "PENDING",
    restroomExistenceOpenResult: "PENDING",
    reviewerName: "",
    reviewedAt: "",
    notes: "",
  }));
}

export function applyCanaryReviewGate(
  pkg: Phase3cLoadPackage,
  decisions: CanaryReviewDecision[]
): {
  approvedPackage: Phase3cLoadPackage;
  heldItems: Array<{
    idx: number;
    restroomId: string;
    name: string;
    guName: string;
    buildingLocationResult: CanaryCheckOutcome;
    restroomExistenceOpenResult: CanaryCheckOutcome;
    holdReason: string;
    notes: string;
  }>;
  summary: {
    total: number;
    approvedReadyCount: number;
    heldCount: number;
    buildingPassCount: number;
    restroomOpenPassCount: number;
    pendingCount: number;
    failCount: number;
    unverifiableCount: number;
  };
} {
  const decisionById = new Map(decisions.map((d) => [d.restroomId, d]));
  const approvedRestrooms: Phase3cRestroomRow[] = [];
  const heldItems: Array<{
    idx: number;
    restroomId: string;
    name: string;
    guName: string;
    buildingLocationResult: CanaryCheckOutcome;
    restroomExistenceOpenResult: CanaryCheckOutcome;
    holdReason: string;
    notes: string;
  }> = [];

  let buildingPassCount = 0;
  let restroomOpenPassCount = 0;
  let pendingCount = 0;
  let failCount = 0;
  let unverifiableCount = 0;

  pkg.restrooms.forEach((r, i) => {
    const dec = decisionById.get(r.id);
    const bRes: CanaryCheckOutcome = dec?.buildingLocationResult ?? "PENDING";
    const oRes: CanaryCheckOutcome = dec?.restroomExistenceOpenResult ?? "PENDING";

    if (bRes === "PASS") buildingPassCount += 1;
    if (oRes === "PASS") restroomOpenPassCount += 1;

    if (bRes === "PASS" && oRes === "PASS") {
      approvedRestrooms.push(r);
      return;
    }

    const reasons: string[] = [];
    if (bRes !== "PASS") reasons.push(`건물위치=${bRes}`);
    if (oRes !== "PASS") reasons.push(`화장실존재/개방=${oRes}`);

    if (bRes === "FAIL" || oRes === "FAIL") failCount += 1;
    else if (bRes === "확인 불가" || oRes === "확인 불가") unverifiableCount += 1;
    else pendingCount += 1;

    heldItems.push({
      idx: i + 1,
      restroomId: r.id,
      name: r.name,
      guName: r.gu_name,
      buildingLocationResult: bRes,
      restroomExistenceOpenResult: oRes,
      holdReason: reasons.join(", "),
      notes: dec?.notes ?? "",
    });
  });

  const approvedIdSet = new Set(approvedRestrooms.map((r) => r.id));
  const approvedPackage: Phase3cLoadPackage = {
    ...pkg,
    generatedAt: new Date().toISOString(),
    counts: {
      restrooms: approvedRestrooms.length,
      policies: pkg.restroomAccessPolicies.filter((p) =>
        approvedIdSet.has(p.restroom_id)
      ).length,
      candidates: pkg.restroomCoordinateCandidates.filter((c) =>
        approvedIdSet.has(c.restroom_id)
      ).length,
      distinctGus: new Set(approvedRestrooms.map((r) => r.gu_name)).size,
    },
    restrooms: approvedRestrooms,
    restroomAccessPolicies: pkg.restroomAccessPolicies.filter((p) =>
      approvedIdSet.has(p.restroom_id)
    ),
    restroomCoordinateCandidates: pkg.restroomCoordinateCandidates.filter((c) =>
      approvedIdSet.has(c.restroom_id)
    ),
  };

  return {
    approvedPackage,
    heldItems,
    summary: {
      total: pkg.restrooms.length,
      approvedReadyCount: approvedRestrooms.length,
      heldCount: heldItems.length,
      buildingPassCount,
      restroomOpenPassCount,
      pendingCount,
      failCount,
      unverifiableCount,
    },
  };
}
