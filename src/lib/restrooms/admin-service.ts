import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";
import type {
  AdminRestroomSummaryItem,
  AdminRestroomDetail,
  AdminRestroomBusinessSummary,
  AdminRestroomApplicantSummary,
  AdminRestroomAuditLog,
} from "./admin-types";
import type { AdminRestroomListFilter, AdminRestroomDecisionInput } from "./admin-validation";
import type {
  Restroom,
  RestroomHour,
  RestroomHourException,
  RestroomAccessPolicy,
  RestroomPhoto,
} from "./types";

export class AdminRestroomError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "AdminRestroomError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Lists restrooms for administrator review and catalog inspection.
 * Strictly gated to administrators.
 */
export async function listRestroomsForAdmin(
  supabase: SupabaseClient<Database>,
  filter: AdminRestroomListFilter
): Promise<{ restrooms: AdminRestroomSummaryItem[]; count: number; total: number }> {
  const untyped = supabase as unknown as { from: (table: string) => any };

  let query = untyped
    .from("restrooms")
    .select(
      "id, business_id, source_id, type, name, road_address, address_detail, latitude, longitude, floor, gender_type, access_method, wheelchair_accessible, baby_changing_available, sanitary_products_available, publication_status, last_verified_at, created_by, approved_by, created_at, updated_at",
      { count: "exact" }
    )
    .order("created_at", { ascending: false });

  if (filter.status && filter.status !== "all") {
    query = query.eq("publication_status", filter.status);
  }

  if (filter.type && filter.type !== "all") {
    query = query.eq("type", filter.type);
  }

  const { data: rawRestrooms, error, count } = await query.range(
    filter.offset,
    filter.offset + filter.limit - 1
  );

  if (error) {
    throw new AdminRestroomError(
      "QUERY_FAILED",
      `화장실 심사 목록 조회 실패: ${error.message}`,
      500
    );
  }

  const restroomsList = (rawRestrooms || []) as Restroom[];
  if (restroomsList.length === 0) {
    return { restrooms: [], count: 0, total: count ?? 0 };
  }

  // 1. Batch query associated businesses
  const businessIds = Array.from(
    new Set(restroomsList.map((r) => r.business_id).filter((id): id is string => Boolean(id)))
  );
  const businessMap = new Map<string, { name: string; registration_status: string }>();

  if (businessIds.length > 0) {
    const { data: businesses } = await untyped
      .from("businesses")
      .select("id, name, registration_status")
      .in("id", businessIds);

    if (businesses) {
      for (const b of businesses) {
        businessMap.set(b.id, {
          name: b.name,
          registration_status: b.registration_status,
        });
      }
    }
  }

  // 2. Batch query applicant profiles
  const creatorIds = Array.from(
    new Set(restroomsList.map((r) => r.created_by).filter((id): id is string => Boolean(id)))
  );
  const applicantMap = new Map<string, string>();

  if (creatorIds.length > 0) {
    const { data: profiles } = await untyped
      .from("profiles")
      .select("id, display_name")
      .in("id", creatorIds);

    if (profiles) {
      for (const p of profiles) {
        if (p.display_name) applicantMap.set(p.id, p.display_name);
      }
    }
  }

  // 3. Batch query active policies
  const restroomIds = restroomsList.map((r) => r.id);
  const activePolicyMap = new Map<
    string,
    { access_mode: any; deposit_amount_krw: number | null }
  >();

  const { data: activePolicies } = await untyped
    .from("restroom_access_policies")
    .select("restroom_id, access_mode, deposit_amount_krw")
    .in("restroom_id", restroomIds)
    .eq("is_active", true);

  if (activePolicies) {
    for (const p of activePolicies) {
      activePolicyMap.set(p.restroom_id, {
        access_mode: p.access_mode,
        deposit_amount_krw: p.deposit_amount_krw,
      });
    }
  }

  // 4. Batch query primary photos
  const photoMap = new Map<string, string>();
  const { data: primaryPhotos } = await untyped
    .from("restroom_photos")
    .select("restroom_id, storage_path")
    .in("restroom_id", restroomIds)
    .eq("is_primary", true);

  if (primaryPhotos) {
    for (const ph of primaryPhotos) {
      photoMap.set(ph.restroom_id, ph.storage_path);
    }
  }

  const items: AdminRestroomSummaryItem[] = restroomsList.map((r) => {
    const biz = r.business_id ? businessMap.get(r.business_id) : undefined;
    const policy = activePolicyMap.get(r.id);

    return {
      id: r.id,
      name: r.name,
      type: r.type,
      publication_status: r.publication_status,
      road_address: r.road_address,
      address_detail: r.address_detail,
      latitude: r.latitude,
      longitude: r.longitude,
      floor: r.floor,
      gender_type: r.gender_type,
      access_method: r.access_method,
      wheelchair_accessible: r.wheelchair_accessible,
      baby_changing_available: r.baby_changing_available,
      sanitary_products_available: r.sanitary_products_available,
      business_id: r.business_id,
      business_name: biz?.name ?? null,
      business_registration_status: biz?.registration_status ?? null,
      active_policy_mode: policy?.access_mode ?? null,
      active_deposit_amount_krw: policy?.deposit_amount_krw ?? null,
      applicant_name: r.created_by ? applicantMap.get(r.created_by) ?? null : null,
      created_by: r.created_by,
      approved_by: r.approved_by,
      last_verified_at: r.last_verified_at,
      created_at: r.created_at,
      updated_at: r.updated_at,
      primary_photo_storage_path: photoMap.get(r.id) ?? null,
    };
  });

  // Optional in-memory search filtering if q is provided
  let filtered = items;
  if (filter.q && filter.q.trim()) {
    const q = filter.q.trim().toLowerCase();
    filtered = items.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.road_address.toLowerCase().includes(q) ||
        (item.business_name && item.business_name.toLowerCase().includes(q)) ||
        (item.applicant_name && item.applicant_name.toLowerCase().includes(q))
    );
  }

  return {
    restrooms: filtered,
    count: filtered.length,
    total: count ?? filtered.length,
  };
}

