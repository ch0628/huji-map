import fs from "node:fs";
import path from "node:path";

export const OPENCAGE_GEOCODE_URL =
  "https://api.opencagedata.com/geocode/v1/json";
export const OPENCAGE_FREE_TRIAL_DAILY_LIMIT = 2500;
export const OPENCAGE_DEFAULT_MIN_DELAY_MS = 1100;
export const OPENCAGE_DEFAULT_SAMPLE_SIZE = 100;

export interface OpenCageResultItem {
  formatted?: string;
  confidence?: number;
  geometry?: {
    lat?: number;
    lng?: number;
  };
  components?: {
    country_code?: string;
    province?: string;
    state?: string;
    city?: string;
    county?: string;
    town?: string;
    suburb?: string;
    road?: string;
    house_number?: string;
    postcode?: string;
    [key: string]: unknown;
  };
}

export interface OpenCageApiResponse {
  status?: {
    code?: number;
    message?: string;
  };
  rate?: {
    limit?: number;
    remaining?: number;
    reset?: number;
  };
  results?: OpenCageResultItem[];
}

export interface OpenCageSampleRecord {
  sampleIndex: number;
  managementNo: string;
  name: string;
  roadAddress: string;
  jibunAddress: string;
  city: string;
  queryAddress: string;
  fallbackQueryAddress: string | null;
}

export interface OpenCageTrialRecordResult {
  sampleIndex: number;
  managementNo: string;
  name: string;
  city: string;
  queryUsed: string;
  status: "matched" | "ambiguous" | "not_found" | "error";
  reason: string;
  httpStatus: number | null;
  confidence: number | null;
  candidateCount: number;
  latitude: number | null;
  longitude: number | null;
  formatted: string | null;
  inKoreaBounds: boolean;
  inGyeonggiBounds: boolean;
  cityMatched: boolean;
}

export interface OpenCageTrialSummary {
  dryRun: boolean;
  scope: "gyeonggi" | "all";
  totalSampled: number;
  httpCallsUsed: number;
  matchedCount: number;
  ambiguousCount: number;
  notFoundCount: number;
  errorCount: number;
  withCoordsCount: number;
  inKoreaBoundsCount: number;
  inGyeonggiBoundsCount: number;
  cityMatchedCount: number;
  rateLimitRemaining: number | null;
  rateLimitCap: number | null;
  attributionNotice: string;
}

const DUMMY_ADDR_RE =
  /^(?:없음|부여불가|해당없음|미상|미정|주소없음|미기재|미입력|null|none|n\/a|na|-+|\.+)$/i;

/**
 * Decodes a CSV buffer supporting UTF-8 and CP949/EUC-KR fallback.
 */
export function decodePublicCsvBuffer(buffer: Buffer | Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("euc-kr").decode(buffer);
  }
}

/**
 * Minimal RFC 4180 CSV parser for standalone Node/Vitest usage.
 */
export function parsePublicCsvRows(
  csvText: string
): Array<Record<string, string>> {
  const clean = csvText.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = "";
  let insideQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    const next = clean[i + 1];
    if (ch === '"') {
      if (insideQuotes && next === '"') {
        currentCell += '"';
        i++;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (ch === "," && !insideQuotes) {
      currentRow.push(currentCell);
      currentCell = "";
    } else if ((ch === "\r" || ch === "\n") && !insideQuotes) {
      if (ch === "\r" && next === "\n") i++;
      currentRow.push(currentCell);
      rows.push(currentRow);
      currentRow = [];
      currentCell = "";
    } else {
      currentCell += ch;
    }
  }
  if (currentCell !== "" || currentRow.length > 0) {
    currentRow.push(currentCell);
    rows.push(currentRow);
  }
  if (rows.length === 0) return [];

  const headers = rows[0].map((h) => h.trim());
  const out: Array<Record<string, string>> = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length === 1 && row[0].trim() === "") continue;
    const rec: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      rec[headers[j]] = row[j] !== undefined ? row[j].trim() : "";
    }
    out.push(rec);
  }
  return out;
}

/**
 * Strips parenthetical remarks and trailing comma building/park notes for cleaner geocoding queries.
 */
