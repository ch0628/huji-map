import type {
  CoordinateSource,
  PublicDataSourceSummary,
  PublicRestroomDetail,
} from "./types";

export type AmenityTriState = "available" | "unavailable" | "unknown";

export interface NormalizedAmenityDisplay {
  readonly state: AmenityTriState;
  readonly label: string;
}

export interface NormalizedPublicHoursInfo {
  /** Parsed official operating hours text (never invents missing weekdays). */
  readonly summaryText: string | null;
  /** True when an opening-hours string exists but cannot be structured safely. */
  readonly needsReview: boolean;
  /** Raw opening-hours text when unparsed or preserved for verification. */
  readonly rawHoursText: string | null;
  /** Closed days / holiday note extracted from official metadata. */
  readonly closedDaysText: string | null;
}

export interface NormalizedPublicSourceInfo {
  readonly providerName: string | null;
  readonly datasetName: string | null;
  readonly licenseName: string | null;
  readonly licenseUrl: string | null;
  readonly sourceUrl: string | null;
  readonly attributionText: string | null;
  readonly baseDate: string | null;
}

export interface NormalizedPublicMetadata {
  readonly operating: NormalizedPublicHoursInfo;
  readonly managingAgency: string | null;
  readonly contactPhone: string | null;
  readonly source: NormalizedPublicSourceInfo;
  /** Unstructured leftover text from description that is not duplicated in structured sections. */
  readonly additionalNote: string | null;
}

/**
 * Strictly maps boolean | null | undefined to tri-state display metadata.
 * Never treats null/undefined as false ("없음").
 */
export function resolveAmenityDisplay(
  value: boolean | null | undefined,
  labels: {
    readonly available: string;
    readonly unavailable: string;
    readonly unknown?: string;
  }
): NormalizedAmenityDisplay {
  if (value === true) {
    return { state: "available", label: labels.available };
  }
  if (value === false) {
    return { state: "unavailable", label: labels.unavailable };
  }
  return { state: "unknown", label: labels.unknown ?? "미확인" };
}

function padHour(hourStr: string): string {
  const n = Number.parseInt(hourStr, 10);
  if (!Number.isFinite(n) || n < 0 || n > 24) return hourStr;
  return String(n).padStart(2, "0");
}

function normalizeTimeRangeSegment(rawSegment: string): string | null {
  const cleaned = rawSegment
    .trim()
    .replace(/(\d{1,2}):\.(\d{2})/g, "$1:$2")
    .replace(/^매\s+/, "");

  // Match optional Korean day prefix + time range:
  // Examples:
  //   "09:00~18:00", "7:00~23:00", "09:00 - 21:00", "09~18시",
  //   "평일 09:00~18:00", "주말 07:00 - 21:00", "토요일09:00~13:00"
  const match =
    /^(?:(평일|주말|토요일|일요일|공휴일|월~금|월~토)\s*)?(\d{1,2})(?::(\d{2}))?\s*[~-]\s*(\d{1,2})(?::(\d{2}))?\s*시?$/.exec(
      cleaned
    );

  if (!match) {
    return null;
  }

  const dayPrefix = match[1]?.trim() ?? "";
  const h1 = Number.parseInt(match[2], 10);
  const m1 = match[3] ? Number.parseInt(match[3], 10) : 0;
  const h2 = Number.parseInt(match[4], 10);
  const m2 = match[5] ? Number.parseInt(match[5], 10) : 0;

  if (
    !Number.isInteger(h1) ||
    !Number.isInteger(m1) ||
    !Number.isInteger(h2) ||
    !Number.isInteger(m2) ||
    h1 < 0 ||
    h1 > 24 ||
    h2 < 0 ||
    h2 > 24 ||
    m1 < 0 ||
    m1 > 59 ||
    m2 < 0 ||
    m2 > 59
  ) {
    return null;
  }

  const formattedRange = `${padHour(String(h1))}:${String(m1).padStart(2, "0")}~${padHour(
    String(h2)
  )}:${String(m2).padStart(2, "0")}`;

  return dayPrefix ? `${dayPrefix} ${formattedRange}` : formattedRange;
}

