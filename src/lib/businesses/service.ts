import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, UserRoleType } from "@/lib/db/types";
import { AuthGuardError } from "@/lib/auth/guards";
import type {
  AdminBusinessDecision,
  AdminBusinessDetail,
  AdminBusinessSummaryItem,
  AdminBusinessVerification,
  AuditLogItem,
  Business,
  BusinessDetail,
  BusinessHours,
  BusinessMember,
  BusinessMemberRole,
  BusinessSummaryItem,
  BusinessVerificationSummary,
} from "./types";
import type {
  AdminBusinessDecisionInput,
  AdminBusinessListFilter,
  CreateBusinessInput,
  UpdateBusinessInput,
} from "./validation";
import { adminBusinessDecisionSchema } from "./validation";

const BUSINESS_SELECT_COLUMNS =
  "id, name, category, description, road_address, jibun_address, address_detail, latitude, longitude, phone, website_url, registration_status, created_by, approved_by, approved_at, rejection_reason, created_at, updated_at";

/**
 * Verification columns a merchant may read. MUST stay in sync with the column-level
 * GRANT on public.business_verifications. registration_number, evidence_storage_path,
 * review_notes and reviewed_by are private (admin/server only) and are never selected here.
 */
export const BUSINESS_VERIFICATION_PUBLIC_COLUMNS =
  "id, business_id, submitted_by, method, status, reviewed_at, created_at";

/**
 * Full verification columns accessible ONLY by administrators and the server process.
 * Contains private business verification data (registration_number, evidence_storage_path, review_notes).
 */
export const BUSINESS_VERIFICATION_ADMIN_COLUMNS =
  "id, business_id, submitted_by, method, registration_number, evidence_storage_path, status, reviewed_by, reviewed_at, review_notes, created_at";


/** Business columns a merchant may change directly. Approval/ownership columns are server-managed. */
const EDITABLE_BUSINESS_FIELDS = [
  "name",
  "category",
  "description",
  "road_address",
  "jibun_address",
  "address_detail",
  "latitude",
  "longitude",
  "phone",
  "website_url",
] as const;

/** Core identity and location fields that formed the basis of administrator approval. */
const CORE_APPROVAL_FIELDS = [
  "name",
  "category",
  "road_address",
  "jibun_address",
  "address_detail",
  "latitude",
  "longitude",
] as const;

interface DbErrorLike {
  code?: string;
  message?: string;
}

function isSupabaseAuthGatewayError(error: DbErrorLike | null | undefined): boolean {
  const code = (error?.code ?? "").toUpperCase();
  const msg = (error?.message ?? "").toLowerCase();
  return (
    code === "PGRST301" ||
    code === "PGRST302" ||
    msg.includes("invalid api key") ||
    msg.includes("invalid compact jws") ||
    msg.includes("jwt")
  );
}

/**
 * Maps database/PostgREST errors to safe, user-facing errors.
 * Never forwards raw database messages (they may contain schema details or user input).
 */
function mapBusinessDbError(
  error: DbErrorLike | null | undefined,
  fallbackMessage: string
): AuthGuardError {
  const code = error?.code ?? "";

  switch (code) {
    case "28000":
      return new AuthGuardError("UNAUTHORIZED", 401, "로그인이 필요한 기능입니다.", "DB_28000");
    case "42501":
    case "PGRST116":
      return new AuthGuardError(
        "FORBIDDEN",
        403,
        "해당 가게에 대한 권한이 없거나 수정할 수 없는 상태입니다.",
        code
      );
    case "P0002":
      return new AuthGuardError("NOT_FOUND", 404, "가게를 찾을 수 없습니다.", "DB_P0002");
    case "HM001":
      return new AuthGuardError(
        "INVALID_INPUT",
        409,
        "이미 관리자 심사 대기 중인 가게입니다.",
        "HM001"
      );
    case "HM002":
      return new AuthGuardError("INVALID_INPUT", 409, "이미 승인 완료된 가게입니다.", "HM002");
    case "HM003":
      return new AuthGuardError(
        "FORBIDDEN",
        403,
        "이용 정지 상태의 가게는 심사를 요청할 수 없습니다.",
        "HM003"
      );
    case "HM005":
      return new AuthGuardError(
        "INVALID_INPUT",
        422,
        fallbackMessage.includes("심사 처리")
          ? "심사 대기 중(pending)인 가게만 승인 또는 반려할 수 있습니다."
          : "현재 상태에서는 심사를 요청할 수 없습니다.",
        "HM005"
      );
    case "HM006":
      return new AuthGuardError(
        "INVALID_INPUT",
        409,
        "이미 반려 처리된 가게입니다.",
        "HM006"
      );
    default:
      break;
  }

  // 22xxx data exception, 23xxx integrity constraint violation (NOT NULL, CHECK, FK, UNIQUE)
  if (code.startsWith("22") || code.startsWith("23")) {
    return new AuthGuardError(
      "INVALID_INPUT",
      400,
      "입력값이 올바르지 않습니다. 입력 내용을 확인해 주세요.",
      `DB_${code}`
    );
  }

  if (isSupabaseAuthGatewayError(error)) {
    return new AuthGuardError(
      "INTERNAL_ERROR",
      500,
      "서버 데이터베이스 인증 또는 연결 오류가 발생했습니다.",
      code ? `SUPABASE_${code}` : "SUPABASE_AUTH_ERROR"
    );
  }

  const safeDbCode = /^[A-Za-z0-9_]{1,32}$/.test(code) ? `DB_${code}` : "DB_QUERY_ERROR";
  return new AuthGuardError("INTERNAL_ERROR", 500, fallbackMessage, safeDbCode);
}