export function cleanKoreanAddressForGeocode(addr: string): string {
  const trimmed = (addr || "").replace(/\s+/g, " ").trim();
  if (!trimmed || DUMMY_ADDR_RE.test(trimmed)) return "";
  return trimmed
    .replace(/\([^)]*\)/g, " ")
    .replace(/,.*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Selects a deterministic uniform sample of N records from public_restroom_raw.csv.
 */
export function selectOpenCageSample(
  records: Array<Record<string, string>>,
  options?: { scope?: "gyeonggi" | "all"; limit?: number }
): OpenCageSampleRecord[] {
  const scope = options?.scope ?? "gyeonggi";
  const limit = Math.max(
    1,
    Math.min(OPENCAGE_DEFAULT_SAMPLE_SIZE, options?.limit ?? OPENCAGE_DEFAULT_SAMPLE_SIZE)
  );

  const pool =
    scope === "gyeonggi"
      ? records.filter(
          (r) =>
            (r["소재지도로명주소"] || "").startsWith("경기도") ||
            (r["소재지지번주소"] || "").startsWith("경기도")
        )
      : records;

  if (pool.length === 0) return [];
  const count = Math.min(limit, pool.length);
  const selected: OpenCageSampleRecord[] = [];

  for (let i = 0; i < count; i++) {
    const idx = Math.floor((i * pool.length) / count);
    const r = pool[idx];
    const roadAddress = (r["소재지도로명주소"] || "").trim();
    const jibunAddress = (r["소재지지번주소"] || "").trim();
    const cleanRoad = cleanKoreanAddressForGeocode(roadAddress);
    const cleanJibun = cleanKoreanAddressForGeocode(jibunAddress);
    const queryAddress = cleanRoad || cleanJibun;
    const fallbackQueryAddress =
      cleanRoad && cleanJibun && cleanRoad !== cleanJibun ? cleanJibun : null;
    const cityToken = (roadAddress || jibunAddress).split(/\s+/)[1] || "";

    selected.push({
      sampleIndex: i + 1,
      managementNo: (r["관리번호"] || r["화장실관리번호"] || "").trim(),
      name: (r["화장실명"] || "").trim(),
      roadAddress,
      jibunAddress,
      city: cityToken,
      queryAddress,
      fallbackQueryAddress,
    });
  }

  return selected;
}

/**
 * Builds an OpenCage Geocoding API v1 request URL without exposing the key in logs.
 */
export function buildOpenCageRequestUrl(
  query: string,
  apiKey: string
): string {
  const params = new URLSearchParams({
    q: query,
    key: apiKey,
    countrycode: "kr",
    language: "ko",
    limit: "3",
    no_annotations: "1",
  });
  return `${OPENCAGE_GEOCODE_URL}?${params.toString()}`;
}

export function isInKoreaWgs84Bounds(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= 33 &&
    lat <= 39 &&
    lng >= 124 &&
    lng <= 132
  );
}

export function isInGyeonggiBounds(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= 36.85 &&
    lat <= 38.3 &&
    lng >= 126.35 &&
    lng <= 127.9
  );
}

function checkCityConsistency(
  expectedCity: string,
  item: OpenCageResultItem
): boolean {
  if (!expectedCity) return true;
  const stem = expectedCity.replace(/[시군구]$/, "");
  if (!stem) return true;
  const compText = [
    item.formatted || "",
    item.components?.city || "",
    item.components?.county || "",
    item.components?.town || "",
    item.components?.suburb || "",
    item.components?.state || "",
    item.components?.province || "",
  ]
    .join(" ")
    .toLowerCase();
  return compText.includes(stem.toLowerCase());
}

/**
 * Evaluates an OpenCage API JSON payload against the Korean input sample.
 * Does NOT reference any Kakao coordinates or legacy cache.
 */
