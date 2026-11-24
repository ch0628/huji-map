/**
 * Phase 3-A Pre-Publication Verification, License Governance,
 * Suwon 502 Protection, DB/API Compatibility, and Pilot Selection Library.
 *
 * Strictly local & read-only:
 * - Zero remote Supabase writes
 * - Zero Kakao API calls and zero Kakao coordinate inputs
 * - No new DB columns or UI components added
 */

import { isValidKoreaWgs84 } from "./lib";
import type { CoordType, VerificationStatus } from "./phase2-lib";
import type { ExposureTier } from "./phase25-lib";

export type LicenseReadinessStatus =
  | "CONFIRMED_NO_RESTRICTION"
  | "PORTAL_NO_RESTRICTION_WITH_TERMS_CONFLICT"
  | "UNCONFIRMED"
  | "PROHIBITED_FOR_DB_STORAGE";

export interface SourceLicenseRecord {
  datasetKey: string;
  dbCoordinateSource: string;
  provider: string;
  portalUrl: string | null;
  termsUrl: string | null;
  portalLicenseDisplay: string;
  status: LicenseReadinessStatus;
  usableForFacilityPinNow: boolean;
  usableForBuildingPinNow: boolean;
  blockingNotes: string;
  requiredUserDocuments: string[];
}

