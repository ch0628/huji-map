import fs from "node:fs";
import path from "node:path";
import type {
  AddressGeocoder,
  GeocodeFatalStopReason,
  GeocodeResult,
  GeocoderStats,
} from "./types";

const KAKAO_ADDRESS_SEARCH_URL = "https://dapi.kakao.com/v2/local/search/address.json";
export const DEFAULT_DAILY_GEOCODE_LIMIT = 30000;
export const DEFAULT_MIN_DELAY_MS = 100;

export interface KakaoGeocoderOptions {
  apiKey?: string;
  cachePath?: string | null;
  usagePath?: string | null;
  dailyLimit?: number;
  maxCallsPerRun?: number;
  minDelayMs?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
  nowFn?: () => Date;
}

interface DailyUsageRecord {
  date: string;
  httpCalls: number;
  cacheHits: number;
  successCount: number;
  notFoundCount: number;
  uncertainCount: number;
  errorCount: number;
  rateLimitedCount: number;
  updatedAt: string;
}

interface KakaoAddressDoc {
  address_name?: string;
  address_type?: string;
  x?: string;
  y?: string;
  address?: {
    address_name?: string;
    region_1depth_name?: string;
    region_2depth_name?: string;
    region_3depth_name?: string;
  } | null;
  road_address?: {
    address_name?: string;
    region_1depth_name?: string;
    region_2depth_name?: string;
    road_name?: string;
    main_building_no?: string;
  } | null;
}

const DUMMY_ADDRESS_EXACT_RE =
  /^(?:없음|부여불가|해당없음|미상|미정|주소없음|미기재|미입력|null|none|n\/a|na|-+|\.+)$/i;

const FULL_PROVINCE_STICKY_RE =
  /^(서울특별시|부산광역시|대구광역시|인천광역시|광주광역시|대전광역시|울산광역시|세종특별자치시|전남광주통합특별시|경기도|강원특별자치도|강원도|충청북도|충청남도|전북특별자치도|전라북도|전라남도|경상북도|경상남도|제주특별자치도)(?=[가-힣])/;

const AMBIGUOUS_SIGUNGU_TOKENS = new Set([
  "중구",
  "동구",
  "서구",
  "남구",
  "북구",
  "강서구",
  "고성군",
]);

const NON_ADMIN_SIGUNGU_WORDS = new Set([
  "특별시",
  "광역시",
  "특별자치시",
  "통합특별시",
  "자치시",
  "도시",
  "시가지",
  "시청",
  "군청",
  "구청",
  "출입구",
  "입구",
  "출구",
  "지구",
  "공구",
  "관리구",
  "상가",
  "주차장",
]);

export interface GeocodeExpectedContext {
  roadAddress?: string | null;
  jibunAddress?: string | null;
  agency?: string | null;
}

/**
 * Returns true if an address string is empty or a known non-address placeholder.
 */
export function isDummyAddress(address: string | null | undefined): boolean {
  const trimmed = (address || "").replace(/\s+/g, " ").trim();
  if (!trimmed) return true;
  if (DUMMY_ADDRESS_EXACT_RE.test(trimmed)) return true;
  return !/[가-힣A-Za-z0-9]/.test(trimmed);
}

/**
 * Normalizes confirmed province typos and missing spaces after full province suffixes.
 */
export function normalizeAddressText(address: string): string {
  let normalized = address.replace(/\s+/g, " ").trim();
  if (!normalized) return "";

  normalized = normalized
    .replace(/^서을특별시(?=\s|$)/, "서울특별시")
    .replace(/^부산광역\s+시(?=\s|$)/, "부산광역시")
    .replace(/^경상붓도(?=\s|$)/, "경상북도")
    .replace(/^경상북(?=\s)/, "경상북도")
    .replace(/^경상님도(?=\s|$)/, "경상남도")
    .replace(FULL_PROVINCE_STICKY_RE, "$1 ");

  return normalized.replace(/\s+/g, " ").trim();
}

/**
 * Strips parenthetical remarks and trailing comma details for fallback address lookup.
 */
