import crypto from "node:crypto";
import { createAdminClient, isServiceRoleConfigured } from "@/lib/supabase/server";
import {
  type CreateUploadIntentParams,
  type CreateUploadIntentResult,
  type SubmitCustomerReceiptParams,
  type SubmitCustomerReceiptResult,
  type AdminReceiptDecisionParams,
  type AdminReceiptDecisionResult,
  type AdminReceiptsFilter,
  type AdminReceiptListResult,
  type AdminReceiptListItem,
  type AdminReceiptRefundStatus,
  toPublicReceiptSubmission,
} from "./types";
import {
  ReceiptServiceError,
  sanitizeFilename,
  verifyReceiptMagicBytes,
  MAX_RECEIPT_FILE_SIZE,
} from "./validation";

/**
 * Creates a signed upload intent for customer receipt photo.
 * Spec: docs/04_API_CONTRACT.md, docs/07_PAYMENT_ACCESS_REFUND.md, docs/08_SECURITY_OPERATIONS.md
 * Invariant: Validates active user, session ownership, payment approval, and time window.
 */
export async function createReceiptUploadIntent(
  params: CreateUploadIntentParams
): Promise<CreateUploadIntentResult> {
  const { accessSessionId, mimeType, fileSizeBytes, userId } = params;

  if (!isServiceRoleConfigured()) {
    throw new ReceiptServiceError(
      "CONFIG_REQUIRED",
      "서버 데이터베이스 보안 서비스 설정이 필요합니다.",
      503
    );
  }

  const adminClient = createAdminClient();

  // 1. Database validation via atomic SECURITY DEFINER RPC
  const { data: rpcData, error: rpcError } = await (adminClient as any).rpc(
    "validate_receipt_upload_intent",
    {
      p_access_session_id: accessSessionId,
      p_caller_user_id: userId,
      p_file_size_bytes: fileSizeBytes,
      p_mime_type: mimeType,
    }
  );

  if (rpcError) {
    throw new ReceiptServiceError(
      "DATABASE_ERROR",
      "영수증 제출 자격 확인 중 오류가 발생했습니다.",
      500
    );
  }

  const result = typeof rpcData === "string" ? JSON.parse(rpcData) : rpcData;

  if (!result || !result.ok) {
    const errorCode = result?.error_code || "VALIDATION_ERROR";
    const errorMessage =
      result?.message || "영수증 업로드 요청을 처리할 수 없습니다.";
    const statusCode = result?.status || 400;
    throw new ReceiptServiceError(errorCode, errorMessage, statusCode);
  }

  // 2. Generate secure unguessable storage path strictly partitioned by user_id and access_session_id
  const uploadId = crypto.randomUUID();
  const ext =
    mimeType === "image/jpeg"
      ? "jpg"
      : mimeType === "image/png"
      ? "png"
      : "webp";
  const storagePath = `receipts/${userId}/${accessSessionId}/${uploadId}.${ext}`;

  // 3. Issue short-lived signed upload URL (15 minutes = 900 seconds)
  const expiresIn = 900;
  let uploadUrl = "";
  let token: string | undefined;

  try {
    const { data: signedData, error: signError } = await adminClient.storage
      .from("receipts")
      .createSignedUploadUrl(storagePath);

    if (signError) {
      // In local environments or when Storage is mocked, formulate a standard upload target
      uploadUrl = `/api/v1/receipts/upload-mock?path=${encodeURIComponent(storagePath)}`;
    } else if (signedData?.signedUrl) {
      uploadUrl = signedData.signedUrl;
      token = signedData.token;
    }
  } catch {
    uploadUrl = `/api/v1/receipts/upload-mock?path=${encodeURIComponent(storagePath)}`;
  }

  return {
    uploadUrl: uploadUrl || `/api/v1/receipts/upload-mock?path=${encodeURIComponent(storagePath)}`,
    storagePath,
    token,
    expiresIn,
  };
}

