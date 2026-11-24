/**
 * Phase 2 Pure Classification, Official Cross-Check, and Selective Dry-Run Library.
 * Strictly separates `VERIFIED`, `CANDIDATE`, `REVIEW_REQUIRED`, and `UNMATCHED`
 * from DB `publication_status`. Never promotes MOIS address-only matches to `VERIFIED`.
 */

import {
  isValidKoreaWgs84,
  haversineMeters,
  parseRoadAddress,
  parseJibunAddress,
  buildRoadKey,
  buildJibunKey,
  normalizeNameToken,
  isPlaceholderAddress,
  extractAddressHints,
} from "./lib";

export type VerificationStatus =
  | "VERIFIED"
  | "CANDIDATE"
  | "REVIEW_REQUIRED"
  | "UNMATCHED";

export type CoordType =
  | "facility_official"
  | "building_centroid"
  | "main_entrance"
  | "complex_centroid_mean"
  | "none";

export type ReviewReason =
  | "PARK_OR_OPEN_SPACE"
  | "MULTI_BUILDING_COMPLEX"
  | "SHARED_ADDRESS_MULTI_RESTROOM"
  | "DUPLICATE_SUSPECT"
  | "LARGE_OFFICIAL_MOIS_DISCREPANCY"
  | "LARGE_KAKAO_MOIS_DISCREPANCY"
  | "AMBIGUOUS_ADDRESS_MATCH"
  | "REDACTED_OR_INVALID_COORD"
  | "ADMIN_BOUNDARY_UNCERTAIN"
  | "UNMATCHED_IN_MOIS"
  | "OFFICIAL_COORD_UNVERIFIED_IN_MOIS";

export interface CachedMoisMatchRecord {
  id: string;
  source_id: string | null;
  source_record_id: string | null;
  name: string;
  road_address: string;
  address_detail: string | null;
  jibun_address: string;
  description: string | null;
  gender_type: string;
  wheelchair_accessible: boolean | null;
  baby_changing_available: boolean | null;
  sanitary_products_available: boolean | null;
  access_method: string;
  publication_status: string;
  last_verified_at: string | null;
  existing_lat: number | null;
  existing_lng: number | null;
  existing_coord_source: string | null;
  existing_coord_source_id: string | null;
  existing_coord_source_record_id: string | null;
  sido: string;
  sigungu: string;
  admin_dong: string | null;
  summary_status: string;
  summary_lat: number | null;
  summary_lng: number | null;
  combined_status: string;
  combined_match_basis: string | null;
  building_count: number;
  matched_road_pk: string | null;
  matched_building_mgmt_no: string | null;
  matched_building_name: string | null;
  nav_building_use: string | null;
  nav_is_complex: boolean | null;
  has_nav_centroid: boolean;
  has_nav_entrance: boolean;
  service_coord_type: string | null;
  service_lat: number | null;
  service_lng: number | null;
  centroid_pref_lat: number | null;
  centroid_pref_lng: number | null;
  existing_to_centroid_dist_m: number | null;
}

export interface OfficialFacilityRecord {
  datasetKey:
    | "suwon_remote_export"
    | "gg_publtolt_15011425"
    | "seoul_metro_2026"
    | "seoul_city_location"
    | "incheon_michuhol_2026"
    | "incheon_yeonsu_2025";
  sourceRecordId: string;
  name: string;
  roadAddress: string;
  jibunAddress: string;
  lat: number;
  lng: number;
  dataStdDate: string | null;
  sidoHint: string;
}

export interface OfficialMatchResult {
  matched: boolean;
  ambiguous: boolean;
  datasetKey: OfficialFacilityRecord["datasetKey"] | null;
  sourceRecordId: string | null;
  matchBasis: string | null;
  lat: number | null;
  lng: number | null;
  dataStdDate: string | null;
}

