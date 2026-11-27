/**
 * Kakao Local API 실시간 위치 보완 모듈 (TASK 5)
 *
 * 보안·정책 원칙:
 * 1. 카카오 API로 확인한 좌표는 절대 DB, Redis, localStorage, sessionStorage, IndexedDB,
 *    로그, 분석 이벤트에 저장하지 않는다.
 * 2. 동일 이용 세션 내 JS 메모리(Map)에만 일시 보관하고 세션/페이지 종료 시 폐기한다.
 * 3. 대량 선조회·누적 수집을 금지한다. 1회 요청당 최대 15건, 동시 2건, 타임아웃 3.5초,
 *    세션당 최대 60회 호출 제한 및 429/오류 시 즉시 보호 중단한다.
 * 4. 시설명·주소 일치도와 현재 bounds 내부 여부를 검증하며, 공식 DB 핀과 중복되면 제외한다.
 */

import { loadKakaoMapSdk } from "./kakao-sdk";
import type { MapBounds } from "./types";
import type {
  PublicRestroomCandidateSummary,
  PublicRestroomSummary,
  RestroomLocationPrecision,
} from "@/lib/restrooms/types";

export const DEFAULT_CANDIDATE_RESOLVER_LIMITS = {
  maxCandidatesPerRequest: 15,
  concurrency: 2,
  timeoutMs: 3500,
  maxSessionCalls: 60,
} as const;

export interface RawKakaoPlaceHit {
  name: string;
  roadAddress: string;
  jibunAddress: string;
  lat: number;
  lng: number;
}

export interface RawKakaoAddressHit {
  roadAddress: string;
  jibunAddress: string;
  lat: number;
  lng: number;
}

export type KakaoKeywordSearchAdapter = (
  query: string,
  bounds: MapBounds,
  signal?: AbortSignal
) => Promise<RawKakaoPlaceHit[]>;

export type KakaoAddressSearchAdapter = (
  address: string,
  signal?: AbortSignal
) => Promise<RawKakaoAddressHit[]>;

export interface CachedCandidatePosition {
  lat: number;
  lng: number;
  precision: Exclude<RestroomLocationPrecision, "facility_official">;
  matchedRoadAddress: string | null;
}

export interface CandidateResolverSessionState {
  callsUsed: number;
  maxSessionCalls: number;
  successCount: number;
  failedCount: number;
  rateLimited: boolean;
  /** 순수 메모리 캐시 (sessionStorage / localStorage / IndexedDB / DB 사용 금지) */
  memoryCache: Map<string, CachedCandidatePosition | null>;
  /** 정상 검색 완료된 후보 ID (빈 결과 포함, 불필요한 재호출 방지용) */
  completedIds?: Set<string>;
  /** 타임아웃/네트워크 등 일시 실패 후보 ID (재시도 대상) */
  transientFailedIds?: Set<string>;
}

export function createCandidateResolverSessionState(
  maxSessionCalls: number = DEFAULT_CANDIDATE_RESOLVER_LIMITS.maxSessionCalls
): CandidateResolverSessionState {
  return {
    callsUsed: 0,
    maxSessionCalls,
    successCount: 0,
    failedCount: 0,
    rateLimited: false,
    memoryCache: new Map(),
    completedIds: new Set(),
    transientFailedIds: new Set(),
  };
}

export function clearCandidateResolverSessionState(
  state: CandidateResolverSessionState
): void {
  state.memoryCache.clear();
  state.completedIds?.clear();
  state.transientFailedIds?.clear();
}

export class KakaoRateLimitError extends Error {
  readonly status = 429;
  constructor(message = "카카오 API 요청 한도를 초과했습니다.") {
    super(message);
    this.name = "KakaoRateLimitError";
  }
}

