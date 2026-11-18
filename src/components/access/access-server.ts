/**
 * Server-only Customer Access Session & Visit Confirmation Service
 * Spec: docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/05_SCREEN_SPEC.md,
 *       docs/07_PAYMENT_ACCESS_REFUND.md, docs/08_SECURITY_OPERATIONS.md, tasks/25_pin_ui.md
 *
 * Security Invariants:
 * - Strictly enforces customer ownership (session.user_id === authenticated userId).
 * - Never queries or returns `restroom_lock_secrets` or plaintext/encrypted PINs.
 * - Never returns internal `idempotency_key`, `provider_payment_key`, or `provider_cancel_id`.
 * - Visit confirmation only records customer's assertion (`verification_method = 'user'`)
 *   for an eligible access session after payment confirmation.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";
import { createAdminClient, createServerClientInstance, isServiceRoleConfigured } from "@/lib/supabase/server";
import {
  toPublicAccessSession,
  type AccessMethodSnapshot,
  type AccessSessionRow,
  type PublicAccessSession,
  type VisitConfirmationRow,
} from "@/lib/access/types";
import {
  toPublicPaymentOrder,
  toPublicPaymentRefund,
  type PaymentOrderRow,
  type PaymentRefundRow,
  type PublicPaymentOrder,
  type PublicPaymentRefund,
} from "@/lib/payments/types";
import {
  evaluatePinRevealEligibility,
  resolveEffectiveAccessStatus,
  visitConfirmationSubmitSchema,
  type AccessPolicySummary,
  type AccessRestroomSummary,
  type CustomerAccessDetail,
  type CustomerAccessListItem,
  type PublicVisitConfirmation,
} from "./types";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CustomerAccessError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "CustomerAccessError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function toPublicVisitConfirmation(
  row: VisitConfirmationRow
): PublicVisitConfirmation {
  return {
    id: row.id,
    access_session_id: row.access_session_id,
    usage_status: row.usage_status,
    verification_method: row.verification_method,
    arrival_confirmed_at: row.arrival_confirmed_at,
    failure_reason: row.failure_reason,
    verified_at: row.verified_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const SAFE_ACCESS_SESSION_COLUMNS =
  "id, user_id, restroom_id, policy_id, status, access_method_snapshot, authorized_at, code_revealed_at, expires_at, created_at, updated_at";

const SAFE_PAYMENT_ORDER_COLUMNS =
  "id, access_session_id, user_id, order_id, provider, payment_mode, amount_krw, status, approved_at, failure_code, created_at, updated_at";

const SAFE_PAYMENT_REFUND_COLUMNS =
  "id, payment_order_id, receipt_submission_id, amount_krw, status, failure_reason, requested_at, completed_at";

const SAFE_VISIT_CONFIRMATION_COLUMNS =
  "id, access_session_id, usage_status, verification_method, verified_by, arrival_confirmed_at, failure_reason, verified_at, created_at, updated_at";

async function resolveQueryClient(
  injectedClient?: SupabaseClient<Database>
): Promise<SupabaseClient<Database>> {
  if (injectedClient) return injectedClient;
  if (isServiceRoleConfigured()) {
    return createAdminClient();
  }
  return createServerClientInstance();
}

/**
 * Lists the authenticated customer's own access sessions in reverse chronological order.
 * Strictly filters by `user_id = userId` so other customers' sessions are never returned.
 */
