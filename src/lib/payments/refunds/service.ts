/**
 * TASK 30: Admin Test Refund Service
 * Spec: docs/04_API_CONTRACT.md, docs/07_PAYMENT_ACCESS_REFUND.md,
 *       docs/11_DECISIONS.md, tasks/30_refund_server.md
 *
 * Security & Concurrency Invariants:
 * - Admin-only + active account verified from server DB.
 * - Test-only enforcement (PAYMENT_MODE=test, test_ key, payment_mode='test', provider='toss').
 * - Full cancellation only (no partial refund).
 * - Atomic persistent claim via payment_refunds UNIQUE(payment_order_id) BEFORE external PG call.
 * - Multi-instance safe CAS transitions on retry/reconcile.
 * - Never marks succeeded before verified PG cancellation.
 * - Enforces 15-day Toss idempotency expiry manual check guard.
 * - Never exposes secrets, provider_payment_key, provider_cancel_id, idempotency_key, or PII.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";
import type { AccessSessionRow } from "@/lib/access/types";
import type { ReceiptSubmissionRow } from "@/lib/receipts/types";
import { createAdminClient, isServiceRoleConfigured } from "@/lib/supabase/server";
import { assertPaymentTestModeAllowed, getPaymentMode } from "../config";
import { TossPaymentError } from "../toss-client";
import {
  type PaymentOrderRow,
  type PaymentRefundRow,
  toPublicPaymentRefund,
} from "../types";
import { recordRefundAuditLog } from "./audit";
import {
  createTossRefundClient,
  verifyTossFullCancellation,
} from "./toss-refund-client";
import type {
  AdminRefundListFilter,
  AdminRefundListItem,
  AdminRefundListResult,
  AdminRefundResult,
  ITossRefundClient,
  ReconcileAdminRefundParams,
  ReconcileAdminRefundResult,
  RequestAdminRefundParams,
  TossPaymentWithCancelsResponse,
} from "./types";

export const FIXED_TEST_CANCEL_REASON =
  "휴지맵 제휴 매장 이용 영수증 관리자 승인에 따른 테스트 보증금 전액 취소";

export const TOSS_IDEMPOTENCY_TTL_MS = 15 * 24 * 60 * 60 * 1000;
export const STALE_REQUESTED_WINDOW_MS = 30 * 1000;

export class RefundServiceError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly userMessage: string;

  constructor(code: string, statusCode: number, userMessage: string) {
    super(userMessage);
    this.name = "RefundServiceError";
    this.code = code;
    this.statusCode = statusCode;
    this.userMessage = userMessage;
  }
}

interface PolicySummary {
  id: string;
  access_mode: string;
  deposit_amount_krw: number | null;
}

function getSupabaseAdmin(injected?: unknown): SupabaseClient<Database> {
  if (injected) {
    return injected as SupabaseClient<Database>;
  }
  if (!isServiceRoleConfigured()) {
    throw new RefundServiceError(
      "CONFIG_REQUIRED",
      503,
      "서버 데이터베이스 보안 서비스 설정이 필요합니다."
    );
  }
  return createAdminClient();
}

function isUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    error.code === "23505" ||
    Boolean(error.message && error.message.toLowerCase().includes("duplicate key"))
  );
}

function sanitizeFailureReason(code: string, detail: string): string {
  const cleaned = detail
    .replace(/test_(?:g)?sk_[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/live_[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "[REDACTED]")
    .trim();
  return `${code}: ${cleaned}`.slice(0, 500);
}

function isExpiredTossIdempotency(requestedAtIso: string, nowMs = Date.now()): boolean {
  const requestedMs = Date.parse(requestedAtIso);
  if (Number.isNaN(requestedMs)) {
    return true;
  }
  return nowMs - requestedMs >= TOSS_IDEMPOTENCY_TTL_MS;
}

function canLinkExpiredPgCancelToAttempt(
  pgPayment: TossPaymentWithCancelsResponse,
  requestedAtIso: string,
  cancelReason?: string,
  canceledAt?: string
): boolean {
  const cancels = pgPayment.cancels ?? [];
  if (cancels.length !== 1) {
    return false;
  }
  if (cancelReason !== FIXED_TEST_CANCEL_REASON) {
    return false;
  }
  if (!canceledAt) {
    return false;
  }
  const canceledMs = Date.parse(canceledAt);
  const requestedMs = Date.parse(requestedAtIso);
  if (Number.isNaN(canceledMs) || Number.isNaN(requestedMs)) {
    return false;
  }
  return canceledMs >= requestedMs - 5000;
}

async function verifyAdminActorInDb(
  supabase: SupabaseClient<Database>,
  adminUserId: string
): Promise<void> {
  const client = supabase as unknown as any;

  const { data: profile, error: profileErr } = await client
    .from("profiles")
    .select("id, account_status")
    .eq("id", adminUserId)
    .maybeSingle();

  if (profileErr || !profile) {
    throw new RefundServiceError(
      "FORBIDDEN",
      403,
      "관리자 프로필 정보를 확인할 수 없습니다."
    );
  }

  if (profile.account_status !== "active") {
    throw new RefundServiceError(
      "ACCOUNT_SUSPENDED",
      403,
      "비활성화되거나 정지된 관리자 계정은 환급을 요청할 수 없습니다."
    );
  }

  const { data: adminRole, error: roleErr } = await client
    .from("user_roles")
    .select("role")
    .eq("user_id", adminUserId)
    .eq("role", "admin")
    .maybeSingle();

  if (roleErr || !adminRole) {
    throw new RefundServiceError(
      "FORBIDDEN",
      403,
      "관리자 권한이 확인되지 않았습니다."
    );
  }
}

async function loadAndValidateRefundContext(params: {
  supabase: SupabaseClient<Database>;
  adminUserId: string;
  paymentOrderId: string;
  receiptSubmissionId: string;
  requestId?: string;
}): Promise<{
  receipt: ReceiptSubmissionRow;
  order: PaymentOrderRow;
  session: AccessSessionRow;
  policy: PolicySummary;
}> {
  const { supabase, adminUserId, paymentOrderId, receiptSubmissionId, requestId } =
    params;
  const client = supabase as unknown as any;

  const auditFail = async (
    code: string,
    entityType: "payment_orders" | "receipt_submissions",
    entityId: string,
    reason: string
  ) => {
    await recordRefundAuditLog({
      adminClient: supabase,
      actorUserId: adminUserId,
      action: "refund_precheck_failed",
      entityType,
      entityId,
      requestId,
      afterData: {
        errorCode: code,
        paymentOrderId,
        receiptSubmissionId,
      },
      reason,
    });
  };

  // 1. Verify active admin in DB
  try {
    await verifyAdminActorInDb(supabase, adminUserId);
  } catch (err) {
    await auditFail(
      err instanceof RefundServiceError ? err.code : "FORBIDDEN",
      "payment_orders",
      paymentOrderId,
      "관리자 권한 또는 계정 상태 검증 실패"
    );
    throw err;
  }

  // 2. Fetch receipt submission
  const { data: receiptData, error: receiptErr } = await client
    .from("receipt_submissions")
    .select("*")
    .eq("id", receiptSubmissionId)
    .maybeSingle();

  if (receiptErr || !receiptData) {
    await auditFail(
      "RECEIPT_NOT_FOUND",
      "receipt_submissions",
      receiptSubmissionId,
      "존재하지 않는 영수증 제출 건"
    );
    throw new RefundServiceError(
      "RECEIPT_NOT_FOUND",
      404,
      "영수증 제출 정보를 찾을 수 없습니다."
    );
  }

  const receipt = receiptData as ReceiptSubmissionRow;

  if (receipt.submission_status !== "approved") {
    await auditFail(
      "RECEIPT_NOT_APPROVED",
      "receipt_submissions",
      receipt.id,
      `미승인 영수증 환급 차단 (status=${receipt.submission_status})`
    );
    throw new RefundServiceError(
      "RECEIPT_NOT_APPROVED",
      422,
      "관리자 승인이 완료된 영수증만 환급 요청할 수 있습니다."
    );
  }

  // 3. Fetch payment order (including private provider_payment_key via service_role)
  const { data: orderData, error: orderErr } = await client
    .from("payment_orders")
    .select("*")
    .eq("id", paymentOrderId)
    .maybeSingle();

  if (orderErr || !orderData) {
    await auditFail(
      "PAYMENT_ORDER_NOT_FOUND",
      "payment_orders",
      paymentOrderId,
      "존재하지 않는 결제 주문"
    );
    throw new RefundServiceError(
      "PAYMENT_ORDER_NOT_FOUND",
      404,
      "결제 주문 정보를 찾을 수 없습니다."
    );
  }

  const order = orderData as PaymentOrderRow;

  if (order.provider !== "toss" || order.payment_mode !== "test") {
    await auditFail(
      "NON_TEST_PAYMENT_FORBIDDEN",
      "payment_orders",
      order.id,
      `테스트 Toss 결제가 아닌 주문 차단 (provider=${order.provider}, mode=${order.payment_mode})`
    );
    throw new RefundServiceError(
      "NON_TEST_PAYMENT_FORBIDDEN",
      422,
      "Toss 테스트 결제 주문에 대해서만 테스트 환급을 수행할 수 있습니다."
    );
  }

  if (order.status !== "approved") {
    await auditFail(
      "PAYMENT_ORDER_NOT_APPROVED",
      "payment_orders",
      order.id,
      `결제 미승인 주문 환급 차단 (status=${order.status})`
    );
    throw new RefundServiceError(
      "PAYMENT_ORDER_NOT_APPROVED",
      422,
      "결제 승인이 완료된 주문만 환급할 수 있습니다."
    );
  }

  if (
    !order.provider_payment_key ||
    !order.provider_payment_key.trim() ||
    order.provider_payment_key.trim().startsWith("live_")
  ) {
    await auditFail(
      "INVALID_PAYMENT_KEY",
      "payment_orders",
      order.id,
      "유효한 테스트 provider_payment_key 부재 또는 차단된 키 형식"
    );
    throw new RefundServiceError(
      "INVALID_PAYMENT_KEY",
      422,
      "주문에 연결된 유효한 테스트 결제 키를 확인할 수 없습니다."
    );
  }

  if (!Number.isInteger(order.amount_krw) || order.amount_krw <= 0) {
    await auditFail(
      "INVALID_ORDER_AMOUNT",
      "payment_orders",
      order.id,
      "유효하지 않은 주문 금액"
    );
    throw new RefundServiceError(
      "INVALID_ORDER_AMOUNT",
      422,
      "결제 주문 금액이 유효하지 않습니다."
    );
  }

  // 4. Fetch access session and verify strict 1:1 linkage
  const { data: sessionData, error: sessionErr } = await client
    .from("access_sessions")
    .select("*")
    .eq("id", order.access_session_id)
    .maybeSingle();

  if (sessionErr || !sessionData) {
    await auditFail(
      "ACCESS_SESSION_NOT_FOUND",
      "payment_orders",
      order.id,
      "결제 주문에 연결된 이용 세션 부재"
    );
    throw new RefundServiceError(
      "ACCESS_SESSION_NOT_FOUND",
      422,
      "결제 주문에 연결된 이용 세션을 찾을 수 없습니다."
    );
  }

  const session = sessionData as AccessSessionRow;

  if (
    receipt.access_session_id !== order.access_session_id ||
    receipt.user_id !== order.user_id ||
    session.user_id !== order.user_id
  ) {
    await auditFail(
      "RECEIPT_ORDER_MISMATCH",
      "payment_orders",
      order.id,
      "영수증-이용세션-결제주문 간 세션 또는 사용자 불일치"
    );
    throw new RefundServiceError(
      "RECEIPT_ORDER_MISMATCH",
      422,
      "승인된 영수증과 결제 주문의 이용 세션 또는 이용자가 일치하지 않습니다."
    );
  }

  // 5. Verify policy snapshot
  const { data: policyData, error: policyErr } = await client
    .from("restroom_access_policies")
    .select("id, access_mode, deposit_amount_krw")
    .eq("id", session.policy_id)
    .maybeSingle();

  if (policyErr || !policyData) {
    await auditFail(
      "INVALID_REFUND_POLICY",
      "payment_orders",
      order.id,
      "이용 세션의 정책 정보를 찾을 수 없음"
    );
    throw new RefundServiceError(
      "INVALID_REFUND_POLICY",
      422,
      "이용 세션의 보증금 정책 정보를 확인할 수 없습니다."
    );
  }

  const policy = policyData as PolicySummary;
  if (
    policy.access_mode !== "test_deposit" ||
    !policy.deposit_amount_krw ||
    policy.deposit_amount_krw <= 0 ||
    policy.deposit_amount_krw !== order.amount_krw
  ) {
    await auditFail(
      "INVALID_REFUND_POLICY",
      "payment_orders",
      order.id,
      `정책 보증금 불일치 (mode=${policy.access_mode}, policyAmount=${policy.deposit_amount_krw}, orderAmount=${order.amount_krw})`
    );
    throw new RefundServiceError(
      "INVALID_REFUND_POLICY",
      422,
      "결제 주문 금액이 이용 시점 테스트 보증금 정책과 일치하지 않습니다."
    );
  }

  return { receipt, order, session, policy };
}

async function updateRefundToProcessing(
  supabase: SupabaseClient<Database>,
  refundId: string,
  failureReason: string
): Promise<PaymentRefundRow | null> {
  const client = supabase as unknown as any;
  const { data, error } = await client
    .from("payment_refunds")
    .update({
      status: "processing",
      failure_reason: failureReason.slice(0, 500),
    })
    .eq("id", refundId)
    .neq("status", "succeeded")
    .select("*")
    .maybeSingle();

  if (error) {
    return null;
  }
  return (data as PaymentRefundRow) ?? null;
}

async function updateRefundToFailed(
  supabase: SupabaseClient<Database>,
  refundId: string,
  failureReason: string
): Promise<PaymentRefundRow | null> {
  const client = supabase as unknown as any;
  const { data, error } = await client
    .from("payment_refunds")
    .update({
      status: "failed",
      failure_reason: failureReason.slice(0, 500),
    })
    .eq("id", refundId)
    .neq("status", "succeeded")
    .select("*")
    .maybeSingle();

  if (error) {
    return null;
  }
  return (data as PaymentRefundRow) ?? null;
}

async function finalizeRefundSucceeded(params: {
  supabase: SupabaseClient<Database>;
  refund: PaymentRefundRow;
  adminUserId: string;
  cancelTransactionKey: string;
  canceledAt?: string;
  requestId?: string;
  viaReconcile: boolean;
}): Promise<PaymentRefundRow> {
  const {
    supabase,
    refund,
    adminUserId,
    cancelTransactionKey,
    canceledAt,
    requestId,
    viaReconcile,
  } = params;
  const client = supabase as unknown as any;

  const completedAt = canceledAt || new Date().toISOString();

  const { data: updated, error: updateErr } = await client
    .from("payment_refunds")
    .update({
      status: "succeeded",
      provider_cancel_id: cancelTransactionKey,
      completed_at: completedAt,
      failure_reason: null,
    })
    .eq("id", refund.id)
    .in("status", ["requested", "processing", "failed"])
    .select("*")
    .maybeSingle();

  if (updateErr || !updated) {
    // Check if another concurrent reconciler already succeeded with the same cancel id
    const { data: latest } = await client
      .from("payment_refunds")
      .select("*")
      .eq("id", refund.id)
      .maybeSingle();

    if (
      latest &&
      latest.status === "succeeded" &&
      latest.provider_cancel_id === cancelTransactionKey
    ) {
      return latest as PaymentRefundRow;
    }

    console.error(
      `[refund] CRITICAL: PG cancellation confirmed for order ${refund.payment_order_id}, but DB update failed`
    );
    throw new RefundServiceError(
      "DB_REFUND_UPDATE_FAILED",
      500,
      "PG 결제는 취소되었으나 환급 완료 상태 저장 중 오류가 발생했습니다. 상태 재조회를 실행해 주세요."
    );
  }

  const updatedRow = updated as PaymentRefundRow;

  if (viaReconcile) {
    await recordRefundAuditLog({
      adminClient: supabase,
      actorUserId: adminUserId,
      action: "refund_reconcile_result",
      entityType: "payment_refunds",
      entityId: updatedRow.id,
      requestId,
      beforeData: { status: refund.status },
      afterData: {
        status: "succeeded",
        paymentOrderId: updatedRow.payment_order_id,
        receiptSubmissionId: updatedRow.receipt_submission_id,
        amountKrw: updatedRow.amount_krw,
        reconciled: true,
      },
      reason: "Toss 결제 조회를 통해 취소 완료 확인 및 DB 복구",
    });
  }

  await recordRefundAuditLog({
    adminClient: supabase,
    actorUserId: adminUserId,
    action: "refund_toss_cancel_succeeded",
    entityType: "payment_refunds",
    entityId: updatedRow.id,
    requestId,
    beforeData: { status: refund.status },
    afterData: {
      status: "succeeded",
      paymentOrderId: updatedRow.payment_order_id,
      receiptSubmissionId: updatedRow.receipt_submission_id,
      amountKrw: updatedRow.amount_krw,
      completedAt: updatedRow.completed_at,
    },
    reason: "Toss 테스트 결제 전액 취소 완료 확인",
  });

  return updatedRow;
}

async function executeTossCancelAndFinalize(params: {
  supabase: SupabaseClient<Database>;
  tossClient: ITossRefundClient;
  refund: PaymentRefundRow;
  order: PaymentOrderRow;
  receipt: ReceiptSubmissionRow;
  adminUserId: string;
  requestId?: string;
  reusedClaim: boolean;
}): Promise<AdminRefundResult> {
  const {
    supabase,
    tossClient,
    refund,
    order,
    receipt,
    adminUserId,
    requestId,
    reusedClaim,
  } = params;

  const paymentKey = order.provider_payment_key as string;

  await recordRefundAuditLog({
    adminClient: supabase,
    actorUserId: adminUserId,
    action: "refund_toss_cancel_requested",
    entityType: "payment_refunds",
    entityId: refund.id,
    requestId,
    beforeData: { status: refund.status },
    afterData: {
      paymentOrderId: order.id,
      orderNumber: order.order_id,
      receiptSubmissionId: receipt.id,
      amountKrw: order.amount_krw,
      fullCancel: true,
    },
    reason: FIXED_TEST_CANCEL_REASON,
  });

  try {
    const cancelRes = await tossClient.cancelPayment({
      paymentKey,
      cancelReason: FIXED_TEST_CANCEL_REASON,
      idempotencyKey: refund.idempotency_key,
    });

    const verification = verifyTossFullCancellation({
      tossPayment: cancelRes,
      expectedPaymentKey: paymentKey,
      expectedOrderId: order.order_id,
      expectedAmountKrw: order.amount_krw,
    });

    if (!verification.valid || !verification.cancelTransactionKey) {
      const reason = sanitizeFailureReason(
        verification.reason || "PG_CANCEL_VERIFICATION_FAILED",
        "Toss 취소 응답 검증에 실패하여 완료 처리할 수 없습니다."
      );
      await updateRefundToProcessing(supabase, refund.id, reason);
      await recordRefundAuditLog({
        adminClient: supabase,
        actorUserId: adminUserId,
        action: "refund_toss_cancel_failed",
        entityType: "payment_refunds",
        entityId: refund.id,
        requestId,
        beforeData: { status: refund.status },
        afterData: {
          status: "processing",
          verificationError: verification.reason,
          paymentOrderId: order.id,
        },
        reason,
      });

      const statusCode =
        verification.reason === "PG_PARTIAL_CANCELED" ||
        verification.reason === "PG_AMOUNT_MISMATCH" ||
        verification.reason === "PG_CANCEL_AMOUNT_MISMATCH"
          ? 422
          : 502;
      throw new RefundServiceError(
        verification.reason || "PG_CANCEL_VERIFICATION_FAILED",
        statusCode,
        "Toss 취소 응답이 주문 금액 또는 전액 취소 상태와 일치하지 않습니다."
      );
    }

    const updated = await finalizeRefundSucceeded({
      supabase,
      refund,
      adminUserId,
      cancelTransactionKey: verification.cancelTransactionKey,
      canceledAt: verification.canceledAt,
      requestId,
      viaReconcile: false,
    });

    return {
      refund: toPublicPaymentRefund(updated),
      reused: reusedClaim,
      outcome: reusedClaim ? "reconciled_succeeded" : "succeeded",
      paymentOrderId: order.id,
      receiptSubmissionId: receipt.id,
    };
  } catch (err: unknown) {
    if (err instanceof RefundServiceError) {
      throw err;
    }

    if (err instanceof TossPaymentError) {
      // Handle timeout / network error / 409 IDEMPOTENT_REQUEST_PROCESSING -> Reconcile via GET
      if (err.isRetryable || err.isProcessing) {
        const uncertainCode = err.isProcessing
          ? "UNCERTAIN_409_PROCESSING"
          : "UNCERTAIN_TIMEOUT";

        try {
          const queryRes = await tossClient.getPaymentByPaymentKey(paymentKey);
          const verification = verifyTossFullCancellation({
            tossPayment: queryRes,
            expectedPaymentKey: paymentKey,
            expectedOrderId: order.order_id,
            expectedAmountKrw: order.amount_krw,
          });

          if (verification.valid && verification.cancelTransactionKey) {
            const updated = await finalizeRefundSucceeded({
              supabase,
              refund,
              adminUserId,
              cancelTransactionKey: verification.cancelTransactionKey,
              canceledAt: verification.canceledAt,
              requestId,
              viaReconcile: true,
            });
            return {
              refund: toPublicPaymentRefund(updated),
              reused: reusedClaim,
              outcome: "reconciled_succeeded",
              paymentOrderId: order.id,
              receiptSubmissionId: receipt.id,
            };
          }

          if (queryRes.status === "PARTIAL_CANCELED") {
            const reason = sanitizeFailureReason(
              "PG_PARTIAL_CANCELED",
              "PG 재조회 결과 부분 취소 상태로 확인되었습니다."
            );
            await updateRefundToProcessing(supabase, refund.id, reason);
            await recordRefundAuditLog({
              adminClient: supabase,
              actorUserId: adminUserId,
              action: "refund_reconcile_result",
              entityType: "payment_refunds",
              entityId: refund.id,
              requestId,
              beforeData: { status: refund.status },
              afterData: { status: "processing", pgStatus: queryRes.status },
              reason,
            });
            throw new RefundServiceError(
              "PARTIAL_CANCELED_NOT_SUPPORTED",
              422,
              "부분 취소된 거래는 전액 환급으로 완료할 수 없습니다."
            );
          }
        } catch (reconcileErr) {
          if (reconcileErr instanceof RefundServiceError) {
            throw reconcileErr;
          }
          // Reconcile GET also timed out or failed; preserve uncertain state below
        }

        const reason = sanitizeFailureReason(
          uncertainCode,
          err.isProcessing
            ? "Toss 409 처리 중 응답으로 인해 상태 확인이 필요합니다."
            : "Toss API 타임아웃 또는 통신 오류로 취소 결과를 확정할 수 없습니다."
        );
        await updateRefundToProcessing(supabase, refund.id, reason);
        await recordRefundAuditLog({
          adminClient: supabase,
          actorUserId: adminUserId,
          action: "refund_toss_timeout_uncertain",
          entityType: "payment_refunds",
          entityId: refund.id,
          requestId,
          beforeData: { status: refund.status },
          afterData: {
            status: "processing",
            pgErrorCode: err.code,
            paymentOrderId: order.id,
          },
          reason,
        });

        throw new RefundServiceError(
          err.isProcessing ? "PG_REFUND_PROCESSING" : "PG_REFUND_TIMEOUT_UNCERTAIN",
          err.isProcessing ? 409 : 504,
          err.isProcessing
            ? "토스페이먼츠에서 환급 취소를 처리 중입니다. 잠시 후 동일한 멱등키로 상태를 재확인해 주세요."
            : "토스페이먼츠 취소 응답 시간이 초과되어 처리 중(불확실) 상태로 보관되었습니다. 동일한 멱등키로 재조회해 주세요."
        );
      }

      // Definite terminal rejection from Toss (e.g. 400 / 404 / 422 non-processing)
      const reason = sanitizeFailureReason(err.code, err.message);
      await updateRefundToFailed(supabase, refund.id, reason);
      await recordRefundAuditLog({
        adminClient: supabase,
        actorUserId: adminUserId,
        action: "refund_toss_cancel_failed",
        entityType: "payment_refunds",
        entityId: refund.id,
        requestId,
        beforeData: { status: refund.status },
        afterData: {
          status: "failed",
          pgErrorCode: err.code,
          paymentOrderId: order.id,
        },
        reason,
      });

      const httpStatus = err.status >= 400 && err.status < 500 ? err.status : 400;
      throw new RefundServiceError(
        err.code,
        httpStatus,
        "토스페이먼츠 결제 취소 요청이 거절되었습니다."
      );
    }

    const reason = sanitizeFailureReason(
      "UNEXPECTED_REFUND_ERROR",
      "환급 처리 중 예기치 않은 오류가 발생했습니다."
    );
    await updateRefundToProcessing(supabase, refund.id, reason);
    await recordRefundAuditLog({
      adminClient: supabase,
      actorUserId: adminUserId,
      action: "refund_toss_timeout_uncertain",
      entityType: "payment_refunds",
      entityId: refund.id,
      requestId,
      beforeData: { status: refund.status },
      afterData: { status: "processing", paymentOrderId: order.id },
      reason,
    });
    throw new RefundServiceError(
      "UNEXPECTED_REFUND_ERROR",
      500,
      "환급 처리 중 오류가 발생했습니다. 상태를 확인한 후 다시 시도해 주세요."
    );
  }
}

/**
 * Requests a full test refund for an approved receipt linked to an approved Toss test payment order.
 */
