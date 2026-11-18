/**
 * Toss Payments Configuration and Security Guards
 * Spec: docs/07_PAYMENT_ACCESS_REFUND.md, docs/08_SECURITY_OPERATIONS.md,
 *       docs/10_CONFIG_AND_BLOCKERS.md, docs/11_DECISIONS.md, AGENTS.md
 */

import { PAYMENT_MODE, type PaymentMode } from "./types";

export class PaymentConfigError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 503) {
    super(message);
    this.name = "PaymentConfigError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Returns current payment mode.
 * Defaults to 'disabled' per docs/07, docs/11.
 * Only 'test' is permitted for automated and QA payments.
 * 'live' is strictly forbidden by AGENTS.md Rule 4.
 */
export function getPaymentMode(): PaymentMode | "disabled" {
  const envMode = process.env.PAYMENT_MODE?.toLowerCase().trim();
  if (envMode === "live") {
    throw new PaymentConfigError(
      "SECURITY_VIOLATION_LIVE_MODE",
      "실거래 결제 모드(live)는 엄격히 금지되어 있습니다. AGENTS.md Rule 4를 준수하세요.",
      500
    );
  }
  if (envMode === "test") {
    return PAYMENT_MODE;
  }
  return "disabled";
}

export function isPaymentTestMode(): boolean {
  try {
    return getPaymentMode() === "test";
  } catch {
    return false;
  }
}

/**
 * Retrieves the Toss Payments test secret key.
 * Strictly checks that:
 * 1. It is never invoked or bundled on the client side (window check).
 * 2. It never starts with 'live_' (security guard).
 * 3. It starts with 'test_' (e.g. test_sk_ or test_gsk_).
 */
export function getTossTestSecretKey(): string | null {
  if (typeof window !== "undefined") {
    throw new PaymentConfigError(
      "SECURITY_VIOLATION_CLIENT_SECRET",
      "시크릿 키는 클라이언트 브라우저에서 절대 접근할 수 없습니다.",
      500
    );
  }

  const secretKey = process.env.TOSS_TEST_SECRET_KEY?.trim();
  if (!secretKey) {
    return null;
  }

  if (secretKey.startsWith("live_")) {
    throw new PaymentConfigError(
      "SECURITY_VIOLATION_LIVE_SECRET_KEY",
      "TOSS 실거래 시크릿 키(live_)는 사용할 수 없습니다. 테스트 키(test_)를 사용하세요.",
      500
    );
  }

  if (!secretKey.startsWith("test_")) {
    throw new PaymentConfigError(
      "INVALID_TEST_SECRET_KEY_FORMAT",
      "유효하지 않은 토스 테스트 시크릿 키입니다. 'test_'로 시작해야 합니다.",
      500
    );
  }

  return secretKey;
}

/**
 * Retrieves the public Toss Payments test client key.
 * Used by client SDKs. Must start with 'test_'.
 */
export function getTossTestClientKey(): string | null {
  const clientKey = process.env.NEXT_PUBLIC_TOSS_TEST_CLIENT_KEY?.trim();
  if (!clientKey) {
    return null;
  }

  if (clientKey.startsWith("live_")) {
    throw new PaymentConfigError(
      "SECURITY_VIOLATION_LIVE_CLIENT_KEY",
      "TOSS 실거래 클라이언트 키(live_)는 사용할 수 없습니다.",
      500
    );
  }

  return clientKey;
}

/**
 * Returns true if payment test mode is enabled and a valid test secret key is present.
 */
export function isTossPaymentConfigured(): boolean {
  if (!isPaymentTestMode()) {
    return false;
  }
  const key = getTossTestSecretKey();
  return Boolean(key);
}

/**
 * Asserts that payment test mode is properly configured.
 * Throws a safe 503 error if keys are absent or mode is disabled.
 */
export function assertPaymentTestModeAllowed(): string {
  if (!isPaymentTestMode()) {
    throw new PaymentConfigError(
      "PAYMENT_MODE_DISABLED",
      "결제 기능 준비 중입니다. (PAYMENT_MODE=disabled)",
      503
    );
  }

  const secretKey = getTossTestSecretKey();
  if (!secretKey) {
    throw new PaymentConfigError(
      "TOSS_CONFIG_REQUIRED",
      "토스페이먼츠 연동 설정이 필요합니다. TOSS_TEST_SECRET_KEY를 확인하세요.",
      503
    );
  }

  return secretKey;
}

