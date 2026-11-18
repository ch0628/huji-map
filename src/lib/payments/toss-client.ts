/**
 * Toss Payments Official API Client (v1/payments)
 * Spec: docs/04_API_CONTRACT.md, docs/07_PAYMENT_ACCESS_REFUND.md,
 *       https://docs.tosspayments.com/reference
 *
 * Rules:
 * - Basic authentication with test secret key: `Basic base64(SECRET_KEY + ":")`
 * - Idempotency-Key header support
 * - Strict error classification (processing, retryable, terminal)
 * - Safe error messages with NO credential leakage
 */

import { assertPaymentTestModeAllowed } from "./config";

export interface TossConfirmRequest {
  paymentKey: string;
  orderId: string;
  amount: number;
  idempotencyKey?: string;
}

export type TossPaymentStatus =
  | "READY"
  | "IN_PROGRESS"
  | "WAITING_FOR_DEPOSIT"
  | "DONE"
  | "CANCELED"
  | "PARTIAL_CANCELED"
  | "ABORTED"
  | "EXPIRED";

export interface TossPaymentResponse {
  paymentKey: string;
  orderId: string;
  orderName?: string;
  status: TossPaymentStatus;
  totalAmount: number;
  method?: string;
  requestedAt?: string;
  approvedAt?: string;
  type?: string;
  currency?: string;
  raw?: Record<string, unknown>;
}

export class TossPaymentError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly isRetryable: boolean;
  public readonly isProcessing: boolean;

  constructor(
    code: string,
    message: string,
    status = 400,
    options: { isRetryable?: boolean; isProcessing?: boolean } = {}
  ) {
    super(message);
    this.name = "TossPaymentError";
    this.code = code;
    this.status = status;
    this.isRetryable = Boolean(options.isRetryable);
    this.isProcessing = Boolean(options.isProcessing);
  }
}

export interface ITossPaymentsClient {
  confirm(req: TossConfirmRequest): Promise<TossPaymentResponse>;
  getPaymentByPaymentKey(paymentKey: string): Promise<TossPaymentResponse>;
  getPaymentByOrderId(orderId: string): Promise<TossPaymentResponse>;
}

export interface TossClientOptions {
  secretKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

export class DefaultTossPaymentsClient implements ITossPaymentsClient {
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(options: TossClientOptions = {}) {
    this.secretKey = options.secretKey || assertPaymentTestModeAllowed();
    this.baseUrl = options.baseUrl || "https://api.tosspayments.com/v1";
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.fetcher = options.fetcher || globalThis.fetch.bind(globalThis);
  }

  private getAuthHeader(): string {
    const encoded = Buffer.from(`${this.secretKey}:`).toString("base64");
    return `Basic ${encoded}`;
  }

  /**
   * Calls POST /v1/payments/confirm
   * https://docs.tosspayments.com/reference#%EA%B2%B0%EC%A0%9C-%EC%8A%B9%EC%9D%B8
   */
  async confirm(req: TossConfirmRequest): Promise<TossPaymentResponse> {
    const url = `${this.baseUrl}/payments/confirm`;
    const headers: Record<string, string> = {
      Authorization: this.getAuthHeader(),
      "Content-Type": "application/json",
    };

    if (req.idempotencyKey) {
      headers["Idempotency-Key"] = req.idempotencyKey;
    }

    const body = JSON.stringify({
      paymentKey: req.paymentKey,
      orderId: req.orderId,
      amount: req.amount,
    });

    const res = await this.executeRequest(url, {
      method: "POST",
      headers,
      body,
    });

    return this.parsePaymentResponse(res, req.orderId, req.amount);
  }

  /**
   * Calls GET /v1/payments/{paymentKey}
   * https://docs.tosspayments.com/reference#paymentkey%EB%A1%9C-%EA%B2%B0%EC%A0%9C-%EC%A1%B0%ED%9A%8C
   */
  async getPaymentByPaymentKey(paymentKey: string): Promise<TossPaymentResponse> {
    const url = `${this.baseUrl}/payments/${encodeURIComponent(paymentKey)}`;
    const headers: Record<string, string> = {
      Authorization: this.getAuthHeader(),
      "Content-Type": "application/json",
    };

    const res = await this.executeRequest(url, {
      method: "GET",
      headers,
    });

    return this.parsePaymentResponse(res);
  }