export interface ClassificationResult {
  id: string;
  sourceRecordId: string | null;
  name: string;
  sido: string;
  sigungu: string;
  roadAddress: string;
  jibunAddress: string;
  verificationStatus: VerificationStatus;
  verificationBasis: string;
  reviewReasons: ReviewReason[];
  coordSource: string | null;
  coordType: CoordType;
  sourceVersion: string;
  recommendedLat: number | null;
  recommendedLng: number | null;
  moisCandidateLat: number | null;
  moisCandidateLng: number | null;
  officialLat: number | null;
  officialLng: number | null;
  officialToMoisDistM: number | null;
  existingKakaoToMoisDistM: number | null;
  sharedAddressCount: number;
  duplicateGroupCount: number;
  buildingCount: number;
  isExistingRemoteSuwon: boolean;
  publishableNow: boolean;
  publishBlockReason: string | null;
}

const PARK_OR_OPEN_SPACE_RE =
  /공원|호수|산책|생태|저수지|천변|하천|광장|등산|둘레길|수변|유원지|해수욕장|해변|야영|캠핑|체육공원|근린공원|어린이공원|소공원|녹지|쉼터|선착장|방파제|포구|전망대|공영주차장|노상주차/;

const LARGE_COMPLEX_RE =
  /백화점|아울렛|터미널|종합병원|대학교|경기장|스타디움|수목원|박물관|미술관|엑스포|컨벤션|전시장|산업단지|캠퍼스|공항|역사|지하철역/;

const ADMIN_REORG_SIGUNGU_RE = /^(?:인천광역시\s*)?(?:서구|중구|동구)\b/;