/**
 * Registers a new business application.
 * docs/03_DATA_MODEL.md & tasks/06_business_backend.md (TASK 06-A):
 * 1. A single database transaction (RPC `create_business_with_owner`) creates the business in
 *    'draft' status (never auto-approved), registers the authenticated creator as first 'owner',
 *    and records the optional private registration number as a 'pending' verification.
 *    Either all rows exist or none do.
 * 2. No `user_roles` row is written here. Applying for registration is open to any active
 *    authenticated user; operating an approved business is governed by approved membership.
 * 3. The creator identity is taken from the verified session inside the database (auth.uid()),
 *    never from the request body. Lead conversion is an admin-only flow (not performed here).
 */
export async function createBusinessForMerchant(
  supabase: SupabaseClient<Database>,
  input: CreateBusinessInput
): Promise<Business> {
  const untyped = supabase as unknown as {
    rpc: (
      fn: string,
      args: Record<string, unknown>
    ) => Promise<{ data: unknown; error: DbErrorLike | null }>;
  };

  const { data, error } = await untyped.rpc("create_business_with_owner", {
    p_name: input.name,
    p_category: input.category,
    p_description: input.description ?? null,
    p_road_address: input.road_address,
    p_jibun_address: input.jibun_address ?? null,
    p_address_detail: input.address_detail ?? null,
    p_latitude: input.latitude,
    p_longitude: input.longitude,
    p_phone: input.phone ?? null,
    p_website_url: input.website_url ?? null,
    p_registration_number: input.registration_number ?? null,
  });

  if (error || !data) {
    throw mapBusinessDbError(error, "가게 등록 중 오류가 발생했습니다.");
  }

  return data as Business;
}

/**
 * Lists businesses associated with the merchant.
 * If user is admin, returns all businesses.
 */
export async function listBusinessesForMerchant(
  supabase: SupabaseClient<Database>,
  userId: string,
  isAdmin: boolean
): Promise<BusinessSummaryItem[]> {
  const untyped = supabase as unknown as {
    from: (table: string) => any;
  };

  if (isAdmin) {
    const { data: businesses, error } = await untyped
      .from("businesses")
      .select("id, name, category, road_address, registration_status, created_at, updated_at")
      .order("created_at", { ascending: false });

    if (error) {
      throw new AuthGuardError(
        "INVALID_INPUT",
        500,
        "가게 목록을 불러오는 중 오류가 발생했습니다."
      );
    }

    return (businesses || []).map((b: any) => ({
      id: b.id,
      name: b.name,
      category: b.category,
      road_address: b.road_address,
      registration_status: b.registration_status,
      role: "admin",
      created_at: b.created_at,
      updated_at: b.updated_at,
    }));
  }

  // Merchant: query active memberships
  const { data: memberships, error: memberError } = await untyped
    .from("business_members")
    .select("business_id, role, membership_status")
    .eq("user_id", userId)
    .eq("membership_status", "active");

  if (memberError) {
    throw new AuthGuardError(
      "INVALID_INPUT",
      500,
      "가게 권한 목록을 불러오는 중 오류가 발생했습니다."
    );
  }

  if (!memberships || memberships.length === 0) {
    return [];
  }

  const businessIds = memberships.map((m: any) => m.business_id);
  const roleMap = new Map<string, BusinessMemberRole>();
  for (const m of memberships) {
    roleMap.set(m.business_id, m.role);
  }

  const { data: businesses, error: bizError } = await untyped
    .from("businesses")
    .select("id, name, category, road_address, registration_status, created_at, updated_at")
    .in("id", businessIds)
    .order("created_at", { ascending: false });

  if (bizError) {
    throw new AuthGuardError(
      "INVALID_INPUT",
      500,
      "가게 목록을 불러오는 중 오류가 발생했습니다."
    );
  }

  return (businesses || []).map((b: any) => ({
    id: b.id,
    name: b.name,
    category: b.category,
    road_address: b.road_address,
    registration_status: b.registration_status,
    role: roleMap.get(b.id) ?? "owner",
    created_at: b.created_at,
    updated_at: b.updated_at,
  }));
}