export async function requestAdminRefund(
  params: RequestAdminRefundParams
): Promise<AdminRefundResult> {
  // STEP 3: Enforce test-only mode and test_ secret key (rejects live_ and disabled mode)
  getPaymentMode();
  assertPaymentTestModeAllowed();

  const supabase = getSupabaseAdmin(params.injectedAdminClient);
  const tossClient = params.tossClient || createTossRefundClient();
  const client = supabase as unknown as any;

  // STEP 2: Authoritative server-side prechecks
  const { receipt, order } = await loadAndValidateRefundContext({
    supabase,
    adminUserId: params.adminUserId,
    paymentOrderId: params.paymentOrderId,
    receiptSubmissionId: params.receiptSubmissionId,
    requestId: params.requestId,
  });

  await recordRefundAuditLog({
    adminClient: supabase,
    actorUserId: params.adminUserId,
    action: "refund_requested",
    entityType: "payment_orders",
    entityId: order.id,
    requestId: params.requestId,
    afterData: {
      paymentOrderId: order.id,
      orderNumber: order.order_id,
      receiptSubmissionId: receipt.id,
      amountKrw: order.amount_krw,
    },
    reason: "관리자 전액 환급 요청 접수",
  });

  // STEP 5: Persistent atomic claim in DB BEFORE any external Toss API call
  const { data: insertedData, error: insertError } = await client
    .from("payment_refunds")
    .insert({
      payment_order_id: order.id,
      receipt_submission_id: receipt.id,
      amount_krw: order.amount_krw,
      status: "requested",
      idempotency_key: params.idempotencyKey,
      requested_by: params.adminUserId,
    })
    .select("*")
    .maybeSingle();

  if (!insertError && insertedData) {
    const newRefund = insertedData as PaymentRefundRow;
    const paymentKey = order.provider_payment_key as string;

    // STEP 4: Pre-cancel PG state & amount verification via GET /v1/payments/{paymentKey}
    let pgPayment: TossPaymentWithCancelsResponse;
    try {
      pgPayment = await tossClient.getPaymentByPaymentKey(paymentKey);
    } catch (err: unknown) {
      if (err instanceof TossPaymentError && (err.isRetryable || err.isProcessing)) {
        const reason = sanitizeFailureReason(
          "UNCERTAIN_PRECHECK_TIMEOUT",
          "취소 전 PG 결제 조회 타임아웃"
        );
        await updateRefundToProcessing(supabase, newRefund.id, reason);
        await recordRefundAuditLog({
          adminClient: supabase,
          actorUserId: params.adminUserId,
          action: "refund_toss_timeout_uncertain",
          entityType: "payment_refunds",
          entityId: newRefund.id,
          requestId: params.requestId,
          beforeData: { status: "requested" },
          afterData: { status: "processing", paymentOrderId: order.id },
          reason,
        });
        throw new RefundServiceError(
          "PG_PRECHECK_TIMEOUT",
          504,
          "Toss 결제 조회 응답 시간이 초과되었습니다. 잠시 후 동일한 멱등키로 재시도해 주세요."
        );
      }

      const code =
        err instanceof TossPaymentError ? err.code : "PG_PRECHECK_FAILED";
      const reason = sanitizeFailureReason(
        code,
        "취소 전 PG 결제 조회에 실패했습니다."
      );
      await updateRefundToFailed(supabase, newRefund.id, reason);
      await recordRefundAuditLog({
        adminClient: supabase,
        actorUserId: params.adminUserId,
        action: "refund_toss_cancel_failed",
        entityType: "payment_refunds",
        entityId: newRefund.id,
        requestId: params.requestId,
        beforeData: { status: "requested" },
        afterData: { status: "failed", pgErrorCode: code },
        reason,
      });
      throw new RefundServiceError(
        code,
        422,
        "토스 결제 상태 조회에 실패하여 환급을 진행할 수 없습니다."
      );
    }

    // Verify PG paymentKey, orderId, totalAmount match DB
    if (
      pgPayment.paymentKey !== paymentKey ||
      pgPayment.orderId !== order.order_id ||
      pgPayment.totalAmount !== order.amount_krw
    ) {
      const reason = sanitizeFailureReason(
        "PG_ORDER_MISMATCH",
        `DB 주문정보(${order.order_id}, ${order.amount_krw})와 PG 조회 결과(${pgPayment.orderId}, ${pgPayment.totalAmount}) 불일치`
      );
      await updateRefundToFailed(supabase, newRefund.id, reason);
      await recordRefundAuditLog({
        adminClient: supabase,
        actorUserId: params.adminUserId,
        action: "refund_toss_cancel_failed",
        entityType: "payment_refunds",
        entityId: newRefund.id,
        requestId: params.requestId,
        beforeData: { status: "requested" },
        afterData: {
          status: "failed",
          pgOrderId: pgPayment.orderId,
          pgTotalAmount: pgPayment.totalAmount,
          dbAmount: order.amount_krw,
        },
        reason,
      });
      throw new RefundServiceError(
        "PG_ORDER_MISMATCH",
        422,
        "DB 결제 주문 정보와 Toss 조회 결과가 일치하지 않아 환급을 중단합니다."
      );
    }

    if (pgPayment.status === "PARTIAL_CANCELED") {
      const reason = sanitizeFailureReason(
        "PG_PARTIAL_CANCELED",
        "부분 취소된 거래는 전액 취소 대상이 아닙니다."
      );
      await updateRefundToFailed(supabase, newRefund.id, reason);
      await recordRefundAuditLog({
        adminClient: supabase,
        actorUserId: params.adminUserId,
        action: "refund_toss_cancel_failed",
        entityType: "payment_refunds",
        entityId: newRefund.id,
        requestId: params.requestId,
        beforeData: { status: "requested" },
        afterData: { status: "failed", pgStatus: "PARTIAL_CANCELED" },
        reason,
      });
      throw new RefundServiceError(
        "PARTIAL_CANCELED_NOT_SUPPORTED",
        422,
        "이미 부분 취소된 결제 거래는 전액 환급을 실행할 수 없습니다."
      );
    }

    if (pgPayment.status === "CANCELED") {
      // DB had no refund row, yet PG is already CANCELED -> State mismatch! Do NOT blindly mark succeeded.
      const reason = sanitizeFailureReason(
        "PG_ALREADY_CANCELED_UNLINKED",
        "DB 환급 기록 없이 PG가 이미 취소되어 있어 수동 확인이 필요합니다."
      );
      await updateRefundToProcessing(supabase, newRefund.id, reason);
      await recordRefundAuditLog({
        adminClient: supabase,
        actorUserId: params.adminUserId,
        action: "refund_reconcile_result",
        entityType: "payment_refunds",
        entityId: newRefund.id,
        requestId: params.requestId,
        beforeData: { status: "requested" },
        afterData: { status: "processing", pgStatus: "CANCELED", mismatch: true },
        reason,
      });
      throw new RefundServiceError(
        "PG_ALREADY_CANCELED_STATE_MISMATCH",
        409,
        "DB 환급 이력이 없는 상태에서 PG 결제가 이미 취소되어 있습니다. 수동 확인이 필요합니다."
      );
    }

    if (pgPayment.status !== "DONE") {
      const reason = sanitizeFailureReason(
        "PG_STATUS_NOT_CANCELABLE",
        `취소 가능한 PG 상태(DONE)가 아닙니다: ${pgPayment.status}`
      );
      await updateRefundToFailed(supabase, newRefund.id, reason);
      await recordRefundAuditLog({
        adminClient: supabase,
        actorUserId: params.adminUserId,
        action: "refund_toss_cancel_failed",
        entityType: "payment_refunds",
        entityId: newRefund.id,
        requestId: params.requestId,
        beforeData: { status: "requested" },
        afterData: { status: "failed", pgStatus: pgPayment.status },
        reason,
      });
      throw new RefundServiceError(
        "PG_PAYMENT_NOT_CANCELABLE",
        422,
        `취소 가능한 PG 결제 상태가 아닙니다 (${pgPayment.status}).`
      );
    }

    return executeTossCancelAndFinalize({
      supabase,
      tossClient,
      refund: newRefund,
      order,
      receipt,
      adminUserId: params.adminUserId,
      requestId: params.requestId,
      reusedClaim: false,
    });
  }

  // Unique violation OR unexpected insert error
  if (!isUniqueViolation(insertError)) {
    throw new RefundServiceError(
      "DATABASE_ERROR",
      500,
      "환급 요청 기록 생성 중 데이터베이스 오류가 발생했습니다."
    );
  }

  // Check if idempotency_key was used by a different order or receipt
  const { data: byKeyData } = await client
    .from("payment_refunds")
    .select("*")
    .eq("idempotency_key", params.idempotencyKey)
    .maybeSingle();

  if (byKeyData) {
    const byKey = byKeyData as PaymentRefundRow;
    if (
      byKey.payment_order_id !== order.id ||
      (byKey.receipt_submission_id && byKey.receipt_submission_id !== receipt.id)
    ) {
      await recordRefundAuditLog({
        adminClient: supabase,
        actorUserId: params.adminUserId,
        action: "refund_duplicate_blocked",
        entityType: "payment_refunds",
        entityId: byKey.id,
        requestId: params.requestId,
        afterData: {
          reason: "IDEMPOTENCY_KEY_CONFLICT",
          paymentOrderId: order.id,
          receiptSubmissionId: receipt.id,
        },
        reason: "동일 멱등키가 다른 주문 또는 다른 영수증에 이미 사용됨",
      });
      throw new RefundServiceError(
        "IDEMPOTENCY_KEY_CONFLICT",
        409,
        "동일한 Idempotency-Key가 다른 주문 또는 영수증 환급에 이미 사용되었습니다."
      );
    }
  }

  // Fetch existing refund row by payment_order_id
  const { data: existingData, error: existingErr } = await client
    .from("payment_refunds")
    .select("*")
    .eq("payment_order_id", order.id)
    .maybeSingle();

  if (existingErr || !existingData) {
    throw new RefundServiceError(
      "REFUND_CONFLICT",
      409,
      "동일 주문에 대한 환급 요청 충돌이 발생했습니다."
    );
  }

  const existing = existingData as PaymentRefundRow;

  // Block different receipt attempting to refund the same order
  if (
    existing.receipt_submission_id &&
    existing.receipt_submission_id !== receipt.id
  ) {
    await recordRefundAuditLog({
      adminClient: supabase,
      actorUserId: params.adminUserId,
      action: "refund_duplicate_blocked",
      entityType: "payment_refunds",
      entityId: existing.id,
      requestId: params.requestId,
      afterData: {
        reason: "DUPLICATE_REFUND_FOR_ORDER",
        paymentOrderId: order.id,
        attemptedReceiptId: receipt.id,
      },
      reason: "다른 영수증으로 동일 주문 중복 환급 차단",
    });
    throw new RefundServiceError(
      "DUPLICATE_REFUND_FOR_ORDER",
      409,
      "해당 결제 주문은 이미 다른 영수증으로 환급이 진행되었거나 완료되었습니다."
    );
  }

  // Already succeeded
  if (existing.status === "succeeded") {
    if (existing.idempotency_key === params.idempotencyKey) {
      await recordRefundAuditLog({
        adminClient: supabase,
        actorUserId: params.adminUserId,
        action: "refund_duplicate_blocked",
        entityType: "payment_refunds",
        entityId: existing.id,
        requestId: params.requestId,
        afterData: {
          status: "succeeded",
          reused: true,
          paymentOrderId: order.id,
        },
        reason: "완료된 환급에 대한 동일 멱등키 재요청: 기존 결과 반환",
      });
      return {
        refund: toPublicPaymentRefund(existing),
        reused: true,
        outcome: "already_succeeded",
        paymentOrderId: order.id,
        receiptSubmissionId: receipt.id,
      };
    }

    await recordRefundAuditLog({
      adminClient: supabase,
      actorUserId: params.adminUserId,
      action: "refund_duplicate_blocked",
      entityType: "payment_refunds",
      entityId: existing.id,
      requestId: params.requestId,
      afterData: {
        status: "succeeded",
        paymentOrderId: order.id,
      },
      reason: "이미 환급 완료된 주문에 대한 중복 환급 요청 차단",
    });
    throw new RefundServiceError(
      "REFUND_ALREADY_SUCCEEDED",
      409,
      "이미 환급이 완료된 결제 주문입니다."
    );
  }

  // Different idempotencyKey while existing attempt is requested / processing / failed
  if (existing.idempotency_key !== params.idempotencyKey) {
    await recordRefundAuditLog({
      adminClient: supabase,
      actorUserId: params.adminUserId,
      action: "refund_duplicate_blocked",
      entityType: "payment_refunds",
      entityId: existing.id,
      requestId: params.requestId,
      afterData: {
        existingStatus: existing.status,
        paymentOrderId: order.id,
      },
      reason: "진행 중이거나 기존 기록이 있는 주문에 대한 타 멱등키 중복 요청 차단",
    });
    throw new RefundServiceError(
      "DUPLICATE_REFUND_REQUEST",
      409,
      `이미 해당 주문에 대한 환급 요청(상태: ${existing.status})이 존재합니다. 기존 요청 키로 상태를 재확인해 주세요.`
    );
  }

  // Same idempotencyKey retry / recovery (existing.status in 'requested' | 'processing' | 'failed')
  const paymentKey = order.provider_payment_key as string;
  const expiredIdempotency = isExpiredTossIdempotency(existing.requested_at);

  // Query Toss first (safe read-only reconciliation)
  let pgPayment: TossPaymentWithCancelsResponse;
  try {
    pgPayment = await tossClient.getPaymentByPaymentKey(paymentKey);
  } catch (err: unknown) {
    const reason = sanitizeFailureReason(
      err instanceof TossPaymentError ? err.code : "PG_RECONCILE_TIMEOUT",
      "재조회 중 Toss API 응답을 받지 못했습니다."
    );
    await updateRefundToProcessing(supabase, existing.id, reason);
    await recordRefundAuditLog({
      adminClient: supabase,
      actorUserId: params.adminUserId,
      action: "refund_toss_timeout_uncertain",
      entityType: "payment_refunds",
      entityId: existing.id,
      requestId: params.requestId,
      beforeData: { status: existing.status },
      afterData: { status: "processing", paymentOrderId: order.id },
      reason,
    });
    throw new RefundServiceError(
      "PG_RECONCILE_TIMEOUT",
      504,
      "Toss 결제 상태 재조회 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요."
    );
  }

  if (
    pgPayment.paymentKey !== paymentKey ||
    pgPayment.orderId !== order.order_id ||
    pgPayment.totalAmount !== order.amount_krw
  ) {
    const reason = sanitizeFailureReason(
      "PG_ORDER_MISMATCH",
      `재조회 시 주문정보(${order.order_id}, ${order.amount_krw}) 불일치`
    );
    await updateRefundToProcessing(supabase, existing.id, reason);
    await recordRefundAuditLog({
      adminClient: supabase,
      actorUserId: params.adminUserId,
      action: "refund_reconcile_result",
      entityType: "payment_refunds",
      entityId: existing.id,
      requestId: params.requestId,
      beforeData: { status: existing.status },
      afterData: { status: "processing", mismatch: true },
      reason,
    });
    throw new RefundServiceError(
      "PG_ORDER_MISMATCH",
      422,
      "재조회한 Toss 결제 정보가 DB 주문 금액/번호와 일치하지 않습니다."
    );
  }

  if (pgPayment.status === "PARTIAL_CANCELED") {
    const reason = sanitizeFailureReason(
      "PG_PARTIAL_CANCELED",
      "부분 취소된 거래로 확인되었습니다."
    );
    await updateRefundToProcessing(supabase, existing.id, reason);
    await recordRefundAuditLog({
      adminClient: supabase,
      actorUserId: params.adminUserId,
      action: "refund_reconcile_result",
      entityType: "payment_refunds",
      entityId: existing.id,
      requestId: params.requestId,
      beforeData: { status: existing.status },
      afterData: { status: "processing", pgStatus: "PARTIAL_CANCELED" },
      reason,
    });
    throw new RefundServiceError(
      "PARTIAL_CANCELED_NOT_SUPPORTED",
      422,
      "부분 취소된 결제 거래는 전액 환급 처리할 수 없습니다."
    );
  }

  if (pgPayment.status === "CANCELED") {
    const verification = verifyTossFullCancellation({
      tossPayment: pgPayment,
      expectedPaymentKey: paymentKey,
      expectedOrderId: order.order_id,
      expectedAmountKrw: order.amount_krw,
    });

    if (!verification.valid || !verification.cancelTransactionKey) {
      const reason = sanitizeFailureReason(
        verification.reason || "PG_CANCEL_VERIFICATION_FAILED",
        "취소 이력 검증 실패"
      );
      await updateRefundToProcessing(supabase, existing.id, reason);
      await recordRefundAuditLog({
        adminClient: supabase,
        actorUserId: params.adminUserId,
        action: "refund_reconcile_result",
        entityType: "payment_refunds",
        entityId: existing.id,
        requestId: params.requestId,
        beforeData: { status: existing.status },
        afterData: { status: "processing", verificationError: verification.reason },
        reason,
      });
      throw new RefundServiceError(
        verification.reason || "PG_CANCEL_VERIFICATION_FAILED",
        409,
        "PG 취소 이력이 주문 금액/상태와 일치하지 않아 수동 확인이 필요합니다."
      );
    }

    if (
      expiredIdempotency &&
      !canLinkExpiredPgCancelToAttempt(
        pgPayment,
        existing.requested_at,
        verification.cancelReason,
        verification.canceledAt
      )
    ) {
      const reason = sanitizeFailureReason(
        "MANUAL_CHECK_REQUIRED",
        "15일 이상 경과된 요청으로 이전 취소와 현재 환급 시도의 관계를 확정할 수 없습니다."
      );
      await updateRefundToProcessing(supabase, existing.id, reason);
      await recordRefundAuditLog({
        adminClient: supabase,
        actorUserId: params.adminUserId,
        action: "refund_reconcile_result",
        entityType: "payment_refunds",
        entityId: existing.id,
        requestId: params.requestId,
        beforeData: { status: existing.status },
        afterData: {
          status: "processing",
          expiredIdempotency: true,
          manualCheckRequired: true,
        },
        reason,
      });
      throw new RefundServiceError(
        "MANUAL_VERIFICATION_REQUIRED",
        409,
        "15일 이상 경과한 환급 요청으로 PG 취소 이력과의 연관성을 자동 확정할 수 없습니다. 수동 확인이 필요합니다."
      );
    }

    const updated = await finalizeRefundSucceeded({
      supabase,
      refund: existing,
      adminUserId: params.adminUserId,
      cancelTransactionKey: verification.cancelTransactionKey,
      canceledAt: verification.canceledAt,
      requestId: params.requestId,
      viaReconcile: true,
    });

    return {
      refund: toPublicPaymentRefund(updated),
      reused: true,
      outcome: "reconciled_succeeded",
      paymentOrderId: order.id,
      receiptSubmissionId: receipt.id,
    };
  }

  if (pgPayment.status !== "DONE") {
    const reason = sanitizeFailureReason(
      "PG_STATUS_NOT_CANCELABLE",
      `PG 결제 상태(${pgPayment.status})가 취소 가능하지 않습니다.`
    );
    await updateRefundToFailed(supabase, existing.id, reason);
    await recordRefundAuditLog({
      adminClient: supabase,
      actorUserId: params.adminUserId,
      action: "refund_reconcile_result",
      entityType: "payment_refunds",
      entityId: existing.id,
      requestId: params.requestId,
      beforeData: { status: existing.status },
      afterData: { status: "failed", pgStatus: pgPayment.status },
      reason,
    });
    throw new RefundServiceError(
      "PG_PAYMENT_NOT_CANCELABLE",
      422,
      `취소 가능한 PG 결제 상태가 아닙니다 (${pgPayment.status}).`
    );
  }

  // PG is still DONE (not canceled). Check 15-day idempotency TTL before re-calling cancel!
  if (expiredIdempotency) {
    const reason = sanitizeFailureReason(
      "MANUAL_CHECK_REQUIRED",
      "요청 후 15일이 경과하여 Toss 멱등키 유효기간이 만료되었으므로 자동 재취소를 수행하지 않습니다."
    );
    await updateRefundToProcessing(supabase, existing.id, reason);
    await recordRefundAuditLog({
      adminClient: supabase,
      actorUserId: params.adminUserId,
      action: "refund_reconcile_result",
      entityType: "payment_refunds",
      entityId: existing.id,
      requestId: params.requestId,
      beforeData: { status: existing.status },
      afterData: {
        status: "processing",
        pgStatus: "DONE",
        expiredIdempotency: true,
        manualCheckRequired: true,
      },
      reason,
    });
    throw new RefundServiceError(
      "MANUAL_VERIFICATION_REQUIRED",
      409,
      "15일 이상 경과된 불확실 환급 요청입니다. 새 멱등키로 자동 재취소하지 않고 수동 확인 대상으로 유지합니다."
    );
  }

  // Check if currently in-flight by another worker
  if (existing.status === "requested") {
    const requestedMs = Date.parse(existing.requested_at);
    if (!Number.isNaN(requestedMs) && Date.now() - requestedMs < STALE_REQUESTED_WINDOW_MS) {
      await recordRefundAuditLog({
        adminClient: supabase,
        actorUserId: params.adminUserId,
        action: "refund_duplicate_blocked",
        entityType: "payment_refunds",
        entityId: existing.id,
        requestId: params.requestId,
        afterData: { status: "requested", paymentOrderId: order.id },
        reason: "동일 멱등키 요청이 현재 처리 중",
      });
      throw new RefundServiceError(
        "REFUND_IN_PROGRESS",
        409,
        "환급 취소 요청이 현재 처리 중입니다. 잠시 후 다시 확인해 주세요."
      );
    }
  }

  // Atomic CAS claim for retry using the EXACT same stored idempotency_key
  const { data: claimedRow, error: claimErr } = await client
    .from("payment_refunds")
    .update({
      status: "requested",
      failure_reason: null,
    })
    .eq("id", existing.id)
    .eq("status", existing.status)
    .select("*")
    .maybeSingle();

  if (claimErr || !claimedRow) {
    await recordRefundAuditLog({
      adminClient: supabase,
      actorUserId: params.adminUserId,
      action: "refund_duplicate_blocked",
      entityType: "payment_refunds",
      entityId: existing.id,
      requestId: params.requestId,
      afterData: { paymentOrderId: order.id },
      reason: "재시도 동시 경합에서 다른 요청이 먼저 처리권을 획득",
    });
    throw new RefundServiceError(
      "REFUND_IN_PROGRESS",
      409,
      "다른 관리자 또는 인스턴스가 이미 재조회를 진행 중입니다."
    );
  }

  return executeTossCancelAndFinalize({
    supabase,
    tossClient,
    refund: claimedRow as PaymentRefundRow,
    order,
    receipt,
    adminUserId: params.adminUserId,
    requestId: params.requestId,
    reusedClaim: true,
  });
}

