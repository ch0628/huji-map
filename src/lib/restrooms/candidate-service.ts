import type { SupabaseClient } from "@supabase/supabase-js";
import type { MapBounds } from "@/lib/maps/types";
import type { Database } from "@/lib/db/types";
import {
  extractEupMyeonDongName,
  findIntersectingAdminRegions,
  MAX_CANDIDATE_VIEWPORT_LAT_SPAN,
  MAX_CANDIDATE_VIEWPORT_LNG_SPAN,
  type KoreaAdminRegion,
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
  cursor?: string;
  excludeIds?: string[];
}

function parseCandidateCursor(cursor?: string): {
  offset: number;
  deferIds: Set<string>;
} {
  if (!cursor) return { offset: 0, deferIds: new Set() };
  const trimmed = cursor.trim();
  if (trimmed.startsWith("d:")) {
    const deferIds = new Set(
      trimmed
        .slice(2)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^[a-zA-Z0-9_:-]{1,64}$/.test(s))
        .slice(0, 60)
    );
    return { offset: 0, deferIds };
  }
  const full = trimmed.match(/^o:(\d+)(?::x:\d+)?$/);
  if (!full) return { offset: 0, deferIds: new Set() };
  const n = Number(full[1]);
  return {
    offset: Number.isFinite(n) && n >= 0 ? Math.min(n, 500) : 0,
    deferIds: new Set(),
  };
}

function extractRoadStem(address: string | null | undefined): string | null {
  if (!address) return null;
  const cleaned = address.normalize("NFKC").replace(/\([^)]*\)/g, " ").trim();
  const m = cleaned.match(/(?:^|\s)([가-힣0-9]+(?:로\d*길|길|로))(?=\s*(?:지하)?\d|\s|$)/u);
  return m ? m[1] : null;
}

function compactRegionToken(name: string): string {
  return name.replace(/\s+/g, "").trim();
}

function extractSigunguTokenFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const cleaned = address
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .replace(
      /^(?:서울특별시|서울시|서울|부산광역시|부산시|부산|대구광역시|대구시|대구|인천광역시|인천시|인천|광주광역시|광주시|대전광역시|대전시|대전|울산광역시|울산시|울산|세종특별자치시|세종시|세종|경기도|경기|강원특별자치도|강원도|강원|충청북도|충북|충청남도|충남|전북특별자치도|전라북도|전북|전라남도|전남|경상북도|경북|경상남도|경남|제주특별자치도|제주도|제주)\s+/u,
      ""
    );
  const cityGu = cleaned.match(/^([가-힣]+시)\s+([가-힣]+구)(?=\s|$)/u);
  if (cityGu) {
    return `${cityGu[1]}${cityGu[2]}`;
  }
  const single = cleaned.match(/^([가-힣]+(?:시|군|구))(?=\s|$)/u);
  if (single) {
    return single[1];
  }
  return null;
}