/**
 * Gets business detail by ID, verifying membership or admin role.
 */
export async function getBusinessDetailForMerchant(
  supabase: SupabaseClient<Database>,
  businessId: string,
  userId: string,
  isAdmin: boolean
): Promise<BusinessDetail> {
  const untyped = supabase as unknown as {
    from: (table: string) => any;
  };

  let myRole: BusinessMemberRole | "admin" = "admin";

  if (!isAdmin) {
    const { data: membership, error: memberError } = await untyped
      .from("business_members")
      .select("role, membership_status")
      .eq("business_id", businessId)
      .eq("user_id", userId)
      .eq("membership_status", "active")
      .maybeSingle();

    if (memberError || !membership) {
      throw new AuthGuardError(
        "FORBIDDEN",
        403,
        "해당 가게에 접근할 권한이 없습니다."
      );
    }
    myRole = membership.role as BusinessMemberRole;
  }

  const { data: biz, error: bizError } = await untyped
    .from("businesses")
    .select(BUSINESS_SELECT_COLUMNS)
    .eq("id", businessId)
    .maybeSingle();

  if (bizError || !biz) {
    throw new AuthGuardError(
      "INVALID_INPUT",
      404,
      "가게를 찾을 수 없습니다."
    );
  }

  // Fetch members
  const { data: members } = await untyped
    .from("business_members")
    .select("business_id, user_id, role, membership_status, joined_at")
    .eq("business_id", businessId);

  // Fetch hours
  const { data: hours } = await untyped
    .from("business_hours")
    .select("id, business_id, weekday, opens_at, closes_at, is_closed, crosses_midnight")
    .eq("business_id", businessId)
    .order("weekday", { ascending: true });

  // Fetch verification status summaries (private columns are never selected or returned)
  let verifications: BusinessVerificationSummary[] = [];
  if (isAdmin || myRole === "owner") {
    const { data: verifData } = await untyped
      .from("business_verifications")
      .select(BUSINESS_VERIFICATION_PUBLIC_COLUMNS)
      .eq("business_id", businessId)
      .order("created_at", { ascending: false });
    verifications = verifData || [];
  }

  return {
    ...(biz as Business),
    members: (members || []) as BusinessMember[],
    hours: (hours || []) as BusinessHours[],
    verifications,
    my_role: myRole,
  };
}

/**
 * Updates editable non-approval fields of own business.
 * docs/04_API_CONTRACT.md line 22:
 * "update own draft; approved changes can reset review as specified"
 * - Only whitelisted columns are written (column-level GRANT enforces the same in the database).
 * - registration_status/approved_* are never sent; the database trigger resets an approved or
 *   pending business to 'draft' when a non-admin edits it, so the client cannot influence approval state.
 * - Suspended businesses cannot be edited by members.
 */
