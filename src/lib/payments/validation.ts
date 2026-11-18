/**
 * Payment API Request & Parameter Validation Schemas
 * Spec: docs/04_API_CONTRACT.md, tasks/21_toss_server.md
 */

import { z } from "zod";

/**
 * Payload for creating a test payment order (POST /api/v1/payments/orders)
 * Client ONLY specifies the restroomId and idempotencyKey.
 * Amount and policy are strictly resolved by the server.
 */
export const createOrderRequestSchema = z.object({
  restroomId: z.string().uuid("restroomId must be a valid UUID"),
  idempotencyKey: z
    .string()
    .trim()
    .min(8, "idempotencyKey must be at least 8 characters")
    .max(128, "idempotencyKey cannot exceed 128 characters"),
});

export type CreateOrderRequest = z.infer<typeof createOrderRequestSchema>;

/**
 * Payload for confirming a test payment (POST /api/v1/payments/confirm)
 */
export const confirmPaymentRequestSchema = z.object({
  orderId: z
    .string()
    .trim()
    .min(6, "orderId must be at least 6 characters")
    .max(64, "orderId cannot exceed 64 characters"),
  paymentKey: z
    .string()
    .trim()
    .min(1, "paymentKey is required")
    .max(255, "paymentKey cannot exceed 255 characters"),
  amount: z
    .number()
    .int("amount must be an integer")
    .positive("amount must be positive"),
});

export type ConfirmPaymentRequest = z.infer<typeof confirmPaymentRequestSchema>;

/**
 * Path parameter for order status inquiry (GET /api/v1/payments/orders/:id)
 * Can be either a payment_orders UUID or a PG orderId string.
 */
export const orderIdParamSchema = z.object({
  id: z.string().trim().min(1, "id parameter is required").max(64),
});

export type OrderIdParam = z.infer<typeof orderIdParamSchema>;