  /**
   * Calls GET /v1/payments/orders/{orderId}
   * https://docs.tosspayments.com/reference#orderid%EB%A1%9C-%EA%B2%B0%EC%A0%9C-%EC%A1%B0%ED%9A%8C
   */
  async getPaymentByOrderId(orderId: string): Promise<TossPaymentResponse> {
    const url = `${this.baseUrl}/payments/orders/${encodeURIComponent(orderId)}`;
    const headers: Record<string, string> = {
      Authorization: this.getAuthHeader(),
      "Content-Type": "application/json",
    };

    const res = await this.executeRequest(url, {
      method: "GET",
      headers,
    });

    return this.parsePaymentResponse(res, orderId);
  }

  private async executeRequest(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetcher(url, {
        ...init,
        signal: controller.signal,
      });
      return response;
    } catch (err: unknown) {
      const isAbort =
        (err instanceof Error && err.name === "AbortError") ||
        (typeof err === "object" && err !== null && "name" in err && err.name === "AbortError");

      if (isAbort) {
        throw new TossPaymentError(
          "PG_TIMEOUT",
          "토스페이먼츠 결제 서버 응답 시간이 초과되었습니다.",
          504,
          { isRetryable: true }
        );
      }

      throw new TossPaymentError(
        "PG_NETWORK_ERROR",
        "토스페이먼츠 결제 서버와 통신할 수 없습니다.",
        502,
        { isRetryable: true }
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async parsePaymentResponse(
    res: Response,
    expectedOrderId?: string,
    expectedAmount?: number
  ): Promise<TossPaymentResponse> {
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      throw new TossPaymentError(
        "INVALID_PG_RESPONSE",
        "토스페이먼츠 응답을 해석할 수 없습니다.",
        502,
        { isRetryable: res.status >= 500 }
      );
    }

    if (!res.ok) {
      const errorCode = String(json?.code || "PAYMENT_FAILED");
      const errorMessage = String(json?.message || "결제 처리에 실패했습니다.");

      // Check for Toss 409 idempotency processing
      const isProcessing =
        res.status === 409 ||
        errorCode === "IDEMPOTENT_REQUEST_PROCESSING" ||
        errorCode === "PROCESSING";

      const isRetryable = res.status >= 500 || res.status === 504 || isProcessing;

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

    const {
      paymentKey,
      orderId,
      orderName,
      status,
      totalAmount,
      method,
      requestedAt,
      approvedAt,
      type,
      currency,
      ...raw
    } = json;

    if (!paymentKey || !orderId || typeof totalAmount !== "number" || !status) {
      throw new TossPaymentError(
        "INCOMPLETE_PG_RESPONSE",
        "결제 응답의 필수 필드가 누락되었습니다.",
        502
      );
    }

    if (expectedOrderId && orderId !== expectedOrderId) {
      throw new TossPaymentError(
        "ORDER_ID_MISMATCH",
        `주문번호 불일치: 요청(${expectedOrderId}) vs 응답(${orderId})`,
        400
      );
    }

    if (expectedAmount !== undefined && totalAmount !== expectedAmount) {
      throw new TossPaymentError(
        "AMOUNT_MISMATCH",
        `결제 금액 불일치: 요청(${expectedAmount}) vs 응답(${totalAmount})`,
        400
      );
    }

    return {
      paymentKey,
      orderId,
      orderName,
      status: status as TossPaymentStatus,
      totalAmount,
      method,
      requestedAt,
      approvedAt,
      type,
      currency,
      raw,
    };
  }
}

/**
 * Creates a Toss payments client instance.
 */
export function createTossPaymentsClient(
  options?: TossClientOptions
): ITossPaymentsClient {
  return new DefaultTossPaymentsClient(options);
}

