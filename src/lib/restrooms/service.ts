import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";
import { createAdminClient, isServiceRoleConfigured } from "@/lib/supabase/server";
import { createSignedPhotoReadUrlMap } from "./photo-urls";
import type {
  AccessMode,
  PublicBusinessInfo,
  PublicDataSourceSummary,
  PublicRestroomAccessPolicy,
  PublicRestroomDetail,
  PublicRestroomHour,
  PublicRestroomHourException,
  PublicRestroomPhoto,
  PublicRestroomSummary,
} from "./types";
import {
  DEFAULT_NEARBY_RADIUS_M,
  MAX_NEARBY_RADIUS_M,
  parseBBoxString,
} from "./validation";

export const PARTNER_DISCOVERY_FLAG_KEY = "partner_restroom_discovery";

export interface PublicCatalogQueryOptions {
  /**
   * Server-only elevated client (service_role) used strictly to verify
   * `businesses.registration_status = 'approved'` and read allowlisted public business fields.
   */
  businessClient?: SupabaseClient<Database>;
  /**
   * Optional override for `partner_restroom_discovery` flag (for testing).
   */
  partnerDiscoveryEnabled?: boolean;
}

export interface ListPublicRestroomsParams {
  bbox?: string;
  centerLat?: number;
  centerLng?: number;
  radiusM?: number;
  type: "all" | "public" | "partner";
  limit: number;
  offset: number;
}