function normalizeMatchText(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanAddressForGeocoding(
  raw: string | null | undefined,
  candidate?: Pick<PublicRestroomCandidateSummary, "sido_name" | "sigungu_name">
): string {
  if (!raw) return "";
  let cleaned = raw
    .normalize("NFKC")
    .replace(/\([^)]*\)/g, " ")
    .replace(/,\s*.*$/u, " ")
    .replace(/\s+\d+층.*$/u, " ")
    .replace(/\s+지하?\s*\d+층.*$/u, " ")
    .replace(/([로길])\s*지하\s*(\d+(?:-\d+)?)/u, "$1 $2")
    .replace(/([로길])(\d+(?:-\d+)?)(?=\s|$)/u, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();

  if (
    candidate &&
    cleaned.length >= 4 &&
    candidate.sigungu_name &&
    !cleaned.includes(candidate.sigungu_name.replace(/\s+/g, "")) &&
    !cleaned.includes(candidate.sigungu_name) &&
    !/^(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)/u.test(
      cleaned
    )
  ) {
    cleaned = `${candidate.sido_name} ${candidate.sigungu_name} ${cleaned}`.trim();
  }

  return cleaned;
}

const DISTINCTIVE_POI_NAME_RE =
  /(?:공원|역|시장|주민센터|행정복지센터|복지센터|보건지소|보건소|도서관|체육관|문화센터|주차장|휴게소|선착장|구청|시청|군청|파출소|지구대|터미널|학교|병원|의료원|마트|백화점|박물관|미술관|복지관|회관|약수터|유원지|해수욕장|산책로|전망대)/u;

const PURE_GENERIC_NAME_RE =
  /^(?:(?:남녀공용|남여공용|공중|개방|간이|이동식|민간|유료|무료)\s*)*화장실(?:\s*(?:\d+호?|제\d+호?))?$/u;

const DESCRIPTIVE_LOCATION_NAME_RE =
  /(?:\d+리\s|건너|입구|좌측|우측|앞$|옆$|뒤$|삼거리|사거리|주유소|교회|성당|빌딩|상가|오피스텔|애니텔|프라자|타워)/u;

function hasStreetOrLotNumber(address: string): boolean {
  return /(?:로|길|동|리|가)\s*(?:산\s*)?\d+(?:-\d+)?(?:\s|,|$)/u.test(address);
}

function chooseSearchOrder(
  candidate: PublicRestroomCandidateSummary,
  cleanAddr: string
): { primary: "keyword" | "address"; skipKeyword: boolean } {
  const name = candidate.name.normalize("NFKC").trim();
  const skipKeyword = PURE_GENERIC_NAME_RE.test(name);
  if (skipKeyword && cleanAddr.length >= 5) {
    return { primary: "address", skipKeyword: true };
  }
  const hasDistinctivePoi = DISTINCTIVE_POI_NAME_RE.test(name);
  const hasNumberedAddress = cleanAddr.length >= 5 && hasStreetOrLotNumber(cleanAddr);
  if (
    hasNumberedAddress &&
    !hasDistinctivePoi &&
    (DESCRIPTIVE_LOCATION_NAME_RE.test(name) || name.length <= 12)
  ) {
    return { primary: "address", skipKeyword: false };
  }
  return { primary: "keyword", skipKeyword };
}

export function isCoordinateWithinBounds(
  lat: number,
  lng: number,
  bounds: MapBounds
): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return (
    lat >= bounds.south &&
    lat <= bounds.north &&
    lng >= bounds.west &&
    lng <= bounds.east
  );
}

function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function tokenizeKorean(text: string): string[] {
  return normalizeMatchText(text)
    .split(" ")
    .filter((t) => t.length >= 2 && t !== "화장실" && t !== "공중화장실");
}

function extractAddressAnchorTokens(address: string | null | undefined): string[] {
  const norm = normalizeMatchText(address);
  if (!norm) return [];
  return norm.split(" ").filter((t) => /\d+/.test(t) || /(로|길|동|읍|면|리)$/u.test(t));
}

export function doesAddressResultMatchCandidate(
  candidate: PublicRestroomCandidateSummary,
  hitRoad: string,
  hitJibun: string
): boolean {
  const combinedHit = normalizeMatchText(`${hitRoad} ${hitJibun}`);
  if (!combinedHit) return false;

  // 시·군·구 확인 (복합시 공백 차이 허용: 예) '수원시팔달구' vs '수원시 팔달구')
  const combinedCompact = combinedHit.replace(/\s+/g, "");
  const sigunguCompact = normalizeMatchText(candidate.sigungu_name)
    .replace(/\s+/g, "")
    .replace(/(시|군|구)$/u, "");
  if (sigunguCompact.length >= 2 && !combinedCompact.includes(sigunguCompact)) {
    return false;
  }

  const targetAddr = candidate.road_address || candidate.jibun_address || candidate.normalized_address;
  const anchors = extractAddressAnchorTokens(targetAddr);
  if (anchors.length === 0) return true;

  let matched = 0;
  for (const token of anchors) {
    if (combinedHit.includes(token) || combinedCompact.includes(token.replace(/\s+/g, ""))) {
      matched += 1;
    }
  }
  return matched >= 1;
}

