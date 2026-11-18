import fs from "node:fs";
import path from "node:path";
import type { AddressGeocoder, GeocodeResult } from "./types";

const KAKAO_ADDRESS_SEARCH_URL = "https://dapi.kakao.com/v2/local/search/address.json";

export interface KakaoGeocoderOptions {
  apiKey?: string;
  isJsKey?: boolean;
  appOrigin?: string;
  cachePath?: string | null;
  minDelayMs?: number;
  fetchImpl?: typeof fetch;
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
 * Builds ordered, deduplicated address query candidates from road and jibun addresses.
 */
export function buildAddressQueryCandidates(
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
 * Validates whether a Kakao address document has precise, reliable coordinates.
 * Rejects broad REGION-only centroids, out-of-Korea coordinates, and cross-city mismatches.
 */
export function evaluateKakaoDocument(
  doc: KakaoAddressDoc,
  cityFilter?: string | null
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
  }

  return { valid: true, latitude: lat, longitude: lng };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Creates a Kakao Local Address Search geocoder with in-memory & optional file caching.
 */
export function createKakaoAddressGeocoder(
  options: KakaoGeocoderOptions = {}
): AddressGeocoder & { flushCache: () => void } {
  const restKey = process.env.KAKAO_REST_API_KEY?.trim();
  const jsKey = process.env.NEXT_PUBLIC_KAKAO_MAP_JS_KEY?.trim();
  const resolvedKey = options.apiKey?.trim() || restKey || jsKey;
  const useJsHeaders = options.isJsKey ?? (!options.apiKey && !restKey && Boolean(jsKey));

  if (!resolvedKey) {
    throw new Error(
      "카카오 주소 검색 API 키가 설정되지 않았습니다. KAKAO_REST_API_KEY 또는 NEXT_PUBLIC_KAKAO_MAP_JS_KEY를 설정해 주세요."
    );
  }

  const appOrigin = (options.appOrigin || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "");
  const fetchFn = options.fetchImpl ?? fetch;
  const minDelayMs = options.minDelayMs ?? 40;

  const cachePath = options.cachePath ? path.resolve(process.cwd(), options.cachePath) : null;
  const memoryCache = new Map<string, GeocodeResult>();

  if (cachePath && fs.existsSync(cachePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as Record<string, GeocodeResult>;
      for (const [k, v] of Object.entries(parsed)) {
        if (v && typeof v === "object" && "status" in v) {
          memoryCache.set(k, v);
        }
      }
    } catch {
      // Ignore corrupt cache and rebuild
    }
  }

  const inflight = new Map<string, Promise<GeocodeResult>>();

  async function queryKakaoOnce(query: string): Promise<{
    ok: boolean;
    httpStatus: number;
    documents: KakaoAddressDoc[];
    errorReason?: string;
  }> {
    const headers: Record<string, string> = {
      Authorization: `KakaoAK ${resolvedKey}`,
    };

    if (useJsHeaders) {
      headers.Origin = appOrigin;
      headers.Referer = `${appOrigin}/`;
      headers.KA = `sdk/4.4.15 os/javascript lang/ko-KR device/Node origin/${encodeURIComponent(appOrigin)}`;
    }

    const url = `${KAKAO_ADDRESS_SEARCH_URL}?query=${encodeURIComponent(query)}&size=5`;

    for (let attempt = 0; attempt < 2; attempt++) {
      if (minDelayMs > 0) {
        await sleep(minDelayMs);
      }

      const res = await fetchFn(url, { headers });
      if (res.status === 429 || res.status >= 500) {
        if (attempt === 0) {
          await sleep(300);
          continue;
        }
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
    cityFilter?: string | null
  ): Promise<GeocodeResult> {
    let lastUncertainReason: string | undefined;

    for (const query of candidates) {
      const resp = await queryKakaoOnce(query);
      if (!resp.ok) {
        return {
          status: "error",
          latitude: null,
          longitude: null,
          queryUsed: query,
          reason: resp.errorReason,
        };
      }

      if (resp.documents.length === 0) {
        continue;
      }

      for (const doc of resp.documents) {
        const check = evaluateKakaoDocument(doc, cityFilter);
        if (check.valid && check.latitude !== undefined && check.longitude !== undefined) {
          return {
            status: "success",
            latitude: check.latitude,
            longitude: check.longitude,
            matchedAddress: doc.address_name || null,
            addressType: doc.address_type || null,
            queryUsed: query,
          };
        }
        if (check.reason) {
          lastUncertainReason = check.reason;
        }
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

  const geocode: AddressGeocoder & { flushCache: () => void } = async ({
    roadAddress,
    jibunAddress,
    cityFilter,
  }) => {
    const candidates = buildAddressQueryCandidates(roadAddress, jibunAddress);
    if (candidates.length === 0) {
      return {
        status: "not_found",
        latitude: null,
        longitude: null,
        reason: "변환할 주소가 없습니다.",
      };
    }

    const cacheKey = `${cityFilter || ""}::${candidates.join("||")}`;
    const cached = memoryCache.get(cacheKey);
    if (cached && cached.status !== "error") {
      return cached;
    }

    const existingPromise = inflight.get(cacheKey);
    if (existingPromise) {
      return existingPromise;
    }

    const promise = lookupCandidates(candidates, cityFilter)
      .then((result) => {
        if (result.status !== "error") {
          memoryCache.set(cacheKey, result);
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
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const obj: Record<string, GeocodeResult> = {};
    for (const [k, v] of memoryCache.entries()) {
      obj[k] = v;
    }
    fs.writeFileSync(cachePath, JSON.stringify(obj, null, 2), "utf8");
  };

  return geocode;
}