export function evaluateOpenCageResponse(
  sample: OpenCageSampleRecord,
  queryUsed: string,
  httpStatus: number,
  payload: OpenCageApiResponse
): OpenCageTrialRecordResult {
  const results = Array.isArray(payload.results) ? payload.results : [];
  if (httpStatus !== 200 || (payload.status?.code && payload.status.code !== 200)) {
    return {
      sampleIndex: sample.sampleIndex,
      managementNo: sample.managementNo,
      name: sample.name,
      city: sample.city,
      queryUsed,
      status: "error",
      reason: `OpenCage API 오류 (HTTP ${httpStatus}, code ${payload.status?.code ?? "unknown"})`,
      httpStatus,
      confidence: null,
      candidateCount: results.length,
      latitude: null,
      longitude: null,
      formatted: null,
      inKoreaBounds: false,
      inGyeonggiBounds: false,
      cityMatched: false,
    };
  }

  if (results.length === 0) {
    return {
      sampleIndex: sample.sampleIndex,
      managementNo: sample.managementNo,
      name: sample.name,
      city: sample.city,
      queryUsed,
      status: "not_found",
      reason: "OpenCage 검색 결과 0건",
      httpStatus,
      confidence: null,
      candidateCount: 0,
      latitude: null,
      longitude: null,
      formatted: null,
      inKoreaBounds: false,
      inGyeonggiBounds: false,
      cityMatched: false,
    };
  }

  const top = results[0];
  const lat =
    typeof top.geometry?.lat === "number" ? top.geometry.lat : Number.NaN;
  const lng =
    typeof top.geometry?.lng === "number" ? top.geometry.lng : Number.NaN;
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0);
  const inKoreaBounds = hasCoords && isInKoreaWgs84Bounds(lat, lng);
  const inGyeonggiBounds = hasCoords && isInGyeonggiBounds(lat, lng);
  const cityMatched = checkCityConsistency(sample.city, top);
  const confidence = typeof top.confidence === "number" ? top.confidence : null;

  const isExact =
    inKoreaBounds &&
    cityMatched &&
    (confidence === null || confidence >= 6) &&
    results.length === 1;

  const status = !inKoreaBounds
    ? "ambiguous"
    : isExact
      ? "matched"
      : "ambiguous";

  let reason = "좌표 반환";
  if (!inKoreaBounds) {
    reason = "대한민국 WGS84 경계 밖 좌표 반환";
  } else if (!cityMatched) {
    reason = `입력 시·군(${sample.city})과 OpenCage 결과 행정구역 불일치`;
  } else if (confidence !== null && confidence < 6) {
    reason = `OpenCage confidence 낮음 (${confidence}/10)`;
  } else if (results.length > 1) {
    reason = `복수 후보(${results.length}건) 반환 — 최상위 후보 검증 필요`;
  } else {
    reason = `단일 후보 및 시·군 일치 (confidence ${confidence ?? "-"}/10)`;
  }

  return {
    sampleIndex: sample.sampleIndex,
    managementNo: sample.managementNo,
    name: sample.name,
    city: sample.city,
    queryUsed,
    status,
    reason,
    httpStatus,
    confidence,
    candidateCount: results.length,
    latitude: hasCoords ? lat : null,
    longitude: hasCoords ? lng : null,
    formatted: top.formatted ?? null,
    inKoreaBounds,
    inGyeonggiBounds,
    cityMatched,
  };
}