export async function listCustomerAccessSessions(params: {
  userId: string;
  limit?: number;
  injectedClient?: SupabaseClient<Database>;
}): Promise<CustomerAccessListItem[]> {
  const { userId, limit = 30, injectedClient } = params;

  if (!userId || !UUID_REGEX.test(userId)) {
    throw new CustomerAccessError(
      "UNAUTHORIZED",
      "로그인이 필요한 서비스입니다.",
      401
    );
  }

  const supabase = (await resolveQueryClient(injectedClient)) as any;
  const safeLimit = Math.min(Math.max(1, limit), 100);

  const { data: sessionRows, error: sessionErr } = await supabase
    .from("access_sessions")
    .select(SAFE_ACCESS_SESSION_COLUMNS)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(safeLimit);

  if (sessionErr) {
    throw new CustomerAccessError(
      "DATABASE_ERROR",
      "이용권 목록을 불러오는 중 오류가 발생했습니다.",
      500
    );
  }

  const sessions = ((sessionRows || []) as AccessSessionRow[]).filter(
    (s) => s.user_id === userId
  );

  if (sessions.length === 0) {
    return [];
  }

  const sessionIds = sessions.map((s) => s.id);
  const restroomIds = Array.from(new Set(sessions.map((s) => s.restroom_id)));

  // Batch fetch restrooms, orders, and visit confirmations
  const [restroomsRes, ordersRes, visitsRes] = await Promise.all([
    supabase
      .from("restrooms")
      .select(
        "id, name, road_address, address_detail, floor, entrance_instructions, access_method, publication_status, business_id"
      )
      .in("id", restroomIds),
    supabase
      .from("payment_orders")
      .select(SAFE_PAYMENT_ORDER_COLUMNS)
      .eq("user_id", userId)
      .in("access_session_id", sessionIds)
      .order("created_at", { ascending: false }),
    supabase
      .from("visit_confirmations")
      .select(SAFE_VISIT_CONFIRMATION_COLUMNS)
      .in("access_session_id", sessionIds)
      .order("created_at", { ascending: false }),
  ]);

  const rawRestrooms = (restroomsRes.data || []) as Array<{
    id: string;
    name: string;
    road_address: string;
    address_detail: string | null;
    floor: string | null;
    entrance_instructions: string | null;
    access_method: AccessMethodSnapshot;
    publication_status: string;
    business_id: string | null;
  }>;

  const businessIds = Array.from(
    new Set(
      rawRestrooms
        .map((r) => r.business_id)
        .filter((id): id is string => Boolean(id))
    )
  );

  const businessMap = new Map<
    string,
    { name: string; category: string; phone: string | null }
  >();

  if (businessIds.length > 0) {
    const { data: bizRows } = await supabase
      .from("businesses")
      .select("id, name, category, phone")
      .in("id", businessIds);

    for (const b of (bizRows || []) as Array<{
      id: string;
      name: string;
      category: string;
      phone: string | null;
    }>) {
      businessMap.set(b.id, {
        name: b.name,
        category: b.category,
        phone: b.phone,
      });
    }
  }

  const restroomMap = new Map<string, AccessRestroomSummary>();
  for (const r of rawRestrooms) {
    const biz = r.business_id ? businessMap.get(r.business_id) : null;
    restroomMap.set(r.id, {
      id: r.id,
      name: r.name,
      road_address: r.road_address,
      address_detail: r.address_detail,
      floor: r.floor,
      entrance_instructions: r.entrance_instructions,
      access_method: r.access_method,
      publication_status: r.publication_status,
      business_id: r.business_id,
      business_name: biz?.name ?? null,
      business_category: biz?.category ?? null,
      business_phone: biz?.phone ?? null,
    });
  }

  const rawOrders = (ordersRes.data || []) as PaymentOrderRow[];
  const orderBySessionMap = new Map<string, PublicPaymentOrder>();
  for (const ord of rawOrders) {
    const existing = orderBySessionMap.get(ord.access_session_id);
    // Prefer 'approved' order if multiple exist for same session
    if (!existing || ord.status === "approved") {
      orderBySessionMap.set(ord.access_session_id, toPublicPaymentOrder(ord));
    }
  }

  const orderIds = Array.from(orderBySessionMap.values()).map((o) => o.id);
  const refundByOrderMap = new Map<string, PublicPaymentRefund>();

  if (orderIds.length > 0) {
    const { data: refundRows } = await supabase
      .from("payment_refunds")
      .select(SAFE_PAYMENT_REFUND_COLUMNS)
      .in("payment_order_id", orderIds);

    for (const ref of (refundRows || []) as PaymentRefundRow[]) {
      refundByOrderMap.set(ref.payment_order_id, toPublicPaymentRefund(ref));
    }
  }

  const visitBySessionMap = new Map<string, PublicVisitConfirmation>();
  for (const v of (visitsRes.data || []) as VisitConfirmationRow[]) {
    if (!visitBySessionMap.has(v.access_session_id)) {
      visitBySessionMap.set(
        v.access_session_id,
        toPublicVisitConfirmation(v)
      );
    }
  }

  const now = new Date();
  return sessions.map((rawSession) => {
    const publicSession: PublicAccessSession = toPublicAccessSession(rawSession);
    const restroom = restroomMap.get(publicSession.restroom_id) ?? null;
    const order = orderBySessionMap.get(publicSession.id) ?? null;
    const refund = order ? refundByOrderMap.get(order.id) ?? null : null;
    const latestVisitConfirmation =
      visitBySessionMap.get(publicSession.id) ?? null;
    const effectiveStatus = resolveEffectiveAccessStatus(
      publicSession,
      refund,
      now
    );
    const eligibility = evaluatePinRevealEligibility({
      session: publicSession,
      order,
      refund,
      restroom,
      now,
    });

    return {
      session: publicSession,
      effectiveStatus,
      restroom,
      order,
      refund,
      latestVisitConfirmation,
      eligibleForPinReveal: eligibility.eligible,
    };
  });
}

