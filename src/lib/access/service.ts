/**
 * Customer Doorlock PIN Reveal Service
 * Spec: docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/07_PAYMENT_ACCESS_REFUND.md,
 *       docs/08_SECURITY_OPERATIONS.md, tasks/24_pin_reveal.md
 *
 * Invariant: Plaintext PIN is NEVER stored in database, logs, or analytics.
 * Invariant: Never reveals PIN unless authenticated user, valid access session,
 *            server-confirmed test payment order, unexpired time, and partner PIN restroom.
 * Invariant: Decrypts AES-256-GCM only in server memory for verified customer.
 */

import { createAdminClient, isServiceRoleConfigured } from "@/lib/supabase/server";
import { decryptPin, PinCryptoError } from "./crypto";
import {
  AccessPinServiceError,
  type RevealPinResponse,
} from "./types";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates access session authorization, checks payment status and restroom policy,
 * transitions access state to 'code_revealed', records audit log,
 * and decrypts the active doorlock PIN for the customer.
 */
export async function revealCustomerPin(params: {
  accessSessionId: string;
  userId: string;
  requestId: string;
}): Promise<RevealPinResponse> {
  const { accessSessionId, userId, requestId } = params;

  // 1. UUID format validation
  if (!accessSessionId || !UUID_REGEX.test(accessSessionId)) {
    throw new AccessPinServiceError(
      "VALIDATION_ERROR",
      "유효한 이용권 UUID가 아닙니다.",
      400
    );
  }

  if (!userId || !UUID_REGEX.test(userId)) {
    throw new AccessPinServiceError(
      "UNAUTHENTICATED",
      "로그인이 필요한 서비스입니다.",
      401
    );
  }

  // 2. Server configuration check
  if (!isServiceRoleConfigured()) {
    throw new AccessPinServiceError(
      "CONFIG_REQUIRED",
      "서버 DB 보안 서비스 설정이 필요합니다.",
      503
    );
  }

  // 3. Execute atomic database validation and reveal RPC
  const adminClient = createAdminClient() as any;

  const { data, error } = await adminClient.rpc("reveal_access_pin", {
    p_access_session_id: accessSessionId,
    p_caller_user_id: userId,
    p_request_id: requestId,
  });

  if (error) {
    throw new AccessPinServiceError(
      "DATABASE_ERROR",
      "이용권 확인 중 데이터베이스 오류가 발생했습니다.",
      500
    );
  }

  const result = (typeof data === "string" ? JSON.parse(data) : data) as {
    ok: boolean;
    error_code?: string;
    message?: string;
    status?: number;
    secret_id?: string;
    ciphertext_b64?: string;
    iv_b64?: string;
    auth_tag_b64?: string;
    key_version?: number;
    code_version?: number;
    expires_at?: string;
    restroom_id?: string;
  };

  if (!result || !result.ok) {
    const errorCode = result?.error_code || "ACCESS_DENIED";
    const errorMessage = result?.message || "도어락 PIN을 조회할 수 없습니다.";
    const statusCode = result?.status || 403;

    throw new AccessPinServiceError(
      errorCode,
      errorMessage,
      statusCode,
      errorCode
    );
  }

  // 4. Decrypt PIN using server-only AES-256-GCM
  let plainPin: string;
  try {
    plainPin = decryptPin({
      ciphertext_b64: result.ciphertext_b64!,
      iv_b64: result.iv_b64!,
      auth_tag_b64: result.auth_tag_b64!,
      key_version: result.key_version ?? 1,
    });
  } catch (decryptErr: any) {
    // Record decryption failure in audit trail
    try {
      await adminClient.rpc("record_pin_reveal_audit", {
        p_access_session_id: accessSessionId,
        p_caller_user_id: userId,
        p_restroom_id: result.restroom_id ?? null,
        p_code_version: result.code_version ?? null,
        p_result: "error",
        p_reason: "decryption_failed",
        p_request_id: requestId,
      });
    } catch {
      // Best-effort audit on decryption failure
    }

    if (decryptErr instanceof PinCryptoError) {
      if (decryptErr.code === "PIN_KEY_MISSING") {
        throw new AccessPinServiceError(
          decryptErr.code,
          decryptErr.message,
          decryptErr.statusCode,
          decryptErr.code
        );
      }
      throw new AccessPinServiceError(
        "DECRYPTION_FAILED",
        "도어락 PIN 복호화 무결성 검증에 실패했습니다.",
        500,
        "decryption_failed"
      );
    }

    throw new AccessPinServiceError(
      "DECRYPTION_FAILED",
      "도어락 PIN 복호화 무결성 검증에 실패했습니다.",
      500,
      "decryption_failed"
    );
  }

  // 5. Confirm reveal in database AFTER decryption success
  // Atomically re-verifies active PIN secret, session status, expiration, and payment
  const { data: confirmData, error: confirmError } = await adminClient.rpc(
    "confirm_pin_revealed",
    {
      p_access_session_id: accessSessionId,
      p_caller_user_id: userId,
      p_restroom_id: result.restroom_id ?? null,
      p_code_version: result.code_version ?? 1,
      p_secret_id: result.secret_id ?? null,
      p_request_id: requestId,
    }
  );

  if (confirmError) {
    throw new AccessPinServiceError(
      "DATABASE_ERROR",
      "이용 상태 갱신 중 데이터베이스 오류가 발생했습니다.",
      500
    );
  }

  const confirmResult = (
    typeof confirmData === "string" ? JSON.parse(confirmData) : confirmData
  ) as {
    ok: boolean;
    error_code?: string;
    message?: string;
    status?: number;
  };

  if (!confirmResult || !confirmResult.ok) {
    const errorCode = confirmResult?.error_code || "CONFIRMATION_FAILED";
    const errorMessage =
      confirmResult?.message || "도어락 PIN 조회를 확정할 수 없습니다.";
    const statusCode = confirmResult?.status || 409;

    throw new AccessPinServiceError(
      errorCode,
      errorMessage,
      statusCode,
      errorCode
    );
  }

  // 6. Return strictly sanitized response
  // Invariant: Never return ciphertext_b64, iv_b64, auth_tag_b64, or keys
  return {
    ok: true,
    pin: plainPin,
    codeVersion: result.code_version!,
    expiresAt: result.expires_at!,
    requestId,
  };
}