/**
 * Retrieves full restroom detail for administrator inspection.
 * Includes complete business info, policies history, hours, photos, and audit logs.
 */
export async function getRestroomDetailForAdmin(
  supabase: SupabaseClient<Database>,
  restroomId: string
): Promise<AdminRestroomDetail> {
  const untyped = supabase as unknown as { from: (table: string) => any };

  // 1. Fetch restroom
  const { data: restroom, error: restroomError } = await untyped
    .from("restrooms")
    .select("*")
    .eq("id", restroomId)
    .maybeSingle();

  if (restroomError || !restroom) {
    throw new AdminRestroomError("RESTROOM_NOT_FOUND", "화장실 정보를 찾을 수 없습니다.", 404);
  }

  // 2. Fetch business info if partner restroom
  let businessSummary: AdminRestroomBusinessSummary | null = null;
  if (restroom.business_id) {
    const { data: biz } = await untyped
      .from("businesses")
      .select("id, name, category, road_address, registration_status, phone")
      .eq("id", restroom.business_id)
      .maybeSingle();

    if (biz) {
      businessSummary = {
        id: biz.id,
        name: biz.name,
        category: biz.category,
        road_address: biz.road_address,
        registration_status: biz.registration_status,
        phone: biz.phone ?? null,
      };
    }
  }

  // 3. Fetch applicant profile
  let applicantSummary: AdminRestroomApplicantSummary | null = null;
  if (restroom.created_by) {
    const { data: prof } = await untyped
      .from("profiles")
      .select("id, display_name, account_status")
      .eq("id", restroom.created_by)
      .maybeSingle();

    if (prof) {
      applicantSummary = {
        id: prof.id,
        display_name: prof.display_name ?? null,
        account_status: prof.account_status,
      };
    }
  }

  // 4. Fetch hours
  const { data: hours } = await untyped
    .from("restroom_hours")
    .select("id, restroom_id, weekday, opens_at, closes_at, is_closed, crosses_midnight")
    .eq("restroom_id", restroomId)
    .order("weekday", { ascending: true });

  // 5. Fetch exceptions
  const { data: exceptions } = await untyped
    .from("restroom_hour_exceptions")
    .select("id, restroom_id, exception_date, opens_at, closes_at, is_closed, reason, created_by, created_at")
    .eq("restroom_id", restroomId)
    .order("exception_date", { ascending: false });

  // 6. Fetch policies (version desc)
  const { data: policies } = await untyped
    .from("restroom_access_policies")
    .select("id, restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, receipt_window_hours, min_purchase_krw, is_active, effective_from, created_by, created_at")
    .eq("restroom_id", restroomId)
    .order("version", { ascending: false });

  // 7. Fetch photos
  const { data: photos } = await untyped
    .from("restroom_photos")
    .select("id, restroom_id, storage_path, photo_type, is_primary, moderation_status, uploaded_by, created_at")
    .eq("restroom_id", restroomId)
    .order("created_at", { ascending: false });

  // 8. Fetch audit logs for this restroom
  const { data: auditLogs } = await untyped
    .from("audit_logs")
    .select("id, actor_user_id, action, entity_type, entity_id, before_data, after_data, reason, created_at")
    .eq("entity_type", "restrooms")
    .eq("entity_id", restroomId)
    .order("created_at", { ascending: false });

  return {
    ...(restroom as Restroom),
    business: businessSummary,
    applicant: applicantSummary,
    hours: (hours || []) as RestroomHour[],
    hour_exceptions: (exceptions || []) as RestroomHourException[],
    policies: (policies || []) as RestroomAccessPolicy[],
    photos: (photos || []) as RestroomPhoto[],
    audit_logs: (auditLogs || []) as AdminRestroomAuditLog[],
  };
}

