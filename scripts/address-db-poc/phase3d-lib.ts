/**
 * Phase 3-D — Official-Data-Based Seoul Canary Release Policy & Gate Library.
 *
 * Strictly distinguishes:
 * - FIELD_VERIFIED: Independent human verification PASS on BOTH building location AND restroom existence/open status.
 * - OFFICIAL_SOURCE_VALIDATED: Passes all 9 automated OA-22586 official-source quality/policy checks
 *   (NO MOIS building coords, NO Kakao geocoding coords, KOGL Type 1 compliant), with `fieldVerified = false`.
 * - REVIEW_REQUIRED: Fails any official-source check, shows outlier/ambiguous/duplicate risk, or flagged FAIL by human.
 *
 * Never fabricates PASS or FIELD_VERIFIED for unreviewed items, and adds zero DB columns.
 */

import { haversineMeters } from "./lib";
import {
  isValidSeoulWgs84,
  type SeoulOaRawRecord,
  type SeoulPilotCandidateAuditRow,
  type SeoulPilotPolicyRow,
} from "./phase3b-lib";
import {
  buildSeoulKogl1Description,
  SEOUL_OA22586_KOGL1_SOURCE_CONFIG,
  type CanaryCheckOutcome,
  type CanaryReviewDecision,
  type Phase3cLoadPackage,
  type Phase3cRestroomRow,
  type RemoteRestroomRef,
} from "./phase3c-lib";

export type Phase3dValidationStatus =
  | "FIELD_VERIFIED"
  | "OFFICIAL_SOURCE_VALIDATED"
  | "REVIEW_REQUIRED";

export interface OfficialSourceCheckResult {
  isSeoulOa22586Source: boolean;
  hasKogl1LicenseAndAttribution: boolean;
  hasValidOfficialCoords: boolean;
  hasConsistentNameAddressGu: boolean;
  isPublicOpenCategory: boolean;
  hasOfficialOperatingHours: boolean;
  noRemoteOrOaDuplicateRisk: boolean;
  noOutlierAmbiguousOrComplexRisk: boolean;
  excludesMoisAndKakao: boolean;
  passedAll: boolean;
  failedChecks: string[];
}

export interface Phase3dEvaluatedCandidate {
  idx: number;
  restroomId: string;
  sourceRecordId: string;
  coordinateSourceRecordId: string;
  name: string;
  guName: string;
  roadAddress: string;
  addressDetail: string | null;
  latitude: number;
  longitude: number;
  validationStatus: Phase3dValidationStatus;
  fieldVerified: boolean;
  officialSourceValidated: boolean;
  approvedForPilot: boolean;
  officialValidationBasis: string;
  officialDescription: string;
  checks: OfficialSourceCheckResult;
  nearestOaNeighbor: {
    distM: number | null;
    seq: string;
    name: string;
    category: string;
  };
  nearestRemoteDistM: number | null;
  needsFieldConfirmationItems: string[];
  humanDecisionSummary: {
    buildingLocationResult: CanaryCheckOutcome;
    restroomExistenceOpenResult: CanaryCheckOutcome;
    notes: string;
  };
}

export interface Phase3dFinalLoadPackage {
  generatedAt: string;
  policyVersion: "phase3d_official_source_v1";
  pilotTarget: "seoul_oa22586";
  sourceVersion: string;
  sourceFileSha256: string;
  moisDependencyRemoved: true;
  kakaoCoordsExcluded: true;
  publicDataSource: typeof SEOUL_OA22586_KOGL1_SOURCE_CONFIG;
  counts: {
    inputCandidates: number;
    approvedTotal: number;
    officialSourceValidatedCount: number;
    fieldVerifiedCount: number;
    reviewRequiredExcludedCount: number;
    restrooms: number;
    policies: number;
    candidates: number;
    distinctGus: number;
  };
  restrooms: Phase3cRestroomRow[];
  restroomAccessPolicies: SeoulPilotPolicyRow[];
  restroomCoordinateCandidates: SeoulPilotCandidateAuditRow[];
  auditSummary: Array<{
    idx: number;
    restroomId: string;
    name: string;
    guName: string;
    validationStatus: Phase3dValidationStatus;
    fieldVerified: boolean;
    needsFieldConfirmationItems: string[];
  }>;
}

