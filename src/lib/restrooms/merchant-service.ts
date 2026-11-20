import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient, isServiceRoleConfigured } from "@/lib/supabase/server";
import { createSignedPhotoReadUrlMap } from "./photo-urls";
import {
  type CreateMerchantRestroomInput,
  type UpdateMerchantRestroomInput,
  type CreateMerchantPolicyInput,
  type RestroomHourInput,
  normalizeRestroomHours,
  resolvePolicyAccessMode,
} from "./merchant-validation";

export class MerchantRestroomError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "MerchantRestroomError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Asserts that the authenticated user is an active member (owner/manager)
 * of an approved partner business.
 */
export async function assertMerchantAccessToBusiness(
  supabase: SupabaseClient<any>,
  userId: string,
  businessId: string
): Promise<{ businessId: string; role: string }> {
  // 1. Verify business existence and approved status
  const { data: business, error: bizError } = await supabase
    .from("businesses")
    .select("id, registration_status")
    .eq("id", businessId)
    .maybeSingle();

  if (bizError || !business) {
    throw new MerchantRestroomError("BUSINESS_NOT_FOUND", "가게를 찾을 수 없습니다.", 404);
  }

  if (business.registration_status !== "approved") {
    throw new MerchantRestroomError(
      "BUSINESS_NOT_APPROVED",
      `승인된 가게만 제휴 화장실을 등록하거나 관리할 수 있습니다. (현재 상태: ${business.registration_status})`,
      403
    );
  }

  // 2. Verify active membership
  const { data: member, error: memError } = await supabase
    .from("business_members")
    .select("role, membership_status")
    .eq("business_id", businessId)
    .eq("user_id", userId)
    .maybeSingle();

  if (memError || !member || member.membership_status !== "active") {
    throw new MerchantRestroomError(
      "MEMBERSHIP_REQUIRED",
      "해당 가게의 활성 멤버십(점주 또는 관리자) 권한이 필요합니다.",
      403
    );
  }

  return { businessId, role: member.role };
}

/**
 * Asserts that the restroom is a partner restroom and the user has active membership
 * in its owning business.
 */
export async function assertMerchantAccessToRestroom(
  supabase: SupabaseClient<any>,
  userId: string,
  restroomId: string
): Promise<{ restroom: any; businessId: string }> {
  const { data: restroom, error } = await supabase
    .from("restrooms")
    .select("id, business_id, type, name, publication_status, road_address, address_detail, latitude, longitude, floor, entrance_instructions, gender_type, wheelchair_accessible, baby_changing_available, sanitary_products_available, access_method, created_at, updated_at")
    .eq("id", restroomId)
    .maybeSingle();

  if (error || !restroom) {
    throw new MerchantRestroomError("RESTROOM_NOT_FOUND", "화장실을 찾을 수 없습니다.", 404);
  }

  if (restroom.type !== "partner" || !restroom.business_id) {
    throw new MerchantRestroomError(
      "FORBIDDEN_PUBLIC_RESTROOM",
      "공공 화장실은 점주 API를 통해 수정하거나 조작할 수 없습니다.",
      403
    );
  }

  await assertMerchantAccessToBusiness(supabase, userId, restroom.business_id);

  return { restroom, businessId: restroom.business_id };
}

/**
 * Lists partner restrooms owned by the specified business.
 */
export async function listMerchantRestrooms(
  supabase: SupabaseClient<any>,
  userId: string,
  businessId: string
) {
  await assertMerchantAccessToBusiness(supabase, userId, businessId);

  const { data: restrooms, error } = await supabase
    .from("restrooms")
    .select("id, business_id, type, name, description, road_address, address_detail, latitude, longitude, floor, entrance_instructions, gender_type, wheelchair_accessible, baby_changing_available, sanitary_products_available, access_method, publication_status, last_verified_at, created_at, updated_at")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new MerchantRestroomError("DB_QUERY_FAILED", `화장실 목록 조회 실패: ${error.message}`, 500);
  }

  return restrooms ?? [];
}

export interface MerchantRestroomPinStatus {
  hasActivePin: boolean;
  codeVersion: number | null;
  updatedAt: string | null;
  encryptionConfigured: boolean;
}

function isPinEncryptionKeyConfigured(): boolean {
  const raw =
    process.env.PIN_ENCRYPTION_KEY ?? process.env.PIN_ENCRYPTION_KEY_BASE64;
  return typeof raw === "string" && raw.trim().length > 0;
}