/**
 * Retrieves a single customer access session detail.
 * Enforces strict ownership: if the session belongs to another user, throws 403 FORBIDDEN.
 * Never includes doorlock PIN in the returned object.
 */
export async function getCustomerAccessSessionDetail(params: {
  userId: string;
  accessSessionId: string;
  injectedClient?: SupabaseClient<Database>;
}): Promise<CustomerAccessDetail> {
  const { userId, accessSessionId, injectedClient } = params;

  if (!userId || !UUID_REGEX.test(userId)) {
    throw new CustomerAccessError(
      "UNAUTHORIZED",
      "로그인이 필요한 서비스입니다.",
      401
    );
  }

  if (!accessSessionId || !UUID_REGEX.test(accessSessionId)) {
    throw new CustomerAccessError(
      "VALIDATION_ERROR",
      "유효한 이용권 식별자(UUID)가 아닙니다.",
      400
    );
  }

  const supabase = (await resolveQueryClient(injectedClient)) as any;

  const { data: sessionRow, error: sessionErr } = await supabase
    .from("access_sessions")
    .select(SAFE_ACCESS_SESSION_COLUMNS)
    .eq("id", accessSessionId)
    .maybeSingle();

  if (sessionErr) {
    throw new CustomerAccessError(
      "DATABASE_ERROR",
      "이용권 상세 정보를 조회하는 중 오류가 발생했습니다.",
      500
    );
  }

  if (!sessionRow) {
    throw new CustomerAccessError(
      "ACCESS_NOT_FOUND",
      "요청하신 화장실 이용권을 찾을 수 없습니다.",
      404
    );
  }

  const typedSession = sessionRow as AccessSessionRow;

  // CRITICAL SECURITY CHECK: Strict customer ownership isolation (TASK 25: 타 고객 이용권 조회 금지)
  if (typedSession.user_id !== userId) {
    throw new CustomerAccessError(
      "FORBIDDEN",
      "타인의 화장실 이용권은 조회할 수 없습니다.",
      403
    );
  }

  const publicSession = toPublicAccessSession(typedSession);

  // Fetch restroom, policy, orders, and visit confirmations in parallel
  const [restroomRes, policyRes, ordersRes, visitsRes] = await Promise.all([
    supabase
      .from("restrooms")
      .select(
        "id, name, road_address, address_detail, floor, entrance_instructions, access_method, publication_status, business_id"
      )
      .eq("id", publicSession.restroom_id)
      .maybeSingle(),
    supabase
      .from("restroom_access_policies")
      .select(
        "id, version, access_mode, deposit_amount_krw, refund_eligible, receipt_window_hours, min_purchase_krw"
      )
      .eq("id", publicSession.policy_id)
      .maybeSingle(),
    supabase
      .from("payment_orders")
      .select(SAFE_PAYMENT_ORDER_COLUMNS)
      .eq("access_session_id", publicSession.id)
      .eq("user_id", userId)
      .order("created_at", { ascending: false }),
    supabase
      .from("visit_confirmations")
      .select(SAFE_VISIT_CONFIRMATION_COLUMNS)
      .eq("access_session_id", publicSession.id)
      .order("created_at", { ascending: false }),
  ]);

  let restroom: AccessRestroomSummary | null = null;
  if (restroomRes.data) {
    const r = restroomRes.data as {
      id: string;
      name: string;
      road_address: string;
      address_detail: string | null;
      floor: string | null;
      entrance_instructions: string | null;
      access_method: AccessMethodSnapshot;
      publication_status: string;
      business_id: string | null;
    };

    let businessName: string | null = null;
    let businessCategory: string | null = null;
    let businessPhone: string | null = null;

    if (r.business_id) {
      const { data: bizData } = await supabase
        .from("businesses")
        .select("id, name, category, phone")
        .eq("id", r.business_id)
        .maybeSingle();

      if (bizData) {
        businessName = bizData.name ?? null;
        businessCategory = bizData.category ?? null;
        businessPhone = bizData.phone ?? null;
      }
    }

    restroom = {
      id: r.id,
      name: r.name,
      road_address: r.road_address,
      address_detail: r.address_detail,
      floor: r.floor,
      entrance_instructions: r.entrance_instructions,
      access_method: r.access_method,
      publication_status: r.publication_status,
      business_id: r.business_id,
      business_name: businessName,
      business_category: businessCategory,
      business_phone: businessPhone,
    };
  }

  const policy = (policyRes.data as AccessPolicySummary | null) ?? null;

  const rawOrders = (ordersRes.data || []) as PaymentOrderRow[];
  let chosenOrder: PublicPaymentOrder | null = null;
  for (const ord of rawOrders) {
    if (!chosenOrder || ord.status === "approved") {
      chosenOrder = toPublicPaymentOrder(ord);
    }
  }

  let refund: PublicPaymentRefund | null = null;
  if (chosenOrder) {
    const { data: refundData } = await supabase
      .from("payment_refunds")
      .select(SAFE_PAYMENT_REFUND_COLUMNS)
      .eq("payment_order_id", chosenOrder.id)
      .maybeSingle();

    if (refundData) {
      refund = toPublicPaymentRefund(refundData as PaymentRefundRow);
    }
  }

  const visitConfirmations = (
    (visitsRes.data || []) as VisitConfirmationRow[]
  ).map(toPublicVisitConfirmation);

  const now = new Date();
  const effectiveStatus = resolveEffectiveAccessStatus(
    publicSession,
    refund,
    now
  );
  const eligibility = evaluatePinRevealEligibility({
    session: publicSession,
    order: chosenOrder,
    refund,
    restroom,
    now,
  });

  return {
    session: publicSession,
    effectiveStatus,
    restroom,
    policy,
    order: chosenOrder,
    refund,
    latestVisitConfirmation: visitConfirmations[0] ?? null,
    visitConfirmations,
    eligibleForPinReveal: eligibility.eligible,
  };
}