interface OfficialRowHint {
  name: string;
  road_address: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

interface ViewportOfficialHints {
  dongWeights: Map<string, number>;
  roadWeights: Map<string, number>;
  sigunguCounts: Map<string, number>;
  hasUrbanDongHint: boolean;
  hasRuralTownHint: boolean;
}

function buildViewportOfficialHints(
  officials: readonly OfficialRowHint[],
  bounds: MapBounds
): ViewportOfficialHints {
  const dongWeights = new Map<string, number>();
  const roadWeights = new Map<string, number>();
  const sigunguCounts = new Map<string, number>();
  let urbanCount = 0;
  let ruralCount = 0;

  const centerLat = (bounds.south + bounds.north) / 2;
  const centerLng = (bounds.west + bounds.east) / 2;
  const latSpan = Math.max(bounds.north - bounds.south, 0.002);
  const lngSpan = Math.max(bounds.east - bounds.west, 0.002);

  const hasAnyCoords = officials.some(
    (o) => typeof o.latitude === "number" && typeof o.longitude === "number"
  );
  const inBoundsOfficials = hasAnyCoords
    ? officials.filter(
      (o) =>
        typeof o.latitude === "number" &&
        typeof o.longitude === "number" &&
        o.latitude >= bounds.south &&
        o.latitude <= bounds.north &&
        o.longitude >= bounds.west &&
        o.longitude <= bounds.east
    )
    : officials;

  const targetOfficials = inBoundsOfficials.length > 0 ? inBoundsOfficials : officials;

  for (const off of targetOfficials) {
    let weight = 1;
    if (typeof off.latitude === "number" && typeof off.longitude === "number") {
      const normDist = Math.hypot(
        (off.latitude - centerLat) / latSpan,
        (off.longitude - centerLng) / lngSpan
      );
      weight = Math.max(0.4, 2.0 - Math.min(normDist, 1.6));
    }

    const dong = extractEupMyeonDongName(off.road_address, null);
    if (dong) {
      dongWeights.set(dong, (dongWeights.get(dong) ?? 0) + weight);
      if (/(?:동|가)$/u.test(dong)) urbanCount += 1;
      else if (/(?:읍|면)$/u.test(dong)) ruralCount += 1;
    }
    const road = extractRoadStem(off.road_address);
    if (road) {
      roadWeights.set(road, (roadWeights.get(road) ?? 0) + weight);
    }
    const sgg = extractSigunguTokenFromAddress(off.road_address);
    if (sgg) {
      const key = compactRegionToken(sgg);
      sigunguCounts.set(key, (sigunguCounts.get(key) ?? 0) + weight);
    }
  }

  return {
    dongWeights,
    roadWeights,
    sigunguCounts,
    hasUrbanDongHint: urbanCount > 0 && ruralCount === 0,
    hasRuralTownHint: ruralCount > 0 && urbanCount === 0,
  };
}

function computeRegionOverlapRatio(region: KoreaAdminRegion, bounds: MapBounds): number {
  const overlapSouth = Math.max(region.south, bounds.south);
  const overlapNorth = Math.min(region.north, bounds.north);
  const overlapWest = Math.max(region.west, bounds.west);
  const overlapEast = Math.min(region.east, bounds.east);
  if (overlapNorth <= overlapSouth || overlapEast <= overlapWest) return 0;
  const viewArea = Math.max(
    (bounds.north - bounds.south) * (bounds.east - bounds.west),
    1e-9
  );
  return Math.min(1, ((overlapNorth - overlapSouth) * (overlapEast - overlapWest)) / viewArea);
}

function rankRegionsForViewport(
  regions: readonly KoreaAdminRegion[],
  bounds: MapBounds,
  sigunguCounts: ReadonlyMap<string, number>
): { ranked: KoreaAdminRegion[]; scores: Map<string, number> } {
  const viewCenterLat = (bounds.south + bounds.north) / 2;
  const viewCenterLng = (bounds.west + bounds.east) / 2;
  const scores = new Map<string, number>();

  for (const r of regions) {
    const overlap = computeRegionOverlapRatio(r, bounds);
    const containsCenter =
      viewCenterLat >= r.south &&
      viewCenterLat <= r.north &&
      viewCenterLng >= r.west &&
      viewCenterLng <= r.east;
    const rLat = (r.south + r.north) / 2;
    const rLng = (r.west + r.east) / 2;
    const centerDistSq = (rLat - viewCenterLat) ** 2 + (rLng - viewCenterLng) ** 2;
    const officialBoost = sigunguCounts.get(compactRegionToken(r.sigunguName)) ?? 0;

    const score =
      officialBoost * 35 +
      overlap * 50 +
      (containsCenter ? 15 : 0) -
      Math.min(centerDistSq * 250, 20);
    scores.set(r.sigunguCode, score);
  }

  const ranked = [...regions].sort((a, b) => {
    const sa = scores.get(a.sigunguCode) ?? 0;
    const sb = scores.get(b.sigunguCode) ?? 0;
    if (Math.abs(sb - sa) > 1e-6) return sb - sa;
    return a.sigunguCode.localeCompare(b.sigunguCode);
  });

  return { ranked, scores };
}

function scoreCandidateRelevance(
  candidate: PublicRestroomCandidateSummary,
  hints: ViewportOfficialHints,
  regionOrder: ReadonlyMap<string, number>
): number {
  let score = 0;
  const regionIdx = regionOrder.get(candidate.sigungu_code) ?? 15;
  score += Math.max(0, 24 - regionIdx * 6);

  const candDong =
    candidate.eupmyeondong_name ||
    extractEupMyeonDongName(candidate.road_address, candidate.jibun_address);
  if (candDong) {
    const dongWeight = hints.dongWeights.get(candDong) ?? 0;
    score += dongWeight > 0 ? Math.min(85, 42 + dongWeight * 12) : 2;
    if (hints.hasUrbanDongHint) {
      if (/(?:동|가)$/u.test(candDong)) score += 20;
      else if (/(?:읍|면)$/u.test(candDong)) score -= 22;
    } else if (hints.hasRuralTownHint) {
      if (/(?:읍|면)$/u.test(candDong)) score += 16;
    }
    // 도로명 접두어(예: 태화1길 -> 태화동) 일치 보너스
    const dongStem = candDong.replace(/(?:동|읍|면|가|\d+동)$/u, "");
    if (dongStem.length >= 2) {
      for (const [road, w] of hints.roadWeights.entries()) {
        if (road.startsWith(dongStem)) {
          score += Math.min(35, 18 + w * 4);
          break;
        }
      }
    }
  }

  const candRoad = extractRoadStem(candidate.road_address);
  if (candRoad) {
    const roadWeight = hints.roadWeights.get(candRoad) ?? 0;
    if (roadWeight > 0) {
      score += Math.min(70, 32 + roadWeight * 12);
    }
  }

  const fullAddr = `${candidate.road_address || ""} ${candidate.jibun_address || ""}`.trim();
  if (/(?:로|길|동|리|가)\s*(?:지하\s*)?(?:산\s*)?\d+(?:-\d+)?/u.test(fullAddr)) {
    score += 12;
  } else {
    score -= 6;
  }
  if (candidate.eupmyeondong_name) {
    score += 4;
  }

  return score;
}

export async function listViewportUnlocatedCandidates(
  supabase: SupabaseClient<Database>,
  params: ListViewportCandidatesParams
): Promise<CandidateViewportResponse> {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 40);
  const parsedCursor = parseCandidateCursor(params.cursor);
  const excludeSet = new Set(params.excludeIds ?? []);
  const deferSet = parsedCursor.deferIds;
  // excludeIds가 함께 전달될 때는 이미 완료 후보를 제외했으므로 숫자 offset을 이중 적용하지 않는다
  const offset = excludeSet.size > 0 || deferSet.size > 0 ? 0 : parsedCursor.offset;
  const regionResult = findIntersectingAdminRegions(params.bounds);
  const initialRanked = rankRegionsForViewport(
    regionResult.regions,
    params.bounds,
    new Map()
  ).ranked;

