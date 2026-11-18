/**
 * TASK 30: Admin Test Refund Types
 * Spec: docs/04_API_CONTRACT.md, docs/07_PAYMENT_ACCESS_REFUND.md,
 *       docs/11_DECISIONS.md, tasks/30_refund_server.md
 */

import type {
  PaymentRefundRow,
  PaymentRefundStatus,
  PublicPaymentRefund,
} from "../types";
import type { TossPaymentStatus } from "../toss-client";

export interface TossCancelRecord {
  transactionKey: string;
  cancelAmount: number;
  cancelReason?: string;
  canceledAt?: string;
  cancelStatus?: string;
  easyPayDiscountAmount?: number;
  refundableAmount?: number;
}

export interface TossPaymentWithCancelsResponse {
  paymentKey: string;
  orderId: string;
  status: TossPaymentStatus;
  totalAmount: number;
  balanceAmount?: number;
  requestedAt?: string;
  approvedAt?: string;
  cancels?: TossCancelRecord[] | null;
}

export interface TossCancelPaymentRequest {
  paymentKey: string;
  cancelReason: string;
  idempotencyKey: string;
}

export interface ITossRefundClient {
  getPaymentByPaymentKey(
    paymentKey: string
  ): Promise<TossPaymentWithCancelsResponse>;
  cancelPayment(
    req: TossCancelPaymentRequest
  ): Promise<TossPaymentWithCancelsResponse>;
}

export interface RequestAdminRefundParams {
  adminUserId: string;
  paymentOrderId: string;
  receiptSubmissionId: string;
  idempotencyKey: string;
  requestId?: string;
  tossClient?: ITossRefundClient;
  injectedAdminClient?: unknown;
}

export type AdminRefundOutcome =
  | "succeeded"
  | "already_succeeded"
  | "reconciled_succeeded";

export interface AdminRefundResult {
  refund: PublicPaymentRefund;
  reused: boolean;
  outcome: AdminRefundOutcome;
  paymentOrderId: string;
  receiptSubmissionId: string;
}

export interface ReconcileAdminRefundParams {
  adminUserId: string;
  paymentOrderId: string;
  requestId?: string;
  tossClient?: ITossRefundClient;
  injectedAdminClient?: unknown;
}

export interface ReconcileAdminRefundResult {
  refund: PublicPaymentRefund;
  reconciled: boolean;
  pgStatus: TossPaymentStatus;
}

export interface AdminRefundListFilter {
  status?: PaymentRefundStatus;
  paymentOrderId?: string;
  receiptSubmissionId?: string;
  page?: number;
  limit?: number;
}

export interface AdminRefundListItem extends PublicPaymentRefund {
  orderNumber: string | null;
  orderStatus: string | null;
  paymentMode: string | null;
  receiptStatus: string | null;
  manualCheckRequired: boolean;
  canRetry: boolean;
}

export interface AdminRefundListResult {
  items: AdminRefundListItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export type RefundAuditAction =
  | "refund_requested"
  | "refund_precheck_failed"
  | "refund_duplicate_blocked"
  | "refund_toss_cancel_requested"
  | "refund_toss_cancel_succeeded"
  | "refund_toss_cancel_failed"
  | "refund_toss_timeout_uncertain"
  | "refund_reconcile_result";

export type { PaymentRefundRow, PaymentRefundStatus, PublicPaymentRefund };

