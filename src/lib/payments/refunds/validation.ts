/**
 * TASK 30: Admin Refund Request & Filter Validation (Zod)
 * Spec: docs/04_API_CONTRACT.md, tasks/30_refund_server.md
 */

import { z } from "zod";
import { PAYMENT_REFUND_STATUSES } from "../types";

export const uuidSchema = z.string().uuid("유효한 UUID 형식이 아닙니다.");

/**
 * Path parameter schema for POST /api/v1/admin/refunds/:paymentOrderId/request
 */
export const adminRefundPathParamSchema = z.object({
  paymentOrderId: z.string().uuid("유효한 paymentOrderId(UUID)가 아닙니다."),
});

/**
 * Body schema for POST /api/v1/admin/refunds/:paymentOrderId/request
 * Strictly accepts ONLY receiptSubmissionId and idempotencyKey.
 * Any client-supplied paymentKey or amount fields are rejected (.strict())
 * so the client can never inject or alter refund amounts or keys.
 */
export const adminRefundRequestBodySchema = z
  .object({
    receiptSubmissionId: z
      .string()
      .uuid("유효한 receiptSubmissionId(UUID)가 아닙니다."),
    idempotencyKey: z
      .string()
      .trim()
      .min(10, "idempotencyKey는 최소 10자 이상이어야 합니다.")
      .max(128, "idempotencyKey는 128자를 초과할 수 없습니다.")
      .regex(
        /^[A-Za-z0-9_.:-]+$/,
        "idempotencyKey는 영문, 숫자, _, ., :, - 만 허용됩니다."
      ),
  })
  .strict();

export type AdminRefundRequestBody = z.infer<typeof adminRefundRequestBodySchema>;

/**
 * Query filter schema for GET /api/v1/admin/refunds
 */
export const adminRefundListFilterSchema = z.object({
  status: z.enum(PAYMENT_REFUND_STATUSES).optional(),
  paymentOrderId: z.string().uuid("유효한 paymentOrderId가 아닙니다.").optional(),
  receiptSubmissionId: z
    .string()
    .uuid("유효한 receiptSubmissionId가 아닙니다.")
    .optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type AdminRefundListFilterInput = z.infer<
  typeof adminRefundListFilterSchema
>;