/**
 * Replaces all weekly operating hours for a partner restroom.
 * Relies on RLS `restroom_hours_mutation_policy` (`can_edit_restroom`).
 */
export async function replaceMerchantRestroomHours(
  supabase: SupabaseClient<any>,
  restroomId: string,
  hours: readonly RestroomHourInput[]
) {
  const normalized = normalizeRestroomHours(hours);

  const { error: deleteError } = await supabase
    .from("restroom_hours")
    .delete()
    .eq("restroom_id", restroomId);

  if (deleteError) {
    throw new MerchantRestroomError(
      "HOURS_UPDATE_FAILED",
      `운영시간 초기화 실패: ${deleteError.message}`,
      500
    );
  }

  if (normalized.length === 0) {
    return [];
  }

  const rowsToInsert = normalized.map((h) => ({
    restroom_id: restroomId,
    weekday: h.weekday,
    opens_at: h.opens_at,
    closes_at: h.closes_at,
    is_closed: h.is_closed,
    crosses_midnight: h.crosses_midnight,
  }));

  const { data: inserted, error: insertError } = await supabase
    .from("restroom_hours")
    .insert(rowsToInsert)
    .select("id, weekday, opens_at, closes_at, is_closed, crosses_midnight")
    .order("weekday", { ascending: true })
    .order("opens_at", { ascending: true });

  if (insertError) {
    throw new MerchantRestroomError(
      "HOURS_UPDATE_FAILED",
      `운영시간 저장 실패: ${insertError.message}`,
      500
    );
  }

  return inserted ?? [];
}

/**
 * Gets partner restroom details for merchant (including policies, hours, and safe PIN metadata).
 * Strictly excludes encrypted_pin, ciphertext, IV, auth_tag, or plaintext PIN.
 */
export async function getMerchantRestroomDetail(
  supabase: SupabaseClient<any>,
  userId: string,
  restroomId: string
) {
  const { restroom, businessId } = await assertMerchantAccessToRestroom(supabase, userId, restroomId);

  // Load hours
  const { data: hours } = await supabase
    .from("restroom_hours")
    .select("id, weekday, opens_at, closes_at, is_closed, crosses_midnight")
    .eq("restroom_id", restroomId)
    .order("weekday", { ascending: true })
    .order("opens_at", { ascending: true });

  // Load policies
  const { data: policies } = await supabase
    .from("restroom_access_policies")
    .select("id, version, access_mode, deposit_amount_krw, refund_eligible, receipt_window_hours, min_purchase_krw, is_active, effective_from, created_at")
    .eq("restroom_id", restroomId)
    .order("version", { ascending: false });

  // Load photos (including unapproved photos for merchant review)
  const { data: photos } = await supabase
    .from("restroom_photos")
    .select("id, restroom_id, storage_path, photo_type, is_primary, moderation_status, uploaded_by, replaces_photo_id, created_at")
    .eq("restroom_id", restroomId)
    .order("created_at", { ascending: false });

  const signedPhotoMap = await createSignedPhotoReadUrlMap(
    (photos ?? []).map((p: any) => p.storage_path)
  );
  const enrichedPhotos = (photos ?? []).map((p: any) => ({
    ...p,
    image_url: signedPhotoMap.get(p.storage_path) ?? null,
  }));

  // Load safe PIN registration metadata (NEVER ciphertext/IV/tag/HMAC/plaintext)
  let pinStatus: MerchantRestroomPinStatus = {
    hasActivePin: false,
    codeVersion: null,
    updatedAt: null,
    encryptionConfigured: isPinEncryptionKeyConfigured(),
  };

  if (isServiceRoleConfigured()) {
    try {
      const adminClient = createAdminClient() as any;
      const { data: activeSecret } = await adminClient
        .from("restroom_lock_secrets")
        .select("code_version, valid_from")
        .eq("restroom_id", restroomId)
        .eq("status", "active")
        .maybeSingle();

      if (activeSecret) {
        pinStatus = {
          ...pinStatus,
          hasActivePin: true,
          codeVersion: activeSecret.code_version ?? null,
          updatedAt: activeSecret.valid_from ?? null,
        };
      }
    } catch {
      // Fail safe: keep default pinStatus without breaking detail view
    }
  }

  return {
    ...restroom,
    businessId,
    hours: hours ?? [],
    policies: policies ?? [],
    photos: enrichedPhotos,
    pinStatus,
  };
}