export async function updateBusinessForMerchant(
  supabase: SupabaseClient<Database>,
  businessId: string,
  userId: string,
  isAdmin: boolean,
  input: UpdateBusinessInput
): Promise<Business> {
  const untyped = supabase as unknown as {
    from: (table: string) => any;
  };

  if (!isAdmin) {
    const { data: membership, error: memberError } = await untyped
      .from("business_members")
      .select("role, membership_status")
      .eq("business_id", businessId)
      .eq("user_id", userId)
      .eq("membership_status", "active")
      .maybeSingle();

    if (memberError || !membership) {
      throw new AuthGuardError(
        "FORBIDDEN",
        403,
        "해당 가게를 수정할 권한이 없습니다."
      );
    }
  }

  const { data: currentBiz, error: fetchError } = await untyped
    .from("businesses")
    .select(BUSINESS_SELECT_COLUMNS)
    .eq("id", businessId)
    .maybeSingle();

  if (fetchError || !currentBiz) {
    throw new AuthGuardError(
      "INVALID_INPUT",
      404,
      "수정할 가게를 찾을 수 없습니다."
    );
  }

  if (!isAdmin && currentBiz.registration_status === "suspended") {
    throw new AuthGuardError(
      "FORBIDDEN",
      403,
      "이용 정지 상태의 가게는 수정할 수 없습니다."
    );
  }

  const updates: Record<string, unknown> = {};
  for (const field of EDITABLE_BUSINESS_FIELDS) {
    const value = input[field];
    if (value !== undefined && value !== (currentBiz as Record<string, unknown>)[field]) {
      updates[field] = value;
    }
  }

  // 승인된 가게의 핵심 승인 근거 필드(상호, 업종, 주소, 위치 좌표) 무단 변경 차단:
  // 재심사 정책 확정 전까지 일반 정보(설명, 전화, 사이트)만 수정 허용.
  if (!isAdmin && currentBiz.registration_status === "approved") {
    const attemptsCoreChange = CORE_APPROVAL_FIELDS.some(
      (f) => updates[f] !== undefined
    );
    if (attemptsCoreChange) {
      throw new AuthGuardError(
        "FORBIDDEN",
        403,
        "승인 완료된 가게의 핵심 정보(상호, 업종, 주소, 위치 좌표)는 재심사 정책 확정 전까지 임의로 변경할 수 없습니다. 변경이 필요한 경우 관리자에게 문의해 주세요."
      );
    }
  }

  // Nothing actually changes: do not write (and do not disturb the approval state).
  if (Object.keys(updates).length === 0) {
    return currentBiz as Business;
  }

  const { data: updatedBiz, error: updateError } = await untyped
    .from("businesses")
    .update(updates)
    .eq("id", businessId)
    .select(BUSINESS_SELECT_COLUMNS)
    .single();

  if (updateError || !updatedBiz) {
    throw mapBusinessDbError(updateError, "가게 정보 수정 중 오류가 발생했습니다.");
  }

  return updatedBiz as Business;
}

/**
 * Submits a business for administrator review (draft/rejected -> pending).
 * docs/04_API_CONTRACT.md line 23:
 * "POST /merchant/businesses/:id/submit -> pending; required fields validation"
 * Executed by the database function `submit_business_for_review`: owner-only (verified via
 * auth.uid()), row-locked, and the only transitions allowed are draft -> pending and rejected -> pending.
 */
export async function submitBusinessForMerchant(
  supabase: SupabaseClient<Database>,
  businessId: string
): Promise<Business> {
  const untyped = supabase as unknown as {
    rpc: (
      fn: string,
      args: Record<string, unknown>
    ) => Promise<{ data: unknown; error: DbErrorLike | null }>;
  };

  const { data, error } = await untyped.rpc("submit_business_for_review", {
    p_business_id: businessId,
  });

  if (error || !data) {
    throw mapBusinessDbError(error, "심사 요청 중 오류가 발생했습니다.");
  }

  return data as Business;
}

/**
 * Gate for features that require an APPROVED business (restrooms, PIN, access policy, ...).
 * Registration (application) permission and approved-business operation permission are separate:
 * an active member of a draft/pending/rejected/suspended business is rejected here.
 * Operating an approved business strictly requires both the 'merchant' role (or 'admin') and
 * active membership in the approved business.
 * Later tasks must call this (or the SQL helper `is_approved_business_member`) before exposing
 * approved-only functionality.
 */