/**
 * Submits a customer receipt photo record into the authoritative database.
 * Spec: docs/04_API_CONTRACT.md, docs/07_PAYMENT_ACCESS_REFUND.md, tasks/26_receipt_backend.md
 * Invariant: Atomic single-session transaction lock, client_submission_id idempotency,
 *            strictly verified file path ownership, and status initialized to 'submitted'.
 */
export async function submitCustomerReceipt(
  params: SubmitCustomerReceiptParams
): Promise<SubmitCustomerReceiptResult> {
  const {
    accessSessionId,
    storagePath,
    mimeType,
    fileSizeBytes,
    originalFilename,
    clientSubmissionId,
    userId,
  } = params;

  if (!isServiceRoleConfigured()) {
    throw new ReceiptServiceError(
      "CONFIG_REQUIRED",
      "서버 데이터베이스 보안 서비스 설정이 필요합니다.",
      503
    );
  }

  // 1. Client-side path ownership pre-check
  const expectedPrefix = `receipts/${userId}/${accessSessionId}/`;
  if (!storagePath.startsWith(expectedPrefix)) {
    throw new ReceiptServiceError(
      "FORBIDDEN",
      "타인의 경로 또는 유효하지 않은 저장 경로입니다.",
      403
    );
  }

  const sanitizedFilename = sanitizeFilename(originalFilename);
  const adminClient = createAdminClient();

  // 2. Authoritative Storage File Verification
  // Invariant: Verify actual file presence, true byte length, and magic bytes.
  // Never blindly trust client-supplied metadata or bypass Storage download.
  let fileBuffer: Buffer;

  try {
    const { data: blobData, error: downloadError } = await adminClient.storage
      .from("receipts")
      .download(storagePath);

    if (downloadError || !blobData) {
      throw new ReceiptServiceError(
        "FILE_NOT_FOUND",
        "업로드된 영수증 파일을 스토리지에서 찾을 수 없습니다. 다시 업로드해 주세요.",
        400
      );
    }

    const arrayBuffer = await blobData.arrayBuffer();
    fileBuffer = Buffer.from(arrayBuffer);
  } catch (dlErr) {
    if (dlErr instanceof ReceiptServiceError) {
      throw dlErr;
    }
    throw new ReceiptServiceError(
      "FILE_NOT_FOUND",
      "업로드된 영수증 파일을 스토리지에서 찾을 수 없습니다. 다시 업로드해 주세요.",
      400
    );
  }

  // 2-1. Verify actual byte size
  const actualSizeBytes = fileBuffer.byteLength;
  if (actualSizeBytes <= 0 || actualSizeBytes > MAX_RECEIPT_FILE_SIZE) {
    throw new ReceiptServiceError(
      "INVALID_FILE_SIZE",
      `실제 파일 크기(${actualSizeBytes} bytes)가 허용 범위(1B ~ 10MB)를 벗어났습니다.`,
      400
    );
  }

  // 2-2. Verify actual magic bytes against declared mimeType
  if (!verifyReceiptMagicBytes(fileBuffer, mimeType)) {
    throw new ReceiptServiceError(
      "INVALID_FILE_CONTENT",
      "업로드된 파일의 실제 내용이 유효한 이미지(JPG, PNG, WebP) 형식이 아닙니다.",
      400
    );
  }

  // 3. Execute atomic submission RPC with verified actual size
  const { data: rpcData, error: rpcError } = await (adminClient as any).rpc(
    "submit_customer_receipt",
    {
      p_access_session_id: accessSessionId,
      p_caller_user_id: userId,
      p_storage_path: storagePath,
      p_mime_type: mimeType,
      p_file_size_bytes: actualSizeBytes,
      p_original_filename: sanitizedFilename,
      p_client_submission_id: clientSubmissionId,
    }
  );

  if (rpcError) {
    throw new ReceiptServiceError(
      "DATABASE_ERROR",
      "영수증 등록 처리 중 데이터베이스 오류가 발생했습니다.",
      500
    );
  }

  const result = typeof rpcData === "string" ? JSON.parse(rpcData) : rpcData;

  if (!result || !result.ok) {
    const errorCode = result?.error_code || "SUBMISSION_FAILED";
    const errorMessage =
      result?.message || "영수증을 제출할 수 없습니다.";
    const statusCode = result?.status || 400;
    throw new ReceiptServiceError(errorCode, errorMessage, statusCode);
  }

  const publicReceipt = toPublicReceiptSubmission(result.receipt);

  return {
    receipt: publicReceipt,
    reused: Boolean(result.reused),
  };
}