/**
 * Creates a new partner restroom in 'draft' status.
 * Strictly prevents self-publishing and spoofing approved_by or last_verified_at.
 */
export async function createMerchantRestroom(
  supabase: SupabaseClient<any>,
  userId: string,
  input: CreateMerchantRestroomInput
) {
  await assertMerchantAccessToBusiness(supabase, userId, input.business_id);

  const resolved = resolvePolicyAccessMode(input);

  // Try atomic RPC if available
  if (typeof supabase.rpc === "function") {
    const { data: rpcRestroom, error: rpcError } = await supabase.rpc(
      "create_merchant_restroom",
      {
        p_business_id: input.business_id,
        p_name: input.name,
        p_description: input.description ?? null,
        p_road_address: input.road_address,
        p_address_detail: input.address_detail ?? null,
        p_latitude: input.latitude,
        p_longitude: input.longitude,
        p_floor: input.floor ?? null,
        p_entrance_instructions: input.entrance_instructions ?? null,
        p_gender_type: input.gender_type ?? "unknown",
        p_wheelchair_accessible: input.wheelchair_accessible ?? null,
        p_baby_changing_available: input.baby_changing_available ?? null,
        p_sanitary_products_available: input.sanitary_products_available ?? null,
        p_access_method: input.access_method ?? "ask_staff",
        p_access_mode: resolved.access_mode,
        p_deposit_amount_krw: resolved.deposit_amount_krw,
        p_refund_eligible: resolved.refund_eligible,
        p_receipt_window_hours: input.receipt_window_hours ?? 24,
        p_min_purchase_krw: input.min_purchase_krw ?? 0,
      }
    );
    if (!rpcError && rpcRestroom) {
      if (input.hours && input.hours.length > 0 && rpcRestroom.id) {
        const savedHours = await replaceMerchantRestroomHours(
          supabase,
          rpcRestroom.id,
          input.hours
        );
        return { ...rpcRestroom, hours: savedHours };
      }
      return rpcRestroom;
    }
    if (rpcError) {
      if (rpcError.code === "42501") {
        throw new MerchantRestroomError("FORBIDDEN", `화장실 등록 권한이 없습니다: ${rpcError.message}`, 403);
      }
      if (
        rpcError.code !== "PGRST202" &&
        !rpcError.message?.includes("function") &&
        !rpcError.message?.includes("does not exist")
      ) {
        throw new MerchantRestroomError("INSERT_FAILED", `화장실 등록 실패: ${rpcError.message}`, 500);
      }
    }
  }

  // 1. Insert restroom as draft
  const { data: inserted, error: insertError } = await supabase
    .from("restrooms")
    .insert({
      type: "partner",
      business_id: input.business_id,
      source_id: null,
      source_record_id: null,
      name: input.name,
      description: input.description ?? null,
      road_address: input.road_address,
      address_detail: input.address_detail ?? null,
      latitude: input.latitude,
      longitude: input.longitude,
      floor: input.floor ?? null,
      entrance_instructions: input.entrance_instructions ?? null,
      gender_type: input.gender_type,
      wheelchair_accessible: input.wheelchair_accessible ?? null,
      baby_changing_available: input.baby_changing_available ?? null,
      sanitary_products_available: input.sanitary_products_available ?? null,
      access_method: input.access_method,
      publication_status: "draft", // Strictly draft
      approved_by: null,
      last_verified_at: null,
      created_by: userId,
    })
    .select("id, business_id, type, name, description, road_address, address_detail, latitude, longitude, floor, entrance_instructions, gender_type, wheelchair_accessible, baby_changing_available, sanitary_products_available, access_method, publication_status, created_at, updated_at")
    .single();

  if (insertError || !inserted) {
    throw new MerchantRestroomError("INSERT_FAILED", `화장실 등록 실패: ${insertError?.message}`, 500);
  }

  // 2. Create initial default policy (version 1)
  await supabase.from("restroom_access_policies").insert({
    restroom_id: inserted.id,
    version: 1,
    access_mode: resolved.access_mode,
    deposit_amount_krw: resolved.deposit_amount_krw,
    refund_eligible: resolved.refund_eligible,
    receipt_window_hours: input.receipt_window_hours ?? 24,
    min_purchase_krw: input.min_purchase_krw ?? 0,
    is_active: true,
    effective_from: new Date().toISOString(),
    created_by: userId,
  });

  if (input.hours && input.hours.length > 0) {
    const savedHours = await replaceMerchantRestroomHours(
      supabase,
      inserted.id,
      input.hours
    );
    return { ...inserted, hours: savedHours };
  }

  return inserted;
}

