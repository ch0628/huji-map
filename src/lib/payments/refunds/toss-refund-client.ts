/**
 * TASK 30: Toss Payments Test Cancellation & Verification Client
 * Spec: https://docs.tosspayments.com/reference
 *       https://docs.tosspayments.com/guides/v2/cancel-payment
 *       https://docs.tosspayments.com/reference/using-api/authorization
 *
 * Security Invariants:
 * - Enforces test-only secret key (starts with `test_`, strictly blocks `live_`).
 * - Never leaks secret key or Authorization header in errors or return values.
 * - Always calls full cancellation (omits `cancelAmount`).
 * - Validates paymentKey, orderId, totalAmount, status, and cancel records.
 */

import { assertPaymentTestModeAllowed, PaymentConfigError } from "../config";
import { TossPaymentError, type TossPaymentStatus } from "../toss-client";
import type {
  ITossRefundClient,
  TossCancelPaymentRequest,
  TossCancelRecord,
  TossPaymentWithCancelsResponse,
} from "./types";

export interface TossRefundClientOptions {
  secretKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

export interface VerifiedTossCancelResult {
  valid: boolean;
  reason?: string;
  cancelTransactionKey?: string;
  canceledAt?: string;
  cancelReason?: string;
  totalCanceledAmount?: number;
}

function validateTestSecretKeyValue(secretKey: string): string {
  const trimmed = secretKey.trim();
  if (!trimmed) {
    throw new PaymentConfigError(
      "TOSS_CONFIG_REQUIRED",
      "토스페이먼츠 테스트 시크릿 키 설정이 필요합니다.",
      503
    );
  }
  if (trimmed.startsWith("live_")) {
    throw new PaymentConfigError(
      "SECURITY_VIOLATION_LIVE_SECRET_KEY",
      "TOSS 실거래 시크릿 키(live_)는 사용할 수 없습니다. 테스트 키(test_)를 사용하세요.",
      500
    );
  }
  if (!trimmed.startsWith("test_")) {
    throw new PaymentConfigError(
      "INVALID_TEST_SECRET_KEY_FORMAT",
      "유효하지 않은 토스 테스트 시크릿 키입니다. 'test_'로 시작해야 합니다.",
      500
    );
  }
  return trimmed;
}

export class DefaultTossRefundClient implements ITossRefundClient {
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(options: TossRefundClientOptions = {}) {
    this.secretKey = options.secretKey
      ? validateTestSecretKeyValue(options.secretKey)
      : assertPaymentTestModeAllowed();
    this.baseUrl = options.baseUrl || "https://api.tosspayments.com/v1";
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.fetcher = options.fetcher || globalThis.fetch.bind(globalThis);
  }

  private getAuthHeader(): string {
    const encoded = Buffer.from(`${this.secretKey}:`).toString("base64");
    return `Basic ${encoded}`;
  }

  /**
   * Calls GET /v1/payments/{paymentKey}
   * Used for pre-cancel verification and post-timeout reconciliation.
   */
  async getPaymentByPaymentKey(
    paymentKey: string
  ): Promise<TossPaymentWithCancelsResponse> {
    if (!paymentKey || !paymentKey.trim()) {
      throw new TossPaymentError(
        "INVALID_PAYMENT_KEY",
        "결제 키가 유효하지 않습니다.",
        400
      );
    }

    const url = `${this.baseUrl}/payments/${encodeURIComponent(paymentKey)}`;
    const res = await this.executeRequest(url, {
      method: "GET",
      headers: {
        Authorization: this.getAuthHeader(),
        "Content-Type": "application/json",
      },
    });

    return this.parsePaymentResponse(res);
  }