/**
 * Creates a short-lived signed read URL for a private receipt photo.
 * Spec: docs/04_API_CONTRACT.md, docs/08_SECURITY_OPERATIONS.md
 * Invariant: Never issues public URLs. Only submitter or admin can obtain signed URL.
 */
export async function createReceiptSignedReadUrl(params: {
  storagePath: string;
  userId: string;
  isAdmin: boolean;
  expiresInSeconds?: number;
}): Promise<string> {
  const { storagePath, userId, isAdmin, expiresInSeconds = 900 } = params;

  if (!isAdmin && !storagePath.startsWith(`receipts/${userId}/`)) {
    throw new ReceiptServiceError(
      "FORBIDDEN",
      "영수증 이미지에 대한 열람 권한이 없습니다.",
      403
    );
  }

  if (!isServiceRoleConfigured()) {
    throw new ReceiptServiceError(
      "CONFIG_REQUIRED",
      "서버 스토리지 보안 서비스 설정이 필요합니다.",
      503
    );
  }

  const adminClient = createAdminClient();
  const { data, error } = await adminClient.storage
    .from("receipts")
    .createSignedUrl(storagePath, expiresInSeconds);

  if (error || !data?.signedUrl) {
    throw new ReceiptServiceError(
      "STORAGE_ERROR",
      "영수증 이미지 임시 열람 주소를 생성하지 못했습니다.",
      500
    );
  }

  return data.signedUrl;
}

/**
 * Lists receipt submissions for administrator manual review.
 * Spec: docs/04_API_CONTRACT.md, tasks/28_manual_review_backend.md
 * Invariant: Filter by status, pagination, and enriched context.
 */
export async function listAdminReceipts(
  filter: AdminReceiptsFilter = {}
): Promise<AdminReceiptListResult> {
  if (!isServiceRoleConfigured()) {
    throw new ReceiptServiceError(
      "CONFIG_REQUIRED",
      "서버 데이터베이스 보안 서비스 설정이 필요합니다.",
      503
    );
  }

  const page = Math.max(1, filter.page ?? 1);
  const limit = Math.min(100, Math.max(1, filter.limit ?? 20));
  const offset = (page - 1) * limit;

  const adminClient = createAdminClient();

  let query = (adminClient as any)
    .from("receipt_submissions")
    .select("*", { count: "exact" });

  const status = filter.status?.trim();
  if (status && status !== "all") {
    if (status === "pending") {
      query = query.in("submission_status", ["submitted", "review_required"]);
    } else if (status.includes(",")) {
      const parts = status
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      query = query.in("submission_status", parts);
    } else {
      query = query.eq("submission_status", status);
    }
  } else if (!status) {
    // Default to pending queue if not specified
    query = query.in("submission_status", ["submitted", "review_required"]);
  }

  // Pending queue is ordered by oldest submission first (FIFO), or newest for completed
  const isPendingQuery =
    !status || status === "pending" || status === "submitted";
  query = query
    .order("created_at", { ascending: isPendingQuery })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    throw new ReceiptServiceError(
      "DATABASE_ERROR",
      "영수증 목록을 조회하는 중 오류가 발생했습니다.",
      500
    );
  }

  const rows = data || [];
  const total = count ?? rows.length;
  const totalPages = Math.ceil(total / limit) || 1;

  const items = await enrichAdminReceiptItems(adminClient, rows);

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages,
    },
  };
}