export async function requireApprovedBusinessMembership(
  supabase: SupabaseClient<Database>,
  businessId: string,
  userId: string,
  options: { ownerOnly?: boolean; userRoles?: UserRoleType[] } = {}
): Promise<{ role: BusinessMemberRole }> {
  const untyped = supabase as unknown as {
    from: (table: string) => any;
  };

  // 1. Verify merchant (or admin) role
  if (options.userRoles) {
    const hasRole = options.userRoles.includes("merchant") || options.userRoles.includes("admin");
    if (!hasRole) {
      throw new AuthGuardError(
        "FORBIDDEN",
        403,
        "제휴 사업자 권한이 없습니다."
      );
    }
  } else {
    const { data: roleRow, error: roleError } = await untyped
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .in("role", ["merchant", "admin"])
      .maybeSingle();

    if (roleError || !roleRow) {
      throw new AuthGuardError(
        "FORBIDDEN",
        403,
        "제휴 사업자 권한이 없습니다."
      );
    }
  }

  // 2. Verify business membership
  const { data: membership, error: memberError } = await untyped
    .from("business_members")
    .select("role, membership_status")
    .eq("business_id", businessId)
    .eq("user_id", userId)
    .eq("membership_status", "active")
    .maybeSingle();

  if (memberError || !membership) {
    throw new AuthGuardError(
      "FORBIDDEN",
      403,
      "해당 가게의 소속 관리자가 아닙니다."
    );
  }

  if (options.ownerOnly && membership.role !== "owner") {
    throw new AuthGuardError(
      "FORBIDDEN",
      403,
      "해당 작업은 가게 소유자만 수행할 수 있습니다."
    );
  }

  // 3. Verify business approval status
  const { data: biz, error: bizError } = await untyped
    .from("businesses")
    .select("registration_status")
    .eq("id", businessId)
    .maybeSingle();

  if (bizError || !biz || biz.registration_status !== "approved") {
    throw new AuthGuardError(
      "FORBIDDEN",
      403,
      "관리자 승인이 완료된 가게만 이용할 수 있는 기능입니다."
    );
  }

  return { role: membership.role as BusinessMemberRole };
}

/**
 * Lists businesses for administrator review (docs/04_API_CONTRACT.md line 26).
 * Gated strictly to users holding the server-verified 'admin' role.
 * Defaults to filtering for 'pending' applications.
 */
export async function listBusinessesForAdmin(
  supabase: SupabaseClient<Database>,
  filter: AdminBusinessListFilter = { status: "pending", limit: 50 }
): Promise<{ businesses: AdminBusinessSummaryItem[]; count: number }> {
  const untyped = supabase as unknown as {
    from: (table: string) => any;
  };

  const status = filter.status ?? "pending";
  const rawLimit = Number(filter.limit ?? 50) || 50;
  const limit = Math.min(rawLimit, 200);

  let query = untyped
    .from("businesses")
    .select(BUSINESS_SELECT_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (status !== "all") {
    query = query.eq("registration_status", status);
  }

  const { data: businesses, error } = await query;
  if (error) {
    throw mapBusinessDbError(error, "가게 심사 목록 조회 중 오류가 발생했습니다.");
  }

  const rawList = (businesses || []) as Business[];

  // Fetch applicant profiles if available
  const applicantIds = Array.from(new Set(rawList.map((b) => b.created_by).filter(Boolean)));
  const profilesMap = new Map<string, { display_name: string | null }>();

  if (applicantIds.length > 0) {
    const { data: profiles } = await untyped
      .from("profiles")
      .select("id, display_name")
      .in("id", applicantIds);

    if (profiles) {
      for (const p of profiles) {
        profilesMap.set(p.id, { display_name: p.display_name });
      }
    }
  }

  const items: AdminBusinessSummaryItem[] = rawList.map((b) => ({
    id: b.id,
    name: b.name,
    category: b.category,
    road_address: b.road_address,
    registration_status: b.registration_status,
    role: "admin",
    created_by: b.created_by,
    applicant_name: profilesMap.get(b.created_by)?.display_name ?? null,
    rejection_reason: b.rejection_reason,
    created_at: b.created_at,
    updated_at: b.updated_at,
  }));

  // Apply optional search query filter in-memory if provided
  let filtered = items;
  if (filter.q && filter.q.trim()) {
    const q = filter.q.trim().toLowerCase();
    filtered = items.filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        b.category.toLowerCase().includes(q) ||
        b.road_address.toLowerCase().includes(q) ||
        (b.applicant_name && b.applicant_name.toLowerCase().includes(q))
    );
  }

  return { businesses: filtered, count: filtered.length };
}

/**
 * Retrieves full business details for administrator review.
 * Includes private verification data (registration_number, evidence_storage_path, etc.)
 * which are protected from merchant/customer exposure.
 */
