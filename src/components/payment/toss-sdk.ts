/**
 * Toss Payments SDK V2 Loader & Checkout Client
 * Spec: docs/07_PAYMENT_ACCESS_REFUND.md, docs/08_SECURITY_OPERATIONS.md,
 *       docs/11_DECISIONS.md, AGENTS.md Rule 4 & 8
 */

import type { TossCheckoutRequestOptions } from "./types";

export const TOSS_SDK_V2_SCRIPT_URL = "https://js.tosspayments.com/v2/standard";
export const TOSS_SDK_SCRIPT_ID = "toss-payments-sdk-v2-script";

export class TossSdkSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TossSdkSecurityError";
  }
}

export class TossSdkLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TossSdkLoadError";
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    TossPayments?: {
      (clientKey: string): {
        payment: (options: { customerKey: string }) => {
          requestPayment: (params: {
            method: string;
            amount: { currency: string; value: number };
            orderId: string;
            orderName: string;
            successUrl: string;
            failUrl: string;
            customerEmail?: string;
            customerName?: string;
            [key: string]: any;
          }) => Promise<void>;
        };
      };
      ANONYMOUS?: string;
    };
  }
}

let tossSdkLoadingPromise: Promise<NonNullable<typeof window.TossPayments>> | null = null;

/**
 * Resets the cached SDK loading promise.
 * Used primarily in testing environments to simulate load states.
 */
export function resetTossSdkLoader(): void {
  tossSdkLoadingPromise = null;
}

/**
 * Loads the official Toss Payments SDK v2 standard library.
 * Guarantees single script tag injection, SSR safety, and cleanup on failure.
 */
export async function loadTossPaymentsSdk(): Promise<NonNullable<typeof window.TossPayments>> {
  if (typeof window === "undefined") {
    throw new TossSdkLoadError("Toss Payments SDK는 브라우저 환경에서만 로드할 수 있습니다.");
  }

  // Already available on window
  if (window.TossPayments) {
    return window.TossPayments;
  }

  if (tossSdkLoadingPromise) {
    return tossSdkLoadingPromise;
  }

  tossSdkLoadingPromise = new Promise((resolve, reject) => {
    let script = document.getElementById(TOSS_SDK_SCRIPT_ID) as HTMLScriptElement | null;

    if (!script) {
      script = document.createElement("script");
      script.id = TOSS_SDK_SCRIPT_ID;
      script.src = TOSS_SDK_V2_SCRIPT_URL;
      script.async = true;

      script.onload = () => {
        if (window.TossPayments) {
          resolve(window.TossPayments);
        } else {
          script?.remove();
          tossSdkLoadingPromise = null;
          reject(new TossSdkLoadError("TossPayments SDK 객체를 찾을 수 없습니다."));
        }
      };

      script.onerror = () => {
        script?.remove();
        tossSdkLoadingPromise = null;
        reject(
          new TossSdkLoadError("토스페이먼츠 SDK 스크립트를 불러오는 중 네트워크 오류가 발생했습니다.")
        );
      };

      document.head.appendChild(script);
    } else {
      // Script already injected by another caller
      script.addEventListener("load", () => {
        if (window.TossPayments) {
          resolve(window.TossPayments);
        } else {
          reject(new TossSdkLoadError("TossPayments SDK 객체를 찾을 수 없습니다."));
        }
      });
      script.addEventListener("error", () => {
        reject(new TossSdkLoadError("토스페이먼츠 SDK 스크립트 로드 실패"));
      });
    }
  });

  return tossSdkLoadingPromise;
}

/**
 * Validates that the provided clientKey is strictly a test client key.
 * AGENTS.md Rule 4 & docs/07:
 * - Reject any key starting with 'live_'
 * - Require key starting with 'test_'
 * - Reject secret keys ('_sk_') in client code
 */