export const SOURCE_LICENSE_MATRIX: SourceLicenseRecord[] = [
  {
    datasetKey: "suwon_remote_export",
    dbCoordinateSource: "gg_publtolt_15011425",
    provider: "경기도 / 수원시",
    portalUrl: "https://www.data.go.kr/data/15011425/openapi.do",
    termsUrl: "https://data.gg.go.kr/portal/termsPolicyPage.do",
    portalLicenseDisplay: "공공데이터포털: 이용허락범위 제한 없음 (무료)",
    status: "PORTAL_NO_RESTRICTION_WITH_TERMS_CONFLICT",
    usableForFacilityPinNow: false,
    usableForBuildingPinNow: false,
    blockingNotes:
      "공공데이터포털 15011425는 '이용허락범위 제한 없음'이나, 경기데이터드림 일반 약관(termsPolicyPage.do) 제12조 ⑥항('명시적 승인 없이 상업적 사용 불가') 및 제14조 ②항 9호('사전 승낙 없이 영리행위 금지')가 잔존함. 기존 원격 수원 502건은 보존하되 신규 확대 적재 전 경기도 AI데이터행정과 서면/유권 확인 필요.",
    requiredUserDocuments: [
      "경기데이터드림(data.gg.go.kr) 공중화장실현황(15011425) 상용·영리 서비스 활용 가능 여부 서면 확인(경기도 AI데이터행정과 또는 경기데이터드림 Q&A 답변)",
      "서비스 내 출처 표시 문구 적용 확인 (제12조 ⑤항)",
    ],
  },
  {
    datasetKey: "gg_publtolt_15011425",
    dbCoordinateSource: "gg_publtolt_15011425",
    provider: "경기도",
    portalUrl: "https://www.data.go.kr/data/15011425/openapi.do",
    termsUrl: "https://data.gg.go.kr/portal/termsPolicyPage.do",
    portalLicenseDisplay: "공공데이터포털: 이용허락범위 제한 없음 (무료)",
    status: "PORTAL_NO_RESTRICTION_WITH_TERMS_CONFLICT",
    usableForFacilityPinNow: false,
    usableForBuildingPinNow: false,
    blockingNotes:
      "공공데이터포털 15011425('이용허락범위 제한 없음')와 경기데이터드림 약관 제12조 ⑥항·제14조 9호 문구 간 충돌 미해소.",
    requiredUserDocuments: [
      "경기도 AI데이터행정과(data.gg.go.kr) 상용/영리 활용 사전확인 회신서",
    ],
  },
  {
    datasetKey: "seoul_city_location",
    dbCoordinateSource: "seoul_public_toilet_info",
    provider: "서울특별시",
    portalUrl: "https://data.seoul.go.kr/dataList/OA-22586/S/1/datasetView.do",
    termsUrl: "https://data.seoul.go.kr",
    portalLicenseDisplay: "서울 열린데이터광장: 이용허락범위 제한 없음",
    status: "CONFIRMED_NO_RESTRICTION",
    usableForFacilityPinNow: true,
    usableForBuildingPinNow: false,
    blockingNotes:
      "포털상 '이용허락범위 제한 없음' 확인. 단, 서울 지역 확대 승인·원격 스키마(20261124000000) 적용·사람 위치 검증 완료 전까지 실제 적재 보류.",
    requiredUserDocuments: [
      "서울 열린데이터광장 출처 표기 문구 확정 ('출처: 서울특별시 / 서울 열린데이터광장')",
    ],
  },
  {
    datasetKey: "seoul_metro_2026",
    dbCoordinateSource: "seoul_metro_2026",
    provider: "서울교통공사",
    portalUrl: "https://www.data.go.kr/data/15044453/fileData.do",
    termsUrl: "https://www.data.go.kr/ugs/selectPortalPolicyView.do",
    portalLicenseDisplay: "공공데이터포털: 이용허락범위 제한 없음 (무료)",
    status: "CONFIRMED_NO_RESTRICTION",
    usableForFacilityPinNow: true,
    usableForBuildingPinNow: false,
    blockingNotes:
      "포털상 '이용허락범위 제한 없음' 확인. 단, 서울 지역 확대·원격 스키마(20261124000000) 적용·사람 위치 검증 선행 필요.",
    requiredUserDocuments: [
      "출처 표기 문구 확정 ('출처: 서울교통공사 / 공공데이터포털')",
    ],
  },
  {
    datasetKey: "incheon_michuhol_2026",
    dbCoordinateSource: "incheon_district_public_toilet",
    provider: "인천광역시 미추홀구",
    portalUrl: "https://www.data.go.kr/data/15071405/fileData.do",
    termsUrl: "https://www.data.go.kr/ugs/selectPortalPolicyView.do",
    portalLicenseDisplay: "공공데이터포털: 이용허락범위 제한 없음 (무료)",
    status: "CONFIRMED_NO_RESTRICTION",
    usableForFacilityPinNow: true,
    usableForBuildingPinNow: false,
    blockingNotes:
      "포털상 '이용허락범위 제한 없음' 확인. 단, 인천 지역 확대·원격 스키마(20261124000000) 적용·사람 위치 검증 선행 필요.",
    requiredUserDocuments: [
      "출처 표기 문구 확정 ('출처: 인천광역시 미추홀구 / 공공데이터포털')",
    ],
  },
  {
    datasetKey: "incheon_yeonsu_2025",
    dbCoordinateSource: "incheon_district_public_toilet",
    provider: "인천광역시 연수구",
    portalUrl: null,
    termsUrl: "https://www.data.go.kr/ugs/selectPortalPolicyView.do",
    portalLicenseDisplay: "개별 포털 데이터셋 직접 URL 미특정 (UNCONFIRMED)",
    status: "UNCONFIRMED",
    usableForFacilityPinNow: false,
    usableForBuildingPinNow: false,
    blockingNotes:
      "로컬 CSV 파일에 공공데이터포털 직접 ID 및 라이선스 증빙 URL이 미포함되어 있어 개별 URL 확인 전까지 UNCONFIRMED 유지.",
    requiredUserDocuments: [
      "인천광역시 연수구 공중 및 개방화장실(20250630) 공공데이터포털 원천 상세 URL 및 이용허락범위 캡처/확인",
    ],
  },
  {
    datasetKey: "public_restroom_standard_15012892",
    dbCoordinateSource: "public_csv_original",
    provider: "행정안전부 / 전국 지자체",
    portalUrl: "https://www.data.go.kr/data/15012892/standard.do",
    termsUrl: "https://www.data.go.kr/ugs/selectPortalPolicyView.do",
    portalLicenseDisplay: "공공데이터포털: 이용허락범위 제한 없음 (무료)",
    status: "CONFIRMED_NO_RESTRICTION",
    usableForFacilityPinNow: false,
    usableForBuildingPinNow: false,
    blockingNotes:
      "속성·주소 메타데이터 원천으로는 제한 없음이 확인되었으나, 최신 표준데이터에 좌표가 누락된 행이 많아 단독 좌표 원천(FACILITY_PIN)으로 사용하지 않음.",
    requiredUserDocuments: [],
  },
  {
    datasetKey: "mois_address_db",
    dbCoordinateSource: "mois_address_nav_db",
    provider: "행정안전부 / 한국지역정보개발원(KLID)",
    portalUrl: "https://business.juso.go.kr",
    termsUrl: null,
    portalLicenseDisplay: "승인 심사형 제공 데이터 (상용/웹공개/국외서버 조건 UNCONFIRMED)",
    status: "UNCONFIRMED",
    usableForFacilityPinNow: false,
    usableForBuildingPinNow: false,
    blockingNotes:
      "동봉 PDF에는 내부 활용DB 구축 방법만 안내되어 있으며, 상업적 공개 웹서비스 제공, 변환 좌표 DB 영구 저장, 국외 서버(현재 원격 Supabase 풀러 ap-southeast-2 시드니 리전) 저장 허용 여부, 출처/갱신 의무가 UNCONFIRMED임.",
    requiredUserDocuments: [
      "주소기반산업지원서비스(business.juso.go.kr) 위치정보요약DB·내비게이션용DB 활용신청서 및 승인내역서 원문",
      "주소기반산업지원서비스 이용약관 및 '주소정보 제공에 관한 규정'상 변환좌표 웹서비스 공개·국외서버 저장 허용 여부 확인서",
    ],
  },
  {
    datasetKey: "kakao_geocode",
    dbCoordinateSource: "kakao_geocode",
    provider: "Kakao Developers",
    portalUrl: "https://developers.kakao.com/docs/latest/ko/local/dev-guide",
    termsUrl: "https://developers.kakao.com/terms/latest/site-policies",
    portalLicenseDisplay: "DB 영구 저장 및 POI DB 구축 금지 (단기 캐시 1~2시간만 허용)",
    status: "PROHIBITED_FOR_DB_STORAGE",
    usableForFacilityPinNow: false,
    usableForBuildingPinNow: false,
    blockingNotes:
      "카카오 로컬 API 응답 좌표의 영구 DB 저장 금지 정책으로 핵심 분류·노출 파이프라인에서 완전 배제.",
    requiredUserDocuments: [],
  },
];