export async function getBusinessDetailForAdmin(
  supabase: SupabaseClient<Database>,
  businessId: string
): Promise<AdminBusinessDetail> {
  const untyped = supabase as unknown as {
    from: (table: string) => any;
  };

  // 1. Fetch business
  const { data: business, error: bizError } = await untyped
    .from("businesses")
    .select(BUSINESS_SELECT_COLUMNS)
    .eq("id", businessId)
    .maybeSingle();

  if (bizError) {
    throw mapBusinessDbError(
      bizError,
      "가게 상세 조회 중 데이터베이스 오류가 발생했습니다."
    );
  }

  if (!business) {
    throw new AuthGuardError(
      "NOT_FOUND",
      404,
      "가게 정보를 찾을 수 없습니다.",
      "BUSINESS_NOT_FOUND"
    );
  }

  // 2. Fetch members
  const { data: members, error: membersError } = await untyped
    .from("business_members")
    .select("business_id, user_id, role, membership_status, joined_at")
    .eq("business_id", businessId);
  if (membersError) {
    throw mapBusinessDbError(membersError, "가게 소속 멤버 조회 중 오류가 발생했습니다.");
  }

  // 3. Fetch hours
  const { data: hours, error: hoursError } = await untyped
    .from("business_hours")
    .select("id, business_id, weekday, opens_at, closes_at, is_closed, crosses_midnight")
    .eq("business_id", businessId)
    .order("weekday", { ascending: true });
  if (hoursError) {
    throw mapBusinessDbError(hoursError, "가게 영업시간 조회 중 오류가 발생했습니다.");
  }

  // 4. Fetch full verifications (including private fields)
  const { data: verifications, error: verifError } = await untyped
    .from("business_verifications")
    .select(BUSINESS_VERIFICATION_ADMIN_COLUMNS)
    .eq("business_id", businessId)
    .order("created_at", { ascending: false });
  if (verifError) {
    throw mapBusinessDbError(verifError, "가게 인증 정보 조회 중 오류가 발생했습니다.");
  }

  // 5. Fetch applicant profile
  let applicantProfile: { id: string; display_name: string | null; account_status: string } | null = null;
  if (business.created_by) {
    const { data: profile, error: profileError } = await untyped
      .from("profiles")
      .select("id, display_name, account_status")
      .eq("id", business.created_by)
      .maybeSingle();
    if (profileError) {
      throw mapBusinessDbError(profileError, "신청자 프로필 조회 중 오류가 발생했습니다.");
    }
    applicantProfile = profile || null;
  }

  // 6. Fetch audit logs for this business
  const { data: auditLogs, error: auditError } = await untyped
    .from("audit_logs")
    .select("id, actor_user_id, action, entity_type, entity_id, before_data, after_data, reason, created_at")
    .eq("entity_type", "businesses")
    .eq("entity_id", businessId)
    .order("created_at", { ascending: false });
  if (auditError) {
    throw mapBusinessDbError(auditError, "가게 감사 로그 조회 중 오류가 발생했습니다.");
  }

  return {
    ...(business as Business),
    members: (members || []) as BusinessMember[],
    hours: (hours || []) as BusinessHours[],
    verifications: (verifications || []) as AdminBusinessVerification[],
    applicant_profile: applicantProfile,
    audit_logs: (auditLogs || []) as AuditLogItem[],
    my_role: "admin",
  };
}

/**
 * Executes administrator approval or rejection decision.
 * Invokes the atomic RPC `decide_business_approval`:
 * - If approved: sets status='approved', records approval time, grants 'merchant' role in user_roles, and writes audit log.
 * - If rejected: sets status='rejected', records rejection_reason, and writes audit log.
 */
export async function decideBusinessApproval(
  supabase: SupabaseClient<Database>,
  businessId: string,
  input: AdminBusinessDecisionInput
): Promise<Business> {
  const parsed = adminBusinessDecisionSchema.safeParse(input);
  if (!parsed.success) {
    const firstMsg = parsed.error.issues[0]?.message ?? "심사 결정 입력값이 올바르지 않습니다.";
    throw new AuthGuardError("INVALID_INPUT", 400, firstMsg);
  }

  const untyped = supabase as unknown as {
    rpc: (
      fn: string,
      args: Record<string, unknown>
    ) => Promise<{ data: unknown; error: DbErrorLike | null }>;
  };

  const { data, error } = await untyped.rpc("decide_business_approval", {
    p_business_id: businessId,
    p_decision: parsed.data.decision,
    p_rejection_reason: parsed.data.rejection_reason || null,
    p_review_notes: parsed.data.review_notes || null,
  });

  if (error || !data) {
    throw mapBusinessDbError(error, "가게 심사 처리 중 오류가 발생했습니다.");
  }

  return data as Business;
}