/**
 * Updates a partner restroom.
 * Prevents mutation of type, business_id, publication_status, approved_by, and last_verified_at.
 */
export async function updateMerchantRestroom(
  supabase: SupabaseClient<any>,
  userId: string,
  restroomId: string,
  input: UpdateMerchantRestroomInput
) {
  const { restroom } = await assertMerchantAccessToRestroom(supabase, userId, restroomId);

  // If already published, check if core location is being modified
  if (restroom.publication_status === "published") {
    const latChanged = input.latitude !== undefined && input.latitude !== restroom.latitude;
    const lngChanged = input.longitude !== undefined && input.longitude !== restroom.longitude;
    const addrChanged = input.road_address !== undefined && input.road_address !== restroom.road_address;

    if (latChanged || lngChanged || addrChanged) {
      throw new MerchantRestroomError(
        "PUBLISHED_RESTROOM_LOCATION_LOCKED",
        "이미 공개 승인된 화장실의 위치 및 도로명주소는 임의로 변경할 수 없습니다. 관리자에게 재검수를 문의해 주세요.",
        422
      );
    }
  }

  const patch: Record<string, any> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.road_address !== undefined) patch.road_address = input.road_address;
  if (input.address_detail !== undefined) patch.address_detail = input.address_detail;
  if (input.latitude !== undefined) patch.latitude = input.latitude;
  if (input.longitude !== undefined) patch.longitude = input.longitude;
  if (input.floor !== undefined) patch.floor = input.floor;
  if (input.entrance_instructions !== undefined) patch.entrance_instructions = input.entrance_instructions;
  if (input.gender_type !== undefined) patch.gender_type = input.gender_type;
  if (input.wheelchair_accessible !== undefined) patch.wheelchair_accessible = input.wheelchair_accessible;
  if (input.baby_changing_available !== undefined) patch.baby_changing_available = input.baby_changing_available;
  if (input.sanitary_products_available !== undefined) patch.sanitary_products_available = input.sanitary_products_available;
  if (input.access_method !== undefined) patch.access_method = input.access_method;

  if (Object.keys(patch).length === 0 && input.hours === undefined) {
    return restroom;
  }

  let updatedRestroom = restroom;
  if (Object.keys(patch).length > 0) {
    const { data: updated, error } = await supabase
      .from("restrooms")
      .update(patch)
      .eq("id", restroomId)
      .select("id, business_id, type, name, description, road_address, address_detail, latitude, longitude, floor, entrance_instructions, gender_type, wheelchair_accessible, baby_changing_available, sanitary_products_available, access_method, publication_status, created_at, updated_at")
      .single();

    if (error || !updated) {
      throw new MerchantRestroomError("UPDATE_FAILED", `화장실 정보 수정 실패: ${error?.message}`, 500);
    }
    updatedRestroom = updated;
  }

  if (input.hours !== undefined) {
    const savedHours = await replaceMerchantRestroomHours(
      supabase,
      restroomId,
      input.hours
    );
    return { ...updatedRestroom, hours: savedHours };
  }

  return updatedRestroom;
}

/**
 * Submits partner restroom for administrator review (draft -> pending).
 */