export const PHASE2_TO_DB_COORDINATE_SOURCE: Record<string, string> = {
  suwon_remote_export: "gg_publtolt_15011425",
  gg_publtolt_15011425: "gg_publtolt_15011425",
  seoul_city_location: "seoul_public_toilet_info",
  seoul_public_toilet_info: "seoul_public_toilet_info",
  seoul_metro_2026: "seoul_metro_2026",
  incheon_michuhol_2026: "incheon_district_public_toilet",
  incheon_yeonsu_2025: "incheon_district_public_toilet",
  incheon_district_public_toilet: "incheon_district_public_toilet",
  mois_address_nav_db: "mois_address_nav_db",
  mois_address_summary_db: "mois_address_summary_db",
};

export const REMOTE_20261122_ALLOWED_SOURCES: ReadonlySet<string> = new Set([
  "gg_publtolt_15011425",
  "kakao_geocode",
  "partner_kakao_js",
  "admin_manual",
  "public_csv_original",
  "other",
]);

export const MIGRATION_20261124_ALLOWED_SOURCES: ReadonlySet<string> = new Set([
  "gg_publtolt_15011425",
  "mois_address_nav_db",
  "mois_address_summary_db",
  "seoul_public_toilet_info",
  "seoul_metro_2026",
  "incheon_district_public_toilet",
  "kakao_geocode",
  "partner_kakao_js",
  "admin_manual",
  "public_csv_original",
  "other",
]);

const OFFICIAL_FACILITY_DB_SOURCES: ReadonlySet<string> = new Set([
  "gg_publtolt_15011425",
  "seoul_public_toilet_info",
  "seoul_metro_2026",
  "incheon_district_public_toilet",
  "admin_manual",
]);

const MOIS_BUILDING_DB_SOURCES: ReadonlySet<string> = new Set([
  "mois_address_nav_db",
  "mois_address_summary_db",
]);