  if (
    regionResult.tooWide ||
    isViewportTooWideForCandidates(params.bounds) ||
    initialRanked.length === 0 ||
    initialRanked.length > MAX_INTERSECTING_REGIONS
  ) {
    const regionCodes = initialRanked.map((r) => r.sigunguCode);
    const regionNames = initialRanked.map((r) => `${r.sidoName} ${r.sigunguName}`);
    return {
      items: [],
      regionCodes,
      regionNames,
      tooWide: true,
      totalReturned: 0,
      nextCursor: null,
      hasMore: false,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = supabase as any;
  const normQ = sanitizePostgrestToken(normalizeCandidateSearchText(params.q));

  // 1) 화면 내/인접 공식 DB 화장실을 먼저 조회해 현재 뷰포트의 실제 시군구·읍면동·도로명 힌트를 추출
  const officialQuery = client
    .from("restrooms")
    .select("name, road_address, latitude, longitude")
    .eq("publication_status", "published")
    .gte("latitude", params.bounds.south - 0.01)
    .lte("latitude", params.bounds.north + 0.01)
    .gte("longitude", params.bounds.west - 0.01)
    .lte("longitude", params.bounds.east + 0.01)
    .limit(300);

  const offRes = await officialQuery;
  const officials = ((offRes.data || []) as OfficialRowHint[]).filter(
    (o) => typeof o.name === "string"
  );
  const hints = buildViewportOfficialHints(officials, params.bounds);
  const { ranked: regions, scores: regionScores } = rankRegionsForViewport(
    regionResult.regions,
    params.bounds,
    hints.sigunguCounts
  );

  const regionCodes = regions.map((r) => r.sigunguCode);
  const regionNames = regions.map((r) => `${r.sidoName} ${r.sigunguName}`);
  const topRegionScore = regionScores.get(regionCodes[0]) ?? 0;

  // 경계 영역에서 1개 시군구에 쏠리지 않도록 공식 핀이 확인되었거나 교차 비율이 높은 시군구(최대 3개)를 primaryCodes로 포함
  const primaryCodes = regions
    .filter((r, idx) => {
      if (idx === 0) return true;
      if (idx >= 3) return false;
      const sc = regionScores.get(r.sigunguCode) ?? 0;
      const officialHit = hints.sigunguCounts.get(compactRegionToken(r.sigunguName)) ?? 0;
      const overlap = computeRegionOverlapRatio(r, params.bounds);
      if (hints.sigunguCounts.size > 0 && officialHit === 0) {
        return false;
      }
      return officialHit > 0 || overlap >= 0.35 || (topRegionScore > 0 && sc >= topRegionScore * 0.55);
    })
    .map((r) => r.sigunguCode);
  const adjacentCodes = regionCodes.filter((c) => !primaryCodes.includes(c));

  const hintedDongs = Array.from(hints.dongWeights.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 16)
    .map(([dong]) => dong);

  const excludeArr = Array.from(excludeSet).slice(0, 220);

  const buildCandidateQuery = (
    codes: string[],
    maxRows: number,
    emdFilter?: string[]
  ) => {
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
      .in("sigungu_code", codes);

    if (emdFilter && emdFilter.length > 0) {
      q = q.in("eupmyeondong_name", emdFilter);
    }

    if (excludeArr.length > 0 && typeof q.not === "function") {
      const serialized = `(${excludeArr.map((id) => `"${id.replace(/"/g, "")}"`).join(",")})`;
      q = q.not("id", "in", serialized);
    }

    q = q
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

  const perPrimaryLimit = Math.min(Math.max((limit + offset) * 4, 80), 150);
  const emdFetchLimit = Math.min(Math.max((limit + offset) * 3, 60), 150);
  const adjacentFetchLimit = Math.min(limit * 2, 60);

  // 시군구 코드 사전순 쏠림(예: 11220 < 11230)을 막기 위해 primaryCodes 각각을 독립 조회
  const primaryQueries = primaryCodes.map((code) =>
    buildCandidateQuery([code], perPrimaryLimit)
  );
  const [primaryResults, emdRes, adjacentRes] = await Promise.all([
    Promise.all(primaryQueries),
    hintedDongs.length > 0
      ? buildCandidateQuery(primaryCodes, emdFetchLimit, hintedDongs)
      : Promise.resolve({ data: [], error: null }),
    adjacentCodes.length > 0 && primaryCodes.length === 1
      ? buildCandidateQuery(adjacentCodes, adjacentFetchLimit)
      : Promise.resolve({ data: [], error: null }),
  ]);

  for (const res of primaryResults) {
    if (res.error) {
      throw new Error(`후보 화장실 인덱스 조회 실패: ${res.error.message}`);
    }
  }
  if (emdRes.error) {
    throw new Error(`읍면동 우선 후보 조회 실패: ${emdRes.error.message}`);
  }
  if (adjacentRes.error) {
    throw new Error(`인접 후보 화장실 인덱스 조회 실패: ${adjacentRes.error.message}`);
  }

  const regionOrder = new Map(regionCodes.map((c, idx) => [c, idx]));
  const combinedRaw = [
    ...((emdRes.data || []) as Array<Record<string, unknown>>),
    ...primaryResults.flatMap(
      (res) => (res.data || []) as Array<Record<string, unknown>>
    ),
    ...((adjacentRes.data || []) as Array<Record<string, unknown>>),
  ];

  const seenCandidateIds = new Set<string>();
  const scoredPool: Array<{
    item: PublicRestroomCandidateSummary;
    score: number;
  }> = [];

  for (const row of combinedRaw) {
    const candId = String(row.id);
    if (excludeSet.has(candId) || seenCandidateIds.has(candId)) continue;
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

    scoredPool.push({
      item: mapped,
      score: scoreCandidateRelevance(mapped, hints, regionOrder),
    });
  }

  scoredPool.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const rankA = regionOrder.get(a.item.sigungu_code) ?? 999;
    const rankB = regionOrder.get(b.item.sigungu_code) ?? 999;
    if (rankA !== rankB) return rankA - rankB;
    return a.item.id.localeCompare(b.item.id);
  });

  // 복수 교차 시군구 경계일 때 상위 스코어 후보들을 시군구별로 균형 인터리빙
  let orderedItems: PublicRestroomCandidateSummary[];
  if (primaryCodes.length >= 2) {
    const buckets = new Map<string, PublicRestroomCandidateSummary[]>();
    for (const entry of scoredPool) {
      const list = buckets.get(entry.item.sigungu_code) ?? [];
      list.push(entry.item);
      buckets.set(entry.item.sigungu_code, list);
    }
    const bucketKeys = [
      ...primaryCodes.filter((c) => (buckets.get(c)?.length ?? 0) > 0),
      ...adjacentCodes.filter((c) => (buckets.get(c)?.length ?? 0) > 0),
    ];
    orderedItems = [];
    const pointers = new Map(bucketKeys.map((k) => [k, 0]));
    while (orderedItems.length < scoredPool.length) {
      let addedInRound = false;
      for (const k of bucketKeys) {
        const list = buckets.get(k);
        const ptr = pointers.get(k) ?? 0;
        if (list && ptr < list.length) {
          orderedItems.push(list[ptr]);
          pointers.set(k, ptr + 1);
          addedInRound = true;
        }
      }
      if (!addedInRound) break;
    }
  } else {
    orderedItems = scoredPool.map((e) => e.item);
  }

  const pagedItems = (
    deferSet.size > 0
      ? [
          ...orderedItems.filter((item) => !deferSet.has(item.id)),
          ...orderedItems.filter((item) => deferSet.has(item.id)),
        ]
      : orderedItems
  ).slice(offset, offset + limit);
  const nextOffset = offset + pagedItems.length;
  const hitPrimaryCap = primaryResults.some(
    (res) => (res.data?.length ?? 0) >= perPrimaryLimit
  );
  const hasMore =
    nextOffset < orderedItems.length ||
    (hitPrimaryCap && pagedItems.length === limit);

  const nextCursor = hasMore
    ? excludeSet.size === 0 && deferSet.size === 0
      ? `o:${nextOffset}`
      : `o:0:x:${excludeSet.size}`
    : null;

  return {
    items: pagedItems,
    regionCodes,
    regionNames,
    tooWide: false,
    totalReturned: pagedItems.length,
    nextCursor,
    hasMore,
  };
}