export interface RunOpenCageTrialOptions {
  apiKey?: string | null;
  dryRun?: boolean;
  confirmed?: boolean;
  scope?: "gyeonggi" | "all";
  limit?: number;
  minDelayMs?: number;
  fetchImpl?: typeof fetch;
  outPath?: string | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Executes (or dry-runs) the 100-record OpenCage geocoding trial without touching any DB or Kakao cache.
 */
export async function runOpenCageTrial(
  samples: OpenCageSampleRecord[],
  options: RunOpenCageTrialOptions = {}
): Promise<{
  summary: OpenCageTrialSummary;
  records: OpenCageTrialRecordResult[];
  blockedReason?: string;
}> {
  const dryRun = options.dryRun !== false;
  const confirmed = options.confirmed === true;
  const scope = options.scope ?? "gyeonggi";
  const minDelayMs = Math.max(
    OPENCAGE_DEFAULT_MIN_DELAY_MS,
    options.minDelayMs ?? OPENCAGE_DEFAULT_MIN_DELAY_MS
  );
  const fetchFn = options.fetchImpl ?? fetch;

  const baseSummary: OpenCageTrialSummary = {
    dryRun,
    scope,
    totalSampled: samples.length,
    httpCallsUsed: 0,
    matchedCount: 0,
    ambiguousCount: 0,
    notFoundCount: 0,
    errorCount: 0,
    withCoordsCount: 0,
    inKoreaBoundsCount: 0,
    inGyeonggiBoundsCount: 0,
    cityMatchedCount: 0,
    rateLimitRemaining: null,
    rateLimitCap: null,
    attributionNotice:
      "지리정보 저작권: OpenStreetMap 기여자 (https://www.openstreetmap.org)",
  };

  if (dryRun || !confirmed) {
    return {
      summary: baseSummary,
      records: [],
      blockedReason: dryRun
        ? "DRY-RUN 모드: 실제 OpenCage HTTP 호출을 실행하지 않았습니다."
        : "안전 차단: --live 실행 시 --confirm 플래그와 사용자 승인이 필요합니다.",
    };
  }

  const apiKey = (options.apiKey || "").trim();
  if (!apiKey) {
    return {
      summary: baseSummary,
      records: [],
      blockedReason: "OPENCAGE_API_KEY 설정 필요: 환경변수가 비어 있어 호출을 중단했습니다.",
    };
  }

  const records: OpenCageTrialRecordResult[] = [];
  let httpCallsUsed = 0;
  let rateLimitRemaining: number | null = null;
  let rateLimitCap: number | null = null;

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    if (!sample.queryAddress) {
      records.push({
        sampleIndex: sample.sampleIndex,
        managementNo: sample.managementNo,
        name: sample.name,
        city: sample.city,
        queryUsed: "",
        status: "not_found",
        reason: "지오코딩 가능한 도로명/지번 주소 없음",
        httpStatus: null,
        confidence: null,
        candidateCount: 0,
        latitude: null,
        longitude: null,
        formatted: null,
        inKoreaBounds: false,
        inGyeonggiBounds: false,
        cityMatched: false,
      });
      continue;
    }

    if (httpCallsUsed > 0 && minDelayMs > 0) {
      await sleep(minDelayMs);
    }

    const url = buildOpenCageRequestUrl(sample.queryAddress, apiKey);
    httpCallsUsed++;
    const res = await fetchFn(url, {
      headers: { Accept: "application/json" },
    });
    const payload = (await res.json()) as OpenCageApiResponse;
    if (typeof payload.rate?.remaining === "number") {
      rateLimitRemaining = payload.rate.remaining;
    }
    if (typeof payload.rate?.limit === "number") {
      rateLimitCap = payload.rate.limit;
    }

    const evaluated = evaluateOpenCageResponse(
      sample,
      sample.queryAddress,
      res.status,
      payload
    );
    records.push(evaluated);

    // Stop immediately on auth or quota exhaustion
    if (res.status === 401 || res.status === 402 || res.status === 403 || res.status === 429) {
      break;
    }
  }

  const summary: OpenCageTrialSummary = {
    dryRun: false,
    scope,
    totalSampled: samples.length,
    httpCallsUsed,
    matchedCount: records.filter((r) => r.status === "matched").length,
    ambiguousCount: records.filter((r) => r.status === "ambiguous").length,
    notFoundCount: records.filter((r) => r.status === "not_found").length,
    errorCount: records.filter((r) => r.status === "error").length,
    withCoordsCount: records.filter(
      (r) => r.latitude !== null && r.longitude !== null
    ).length,
    inKoreaBoundsCount: records.filter((r) => r.inKoreaBounds).length,
    inGyeonggiBoundsCount: records.filter((r) => r.inGyeonggiBounds).length,
    cityMatchedCount: records.filter((r) => r.cityMatched).length,
    rateLimitRemaining,
    rateLimitCap,
    attributionNotice:
      "지리정보 저작권: OpenStreetMap 기여자 (https://www.openstreetmap.org)",
  };

  if (options.outPath) {
    const absOut = path.resolve(options.outPath);
    fs.mkdirSync(path.dirname(absOut), { recursive: true });
    fs.writeFileSync(
      absOut,
      JSON.stringify({ summary, records }, null, 2),
      "utf8"
    );
  }

  return { summary, records };
}