function stripAddressNotes(address: string): string {
  return address
    .replace(/\([^)]*\)/g, " ")
    .replace(/,.*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Builds raw (pre-normalization) ordered candidates for backward-compatible cache lookup.
 */
function buildRawAddressQueryCandidates(
  roadAddress: string,
  jibunAddress: string
): string[] {
  const candidates: string[] = [];
  const pushUnique = (val: string) => {
    const trimmed = val.trim();
    if (trimmed && !candidates.includes(trimmed)) {
      candidates.push(trimmed);
    }
  };
  if (roadAddress) {
    pushUnique(roadAddress);
    pushUnique(stripAddressNotes(roadAddress));
  }
  if (jibunAddress) {
    pushUnique(jibunAddress);
    pushUnique(stripAddressNotes(jibunAddress));
  }
  return candidates;
}

/**
 * Builds ordered, deduplicated address query candidates from road and jibun addresses.
 * Excludes dummy placeholder values ("없음", "부여불가", etc.) and normalizes spacing/typos.
 */
export function buildAddressQueryCandidates(
  roadAddress: string,
  jibunAddress: string
): string[] {
  const candidates: string[] = [];
  const pushUnique = (val: string) => {
    const trimmed = val.replace(/\s+/g, " ").trim();
    if (!isDummyAddress(trimmed) && !candidates.includes(trimmed)) {
      candidates.push(trimmed);
    }
  };

  if (!isDummyAddress(roadAddress)) {
    const normRoad = normalizeAddressText(roadAddress);
    pushUnique(normRoad);
    pushUnique(stripAddressNotes(normRoad));
  }
  if (!isDummyAddress(jibunAddress)) {
    const normJibun = normalizeAddressText(jibunAddress);
    pushUnique(normJibun);
    pushUnique(stripAddressNotes(normJibun));
  }

  return candidates;
}

const PROVINCE_ALIASES: Array<[RegExp, string]> = [
  [/^(서울특별시|서울시|서울)(?:\s|$)/, "서울"],
  [/^(부산광역시|부산시|부산)(?:\s|$)/, "부산"],
  [/^(대구광역시|대구시|대구)(?:\s|$)/, "대구"],
  [/^(인천광역시|인천시|인천)(?:\s|$)/, "인천"],
  [/^(전남광주통합특별시)(?:\s|$)/, "전남광주통합"],
  [/^(광주광역시|광주시|광주)(?:\s|$)/, "광주"],
  [/^(대전광역시|대전시|대전)(?:\s|$)/, "대전"],
  [/^(울산광역시|울산시|울산)(?:\s|$)/, "울산"],
  [/^(세종특별자치시|세종시|세종)(?:\s|$)/, "세종"],
  [/^(경기도|경기)(?:\s|$)/, "경기"],
  [/^(강원특별자치도|강원도|강원)(?:\s|$)/, "강원"],
  [/^(충청북도|충북)(?:\s|$)/, "충북"],
  [/^(충청남도|충남)(?:\s|$)/, "충남"],
  [/^(전북특별자치도|전라북도|전북)(?:\s|$)/, "전북"],
  [/^(전라남도|전남)(?:\s|$)/, "전남"],
  [/^(경상북도|경북)(?:\s|$)/, "경북"],
  [/^(경상남도|경남)(?:\s|$)/, "경남"],
  [/^(제주특별자치도|제주도|제주)(?:\s|$)/, "제주"],
];

export function normalizeProvinceToken(text: string): string | null {
  const normalized = normalizeAddressText(text);
  if (!normalized) return null;
  for (const [pattern, canonical] of PROVINCE_ALIASES) {
    if (pattern.test(normalized)) {
      return canonical;
    }
  }
  return null;
}

export function areProvincesCompatible(
  provA: string | null | undefined,
  provB: string | null | undefined
): boolean {
  if (!provA || !provB) return false;
  if (provA === provB) return true;
  if (provA === "전남광주통합" && (provB === "전남" || provB === "광주")) {
    return true;
  }
  if (provB === "전남광주통합" && (provA === "전남" || provA === "광주")) {
    return true;
  }
  return false;
}

function stripLeadingProvince(text: string): {
  province: string | null;
  rest: string;
} {
  const normalized = normalizeAddressText(text);
  if (!normalized) return { province: null, rest: "" };
  for (const [pattern, canonical] of PROVINCE_ALIASES) {
    const m = normalized.match(pattern);
    if (m) {
      return {
        province: canonical,
        rest: normalized.slice(m[0].length).trim(),
      };
    }
  }
  return { province: null, rest: normalized };
}

function pushValidSigungu(list: string[], candidate: string): void {
  if (
    candidate.length >= 2 &&
    !NON_ADMIN_SIGUNGU_WORDS.has(candidate) &&
    !list.includes(candidate)
  ) {
    list.push(candidate);
  }
}

function extractSigunguTokensFromAddress(address: string): string[] {
  if (isDummyAddress(address)) return [];
  const { province, rest } = stripLeadingProvince(address);
  if (!rest) return [];

  const tokens = rest.split(/\s+/);
  const sigungus: string[] = [];

  for (let i = 0; i < Math.min(2, tokens.length); i++) {
    const tok = tokens[i];
    if (/^[가-힣]{1,5}(?:시|군|구)$/.test(tok)) {
      pushValidSigungu(sigungus, tok);
    } else if (province) {
      // Handle rare sticky city/gu + road name after a valid province (e.g. 성산구원이대로450)
      const sticky = tok.match(/^([가-힣]{1,4}(?:시|군|구))[가-힣0-9]+(?:대로|로|길)/);
      if (sticky) {
        pushValidSigungu(sigungus, sticky[1]);
      }
      break;
    } else {
      break;
    }
  }

  return sigungus;
}

function extractAgencyRegionHint(agency: string | null | undefined): {
  province: string | null;
  sigungus: string[];
} {
  const trimmed = normalizeAddressText(agency || "");
  if (!trimmed) return { province: null, sigungus: [] };

  const { province, rest } = stripLeadingProvince(trimmed);
  const sigungus: string[] = [];

  const re =
    /(?:^|[\s(])([가-힣]{1,5}(?:시|군|구))(?:청|시설관리공단|도시관리공단|도시공사)?(?=[\s()]|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(rest)) !== null) {
    pushValidSigungu(sigungus, match[1]);
  }

  return { province, sigungus };
}

const REORG_GU_GROUPS: Array<{ province: string; groups: Set<string>[] }> = [
  {
    province: "인천",
    groups: [
      new Set(["중구", "영종구", "제물포구"]),
      new Set(["동구", "제물포구"]),
      new Set(["서구", "서해구", "검단구"]),
    ],
  },
  {
    province: "경기",
    groups: [new Set(["원미구", "소사구", "오정구", "부천시"])],
  },
];

function areSingleSigunguTokensCompatible(
  a: string,
  b: string,
  province: string | null
): boolean {
  if (a === b) return true;
  if (province) {
    for (const rule of REORG_GU_GROUPS) {
      if (rule.province !== province) continue;
      if (rule.groups.some((g) => g.has(a) && g.has(b))) {
        return true;
      }
    }
  }
  return false;
}

function areSigunguListsCompatible(
  expected: string[],
  resolved: string[],
  province: string | null
): boolean {
  if (expected.length === 0) return true;
  if (resolved.length === 0) {
    return province === "세종";
  }

  const expectedGus = expected.filter((t) => t.endsWith("구"));
  const resolvedGus = resolved.filter((t) => t.endsWith("구"));

  // If both specify a 구 (district), at least one 구 pair must be compatible
  if (expectedGus.length > 0 && resolvedGus.length > 0) {
    return expectedGus.some((eg) =>
      resolvedGus.some((rg) => areSingleSigunguTokensCompatible(eg, rg, province))
    );
  }

  return expected.some((et) =>
    resolved.some((rt) => areSingleSigunguTokensCompatible(et, rt, province))
  );
}

export interface RegionAssessment {
  valid: boolean;
  reason?: string;
  expectedProv: string | null;
  expectedSigungus: string[];
  hasPhysicalAnchor: boolean;
}

/**
 * Cross-validates road address, jibun address, and managing agency to determine
 * a trustworthy expected province/sigungu context before or after Kakao lookup.
 */
export function assessExpectedRegionContext(
  context: string | GeocodeExpectedContext
): RegionAssessment {
  const ctx: GeocodeExpectedContext =
    typeof context === "string"
      ? { roadAddress: context, jibunAddress: "", agency: "" }
      : context;

  const cleanRoad = !isDummyAddress(ctx.roadAddress)
    ? normalizeAddressText(ctx.roadAddress || "")
    : "";
  const cleanJibun = !isDummyAddress(ctx.jibunAddress)
    ? normalizeAddressText(ctx.jibunAddress || "")
    : "";
  const agencyHint = extractAgencyRegionHint(ctx.agency);

  if (!cleanRoad && !cleanJibun) {
    return {
      valid: false,
      reason: "유효한 도로명/지번 주소가 없습니다.",
      expectedProv: null,
      expectedSigungus: [],
      hasPhysicalAnchor: false,
    };
  }

  const roadProv = cleanRoad ? normalizeProvinceToken(cleanRoad) : null;
  const jibunProv = cleanJibun ? normalizeProvinceToken(cleanJibun) : null;

  if (roadProv && jibunProv && !areProvincesCompatible(roadProv, jibunProv)) {
    return {
      valid: false,
      reason: `원천 도로명(${roadProv})과 지번(${jibunProv})의 시·도가 서로 일치하지 않습니다.`,
      expectedProv: null,
      expectedSigungus: [],
      hasPhysicalAnchor: false,
    };
  }

  const roadSigungus = cleanRoad ? extractSigunguTokensFromAddress(cleanRoad) : [];
  const jibunSigungus = cleanJibun ? extractSigunguTokensFromAddress(cleanJibun) : [];
  const physicalProv = roadProv || jibunProv || null;

  if (
    !physicalProv &&
    roadSigungus.length > 0 &&
    jibunSigungus.length > 0 &&
    !areSigunguListsCompatible(roadSigungus, jibunSigungus, null)
  ) {
    return {
      valid: false,
      reason: `원천 도로명(${roadSigungus.join(" ")})과 지번(${jibunSigungus.join(" ")})의 시·군·구가 서로 일치하지 않습니다.`,
      expectedProv: null,
      expectedSigungus: [],
      hasPhysicalAnchor: false,
    };
  }

  const physicalSigungus = Array.from(new Set([...roadSigungus, ...jibunSigungus]));

  // When road/jibun omit province and agency explicitly specifies a conflicting sigungu, reject
  if (
    !physicalProv &&
    physicalSigungus.length > 0 &&
    agencyHint.sigungus.length > 0 &&
    !areSigunguListsCompatible(physicalSigungus, agencyHint.sigungus, agencyHint.province)
  ) {
    return {
      valid: false,
      reason: `원천 주소(${physicalSigungus.join(" ")})와 관리기관(${agencyHint.sigungus.join(" ")})의 지역이 서로 충돌합니다.`,
      expectedProv: null,
      expectedSigungus: [],
      hasPhysicalAnchor: false,
    };
  }

  const expectedProv = physicalProv || agencyHint.province || null;
  const expectedSigungus =
    physicalSigungus.length > 0 ? physicalSigungus : agencyHint.sigungus;

  // Reject unanchored addresses lacking both province and unambiguous sigungu
  const hasUnambiguousSigungu = expectedSigungus.some(
    (s) => !AMBIGUOUS_SIGUNGU_TOKENS.has(s)
  );
  if (!expectedProv && !hasUnambiguousSigungu) {
    return {
      valid: false,
      reason:
        "시·도 또는 고유한 시·군·구 정보가 없어 타 지역 오변환 위험으로 불확실(uncertain) 처리합니다.",
      expectedProv: null,
      expectedSigungus,
      hasPhysicalAnchor: false,
    };
  }

  return {
    valid: true,
    expectedProv,
    expectedSigungus,
    hasPhysicalAnchor: true,
  };
}

function extractResolvedRegion(doc: KakaoAddressDoc): {
  province: string | null;
  sigungus: string[];
} {
  const depth1 =
    doc.road_address?.region_1depth_name ||
    doc.address?.region_1depth_name ||
    doc.address_name ||
    "";
  const province = normalizeProvinceToken(depth1) || normalizeProvinceToken(doc.address_name || "");

  const sigungus: string[] = [];
  const depth2Candidates = [
    doc.road_address?.region_2depth_name,
    doc.address?.region_2depth_name,
  ];
  for (const d2 of depth2Candidates) {
    if (!d2) continue;
    for (const part of d2.trim().split(/\s+/)) {
      if (/^[가-힣]{1,5}(?:시|군|구)$/.test(part)) {
        pushValidSigungu(sigungus, part);
      }
    }
  }

  const addrCandidates = [
    doc.road_address?.address_name,
    doc.address?.address_name,
    doc.address_name,
  ];
  for (const a of addrCandidates) {
    if (!a) continue;
    for (const s of extractSigunguTokensFromAddress(a)) {
      pushValidSigungu(sigungus, s);
    }
  }

  return { province, sigungus };
}

/**
 * Validates whether a Kakao address document has precise, reliable coordinates.
 * Rejects broad REGION-only centroids, out-of-Korea coordinates, unanchored addresses,
 * and cross-province/cross-sigungu mismatches while preserving reorganized districts.
 */
export function evaluateKakaoDocument(
  doc: KakaoAddressDoc,
  cityFilter?: string | null,
  expectedAddress?: string | GeocodeExpectedContext | null
): { valid: boolean; latitude?: number; longitude?: number; reason?: string } {
  const addressType = (doc.address_type || "").toUpperCase();
  if (addressType === "REGION") {
    return {
      valid: false,
      reason: "행정동/지역 단위 대표 좌표(REGION)만 반환되어 위치가 불확실합니다.",
    };
  }

  const lat = doc.y ? parseFloat(doc.y) : NaN;
  const lng = doc.x ? parseFloat(doc.x) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { valid: false, reason: "유효하지 않은 위도/경도 값입니다." };
  }

  if (lat <= 30 || lat >= 45 || lng <= 120 || lng >= 135) {
    return { valid: false, reason: "대한민국 좌표 범위를 벗어났습니다." };
  }

  if (cityFilter) {
    const cityToken = cityFilter.replace(/시$/, "").trim();
    const resolvedRegions = [
      doc.address_name,
      doc.address?.address_name,
      doc.address?.region_2depth_name,
      doc.road_address?.address_name,
      doc.road_address?.region_2depth_name,
    ]
      .filter(Boolean)
      .join(" ");

    if (cityToken && !resolvedRegions.includes(cityToken)) {
      return {
        valid: false,
        reason: `변환된 주소(${doc.address_name || "미상"})가 대상 지역(${cityFilter})과 일치하지 않습니다.`,
      };
    }
  } else if (expectedAddress) {
    const assessment = assessExpectedRegionContext(expectedAddress);
    if (!assessment.valid) {
      return { valid: false, reason: assessment.reason };
    }

    const resolved = extractResolvedRegion(doc);
    if (assessment.expectedProv) {
      if (
        !resolved.province ||
        !areProvincesCompatible(assessment.expectedProv, resolved.province)
      ) {
        return {
          valid: false,
          reason: `변환된 시·도(${resolved.province || "미상"})가 원천 주소(${assessment.expectedProv})와 일치하지 않습니다.`,
        };
      }
    }

    if (
      assessment.expectedSigungus.length > 0 &&
      !areSigunguListsCompatible(
        assessment.expectedSigungus,
        resolved.sigungus,
        assessment.expectedProv || resolved.province
      )
    ) {
      return {
        valid: false,
        reason: `변환된 시·군·구(${resolved.sigungus.join(" ") || "미상"})가 원천 주소(${assessment.expectedSigungus.join(" ")})와 일치하지 않습니다.`,
      };
    }
  }

  return { valid: true, latitude: lat, longitude: lng };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getKstDateString(now: Date): string {
  const kstMs = now.getTime() + 9 * 60 * 60 * 1000;
  return new Date(kstMs).toISOString().slice(0, 10);
}

function writeJsonAtomic(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

/**
 * Creates a Kakao Local Address Search geocoder with:
 * - in-memory & atomic file caching (including legacy city-prefixed cache reuse)
 * - daily & per-run HTTP call quota persistence
 * - global QPS spacing (default 100ms)
 * - immediate stop on quota exhaustion, HTTP 429, or 401/403 auth errors
 */
export function createKakaoAddressGeocoder(
  options: KakaoGeocoderOptions = {}
): AddressGeocoder {
  const restKey = process.env.KAKAO_REST_API_KEY?.trim();
  const resolvedKey = options.apiKey?.trim() || restKey;

  if (!resolvedKey) {
    throw new Error(
      "카카오 REST API 키가 설정되지 않았습니다. .env.local에 KAKAO_REST_API_KEY를 설정해 주세요."
    );
  }

  const fetchFn = options.fetchImpl ?? fetch;
  const nowFn = options.nowFn ?? (() => new Date());
  const minDelayMs = Math.max(0, options.minDelayMs ?? DEFAULT_MIN_DELAY_MS);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 500);
  const dailyLimit = Math.max(
    1,
    options.dailyLimit ?? DEFAULT_DAILY_GEOCODE_LIMIT
  );
  const maxCallsPerRun =
    options.maxCallsPerRun !== undefined && options.maxCallsPerRun > 0
      ? options.maxCallsPerRun
      : Infinity;

  const cachePath = options.cachePath
    ? path.resolve(process.cwd(), options.cachePath)
    : null;
  const usagePath = options.usagePath
    ? path.resolve(process.cwd(), options.usagePath)
    : null;

  const memoryCache = new Map<string, GeocodeResult>();
  const addressFallbackCache = new Map<string, GeocodeResult>();

  if (cachePath && fs.existsSync(cachePath)) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(cachePath, "utf8")
      ) as Record<string, GeocodeResult>;
      for (const [k, v] of Object.entries(parsed)) {
        if (v && typeof v === "object" && "status" in v) {
          memoryCache.set(k, v);
          if (v.status === "success") {
            const sepIdx = k.indexOf("::");
            const addrPart = sepIdx >= 0 ? k.slice(sepIdx + 2) : k;
            if (addrPart && !addressFallbackCache.has(addrPart)) {
              addressFallbackCache.set(addrPart, v);
            }
          }
        }
      }
    } catch {
      // Ignore corrupt cache and rebuild
    }
  }

  let currentDate = getKstDateString(nowFn());
  let todayHttpCalls = 0;
  let runHttpCalls = 0;
  let cacheHits = 0;
  let successCount = 0;
  let notFoundCount = 0;
  let uncertainCount = 0;
  let errorCount = 0;
  let rateLimitedCount = 0;
  let fatalStopReason: GeocodeFatalStopReason | null = null;
  let fatalStopMessage: string | null = null;

  if (usagePath && fs.existsSync(usagePath)) {
    try {
      const saved = JSON.parse(
        fs.readFileSync(usagePath, "utf8")
      ) as Partial<DailyUsageRecord>;
      if (saved.date === currentDate && typeof saved.httpCalls === "number") {
        todayHttpCalls = Math.max(0, saved.httpCalls);
      }
    } catch {
      // Ignore corrupt usage file
    }
  }

  function rolloverDayIfNeeded(): void {
    const today = getKstDateString(nowFn());
    if (today !== currentDate) {
      currentDate = today;
      todayHttpCalls = 0;
      if (fatalStopReason === "quota_exceeded" && runHttpCalls < maxCallsPerRun) {
        fatalStopReason = null;
        fatalStopMessage = null;
      }
    }
  }

  let rateQueue: Promise<void> = Promise.resolve();
  let lastHttpStartedAt = 0;

  async function acquireHttpSlot(): Promise<
    | { allowed: true }
    | { allowed: false; reason: string; fatalStopReason: GeocodeFatalStopReason }
  > {
    const prev = rateQueue;
    let release!: () => void;
    rateQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      rolloverDayIfNeeded();

      if (fatalStopReason) {
        return {
          allowed: false,
          reason: fatalStopMessage || "카카오 API 호출이 제한되어 중단되었습니다.",
          fatalStopReason,
        };
      }

      if (todayHttpCalls >= dailyLimit) {
        fatalStopReason = "quota_exceeded";
        fatalStopMessage = `금일 카카오 API 호출 상한(${dailyLimit.toLocaleString()}건)에 도달했습니다.`;
        return {
          allowed: false,
          reason: fatalStopMessage,
          fatalStopReason,
        };
      }

      if (runHttpCalls >= maxCallsPerRun) {
        fatalStopReason = "quota_exceeded";
        fatalStopMessage = `이번 실행의 카카오 API 호출 상한(${maxCallsPerRun.toLocaleString()}건)에 도달했습니다.`;
        return {
          allowed: false,
          reason: fatalStopMessage,
          fatalStopReason,
        };
      }

      if (minDelayMs > 0 && lastHttpStartedAt > 0) {
        const elapsed = Date.now() - lastHttpStartedAt;
        if (elapsed < minDelayMs) {
          await sleep(minDelayMs - elapsed);
        }
      }
      lastHttpStartedAt = Date.now();
      todayHttpCalls++;
      runHttpCalls++;
      return { allowed: true };
    } finally {
      release();
    }
  }

  const inflight = new Map<string, Promise<GeocodeResult>>();

  async function queryKakaoOnce(query: string): Promise<{
    ok: boolean;
    httpStatus: number;
    documents: KakaoAddressDoc[];
    errorReason?: string;
    fatalStopReason?: GeocodeFatalStopReason;
  }> {
    const headers: Record<string, string> = {
      Authorization: `KakaoAK ${resolvedKey}`,
    };

    const url = `${KAKAO_ADDRESS_SEARCH_URL}?query=${encodeURIComponent(query)}&size=5`;

    for (let attempt = 0; attempt < 2; attempt++) {
      const slot = await acquireHttpSlot();
      if (!slot.allowed) {
        return {
          ok: false,
          httpStatus: slot.fatalStopReason === "auth_error" ? 401 : 429,
          documents: [],
          errorReason: slot.reason,
          fatalStopReason: slot.fatalStopReason,
        };
      }

      const res = await fetchFn(url, { headers });

      if (res.status === 401 || res.status === 403) {
        fatalStopReason = "auth_error";
        fatalStopMessage = `카카오 REST API 인증/권한 오류(HTTP ${res.status}). KAKAO_REST_API_KEY 및 카카오 로컬 API 활성 상태를 확인해 주세요.`;
        return {
          ok: false,
          httpStatus: res.status,
          documents: [],
          errorReason: fatalStopMessage,
          fatalStopReason,
        };
      }

      if (res.status === 429) {
        rateLimitedCount++;
        if (attempt === 0) {
          if (retryDelayMs > 0) await sleep(retryDelayMs);
          continue;
        }
        fatalStopReason = "rate_limited";
        fatalStopMessage = "카카오 API 호출량 제한(HTTP 429)에 도달하여 캐시·체크포인트를 저장하고 중단합니다.";
        return {
          ok: false,
          httpStatus: 429,
          documents: [],
          errorReason: fatalStopMessage,
          fatalStopReason,
        };
      }

      if (res.status >= 500) {
        if (attempt === 0) {
          if (retryDelayMs > 0) await sleep(retryDelayMs);
          continue;
        }
        return {
          ok: false,
          httpStatus: res.status,
          documents: [],
          errorReason: `카카오 주소 검색 서버 오류 (HTTP ${res.status})`,
        };
      }

      if (!res.ok) {
        return {
          ok: false,
          httpStatus: res.status,
          documents: [],
          errorReason: `카카오 주소 검색 API 오류 (HTTP ${res.status})`,
        };
      }

      const json = (await res.json()) as { documents?: KakaoAddressDoc[] };
      return {
        ok: true,
        httpStatus: res.status,
        documents: Array.isArray(json.documents) ? json.documents : [],
      };
    }

    return {
      ok: false,
      httpStatus: 500,
      documents: [],
      errorReason: "카카오 주소 검색 API 재시도 초과",
    };
  }

  async function lookupCandidates(
    candidates: string[],
    cityFilter: string | null | undefined,
    expectedContext: GeocodeExpectedContext
  ): Promise<GeocodeResult> {
    let lastUncertainReason: string | undefined;
    let preAssessment: RegionAssessment | null = null;

    if (!cityFilter) {
      preAssessment = assessExpectedRegionContext(expectedContext);
      if (!preAssessment.valid) {
        return {
          status: "uncertain",
          latitude: null,
          longitude: null,
          queryUsed: candidates[0] || null,
          reason: preAssessment.reason,
        };
      }
    }

    for (const query of candidates) {
      const resp = await queryKakaoOnce(query);
      if (!resp.ok) {
        return {
          status: "error",
          latitude: null,
          longitude: null,
          queryUsed: query,
          reason: resp.errorReason,
          fatalStopReason: resp.fatalStopReason,
        };
      }

      if (resp.documents.length === 0) {
        continue;
      }

      const validMatches: Array<{
        doc: KakaoAddressDoc;
        latitude: number;
        longitude: number;
        resolvedProvince: string | null;
      }> = [];

      for (const doc of resp.documents) {
        const check = evaluateKakaoDocument(doc, cityFilter, expectedContext);
        if (check.valid && check.latitude !== undefined && check.longitude !== undefined) {
          validMatches.push({
            doc,
            latitude: check.latitude,
            longitude: check.longitude,
            resolvedProvince: extractResolvedRegion(doc).province,
          });
        } else if (check.reason) {
          lastUncertainReason = check.reason;
        }
      }

      if (validMatches.length > 0) {
        // When source omitted province, ensure Kakao candidates don't span conflicting provinces
        if (!cityFilter && preAssessment && !preAssessment.expectedProv) {
          const firstProv = validMatches[0].resolvedProvince;
          const hasConflictingProv = validMatches.some(
            (m) =>
              m.resolvedProvince &&
              firstProv &&
              !areProvincesCompatible(firstProv, m.resolvedProvince)
          );
          if (hasConflictingProv) {
            lastUncertainReason =
              "시·도 생략 주소에 대해 복수 시·도 후보가 검색되어 위치가 불확실합니다.";
            continue;
          }
        }

        const chosen = validMatches[0];
        return {
          status: "success",
          latitude: chosen.latitude,
          longitude: chosen.longitude,
          matchedAddress: chosen.doc.address_name || null,
          addressType: chosen.doc.address_type || null,
          queryUsed: query,
        };
      }
    }

    if (lastUncertainReason) {
      return {
        status: "uncertain",
        latitude: null,
        longitude: null,
        queryUsed: candidates[0] || null,
        reason: lastUncertainReason,
      };
    }

    return {
      status: "not_found",
      latitude: null,
      longitude: null,
      queryUsed: candidates[0] || null,
      reason: "카카오 주소 검색 결과가 없습니다.",
    };
  }

  const geocode: AddressGeocoder = async ({
    roadAddress,
    jibunAddress,
    agency,
    cityFilter,
  }) => {
    const candidates = buildAddressQueryCandidates(roadAddress, jibunAddress);
    if (candidates.length === 0) {
      notFoundCount++;
      return {
        status: "not_found",
        latitude: null,
        longitude: null,
        reason: "변환할 주소가 없습니다.",
      };
    }

    const expectedContext: GeocodeExpectedContext = {
      roadAddress,
      jibunAddress,
      agency: agency ?? null,
    };

    const addrKey = candidates.join("||");
    const hasPhysicalProv = Boolean(
      (!isDummyAddress(roadAddress) && normalizeProvinceToken(roadAddress)) ||
        (!isDummyAddress(jibunAddress) && normalizeProvinceToken(jibunAddress))
    );
    const agencyHint = !hasPhysicalProv ? extractAgencyRegionHint(agency) : null;
    const agencyScope =
      agencyHint && (agencyHint.province || agencyHint.sigungus.length > 0)
        ? `|agency:${agencyHint.province || ""}:${agencyHint.sigungus.join(",")}`
        : "";

    const cacheKey = `${cityFilter || ""}::${addrKey}${agencyScope}`;
    const rawAddrKey = buildRawAddressQueryCandidates(roadAddress, jibunAddress).join("||");
    const rawCacheKey = rawAddrKey ? `${cityFilter || ""}::${rawAddrKey}` : "";

    const cached =
      memoryCache.get(cacheKey) ||
      (!cityFilter && !agencyScope ? addressFallbackCache.get(addrKey) : undefined) ||
      (rawCacheKey && !agencyScope ? memoryCache.get(rawCacheKey) : undefined) ||
      (!cityFilter && !agencyScope && rawAddrKey
        ? addressFallbackCache.get(rawAddrKey)
        : undefined);
    if (cached && cached.status !== "error") {
      cacheHits++;
      return cached;
    }

    const existingPromise = inflight.get(cacheKey);
    if (existingPromise) {
      return existingPromise;
    }

    const promise = lookupCandidates(candidates, cityFilter, expectedContext)
      .then((result) => {
        if (result.status === "success") {
          successCount++;
          memoryCache.set(cacheKey, result);
          if (!agencyScope && !addressFallbackCache.has(addrKey)) {
            addressFallbackCache.set(addrKey, result);
          }
        } else if (result.status === "not_found") {
          notFoundCount++;
          memoryCache.set(cacheKey, result);
        } else if (result.status === "uncertain") {
          uncertainCount++;
          memoryCache.set(cacheKey, result);
        } else {
          errorCount++;
        }
        return result;
      })
      .finally(() => {
        inflight.delete(cacheKey);
      });

    inflight.set(cacheKey, promise);
    return promise;
  };

  geocode.flushCache = () => {
    if (!cachePath) return;
    const obj: Record<string, GeocodeResult> = {};
    for (const [k, v] of memoryCache.entries()) {
      obj[k] = v;
    }
    writeJsonAtomic(cachePath, obj);
  };

  geocode.flushUsage = () => {
    if (!usagePath) return;
    const record: DailyUsageRecord = {
      date: currentDate,
      httpCalls: todayHttpCalls,
      cacheHits,
      successCount,
      notFoundCount,
      uncertainCount,
      errorCount,
      rateLimitedCount,
      updatedAt: nowFn().toISOString(),
    };
    writeJsonAtomic(usagePath, record);
  };

  geocode.getStats = (): GeocoderStats => {
    rolloverDayIfNeeded();
    return {
      date: currentDate,
      dailyLimit,
      maxCallsPerRun: Number.isFinite(maxCallsPerRun) ? maxCallsPerRun : null,
      todayHttpCalls,
      runHttpCalls,
      remainingDailyQuota: Math.max(0, dailyLimit - todayHttpCalls),
      cacheHits,
      successCount,
      notFoundCount,
      uncertainCount,
      errorCount,
      rateLimitedCount,
      fatalStopReason,
    };
  };

  return geocode;
}
