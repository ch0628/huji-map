/**
 * Payment Service Implementation
 * Handles order creation, Toss confirmation, atomic DB transitions,
 * error recovery, idempotent retries, and server event telemetry.
 *
 * Spec: docs/04_API_CONTRACT.md, docs/07_PAYMENT_ACCESS_REFUND.md,
 *       docs/08_SECURITY_OPERATIONS.md, docs/11_DECISIONS.md, tasks/21_toss_server.md
 */

import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";
import { createAdminClient } from "@/lib/supabase/server";
import {
  assertPaymentTestModeAllowed,
  getTossTestClientKey,
} from "./config";
import {
  createTossPaymentsClient,
  type ITossPaymentsClient,
  TossPaymentError,
} from "./toss-client";
import {
  type PaymentOrderRow,
  type PublicPaymentOrder,
  toPublicPaymentOrder,
} from "./types";
import {
  type AccessSessionRow,
  type PublicAccessSession,
  toPublicAccessSession,
} from "@/lib/access/types";

export class PaymentServiceError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly userMessage: string;

  constructor(code: string, statusCode: number, userMessage: string) {
    super(userMessage);
    this.name = "PaymentServiceError";
    this.code = code;
    this.statusCode = statusCode;
    this.userMessage = userMessage;
  }
}

export interface CreatePaymentOrderResult {
  orderId: string;
  amount: number;
  paymentMode: "test";
  accessSessionId: string;
  clientKey?: string;
  order: PublicPaymentOrder;
  accessSession: PublicAccessSession;
  reused: boolean;
}

export interface ConfirmPaymentResult {
  order: PublicPaymentOrder;
  accessSession: PublicAccessSession;
  alreadyApproved: boolean;
}

/**
 * Creates a test payment order and access session atomically.
 */