  /**
   * Calls POST /v1/payments/{paymentKey}/cancel
   * Always performs FULL cancellation by omitting `cancelAmount`.
   */
  async cancelPayment(
    req: TossCancelPaymentRequest
  ): Promise<TossPaymentWithCancelsResponse> {
    if (!req.paymentKey || !req.paymentKey.trim()) {
      throw new TossPaymentError(
        "INVALID_PAYMENT_KEY",
        "결제 키가 유효하지 않습니다.",
        400
      );
    }
    if (!req.idempotencyKey || !req.idempotencyKey.trim()) {
      throw new TossPaymentError(
        "INVALID_IDEMPOTENCY_KEY",
        "멱등키가 필요합니다.",
        400
      );
    }

    const url = `${this.baseUrl}/payments/${encodeURIComponent(
      req.paymentKey
    )}/cancel`;
    const body = JSON.stringify({
      cancelReason: req.cancelReason,
      // cancelAmount is intentionally omitted to enforce full cancellation only
    });

    const res = await this.executeRequest(url, {
      method: "POST",
      headers: {
        Authorization: this.getAuthHeader(),
        "Content-Type": "application/json",
        "Idempotency-Key": req.idempotencyKey,
      },
      body,
    });

    return this.parsePaymentResponse(res);
  }