export function doesPlaceResultMatchCandidate(
  candidate: PublicRestroomCandidateSummary,
  hit: RawKakaoPlaceHit
): boolean {
  if (!doesAddressResultMatchCandidate(candidate, hit.roadAddress, hit.jibunAddress)) {
    // 주소 불일치 시 이름 유사도가 아주 높은지 재확인
    const candTokens = tokenizeKorean(candidate.name);
    const hitNorm = normalizeMatchText(hit.name);
    const sigunguShort = normalizeMatchText(candidate.sigungu_name)
      .replace(/\s+/g, "")
      .replace(/(시|군|구)$/u, "");
    const hitAddrCompact = normalizeMatchText(`${hit.roadAddress} ${hit.jibunAddress}`).replace(
      /\s+/g,
      ""
    );
    if (sigunguShort.length >= 2 && !hitAddrCompact.includes(sigunguShort)) {
      return false;
    }
    const nameHits = candTokens.filter((t) => hitNorm.includes(t)).length;
    return candTokens.length > 0 && nameHits >= Math.min(2, candTokens.length);
  }

  const candNorm = normalizeMatchText(candidate.name).replace(/공중화장실|개방화장실|화장실/gu, "").trim();
  const hitNorm = normalizeMatchText(hit.name);
  if (!candNorm) return true;
  if (hitNorm.includes(candNorm) || candNorm.includes(hitNorm)) return true;

  const candTokens = tokenizeKorean(candidate.name);
  if (candTokens.length === 0) return true;
  return candTokens.some((t) => hitNorm.includes(t));
}

export function isResolvedCandidateDuplicateOfOfficial(
  candidate: PublicRestroomCandidateSummary,
  lat: number,
  lng: number,
  officials: readonly PublicRestroomSummary[]
): boolean {
  const candAddrNorm = normalizeMatchText(
    candidate.road_address || candidate.jibun_address || candidate.normalized_address
  );
  const candNameNorm = normalizeMatchText(candidate.name);

  for (const off of officials) {
    const dist = haversineMeters(lat, lng, off.latitude, off.longitude);
    if (dist < 20) {
      return true;
    }
    if (dist < 50) {
      const offAddrNorm = normalizeMatchText(off.road_address);
      const offNameNorm = normalizeMatchText(off.name);
      if (
        (candAddrNorm.length >= 6 &&
          (offAddrNorm.includes(candAddrNorm) || candAddrNorm.includes(offAddrNorm))) ||
        candNameNorm === offNameNorm ||
        (candNameNorm.length >= 3 && offNameNorm.includes(candNameNorm))
      ) {
        return true;
      }
    }
  }
  return false;
}

function createWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("카카오 위치 조회 시간이 초과되었습니다."));
    }, timeoutMs);

    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    promise.then(
      (val) => {
        clearTimeout(timer);
        cleanup();
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        cleanup();
        reject(err);
      }
    );
  });
}

async function createDefaultKakaoAdapters(): Promise<{
  keywordSearchFn: KakaoKeywordSearchAdapter;
  addressSearchFn: KakaoAddressSearchAdapter;
}> {
  const kakao = await loadKakaoMapSdk();
  const services = kakao?.maps?.services;
  if (!kakao?.maps || !services) {
    throw new Error("카카오 지도 services 라이브러리를 사용할 수 없습니다.");
  }

  const places = new services.Places();
  const geocoder = new services.Geocoder();
  const Status = services.Status;

  const keywordSearchFn: KakaoKeywordSearchAdapter = (query, bounds) =>
    new Promise((resolve, reject) => {
      if (!kakao.maps) {
        reject(new Error("Kakao maps not ready"));
        return;
      }
      const kakaoBounds = new kakao.maps.LatLngBounds(
        new kakao.maps.LatLng(bounds.south, bounds.west),
        new kakao.maps.LatLng(bounds.north, bounds.east)
      );

      places.keywordSearch(
        query,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (result: any[], status: string) => {
          if (status === Status.OK) {
            resolve(
              result.map((r) => ({
                name: String(r.place_name ?? ""),
                roadAddress: String(r.road_address_name ?? ""),
                jibunAddress: String(r.address_name ?? ""),
                lat: Number(r.y),
                lng: Number(r.x),
              }))
            );
          } else if (status === Status.ZERO_RESULT) {
            resolve([]);
          } else {
            reject(new Error(`Kakao Places error: ${status}`));
          }
        },
        { bounds: kakaoBounds, size: 5 }
      );
    });

  const addressSearchFn: KakaoAddressSearchAdapter = (address) =>
    new Promise((resolve, reject) => {
      geocoder.addressSearch(
        address,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (result: any[], status: string) => {
          if (status === Status.OK) {
            resolve(
              result.map((r) => ({
                roadAddress: String(r.road_address?.address_name ?? ""),
                jibunAddress: String(r.address?.address_name ?? r.address_name ?? ""),
                lat: Number(r.y),
                lng: Number(r.x),
              }))
            );
          } else if (status === Status.ZERO_RESULT) {
            resolve([]);
          } else {
            reject(new Error(`Kakao Geocoder error: ${status}`));
          }
        }
      );
    });

  return { keywordSearchFn, addressSearchFn };
}