/**
 * Records a customer's visit confirmation assertion (`public.visit_confirmations`).
 * Spec: docs/03_DATA_MODEL.md line 312 & line 481, docs/04_API_CONTRACT.md line 47.
 */
export async function submitCustomerVisitConfirmation(params: {
  userId: string;
  accessSessionId: string;
  rawInput: unknown;
  injectedClient?: SupabaseClient<Database>;
}): Promise<{
  confirmation: PublicVisitConfirmation;
  sessionStatus: string;
  reused: boolean;
}> {
  const { userId, accessSessionId, rawInput, injectedClient } = params;

  if (!userId || !UUID_REGEX.test(userId)) {
    throw new CustomerAccessError(
      "UNAUTHORIZED",
      "로그인이 필요한 서비스입니다.",
      401
    );
  }

  if (!accessSessionId || !UUID_REGEX.test(accessSessionId)) {
    throw new CustomerAccessError(
      "VALIDATION_ERROR",
      "유효한 이용권 식별자(UUID)가 아닙니다.",
      400
    );
  }

  const parsed = visitConfirmationSubmitSchema.safeParse(rawInput);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    throw new CustomerAccessError(
      "VALIDATION_ERROR",
      firstIssue?.message || "방문 확인 입력값이 올바르지 않습니다.",
      400
    );
  }

  const { usageStatus, failureReason } = parsed.data;
  const normalizedReason =
    usageStatus === "failed" && failureReason ? failureReason.trim() : null;

  if (!injectedClient && !isServiceRoleConfigured()) {
    throw new CustomerAccessError(
      "CONFIG_REQUIRED",
      "서버 DB 보안 서비스 설정이 필요합니다.",
      503
    );
  }

  const adminClient = (injectedClient ?? createAdminClient()) as any;

  if (typeof adminClient?.rpc !== "function") {
    throw new CustomerAccessError(
      "DATABASE_ERROR",
      "방문 확인 원자적 RPC 클라이언트를 초기화할 수 없습니다.",
      500
    );
  }

  // Execute atomic PostgreSQL RPC (`record_customer_visit_confirmation`) via service_role.
  // Never falls back to non-atomic SELECT -> INSERT queries.
  const { data: rpcData, error: rpcError } = await adminClient.rpc(
    "record_customer_visit_confirmation",
    {
      p_access_session_id: accessSessionId,
      p_caller_user_id: userId,
      p_usage_status: usageStatus,
      p_failure_reason: normalizedReason,
    }
  );

  if (rpcError) {
    throw new CustomerAccessError(
      "DATABASE_ERROR",
      "방문 확인 기록 처리 중 데이터베이스 오류가 발생했습니다.",
      500
    );
  }

  const rpcResult = (
    typeof rpcData === "string" ? JSON.parse(rpcData) : rpcData
  ) as {
    ok: boolean;
    reused?: boolean;
    session_status?: string;
    confirmation?: VisitConfirmationRow;
    error_code?: string;
    message?: string;
    status?: number;
  };

  if (!rpcResult || !rpcResult.ok || !rpcResult.confirmation) {
    throw new CustomerAccessError(
      rpcResult?.error_code || "VISIT_CONFIRMATION_FAILED",
      rpcResult?.message || "방문 확인을 기록할 수 없습니다.",
      rpcResult?.status || 422
    );
  }

  return {
    confirmation: toPublicVisitConfirmation(rpcResult.confirmation),
    sessionStatus: rpcResult.session_status || "authorized",
    reused: Boolean(rpcResult.reused),
  };
}