export function mapPhase2SourceToDbSource(
  phase2Source: string | null
): string | null {
  if (!phase2Source) return null;
  return PHASE2_TO_DB_COORDINATE_SOURCE[phase2Source] ?? null;
}

/**
 * Resolves runtime map exposure tier from DB metadata WITHOUT adding a `display_tier` column,
 * preventing confusion between FACILITY_PIN (official facility source) and BUILDING_PIN (MOIS building source).
 */
export function resolveCompatibleExposureTier(
  row: {
    type: "public" | "partner";
    publication_status: string;
    latitude: number | null;
    longitude: number | null;
    coordinate_source: string | null;
    coordinate_type: CoordType | "geocoded" | "manual" | null;
    coordinate_verification_status: VerificationStatus | null;
  },
  options: {
    moisLicenseCleared?: boolean;
  } = {}
): {
  exposureTier: ExposureTier;
  blockReason: string | null;
} {
  if (row.publication_status !== "published") {
    return { exposureTier: "HIDDEN", blockReason: "not_published" };
  }
  if (
    row.latitude === null ||
    row.longitude === null ||
    !isValidKoreaWgs84(row.latitude, row.longitude)
  ) {
    return { exposureTier: "HIDDEN", blockReason: "invalid_coords" };
  }

  if (row.type === "partner") {
    if (row.coordinate_source === "kakao_geocode") {
      return { exposureTier: "HIDDEN", blockReason: "kakao_geocode_forbidden" };
    }
    return { exposureTier: "FACILITY_PIN", blockReason: null };
  }

  // Public restrooms: strictly enforce source + coordinate_type consistency
  if (!row.coordinate_source || row.coordinate_source === "kakao_geocode") {
    return { exposureTier: "HIDDEN", blockReason: "unverified_or_kakao_source" };
  }

  // Legacy Suwon 502 published rows (20261122 schema before 20261124 backfill)
  if (
    row.coordinate_type === null &&
    row.coordinate_source === "gg_publtolt_15011425"
  ) {
    return { exposureTier: "FACILITY_PIN", blockReason: null };
  }

  if (row.coordinate_type === "facility_official") {
    if (!OFFICIAL_FACILITY_DB_SOURCES.has(row.coordinate_source)) {
      return {
        exposureTier: "HIDDEN",
        blockReason: "source_mismatch_for_facility_pin",
      };
    }
    return { exposureTier: "FACILITY_PIN", blockReason: null };
  }

  if (
    row.coordinate_type === "building_centroid" ||
    row.coordinate_type === "main_entrance"
  ) {
    if (!MOIS_BUILDING_DB_SOURCES.has(row.coordinate_source)) {
      return {
        exposureTier: "HIDDEN",
        blockReason: "source_mismatch_for_building_pin",
      };
    }
    if (!options.moisLicenseCleared) {
      return {
        exposureTier: "HIDDEN",
        blockReason: "mois_license_unconfirmed",
      };
    }
    return { exposureTier: "BUILDING_PIN", blockReason: null };
  }

  // complex_centroid_mean, geocoded, manual without official source, etc.
  return { exposureTier: "HIDDEN", blockReason: "unsupported_coord_type" };
}

export interface SuwonProtectionAssessment {
  restroomId: string;
  name: string;
  exposureTier: ExposureTier;
  protectionAction: "PRESERVE_PUBLISHED";
  riskCategory:
    | "SAFE_FACILITY_PIN"
    | "SAME_BUILDING_SHARED_COORD"
    | "CRITICAL_OUTLIER_GT_300M"
    | "MODERATE_GAP_100_300M"
    | "SHARED_PARK_OR_COMPLEX_OFFICE_COPY"
    | "MOIS_REDACTED_OR_UNVERIFIED";
  correctionProposal: string;
}