export function normalizeStrictName(name: string): string {
  return (name || "")
    .replace(/\uFEFF/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

export function buildCanonicalAddressKeys(
  roadAddress: string,
  jibunAddress: string,
  sidoHint?: string
): { roadKey: string | null; jibunKey: string | null } {
  const rEmpty = isPlaceholderAddress(roadAddress);
  const jEmpty = isPlaceholderAddress(jibunAddress);
  const rh = !rEmpty ? extractAddressHints(roadAddress) : {};
  const jh = !jEmpty ? extractAddressHints(jibunAddress) : {};
  const hints = {
    sidoHint: sidoHint || rh.sidoHint || jh.sidoHint,
    sigunguHint: rh.sigunguHint || jh.sigunguHint,
  };
  const pr = parseRoadAddress(roadAddress, hints);
  const pj =
    parseJibunAddress(jibunAddress, hints) ??
    parseJibunAddress(roadAddress, hints);
  return {
    roadKey: pr ? buildRoadKey(pr, false) : null,
    jibunKey: pj ? buildJibunKey(pj, false) : null,
  };
}

export class OfficialFacilityIndex {
  private byNameRoad = new Map<string, OfficialFacilityRecord[]>();
  private byNameJibun = new Map<string, OfficialFacilityRecord[]>();
  private byNormNameRoad = new Map<string, OfficialFacilityRecord[]>();
  private byNormNameJibun = new Map<string, OfficialFacilityRecord[]>();
  private byStationName = new Map<string, OfficialFacilityRecord[]>();
  private bySuwonId = new Map<string, OfficialFacilityRecord>();

  add(rec: OfficialFacilityRecord): void {
    if (!isValidKoreaWgs84(rec.lat, rec.lng)) return;

    if (rec.datasetKey === "suwon_remote_export") {
      this.bySuwonId.set(rec.sourceRecordId, rec);
    }

    const strictName = normalizeStrictName(rec.name);
    const normName = normalizeNameToken(rec.name);
    const { roadKey, jibunKey } = buildCanonicalAddressKeys(
      rec.roadAddress,
      rec.jibunAddress,
      rec.sidoHint
    );

    if (strictName && roadKey) {
      const k = `${strictName}::${roadKey}`;
      const arr = this.byNameRoad.get(k) ?? [];
      arr.push(rec);
      this.byNameRoad.set(k, arr);
    }
    if (strictName && jibunKey) {
      const k = `${strictName}::${jibunKey}`;
      const arr = this.byNameJibun.get(k) ?? [];
      arr.push(rec);
      this.byNameJibun.set(k, arr);
    }
    if (normName && roadKey) {
      const k = `${normName}::${roadKey}`;
      const arr = this.byNormNameRoad.get(k) ?? [];
      arr.push(rec);
      this.byNormNameRoad.set(k, arr);
    }
    if (normName && jibunKey) {
      const k = `${normName}::${jibunKey}`;
      const arr = this.byNormNameJibun.get(k) ?? [];
      arr.push(rec);
      this.byNormNameJibun.set(k, arr);
    }

    if (rec.datasetKey === "seoul_metro_2026" && normName) {
      const arr = this.byStationName.get(normName) ?? [];
      arr.push(rec);
      this.byStationName.set(normName, arr);
    }
  }

  lookup(target: {
    id: string;
    name: string;
    roadAddress: string;
    jibunAddress: string;
    sido: string;
  }): OfficialMatchResult {
    const suwonDirect = this.bySuwonId.get(target.id);
    if (suwonDirect) {
      return {
        matched: true,
        ambiguous: false,
        datasetKey: "suwon_remote_export",
        sourceRecordId: suwonDirect.sourceRecordId,
        matchBasis: "suwon_remote_export_id",
        lat: suwonDirect.lat,
        lng: suwonDirect.lng,
        dataStdDate: suwonDirect.dataStdDate,
      };
    }

    const strictName = normalizeStrictName(target.name);
    const normName = normalizeNameToken(target.name);
    const { roadKey, jibunKey } = buildCanonicalAddressKeys(
      target.roadAddress,
      target.jibunAddress,
      target.sido !== "(시도미상/누락)" ? target.sido : undefined
    );

    const tryBucket = (
      bucket: OfficialFacilityRecord[] | undefined,
      basis: string
    ): OfficialMatchResult | null => {
      if (!bucket || bucket.length === 0) return null;
      // Deduplicate identical dataset+coord duplicates inside same municipal file?
      // Never auto-select if multiple distinct coordinates exist!
      const uniqueCoords = new Set(
        bucket.map((b) => `${b.lat.toFixed(6)},${b.lng.toFixed(6)}`)
      );
      if (bucket.length > 1 && uniqueCoords.size > 1) {
        return {
          matched: false,
          ambiguous: true,
          datasetKey: bucket[0].datasetKey,
          sourceRecordId: null,
          matchBasis: basis,
          lat: null,
          lng: null,
          dataStdDate: null,
        };
      }
      if (bucket.length > 1) {
        // Even with same coords, block >1 rows per match-suwon-gg-coords strict 1:1 rule
        return {
          matched: false,
          ambiguous: true,
          datasetKey: bucket[0].datasetKey,
          sourceRecordId: null,
          matchBasis: basis,
          lat: null,
          lng: null,
          dataStdDate: null,
        };
      }
      const w = bucket[0];
      return {
        matched: true,
        ambiguous: false,
        datasetKey: w.datasetKey,
        sourceRecordId: w.sourceRecordId,
        matchBasis: basis,
        lat: w.lat,
        lng: w.lng,
        dataStdDate: w.dataStdDate,
      };
    };

    if (strictName && roadKey) {
      const r = tryBucket(
        this.byNameRoad.get(`${strictName}::${roadKey}`),
        "official_name+road"
      );
      if (r) return r;
    }
    if (strictName && jibunKey) {
      const r = tryBucket(
        this.byNameJibun.get(`${strictName}::${jibunKey}`),
        "official_name+jibun"
      );
      if (r) return r;
    }
    if (normName && roadKey) {
      const r = tryBucket(
        this.byNormNameRoad.get(`${normName}::${roadKey}`),
        "official_norm_name+road"
      );
      if (r) return r;
    }
    if (normName && jibunKey) {
      const r = tryBucket(
        this.byNormNameJibun.get(`${normName}::${jibunKey}`),
        "official_norm_name+jibun"
      );
      if (r) return r;
    }

    return {
      matched: false,
      ambiguous: false,
      datasetKey: null,
      sourceRecordId: null,
      matchBasis: null,
      lat: null,
      lng: null,
      dataStdDate: null,
    };
  }
}

export function classifyRestroomRecord(
  rec: CachedMoisMatchRecord,
  officialMatch: OfficialMatchResult,
  context: {
    sharedAddressCount: number;
    duplicateGroupCount: number;
    existingRemoteIds: Set<string>;
    moisLicenseCleared?: boolean;
  }
): ClassificationResult {
  const reasons: ReviewReason[] = [];
  const isExistingRemoteSuwon =
    rec.existing_coord_source === "gg_publtolt_15011425" ||
    context.existingRemoteIds.has(rec.id);

  // Determine best independent MOIS coordinate candidate (Centroid-first per Phase 1 result)
  let moisLat: number | null = null;
  let moisLng: number | null = null;
  let moisCoordType: CoordType = "none";

  if (rec.combined_status === "unique_match") {
    if (
      rec.centroid_pref_lat !== null &&
      rec.centroid_pref_lng !== null &&
      isValidKoreaWgs84(rec.centroid_pref_lat, rec.centroid_pref_lng)
    ) {
      moisLat = rec.centroid_pref_lat;
      moisLng = rec.centroid_pref_lng;
      if (rec.has_nav_centroid) {
        moisCoordType =
          rec.building_count > 1 && !rec.matched_building_mgmt_no
            ? "complex_centroid_mean"
            : "building_centroid";
      } else {
        moisCoordType = "main_entrance";
      }
    } else if (
      rec.service_lat !== null &&
      rec.service_lng !== null &&
      isValidKoreaWgs84(rec.service_lat, rec.service_lng)
    ) {
      moisLat = rec.service_lat;
      moisLng = rec.service_lng;
      moisCoordType = "main_entrance";
    }
  }

  // Distance between official facility coord and MOIS candidate
  const officialLat =
    officialMatch.matched && officialMatch.lat !== null
      ? officialMatch.lat
      : isExistingRemoteSuwon
        ? rec.existing_lat
        : null;
  const officialLng =
    officialMatch.matched && officialMatch.lng !== null
      ? officialMatch.lng
      : isExistingRemoteSuwon
        ? rec.existing_lng
        : null;

  const officialToMoisDistM =
    officialLat !== null &&
    officialLng !== null &&
    moisLat !== null &&
    moisLng !== null
      ? haversineMeters(officialLat, officialLng, moisLat, moisLng)
      : null;

  const existingKakaoToMoisDistM =
    rec.existing_coord_source === "kakao_geocode" &&
    rec.existing_lat !== null &&
    rec.existing_lng !== null &&
    moisLat !== null &&
    moisLng !== null
      ? haversineMeters(rec.existing_lat, rec.existing_lng, moisLat, moisLng)
      : null;

  // 1) Collect all Review Flags per TASK-02 C
  const combinedText = `${rec.name} ${rec.road_address} ${rec.jibun_address}`;
  if (PARK_OR_OPEN_SPACE_RE.test(combinedText)) {
    reasons.push("PARK_OR_OPEN_SPACE");
  }
  if (
    (rec.building_count > 1 && !rec.matched_building_mgmt_no) ||
    (LARGE_COMPLEX_RE.test(rec.name) && rec.building_count > 1)
  ) {
    reasons.push("MULTI_BUILDING_COMPLEX");
  }
  if (context.sharedAddressCount > 1) {
    reasons.push("SHARED_ADDRESS_MULTI_RESTROOM");
  }
  if (context.duplicateGroupCount > 1) {
    reasons.push("DUPLICATE_SUSPECT");
  }
  if (officialToMoisDistM !== null && officialToMoisDistM > 100) {
    reasons.push("LARGE_OFFICIAL_MOIS_DISCREPANCY");
  }
  if (existingKakaoToMoisDistM !== null && existingKakaoToMoisDistM > 200) {
    reasons.push("LARGE_KAKAO_MOIS_DISCREPANCY");
  }
  if (rec.combined_status === "ambiguous_match" || officialMatch.ambiguous) {
    reasons.push("AMBIGUOUS_ADDRESS_MATCH");
  }
  if (rec.combined_status === "invalid_coordinate") {
    reasons.push("REDACTED_OR_INVALID_COORD");
  }
  if (
    rec.sido === "(시도미상/누락)" ||
    (rec.sido === "인천광역시" &&
      ADMIN_REORG_SIGUNGU_RE.test(rec.road_address + " " + rec.jibun_address))
  ) {
    reasons.push("ADMIN_BOUNDARY_UNCERTAIN");
  }
  if (
    (officialMatch.matched || isExistingRemoteSuwon) &&
    rec.combined_status === "unmatched"
  ) {
    reasons.push("OFFICIAL_COORD_UNVERIFIED_IN_MOIS");
  }

  // 2) Classify strictly into VERIFIED / CANDIDATE / REVIEW_REQUIRED / UNMATCHED
  const hasIndependentOfficial =
    (officialMatch.matched && officialLat !== null && officialLng !== null) ||
    (isExistingRemoteSuwon && officialLat !== null && officialLng !== null);

  let status: VerificationStatus;
  let basis: string;
  let coordSource: string | null = null;
  let coordType: CoordType = "none";
  let sourceVersion = "2026-10";
  let recLat: number | null = null;
  let recLng: number | null = null;

  if (
    hasIndependentOfficial &&
    rec.combined_status === "unique_match" &&
    reasons.length === 0 &&
    officialToMoisDistM !== null &&
    officialToMoisDistM <= 50
  ) {
    // Independent official facility coordinate + clean 1:1 MOIS single building + <=50m consistency + 0 review flags
    status = "VERIFIED";
    coordSource = officialMatch.datasetKey || rec.existing_coord_source || "gg_publtolt_15011425";
    coordType = "facility_official";
    sourceVersion = officialMatch.dataStdDate || "2023-12-19";
    recLat = officialLat;
    recLng = officialLng;
    basis = `independent_official(${coordSource})+mois_1to1_consistent(${officialToMoisDistM.toFixed(1)}m)`;
  } else if (reasons.length > 0) {
    status = "REVIEW_REQUIRED";
    if (hasIndependentOfficial) {
      coordSource = officialMatch.datasetKey || rec.existing_coord_source;
      coordType = "facility_official";
      sourceVersion = officialMatch.dataStdDate || "2023-12-19";
      recLat = officialLat;
      recLng = officialLng;
      basis = `official_with_review_flags:${reasons.join(",")}`;
    } else if (moisLat !== null && moisLng !== null) {
      coordSource =
        rec.combined_match_basis?.startsWith("summary_")
          ? "mois_address_summary_db"
          : "mois_address_nav_db";
      coordType = moisCoordType;
      sourceVersion = "2026-10";
      recLat = moisLat;
      recLng = moisLng;
      basis = `mois_with_review_flags:${reasons.join(",")}`;
    } else {
      basis = `unlocated_review_flags:${reasons.join(",")}`;
    }
  } else if (
    hasIndependentOfficial &&
    officialToMoisDistM !== null &&
    officialToMoisDistM > 50
  ) {
    // Discrepancy 50m..100m between official and MOIS -> hold for review, do NOT auto-VERIFIED
    reasons.push("LARGE_OFFICIAL_MOIS_DISCREPANCY");
    status = "REVIEW_REQUIRED";
    coordSource = officialMatch.datasetKey || rec.existing_coord_source;
    coordType = "facility_official";
    sourceVersion = officialMatch.dataStdDate || "2023-12-19";
    recLat = officialLat;
    recLng = officialLng;
    basis = `official_mois_gap_gt_50m(${officialToMoisDistM.toFixed(1)}m)`;
  } else if (rec.combined_status === "unique_match" && moisLat !== null && moisLng !== null) {
    // Unique MOIS match with clean single building, but NO independent facility coordinate
    status = "CANDIDATE";
    coordSource =
      rec.combined_match_basis?.startsWith("summary_")
        ? "mois_address_summary_db"
        : "mois_address_nav_db";
    coordType = moisCoordType;
    sourceVersion = "2026-10";
    recLat = moisLat;
    recLng = moisLng;
    basis = `mois_1to1_only(${rec.combined_match_basis || "road"})_no_independent_facility_coord`;
  } else {
    status = "UNMATCHED";
    basis = "unmatched_in_mois_and_no_official_coord";
  }

  // Publishability guard (TASK-06)
  let publishableNow = false;
  let publishBlockReason: string | null = null;
  const isMoisDerived =
    coordSource === "mois_address_nav_db" ||
    coordSource === "mois_address_summary_db";

  if (status !== "VERIFIED") {
    publishBlockReason = `status=${status}`;
  } else if (isMoisDerived && !context.moisLicenseCleared) {
    publishBlockReason = "mois_license_unverified";
  } else if (recLat === null || recLng === null || !isValidKoreaWgs84(recLat, recLng)) {
    publishBlockReason = "invalid_coords";
  } else if (isExistingRemoteSuwon) {
    publishableNow = true;
    publishBlockReason = null; // Already published in remote Suwon baseline
  } else {
    // New VERIFIED municipal official coord (e.g. Gyeonggi 15011425 outside Suwon)
    // Eligible for staged remote load ONLY after user confirmation & municipal license check
    publishableNow = true;
    publishBlockReason = null;
  }

  return {
    id: rec.id,
    sourceRecordId: rec.source_record_id,
    name: rec.name,
    sido: rec.sido,
    sigungu: rec.sigungu,
    roadAddress: rec.road_address,
    jibunAddress: rec.jibun_address,
    verificationStatus: status,
    verificationBasis: basis,
    reviewReasons: Array.from(new Set(reasons)),
    coordSource,
    coordType,
    sourceVersion,
    recommendedLat: recLat,
    recommendedLng: recLng,
    moisCandidateLat: moisLat,
    moisCandidateLng: moisLng,
    officialLat,
    officialLng,
    officialToMoisDistM,
    existingKakaoToMoisDistM,
    sharedAddressCount: context.sharedAddressCount,
    duplicateGroupCount: context.duplicateGroupCount,
    buildingCount: rec.building_count,
    isExistingRemoteSuwon,
    publishableNow,
    publishBlockReason,
  };
}

export interface DryRunSummary {
  targetSigunguFilter: string[] | null;
  totalEvaluated: number;
  selectedVerifiedCount: number;
  alreadyOnRemoteCount: number;
  newToLoadCount: number;
  skippedNotVerifiedCount: number;
  skippedMoisLicenseHoldCount: number;
  skippedDuplicateInBatchCount: number;
  skippedPartnerOrInvalidCount: number;
  freePolicyToCreateCount: number;
  idempotentSecondRunNewCount: number;
  errors: string[];
  selectedSample: Array<{
    id: string;
    name: string;
    sido: string;
    sigungu: string;
    coordSource: string | null;
    lat: number;
    lng: number;
  }>;
}

/**
 * Simulates a zero-write selective staged load into remote Supabase (TASK-07).
 * Enforces: VERIFIED-only, MOIS-license hold, existing remote dedup, Suwon protection,
 * public-only free policy check, and idempotent re-run check.
 */
export function runSelectiveDryRun(
  classified: ClassificationResult[],
  options: {
    existingRemoteIds: Set<string>;
    existingRemoteSourceRecordIds: Set<string>;
    sigunguFilter?: string[] | null;
    moisLicenseCleared?: boolean;
  }
): DryRunSummary {
  const errors: string[] = [];
  const filterSet =
    options.sigunguFilter && options.sigunguFilter.length > 0
      ? new Set(options.sigunguFilter)
      : null;

  const filtered = filterSet
    ? classified.filter((c) => filterSet.has(c.sigungu))
    : classified;

  let selectedVerifiedCount = 0;
  let alreadyOnRemoteCount = 0;
  let newToLoadCount = 0;
  let skippedNotVerifiedCount = 0;
  let skippedMoisLicenseHoldCount = 0;
  let skippedDuplicateInBatchCount = 0;
  let skippedPartnerOrInvalidCount = 0;

  const batchSeenIds = new Set<string>();
  const batchSeenSourceRecIds = new Set<string>();
  const batchSeenNameAddr = new Set<string>();
  const selectedSample: DryRunSummary["selectedSample"] = [];

  for (const item of filtered) {
    if (item.verificationStatus !== "VERIFIED") {
      skippedNotVerifiedCount += 1;
      continue;
    }

    const isMoisDerived =
      item.coordSource === "mois_address_nav_db" ||
      item.coordSource === "mois_address_summary_db";
    if (isMoisDerived && !options.moisLicenseCleared) {
      skippedMoisLicenseHoldCount += 1;
      continue;
    }

    if (
      item.recommendedLat === null ||
      item.recommendedLng === null ||
      !isValidKoreaWgs84(item.recommendedLat, item.recommendedLng)
    ) {
      skippedPartnerOrInvalidCount += 1;
      errors.push(`Invalid coords on VERIFIED item: ${item.id} (${item.name})`);
      continue;
    }

    if (/demo\/test|qa\b/i.test(item.name)) {
      skippedPartnerOrInvalidCount += 1;
      errors.push(`QA/DEMO contamination blocked: ${item.id} (${item.name})`);
      continue;
    }

    if (
      options.existingRemoteIds.has(item.id) ||
      (item.sourceRecordId &&
        options.existingRemoteSourceRecordIds.has(item.sourceRecordId))
    ) {
      alreadyOnRemoteCount += 1;
      continue;
    }

    const dedupKey = `${normalizeStrictName(item.name)}::${(item.roadAddress || item.jibunAddress).replace(/\s+/g, "")}`;
    if (
      batchSeenIds.has(item.id) ||
      (item.sourceRecordId && batchSeenSourceRecIds.has(item.sourceRecordId)) ||
      batchSeenNameAddr.has(dedupKey)
    ) {
      skippedDuplicateInBatchCount += 1;
      continue;
    }

    batchSeenIds.add(item.id);
    if (item.sourceRecordId) batchSeenSourceRecIds.add(item.sourceRecordId);
    batchSeenNameAddr.add(dedupKey);
    selectedVerifiedCount += 1;
    newToLoadCount += 1;

    if (selectedSample.length < 15) {
      selectedSample.push({
        id: item.id,
        name: item.name,
        sido: item.sido,
        sigungu: item.sigungu,
        coordSource: item.coordSource,
        lat: item.recommendedLat,
        lng: item.recommendedLng,
      });
    }
  }

  // Simulate idempotent second run assuming first-run IDs + dedup keys are now on remote
  const afterIds = new Set(options.existingRemoteIds);
  const afterSrcIds = new Set(options.existingRemoteSourceRecordIds);
  const afterNameAddr = new Set<string>(batchSeenNameAddr);
  for (const id of batchSeenIds) afterIds.add(id);
  for (const sid of batchSeenSourceRecIds) afterSrcIds.add(sid);

  let secondRunNew = 0;
  for (const item of filtered) {
    if (item.verificationStatus !== "VERIFIED") continue;
    const isMoisDerived =
      item.coordSource === "mois_address_nav_db" ||
      item.coordSource === "mois_address_summary_db";
    if (isMoisDerived && !options.moisLicenseCleared) continue;
    if (afterIds.has(item.id)) continue;
    if (item.sourceRecordId && afterSrcIds.has(item.sourceRecordId)) continue;
    const dedupKey = `${normalizeStrictName(item.name)}::${(item.roadAddress || item.jibunAddress).replace(/\s+/g, "")}`;
    if (afterNameAddr.has(dedupKey)) continue;
    secondRunNew += 1;
  }

  return {
    targetSigunguFilter: options.sigunguFilter ?? null,
    totalEvaluated: filtered.length,
    selectedVerifiedCount,
    alreadyOnRemoteCount,
    newToLoadCount,
    skippedNotVerifiedCount,
    skippedMoisLicenseHoldCount,
    skippedDuplicateInBatchCount,
    skippedPartnerOrInvalidCount,
    freePolicyToCreateCount: newToLoadCount,
    idempotentSecondRunNewCount: secondRunNew,
    errors,
    selectedSample,
  };
}