export interface ResolveCandidatesOptions {
  bounds: MapBounds;
  officialRestrooms: readonly PublicRestroomSummary[];
  sessionState: CandidateResolverSessionState;
  signal?: AbortSignal;
  maxCandidates?: number;
  concurrency?: number;
  timeoutMs?: number;
  keywordSearchFn?: KakaoKeywordSearchAdapter;
  addressSearchFn?: KakaoAddressSearchAdapter;
  /** 유효 참고 위치 1건 확인될 때마다 즉시 전달하는 점진 콜백 */
  onResolvedItem?: (item: PublicRestroomSummary) => void;
}

export interface ResolveCandidatesResult {
  items: PublicRestroomSummary[];
  attemptedCount: number;
  callsIssued: number;
  successCount: number;
  failedCount: number;
  aborted: boolean;
  rateLimited: boolean;
  quotaExceeded: boolean;
  completedIds?: string[];
  transientFailedIds?: string[];
}

function toCandidateSummaryItem(
  candidate: PublicRestroomCandidateSummary,
  pos: CachedCandidatePosition
): PublicRestroomSummary {
  const displayAddress =
    pos.matchedRoadAddress ||
    candidate.road_address ||
    candidate.jibun_address ||
    `${candidate.sido_name} ${candidate.sigungu_name}`;

  return {
    id: `candidate:${candidate.id}`,
    type: "public",
    name: candidate.name,
    road_address: displayAddress,
    address_detail: null,
    latitude: pos.lat,
    longitude: pos.lng,
    access_method: "open",
    gender_type: candidate.gender_type,
    wheelchair_accessible: candidate.wheelchair_accessible,
    baby_changing_available: candidate.baby_changing_available,
    sanitary_products_available: null,
    last_verified_at: candidate.source_base_date,
    business_id: null,
    location_kind: "candidate_reference",
    location_precision: pos.precision,
    candidate_meta: {
      sido_name: candidate.sido_name,
      sigungu_name: candidate.sigungu_name,
      eupmyeondong_name: candidate.eupmyeondong_name,
      open_hours: candidate.open_hours,
      closed_days: candidate.closed_days,
      source_provider: candidate.source_provider,
      source_dataset_id: candidate.source_dataset_id,
      source_base_date: candidate.source_base_date,
      attribution_text: candidate.attribution_text,
      facility_hash: candidate.facility_hash,
      coordinate_status: "unlocated",
    },
  };
}