function normStrict(s: string): string {
  return (s || "").replace(/\s+/g, "").toLowerCase();
}

export function buildPhase3dVerificationBasis(
  validationStatus: Phase3dValidationStatus,
  fieldVerified: boolean,
  coordSourceRecordId: string
): string {
  const modeTag =
    validationStatus === "FIELD_VERIFIED"
      ? "POLICY=FIELD_VERIFIED|FIELD_VERIFIED=true"
      : validationStatus === "OFFICIAL_SOURCE_VALIDATED"
        ? "POLICY=OFFICIAL_SOURCE_VALIDATED|FIELD_VERIFIED=false"
        : "POLICY=REVIEW_REQUIRED|FIELD_VERIFIED=false";
  return `${modeTag}|source=seoul_public_toilet_info(${coordSourceRecordId})|oa22586_official_only`;
}

export function buildPhase3dOfficialDescription(
  oa: SeoulOaRawRecord,
  sourceVersion: string,
  datasetYear = "2026"
): string {
  const base = buildSeoulKogl1Description(oa, datasetYear);
  const closedDays = oa.siteUse
    .split("|")
    .map((s) => s.trim())
    .filter((s) => /토요일|일요일|공휴일/.test(s));
  const closureNote =
    closedDays.length > 0 ? `휴무안내(공식자료): ${closedDays.join("·")}` : "";
  const extraParts = [
    closureNote,
    `기준일: ${sourceVersion}`,
    "안내: 공식 공공데이터 기준 · 현장 직접 확인 미완료",
  ].filter(Boolean);
  const combined = `${base} / ${extraParts.join(" / ")}`;
  return combined.slice(0, 2000);
}

const ALLOWED_PUBLIC_SITE_TYPE_TOKENS = [
  "공공시설",
  "공원 및 하천변",
  "공중화장실",
  "체육시설",
  "교통시설",
];

function isAllowedPublicSiteType(siteType: string): boolean {
  const trimmed = siteType.trim();
  if (!trimmed) return false;
  return ALLOWED_PUBLIC_SITE_TYPE_TOKENS.some((token) => trimmed.includes(token));
}

function hasAmbiguousOrComplexRisk(
  r: Phase3cRestroomRow,
  oa: SeoulOaRawRecord | undefined
): string | null {
  if (!oa) return "missing_oa_raw_record";
  // Road address (or jibun fallback when road_address is absent in OA-22586) must include number token
  if (!/\d+/.test(r.road_address)) {
    return "road_address_missing_building_number";
  }
  if (/임시|이동식|공사중|철거|폐쇄|불가/.test(`${r.name} ${oa.openHours} ${oa.notes}`)) {
    return "temporary_or_closed_keyword";
  }
  if (/견인보관|견인차량보관/.test(`${r.name} ${oa.notes}`)) {
    return "restricted_or_unclear_public_access";
  }
  if (/일대|부근|인근/.test(`${r.road_address} ${oa.roadAddress} ${oa.jibunAddress}`)) {
    return "ambiguous_vicinity_address";
  }
  // Exclude private, underground subway complex, multi-tenant retail, medical interior, and unclear commercial site types
  if (!isAllowedPublicSiteType(oa.siteType)) {
    return `non_public_site_type:${oa.siteType.trim()}`;
  }
  return null;
}