export async function createPaymentOrder(params: {
  userId: string;
  restroomId: string;
  idempotencyKey: string;
  injectedClient?: SupabaseClient<Database>;
}): Promise<CreatePaymentOrderResult> {
  // 1. Verify payment mode is test and configuration is ready
  assertPaymentTestModeAllowed();

  const supabase = params.injectedClient || createAdminClient();

  // 2. Generate a secure, unique PG orderId (e.g. hm_ord_{timestamp}_{random})
  const generatedOrderId = `hm_ord_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;

  // 3. Call atomic PostgreSQL RPC `create_payment_order_session`
  const { data: rpcData, error: rpcError } = await supabase.rpc(
    "create_payment_order_session" as any,
    {
      p_user_id: params.userId,
      p_restroom_id: params.restroomId,
      p_order_id: generatedOrderId,
      p_idempotency_key: params.idempotencyKey,
    } as any
  );

  if (rpcError) {
    if (rpcError.code === "P0002" || rpcError.message?.includes("HM064")) {
      throw new PaymentServiceError(
        "RESTROOM_NOT_FOUND",
        404,
        "화장실 정보를 찾을 수 없습니다."
      );
    }
    if (rpcError.message?.includes("HM065")) {
      throw new PaymentServiceError(
        "PUBLIC_RESTROOM_ORDER_FORBIDDEN",
        400,
        "공공 화장실은 무료 이용 대상이며 결제 주문을 생성할 수 없습니다."
      );
    }
    if (rpcError.message?.includes("HM066")) {
      throw new PaymentServiceError(
        "RESTROOM_NOT_PUBLISHED",
        400,
        "공개 승인되지 않은 화장실에는 결제 주문을 생성할 수 없습니다."
      );
    }
    if (rpcError.message?.includes("HM067")) {
      throw new PaymentServiceError(
        "PARTNER_BUSINESS_NOT_APPROVED",
        400,
        "승인되지 않은 제휴 점포의 화장실은 이용할 수 없습니다."
      );
    }
    if (rpcError.code === "23505" || rpcError.message?.includes("HM063")) {
      throw new PaymentServiceError(
        "IDEMPOTENCY_KEY_COLLISION",
        409,
        "동일한 멱등키가 다른 화장실 주문에 이미 사용되었습니다."
      );
    }
    if (rpcError.code === "42501" || rpcError.message?.includes("HM062")) {
      throw new PaymentServiceError(
        "ACCOUNT_SUSPENDED",
        403,
        "이용이 제한된 사용자 계정입니다."
      );
    }

    throw new PaymentServiceError(
      "ORDER_CREATION_FAILED",
      500,
      rpcError.message || "결제 주문 생성에 실패했습니다."
    );
  }

  const orderRow = (rpcData as any).order as PaymentOrderRow;
  const sessionRow = (rpcData as any).access_session as AccessSessionRow;
  const isReused = Boolean((rpcData as any).reused);
  const businessId = (rpcData as any).business_id as string | undefined;

  // 4. Log server event `payment_order_created` if new order
  if (!isReused) {
    try {
      await (supabase as any).from("event_logs").insert({
        client_event_id: crypto.randomUUID(),
        event_name: "payment_order_created",
        event_version: 1,
        user_id: params.userId,
        business_id: businessId || null,
        restroom_id: params.restroomId,
        access_session_id: sessionRow.id,
        properties: {
          order_id: orderRow.order_id,
          amount_krw: orderRow.amount_krw,
          payment_mode: "test",
        },
        source: "server",
        is_test: true,
        occurred_at: new Date().toISOString(),
        received_at: new Date().toISOString(),
      });
    } catch (eventErr) {
      // Event failure must not break payment order response
      console.warn("Failed to log payment_order_created event:", eventErr);
    }
  }

  return {
    orderId: orderRow.order_id,
    amount: orderRow.amount_krw,
    paymentMode: "test",
    accessSessionId: sessionRow.id,
    clientKey: getTossTestClientKey() || undefined,
    order: toPublicPaymentOrder(orderRow),
    accessSession: toPublicAccessSession(sessionRow),
    reused: isReused,
  };
}

/**
 * Confirms a payment order with Toss Payments and atomically authorizes access.
 */
export async function confirmPayment(params: {
  userId: string;
  orderId: string;
  paymentKey: string;
  amount: number;
  tossClient?: ITossPaymentsClient;
  injectedClient?: SupabaseClient<Database>;
}): Promise<ConfirmPaymentResult> {
  // 1. Verify payment mode is test and configuration is ready
  assertPaymentTestModeAllowed();

  const supabase = params.injectedClient || createAdminClient();

  // 2. Fetch order from DB using service_role to verify ownership & amount
  const { data: orderData, error: fetchOrderError } = await supabase
    .from("payment_orders")
    .select("*")
    .eq("order_id", params.orderId)
    .maybeSingle();

  if (fetchOrderError || !orderData) {
    throw new PaymentServiceError(
      "ORDER_NOT_FOUND",
      404,
      "주문 정보를 찾을 수 없습니다."
    );
  }

  const order = orderData as PaymentOrderRow;

  // Verify ownership
  if (order.user_id !== params.userId) {
    throw new PaymentServiceError(
      "FORBIDDEN_ORDER_OWNERSHIP",
      403,
      "해당 주문에 접근할 권한이 없습니다."
    );
  }

  // Verify amount matches server stored amount
  if (order.amount_krw !== params.amount) {
    throw new PaymentServiceError(
      "AMOUNT_MISMATCH",
      400,
      `요청 금액(${params.amount})이 저장된 주문 금액(${order.amount_krw})과 일치하지 않습니다.`
    );
  }

  // 3. Idempotency & status check
  if (order.status === "approved") {
    if (order.provider_payment_key === params.paymentKey) {
      // Safely return existing approved result without calling PG again
      const { data: sessionData } = await supabase
        .from("access_sessions")
        .select("*")
        .eq("id", order.access_session_id)
        .single();

      return {
        order: toPublicPaymentOrder(order),
        accessSession: toPublicAccessSession(sessionData as unknown as AccessSessionRow),
        alreadyApproved: true,
      };
    } else {
      // Collision / tampering: different payment key on already approved order
      throw new PaymentServiceError(
        "PAYMENT_KEY_MISMATCH",
        409,
        "이미 다른 결제 키로 승인 완료된 주문입니다."
      );
    }
  }

  if (order.status === "failed" || order.status === "canceled") {
    throw new PaymentServiceError(
      "ORDER_TERMINAL_STATUS",
      422,
      `이미 종료된 주문(${order.status})은 결제 승인을 진행할 수 없습니다.`
    );
  }

  // 4. Call Toss Payments API
  const tossClient = params.tossClient || createTossPaymentsClient();
  let tossApproved = false;

  try {
    const tossRes = await tossClient.confirm({
      paymentKey: params.paymentKey,
      orderId: params.orderId,
      amount: params.amount,
      idempotencyKey: order.idempotency_key,
    });

    if (tossRes.status === "DONE") {
      tossApproved = true;
    } else {
      throw new PaymentServiceError(
        "PG_APPROVAL_INCOMPLETE",
        400,
        `토스 결제 승인이 완료되지 않았습니다 (상태: ${tossRes.status}).`
      );
    }
  } catch (err: unknown) {
    if (err instanceof PaymentServiceError) {
      throw err;
    }

    if (err instanceof TossPaymentError) {
      // A. Processing (409)
      if (err.isProcessing) {
        throw new PaymentServiceError(
          "PG_PROCESSING",
          409,
          "토스페이먼츠에서 결제를 처리 중입니다. 잠시 후 상태를 다시 확인해 주세요."
        );
      }

      // B. Already processed payment in Toss: verify via query API
      if (err.code === "ALREADY_PROCESSED_PAYMENT") {
        try {
          const queryRes = await tossClient.getPaymentByPaymentKey(params.paymentKey);
          if (
            queryRes.status === "DONE" &&
            queryRes.orderId === params.orderId &&
            queryRes.totalAmount === params.amount
          ) {
            tossApproved = true;
          }
        } catch {
          // If query fails, fall through to re-throw
        }
      }

      // C. Retryable network timeout / server 5xx: verify via query API
      if (!tossApproved && err.isRetryable) {
        try {
          const queryRes = await tossClient.getPaymentByPaymentKey(params.paymentKey);
          if (
            queryRes.status === "DONE" &&
            queryRes.orderId === params.orderId &&
            queryRes.totalAmount === params.amount
          ) {
            tossApproved = true;
          }
        } catch {
          // Query also timed out or failed: do NOT mark order failed!
          throw new PaymentServiceError(
            "PG_TIMEOUT",
            504,
            "토스페이먼츠 응답 시간이 초과되었습니다. 중복 결제를 방지하기 위해 잠시 후 재시도해 주세요."
          );
        }
      }

      // D. Definite rejection: record failure in DB
      if (!tossApproved) {
        try {
          await supabase.rpc("record_payment_failure" as any, {
            p_order_id: params.orderId,
            p_failure_code: err.code,
          } as any);

          // Log server event `payment_failed`
          await (supabase as any).from("event_logs").insert({
            client_event_id: crypto.randomUUID(),
            event_name: "payment_failed",
            event_version: 1,
            user_id: params.userId,
            access_session_id: order.access_session_id,
            properties: {
              order_id: params.orderId,
              failure_code: err.code,
            },
            source: "server",
            is_test: true,
            occurred_at: new Date().toISOString(),
            received_at: new Date().toISOString(),
          });
        } catch (failErr) {
          console.warn("Failed to record payment failure:", failErr);
        }

        throw new PaymentServiceError(
          err.code,
          err.status >= 400 && err.status < 500 ? err.status : 400,
          err.message || "결제 승인이 거절되었습니다."
        );
      }
    } else {
      throw new PaymentServiceError(
        "UNEXPECTED_PG_ERROR",
        500,
        "결제 처리 중 예상치 못한 오류가 발생했습니다."
      );
    }
  }

  // 5. Toss approval confirmed -> Atomic DB update via `complete_payment_approval` RPC
  const { data: updateData, error: updateError } = await supabase.rpc(
    "complete_payment_approval" as any,
    {
      p_order_id: params.orderId,
      p_payment_key: params.paymentKey,
      p_amount_krw: params.amount,
    } as any
  );

  if (updateError) {
    // PG succeeded, but DB failed! DO NOT MARK ORDER AS FAILED!
    // The payment is verified in Toss. The client or reconciliation job can retry.
    console.error(
      `CRITICAL: Toss payment confirmed but DB atomic update failed for order ${params.orderId}:`,
      updateError
    );

    throw new PaymentServiceError(
      "DB_APPROVAL_FAILED",
      500,
      "결제는 승인되었으나 이용권 활성화 처리 중 시스템 오류가 발생했습니다. 잠시 후 다시 시도해 주세요."
    );
  }

  const updatedOrder = (updateData as any).order as PaymentOrderRow;
  const updatedSession = (updateData as any).access_session as AccessSessionRow;
  const alreadyApproved = Boolean((updateData as any).already_approved);

  // 6. Emit server events: `payment_confirmed` and `access_authorized`
  try {
    const now = new Date().toISOString();
    await (supabase as any).from("event_logs").insert([
      {
        client_event_id: crypto.randomUUID(),
        event_name: "payment_confirmed",
        event_version: 1,
        user_id: params.userId,
        restroom_id: updatedSession.restroom_id,
        access_session_id: updatedSession.id,
        properties: {
          order_id: updatedOrder.order_id,
          amount_krw: updatedOrder.amount_krw,
          payment_mode: "test",
          approved_at: updatedOrder.approved_at,
        },
        source: "server",
        is_test: true,
        occurred_at: now,
        received_at: now,
      },
      {
        client_event_id: crypto.randomUUID(),
        event_name: "access_authorized",
        event_version: 1,
        user_id: params.userId,
        restroom_id: updatedSession.restroom_id,
        access_session_id: updatedSession.id,
        properties: {
          access_method: updatedSession.access_method_snapshot,
          authorized_at: updatedSession.authorized_at,
        },
        source: "server",
        is_test: true,
        occurred_at: now,
        received_at: now,
      },
    ]);
  } catch (eventErr) {
    console.warn("Failed to log payment_confirmed / access_authorized events:", eventErr);
  }

  return {
    order: toPublicPaymentOrder(updatedOrder),
    accessSession: toPublicAccessSession(updatedSession),
    alreadyApproved,
  };
}

/**
 * Retrieves safe public details of a payment order.
 */
export async function getPaymentOrder(params: {
  userId: string;
  isAdmin: boolean;
  orderIdOrId: string;
  injectedClient?: SupabaseClient<Database>;
}): Promise<PublicPaymentOrder> {
  assertPaymentTestModeAllowed();

  const supabase = params.injectedClient || createAdminClient();

  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      params.orderIdOrId
    );

  let query = supabase.from("payment_orders").select("*");
  if (isUuid) {
    query = query.eq("id", params.orderIdOrId);
  } else {
    query = query.eq("order_id", params.orderIdOrId);
  }

  const { data, error } = await query.maybeSingle();

  if (error || !data) {
    throw new PaymentServiceError(
      "ORDER_NOT_FOUND",
      404,
      "주문 정보를 찾을 수 없습니다."
    );
  }

  const order = data as PaymentOrderRow;

  if (order.user_id !== params.userId && !params.isAdmin) {
    throw new PaymentServiceError(
      "FORBIDDEN_ORDER_ACCESS",
      403,
      "해당 주문을 조회할 권한이 없습니다."
    );
  }

  return toPublicPaymentOrder(order);
}