/**
 * Enriches receipt_submissions rows with authoritative store, restroom, access session,
 * versioned policy (via access_sessions.policy_id), deposit payment order (via access_session_id),
 * and refund status (via receipt_submission_id) for administrator comparison.
 *
 * Security Invariants:
 * - Never exposes provider_payment_key, provider_cancel_id, idempotency_key,
 *   businessRegistrationNumber, phone, email, or PIN.
 * - Matches payment_orders strictly by access_session_id (prioritizing status='approved').
 * - Matches payment_refunds strictly by receipt_submission_id.
 */
async function enrichAdminReceiptItems(
  adminClient: ReturnType<typeof createAdminClient>,
  rows: any[]
): Promise<AdminReceiptListItem[]> {
  if (!rows || rows.length === 0) {
    return [];
  }

  const submissionIds = Array.from(
    new Set(rows.map((r: any) => r.id).filter(Boolean))
  );
  const sessionIds = Array.from(
    new Set(rows.map((r: any) => r.access_session_id).filter(Boolean))
  );
  const userIds = Array.from(
    new Set(rows.map((r: any) => r.user_id).filter(Boolean))
  );

  const sessionMap = new Map<
    string,
    {
      restroomId: string;
      policyId: string;
      status: string | null;
      authorizedAt: string | null;
      expiresAt: string | null;
    }
  >();
  const restroomMap = new Map<
    string,
    { name: string; businessId: string | null }
  >();
  const businessMap = new Map<
    string,
    { id: string; name: string; roadAddress: string | null }
  >();
  const profileMap = new Map<string, { displayName: string | null }>();
  const policyMap = new Map<
    string,
    {
      version: number | null;
      depositAmountKrw: number;
      receiptWindowHours: number | null;
      minPurchaseKrw: number | null;
    }
  >();
  const paymentOrderMap = new Map<
    string,
    {
      id: string;
      orderId: string;
      amountKrw: number;
      status: string;
      paymentMode: string;
      approvedAt: string | null;
      createdAt: string | null;
    }
  >();
  const refundMap = new Map<
    string,
    {
      status: AdminReceiptRefundStatus;
      amountKrw: number | null;
      requestedAt: string | null;
      completedAt: string | null;
    }
  >();

  if (sessionIds.length > 0) {
    const { data: sessionRows } = await (adminClient as any)
      .from("access_sessions")
      .select("id, restroom_id, policy_id, status, authorized_at, expires_at")
      .in("id", sessionIds);

    if (sessionRows) {
      for (const s of sessionRows) {
        sessionMap.set(s.id, {
          restroomId: s.restroom_id,
          policyId: s.policy_id,
          status: s.status ?? null,
          authorizedAt: s.authorized_at ?? null,
          expiresAt: s.expires_at ?? null,
        });
      }

      const restroomIds = Array.from(
        new Set(sessionRows.map((s: any) => s.restroom_id).filter(Boolean))
      );
      const policyIds = Array.from(
        new Set(sessionRows.map((s: any) => s.policy_id).filter(Boolean))
      );

      if (restroomIds.length > 0) {
        const { data: restroomRows } = await (adminClient as any)
          .from("restrooms")
          .select("id, name, business_id")
          .in("id", restroomIds);

        if (restroomRows) {
          for (const r of restroomRows) {
            restroomMap.set(r.id, {
              name: r.name,
              businessId: r.business_id,
            });
          }

          const businessIds = Array.from(
            new Set(
              restroomRows.map((r: any) => r.business_id).filter(Boolean)
            )
          );
          if (businessIds.length > 0) {
            const { data: bizRows } = await (adminClient as any)
              .from("businesses")
              .select("id, name, road_address")
              .in("id", businessIds);

            if (bizRows) {
              for (const b of bizRows) {
                businessMap.set(b.id, {
                  id: b.id,
                  name: b.name,
                  roadAddress: b.road_address ?? null,
                });
              }
            }
          }
        }
      }

      if (policyIds.length > 0) {
        const { data: policyRows } = await (adminClient as any)
          .from("restroom_access_policies")
          .select(
            "id, version, deposit_amount_krw, receipt_window_hours, min_purchase_krw"
          )
          .in("id", policyIds);

        if (policyRows) {
          for (const p of policyRows) {
            policyMap.set(p.id, {
              version: p.version ?? null,
              depositAmountKrw: p.deposit_amount_krw ?? 0,
              receiptWindowHours: p.receipt_window_hours ?? null,
              minPurchaseKrw: p.min_purchase_krw ?? null,
            });
          }
        }
      }
    }

    // Fetch payment_orders strictly by access_session_id (safe public columns only)
    const { data: orderRows } = await (adminClient as any)
      .from("payment_orders")
      .select(
        "id, access_session_id, order_id, amount_krw, status, payment_mode, approved_at, created_at"
      )
      .in("access_session_id", sessionIds);

    if (orderRows && Array.isArray(orderRows)) {
      const sortedOrders = [...orderRows].sort((a, b) => {
        const aTime = a.created_at ? Date.parse(a.created_at) : 0;
        const bTime = b.created_at ? Date.parse(b.created_at) : 0;
        return bTime - aTime;
      });

      for (const o of sortedOrders) {
        const existing = paymentOrderMap.get(o.access_session_id);
        if (
          !existing ||
          (existing.status !== "approved" && o.status === "approved")
        ) {
          paymentOrderMap.set(o.access_session_id, {
            id: o.id,
            orderId: o.order_id,
            amountKrw: o.amount_krw,
            status: o.status,
            paymentMode: o.payment_mode,
            approvedAt: o.approved_at ?? null,
            createdAt: o.created_at ?? null,
          });
        }
      }
    }
  }

  if (submissionIds.length > 0) {
    // Fetch payment_refunds strictly by receipt_submission_id (safe columns only)
    const { data: refundRows } = await (adminClient as any)
      .from("payment_refunds")
      .select("id, receipt_submission_id, amount_krw, status, requested_at, completed_at")
      .in("receipt_submission_id", submissionIds);

    if (refundRows && Array.isArray(refundRows)) {
      for (const ref of refundRows) {
        if (!ref.receipt_submission_id) continue;
        refundMap.set(ref.receipt_submission_id, {
          status: ref.status as AdminReceiptRefundStatus,
          amountKrw: ref.amount_krw ?? null,
          requestedAt: ref.requested_at ?? null,
          completedAt: ref.completed_at ?? null,
        });
      }
    }
  }

  if (userIds.length > 0) {
    const { data: profileRows } = await (adminClient as any)
      .from("profiles")
      .select("id, display_name")
      .in("id", userIds);

    if (profileRows) {
      for (const pr of profileRows) {
        profileMap.set(pr.id, { displayName: pr.display_name });
      }
    }
  }

  return rows.map((row: any) => {
    const publicReceipt = toPublicReceiptSubmission(row);
    const sessionInfo = sessionMap.get(row.access_session_id);
    const restroomInfo = sessionInfo
      ? restroomMap.get(sessionInfo.restroomId)
      : null;
    const businessInfo = restroomInfo?.businessId
      ? businessMap.get(restroomInfo.businessId)
      : null;
    const policyInfo = sessionInfo ? policyMap.get(sessionInfo.policyId) : null;
    const orderInfo = paymentOrderMap.get(row.access_session_id);
    const refundInfo = refundMap.get(row.id);
    const profileInfo = profileMap.get(row.user_id);

    const effectiveWindowHours = policyInfo
      ? (policyInfo.receiptWindowHours ?? 24)
      : null;

    let receiptWindowDeadline: string | null = null;
    if (sessionInfo?.authorizedAt && effectiveWindowHours !== null) {
      const authMs = Date.parse(sessionInfo.authorizedAt);
      if (!Number.isNaN(authMs)) {
        receiptWindowDeadline = new Date(
          authMs + effectiveWindowHours * 3600 * 1000
        ).toISOString();
      }
    }

    return {
      ...publicReceipt,
      restroomName: restroomInfo?.name ?? null,
      businessId: businessInfo?.id ?? restroomInfo?.businessId ?? null,
      businessName: businessInfo?.name ?? null,
      businessRoadAddress: businessInfo?.roadAddress ?? null,
      userDisplayName: profileInfo?.displayName ?? null,
      accessAuthorizedAt: sessionInfo?.authorizedAt ?? null,
      accessExpiresAt: sessionInfo?.expiresAt ?? null,
      accessStatus: sessionInfo?.status ?? null,
      policyVersion: policyInfo?.version ?? null,
      depositAmountKrw: policyInfo?.depositAmountKrw ?? null,
      receiptWindowHours: effectiveWindowHours,
      receiptWindowDeadline,
      minPurchaseKrw: policyInfo?.minPurchaseKrw ?? null,
      paymentOrderId: orderInfo?.id ?? null,
      paymentOrderNumber: orderInfo?.orderId ?? null,
      paymentAmountKrw: orderInfo?.amountKrw ?? null,
      paymentStatus: orderInfo?.status ?? null,
      paymentMode: orderInfo?.paymentMode ?? null,
      paymentApprovedAt: orderInfo?.approvedAt ?? null,
      receiptReference: row.receipt_reference ?? null,
      refundStatus: refundInfo?.status ?? "none",
      refundAmountKrw: refundInfo?.amountKrw ?? null,
      refundRequestedAt: refundInfo?.requestedAt ?? null,
      refundCompletedAt: refundInfo?.completedAt ?? null,
    };
  });
}