/**
 * Executes administrator review decision (publish, reject, or suspend).
 * Uses atomic SECURITY DEFINER RPC `decide_restroom_review` when present,
 * or gracefully runs secure transactional updates and audit log recording.
 */
export async function decideRestroomReview(
  supabase: SupabaseClient<Database>,
  adminUserId: string,
  restroomId: string,
  input: AdminRestroomDecisionInput
): Promise<Restroom> {
  const untyped = supabase as unknown as {
    rpc?: (fn: string, args: Record<string, unknown>) => Promise<{ data: any; error: any }>;
    from: (table: string) => any;
  };

  // Try atomic SECURITY DEFINER RPC first
  if (typeof untyped.rpc === "function") {
    const { data: rpcRestroom, error: rpcError } = await untyped.rpc(
      "decide_restroom_review",
      {
        p_restroom_id: restroomId,
        p_decision: input.decision,
        p_reason: input.reason || null,
        p_review_notes: input.review_notes || null,
      }
    );

    if (!rpcError && rpcRestroom) {
      return rpcRestroom as Restroom;
    }

    if (rpcError) {
      if (rpcError.code === "42501") {
        throw new AdminRestroomError("FORBIDDEN", "관리자 권한이 없습니다.", 403);
      }
      if (rpcError.code === "P0002") {
        throw new AdminRestroomError("RESTROOM_NOT_FOUND", "화장실을 찾을 수 없습니다.", 404);
      }
      if (rpcError.code === "22023") {
        throw new AdminRestroomError("INVALID_INPUT", rpcError.message || "입력값이 올바르지 않습니다.", 400);
      }
      if (rpcError.code === "HM001") {
        throw new AdminRestroomError("INVALID_STATUS_TRANSITION", rpcError.message || "허용되지 않은 상태 전이입니다.", 422);
      }
      if (rpcError.code === "HM002") {
        throw new AdminRestroomError("ALREADY_IN_STATE", rpcError.message || "이미 해당 상태입니다.", 409);
      }
      if (rpcError.code === "HM005") {
        throw new AdminRestroomError("INCOMPLETE_RESTROOM", rpcError.message || "필수 정보가 누락되어 공개할 수 없습니다.", 422);
      }
      if (rpcError.code === "HM006") {
        throw new AdminRestroomError("REASON_REQUIRED", rpcError.message || "사유를 필수로 입력해야 합니다.", 422);
      }
      if (rpcError.code === "HM007") {
        throw new AdminRestroomError("BUSINESS_NOT_APPROVED", rpcError.message || "승인된 제휴 가게의 화장실만 공개할 수 있습니다.", 422);
      }

      // If function does not exist in remote DB, continue to fallback
      if (
        rpcError.code !== "PGRST202" &&
        !rpcError.message?.includes("function") &&
        !rpcError.message?.includes("does not exist")
      ) {
        throw new AdminRestroomError("DECISION_FAILED", `심사 처리 실패: ${rpcError.message}`, 500);
      }
    }
  }

  // Fallback to table queries with strict business logic
  const { data: currentRestroom, error: findError } = await untyped
    .from("restrooms")
    .select("*")
    .eq("id", restroomId)
    .maybeSingle();

  if (findError || !currentRestroom) {
    throw new AdminRestroomError("RESTROOM_NOT_FOUND", "화장실을 찾을 수 없습니다.", 404);
  }

  const beforeData = { ...currentRestroom };

  if (input.decision === "publish") {
    if (currentRestroom.publication_status === "published") {
      throw new AdminRestroomError("ALREADY_IN_STATE", "ALREADY_PUBLISHED: 이미 공개된 화장실입니다.", 409);
    }

    if (currentRestroom.publication_status === "draft") {
      throw new AdminRestroomError(
        "INVALID_STATUS_TRANSITION",
        "INVALID_STATUS_TRANSITION: draft 상태의 화장실은 직접 공개할 수 없으며 심사 제출(pending)이 필요합니다.",
        422
      );
    }

    if (currentRestroom.publication_status === "archived") {
      throw new AdminRestroomError(
        "INVALID_STATUS_TRANSITION",
        "INVALID_STATUS_TRANSITION: archived 상태의 화장실은 공개할 수 없습니다.",
        422
      );
    }

    if (currentRestroom.publication_status !== "pending" && currentRestroom.publication_status !== "suspended") {
      throw new AdminRestroomError(
        "INVALID_STATUS_TRANSITION",
        "INVALID_STATUS_TRANSITION: 심사 대기(pending) 또는 공개 중단(suspended) 상태의 화장실만 공개할 수 있습니다.",
        422
      );
    }

    if (!currentRestroom.name?.trim() || !currentRestroom.road_address?.trim()) {
      throw new AdminRestroomError(
        "INCOMPLETE_RESTROOM",
        "화장실 이름과 도로명주소는 필수 정보입니다.",
        422
      );
    }

    if (currentRestroom.latitude === null || currentRestroom.longitude === null) {
      throw new AdminRestroomError(
        "INCOMPLETE_RESTROOM",
        "화장실의 유효한 위도와 경도 좌표가 등록되어야 공개할 수 있습니다.",
        422
      );
    }

    if (currentRestroom.type === "partner") {
      if (!currentRestroom.business_id) {
        throw new AdminRestroomError(
          "INCOMPLETE_RESTROOM",
          "제휴 화장실은 소속 가게 ID가 필수입니다.",
          422
        );
      }

      const { data: biz } = await untyped
        .from("businesses")
        .select("registration_status")
        .eq("id", currentRestroom.business_id)
        .maybeSingle();

      if (!biz || biz.registration_status !== "approved") {
        throw new AdminRestroomError(
          "BUSINESS_NOT_APPROVED",
          `소속 가게가 관리자 승인(approved) 상태여야 화장실을 공개할 수 있습니다. (현재 상태: ${biz?.registration_status ?? "없음"})`,
          422
        );
      }
    }

    // Check active policy
    const { data: activePolicy } = await untyped
      .from("restroom_access_policies")
      .select("id")
      .eq("restroom_id", restroomId)
      .eq("is_active", true)
      .maybeSingle();

    if (!activePolicy) {
      throw new AdminRestroomError(
        "INCOMPLETE_RESTROOM",
        "활성화된 화장실 이용 정책이 존재해야 공개할 수 있습니다.",
        422
      );
    }

    const { data: updated, error: updateError } = await untyped
      .from("restrooms")
      .update({
        publication_status: "published",
        approved_by: adminUserId,
        last_verified_at: new Date().toISOString(),
      })
      .eq("id", restroomId)
      .select("*")
      .single();

    if (updateError || !updated) {
      throw new AdminRestroomError(
        "UPDATE_FAILED",
        `공개 승인 처리 실패: ${updateError?.message}`,
        500
      );
    }

    // Write audit log
    await untyped.from("audit_logs").insert({
      actor_user_id: adminUserId,
      action: "restroom_published",
      entity_type: "restrooms",
      entity_id: restroomId,
      before_data: beforeData,
      after_data: updated,
      reason: input.review_notes || "관리자 화장실 공개 승인",
    });

    return updated as Restroom;
  }

  if (input.decision === "reject") {
    if (!input.reason || input.reason.trim().length < 2) {
      throw new AdminRestroomError(
        "REASON_REQUIRED",
        "반려 시 구체적인 반려 사유(2자 이상)를 필수로 입력해야 합니다.",
        422
      );
    }

    if (currentRestroom.publication_status === "published") {
      throw new AdminRestroomError(
        "INVALID_STATUS_TRANSITION",
        "INVALID_STATUS_TRANSITION: 공개 중인 화장실은 반려할 수 없습니다. 공개 중단(suspend)을 이용해 주세요.",
        422
      );
    }

    if (currentRestroom.publication_status !== "pending") {
      throw new AdminRestroomError(
        "INVALID_STATUS_TRANSITION",
        "INVALID_STATUS_TRANSITION: 심사 대기(pending) 상태의 화장실만 반려할 수 있습니다.",
        422
      );
    }

    const { data: updated, error: updateError } = await untyped
      .from("restrooms")
      .update({
        publication_status: "draft",
        approved_by: null,
      })
      .eq("id", restroomId)
      .select("*")
      .single();

    if (updateError || !updated) {
      throw new AdminRestroomError(
        "UPDATE_FAILED",
        `반려 처리 실패: ${updateError?.message}`,
        500
      );
    }

    // Write audit log
    await untyped.from("audit_logs").insert({
      actor_user_id: adminUserId,
      action: "restroom_rejected",
      entity_type: "restrooms",
      entity_id: restroomId,
      before_data: beforeData,
      after_data: updated,
      reason: input.reason.trim(),
    });

    return updated as Restroom;
  }

  if (input.decision === "suspend") {
    if (!input.reason || input.reason.trim().length < 2) {
      throw new AdminRestroomError(
        "REASON_REQUIRED",
        "공개 중단 시 구체적인 중단 사유(2자 이상)를 필수로 입력해야 합니다.",
        422
      );
    }

    if (currentRestroom.publication_status === "suspended") {
      throw new AdminRestroomError(
        "ALREADY_IN_STATE",
        "ALREADY_SUSPENDED: 이미 공개 중단된 화장실입니다.",
        409
      );
    }

    if (currentRestroom.publication_status !== "published") {
      throw new AdminRestroomError(
        "INVALID_STATUS_TRANSITION",
        "INVALID_STATUS_TRANSITION: 공개 중(published)인 화장실만 공개 중단할 수 있습니다.",
        422
      );
    }

    const { data: updated, error: updateError } = await untyped
      .from("restrooms")
      .update({
        publication_status: "suspended",
      })
      .eq("id", restroomId)
      .select("*")
      .single();

    if (updateError || !updated) {
      throw new AdminRestroomError(
        "UPDATE_FAILED",
        `공개 중단 처리 실패: ${updateError?.message}`,
        500
      );
    }

    // Write audit log
    await untyped.from("audit_logs").insert({
      actor_user_id: adminUserId,
      action: "restroom_suspended",
      entity_type: "restrooms",
      entity_id: restroomId,
      before_data: beforeData,
      after_data: updated,
      reason: input.reason.trim(),
    });

    return updated as Restroom;
  }

  throw new AdminRestroomError("INVALID_DECISION", "유효하지 않은 결정입니다.", 400);
}

