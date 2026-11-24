/**
 * Phase 2.5 Coordinate Reclassification & Map Exposure Simulation Library.
 *
 * Key invariants:
 * 1. Preserves Phase 2 `verificationStatus` (`VERIFIED`/`CANDIDATE`/`REVIEW_REQUIRED`/`UNMATCHED`)
 *    as baseline without overwriting it.
 * 2. Computes separate map exposure tiers (`FACILITY_PIN` / `BUILDING_PIN` / `HIDDEN`)
 *    and waterfall steps without adding a `display_tier` DB column yet.
 * 3. NEVER uses Kakao geocode coordinates (`existing_coord_source === 'kakao_geocode'`
 *    or `existingKakaoToMoisDistM`) as an input to classification or exposure tiers.
 */

import { haversineMeters, isValidKoreaWgs84 } from "./lib";
import type {
  CachedMoisMatchRecord,
  CoordType,
  ReviewReason,
  VerificationStatus,
} from "./phase2-lib";

export type ExposureTier = "FACILITY_PIN" | "BUILDING_PIN" | "HIDDEN";

export interface NavBuildingSummary {
  mgmt: string;
  name: string;
  detail: string;
  hist: string;
  dhist: string;
  use: string;
  gf: string;
  uf: string;
  apt: string;
  bcnt: string;
  clat: number | null;
  clng: number | null;
  elat: number | null;
  elng: number | null;
}

export interface Phase2BaselineInput {
  id: string;
  sourceRecordId: string | null;
  name: string;
  sido: string;
  sigungu: string;
  roadAddress: string;
  jibunAddress: string;
  baselineStatus: VerificationStatus;
  baselineReviewReasons: ReviewReason[];
  baselineCoordSource: string | null;
  baselineCoordType: CoordType;
  officialLat: number | null;
  officialLng: number | null;
  moisLat: number | null;
  moisLng: number | null;
  officialToMoisDistM: number | null;
  buildingCount: number;
  sharedAddressCount: number;
  duplicateGroupCount: number;
  isExistingRemoteSuwon: boolean;
}

export interface SharedCoordAnalysis {
  suspectIdenticalIds: Set<string>;
  sameBuildingSplitIds: Set<string>;
}

export interface Phase25Result {
  id: string;
  sourceRecordId: string | null;
  name: string;
  sido: string;
  sigungu: string;
  roadAddress: string;
  jibunAddress: string;
  baselineStatus: VerificationStatus;
  baselineReviewReasons: ReviewReason[];
  effectiveReasonsWithoutKakao: ReviewReason[];
  exposureTier: ExposureTier;
  waterfallStep: number;
  ruleTag: string;
  coordSource: string | null;
  coordType: CoordType;
  recommendedLat: number | null;
  recommendedLng: number | null;
  matchedBuildingMgmtNo: string | null;
  matchedBuildingName: string | null;
  minBuildingDistM: number | null;
  buildingSpreadRadiusM: number | null;
  isExistingRemoteSuwon: boolean;
  licenseClearedNow: boolean;
  publicationEligibleNow: boolean;
  publicationBlockReason: string | null;
}

const FLOOR_WING_RE =
  /(지하|지상|B?\d+층|\d+F|남자|여자|남성|여성|남녀|장애인|가족|유아|본관|별관|신관|구관|동관|서관|남관|북관|좌측|우측|동편|서편|남편|북편|내부|외부|게이트|출구|\(\d+\)|-\d+$)/i;

const OUTDOOR_OPEN_RE =
  /(게이트볼장|축구장|야구장|테니스장|풋살장|농구장|족구장|운동장|생태원|수목원|유수지|선착장|전망대|방파제|유원지|등산로|둘레길|산책로|해수욕장|해변|캠핑장|야영장)/;

const SUB_BUILDING_RE =
  /([가-힣a-z0-9]{1,8}(?:공학관|강의동|연구동|생활관|기숙사|복지관|문화관|체육관|도서관|기념관|박물관|미술관|민원동|청사동|본관|별관|신관|구관|동관|서관|남관|북관|관리동|주차장|화장실|센터|타워|회관|빌딩|동|관|호동|호관))/gi;