/**
 * Retrieves a single receipt submission by ID for administrator review.
 */
export async function getAdminReceiptById(
  submissionId: string
): Promise<AdminReceiptListItem> {
  if (!isServiceRoleConfigured()) {
    throw new ReceiptServiceError(
      "CONFIG_REQUIRED",
      "서버 데이터베이스 보안 서비스 설정이 필요합니다.",
      503
    );
  }

  const adminClient = createAdminClient();
  const { data: row, error } = await (adminClient as any)
    .from("receipt_submissions")
    .select("*")
    .eq("id", submissionId)
    .maybeSingle();

  if (error || !row) {
    throw new ReceiptServiceError(
      "RECEIPT_NOT_FOUND",
      "영수증 정보를 찾을 수 없습니다.",
      404
    );
  }

  const [enriched] = await enrichAdminReceiptItems(adminClient, [row]);
  return enriched;
}

/**
 * Executes administrator manual review decision (approved, rejected, resubmission_requested).
 * Spec: docs/04_API_CONTRACT.md, docs/07_PAYMENT_ACCESS_REFUND.md, tasks/28_manual_review_backend.md
 * Invariant: Atomic single transaction, row-level locking, append-only review audit trail,
 *            strict reason check, NO automatic refund, and conflict prevention.
 */