export interface ListPublicRestroomsResult {
  items: PublicRestroomSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface SearchPublicRestroomsParams {
  q: string;
  type: "all" | "public" | "partner";
  limit: number;
}

export interface SearchPublicRestroomsResult {
  items: PublicRestroomSummary[];
  total: number;
  limit: number;
}

const PUBLIC_RESTROOM_SUMMARY_COLUMNS =
  "id, type, name, road_address, address_detail, latitude, longitude, access_method, gender_type, wheelchair_accessible, baby_changing_available, sanitary_products_available, last_verified_at, business_id, coordinate_source, coordinate_type, coordinate_verification_status";

const PUBLIC_APPROVED_OFFICIAL_SOURCES = new Set<string>([
  "seoul_public_toilet_info",
  "seoul_metro_2026",
  "seoul_park_public_toilet",
  "incheon_district_public_toilet",
  "gyeonggi_city_public_toilet",
  "jeonbuk_public_toilet",
  "gwangju_public_toilet",
  "busan_district_public_toilet",
  "jeju_public_toilet",
  "daejeon_public_toilet",
  "ulsan_public_toilet",
  "chungbuk_public_toilet",
  "knps_national_park_toilet",
  "mois_bike_trail_toilet",
  "mof_beach_toilet",
  "kex_highway_rest_area_toilet",
  "admin_manual",
]);

const BLOCKED_COORDINATE_SOURCES = new Set<string>([
  "kakao_geocode",
  "mois_address_nav_db",
  "mois_address_summary_db",
]);

const BLOCKED_COORDINATE_TYPES = new Set<string>([
  "building_centroid",
  "main_entrance",
  "complex_centroid_mean",
  "geocoded",
]);

/**
 * Runtime/service-layer coordinate exposure guard aligned with
 * `public.is_restroom_coordinate_publicly_allowed` in migration `20261125000000`.
 *
 * Ensures unconfirmed MOIS coordinates, Kakao geocoding coordinates, and newly
 * imported rows with `publication_status = 'published'` alone cannot leak if
 * verification metadata is unverified or non-official, while keeping legacy Suwon
 * 502 public rows and existing partner rows intact.
 */
export function isRestroomCoordinatePubliclyAllowed(row: {
  type?: string | null;
  coordinate_source?: string | null;
  coordinate_type?: string | null;
  coordinate_verification_status?: string | null;
}): boolean {
  const src = row.coordinate_source;
  const ctype = row.coordinate_type;
  const vstatus = row.coordinate_verification_status;

  if (typeof src === "string" && BLOCKED_COORDINATE_SOURCES.has(src)) {
    return false;
  }
  if (typeof ctype === "string" && BLOCKED_COORDINATE_TYPES.has(ctype)) {
    return false;
  }

  if (row.type === "partner") {
    return true;
  }

  if (row.type !== "public") {
    return false;
  }

  // Legacy unit-test mocks or pre-20261125 RPC responses that omit all three
  // metadata keys fall through safely; real DB selects always include these keys
  // (as string or null) and SQL RPC enforces the predicate directly in DB.
  const hasMetadataKeys =
    "coordinate_source" in row ||
    "coordinate_type" in row ||
    "coordinate_verification_status" in row;
  if (!hasMetadataKeys) {
    return true;
  }

  if (src === "gg_publtolt_15011425") {
    return (
      (ctype == null || ctype === "facility_official") &&
      (vstatus == null || vstatus === "VERIFIED")
    );
  }

  if (typeof src === "string" && PUBLIC_APPROVED_OFFICIAL_SOURCES.has(src)) {
    return ctype === "facility_official" && vstatus === "VERIFIED";
  }

  return false;
}

function resolveBusinessClient(
  callerClient: SupabaseClient<Database>,
  options?: PublicCatalogQueryOptions
): SupabaseClient<Database> {
  if (options?.businessClient) {
    return options.businessClient;
  }
  if (isServiceRoleConfigured()) {
    return createAdminClient();
  }
  return callerClient;
}

function hasValidCoordinates(lat: unknown, lng: unknown): lat is number {
  return (
    typeof lat === "number" &&
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90 &&
    typeof lng === "number" &&
    Number.isFinite(lng) &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * Check whether `partner_restroom_discovery` feature flag is enabled.
 * Fails closed (returns false) when the flag row is missing or query fails.
 * Public restrooms must NEVER be gated by this flag.
 */
export async function isPartnerRestroomDiscoveryEnabled(
  supabase: SupabaseClient<Database>
): Promise<boolean> {
  try {
    const { data, error } = await (supabase as any)
      .from("feature_flags")
      .select("enabled")
      .eq("key", PARTNER_DISCOVERY_FLAG_KEY)
      .maybeSingle();

    if (error) {
      console.error(
        `[isPartnerRestroomDiscoveryEnabled] Failed to read feature flag:`,
        error
      );
      return false;
    }

    return data?.enabled === true;
  } catch (error) {
    console.error(
      `[isPartnerRestroomDiscoveryEnabled] Unexpected error reading feature flag:`,
      error
    );
    return false;
  }
}

async function resolvePartnerDiscoveryFlag(
  supabase: SupabaseClient<Database>,
  type: "all" | "public" | "partner",
  options?: PublicCatalogQueryOptions
): Promise<boolean> {
  if (type === "public") return false;
  return typeof options?.partnerDiscoveryEnabled === "boolean"
    ? options.partnerDiscoveryEnabled
    : isPartnerRestroomDiscoveryEnabled(supabase);
}

async function resolveApprovedBusinessMap(
  supabase: SupabaseClient<Database>,
  businessIds: string[],
  options?: PublicCatalogQueryOptions
): Promise<Map<string, { id: string; name: string }> | null> {
  const uniqueIds = Array.from(new Set(businessIds.filter(Boolean)));
  const approvedBizMap = new Map<string, { id: string; name: string }>();
  if (uniqueIds.length === 0) {
    return approvedBizMap;
  }

  const bizClient = resolveBusinessClient(supabase, options);
  const { data: bizData, error: bizError } = await (bizClient as any)
    .from("businesses")
    .select("id, name, registration_status")
    .in("id", uniqueIds)
    .eq("registration_status", "approved");

  if (bizError) {
    console.error(
      "[resolveApprovedBusinessMap] Failed to verify partner businesses:",
      bizError
    );
    return null;
  }

  if (bizData) {
    for (const b of bizData) {
      if (b.registration_status === undefined || b.registration_status === "approved") {
        approvedBizMap.set(b.id, { id: b.id, name: b.name });
      }
    }
  }
  return approvedBizMap;
}

async function countUnapprovedPartnerRestroomsInBBox(
  supabase: SupabaseClient<Database>,
  bounds: { south: number; west: number; north: number; east: number },
  options?: PublicCatalogQueryOptions
): Promise<{ unapprovedCount: number; approvedIds: Set<string> } | null> {
  const PAGE_SIZE = 1000;
  const partnerRows: Array<{ id: string; business_id: string | null }> = [];
  let offset = 0;

  while (true) {
    const { data, error } = await (supabase as any)
      .from("restrooms")
      .select("id, business_id")
      .eq("publication_status", "published")
      .eq("type", "partner")
      .gte("latitude", bounds.south)
      .lte("latitude", bounds.north)
      .gte("longitude", bounds.west)
      .lte("longitude", bounds.east)
      .not("latitude", "is", null)
      .not("longitude", "is", null)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error || !Array.isArray(data)) {
      return null;
    }

    partnerRows.push(...data);
    if (data.length < PAGE_SIZE) {
      break;
    }
    offset += PAGE_SIZE;
  }

  if (partnerRows.length === 0) {
    return { unapprovedCount: 0, approvedIds: new Set() };
  }

  const bizIds = partnerRows
    .map((r) => r.business_id)
    .filter((id): id is string => Boolean(id));
  const approvedMap = await resolveApprovedBusinessMap(supabase, bizIds, options);
  if (!approvedMap) {
    return null;
  }

  const approvedIds = new Set(approvedMap.keys());
  let unapprovedCount = 0;
  for (const r of partnerRows) {
    if (!r.business_id || !approvedIds.has(r.business_id)) {
      unapprovedCount += 1;
    }
  }

  return { unapprovedCount, approvedIds };
}

function resolveCatalogTotal(
  rawTotal: number | null | undefined,
  rawRowCount: number,
  hydratedCount: number,
  limit: number,
  offset: number,
  bboxUnapprovedPartnerInfo?: {
    unapprovedCount: number;
    currentPageUnapprovedPartnerCount: number;
  }
): number {
  const filteredOutCount = Math.max(0, rawRowCount - hydratedCount);
  if (offset === 0 && rawRowCount < limit) {
    return hydratedCount;
  }
  if (typeof rawTotal === "number" && Number.isFinite(rawTotal)) {
    if (bboxUnapprovedPartnerInfo) {
      const otherFilteredOnPage = Math.max(
        0,
        filteredOutCount - bboxUnapprovedPartnerInfo.currentPageUnapprovedPartnerCount
      );
      return Math.max(
        hydratedCount,
        rawTotal - bboxUnapprovedPartnerInfo.unapprovedCount - otherFilteredOnPage
      );
    }
    return Math.max(hydratedCount, rawTotal - filteredOutCount);
  }
  return hydratedCount;
}

/**
 * List publicly visible restrooms within radius (default 400m) of a search center,
 * filtered by publication/business-approval/flag policy BEFORE distance sorting and LIMIT.
 */
export async function listNearbyPublicRestrooms(
  supabase: SupabaseClient<Database>,
  params: {
    centerLat: number;
    centerLng: number;
    radiusM?: number;
    type: "all" | "public" | "partner";
    limit: number;
    offset: number;
  },
  options?: PublicCatalogQueryOptions
): Promise<ListPublicRestroomsResult> {
  const partnerDiscoveryEnabled = await resolvePartnerDiscoveryFlag(
    supabase,
    params.type,
    options
  );

  if (params.type === "partner" && !partnerDiscoveryEnabled) {
    return {
      items: [],
      total: 0,
      limit: params.limit,
      offset: params.offset,
    };
  }

  const effectiveType =
    params.type === "all" && !partnerDiscoveryEnabled ? "public" : params.type;
  const radiusM = Math.min(
    MAX_NEARBY_RADIUS_M,
    Math.max(1, Math.trunc(params.radiusM ?? DEFAULT_NEARBY_RADIUS_M))
  );

  const { data: rows, error } = await (supabase as any).rpc(
    "list_nearby_public_restrooms",
    {
      p_center_lat: params.centerLat,
      p_center_lng: params.centerLng,
      p_radius_m: radiusM,
      p_type: effectiveType,
      p_limit: params.limit,
      p_offset: params.offset,
    }
  );

  if (error) {
    throw error;
  }

  if (!rows || rows.length === 0) {
    return {
      items: [],
      total: 0,
      limit: params.limit,
      offset: params.offset,
    };
  }

  const distanceMap = new Map<string, number>();
  for (const r of rows) {
    if (typeof r.id === "string" && typeof r.distance_meters === "number") {
      distanceMap.set(r.id, r.distance_meters);
    }
  }

  const rawTotalValue = rows[0]?.total_count;
  const parsedRawTotal =
    typeof rawTotalValue === "number"
      ? rawTotalValue
      : typeof rawTotalValue === "string"
        ? Number(rawTotalValue)
        : null;

  const hydrated = await hydratePublicRestroomSummaries(
    supabase,
    rows,
    partnerDiscoveryEnabled,
    options
  );

  const items: PublicRestroomSummary[] = hydrated.map((item) => {
    const dist = distanceMap.get(item.id);
    return dist !== undefined ? { ...item, distance_meters: dist } : item;
  });

  return {
    items,
    total: resolveCatalogTotal(
      parsedRawTotal,
      rows.length,
      items.length,
      params.limit,
      params.offset
    ),
    limit: params.limit,
    offset: params.offset,
  };
}

/**
 * List publicly visible restrooms within a bounding box or nearby center radius.
 * Excludes draft/pending/suspended/archived restrooms, unlocated (null coords) restrooms,
 * restrooms of non-approved businesses, and partner restrooms when `partner_restroom_discovery` is disabled.
 */
export async function listPublicRestrooms(
  supabase: SupabaseClient<Database>,
  params: ListPublicRestroomsParams,
  options?: PublicCatalogQueryOptions
): Promise<ListPublicRestroomsResult> {
  if (
    typeof params.centerLat === "number" &&
    typeof params.centerLng === "number"
  ) {
    return listNearbyPublicRestrooms(
      supabase,
      {
        centerLat: params.centerLat,
        centerLng: params.centerLng,
        radiusM: params.radiusM,
        type: params.type,
        limit: params.limit,
        offset: params.offset,
      },
      options
    );
  }

  if (!params.bbox) {
    throw new Error("bbox or centerLat/centerLng is required.");
  }

  const { south, west, north, east } = parseBBoxString(params.bbox);

  // Public restroom discovery is never affected by partner_restroom_discovery
  const partnerDiscoveryEnabled = await resolvePartnerDiscoveryFlag(
    supabase,
    params.type,
    options
  );

  if (params.type === "partner" && !partnerDiscoveryEnabled) {
    return {
      items: [],
      total: 0,
      limit: params.limit,
      offset: params.offset,
    };
  }

  let query = (supabase as any)
    .from("restrooms")
    .select(PUBLIC_RESTROOM_SUMMARY_COLUMNS, { count: "exact" })
    .eq("publication_status", "published")
    .gte("latitude", south)
    .lte("latitude", north)
    .gte("longitude", west)
    .lte("longitude", east)
    .not("latitude", "is", null)
    .not("longitude", "is", null);

  if (params.type === "public" || (params.type === "all" && !partnerDiscoveryEnabled)) {
    query = query.eq("type", "public");
  } else if (params.type === "partner") {
    query = query.eq("type", "partner");
  }

  const { data: rows, count, error } = await query
    .order("id", { ascending: true })
    .range(params.offset, params.offset + params.limit - 1);

  if (error) {
    throw error;
  }

  if (!rows || rows.length === 0) {
    let emptyPageTotal = count ?? 0;
    if (
      partnerDiscoveryEnabled &&
      params.type !== "public" &&
      typeof count === "number" &&
      count > 0
    ) {
      const partnerStats = await countUnapprovedPartnerRestroomsInBBox(
        supabase,
        { south, west, north, east },
        options
      );
      if (partnerStats) {
        emptyPageTotal = Math.max(0, count - partnerStats.unapprovedCount);
      }
    }
    return {
      items: [],
      total: emptyPageTotal,
      limit: params.limit,
      offset: params.offset,
    };
  }

  const items = await hydratePublicRestroomSummaries(
    supabase,
    rows,
    partnerDiscoveryEnabled,
    options
  );

  let bboxUnapprovedPartnerInfo:
    | {
        unapprovedCount: number;
        currentPageUnapprovedPartnerCount: number;
      }
    | undefined;

  const isMultiPage =
    params.offset > 0 ||
    rows.length >= params.limit ||
    (typeof count === "number" && count > rows.length);

  if (partnerDiscoveryEnabled && params.type !== "public" && isMultiPage) {
    const partnerStats = await countUnapprovedPartnerRestroomsInBBox(
      supabase,
      { south, west, north, east },
      options
    );
    if (partnerStats) {
      const currentPageUnapprovedPartnerCount = rows.filter(
        (r: any) =>
          r.type === "partner" &&
          (!r.business_id || !partnerStats.approvedIds.has(r.business_id))
      ).length;
      bboxUnapprovedPartnerInfo = {
        unapprovedCount: partnerStats.unapprovedCount,
        currentPageUnapprovedPartnerCount,
      };
    }
  }

  return {
    items,
    total: resolveCatalogTotal(
      count,
      rows.length,
      items.length,
      params.limit,
      params.offset,
      bboxUnapprovedPartnerInfo
    ),
    limit: params.limit,
    offset: params.offset,
  };
}

/**
 * Verify approved partner businesses, filter out non-published or invalid-coord rows,
 * and batch-hydrate active policies & primary approved photos.
 */
async function hydratePublicRestroomSummaries(
  supabase: SupabaseClient<Database>,
  rows: any[],
  partnerDiscoveryEnabled: boolean,
  options?: PublicCatalogQueryOptions
): Promise<PublicRestroomSummary[]> {
  // Defense-in-depth: Verify partner business is approved via server-only allowlist lookup
  // (`businesses` table denies direct SELECT to anon and non-member authenticated callers)
  const partnerBizIds = partnerDiscoveryEnabled
    ? Array.from(
        new Set(
          rows
            .filter((r: any) => r.type === "partner" && r.business_id)
            .map((r: any) => r.business_id as string)
        )
      )
    : [];

  const approvedBizMap =
    (await resolveApprovedBusinessMap(supabase, partnerBizIds, options)) ??
    new Map<string, { id: string; name: string }>();

  // Filter out unpublished rows, invalid coordinates, unverified/prohibited coordinate sources,
  // and partner restrooms whose business is NOT approved
  const validRows = rows.filter((r: any) => {
    if (
      r.publication_status !== undefined &&
      r.publication_status !== "published"
    ) {
      return false;
    }
    if (!hasValidCoordinates(r.latitude, r.longitude)) {
      return false;
    }
    if (!isRestroomCoordinatePubliclyAllowed(r)) {
      return false;
    }
    if (r.type === "public") return true;
    if (r.type === "partner") {
      return (
        partnerDiscoveryEnabled &&
        Boolean(r.business_id) &&
        approvedBizMap.has(r.business_id)
      );
    }
    return false;
  });

  const restroomIds = validRows.map((r: any) => r.id);

  // Batch fetch active access policies
  const policyMap = new Map<
    string,
    { access_mode: AccessMode; deposit_amount_krw: number | null }
  >();
  if (restroomIds.length > 0) {
    const { data: policies } = await (supabase as any)
      .from("restroom_access_policies")
      .select("restroom_id, access_mode, deposit_amount_krw")
      .in("restroom_id", restroomIds)
      .eq("is_active", true);

    if (policies) {
      for (const p of policies) {
        policyMap.set(p.restroom_id, {
          access_mode: p.access_mode,
          deposit_amount_krw: p.deposit_amount_krw,
        });
      }
    }
  }

  // Batch fetch primary approved photos
  const photoMap = new Map<string, string>();
  if (restroomIds.length > 0) {
    const { data: photos } = await (supabase as any)
      .from("restroom_photos")
      .select("restroom_id, storage_path")
      .in("restroom_id", restroomIds)
      .eq("moderation_status", "approved")
      .eq("is_primary", true);

    if (photos) {
      for (const ph of photos) {
        photoMap.set(ph.restroom_id, ph.storage_path);
      }
    }
  }

  const signedPhotoMap = await createSignedPhotoReadUrlMap(
    Array.from(photoMap.values())
  );

  return validRows.map((r: any) => {
    const policy = policyMap.get(r.id);
    const photoStoragePath = photoMap.get(r.id);
    const biz = r.business_id ? approvedBizMap.get(r.business_id) : undefined;

    return {
      id: r.id,
      type: r.type,
      name: r.name,
      road_address: r.road_address,
      address_detail: r.address_detail,
      latitude: r.latitude as number,
      longitude: r.longitude as number,
      access_method: r.access_method,
      gender_type: r.gender_type,
      wheelchair_accessible: r.wheelchair_accessible,
      baby_changing_available: r.baby_changing_available,
      sanitary_products_available: r.sanitary_products_available,
      last_verified_at: r.last_verified_at,
      business_id: r.business_id,
      business_name: biz ? biz.name : null,
      deposit_amount_krw: policy ? policy.deposit_amount_krw : null,
      access_mode: policy ? policy.access_mode : null,
      primary_photo_storage_path: photoStoragePath ?? null,
      primary_photo_url: photoStoragePath
        ? signedPhotoMap.get(photoStoragePath) ?? null
        : null,
    };
  });
}

function normalizeSearchKeyword(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

/**
 * Search publicly visible restrooms by name (for map search integration),
 * and for approved partner restrooms also matches approved business names and
 * whitespace-normalized names when `partner_restroom_discovery` is enabled.
 * Strictly excludes draft/pending/suspended/archived restrooms, restrooms without valid coords,
 * partner restrooms of non-approved businesses, and partner restrooms when `partner_restroom_discovery` is disabled.
 */
export async function searchPublicRestroomsByName(
  supabase: SupabaseClient<Database>,
  params: SearchPublicRestroomsParams,
  options?: PublicCatalogQueryOptions
): Promise<SearchPublicRestroomsResult> {
  const trimmed = params.q.trim();
  const compactQ = normalizeSearchKeyword(trimmed);
  if (!trimmed || !compactQ) {
    return { items: [], total: 0, limit: params.limit };
  }

  let partnerDiscoveryEnabled = false;
  if (params.type !== "public") {
    partnerDiscoveryEnabled =
      typeof options?.partnerDiscoveryEnabled === "boolean"
        ? options.partnerDiscoveryEnabled
        : await isPartnerRestroomDiscoveryEnabled(supabase);
  }

  if (params.type === "partner" && !partnerDiscoveryEnabled) {
    return { items: [], total: 0, limit: params.limit };
  }

  const escapedQ = trimmed.replace(/[\\%_]/g, "\\$&");
  const fetchLimit = Math.min(params.limit * 3, 60);

  let query = (supabase as any)
    .from("restrooms")
    .select(PUBLIC_RESTROOM_SUMMARY_COLUMNS)
    .eq("publication_status", "published")
    .not("latitude", "is", null)
    .not("longitude", "is", null)
    .ilike("name", `%${escapedQ}%`);

  if (params.type === "public" || (params.type === "all" && !partnerDiscoveryEnabled)) {
    query = query.eq("type", "public");
  } else if (params.type === "partner") {
    query = query.eq("type", "partner");
  }

  const { data: directRows, error } = await query
    .order("name", { ascending: true })
    .limit(fetchLimit);

  if (error) {
    throw error;
  }

  const mergedRows: any[] = Array.isArray(directRows) ? [...directRows] : [];
  const seenIds = new Set<string>(mergedRows.map((r) => r?.id).filter(Boolean));

  // For approved partner restrooms, also match whitespace-normalized restroom names
  // and approved business names (e.g. searching "진미통닭" finds "진미 통닭").
  if (partnerDiscoveryEnabled && params.type !== "public") {
    const matchedBizIds = new Set<string>();
    const bizClient = resolveBusinessClient(supabase, options);
    const { data: approvedBusinesses, error: bizError } = await (bizClient as any)
      .from("businesses")
      .select("id, name, registration_status")
      .eq("registration_status", "approved");

    if (!bizError && Array.isArray(approvedBusinesses)) {
      for (const b of approvedBusinesses) {
        if (
          b?.id &&
          (b.registration_status === undefined || b.registration_status === "approved") &&
          typeof b.name === "string" &&
          normalizeSearchKeyword(b.name).includes(compactQ)
        ) {
          matchedBizIds.add(b.id);
        }
      }
    }

    const { data: partnerRows, error: partnerError } = await (supabase as any)
      .from("restrooms")
      .select(PUBLIC_RESTROOM_SUMMARY_COLUMNS)
      .eq("publication_status", "published")
      .eq("type", "partner")
      .not("latitude", "is", null)
      .not("longitude", "is", null)
      .order("name", { ascending: true })
      .limit(200);

    if (!partnerError && Array.isArray(partnerRows)) {
      for (const r of partnerRows) {
        if (!r?.id || seenIds.has(r.id)) continue;
        const nameMatches =
          typeof r.name === "string" &&
          normalizeSearchKeyword(r.name).includes(compactQ);
        const businessMatches =
          typeof r.business_id === "string" && matchedBizIds.has(r.business_id);
        if (nameMatches || businessMatches) {
          seenIds.add(r.id);
          mergedRows.push(r);
        }
      }
    }
  }

  if (mergedRows.length === 0) {
    return { items: [], total: 0, limit: params.limit };
  }

  const hydrated = await hydratePublicRestroomSummaries(
    supabase,
    mergedRows,
    partnerDiscoveryEnabled,
    options
  );
  const items = hydrated.slice(0, params.limit);

  return {
    items,
    total: items.length,
    limit: params.limit,
  };
}

/**
 * Retrieve public details of a single restroom.
 * Returns null if the restroom is non-existent, unapproved, draft, missing valid coordinates,
 * belongs to a non-approved business, or is a partner restroom when `partner_restroom_discovery` is disabled.
 * NEVER leaks PIN, payment secret keys, or internal private notes.
 */
export async function getPublicRestroomDetail(
  supabase: SupabaseClient<Database>,
  id: string,
  options?: PublicCatalogQueryOptions
): Promise<PublicRestroomDetail | null> {
  const { data: restroom, error } = await (supabase as any)
    .from("restrooms")
    .select(
      "id, type, name, description, road_address, address_detail, latitude, longitude, floor, entrance_instructions, gender_type, wheelchair_accessible, baby_changing_available, sanitary_products_available, access_method, publication_status, last_verified_at, source_id, coordinate_source_id, business_id, coordinate_source, coordinate_type, coordinate_verification_status, created_at, updated_at"
    )
    .eq("id", id)
    .eq("publication_status", "published")
    .maybeSingle();

  if (error || !restroom) {
    return null;
  }

  if (
    restroom.publication_status !== undefined &&
    restroom.publication_status !== "published"
  ) {
    return null;
  }

  if (!hasValidCoordinates(restroom.latitude, restroom.longitude)) {
    return null;
  }

  if (!isRestroomCoordinatePubliclyAllowed(restroom)) {
    return null;
  }

  let publicBusiness: PublicBusinessInfo | null = null;
  if (restroom.type === "partner") {
    const partnerDiscoveryEnabled =
      typeof options?.partnerDiscoveryEnabled === "boolean"
        ? options.partnerDiscoveryEnabled
        : await isPartnerRestroomDiscoveryEnabled(supabase);

    if (!partnerDiscoveryEnabled) {
      return null;
    }

    if (!restroom.business_id) {
      return null;
    }

    const bizClient = resolveBusinessClient(supabase, options);
    const { data: biz, error: bizError } = await (bizClient as any)
      .from("businesses")
      .select(
        "id, name, category, description, road_address, jibun_address, address_detail, latitude, longitude, phone, website_url, registration_status"
      )
      .eq("id", restroom.business_id)
      .eq("registration_status", "approved")
      .maybeSingle();

    if (
      bizError ||
      !biz ||
      (biz.registration_status !== undefined && biz.registration_status !== "approved")
    ) {
      if (bizError) {
        console.error(
          "[getPublicRestroomDetail] Failed to verify partner business:",
          bizError
        );
      }
      // If partner business is not approved or suspended, restroom is strictly hidden
      return null;
    }

    publicBusiness = {
      id: biz.id,
      name: biz.name,
      category: biz.category,
      description: biz.description,
      road_address: biz.road_address,
      jibun_address: biz.jibun_address,
      address_detail: biz.address_detail,
      latitude: biz.latitude,
      longitude: biz.longitude,
      phone: biz.phone,
      website_url: biz.website_url,
    };
  }

  // Fetch hours (ordered by weekday, opens_at)
  const { data: hoursData } = await (supabase as any)
    .from("restroom_hours")
    .select("id, weekday, opens_at, closes_at, is_closed, crosses_midnight")
    .eq("restroom_id", id)
    .order("weekday", { ascending: true })
    .order("opens_at", { ascending: true });

  const hours: PublicRestroomHour[] = (hoursData || []).map((h: any) => ({
    id: h.id,
    weekday: h.weekday,
    opens_at: h.opens_at,
    closes_at: h.closes_at,
    is_closed: h.is_closed,
    crosses_midnight: h.crosses_midnight,
  }));

  // Fetch hour exceptions
  const { data: exceptionsData } = await (supabase as any)
    .from("restroom_hour_exceptions")
    .select("id, exception_date, is_closed, opens_at, closes_at, reason")
    .eq("restroom_id", id)
    .order("exception_date", { ascending: true });

  const hour_exceptions: PublicRestroomHourException[] = (exceptionsData || []).map((e: any) => ({
    id: e.id,
    exception_date: e.exception_date,
    is_closed: e.is_closed,
    opens_at: e.opens_at,
    closes_at: e.closes_at,
    reason: e.reason,
  }));

  // Fetch single active access policy
  const { data: policyData } = await (supabase as any)
    .from("restroom_access_policies")
    .select(
      "id, version, access_mode, deposit_amount_krw, refund_eligible, receipt_window_hours, min_purchase_krw, effective_from"
    )
    .eq("restroom_id", id)
    .eq("is_active", true)
    .maybeSingle();

  const active_policy: PublicRestroomAccessPolicy | null = policyData
    ? {
        id: policyData.id,
        version: policyData.version,
        access_mode: policyData.access_mode,
        deposit_amount_krw: policyData.deposit_amount_krw,
        refund_eligible: policyData.refund_eligible,
        receipt_window_hours: policyData.receipt_window_hours,
        min_purchase_krw: policyData.min_purchase_krw,
        effective_from: policyData.effective_from,
      }
    : null;

  // Fetch approved photos only (moderated and approved)
  const { data: photosData } = await (supabase as any)
    .from("restroom_photos")
    .select("id, storage_path, photo_type, is_primary")
    .eq("restroom_id", id)
    .eq("moderation_status", "approved")
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true });

  const signedDetailPhotoMap = await createSignedPhotoReadUrlMap(
    (photosData || []).map((p: any) => p.storage_path)
  );

  const photos: PublicRestroomPhoto[] = (photosData || []).map((p: any) => ({
    id: p.id,
    storage_path: p.storage_path,
    photo_type: p.photo_type,
    is_primary: p.is_primary,
    image_url: signedDetailPhotoMap.get(p.storage_path) ?? null,
  }));

  let dataSource: PublicDataSourceSummary | null = null;
  const targetSourceId = restroom.source_id || restroom.coordinate_source_id || null;
  if (restroom.type === "public" && targetSourceId) {
    try {
      const { data: srcData } = await (supabase as any)
        .from("public_data_sources")
        .select(
          "id, provider_name, dataset_name, source_url, license_name, license_url, attribution_text, last_synced_at"
        )
        .eq("id", targetSourceId)
        .maybeSingle();

      if (srcData && srcData.id) {
        dataSource = {
          id: srcData.id,
          provider_name: srcData.provider_name,
          dataset_name: srcData.dataset_name,
          source_url: srcData.source_url,
          license_name: srcData.license_name ?? null,
          license_url: srcData.license_url ?? null,
          attribution_text: srcData.attribution_text ?? null,
          last_synced_at: srcData.last_synced_at ?? null,
        };
      }
    } catch {
      // Optional public metadata lookup; degrade gracefully in mock/offline contexts
      dataSource = null;
    }
  }

  return {
    id: restroom.id,
    type: restroom.type,
    name: restroom.name,
    description: restroom.description,
    road_address: restroom.road_address,
    address_detail: restroom.address_detail,
    latitude: restroom.latitude,
    longitude: restroom.longitude,
    floor: restroom.floor,
    entrance_instructions: restroom.entrance_instructions,
    gender_type: restroom.gender_type,
    wheelchair_accessible: restroom.wheelchair_accessible,
    baby_changing_available: restroom.baby_changing_available,
    sanitary_products_available: restroom.sanitary_products_available,
    access_method: restroom.access_method,
    last_verified_at: restroom.last_verified_at,
    source_id: restroom.source_id ?? null,
    coordinate_source: restroom.coordinate_source ?? null,
    data_source: dataSource,
    business_id: restroom.business_id,
    business: publicBusiness,
    hours,
    hour_exceptions,
    active_policy,
    photos,
    created_at: restroom.created_at,
    updated_at: restroom.updated_at,
  };
}

/**
 * Retrieve public approved business information (GET /api/v1/businesses/:id).
 * Returns null if the business is non-existent or not in 'approved' status.
 * Excludes sensitive fields (registration_number, review_notes, created_by, approved_by).
 */
export async function getPublicBusinessDetail(
  supabase: SupabaseClient<Database>,
  id: string,
  options?: PublicCatalogQueryOptions
): Promise<PublicBusinessInfo | null> {
  const bizClient = resolveBusinessClient(supabase, options);
  const { data: biz, error } = await (bizClient as any)
    .from("businesses")
    .select(
      "id, name, category, description, road_address, jibun_address, address_detail, latitude, longitude, phone, website_url, registration_status"
    )
    .eq("id", id)
    .eq("registration_status", "approved")
    .maybeSingle();

  if (
    error ||
    !biz ||
    (biz.registration_status !== undefined && biz.registration_status !== "approved")
  ) {
    if (error) {
      console.error(
        "[getPublicBusinessDetail] Failed to query approved business:",
        error
      );
    }
    return null;
  }

  return {
    id: biz.id,
    name: biz.name,
    category: biz.category,
    description: biz.description,
    road_address: biz.road_address,
    jibun_address: biz.jibun_address,
    address_detail: biz.address_detail,
    latitude: biz.latitude,
    longitude: biz.longitude,
    phone: biz.phone,
    website_url: biz.website_url,
  };
}