const BUILDING_DONG_RE =
  /^([a-z0-9]+동|본동|별동|신동|민원동|청사동|관리동|강의동|연구동|실험동|실습동|제\d+.*동)$/i;

const PAREN_FLOOR_WING_RE =
  /\((?:\s*(?:지하|지상|B?\d+층|\d+F|남자?|여자?|남성|여성|남녀|공용|장애인(?:용)?|가족|유아|본관|별관|신관|구관|동관|서관|남관|북관|좌측|우측|동편|서편|남편|북편|내부|외부|\d+))+\)/gi;

export function stripFacilityMarkers(name: string): string {
  return (name || "")
    .replace(PAREN_FLOOR_WING_RE, " ")
    .replace(
      /(공중화장실|개방화장실|간이화장실|화장실|남녀공용|장애인용|장애인|가족|유아|지하\d+층|지상\d+층|\d+층|\d+f|b\d+|좌측|우측|동편|서편|본관|별관|신관|구관)/gi,
      " "
    )
    .replace(/[^가-힣a-z0-9]/gi, "")
    .toLowerCase();
}

export function cleanBuildingToken(raw: string): string {
  return (raw || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(
      /(공중화장실|개방화장실|화장실|남녀공용|장애인용|지하\d+층|지상\d+층|\d+층|\d+f|b\d+)/gi,
      " "
    )
    .replace(/[^가-힣a-z0-9]/gi, "");
}

export function computeBuildingSpreadRadiusM(
  buildings: NavBuildingSummary[]
): number | null {
  const pts = buildings.filter(
    (b): b is NavBuildingSummary & { clat: number; clng: number } =>
      b.clat !== null && b.clng !== null
  );
  if (pts.length <= 1) return pts.length === 1 ? 0 : null;
  const meanLat = pts.reduce((s, p) => s + p.clat, 0) / pts.length;
  const meanLng = pts.reduce((s, p) => s + p.clng, 0) / pts.length;
  let maxDist = 0;
  for (const p of pts) {
    const d = haversineMeters(meanLat, meanLng, p.clat, p.clng);
    if (d > maxDist) maxDist = d;
  }
  return maxDist;
}

export function findClosestBuilding(
  lat: number,
  lng: number,
  buildings: NavBuildingSummary[]
): { building: NavBuildingSummary | null; distanceM: number | null } {
  let bestB: NavBuildingSummary | null = null;
  let bestDist: number | null = null;
  for (const b of buildings) {
    if (b.clat !== null && b.clng !== null) {
      const d = haversineMeters(lat, lng, b.clat, b.clng);
      if (bestDist === null || d < bestDist) {
        bestDist = d;
        bestB = b;
      }
    }
    if (b.elat !== null && b.elng !== null) {
      const d = haversineMeters(lat, lng, b.elat, b.elng);
      if (bestDist === null || d < bestDist) {
        bestDist = d;
        bestB = b;
      }
    }
  }
  return { building: bestB, distanceM: bestDist };
}

/**
 * Detects identical official coordinates shared across multiple restroom rows.
 * Distinguishes legitimate same-building floor/wing splits from copy-pasted
 * park management office or cross-complex coordinates.
 */
export function analyzeSharedOfficialCoords(
  baselines: Phase2BaselineInput[],
  cacheById: Map<string, CachedMoisMatchRecord>,
  buildingsByPk: Map<string, NavBuildingSummary[]>
): SharedCoordAnalysis {
  const byCoord = new Map<string, Phase2BaselineInput[]>();
  for (const b of baselines) {
    if (
      b.officialLat !== null &&
      b.officialLng !== null &&
      isValidKoreaWgs84(b.officialLat, b.officialLng)
    ) {
      const key = `${b.officialLat.toFixed(5)},${b.officialLng.toFixed(5)}`;
      const arr = byCoord.get(key);
      if (arr) arr.push(b);
      else byCoord.set(key, [b]);
    }
  }

  const suspectIdenticalIds = new Set<string>();
  const sameBuildingSplitIds = new Set<string>();

  for (const items of byCoord.values()) {
    if (items.length < 2) continue;

    const anyPark = items.some(
      (x) =>
        x.baselineReviewReasons.includes("PARK_OR_OPEN_SPACE") ||
        OUTDOOR_OPEN_RE.test(x.name)
    );

    const roots = new Set(
      items.map((x) => stripFacilityMarkers(x.name)).filter((r) => r.length > 0)
    );
    const sameRoot =
      roots.size <= 1 || items.every((x) => FLOOR_WING_RE.test(x.name));

    let allSingleOrTight = true;
    let allCloseToMatchedBldg = true;

    for (const x of items) {
      const c = cacheById.get(x.id);
      const pk = c?.matched_road_pk;
      if (!pk || c?.combined_status !== "unique_match") {
        allSingleOrTight = false;
        allCloseToMatchedBldg = false;
        break;
      }
      const bldgs = buildingsByPk.get(pk) ?? [];
      if (x.buildingCount > 1) {
        const spread = computeBuildingSpreadRadiusM(bldgs);
        if (spread === null || spread > 20) {
          allSingleOrTight = false;
        }
      }
      const { distanceM } = findClosestBuilding(
        x.officialLat!,
        x.officialLng!,
        bldgs
      );
      if (distanceM === null || distanceM > 50) {
        allCloseToMatchedBldg = false;
      }
    }

    // Legitimate same-building floor/wing split:
    // Non-park, same facility root (or floor/wing markers), and either single/tight building
    // OR identical facility root within <=50m of an actual MOIS building at that PK.
    const isLegitSameBuilding =
      !anyPark &&
      sameRoot &&
      (allSingleOrTight || (roots.size <= 1 && allCloseToMatchedBldg));

    if (isLegitSameBuilding) {
      for (const x of items) sameBuildingSplitIds.add(x.id);
    } else {
      for (const x of items) suspectIdenticalIds.add(x.id);
    }
  }

  return { suspectIdenticalIds, sameBuildingSplitIds };
}

/**
 * Attempts strict unique building disambiguation inside a multi-building road PK.
 * Returns null if 0 or >=2 candidate buildings remain (never picks arbitrarily).
 */
export function disambiguateComplexBuilding(
  restroomName: string,
  buildings: NavBuildingSummary[]
): { building: NavBuildingSummary; method: string } | null {
  if (buildings.length === 0) return null;

  const rawMatches = restroomName.match(SUB_BUILDING_RE) ?? [];
  const subTokens: string[] = [];
  for (const tok of rawMatches) {
    if (tok.endsWith("동") && !BUILDING_DONG_RE.test(tok)) continue;
    const cleaned = cleanBuildingToken(tok);
    if (cleaned.length >= 2) subTokens.push(cleaned);
  }

  if (subTokens.length > 0) {
    const hits = buildings.filter((b) => {
      const bd = cleanBuildingToken(b.detail);
      const bn = cleanBuildingToken(b.name);
      return subTokens.some(
        (st) =>
          (bd && (st === bd || (st.length >= 3 && bd.includes(st)))) ||
          (bn && st === bn)
      );
    });
    if (hits.length === 1 && hits[0].clat !== null && hits[0].clng !== null) {
      return { building: hits[0], method: "sub_token_unique" };
    }
  }

  const rClean = cleanBuildingToken(restroomName);
  if (rClean.length >= 3) {
    const hits = buildings.filter((b) => {
      const bd = cleanBuildingToken(b.detail);
      const bn = cleanBuildingToken(b.name);
      return (
        (bd &&
          (rClean === bd ||
            (bd.length >= 4 && (rClean.includes(bd) || bd.includes(rClean))))) ||
        (bn && rClean === bn)
      );
    });
    if (hits.length === 1 && hits[0].clat !== null && hits[0].clng !== null) {
      return { building: hits[0], method: "name_unique" };
    }
  }

  const toiletBldgs = buildings.filter((b) =>
    `${b.name} ${b.detail}`.includes("화장실")
  );
  // Only select a standalone '화장실' building if the restroom name doesn't refer
  // to a different main building type (e.g. '도서관 3층', '구청', '병원', '학교')
  const nonToiletMainBuildingHint =
    /(도서관|구청|시청|군청|주민센터|복지관|병원|학교|대학|백화점|마트|아울렛|터미널|체육관|박물관|미술관|법원|경찰서)/.test(
      restroomName
    );
  if (
    !nonToiletMainBuildingHint &&
    toiletBldgs.length === 1 &&
    toiletBldgs[0].clat !== null &&
    toiletBldgs[0].clng !== null
  ) {
    return { building: toiletBldgs[0], method: "unique_toilet_bldg" };
  }

  return null;
}

const HARD_BLOCKING_REASONS: ReadonlySet<ReviewReason> = new Set([
  "DUPLICATE_SUSPECT",
  "ADMIN_BOUNDARY_UNCERTAIN",
  "AMBIGUOUS_ADDRESS_MATCH",
  "REDACTED_OR_INVALID_COORD",
  "OFFICIAL_COORD_UNVERIFIED_IN_MOIS",
]);

function checkLicenseAndPublication(
  tier: ExposureTier,
  coordSource: string | null,
  lat: number | null,
  lng: number | null,
  isExistingRemoteSuwon: boolean,
  options: {
    moisLicenseCleared?: boolean;
    municipalCommercialCleared?: boolean;
  }
): {
  licenseClearedNow: boolean;
  publicationEligibleNow: boolean;
  publicationBlockReason: string | null;
} {
  if (tier === "HIDDEN") {
    return {
      licenseClearedNow: false,
      publicationEligibleNow: false,
      publicationBlockReason: "exposure_tier=HIDDEN",
    };
  }
  if (coordSource === "kakao_geocode") {
    return {
      licenseClearedNow: false,
      publicationEligibleNow: false,
      publicationBlockReason: "kakao_coords_excluded",
    };
  }
  if (lat === null || lng === null || !isValidKoreaWgs84(lat, lng)) {
    return {
      licenseClearedNow: false,
      publicationEligibleNow: false,
      publicationBlockReason: "invalid_coords",
    };
  }
  const isMoisDerived =
    coordSource === "mois_address_nav_db" ||
    coordSource === "mois_address_summary_db";
  if (isMoisDerived && !options.moisLicenseCleared) {
    return {
      licenseClearedNow: false,
      publicationEligibleNow: false,
      publicationBlockReason: "mois_license_unconfirmed",
    };
  }
  if (isExistingRemoteSuwon) {
    return {
      licenseClearedNow: true,
      publicationEligibleNow: true,
      publicationBlockReason: null,
    };
  }
  if (!options.municipalCommercialCleared) {
    return {
      licenseClearedNow: false,
      publicationEligibleNow: false,
      publicationBlockReason: "municipal_license_precheck_required",
    };
  }
  return {
    licenseClearedNow: true,
    publicationEligibleNow: true,
    publicationBlockReason: null,
  };
}

/**
 * Evaluates a single restroom record for Phase 2.5 exposure tier and waterfall step.
 * Deliberately ignores Kakao coordinates (`existing_coord_source === 'kakao_geocode'`).
 */
export function classifyPhase25Record(
  baseline: Phase2BaselineInput,
  cacheRec: CachedMoisMatchRecord,
  buildings: NavBuildingSummary[],
  sharedCoordAnalysis: SharedCoordAnalysis,
  options: {
    moisLicenseCleared?: boolean;
    municipalCommercialCleared?: boolean;
    steps2Before3?: boolean;
  } = {}
): Phase25Result {
  const effectiveReasons = baseline.baselineReviewReasons.filter(
    (r) => r !== "LARGE_KAKAO_MOIS_DISCREPANCY"
  );
  const reasonSet = new Set<ReviewReason>(effectiveReasons);

  const hasOfficial =
    baseline.officialLat !== null &&
    baseline.officialLng !== null &&
    isValidKoreaWgs84(baseline.officialLat, baseline.officialLng);

  const officialClosest = hasOfficial
    ? findClosestBuilding(
        baseline.officialLat!,
        baseline.officialLng!,
        buildings
      )
    : { building: null, distanceM: null };

  const moisCoord =
    cacheRec.combined_status === "unique_match" &&
    cacheRec.centroid_pref_lat !== null &&
    cacheRec.centroid_pref_lng !== null &&
    isValidKoreaWgs84(cacheRec.centroid_pref_lat, cacheRec.centroid_pref_lng)
      ? { lat: cacheRec.centroid_pref_lat, lng: cacheRec.centroid_pref_lng }
      : cacheRec.combined_status === "unique_match" &&
          cacheRec.service_lat !== null &&
          cacheRec.service_lng !== null &&
          isValidKoreaWgs84(cacheRec.service_lat, cacheRec.service_lng)
        ? { lat: cacheRec.service_lat, lng: cacheRec.service_lng }
        : null;

  const spreadRadiusM =
    buildings.length > 1 ? computeBuildingSpreadRadiusM(buildings) : 0;

  const hasHardBlock = effectiveReasons.some((r) =>
    HARD_BLOCKING_REASONS.has(r)
  );
  const isParkOrOutdoor =
    reasonSet.has("PARK_OR_OPEN_SPACE") || OUTDOOR_OPEN_RE.test(baseline.name);

  let tier: ExposureTier = "HIDDEN";
  let waterfallStep = -1;
  let ruleTag = "held_hidden";
  let coordSource: string | null = null;
  let coordType: CoordType = "none";
  let recLat: number | null = null;
  let recLng: number | null = null;
  let matchedMgmtNo: string | null = cacheRec.matched_building_mgmt_no;
  let matchedBldgName: string | null = cacheRec.matched_building_name;

  // Step 0: Baseline VERIFIED
  if (baseline.baselineStatus === "VERIFIED") {
    tier = "FACILITY_PIN";
    waterfallStep = 0;
    ruleTag = "baseline_verified";
    coordSource = baseline.baselineCoordSource;
    coordType = "facility_official";
    recLat = baseline.officialLat;
    recLng = baseline.officialLng;
  }
  // Step 1: Official facility coord re-evaluation
  else if (
    hasOfficial &&
    !hasHardBlock &&
    !sharedCoordAnalysis.suspectIdenticalIds.has(baseline.id) &&
    officialClosest.distanceM !== null
  ) {
    const dist = officialClosest.distanceM;
    const bestB = officialClosest.building;
    const bNameStr = bestB ? `${bestB.name} ${bestB.detail}` : "";
    const isParkMgmtOfficeTrap =
      isParkOrOutdoor &&
      bNameStr.includes("관리사무소") &&
      !baseline.name.includes("관리사무소");

    if (isParkOrOutdoor) {
      if (!isParkMgmtOfficeTrap && dist <= 50) {
        tier = "FACILITY_PIN";
        waterfallStep = 1;
        ruleTag = "official_park_unique_close_bldg";
        coordSource = baseline.baselineCoordSource;
        coordType = "facility_official";
        recLat = baseline.officialLat;
        recLng = baseline.officialLng;
        if (!matchedMgmtNo && bestB) {
          matchedMgmtNo = bestB.mgmt;
          matchedBldgName = bestB.name || bestB.detail || null;
        }
      }
    } else if (dist <= 100) {
      tier = "FACILITY_PIN";
      waterfallStep = 1;
      ruleTag = "official_re_evaluated_bldg_match";
      coordSource = baseline.baselineCoordSource;
      coordType = "facility_official";
      recLat = baseline.officialLat;
      recLng = baseline.officialLng;
      if (!matchedMgmtNo && bestB) {
        matchedMgmtNo = bestB.mgmt;
        matchedBldgName = bestB.name || bestB.detail || null;
      }
    }
  }

  // Helper to resolve single building from MOIS for Steps 2, 3, 4, 5
  const tryMoisSingleBuilding = (): {
    lat: number;
    lng: number;
    cType: CoordType;
    mgmt: string | null;
    bName: string | null;
    subTag: string;
  } | null => {
    if (cacheRec.combined_status !== "unique_match" || !moisCoord) return null;
    if (cacheRec.matched_building_mgmt_no) {
      const mb = buildings.find(
        (b) => b.mgmt === cacheRec.matched_building_mgmt_no
      );
      if (mb && (mb.apt === "1" || mb.apt === "2")) return null;
      const lat = mb?.clat ?? moisCoord.lat;
      const lng = mb?.clng ?? moisCoord.lng;
      return {
        lat,
        lng,
        cType: mb?.clat !== null ? "building_centroid" : "main_entrance",
        mgmt: cacheRec.matched_building_mgmt_no,
        bName: mb?.name || mb?.detail || cacheRec.matched_building_name,
        subTag: "single_bldg",
      };
    }
    if (reasonSet.has("MULTI_BUILDING_COMPLEX") && buildings.length > 0) {
      const dis = disambiguateComplexBuilding(baseline.name, buildings);
      if (dis && dis.building.apt === "0") {
        return {
          lat: dis.building.clat!,
          lng: dis.building.clng!,
          cType: "building_centroid",
          mgmt: dis.building.mgmt,
          bName: dis.building.name || dis.building.detail || null,
          subTag: dis.method,
        };
      }
      if (
        spreadRadiusM !== null &&
        spreadRadiusM <= 20 &&
        buildings.every((b) => b.apt === "0")
      ) {
        return {
          lat: moisCoord.lat,
          lng: moisCoord.lng,
          cType: "building_centroid",
          mgmt: null,
          bName: buildings[0]?.name || null,
          subTag: "tight_cluster_20m",
        };
      }
    }
    return null;
  };

  if (tier === "HIDDEN" && !hasHardBlock && !reasonSet.has("LARGE_OFFICIAL_MOIS_DISCREPANCY")) {
    const moisSource = cacheRec.combined_match_basis?.startsWith("summary_")
      ? "mois_address_summary_db"
      : "mois_address_nav_db";

    const applyBuildingPin = (
      step: number,
      tag: string,
      resolved: NonNullable<ReturnType<typeof tryMoisSingleBuilding>>
    ) => {
      tier = "BUILDING_PIN";
      waterfallStep = step;
      ruleTag = tag;
      coordSource = moisSource;
      coordType = resolved.cType;
      recLat = resolved.lat;
      recLng = resolved.lng;
      matchedMgmtNo = resolved.mgmt;
      matchedBldgName = resolved.bName;
    };

    const steps2Before3 = options.steps2Before3 ?? true;

    if (steps2Before3) {
      // Step 2: Multi-building complex disambiguation (non-park, non-shared OR shared handled after if needed)
      if (
        reasonSet.has("MULTI_BUILDING_COMPLEX") &&
        !isParkOrOutdoor &&
        !reasonSet.has("SHARED_ADDRESS_MULTI_RESTROOM")
      ) {
        const res = tryMoisSingleBuilding();
        if (res) applyBuildingPin(2, `mbc_${res.subTag}`, res);
      }

      // Step 3: Shared address facilities (non-park)
      if (
        tier === "HIDDEN" &&
        reasonSet.has("SHARED_ADDRESS_MULTI_RESTROOM") &&
        !isParkOrOutdoor
      ) {
        const res = tryMoisSingleBuilding();
        if (res) applyBuildingPin(3, `shared_${res.subTag}`, res);
      }
    } else {
      // Alternative order: Step 3 (shared) before Step 2 (MBC)
      if (reasonSet.has("SHARED_ADDRESS_MULTI_RESTROOM") && !isParkOrOutdoor) {
        const res = tryMoisSingleBuilding();
        if (res) applyBuildingPin(3, `shared_${res.subTag}`, res);
      }
      if (
        tier === "HIDDEN" &&
        reasonSet.has("MULTI_BUILDING_COMPLEX") &&
        !isParkOrOutdoor
      ) {
        const res = tryMoisSingleBuilding();
        if (res) applyBuildingPin(2, `mbc_${res.subTag}`, res);
      }
    }

    // Step 4: General single-building CANDIDATE evaluation
    if (tier === "HIDDEN" && baseline.baselineStatus === "CANDIDATE" && !isParkOrOutdoor) {
      const res = tryMoisSingleBuilding();
      if (res) applyBuildingPin(4, "candidate_single_building", res);
    }

    // Step 5: Other safe rules
    if (tier === "HIDDEN") {
      // 5a) Kakao-only flag removed -> single building
      if (
        baseline.baselineStatus === "REVIEW_REQUIRED" &&
        effectiveReasons.length === 0 &&
        !isParkOrOutdoor
      ) {
        const res = tryMoisSingleBuilding();
        if (res) applyBuildingPin(5, "kakao_flag_removed_single_bldg", res);
      }
      // 5b) Dedicated park toilet building explicitly named '화장실' in MOIS
      else if (
        isParkOrOutdoor &&
        effectiveReasons.every(
          (r) =>
            r === "PARK_OR_OPEN_SPACE" || r === "SHARED_ADDRESS_MULTI_RESTROOM"
        ) &&
        cacheRec.matched_building_mgmt_no
      ) {
        const mb = buildings.find(
          (b) => b.mgmt === cacheRec.matched_building_mgmt_no
        );
        if (
          mb &&
          mb.apt === "0" &&
          mb.clat !== null &&
          mb.clng !== null &&
          `${mb.name} ${mb.detail}`.includes("화장실")
        ) {
          applyBuildingPin(5, "dedicated_park_toilet_building", {
            lat: mb.clat,
            lng: mb.clng,
            cType: "building_centroid",
            mgmt: mb.mgmt,
            bName: mb.name || mb.detail || null,
            subTag: "dedicated_park_toilet",
          });
        }
      }
    }
  }

  const lic = checkLicenseAndPublication(
    tier,
    coordSource,
    recLat,
    recLng,
    baseline.isExistingRemoteSuwon,
    options
  );

  return {
    id: baseline.id,
    sourceRecordId: baseline.sourceRecordId,
    name: baseline.name,
    sido: baseline.sido,
    sigungu: baseline.sigungu,
    roadAddress: baseline.roadAddress,
    jibunAddress: baseline.jibunAddress,
    baselineStatus: baseline.baselineStatus,
    baselineReviewReasons: baseline.baselineReviewReasons,
    effectiveReasonsWithoutKakao: effectiveReasons,
    exposureTier: tier,
    waterfallStep,
    ruleTag,
    coordSource,
    coordType,
    recommendedLat: recLat,
    recommendedLng: recLng,
    matchedBuildingMgmtNo: matchedMgmtNo,
    matchedBuildingName: matchedBldgName,
    minBuildingDistM: officialClosest.distanceM,
    buildingSpreadRadiusM: spreadRadiusM,
    isExistingRemoteSuwon: baseline.isExistingRemoteSuwon,
    licenseClearedNow: lic.licenseClearedNow,
    publicationEligibleNow: lic.publicationEligibleNow,
    publicationBlockReason: lic.publicationBlockReason,
  };
}

/**
 * Derives exposure tier from 20261124000000 schema metadata without a `display_tier` column.
 */
export function deriveExposureTierFromDbMetadata(row: {
  publication_status: string;
  coordinate_source: string | null;
  coordinate_type: string | null;
  coordinate_verification_status: string | null;
}): ExposureTier {
  if (row.publication_status !== "published") return "HIDDEN";
  if (row.coordinate_source === "kakao_geocode") return "HIDDEN";
  if (
    row.coordinate_type === "facility_official" ||
    (row.coordinate_type === null &&
      row.coordinate_source === "gg_publtolt_15011425")
  ) {
    return "FACILITY_PIN";
  }
  if (
    row.coordinate_type === "building_centroid" ||
    row.coordinate_type === "main_entrance"
  ) {
    return "BUILDING_PIN";
  }
  return "HIDDEN";
}

/**
 * Deterministic Mulberry32 PRNG for reproducible stratified sampling (TASK 7).
 */
export function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededSample<T>(items: T[], count: number, seed: number): T[] {
  const arr = [...items];
  const rng = createSeededRng(seed);
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, Math.min(count, arr.length));
}