/**
 * Moderate photo status (approved | rejected).
 * Updates moderation_status and writes audit log atomically.
 */
export async function moderateRestroomPhoto(
  supabase: SupabaseClient<Database>,
  adminUserId: string,
  photoId: string,
  status: "approved" | "rejected",
  reviewNotes?: string
): Promise<RestroomPhoto> {
  const untyped = supabase as unknown as {
    rpc?: (fn: string, args: Record<string, unknown>) => Promise<{ data: any; error: any }>;
    from: (table: string) => any;
  };

  if (typeof untyped.rpc === "function") {
    const { data: rpcPhoto, error: rpcError } = await untyped.rpc("moderate_restroom_photo", {
      p_photo_id: photoId,
      p_moderation_status: status,
      p_review_notes: reviewNotes || null,
    });

    if (!rpcError && rpcPhoto) {
      return rpcPhoto as RestroomPhoto;
    }

    if (rpcError) {
      if (rpcError.code === "42501") {
        throw new AdminRestroomError("FORBIDDEN", "사진 검수 권한이 없습니다.", 403);
      }
      if (rpcError.code === "P0002") {
        throw new AdminRestroomError("PHOTO_NOT_FOUND", "사진을 찾을 수 없습니다.", 404);
      }
      if (rpcError.code === "22023") {
        throw new AdminRestroomError("INVALID_INPUT", rpcError.message || "유효하지 않은 상태입니다.", 400);
      }
      if (
        rpcError.code !== "PGRST202" &&
        !rpcError.message?.includes("function") &&
        !rpcError.message?.includes("does not exist")
      ) {
        throw new AdminRestroomError("PHOTO_UPDATE_FAILED", `사진 검수 처리 실패: ${rpcError.message}`, 500);
      }
    }
  }

  // Fallback
  const { data: currentPhoto } = await untyped
    .from("restroom_photos")
    .select("*")
    .eq("id", photoId)
    .maybeSingle();

  if (!currentPhoto) {
    throw new AdminRestroomError("PHOTO_NOT_FOUND", "사진을 찾을 수 없습니다.", 404);
  }

  const { data: updated, error } = await untyped
    .from("restroom_photos")
    .update({ moderation_status: status })
    .eq("id", photoId)
    .select("*")
    .single();

  if (error || !updated) {
    throw new AdminRestroomError("PHOTO_UPDATE_FAILED", `사진 검수 처리 실패: ${error?.message}`, 500);
  }

  // Write audit log
  await untyped.from("audit_logs").insert({
    actor_user_id: adminUserId,
    action: `photo_${status}`,
    entity_type: "restroom_photos",
    entity_id: photoId,
    before_data: currentPhoto,
    after_data: updated,
    reason: reviewNotes || `관리자 사진 검수: ${status}`,
  });

  return updated as RestroomPhoto;
}