function normalizeClosedDaysValue(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const tokens = raw
    .split(/[|·,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const joined = tokens.join("·");
  if (/(휴무|제외|미개방)$/.test(joined)) {
    return joined;
  }
  return `${joined} 휴무`;
}

function mergeClosedDays(a: string | null, b: string | null): string | null {
  const parts = [a, b].filter((v): v is string => Boolean(v && v.trim()));
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  if (parts[0] === parts[1]) return parts[0];
  return `${parts[0]} · ${parts[1]}`;
}

/**
 * Conservatively parses official opening-hours and closure strings.
 * - "정시(09:00~18:00,평일)" -> "평일 09:00~18:00"
 * - "정시(09:00~18:00)" -> "09:00~18:00" (never guesses weekdays)
 * - "09:00~18:00" -> "09:00~18:00"
 * - "평일 09:00~18:00(매주 월요일 휴무)" -> summaryText="평일 09:00~18:00", closedDaysText="매주 월요일 휴무"
 * - "상시" -> "상시 (공식 자료 기준)"
 * - Unparseable formats (e.g. "20시간", "공연시간 1시간 전후", "미개방", "미정") -> needsReview=true, rawHoursText preserved
 */
export function parseOfficialOperatingHours(
  rawOpenHours: string | null | undefined,
  rawClosedDays?: string | null | undefined
): NormalizedPublicHoursInfo {
  const explicitClosed = normalizeClosedDaysValue(rawClosedDays);
  const trimmed = rawOpenHours?.trim() ?? "";

  if (!trimmed) {
    return {
      summaryText: null,
      needsReview: false,
      rawHoursText: null,
      closedDaysText: explicitClosed,
    };
  }

  // Handle Seoul OA-22586 wrapper: "정시(09:00~18:00,평일)" or "정시(09:00~18:00)"
  const jeongsiMatch = /^정시\(([^)]+)\)$/.exec(trimmed);
  if (jeongsiMatch) {
    const innerParts = jeongsiMatch[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const timePart = innerParts.find((p) => /\d/.test(p)) ?? "";
    const dayPart = innerParts.find((p) => !/\d/.test(p)) ?? "";
    const candidate = dayPart ? `${dayPart} ${timePart}` : timePart;
    const normalized = normalizeTimeRangeSegment(candidate);
    if (normalized) {
      return {
        summaryText: normalized,
        needsReview: false,
        rawHoursText: null,
        closedDaysText: explicitClosed,
      };
    }
  }

  if (trimmed === "상시") {
    return {
      summaryText: "상시 (공식 자료 기준)",
      needsReview: false,
      rawHoursText: null,
      closedDaysText: explicitClosed,
    };
  }

  // Extract trailing parenthetical closure/holiday note e.g. "(매주 월요일 휴무)" or "(공휴일 제외)"
  let mainPart = trimmed;
  let parenClosed: string | null = null;
  const parenMatch = /^(.+?)\(([^)]+)\)$/.exec(trimmed);
  if (parenMatch) {
    const inside = parenMatch[2].trim();
    if (/휴무|제외|폐쇄/.test(inside)) {
      mainPart = parenMatch[1].trim();
      parenClosed = inside;
    }
  }

  const closedDaysText = mergeClosedDays(explicitClosed, parenClosed);

  // Single time range
  const singleNormalized = normalizeTimeRangeSegment(mainPart);
  if (singleNormalized) {
    return {
      summaryText: singleNormalized,
      needsReview: false,
      rawHoursText: null,
      closedDaysText,
    };
  }

  // Multi-segment schedule separated by "," or "/" (e.g. "평일 7:00~23:00, 주말 7:00~21:00")
  if (/[,/]/.test(mainPart)) {
    const segments = mainPart
      .split(/[,/]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const normalizedSegments = segments.map(normalizeTimeRangeSegment);
    if (
      normalizedSegments.length >= 2 &&
      normalizedSegments.every((s): s is string => s !== null)
    ) {
      return {
        summaryText: normalizedSegments.join(" · "),
        needsReview: false,
        rawHoursText: null,
        closedDaysText,
      };
    }
  }

  // Unparseable format (e.g., "20시간", "공연시간 1시간 전후", "미개방", "미정")
  return {
    summaryText: null,
    needsReview: true,
    rawHoursText: trimmed,
    closedDaysText,
  };
}

function cleanAgencyAndPhone(
  rawAgency: string | null,
  rawPhone: string | null
): { managingAgency: string | null; contactPhone: string | null } {
  const phone = rawPhone?.trim() || null;
  let agency = rawAgency?.trim() || null;

  if (agency && phone) {
    const escapedPhone = phone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Remove duplicate phone embedded at end of managing agency (e.g. "자양2동주민센터(02-450-1511)" or "답십리1동 주민센터 - 02-2171-6227")
    const stripped = agency
      .replace(new RegExp(`\\s*\\(${escapedPhone}\\)\\s*$`), "")
      .replace(new RegExp(`\\s*[-·]?\\s*${escapedPhone}\\s*$`), "")
      .trim();
    if (stripped) {
      agency = stripped;
    }
  }

  return { managingAgency: agency, contactPhone: phone };
}

function inferDefaultSourceFromMetadata(params: {
  coordinateSource?: CoordinateSource | null;
  rawAttribution?: string | null;
  dataSource?: PublicDataSourceSummary | null;
}): Omit<NormalizedPublicSourceInfo, "baseDate"> {
  const ds = params.dataSource ?? null;
  const rawAttr = params.rawAttribution?.trim() ?? "";

  if (ds) {
    const isSeoulOa =
      params.coordinateSource === "seoul_public_toilet_info" ||
      ds.dataset_name?.includes("OA-22586") ||
      ds.source_url?.includes("OA-22586") ||
      false;
    const isDataGoKrSuwonOrGg =
      !isSeoulOa &&
      (ds.source_url?.includes("15012892") ||
        ds.source_url?.includes("15011425") ||
        params.coordinateSource === "gg_publtolt_15011425");

    // Both data.go.kr 15012892 and 15011425 state "이용허락범위 제한 없음" rather than KOGL Type 1;
    // normalize stale DB KOGL labels in presentation without mutating remote DB metadata.
    const rawLicense = ds.license_name?.trim() || null;
    const normalizedLicenseName =
      isDataGoKrSuwonOrGg && rawLicense?.includes("공공누리")
        ? "이용허락범위 제한 없음"
        : rawLicense;
    const normalizedLicenseUrl =
      isDataGoKrSuwonOrGg && rawLicense?.includes("공공누리")
        ? "https://www.data.go.kr/ugs/selectPortalPolicyView.do"
        : ds.license_url || null;

    return {
      providerName: ds.provider_name || null,
      datasetName: ds.dataset_name || null,
      licenseName: normalizedLicenseName,
      licenseUrl: normalizedLicenseUrl,
      sourceUrl: ds.source_url || null,
      attributionText: ds.attribution_text || rawAttr || null,
    };
  }

  if (
    params.coordinateSource === "seoul_public_toilet_info" ||
    rawAttr.includes("OA-22586")
  ) {
    return {
      providerName: "서울특별시",
      datasetName: "서울시 공중화장실 위치정보 (OA-22586)",
      licenseName: "공공누리 제1유형 (출처표시)",
      licenseUrl: "https://www.kogl.or.kr/info/licenseType1.do",
      sourceUrl: "https://data.seoul.go.kr/dataList/OA-22586/S/1/datasetView.do",
      attributionText:
        "본 서비스는 '서울특별시'에서 '2026년' 작성하여 공공누리 제1유형으로 개방한 '서울시 공중화장실 위치정보(OA-22586)'를 서울 열린데이터광장(https://data.seoul.go.kr/dataList/OA-22586/S/1/datasetView.do)에서 무료로 내려받아 이용하였습니다.",
    };
  }

  if (params.coordinateSource === "gg_publtolt_15011425") {
    return {
      providerName: "경기도",
      datasetName: "경기도 공중화장실 현황 (Publtolt / 15011425)",
      licenseName: null,
      licenseUrl: null,
      sourceUrl: "https://www.data.go.kr/data/15011425/openapi.do",
      attributionText:
        rawAttr ||
        "출처: 경기도 / 경기데이터드림(data.gg.go.kr) 공중화장실 현황(15011425)",
    };
  }

  if (rawAttr) {
    const hasKogl1 = rawAttr.includes("공공누리 제1유형");
    return {
      providerName: null,
      datasetName: null,
      licenseName: hasKogl1 ? "공공누리 제1유형 (출처표시)" : null,
      licenseUrl: hasKogl1 ? "https://www.kogl.or.kr/info/licenseType1.do" : null,
      sourceUrl: null,
      attributionText: rawAttr,
    };
  }

  return {
    providerName: null,
    datasetName: null,
    licenseName: null,
    licenseUrl: null,
    sourceUrl: null,
    attributionText: null,
  };
}

/**
 * Normalizes public restroom description & source metadata into structured UI sections
 * without mutating or losing raw DB information.
 */
export function normalizePublicRestroomMetadata(
  restroom: Pick<
    PublicRestroomDetail,
    | "type"
    | "description"
    | "last_verified_at"
    | "source_id"
    | "coordinate_source"
    | "data_source"
  >
): NormalizedPublicMetadata {
  const rawDesc = restroom.description?.trim() ?? "";

  let rawOpenHours: string | null = null;
  let rawAgency: string | null = null;
  let rawPhone: string | null = null;
  let rawClosedDays: string | null = null;
  let rawAttribution: string | null = null;
  let rawBaseDate: string | null = null;
  const unparsedNotes: string[] = [];

  if (rawDesc) {
    // Structured public metadata segments are separated by " / " (spaces around slash).
    // Note: Time schedules like "평일09:00~18:00/토요일09:00~13:00" have no spaces around "/".
    const segments = rawDesc
      .split(/\s+\/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    for (const seg of segments) {
      if (seg.startsWith("개방시간:")) {
        rawOpenHours = seg.slice("개방시간:".length).trim() || null;
      } else if (seg.startsWith("관리:")) {
        rawAgency = seg.slice("관리:".length).trim() || null;
      } else if (seg.startsWith("전화:")) {
        rawPhone = seg.slice("전화:".length).trim() || null;
      } else if (seg.startsWith("연락처:")) {
        rawPhone = seg.slice("연락처:".length).trim() || null;
      } else if (seg.startsWith("휴무안내(공식자료):")) {
        rawClosedDays = seg.slice("휴무안내(공식자료):".length).trim() || null;
      } else if (seg.startsWith("휴무안내:")) {
        rawClosedDays = seg.slice("휴무안내:".length).trim() || null;
      } else if (seg.startsWith("출처:")) {
        rawAttribution = seg.slice("출처:".length).trim() || null;
      } else if (seg.startsWith("기준일:")) {
        rawBaseDate = seg.slice("기준일:".length).trim() || null;
      } else if (seg.startsWith("안내:")) {
        const noticeVal = seg.slice("안내:".length).trim();
        // Suppress retired/redundant unverified-notice suffix from raw description
        if (
          noticeVal &&
          !/공식\s*공공데이터\s*기준\s*·\s*현장\s*(?:직접\s*)?확인\s*미완료/.test(
            noticeVal
          ) &&
          !/공식\s*자료\s*기준\s*·\s*실제\s*개방\s*여부\s*미확인/.test(noticeVal)
        ) {
          unparsedNotes.push(noticeVal);
        }
      } else {
        unparsedNotes.push(seg);
      }
    }
  }

  const operating = parseOfficialOperatingHours(rawOpenHours, rawClosedDays);
  const { managingAgency, contactPhone } = cleanAgencyAndPhone(
    rawAgency,
    rawPhone
  );
  const baseDate =
    rawBaseDate ||
    (restroom.last_verified_at ? restroom.last_verified_at.slice(0, 10) : null);

  const sourceCore = inferDefaultSourceFromMetadata({
    coordinateSource: restroom.coordinate_source,
    rawAttribution,
    dataSource: restroom.data_source,
  });

  return {
    operating,
    managingAgency,
    contactPhone,
    source: {
      ...sourceCore,
      baseDate,
    },
    additionalNote: unparsedNotes.length > 0 ? unparsedNotes.join(" / ") : null,
  };
}