export function assertTossTestClientKey(clientKey: string): void {
  if (!clientKey || typeof clientKey !== "string") {
    throw new TossSdkSecurityError("토스페이먼츠 클라이언트 키가 누락되었습니다.");
  }

  const trimmed = clientKey.trim();
  if (trimmed.startsWith("live_")) {
    throw new TossSdkSecurityError(
      "실거래 결제 키(live_)는 사용할 수 없습니다. 테스트 키(test_)를 사용하세요. (AGENTS.md Rule 4)"
    );
  }

  if (trimmed.includes("_sk_")) {
    throw new TossSdkSecurityError("시크릿 키(secret key)를 클라이언트 결제창에 사용할 수 없습니다.");
  }

  if (!trimmed.startsWith("test_")) {
    throw new TossSdkSecurityError(
      "유효하지 않은 테스트 클라이언트 키입니다. 'test_'로 시작해야 합니다."
    );
  }
}

/**
 * CustomerKey format pattern per Toss Payments SDK V2 specification:
 * - 22 to 255 characters
 * - Uppercase, lowercase, numbers, and allowed special characters: '-', '_', '=', '.', '@'
 * - At least one allowed special character is required
 */
export const TOSS_CUSTOMER_KEY_REGEX =
  /^(?=.{22,255}$)(?=.*[-_=.@])[A-Za-z0-9\-_=.@]+$/;

/**
 * Validates successUrl and failUrl to ensure they are valid absolute HTTP/HTTPS URLs.
 */
export function assertAbsoluteHttpUrl(urlStr: string, paramName: string): string {
  if (!urlStr || typeof urlStr !== "string") {
    throw new TossSdkSecurityError(`${paramName}이(가) 누락되었거나 유효하지 않습니다.`);
  }

  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Invalid protocol");
    }
    return parsed.toString();
  } catch {
    throw new TossSdkSecurityError(
      `${paramName}은(는) 올바른 절대 HTTP/HTTPS URL이어야 합니다. (입력값: ${urlStr})`
    );
  }
}

/**
 * Initiates the Toss Payments standard payment window (SDK V2).
 */
export async function requestTossPayment(options: TossCheckoutRequestOptions): Promise<void> {
  // 1. Strict test client key security validation
  assertTossTestClientKey(options.clientKey);

  // 2. Validate amount & order
  if (!Number.isInteger(options.amount) || options.amount <= 0) {
    throw new TossSdkSecurityError("결제 금액은 0보다 큰 정수여야 합니다.");
  }
  if (!options.orderId || options.orderId.trim().length === 0) {
    throw new TossSdkSecurityError("주문 번호(orderId)가 필요합니다.");
  }

  // 3. Validate successUrl & failUrl as absolute URLs
  const validatedSuccessUrl = assertAbsoluteHttpUrl(options.successUrl, "successUrl");
  const validatedFailUrl = assertAbsoluteHttpUrl(options.failUrl, "failUrl");

  // 4. Validate customerKey according to SDK V2 specification
  // In authenticated restroom checkout flow, customerKey is strictly required and cannot be bypassed with ANONYMOUS
  const customerKey = options.customerKey?.trim();
  if (!customerKey) {
    throw new TossSdkSecurityError(
      "customerKey가 누락되었습니다. 안심 제휴 결제는 인증된 고객의 customerKey(UUID)가 필수입니다."
    );
  }

  if (!TOSS_CUSTOMER_KEY_REGEX.test(customerKey)) {
    throw new TossSdkSecurityError(
      "customerKey 규격 오류: 영문 대소문자, 숫자, 특수문자(-, _, =, ., @) 22~255자 및 특수문자 1개 이상이 필수입니다."
    );
  }

  // 5. Load SDK
  const TossPayments = await loadTossPaymentsSdk();

  // 6. Initialize TossPayments instance with clientKey
  const tossPayments = TossPayments(options.clientKey);
  const payment = tossPayments.payment({ customerKey });

  // 7. Request standard card payment window (amount structure per SDK V2)
  await payment.requestPayment({
    method: "CARD",
    amount: {
      currency: "KRW",
      value: options.amount,
    },
    orderId: options.orderId,
    orderName: options.orderName,
    successUrl: validatedSuccessUrl,
    failUrl: validatedFailUrl,
    ...(options.customerEmail ? { customerEmail: options.customerEmail } : {}),
    ...(options.customerName ? { customerName: options.customerName } : {}),
  });
}
