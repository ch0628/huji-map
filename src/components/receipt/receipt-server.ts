/**
 * Server-only Customer Receipt Service
 * Spec: docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/05_SCREEN_SPEC.md,
 *       docs/07_PAYMENT_ACCESS_REFUND.md, docs/08_SECURITY_OPERATIONS.md, tasks/27_receipt_customer_ui.md
 *
 * Security Invariants:
 * - Strictly enforces customer ownership (user_id === authenticated userId).
 * - Never returns public storage URLs or leaks other customers' receipts.
 * - Does not auto-approve or auto-refund receipts.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";
import { createAdminClient, createServerClientInstance, isServiceRoleConfigured } from "@/lib/supabase/server";
import type {
  CustomerReceiptItem,
  EligibleAccessSessionItem,
  CustomerReceiptsData,
  RefundStatus,
} from "./types";
import type { ReceiptMimeType, ReceiptSubmissionStatus } from "@/lib/receipts/types";

export class CustomerReceiptError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "CustomerReceiptError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

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
 * Lists the authenticated customer's submitted receipts and eligible access sessions.
 * Strictly scoped to `userId`.
 */
export async function listCustomerReceiptsAndEligibleSessions(params: {
  userId: string;
  injectedClient?: SupabaseClient<Database>;
}): Promise<CustomerReceiptsData> {
  const { userId, injectedClient } = params;

  if (!userId) {
    throw new CustomerReceiptError("UNAUTHENTICATED", "로그인이 필요합니다.", 401);
  }

  const client = await resolveQueryClient(injectedClient);

  // 1. Fetch user's receipt submissions ordered by created_at DESC
  const { data: rawReceipts, error: receiptsErr } = await (client as any)
    .from("receipt_submissions")
    .select(`
      id,
      access_session_id,
      user_id,
      storage_path,
      mime_type,
      file_size_bytes,
      original_filename,
      submission_status,
      store_name_confirmed,
      purchase_at_confirmed,
      purchase_amount_krw,
      reviewed_at,
      review_reason,
      created_at,
      updated_at
    `)
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (receiptsErr) {
    throw new CustomerReceiptError(
      "DATABASE_ERROR",
      "영수증 목록을 불러오는 중 데이터베이스 오류가 발생했습니다.",
      500
    );
  }

  const receiptRows = rawReceipts || [];
  const accessSessionIds = Array.from(
    new Set(receiptRows.map((r: any) => r.access_session_id))
  );

  // 2. Fetch associated access sessions and payment orders
  let accessSessionMap = new Map<string, any>();
  if (accessSessionIds.length > 0) {
    const { data: sessionRows } = await (client as any)
      .from("access_sessions")
      .select(`
        id,
        restroom_id,
        policy_id,
        status,
        authorized_at,
        expires_at,
        created_at
      `)
      .in("id", accessSessionIds);

    for (const s of sessionRows || []) {
      accessSessionMap.set(s.id, s);
    }
  }

  // 3. Fetch associated restrooms and businesses
  const restroomIds = Array.from(
    new Set(
      Array.from(accessSessionMap.values())
        .map((s) => s.restroom_id)
        .filter(Boolean)
    )
  );

  let restroomMap = new Map<string, any>();
  if (restroomIds.length > 0) {
    const { data: restroomRows } = await (client as any)
      .from("restrooms")
      .select(`
        id,
        name,
        road_address,
        business_id
      `)
      .in("id", restroomIds);

    for (const r of restroomRows || []) {
      restroomMap.set(r.id, r);
    }
  }

  const businessIds = Array.from(
    new Set(
      Array.from(restroomMap.values())
        .map((r) => r.business_id)
        .filter(Boolean)
    )
  );

  let businessMap = new Map<string, any>();
  if (businessIds.length > 0) {
    const { data: businessRows } = await (client as any)
      .from("businesses")
      .select("id, name")
      .in("id", businessIds);

    for (const b of businessRows || []) {
      businessMap.set(b.id, b);
    }
  }

  // 4. Fetch associated payment orders to find deposit amounts
  let paymentOrderMap = new Map<string, any>();
  if (accessSessionIds.length > 0) {
    const { data: orderRows } = await (client as any)
      .from("payment_orders")
      .select("id, access_session_id, amount_krw, status")
      .in("access_session_id", accessSessionIds)
      .eq("status", "approved");

    for (const o of orderRows || []) {
      paymentOrderMap.set(o.access_session_id, o);
    }
  }

  // 5. Fetch associated payment refunds
  const submissionIds = receiptRows.map((r: any) => r.id);
  let refundMap = new Map<string, any>();
  if (submissionIds.length > 0) {
    const { data: refundRows } = await (client as any)
      .from("payment_refunds")
      .select("id, receipt_submission_id, amount_krw, status, completed_at")
      .in("receipt_submission_id", submissionIds);

    for (const ref of refundRows || []) {
      refundMap.set(ref.receipt_submission_id, ref);
    }
  }

  // Map to CustomerReceiptItem[]
  const receipts: CustomerReceiptItem[] = receiptRows.map((r: any) => {
    const session = accessSessionMap.get(r.access_session_id);
    const restroom = session ? restroomMap.get(session.restroom_id) : null;
    const business = restroom ? businessMap.get(restroom.business_id) : null;
    const order = paymentOrderMap.get(r.access_session_id);
    const refund = refundMap.get(r.id);

    let refundStatus: RefundStatus = "none";
    if (refund) {
      if (refund.status === "succeeded") {
        refundStatus = "completed";
      } else if (refund.status === "failed") {
        refundStatus = "failed";
      } else {
        refundStatus = "pending";
      }
    }

    return {
      id: r.id,
      accessSessionId: r.access_session_id,
      userId: r.user_id,
      storagePath: r.storage_path,
      mimeType: r.mime_type as ReceiptMimeType,
      fileSizeBytes: r.file_size_bytes,
      originalFilename: r.original_filename ?? null,
      submissionStatus: r.submission_status as ReceiptSubmissionStatus,
      storeNameConfirmed: r.store_name_confirmed ?? null,
      purchaseAtConfirmed: r.purchase_at_confirmed ?? null,
      purchaseAmountKrw: r.purchase_amount_krw ?? null,
      reviewReason: r.review_reason ?? null,
      reviewedAt: r.reviewed_at ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,

      restroomName: restroom?.name || "제휴 화장실",
      partnerName: business?.name || "제휴 매장",
      roadAddress: restroom?.road_address || "",
      depositAmountKrw: order?.amount_krw ?? 1000,

      refundStatus,
      refundAmountKrw: refund?.amount_krw ?? null,
      refundCompletedAt: refund?.completed_at ?? null,
    };
  });

  // 6. Fetch all eligible access sessions for this user (approved test deposits)
  const { data: eligibleSessionRows } = await (client as any)
    .from("access_sessions")
    .select(`
      id,
      restroom_id,
      policy_id,
      status,
      authorized_at,
      expires_at,
      created_at
    `)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);

  const eligibleSessions: EligibleAccessSessionItem[] = [];

  if (eligibleSessionRows && eligibleSessionRows.length > 0) {
    const allEligibleSessionIds = eligibleSessionRows.map((s: any) => s.id as string);
    const allPolicyIds: string[] = Array.from(
      new Set(
        eligibleSessionRows
          .map((s: any) => s.policy_id as string)
          .filter(Boolean)
      )
    );
    const allEligibleRestroomIds: string[] = Array.from(
      new Set(
        eligibleSessionRows
          .map((s: any) => s.restroom_id as string)
          .filter(Boolean)
      )
    );

    // Fetch policies
    let policyMap = new Map<string, any>();
    if (allPolicyIds.length > 0) {
      const { data: policyRows } = await (client as any)
        .from("restroom_access_policies")
        .select("id, deposit_amount_krw, receipt_window_hours, access_mode")
        .in("id", allPolicyIds);

      for (const p of policyRows || []) {
        policyMap.set(p.id, p);
      }
    }

    // Fetch restrooms & businesses if not already cached
    const missingRestroomIds = allEligibleRestroomIds.filter(
      (id: string) => !restroomMap.has(id)
    );
    if (missingRestroomIds.length > 0) {
      const { data: missingRows } = await (client as any)
        .from("restrooms")
        .select("id, name, road_address, business_id")
        .in("id", missingRestroomIds);

      for (const r of missingRows || []) {
        restroomMap.set(r.id, r);
      }
    }

    const missingBusinessIds: string[] = Array.from(restroomMap.values())
      .map((r: any) => r.business_id as string)
      .filter((id: string) => Boolean(id) && !businessMap.has(id));

    if (missingBusinessIds.length > 0) {
      const { data: missingBizRows } = await (client as any)
        .from("businesses")
        .select("id, name")
        .in("id", missingBusinessIds);

      for (const b of missingBizRows || []) {
        businessMap.set(b.id, b);
      }
    }

    // Fetch approved payment orders for these sessions
    const { data: approvedOrders } = await (client as any)
      .from("payment_orders")
      .select("id, access_session_id, amount_krw, payment_mode, status")
      .in("access_session_id", allEligibleSessionIds)
      .eq("status", "approved")
      .eq("payment_mode", "test");

    const approvedOrderSessionIds = new Set(
      (approvedOrders || []).map((o: any) => o.access_session_id)
    );

    // Check which sessions already have pending or approved receipts
    const pendingSessionIds = new Set(
      receipts
        .filter(
          (r) =>
            r.submissionStatus === "submitted" ||
            r.submissionStatus === "review_required"
        )
        .map((r) => r.accessSessionId)
    );

    const approvedSessionIds = new Set(
      receipts
        .filter((r) => r.submissionStatus === "approved")
        .map((r) => r.accessSessionId)
    );

    const now = new Date();

    for (const session of eligibleSessionRows) {
      // Must have an approved test payment order
      if (!approvedOrderSessionIds.has(session.id)) {
        continue;
      }

      const policy = policyMap.get(session.policy_id);
      const restroom = restroomMap.get(session.restroom_id);
      const business = restroom ? businessMap.get(restroom.business_id) : null;
      const order = (approvedOrders || []).find(
        (o: any) => o.access_session_id === session.id
      );

      const windowHours = policy?.receipt_window_hours ?? 24;
      const baseTime = session.authorized_at
        ? new Date(session.authorized_at)
        : new Date(session.created_at);
      const deadline = new Date(baseTime.getTime() + windowHours * 3600 * 1000);
      const isWindowExpired = now.getTime() > deadline.getTime();

      eligibleSessions.push({
        accessSessionId: session.id,
        restroomId: session.restroom_id,
        restroomName: restroom?.name || "제휴 화장실",
        partnerName: business?.name || "제휴 매장",
        roadAddress: restroom?.road_address || "",
        depositAmountKrw: order?.amount_krw ?? policy?.deposit_amount_krw ?? 1000,
        authorizedAt: session.authorized_at || session.created_at,
        expiresAt: session.expires_at,
        receiptWindowHours: windowHours,
        receiptWindowDeadline: deadline.toISOString(),
        isWindowExpired,
        hasPendingReceipt: pendingSessionIds.has(session.id),
        hasApprovedReceipt: approvedSessionIds.has(session.id),
      });
    }
  }

  return {
    receipts,
    eligibleSessions,
  };
}
