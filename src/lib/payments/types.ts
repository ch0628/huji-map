/**
 * Payment Orders & Refunds Types & Validation
 * Spec: docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/07_PAYMENT_ACCESS_REFUND.md,
 *       docs/08_SECURITY_OPERATIONS.md, docs/11_DECISIONS.md, tasks/20_payment_schema.md
 */

import { z } from "zod";

export const PAYMENT_PROVIDER = "toss" as const;
export type PaymentProvider = typeof PAYMENT_PROVIDER;

export const PAYMENT_MODE = "test" as const;
export type PaymentMode = typeof PAYMENT_MODE;

export const PAYMENT_ORDER_STATUSES = [
  "created",
  "pending",
  "approved",
  "failed",
  "canceled",
] as const;
export type PaymentOrderStatus = (typeof PAYMENT_ORDER_STATUSES)[number];

export const PAYMENT_REFUND_STATUSES = [
  "requested",
  "processing",
  "succeeded",
  "failed",
] as const;
export type PaymentRefundStatus = (typeof PAYMENT_REFUND_STATUSES)[number];

/**
 * Full database row representation of `public.payment_orders`
 */
export interface PaymentOrderRow {
  id: string; // uuid PK
  access_session_id: string; // uuid FK to access_sessions(id)
  user_id: string; // uuid FK to profiles(id)
  order_id: string; // unique PG order id
  provider: PaymentProvider;
  payment_mode: PaymentMode;
  amount_krw: number;
  status: PaymentOrderStatus;
  provider_payment_key: string | null; // private Toss payment key (never expose to client)
  idempotency_key: string;
  approved_at: string | null;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Safe client-facing view of a payment order
 * Strictly omits `provider_payment_key` and internal `idempotency_key`
 * per docs/03, docs/04, docs/08
 */
export type PublicPaymentOrder = Omit<
  PaymentOrderRow,
  "provider_payment_key" | "idempotency_key"
>;

/**
 * Full database row representation of `public.payment_refunds`
 */
export interface PaymentRefundRow {
  id: string; // uuid PK
  payment_order_id: string; // uuid FK to payment_orders(id) UNIQUE
  receipt_submission_id: string | null; // uuid NULL (FK deferred to receipt_backend)
  amount_krw: number;
  status: PaymentRefundStatus;
  idempotency_key: string;
  requested_by: string; // uuid FK to profiles(id)
  provider_cancel_id: string | null;
  failure_reason: string | null;
  requested_at: string;
  completed_at: string | null;
}

/**
 * Safe client-facing view of a payment refund
 * Strictly omits `provider_cancel_id`, internal `idempotency_key`, and `requested_by`
 * per docs/03, docs/04, docs/08
 */
export type PublicPaymentRefund = Omit<
  PaymentRefundRow,
  "provider_cancel_id" | "idempotency_key" | "requested_by"
>;

// ============================================================================
// Zod Validation Schemas
// ============================================================================

export const paymentProviderSchema = z.literal(PAYMENT_PROVIDER);

export const paymentModeSchema = z.literal(PAYMENT_MODE);

export const paymentOrderStatusSchema = z.enum(PAYMENT_ORDER_STATUSES);

export const paymentRefundStatusSchema = z.enum(PAYMENT_REFUND_STATUSES);

/**
 * Server creation payload for a payment order
 */
export const createPaymentOrderSchema = z.object({
  access_session_id: z.string().uuid("access_session_id must be a valid UUID"),
  user_id: z.string().uuid("user_id must be a valid UUID"),
  order_id: z
    .string()
    .trim()
    .min(6, "order_id must be at least 6 characters")
    .max(64, "order_id cannot exceed 64 characters"),
  amount_krw: z
    .number()
    .int("amount_krw must be an integer")
    .positive("amount_krw must be greater than zero"),
  idempotency_key: z
    .string()
    .trim()
    .min(10, "idempotency_key must be at least 10 characters")
    .max(128, "idempotency_key cannot exceed 128 characters"),
  provider: paymentProviderSchema.default(PAYMENT_PROVIDER),
  payment_mode: paymentModeSchema.default(PAYMENT_MODE),
});

export type CreatePaymentOrderInput = z.infer<typeof createPaymentOrderSchema>;

/**
 * Toss PG approval confirmation payload (server-to-server)
 */
export const approvePaymentOrderSchema = z.object({
  order_id: z.string().trim().min(1, "order_id is required"),
  payment_key: z.string().trim().min(1, "payment_key is required"),
  amount_krw: z.number().int().positive(),
});

export type ApprovePaymentOrderInput = z.infer<typeof approvePaymentOrderSchema>;

/**
 * Administrator refund request payload
 */
export const requestPaymentRefundSchema = z.object({
  payment_order_id: z.string().uuid("payment_order_id must be a valid UUID"),
  receipt_submission_id: z.string().uuid().nullable().optional(),
  amount_krw: z.number().int().positive("amount_krw must be positive"),
  idempotency_key: z
    .string()
    .trim()
    .min(10, "idempotency_key must be at least 10 characters")
    .max(128, "idempotency_key cannot exceed 128 characters"),
  requested_by: z.string().uuid("requested_by must be a valid UUID"),
});

export type RequestPaymentRefundInput = z.infer<typeof requestPaymentRefundSchema>;

// ============================================================================
// Helper Functions & Guards
// ============================================================================

/**
 * Sanitizes a database payment order for safe public/client consumption
 * Strictly removes provider_payment_key and internal idempotency_key
 */
export function toPublicPaymentOrder(row: PaymentOrderRow): PublicPaymentOrder {
  const {
    provider_payment_key: _omittedKey,
    idempotency_key: _omittedIdemKey,
    ...safe
  } = row;
  return safe;
}

/**
 * Sanitizes a database payment refund for safe public/client consumption
 * Strictly removes provider_cancel_id, internal idempotency_key, and requested_by
 */
export function toPublicPaymentRefund(row: PaymentRefundRow): PublicPaymentRefund {
  const {
    provider_cancel_id: _omittedCancelId,
    idempotency_key: _omittedIdemKey,
    requested_by: _omittedRequestedBy,
    ...safe
  } = row;
  return safe;
}

/**
 * Checks if a payment order is successfully approved
 */
export function isApprovedPaymentOrder(
  order: Pick<PaymentOrderRow, "status">
): boolean {
  return order.status === "approved";
}

/**
 * Terminal states for payment orders
 */
export function isTerminalPaymentOrderStatus(
  status: PaymentOrderStatus
): boolean {
  return status === "failed" || status === "canceled";
}

/**
 * Terminal states for payment refunds
 */
export function isTerminalPaymentRefundStatus(
  status: PaymentRefundStatus
): boolean {
  return status === "succeeded";
}