/**
 * Queries Toss PG for an existing refund attempt and reconciles DB state without initiating a new cancel.
 */
export async function reconcileAdminRefund(
  params: ReconcileAdminRefundParams
): Promise<ReconcileAdminRefundResult> {
  getPaymentMode();
  assertPaymentTestModeAllowed();

  const supabase = getSupabaseAdmin(params.injectedAdminClient);
  const tossClient = params.tossClient || createTossRefundClient();
  const client = supabase as unknown as any;

  await verifyAdminActorInDb(supabase, params.adminUserId);

  const { data: refundData, error: refundErr } = await client
    .from("payment_refunds")
    .select("*")
    .eq("payment_order_id", params.paymentOrderId)
    .maybeSingle();

  if (refundErr || !refundData) {
    throw new RefundServiceError(
      "REFUND_NOT_FOUND",
      404,
      "해당 결제 주문에 대한 환급 요청 이력을 찾을 수 없습니다."
    );
  }

  const refund = refundData as PaymentRefundRow;
  if (refund.status === "succeeded") {
    return {
      refund: toPublicPaymentRefund(refund),
      reconciled: false,
      pgStatus: "CANCELED",
    };
  }

  const { data: orderData, error: orderErr } = await client
    .from("payment_orders")
    .select("*")
    .eq("id", params.paymentOrderId)
    .maybeSingle();

  if (orderErr || !orderData) {
    throw new RefundServiceError(
      "PAYMENT_ORDER_NOT_FOUND",
      404,
      "결제 주문 정보를 찾을 수 없습니다."
    );
  }

  const order = orderData as PaymentOrderRow;
  if (
    order.provider !== "toss" ||
    order.payment_mode !== "test" ||
    !order.provider_payment_key ||
    order.provider_payment_key.startsWith("live_")
  ) {
    throw new RefundServiceError(
      "NON_TEST_PAYMENT_FORBIDDEN",
      422,
      "유효한 Toss 테스트 결제 주문이 아닙니다."
    );
  }

  let pgPayment: TossPaymentWithCancelsResponse;
  try {
    pgPayment = await tossClient.getPaymentByPaymentKey(order.provider_payment_key);
  } catch {
    throw new RefundServiceError(
      "PG_RECONCILE_TIMEOUT",
      504,
      "Toss 결제 조회 시간이 초과되었습니다."
    );
  }

  if (pgPayment.status === "CANCELED") {
    const verification = verifyTossFullCancellation({
      tossPayment: pgPayment,
      expectedPaymentKey: order.provider_payment_key,
      expectedOrderId: order.order_id,
      expectedAmountKrw: order.amount_krw,
    });

    if (!verification.valid || !verification.cancelTransactionKey) {
      const reason = sanitizeFailureReason(
        verification.reason || "PG_CANCEL_VERIFICATION_FAILED",
        "재조회 취소 검증 실패"
      );
      const updated = await updateRefundToProcessing(supabase, refund.id, reason);
      await recordRefundAuditLog({
        adminClient: supabase,
        actorUserId: params.adminUserId,
        action: "refund_reconcile_result",
        entityType: "payment_refunds",
        entityId: refund.id,
        requestId: params.requestId,
        beforeData: { status: refund.status },
        afterData: { status: "processing", verificationError: verification.reason },
        reason,
      });
      throw new RefundServiceError(
        verification.reason || "PG_CANCEL_VERIFICATION_FAILED",
        409,
        updated
          ? "PG 취소 정보가 DB 주문과 일치하지 않아 수동 확인이 필요합니다."
          : "재조회 결과 검증에 실패했습니다."
      );
    }

    const expired = isExpiredTossIdempotency(refund.requested_at);
    if (
      expired &&
      !canLinkExpiredPgCancelToAttempt(
        pgPayment,
        refund.requested_at,
        verification.cancelReason,
        verification.canceledAt
      )
    ) {
      const reason = sanitizeFailureReason(
        "MANUAL_CHECK_REQUIRED",
        "15일 이상 경과 후 PG 취소 연관성 미확정"
      );
      const updated = await updateRefundToProcessing(supabase, refund.id, reason);
      await recordRefundAuditLog({
        adminClient: supabase,
        actorUserId: params.adminUserId,
        action: "refund_reconcile_result",
        entityType: "payment_refunds",
        entityId: refund.id,
        requestId: params.requestId,
        beforeData: { status: refund.status },
        afterData: { status: "processing", manualCheckRequired: true },
        reason,
      });
      return {
        refund: toPublicPaymentRefund(updated || refund),
        reconciled: false,
        pgStatus: pgPayment.status,
      };
    }

    const finalized = await finalizeRefundSucceeded({
      supabase,
      refund,
      adminUserId: params.adminUserId,
      cancelTransactionKey: verification.cancelTransactionKey,
      canceledAt: verification.canceledAt,
      requestId: params.requestId,
      viaReconcile: true,
    });

    return {
      refund: toPublicPaymentRefund(finalized),
      reconciled: true,
      pgStatus: pgPayment.status,
    };
  }

  await recordRefundAuditLog({
    adminClient: supabase,
    actorUserId: params.adminUserId,
    action: "refund_reconcile_result",
    entityType: "payment_refunds",
    entityId: refund.id,
    requestId: params.requestId,
    beforeData: { status: refund.status },
    afterData: { status: refund.status, pgStatus: pgPayment.status },
    reason: `PG 재조회 완료 (PG 상태: ${pgPayment.status})`,
  });

  return {
    refund: toPublicPaymentRefund(refund),
    reconciled: false,
    pgStatus: pgPayment.status,
  };
}