  private async executeRequest(
    url: string,
    init: RequestInit
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await this.fetcher(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (err: unknown) {
      const isAbort =
        (err instanceof Error && err.name === "AbortError") ||
        (typeof err === "object" &&
          err !== null &&
          "name" in err &&
          err.name === "AbortError");

      if (isAbort) {
        throw new TossPaymentError(
          "PG_TIMEOUT",
          "토스페이먼츠 취소 서버 응답 시간이 초과되었습니다.",
          504,
          { isRetryable: true }
        );
      }

      throw new TossPaymentError(
        "PG_NETWORK_ERROR",
        "토스페이먼츠 취소 서버와 통신할 수 없습니다.",
        502,
        { isRetryable: true }
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async parsePaymentResponse(
    res: Response
  ): Promise<TossPaymentWithCancelsResponse> {
    let json: Record<string, unknown> | null = null;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new TossPaymentError(
        "INVALID_PG_RESPONSE",
        "토스페이먼츠 응답을 해석할 수 없습니다.",
        502,
        { isRetryable: res.status >= 500 }
      );
    }

    if (!res.ok) {
      const errorCode = String(json?.code || "PG_CANCEL_FAILED");
      const errorMessage = String(
        json?.message || "토스페이먼츠 취소 요청 처리에 실패했습니다."
      );

      const isProcessing =
        res.status === 409 &&
        (errorCode === "IDEMPOTENT_REQUEST_PROCESSING" ||
          errorCode === "PROCESSING");

      const isRetryable =
        res.status >= 500 || res.status === 504 || isProcessing;

      throw new TossPaymentError(errorCode, errorMessage, res.status, {
        isRetryable,
        isProcessing,
      });
    }

    if (!json || typeof json !== "object") {
      throw new TossPaymentError(
        "MALFORMED_PG_RESPONSE",
        "유효하지 않은 결제 응답 데이터입니다.",
        502
      );
    }

    const paymentKey =
      typeof json.paymentKey === "string" ? json.paymentKey : "";
    const orderId = typeof json.orderId === "string" ? json.orderId : "";
    const status = typeof json.status === "string" ? json.status : "";
    const totalAmount =
      typeof json.totalAmount === "number" ? json.totalAmount : NaN;
    const balanceAmount =
      typeof json.balanceAmount === "number" ? json.balanceAmount : undefined;

    if (!paymentKey || !orderId || Number.isNaN(totalAmount) || !status) {
      throw new TossPaymentError(
        "INCOMPLETE_PG_RESPONSE",
        "토스페이먼츠 응답의 필수 필드가 누락되었습니다.",
        502
      );
    }

    const rawCancels = Array.isArray(json.cancels) ? json.cancels : null;
    const cancels: TossCancelRecord[] | null = rawCancels
      ? rawCancels
          .filter(
            (item): item is Record<string, unknown> =>
              Boolean(item) && typeof item === "object"
          )
          .map((item) => ({
            transactionKey:
              typeof item.transactionKey === "string"
                ? item.transactionKey
                : "",
            cancelAmount:
              typeof item.cancelAmount === "number" ? item.cancelAmount : 0,
            cancelReason:
              typeof item.cancelReason === "string"
                ? item.cancelReason
                : undefined,
            canceledAt:
              typeof item.canceledAt === "string" ? item.canceledAt : undefined,
            cancelStatus:
              typeof item.cancelStatus === "string"
                ? item.cancelStatus
                : undefined,
            easyPayDiscountAmount:
              typeof item.easyPayDiscountAmount === "number"
                ? item.easyPayDiscountAmount
                : undefined,
            refundableAmount:
              typeof item.refundableAmount === "number"
                ? item.refundableAmount
                : undefined,
          }))
      : null;

    return {
      paymentKey,
      orderId,
      status: status as TossPaymentStatus,
      totalAmount,
      balanceAmount,
      requestedAt:
        typeof json.requestedAt === "string" ? json.requestedAt : undefined,
      approvedAt:
        typeof json.approvedAt === "string" ? json.approvedAt : undefined,
      cancels,
    };
  }
}

export function createTossRefundClient(
  options?: TossRefundClientOptions
): ITossRefundClient {
  return new DefaultTossRefundClient(options);
}

/**
 * Strictly verifies that a Toss Payment response proves a complete full-amount cancellation
 * matching the expected paymentKey, orderId, and DB amount.
 */
export function verifyTossFullCancellation(params: {
  tossPayment: TossPaymentWithCancelsResponse;
  expectedPaymentKey: string;
  expectedOrderId: string;
  expectedAmountKrw: number;
}): VerifiedTossCancelResult {
  const { tossPayment, expectedPaymentKey, expectedOrderId, expectedAmountKrw } =
    params;

  if (tossPayment.paymentKey !== expectedPaymentKey) {
    return {
      valid: false,
      reason: "PG_PAYMENT_KEY_MISMATCH",
    };
  }

  if (tossPayment.orderId !== expectedOrderId) {
    return {
      valid: false,
      reason: "PG_ORDER_ID_MISMATCH",
    };
  }

  if (tossPayment.totalAmount !== expectedAmountKrw) {
    return {
      valid: false,
      reason: "PG_AMOUNT_MISMATCH",
    };
  }

  if (tossPayment.status === "PARTIAL_CANCELED") {
    return {
      valid: false,
      reason: "PG_PARTIAL_CANCELED",
    };
  }

  if (tossPayment.status !== "CANCELED") {
    return {
      valid: false,
      reason: `PG_STATUS_NOT_CANCELED:${tossPayment.status}`,
    };
  }

  if (
    typeof tossPayment.balanceAmount === "number" &&
    tossPayment.balanceAmount !== 0
  ) {
    return {
      valid: false,
      reason: "PG_NON_ZERO_BALANCE",
    };
  }

  const cancels = tossPayment.cancels ?? [];
  if (cancels.length === 0) {
    return {
      valid: false,
      reason: "PG_MISSING_CANCEL_HISTORY",
    };
  }

  const doneCancels = cancels.filter(
    (c) =>
      (!c.cancelStatus || c.cancelStatus === "DONE") &&
      c.transactionKey.trim().length > 0 &&
      c.cancelAmount > 0
  );

  if (doneCancels.length === 0) {
    return {
      valid: false,
      reason: "PG_NO_DONE_CANCEL_RECORD",
    };
  }

  const totalCanceledAmount = doneCancels.reduce(
    (sum, item) => sum + item.cancelAmount,
    0
  );

  if (totalCanceledAmount !== expectedAmountKrw) {
    return {
      valid: false,
      reason: "PG_CANCEL_AMOUNT_MISMATCH",
    };
  }

  const latestCancel = doneCancels[doneCancels.length - 1];

  return {
    valid: true,
    cancelTransactionKey: latestCancel.transactionKey,
    canceledAt: latestCancel.canceledAt,
    cancelReason: latestCancel.cancelReason,
    totalCanceledAmount,
  };
}

