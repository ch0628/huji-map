import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";
import { createAdminClient, isServiceRoleConfigured } from "@/lib/supabase/server";
import type {
  AccessMode,
  PublicBusinessInfo,
  PublicRestroomAccessPolicy,
  PublicRestroomDetail,
  PublicRestroomHour,
  PublicRestroomHourException,
  PublicRestroomPhoto,
  PublicRestroomSummary,
} from "./types";
import { parseBBoxString } from "./validation";

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
  bbox: string;
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
  "id, type, name, road_address, address_detail, latitude, longitude, access_method, gender_type, wheelchair_accessible, baby_changing_available, sanitary_products_available, last_verified_at, business_id";

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

/**
 * List publicly visible restrooms within a bounding box (for map search and catalog).
 * Excludes draft/pending/suspended/archived restrooms, unlocated (null coords) restrooms,
 * restrooms of non-approved businesses, and partner restrooms when `partner_restroom_discovery` is disabled.
 */
export async function listPublicRestrooms(
  supabase: SupabaseClient<Database>,
  params: ListPublicRestroomsParams,
  options?: PublicCatalogQueryOptions
): Promise<ListPublicRestroomsResult> {
  const { south, west, north, east } = parseBBoxString(params.bbox);

  // Public restroom discovery is never affected by partner_restroom_discovery
  let partnerDiscoveryEnabled = false;
  if (params.type !== "public") {
    partnerDiscoveryEnabled =
      typeof options?.partnerDiscoveryEnabled === "boolean"
        ? options.partnerDiscoveryEnabled
        : await isPartnerRestroomDiscoveryEnabled(supabase);
  }

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
    return {
      items: [],
      total: count ?? 0,
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

  return {
    items,
    total: items.length === rows.length ? (count ?? items.length) : items.length,
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

  const approvedBizMap = new Map<string, { id: string; name: string }>();
  if (partnerBizIds.length > 0) {
    const bizClient = resolveBusinessClient(supabase, options);
    const { data: bizData, error: bizError } = await (bizClient as any)
      .from("businesses")
      .select("id, name, registration_status")
      .in("id", partnerBizIds)
      .eq("registration_status", "approved");

    if (bizError) {
      console.error(
        "[hydratePublicRestroomSummaries] Failed to verify partner businesses:",
        bizError
      );
    } else if (bizData) {
      for (const b of bizData) {
        if (b.registration_status === undefined || b.registration_status === "approved") {
          approvedBizMap.set(b.id, { id: b.id, name: b.name });
        }
      }
    }
  }

  // Filter out unpublished rows, invalid coordinates, and partner restrooms whose business is NOT approved
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
    };
  });
}

/**
 * Search publicly visible restrooms by name (for map search integration).
 * Strictly excludes draft/pending/suspended/archived restrooms, restrooms without valid coords,
 * partner restrooms of non-approved businesses, and partner restrooms when `partner_restroom_discovery` is disabled.
 */
export async function searchPublicRestroomsByName(
  supabase: SupabaseClient<Database>,
  params: SearchPublicRestroomsParams,
  options?: PublicCatalogQueryOptions
): Promise<SearchPublicRestroomsResult> {
  const trimmed = params.q.trim();
  if (!trimmed) {
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

  const { data: rows, error } = await query
    .order("name", { ascending: true })
    .limit(fetchLimit);

  if (error) {
    throw error;
  }

  if (!rows || rows.length === 0) {
    return { items: [], total: 0, limit: params.limit };
  }

  const hydrated = await hydratePublicRestroomSummaries(
    supabase,
    rows,
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
      "id, type, name, description, road_address, address_detail, latitude, longitude, floor, entrance_instructions, gender_type, wheelchair_accessible, baby_changing_available, sanitary_products_available, access_method, publication_status, last_verified_at, business_id, created_at, updated_at"
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

  const photos: PublicRestroomPhoto[] = (photosData || []).map((p: any) => ({
    id: p.id,
    storage_path: p.storage_path,
    photo_type: p.photo_type,
    is_primary: p.is_primary,
  }));

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