export function assessSuwon502Row(row: {
  restroomId: string;
  name: string;
  exposureTier: ExposureTier;
  minBuildingDistM: number | null;
  baselineReviewReasons: string[];
}): SuwonProtectionAssessment {
  const reasons = new Set(row.baselineReviewReasons);

  if (row.exposureTier === "FACILITY_PIN") {
    return {
      restroomId: row.restroomId,
      name: row.name,
      exposureTier: row.exposureTier,
      protectionAction: "PRESERVE_PUBLISHED",
      riskCategory: "SAFE_FACILITY_PIN",
      correctionProposal: "현행 유지 (개별 건물/시설 좌표 정합 확인)",
    };
  }

  if (row.exposureTier === "BUILDING_PIN") {
    return {
      restroomId: row.restroomId,
      name: row.name,
      exposureTier: row.exposureTier,
      protectionAction: "PRESERVE_PUBLISHED",
      riskCategory: "SAME_BUILDING_SHARED_COORD",
      correctionProposal:
        "현행 유지 (공식좌표와 건물중심점 <=6m 일치하나 동일주소 다수 등록으로 BUILDING_PIN 분류; 중복 여부 추후 검수)",
    };
  }

  if (row.minBuildingDistM !== null && row.minBuildingDistM > 300) {
    return {
      restroomId: row.restroomId,
      name: row.name,
      exposureTier: row.exposureTier,
      protectionAction: "PRESERVE_PUBLISHED",
      riskCategory: "CRITICAL_OUTLIER_GT_300M",
      correctionProposal: `긴급 좌표 검수 제안: 공식좌표가 도로명주소 건물과 ${row.minBuildingDistM.toFixed(1)}m 괴리 — 현장/지도 대조 후 관리자 수동 보정 권장`,
    };
  }

  if (row.minBuildingDistM !== null && row.minBuildingDistM > 100) {
    return {
      restroomId: row.restroomId,
      name: row.name,
      exposureTier: row.exposureTier,
      protectionAction: "PRESERVE_PUBLISHED",
      riskCategory: "MODERATE_GAP_100_300M",
      correctionProposal: `위치 정밀도 검수 제안: 건물과 ${row.minBuildingDistM.toFixed(1)}m 이격 — 공원/대형건물 출입구 여부 확인 후 보정 검토`,
    };
  }

  if (
    reasons.has("REDACTED_OR_INVALID_COORD") ||
    reasons.has("OFFICIAL_COORD_UNVERIFIED_IN_MOIS") ||
    reasons.has("AMBIGUOUS_ADDRESS_MATCH")
  ) {
    return {
      restroomId: row.restroomId,
      name: row.name,
      exposureTier: row.exposureTier,
      protectionAction: "PRESERVE_PUBLISHED",
      riskCategory: "MOIS_REDACTED_OR_UNVERIFIED",
      correctionProposal:
        "자동 삭제 금지: 행안부 DB 미매칭/공개제한/모호 필지 사유이므로 기존 지자체 공식좌표 보존 후 로드뷰 확인 대상 편입",
    };
  }

  return {
    restroomId: row.restroomId,
    name: row.name,
    exposureTier: row.exposureTier,
    protectionAction: "PRESERVE_PUBLISHED",
    riskCategory: "SHARED_PARK_OR_COMPLEX_OFFICE_COPY",
    correctionProposal:
      "개별 좌표 분리 제안: 공원 관리사무소·복합단지 대표좌표 공유 의심 — 지자체 개별 시설 좌표 확보 전까지 현행 보존 후 순차 분리",
  };
}

export function buildStaticMapReviewLinks(
  name: string,
  lat: number | null,
  lng: number | null
): {
  kakaoMapLink: string;
  naverSearchLink: string;
  vworldLink: string;
} {
  if (lat === null || lng === null || !isValidKoreaWgs84(lat, lng)) {
    return { kakaoMapLink: "", naverSearchLink: "", vworldLink: "" };
  }
  const encName = encodeURIComponent(name || "화장실");
  return {
    kakaoMapLink: `https://map.kakao.com/link/map/${encName},${lat.toFixed(6)},${lng.toFixed(6)}`,
    naverSearchLink: `https://map.naver.com/p/search/${encName}?c=${lng.toFixed(6)},${lat.toFixed(6)},17,0,0,0,dh`,
    vworldLink: `https://map.vworld.kr/map/ws3dmap.do?x=${lng.toFixed(6)}&y=${lat.toFixed(6)}`,
  };
}
