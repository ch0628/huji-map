import type { SupabaseClient } from "@supabase/supabase-js";
import type { MapBounds } from "@/lib/maps/types";
import type { Database } from "@/lib/db/types";
import {
  findIntersectingAdminRegions,
  MAX_CANDIDATE_VIEWPORT_LAT_SPAN,
  MAX_CANDIDATE_VIEWPORT_LNG_SPAN,
} from "./korea-admin-regions";
import type {
  CandidateViewportResponse,
  GenderType,
  PublicRestroomCandidateSummary,
} from "./types";

const MAX_INTERSECTING_REGIONS = 16;

export function normalizeCandidateSearchText(value: string | null | undefined): string {
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

export function normalizeKoreanRoadAddress(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/^서울\s+/u, "서울특별시 ")
    .replace(/^부산\s+/u, "부산광역시 ")
    .replace(/^대구\s+/u, "대구광역시 ")
    .replace(/^인천\s+/u, "인천광역시 ")
    .replace(/^광주\s+/u, "광주광역시 ")
    .replace(/^대전\s+/u, "대전광역시 ")
    .replace(/^울산\s+/u, "울산광역시 ")
    .replace(/^세종(시)?\s+/u, "세종특별자치시 ")
    .replace(/^경기\s+/u, "경기도 ")
    .replace(/^강원(도)?\s+/u, "강원특별자치도 ")
    .replace(/^충북\s+/u, "충청북도 ")
    .replace(/^충남\s+/u, "충청남도 ")
    .replace(/^전북(도)?\s+/u, "전북특별자치도 ")
    .replace(/^전남\s+/u, "전라남도 ")
    .replace(/^경북\s+/u, "경상북도 ")
    .replace(/^경남\s+/u, "경상남도 ")
    .replace(/^제주(도)?\s+/u, "제주특별자치도 ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isViewportTooWideForCandidates(bounds: MapBounds): boolean {
  const latSpan = bounds.north - bounds.south;
  const lngSpan = bounds.east - bounds.west;
  return (
    !Number.isFinite(latSpan) ||
    !Number.isFinite(lngSpan) ||
    latSpan <= 0 ||
    lngSpan <= 0 ||
    latSpan > MAX_CANDIDATE_VIEWPORT_LAT_SPAN ||
    lngSpan > MAX_CANDIDATE_VIEWPORT_LNG_SPAN
  );
}

function sanitizePostgrestToken(raw: string): string {
  return raw.replace(/[,().%_*\\'"]/g, " ").replace(/\s+/g, " ").trim();
}

export interface OfficialRestroomFingerprintRef {
  name: string;
  road_address: string | null;
}

/**
 * 공식 DB 화장실과 이름+주소가 실질적으로 동일한 후보를 걸러낸다.
 * 주의: facility_hash 단독 일치만으로 병합하지 않고, 정규화 주소·이름 일치도 함께 확인한다.
 */
export function isCandidateDuplicateOfOfficial(
  candidate: Pick<
    PublicRestroomCandidateSummary,
    "name" | "normalized_name" | "road_address" | "jibun_address" | "normalized_address"
  >,
  officials: readonly OfficialRestroomFingerprintRef[]
): boolean {
  if (officials.length === 0) return false;

  const candName = normalizeCandidateSearchText(candidate.normalized_name || candidate.name);
  const candRoad = normalizeKoreanRoadAddress(candidate.road_address || candidate.normalized_address);
  const candJibun = normalizeKoreanRoadAddress(candidate.jibun_address);

  for (const off of officials) {
    const offName = normalizeCandidateSearchText(off.name);
    const offAddr = normalizeKoreanRoadAddress(off.road_address);
    if (!offAddr) continue;

    const sameAddress =
      (candRoad.length >= 6 && (offAddr === candRoad || offAddr.includes(candRoad) || candRoad.includes(offAddr))) ||
      (candJibun.length >= 6 && (offAddr === candJibun || offAddr.includes(candJibun) || candJibun.includes(offAddr)));

    if (!sameAddress) continue;

    if (
      candName === offName ||
      (candName.length >= 3 && offName.includes(candName)) ||
      (offName.length >= 3 && candName.includes(offName))
    ) {
      return true;
    }

    // 동일 주소에서 둘 다 '화장실' 명칭 포함 시 중복 후보로 제외
    const candTokens = new Set(candName.split(" ").filter((t) => t.length >= 2));
    const offTokens = offName.split(" ").filter((t) => t.length >= 2);
    const overlap = offTokens.filter((t) => candTokens.has(t)).length;
    if (overlap >= 1 && (candRoad === offAddr || candJibun === offAddr)) {
      return true;
    }
  }

  return false;
}

export interface ListViewportCandidatesParams {
  bounds: MapBounds;
  q?: string;
  limit?: number;
}

export async function listViewportUnlocatedCandidates(
  supabase: SupabaseClient<Database>,
  params: ListViewportCandidatesParams
): Promise<CandidateViewportResponse> {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 40);
  const regionResult = findIntersectingAdminRegions(params.bounds);
  const viewCenterLat = (params.bounds.south + params.bounds.north) / 2;
  const viewCenterLng = (params.bounds.west + params.bounds.east) / 2;

  // 지도 중심에서 가장 가까운 시군구 순으로 정렬 (사전순 sigungu_code 편향 방지)
  const regions = [...regionResult.regions].sort((a, b) => {
    const aLat = (a.south + a.north) / 2;
    const aLng = (a.west + a.east) / 2;
    const bLat = (b.south + b.north) / 2;
    const bLng = (b.west + b.east) / 2;
    const distA = (aLat - viewCenterLat) ** 2 + (aLng - viewCenterLng) ** 2;
    const distB = (bLat - viewCenterLat) ** 2 + (bLng - viewCenterLng) ** 2;
    return distA - distB || a.sigunguCode.localeCompare(b.sigunguCode);
  });
  const regionCodes = regions.map((r) => r.sigunguCode);
  const regionNames = regions.map((r) => `${r.sidoName} ${r.sigunguName}`);

  if (
    regionResult.tooWide ||
    isViewportTooWideForCandidates(params.bounds) ||
    regions.length === 0 ||
    regions.length > MAX_INTERSECTING_REGIONS
  ) {
    return {
      items: [],
      regionCodes,
      regionNames,
      tooWide: true,
      totalReturned: 0,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = supabase as any;
  const normQ = sanitizePostgrestToken(normalizeCandidateSearchText(params.q));

  const buildCandidateQuery = (codes: string[], maxRows: number) => {
    let q = client
      .from("public_restroom_candidates")
      .select(
        [
          "id",
          "source_provider",
          "source_dataset_id",
          "source_record_id",
          "name",
          "normalized_name",
          "road_address",
          "jibun_address",
          "normalized_address",
          "sido_code",
          "sigungu_code",
          "eupmyeondong_code",
          "sido_name",
          "sigungu_name",
          "eupmyeondong_name",
          "facility_type",
          "open_hours",
          "closed_days",
          "gender_type",
          "wheelchair_accessible",
          "baby_changing_available",
          "coordinate_status",
          "facility_hash",
          "source_base_date",
          "attribution_text",
        ].join(", ")
      )
      .eq("coordinate_status", "unlocated")
      .in("sigungu_code", codes)
      .order("sigungu_code", { ascending: true })
      .order("id", { ascending: true })
      .limit(maxRows);

    if (normQ.length > 0) {
      q = q.or(
        `normalized_name.ilike.%${normQ}%,normalized_address.ilike.%${normQ}%,eupmyeondong_name.ilike.%${normQ}%`
      );
    }
    return q;
  };

  // 중심 시군구 우선 + 인접 시군구 병행 조회로 경계 누락·쏠림 모두 방지
  const primaryCodes = regionCodes.slice(0, 1);
  const adjacentCodes = regionCodes.slice(1);
  const primaryFetchLimit = Math.min(limit * 3, 90);
  const adjacentFetchLimit = Math.min(limit * 2, 60);

  const officialQuery = client
    .from("restrooms")
    .select("name, road_address")
    .eq("publication_status", "published")
    .gte("latitude", params.bounds.south - 0.01)
    .lte("latitude", params.bounds.north + 0.01)
    .gte("longitude", params.bounds.west - 0.01)
    .lte("longitude", params.bounds.east + 0.01)
    .limit(300);

  const [primaryRes, adjacentRes, offRes] = await Promise.all([
    buildCandidateQuery(primaryCodes, primaryFetchLimit),
    adjacentCodes.length > 0
      ? buildCandidateQuery(adjacentCodes, adjacentFetchLimit)
      : Promise.resolve({ data: [], error: null }),
    officialQuery,
  ]);

  if (primaryRes.error) {
    throw new Error(`후보 화장실 인덱스 조회 실패: ${primaryRes.error.message}`);
  }
  if (adjacentRes.error) {
    throw new Error(`인접 후보 화장실 인덱스 조회 실패: ${adjacentRes.error.message}`);
  }

  const regionOrder = new Map(regionCodes.map((c, idx) => [c, idx]));
  const rawCandidates = [
    ...((primaryRes.data || []) as Array<Record<string, unknown>>),
    ...((adjacentRes.data || []) as Array<Record<string, unknown>>),
  ].sort((a, b) => {
    const rankA = regionOrder.get(String(a.sigungu_code ?? "")) ?? 999;
    const rankB = regionOrder.get(String(b.sigungu_code ?? "")) ?? 999;
    return rankA - rankB;
  });
  const officials = ((offRes.data || []) as Array<{ name: string; road_address: string | null }>).filter(
    (o) => typeof o.name === "string"
  );

  const items: PublicRestroomCandidateSummary[] = [];
  const seenCandidateIds = new Set<string>();
  for (const row of rawCandidates) {
    const candId = String(row.id);
    if (seenCandidateIds.has(candId)) continue;
    seenCandidateIds.add(candId);

    const mapped: PublicRestroomCandidateSummary = {
      id: candId,
      source_provider: String(row.source_provider ?? ""),
      source_dataset_id: String(row.source_dataset_id ?? ""),
      source_record_id: String(row.source_record_id ?? ""),
      name: String(row.name ?? ""),
      normalized_name: String(row.normalized_name ?? ""),
      road_address: typeof row.road_address === "string" ? row.road_address : null,
      jibun_address: typeof row.jibun_address === "string" ? row.jibun_address : null,
      normalized_address: String(row.normalized_address ?? ""),
      sido_code: String(row.sido_code ?? ""),
      sigungu_code: String(row.sigungu_code ?? ""),
      eupmyeondong_code: typeof row.eupmyeondong_code === "string" ? row.eupmyeondong_code : null,
      sido_name: String(row.sido_name ?? ""),
      sigungu_name: String(row.sigungu_name ?? ""),
      eupmyeondong_name: typeof row.eupmyeondong_name === "string" ? row.eupmyeondong_name : null,
      facility_type: typeof row.facility_type === "string" ? row.facility_type : null,
      open_hours: typeof row.open_hours === "string" ? row.open_hours : null,
      closed_days: typeof row.closed_days === "string" ? row.closed_days : null,
      gender_type: ((row.gender_type as GenderType) || "unknown") as GenderType,
      wheelchair_accessible:
        typeof row.wheelchair_accessible === "boolean" ? row.wheelchair_accessible : null,
      baby_changing_available:
        typeof row.baby_changing_available === "boolean" ? row.baby_changing_available : null,
      coordinate_status: "unlocated",
      facility_hash: String(row.facility_hash ?? ""),
      source_base_date: typeof row.source_base_date === "string" ? row.source_base_date : null,
      attribution_text: typeof row.attribution_text === "string" ? row.attribution_text : null,
    };

    if (isCandidateDuplicateOfOfficial(mapped, officials)) {
      continue;
    }

    items.push(mapped);
    if (items.length >= limit) break;
  }

  return {
    items,
    regionCodes,
    regionNames,
    tooWide: false,
    totalReturned: items.length,
  };
}