export function evaluatePhase3dCanaryCandidates(params: {
  pkg: Phase3cLoadPackage;
  oaRecords: SeoulOaRawRecord[];
  remoteRows: RemoteRestroomRef[];
  humanDecisions: CanaryReviewDecision[];
  sourceVersion: string;
}): {
  evaluated: Phase3dEvaluatedCandidate[];
  finalPackage: Phase3dFinalLoadPackage;
} {
  const { pkg, oaRecords, remoteRows, humanDecisions, sourceVersion } = params;

  const oaBySeq = new Map(oaRecords.map((o) => [o.seq.trim(), o]));
  const decisionById = new Map(humanDecisions.map((d) => [d.restroomId, d]));

  // Count exact coords across all OA-22586 rows to detect ambiguous sharing
  const oaCoordCounts = new Map<string, number>();
  for (const o of oaRecords) {
    if (!isValidSeoulWgs84(o.lat, o.lng)) continue;
    const k = `${o.lat.toFixed(6)},${o.lng.toFixed(6)}`;
    oaCoordCounts.set(k, (oaCoordCounts.get(k) ?? 0) + 1);
  }

  const remoteIdSet = new Set(remoteRows.map((r) => r.id));
  const remoteSrcSet = new Set(
    remoteRows.map((r) => r.source_record_id).filter((v): v is string => Boolean(v))
  );
  const remoteNameSet = new Set(remoteRows.map((r) => normStrict(r.name)));

  const evaluated: Phase3dEvaluatedCandidate[] = [];

  pkg.restrooms.forEach((r, idxZero) => {
    const idx = idxZero + 1;
    const seq = r.coordinate_source_record_id.replace(/^SEOUL-LOC-/, "").trim();
    const oa = oaBySeq.get(seq);
    const dec = decisionById.get(r.id);

    const bRes: CanaryCheckOutcome = dec?.buildingLocationResult ?? "PENDING";
    const oRes: CanaryCheckOutcome = dec?.restroomExistenceOpenResult ?? "PENDING";
    const humanFieldVerified = bRes === "PASS" && oRes === "PASS";
    const humanFailed = bRes === "FAIL" || oRes === "FAIL";

    // Nearest neighbor inside ALL 4,547 OA-22586 records
    let nearestOa: { distM: number | null; seq: string; name: string; category: string } = {
      distM: null,
      seq: "",
      name: "",
      category: "",
    };
    for (const o of oaRecords) {
      const oSeq = o.seq.trim();
      if (!oSeq || oSeq === seq) continue;
      if (!isValidSeoulWgs84(o.lat, o.lng)) continue;
      const d = haversineMeters(r.latitude, r.longitude, o.lat, o.lng);
      if (nearestOa.distM === null || d < nearestOa.distM) {
        nearestOa = {
          distM: Number(d.toFixed(1)),
          seq: oSeq,
          name: o.buildingName,
          category: o.categoryType,
        };
      }
    }

    // Nearest neighbor & overlap against ALL remote rows
    let nearestRemoteDistM: number | null = null;
    let hasRemoteOverlap =
      remoteIdSet.has(r.id) ||
      remoteSrcSet.has(r.source_record_id) ||
      remoteNameSet.has(normStrict(r.name));
    for (const rr of remoteRows) {
      const sameSeoulSource = rr.coordinate_source === "seoul_public_toilet_info";
      if (!sameSeoulSource && rr.road_address && normStrict(rr.road_address) === normStrict(r.road_address)) {
        hasRemoteOverlap = true;
      }
      if (rr.latitude == null || rr.longitude == null) continue;
      const d = haversineMeters(r.latitude, r.longitude, rr.latitude, rr.longitude);
      if (nearestRemoteDistM === null || d < nearestRemoteDistM) {
        nearestRemoteDistM = Number(d.toFixed(1));
      }
      const proximityThresholdM = sameSeoulSource ? 50 : 200;
      if (d < proximityThresholdM) hasRemoteOverlap = true;
    }

    const coordKey = `${r.latitude.toFixed(6)},${r.longitude.toFixed(6)}`;
    const isSeoulOa22586Source =
      r.coordinate_source === "seoul_public_toilet_info" &&
      r.coordinate_source_record_id.startsWith("SEOUL-LOC-") &&
      Boolean(oa);

    const hasKogl1LicenseAndAttribution =
      Boolean(pkg.publicDataSource.licenseName?.includes("공공누리 제1유형")) &&
      Boolean(pkg.publicDataSource.attributionText?.includes("서울특별시")) &&
      Boolean(pkg.publicDataSource.attributionText?.includes("OA-22586")) &&
      Boolean(r.description?.includes("공공누리 제1유형"));

    const hasValidOfficialCoords =
      r.coordinate_type === "facility_official" &&
      isValidSeoulWgs84(r.latitude, r.longitude);

    const expectedOaPrimaryAddr = oa
      ? oa.roadAddress.trim() || oa.jibunAddress.trim() || `서울특별시 ${oa.guName.trim()}`
      : "";
    const hasConsistentNameAddressGu =
      Boolean(oa) &&
      normStrict(r.name) === normStrict(oa!.buildingName) &&
      r.gu_name.trim() === oa!.guName.trim() &&
      r.road_address.includes(r.gu_name.trim()) &&
      normStrict(r.road_address) === normStrict(expectedOaPrimaryAddr);

    const isPublicOpenCategory =
      r.oa_category_type.trim() === "공공개방|" &&
      oa?.categoryType.trim() === "공공개방|";

    const hasOfficialOperatingHours =
      Boolean(oa?.openHours.trim()) &&
      !/미정|확인불가|없음|영업시작~종료/.test(oa!.openHours) &&
      Boolean(r.description?.includes("개방시간:"));

    const noRemoteOrOaDuplicateRisk =
      !hasRemoteOverlap &&
      (oaCoordCounts.get(coordKey) ?? 0) === 1 &&
      (nearestOa.distM === null || nearestOa.distM >= 50);

    const complexRisk = hasAmbiguousOrComplexRisk(r, oa);
    const noOutlierAmbiguousOrComplexRisk = complexRisk === null;

    const excludesMoisAndKakao =
      !["mois_address_nav_db", "mois_address_summary_db", "kakao_geocode"].includes(
        r.coordinate_source
      ) &&
      pkg.moisDependencyRemoved === true &&
      !r.coordinate_verification_basis.includes("mois_1to1");

    const failedChecks: string[] = [];
    if (!isSeoulOa22586Source) failedChecks.push("isSeoulOa22586Source");
    if (!hasKogl1LicenseAndAttribution) failedChecks.push("hasKogl1LicenseAndAttribution");
    if (!hasValidOfficialCoords) failedChecks.push("hasValidOfficialCoords");
    if (!hasConsistentNameAddressGu) failedChecks.push("hasConsistentNameAddressGu");
    if (!isPublicOpenCategory) failedChecks.push("isPublicOpenCategory");
    if (!hasOfficialOperatingHours) failedChecks.push("hasOfficialOperatingHours");
    if (!noRemoteOrOaDuplicateRisk) failedChecks.push("noRemoteOrOaDuplicateRisk");
    if (!noOutlierAmbiguousOrComplexRisk) {
      failedChecks.push(`noOutlierAmbiguousOrComplexRisk(${complexRisk})`);
    }
    if (!excludesMoisAndKakao) failedChecks.push("excludesMoisAndKakao");

    const passedAll = failedChecks.length === 0;

    let validationStatus: Phase3dValidationStatus;
    if (humanFieldVerified && passedAll) {
      validationStatus = "FIELD_VERIFIED";
    } else if (humanFailed || !passedAll) {
      validationStatus = "REVIEW_REQUIRED";
    } else {
      validationStatus = "OFFICIAL_SOURCE_VALIDATED";
    }

    const approvedForPilot =
      validationStatus === "FIELD_VERIFIED" ||
      validationStatus === "OFFICIAL_SOURCE_VALIDATED";

    const needsFieldConfirmationItems: string[] = [];
    if (!humanFieldVerified) {
      needsFieldConfirmationItems.push(
        "실제 화장실 출입구 위치 및 외부 안내표지판 유무 (로드뷰·현장)"
      );
      if (oa && !oa.openHours.includes("평일") && !oa.siteUse.includes("토요일")) {
        needsFieldConfirmationItems.push(
          `주말/공휴일 개방 여부 확인 (공식 원천 '${oa.openHours.replace(/\|/g, "")}'에 요일 미명기)`
        );
      } else {
        needsFieldConfirmationItems.push("현장 실제 개방시간 일치 여부");
      }
      if (r.wheelchair_accessible === null) {
        needsFieldConfirmationItems.push(
          "장애인화장실 설치·이용 가능 여부 (공식 원천 공란)"
        );
      }
      if (nearestOa.distM !== null && nearestOa.distM < 100) {
        needsFieldConfirmationItems.push(
          `인근 ${nearestOa.distM}m 시설('${nearestOa.name}')과 입구 혼동 여부 확인`
        );
      }
    }

    const officialDescription = oa
      ? buildPhase3dOfficialDescription(oa, sourceVersion, "2026")
      : r.description || "";
    const officialValidationBasis = buildPhase3dVerificationBasis(
      validationStatus,
      humanFieldVerified,
      r.coordinate_source_record_id
    );

    evaluated.push({
      idx,
      restroomId: r.id,
      sourceRecordId: r.source_record_id,
      coordinateSourceRecordId: r.coordinate_source_record_id,
      name: r.name,
      guName: r.gu_name,
      roadAddress: r.road_address,
      addressDetail: r.address_detail,
      latitude: r.latitude,
      longitude: r.longitude,
      validationStatus,
      fieldVerified: humanFieldVerified,
      officialSourceValidated: passedAll,
      approvedForPilot,
      officialValidationBasis,
      officialDescription,
      checks: {
        isSeoulOa22586Source,
        hasKogl1LicenseAndAttribution,
        hasValidOfficialCoords,
        hasConsistentNameAddressGu,
        isPublicOpenCategory,
        hasOfficialOperatingHours,
        noRemoteOrOaDuplicateRisk,
        noOutlierAmbiguousOrComplexRisk,
        excludesMoisAndKakao,
        passedAll,
        failedChecks,
      },
      nearestOaNeighbor: nearestOa,
      nearestRemoteDistM,
      needsFieldConfirmationItems,
      humanDecisionSummary: {
        buildingLocationResult: bRes,
        restroomExistenceOpenResult: oRes,
        notes: dec?.notes ?? "",
      },
    });
  });

  const approvedMap = new Map(
    evaluated.filter((e) => e.approvedForPilot).map((e) => [e.restroomId, e])
  );

  const approvedRestrooms: Phase3cRestroomRow[] = pkg.restrooms
    .filter((r) => approvedMap.has(r.id))
    .map((r) => {
      const ev = approvedMap.get(r.id)!;
      return {
        ...r,
        description: ev.officialDescription,
        coordinate_verification_status: "VERIFIED",
        coordinate_verification_basis: ev.officialValidationBasis,
        coordinate_source_version: sourceVersion,
      };
    });

  const approvedPolicies = pkg.restroomAccessPolicies.filter((p) =>
    approvedMap.has(p.restroom_id)
  );
  const approvedCandidates = pkg.restroomCoordinateCandidates
    .filter((c) => approvedMap.has(c.restroom_id))
    .map((c) => {
      const ev = approvedMap.get(c.restroom_id)!;
      return {
        ...c,
        source_version: sourceVersion,
        verification_basis: ev.officialValidationBasis,
      };
    });

  const officialSourceValidatedCount = evaluated.filter(
    (e) => e.validationStatus === "OFFICIAL_SOURCE_VALIDATED"
  ).length;
  const fieldVerifiedCount = evaluated.filter(
    (e) => e.validationStatus === "FIELD_VERIFIED"
  ).length;
  const reviewRequiredExcludedCount = evaluated.filter(
    (e) => e.validationStatus === "REVIEW_REQUIRED"
  ).length;

  return {
    evaluated,
    finalPackage: {
      generatedAt: new Date().toISOString(),
      policyVersion: "phase3d_official_source_v1",
      pilotTarget: "seoul_oa22586",
      sourceVersion,
      sourceFileSha256: pkg.sourceFileSha256,
      moisDependencyRemoved: true,
      kakaoCoordsExcluded: true,
      publicDataSource: SEOUL_OA22586_KOGL1_SOURCE_CONFIG,
      counts: {
        inputCandidates: evaluated.length,
        approvedTotal: approvedRestrooms.length,
        officialSourceValidatedCount,
        fieldVerifiedCount,
        reviewRequiredExcludedCount,
        restrooms: approvedRestrooms.length,
        policies: approvedPolicies.length,
        candidates: approvedCandidates.length,
        distinctGus: new Set(approvedRestrooms.map((r) => r.gu_name)).size,
      },
      restrooms: approvedRestrooms,
      restroomAccessPolicies: approvedPolicies,
      restroomCoordinateCandidates: approvedCandidates,
      auditSummary: evaluated.map((e) => ({
        idx: e.idx,
        restroomId: e.restroomId,
        name: e.name,
        guName: e.guName,
        validationStatus: e.validationStatus,
        fieldVerified: e.fieldVerified,
        needsFieldConfirmationItems: e.needsFieldConfirmationItems,
      })),
    },
  };
}