/**
 * Lists admin refund records (safe fields only; never leaks secrets/keys/PII).
 */
export async function listAdminRefunds(
  filter: AdminRefundListFilter = {},
  injectedAdminClient?: unknown
): Promise<AdminRefundListResult> {
  const supabase = getSupabaseAdmin(injectedAdminClient);
  const client = supabase as unknown as any;

  const page = Math.max(1, filter.page ?? 1);
  const limit = Math.min(100, Math.max(1, filter.limit ?? 20));
  const offset = (page - 1) * limit;

  let query = client
    .from("payment_refunds")
    .select(
      "id, payment_order_id, receipt_submission_id, amount_krw, status, failure_reason, requested_at, completed_at",
      { count: "exact" }
    );

  if (filter.status) {
    query = query.eq("status", filter.status);
  }
  if (filter.paymentOrderId) {
    query = query.eq("payment_order_id", filter.paymentOrderId);
  }
  if (filter.receiptSubmissionId) {
    query = query.eq("receipt_submission_id", filter.receiptSubmissionId);
  }

  query = query
    .order("requested_at", { ascending: false })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    throw new RefundServiceError(
      "DATABASE_ERROR",
      500,
      "환급 목록을 조회하는 중 오류가 발생했습니다."
    );
  }

  const rows = (data || []) as Array<
    Omit<PaymentRefundRow, "provider_cancel_id" | "idempotency_key" | "requested_by">
  >;
  const total = count ?? rows.length;
  const totalPages = Math.ceil(total / limit) || 1;

  const orderIds = Array.from(
    new Set(rows.map((r) => r.payment_order_id).filter(Boolean))
  );
  const receiptIds = Array.from(
    new Set(
      rows
        .map((r) => r.receipt_submission_id)
        .filter((v): v is string => Boolean(v))
    )
  );

  const orderMap = new Map<
    string,
    { orderId: string; status: string; paymentMode: string }
  >();
  const receiptMap = new Map<string, { submissionStatus: string }>();

  if (orderIds.length > 0) {
    const { data: orderRows } = await client
      .from("payment_orders")
      .select("id, order_id, status, payment_mode")
      .in("id", orderIds);

    if (Array.isArray(orderRows)) {
      for (const o of orderRows) {
        orderMap.set(o.id, {
          orderId: o.order_id,
          status: o.status,
          paymentMode: o.payment_mode,
        });
      }
    }
  }

  if (receiptIds.length > 0) {
    const { data: receiptRows } = await client
      .from("receipt_submissions")
      .select("id, submission_status")
      .in("id", receiptIds);

    if (Array.isArray(receiptRows)) {
      for (const rec of receiptRows) {
        receiptMap.set(rec.id, {
          submissionStatus: rec.submission_status,
        });
      }
    }
  }

  const items: AdminRefundListItem[] = rows.map((row) => {
    const safeRefund = toPublicPaymentRefund(row as PaymentRefundRow);
    const ord = orderMap.get(safeRefund.payment_order_id);
    const rec = safeRefund.receipt_submission_id
      ? receiptMap.get(safeRefund.receipt_submission_id)
      : undefined;
    const expired = isExpiredTossIdempotency(safeRefund.requested_at);
    const manualCheckRequired =
      Boolean(safeRefund.failure_reason?.startsWith("MANUAL_CHECK_REQUIRED")) ||
      Boolean(
        safeRefund.failure_reason?.startsWith("PG_ALREADY_CANCELED_UNLINKED")
      ) ||
      (safeRefund.status !== "succeeded" && expired);

    return {
      ...safeRefund,
      orderNumber: ord?.orderId ?? null,
      orderStatus: ord?.status ?? null,
      paymentMode: ord?.paymentMode ?? null,
      receiptStatus: rec?.submissionStatus ?? null,
      manualCheckRequired,
      canRetry:
        safeRefund.status !== "succeeded" &&
        !manualCheckRequired &&
        !expired,
    };
  });

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
