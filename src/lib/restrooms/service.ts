import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";
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

/**
 * List publicly visible restrooms within a bounding box (for map search and catalog).
 * Excludes draft/pending restrooms, unlocated (null coords) restrooms, and restrooms of suspended businesses.
 */
export async function listPublicRestrooms(
  supabase: SupabaseClient<Database>,
  params: ListPublicRestroomsParams
): Promise<ListPublicRestroomsResult> {
  const { south, west, north, east } = parseBBoxString(params.bbox);

  let query = (supabase as any)
    .from("restrooms")
    .select(
      "id, type, name, road_address, address_detail, latitude, longitude, access_method, gender_type, wheelchair_accessible, baby_changing_available, sanitary_products_available, last_verified_at, business_id",
      { count: "exact" }
    )
    .eq("publication_status", "published")
    .gte("latitude", south)
    .lte("latitude", north)
    .gte("longitude", west)
    .lte("longitude", east)
    .not("latitude", "is", null)
    .not("longitude", "is", null);

  if (params.type === "public") {
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

  // Defense-in-depth: For partner restrooms, verify business is approved and fetch business name
  const partnerBizIds = Array.from(
    new Set(
      rows
        .filter((r: any) => r.type === "partner" && r.business_id)
        .map((r: any) => r.business_id as string)
    )
  );

  const approvedBizMap = new Map<string, { id: string; name: string }>();
  if (partnerBizIds.length > 0) {
    const { data: bizData } = await (supabase as any)
      .from("businesses")
      .select("id, name, registration_status")
      .in("id", partnerBizIds)
      .eq("registration_status", "approved");

    if (bizData) {
      for (const b of bizData) {
        approvedBizMap.set(b.id, { id: b.id, name: b.name });
      }
    }
  }

  // Filter out partner restrooms whose business is NOT approved (suspended, draft, etc.)
  const validRows = rows.filter((r: any) => {
    if (r.type === "public") return true;
    if (r.type === "partner") {
      return r.business_id && approvedBizMap.has(r.business_id);
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

  const items: PublicRestroomSummary[] = validRows.map((r: any) => {
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

  return {
    items,
    total: validRows.length === rows.length ? (count ?? items.length) : items.length,
    limit: params.limit,
    offset: params.offset,
  };
}

/**
 * Retrieve public details of a single restroom.
 * Returns null if the restroom is non-existent, unapproved, draft, or belongs to a suspended/unapproved business.
 * NEVER leaks PIN, payment secret keys, or internal private notes.
 */
export async function getPublicRestroomDetail(
  supabase: SupabaseClient<Database>,
  id: string
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

  let publicBusiness: PublicBusinessInfo | null = null;
  if (restroom.type === "partner") {
    if (!restroom.business_id) {
      return null;
    }
    const { data: biz } = await (supabase as any)
      .from("businesses")
      .select(
        "id, name, category, description, road_address, jibun_address, address_detail, latitude, longitude, phone, website_url, registration_status"
      )
      .eq("id", restroom.business_id)
      .eq("registration_status", "approved")
      .maybeSingle();

    if (!biz) {
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
  id: string
): Promise<PublicBusinessInfo | null> {
  const { data: biz, error } = await (supabase as any)
    .from("businesses")
    .select(
      "id, name, category, description, road_address, jibun_address, address_detail, latitude, longitude, phone, website_url, registration_status"
    )
    .eq("id", id)
    .eq("registration_status", "approved")
    .maybeSingle();

  if (error || !biz) {
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