export async function submitRestroomForReview(
  supabase: SupabaseClient<any>,
  userId: string,
  restroomId: string
) {
  const { restroom } = await assertMerchantAccessToRestroom(supabase, userId, restroomId);

  if (restroom.publication_status !== "draft") {
    throw new MerchantRestroomError(
      "INVALID_STATUS_TRANSITION",
      `임시저장(draft) 상태의 화장실만 심사를 요청할 수 있습니다. (현재 상태: ${restroom.publication_status})`,
      422
    );
  }

  // Try atomic SECURITY DEFINER RPC first (required by PostgreSQL trigger rules)
  if (typeof supabase.rpc === "function") {
    const { data: rpcUpdated, error: rpcError } = await supabase.rpc(
      "submit_merchant_restroom_for_review",
      { p_restroom_id: restroomId }
    );
    if (!rpcError && rpcUpdated) {
      return rpcUpdated;
    }
    if (rpcError) {
      if (rpcError.code === "42501") {
        throw new MerchantRestroomError("FORBIDDEN", `심사 제출 권한이 없습니다: ${rpcError.message}`, 403);
      }
      if (rpcError.code === "HM001") {
        throw new MerchantRestroomError("INVALID_STATUS_TRANSITION", rpcError.message, 422);
      }
      if (rpcError.code === "HM005") {
        throw new MerchantRestroomError("INCOMPLETE_RESTROOM", rpcError.message, 422);
      }
      if (
        rpcError.code !== "PGRST202" &&
        !rpcError.message?.includes("function") &&
        !rpcError.message?.includes("does not exist")
      ) {
        throw new MerchantRestroomError("SUBMIT_FAILED", `심사 요청 실패: ${rpcError.message}`, 500);
      }
    }
  }

  const { data: updated, error } = await supabase
    .from("restrooms")
    .update({ publication_status: "pending" })
    .eq("id", restroomId)
    .select("id, publication_status, updated_at")
    .single();

  if (error || !updated) {
    throw new MerchantRestroomError("SUBMIT_FAILED", `심사 요청 실패: ${error?.message}`, 500);
  }

  return updated;
}

/**
 * Creates a new versioned access policy for a partner restroom.
 * Automatically increments version and manages active status.
 */
export async function createMerchantRestroomPolicy(
  supabase: SupabaseClient<any>,
  userId: string,
  restroomId: string,
  input: CreateMerchantPolicyInput
) {
  await assertMerchantAccessToRestroom(supabase, userId, restroomId);

  const resolved = resolvePolicyAccessMode(input);

  // Try atomic RPC first (enforces row-lock & trigger immutability)
  if (typeof supabase.rpc === "function") {
    const { data: rpcPolicy, error: rpcError } = await supabase.rpc(
      "create_merchant_restroom_policy",
      {
        p_restroom_id: restroomId,
        p_access_mode: resolved.access_mode,
        p_deposit_amount_krw: resolved.deposit_amount_krw,
        p_refund_eligible: resolved.refund_eligible,
        p_receipt_window_hours: input.receipt_window_hours ?? null,
        p_min_purchase_krw: input.min_purchase_krw ?? null,
      }
    );
    if (!rpcError && rpcPolicy) {
      return rpcPolicy;
    }
    if (rpcError) {
      if (rpcError.code === "42501") {
        throw new MerchantRestroomError("FORBIDDEN", `정책 생성 권한이 없습니다: ${rpcError.message}`, 403);
      }
      if (
        rpcError.code !== "PGRST202" &&
        !rpcError.message?.includes("function") &&
        !rpcError.message?.includes("does not exist")
      ) {
        throw new MerchantRestroomError("POLICY_INSERT_FAILED", `정책 버전 생성 실패: ${rpcError.message}`, 500);
      }
    }
  }

  // Fallback to table queries
  // 1. Find max version
  const { data: existingPolicies, error: findError } = await supabase
    .from("restroom_access_policies")
    .select("version")
    .eq("restroom_id", restroomId)
    .order("version", { ascending: false })
    .limit(1);

  if (findError) {
    throw new MerchantRestroomError("POLICY_QUERY_FAILED", `기존 정책 조회 실패: ${findError.message}`, 500);
  }

  const nextVersion = (existingPolicies?.[0]?.version ?? 0) + 1;

  // 2. If new policy is active, deactivate existing active policies
  if (input.is_active) {
    await supabase
      .from("restroom_access_policies")
      .update({ is_active: false })
      .eq("restroom_id", restroomId)
      .eq("is_active", true);
  }

  // 3. Insert new policy version
  const { data: inserted, error: insertError } = await supabase
    .from("restroom_access_policies")
    .insert({
      restroom_id: restroomId,
      version: nextVersion,
      access_mode: resolved.access_mode,
      deposit_amount_krw: resolved.deposit_amount_krw,
      refund_eligible: resolved.refund_eligible,
      receipt_window_hours: input.receipt_window_hours ?? null,
      min_purchase_krw: input.min_purchase_krw ?? null,
      is_active: input.is_active,
      effective_from: new Date().toISOString(),
      created_by: userId,
    })
    .select("id, restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, receipt_window_hours, min_purchase_krw, is_active, effective_from, created_at")
    .single();

  if (insertError || !inserted) {
    throw new MerchantRestroomError("POLICY_INSERT_FAILED", `정책 버전 생성 실패: ${insertError?.message}`, 500);
  }

  return inserted;
}