export async function decideReceiptReview(
  params: AdminReceiptDecisionParams
): Promise<AdminReceiptDecisionResult> {
  const {
    submissionId,
    reviewerId,
    decision,
    reason,
    confirmedStore,
    confirmedPurchaseAt,
    confirmedAmount,
    receiptReference,
    idempotencyKey,
    payloadHash,
  } = params;

  if (!isServiceRoleConfigured()) {
    throw new ReceiptServiceError(
      "CONFIG_REQUIRED",
      "서버 데이터베이스 보안 서비스 설정이 필요합니다.",
      503
    );
  }

  const trimmedReason = reason?.trim() ?? "";
  if (trimmedReason.length < 2 || trimmedReason.length > 500) {
    throw new ReceiptServiceError(
      "VALIDATION_ERROR",
      "심사 사유는 2자 이상 500자 이하여야 합니다.",
      400
    );
  }

  const adminClient = createAdminClient();

  // 1. Try atomic SECURITY DEFINER RPC first
  const { data: rpcData, error: rpcError } = await (adminClient as any).rpc(
    "decide_receipt_review",
    {
      p_submission_id: submissionId,
      p_reviewer_id: reviewerId,
      p_decision: decision,
      p_reason: trimmedReason,
      p_store_name_confirmed: confirmedStore ?? null,
      p_purchase_at_confirmed: confirmedPurchaseAt ?? null,
      p_purchase_amount_krw: confirmedAmount ?? null,
      p_receipt_reference: receiptReference ?? null,
      p_idempotency_key: idempotencyKey ?? null,
      p_payload_hash: payloadHash ?? null,
    }
  );

  if (rpcError) {
    const code = rpcError.code ?? "";
    const msg = rpcError.message ?? "";

    if (
      code === "42501" ||
      msg.includes("FORBIDDEN_ADMIN_ONLY") ||
      msg.includes("INACTIVE_ADMIN")
    ) {
      throw new ReceiptServiceError("FORBIDDEN", "관리자 권한이 없습니다.", 403);
    }
    if (code === "28000" || msg.includes("UNAUTHENTICATED")) {
      throw new ReceiptServiceError(
        "UNAUTHORIZED",
        "관리자 인증이 필요합니다.",
        401
      );
    }
    if (code === "P0002" || msg.includes("RECEIPT_NOT_FOUND")) {
      throw new ReceiptServiceError(
        "RECEIPT_NOT_FOUND",
        "영수증 제출 정보를 찾을 수 없습니다.",
        404
      );
    }
    if (
      code === "22023" ||
      msg.includes("INVALID_") ||
      msg.includes("REASON_REQUIRED")
    ) {
      throw new ReceiptServiceError(
        "VALIDATION_ERROR",
        msg || "입력값이 유효하지 않습니다.",
        400
      );
    }
    if (
      code === "23505" ||
      code === "HM094" ||
      msg.includes("HM094") ||
      msg.includes("Idempotency key conflict")
    ) {
      throw new ReceiptServiceError(
        "CONFLICT",
        "동일한 Idempotency-Key로 다른 요청 본문이 전송되었거나 충돌이 발생했습니다.",
        409
      );
    }
    if (code === "HM002" || msg.includes("ALREADY_APPROVED")) {
      throw new ReceiptServiceError(
        "STATUS_CONFLICT",
        "이미 승인 완료된 영수증입니다.",
        409
      );
    }
    if (code === "HM006" || msg.includes("ALREADY_FINALIZED")) {
      throw new ReceiptServiceError(
        "STATUS_CONFLICT",
        "이미 처리가 완료된 영수증입니다.",
        409
      );
    }
    if (code === "HM001" || msg.includes("INVALID_STATUS_TRANSITION")) {
      throw new ReceiptServiceError(
        "STATUS_CONFLICT",
        "심사 대기 중인 영수증만 판정할 수 있습니다.",
        409
      );
    }

    throw new ReceiptServiceError(
      "DATABASE_ERROR",
      `영수증 심사 처리 중 오류가 발생했습니다: ${msg}`,
      500
    );
  }

  const result = typeof rpcData === "string" ? JSON.parse(rpcData) : rpcData;

  if (!result || !result.ok) {
    throw new ReceiptServiceError(
      result?.error_code || "DECISION_FAILED",
      result?.message || "영수증 심사 처리에 실패했습니다.",
      result?.status || 400
    );
  }

  const publicReceipt = toPublicReceiptSubmission(result.receipt);

  return {
    receipt: publicReceipt,
    auditId: result.audit_id,
    reused: Boolean(result.reused),
  };
}