export async function resolveViewportCandidatesWithKakao(
  candidates: readonly PublicRestroomCandidateSummary[],
  options: ResolveCandidatesOptions
): Promise<ResolveCandidatesResult> {
  const maxCandidates = Math.min(
    Math.max(options.maxCandidates ?? DEFAULT_CANDIDATE_RESOLVER_LIMITS.maxCandidatesPerRequest, 1),
    20
  );
  const concurrency = Math.min(
    Math.max(options.concurrency ?? DEFAULT_CANDIDATE_RESOLVER_LIMITS.concurrency, 1),
    3
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_CANDIDATE_RESOLVER_LIMITS.timeoutMs;
  const { bounds, officialRestrooms, sessionState, signal } = options;

  if (signal?.aborted) {
    return {
      items: [],
      attemptedCount: 0,
      callsIssued: 0,
      successCount: 0,
      failedCount: 0,
      aborted: true,
      rateLimited: sessionState.rateLimited,
      quotaExceeded: sessionState.callsUsed >= sessionState.maxSessionCalls,
    };
  }

  const sliced = candidates.slice(0, maxCandidates);
  if (sliced.length === 0) {
    return {
      items: [],
      attemptedCount: 0,
      callsIssued: 0,
      successCount: 0,
      failedCount: 0,
      aborted: false,
      rateLimited: sessionState.rateLimited,
      quotaExceeded: false,
    };
  }

  let keywordSearchFn = options.keywordSearchFn;
  let addressSearchFn = options.addressSearchFn;

  if (!keywordSearchFn || !addressSearchFn) {
    try {
      const defaults = await createDefaultKakaoAdapters();
      keywordSearchFn = keywordSearchFn ?? defaults.keywordSearchFn;
      addressSearchFn = addressSearchFn ?? defaults.addressSearchFn;
    } catch {
      return {
        items: [],
        attemptedCount: 0,
        callsIssued: 0,
        successCount: 0,
        failedCount: 1,
        aborted: Boolean(signal?.aborted),
        rateLimited: sessionState.rateLimited,
        quotaExceeded: false,
      };
    }
  }

  const resolvedItems: PublicRestroomSummary[] = [];
  const completedIds: string[] = [];
  const transientFailedIds: string[] = [];
  if (!sessionState.completedIds) sessionState.completedIds = new Set();
  if (!sessionState.transientFailedIds) sessionState.transientFailedIds = new Set();

  const inFlightKeyword = new Map<string, Promise<RawKakaoPlaceHit[]>>();
  const inFlightAddress = new Map<string, Promise<RawKakaoAddressHit[]>>();

  let nextIndex = 0;
  let callsIssued = 0;
  let successCount = 0;
  let failedCount = 0;
  let aborted = false;
  let quotaExceeded = sessionState.callsUsed >= sessionState.maxSessionCalls;

  const isRateLimit = (err: unknown): boolean => {
    if (err instanceof KakaoRateLimitError) return true;
    const msg = err instanceof Error ? err.message : String(err);
    return /429|TOO_MANY_REQUESTS|QUOTA|RATE_LIMIT/i.test(msg);
  };

  const isAbort = (err: unknown): boolean =>
    Boolean(signal?.aborted) || (err instanceof DOMException && err.name === "AbortError");

  const runKeywordSearchOnce = async (placeQuery: string): Promise<RawKakaoPlaceHit[]> => {
    const key = normalizeMatchText(placeQuery);
    const existing = inFlightKeyword.get(key);
    if (existing) {
      return existing;
    }
    if (sessionState.callsUsed >= sessionState.maxSessionCalls) {
      quotaExceeded = true;
      return [];
    }
    sessionState.callsUsed += 1;
    callsIssued += 1;
    const p = createWithTimeout(keywordSearchFn!(placeQuery, bounds, signal), timeoutMs, signal);
    inFlightKeyword.set(key, p);
    try {
      return await p;
    } catch (err) {
      inFlightKeyword.delete(key);
      throw err;
    }
  };

  const runAddressSearchOnce = async (cleanAddr: string): Promise<RawKakaoAddressHit[]> => {
    const key = normalizeMatchText(cleanAddr);
    const existing = inFlightAddress.get(key);
    if (existing) {
      return existing;
    }
    if (sessionState.callsUsed >= sessionState.maxSessionCalls) {
      quotaExceeded = true;
      return [];
    }
    sessionState.callsUsed += 1;
    callsIssued += 1;
    const p = createWithTimeout(addressSearchFn!(cleanAddr, signal), timeoutMs, signal);
    inFlightAddress.set(key, p);
    try {
      return await p;
    } catch (err) {
      inFlightAddress.delete(key);
      throw err;
    }
  };

  const emitValidItem = (
    candidate: PublicRestroomCandidateSummary,
    pos: CachedCandidatePosition
  ) => {
    if (
      isCoordinateWithinBounds(pos.lat, pos.lng, bounds) &&
      !isResolvedCandidateDuplicateOfOfficial(candidate, pos.lat, pos.lng, officialRestrooms)
    ) {
      const summary = toCandidateSummaryItem(candidate, pos);
      resolvedItems.push(summary);
      options.onResolvedItem?.(summary);
    }
  };

  const worker = async () => {
    while (true) {
      if (signal?.aborted) {
        aborted = true;
        return;
      }
      if (sessionState.rateLimited) return;

      const idx = nextIndex++;
      if (idx >= sliced.length) return;
      const candidate = sliced[idx];

      // 1) 세션 내 메모리 캐시 재사용 (추가 API 호출 0)
      if (sessionState.memoryCache.has(candidate.id)) {
        const cached = sessionState.memoryCache.get(candidate.id);
        completedIds.push(candidate.id);
        sessionState.completedIds?.add(candidate.id);
        if (cached) {
          emitValidItem(candidate, cached);
        }
        continue;
      }

      if (sessionState.callsUsed >= sessionState.maxSessionCalls) {
        quotaExceeded = true;
        return;
      }

      let found: CachedCandidatePosition | null = null;
      const preferredRawAddr = hasStreetOrLotNumber(candidate.road_address || "")
        ? candidate.road_address
        : candidate.jibun_address || candidate.road_address;
      const cleanAddr = cleanAddressForGeocoding(preferredRawAddr, candidate);
      const placeQuery = `${candidate.sigungu_name} ${candidate.name}`.trim();
      const strategy = chooseSearchOrder(candidate, cleanAddr);

      const tryKeyword = async () => {
        if (strategy.skipKeyword || signal?.aborted || sessionState.rateLimited || quotaExceeded) {
          return;
        }
        const placeHits = await runKeywordSearchOnce(placeQuery);
        const matchedPlace = placeHits.find(
          (h) =>
            isCoordinateWithinBounds(h.lat, h.lng, bounds) &&
            doesPlaceResultMatchCandidate(candidate, h)
        );
        if (matchedPlace) {
          found = {
            lat: matchedPlace.lat,
            lng: matchedPlace.lng,
            precision: "kakao_place",
            matchedRoadAddress: matchedPlace.roadAddress || matchedPlace.jibunAddress || null,
          };
        }
      };

      const tryAddress = async () => {
        if (cleanAddr.length < 5 || signal?.aborted || sessionState.rateLimited || quotaExceeded) {
          return;
        }
        const addrHits = await runAddressSearchOnce(cleanAddr);
        const matchedAddr = addrHits.find(
          (h) =>
            isCoordinateWithinBounds(h.lat, h.lng, bounds) &&
            doesAddressResultMatchCandidate(candidate, h.roadAddress, h.jibunAddress)
        );
        if (matchedAddr) {
          found = {
            lat: matchedAddr.lat,
            lng: matchedAddr.lng,
            precision: "kakao_address",
            matchedRoadAddress: matchedAddr.roadAddress || matchedAddr.jibunAddress || null,
          };
        }
      };

      try {
        // 2) 후보의 주소/시설명 품질에 따라 addressSearch vs keywordSearch 동적 우선 실행
        //    1차 검색에서 유효 좌표가 확보되면 2차 불필요 호출 생략
        if (strategy.primary === "address") {
          await tryAddress();
          if (!found && !quotaExceeded && !signal?.aborted && !sessionState.rateLimited) {
            await tryKeyword();
          }
        } else {
          await tryKeyword();
          if (!found && !quotaExceeded && !signal?.aborted && !sessionState.rateLimited) {
            await tryAddress();
          }
        }

        if (signal?.aborted) {
          aborted = true;
          return;
        }

        if (quotaExceeded && !found) {
          transientFailedIds.push(candidate.id);
          sessionState.transientFailedIds?.add(candidate.id);
          return;
        }

        sessionState.memoryCache.set(candidate.id, found);
        sessionState.completedIds?.add(candidate.id);
        sessionState.transientFailedIds?.delete(candidate.id);
        completedIds.push(candidate.id);

        if (found) {
          successCount += 1;
          sessionState.successCount += 1;
          emitValidItem(candidate, found);
        }
      } catch (err) {
        if (isAbort(err)) {
          aborted = true;
          return;
        }
        failedCount += 1;
        sessionState.failedCount += 1;
        // 일시 실패(타임아웃/네트워크/429)는 memoryCache에 저장하지 않고 재시도 가능 상태로 분리
        transientFailedIds.push(candidate.id);
        sessionState.transientFailedIds?.add(candidate.id);
        if (isRateLimit(err)) {
          sessionState.rateLimited = true;
          return;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    items: resolvedItems,
    attemptedCount: sliced.length,
    callsIssued,
    successCount,
    failedCount,
    aborted,
    rateLimited: sessionState.rateLimited,
    quotaExceeded,
    completedIds,
    transientFailedIds,
  };
}
