/**
 * Doorlock PIN Storage & Rotation Service
 * Spec: docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/07_PAYMENT_ACCESS_REFUND.md,
 *       docs/08_SECURITY_OPERATIONS.md, tasks/23_pin_storage.md
 */

import { createAdminClient, isServiceRoleConfigured } from "@/lib/supabase/server";
import { encryptPin, computePinHmac, PinCryptoError } from "./crypto";
import { setRestroomPinSchema, type SetPinResponse } from "./types";

export class RestroomPinServiceError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "RestroomPinServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Validates, encrypts, and atomically stores or rotates a doorlock PIN
 * for an approved partner restroom with database-backed persistent idempotency.
 *
 * Invariant: Never logs or stores plaintext PIN.
 * Invariant: Never includes PIN, ciphertext, IV, auth_tag, or keys in response.
 * Invariant: Replays previous code_version on same idempotency_key without creating new version.
 */
export async function setOrRotateRestroomPin(params: {
  restroomId: string;
  userId: string;
  pin: string;
  requestId: string;
  idempotencyKey?: string | null;
}): Promise<SetPinResponse & { action?: string }> {
  const { restroomId, userId, pin, requestId, idempotencyKey } = params;

  // 1. Zod input validation
  const validationResult = setRestroomPinSchema.safeParse({ pin });
  if (!validationResult.success) {
    const firstIssue = validationResult.error.issues[0];
    throw new RestroomPinServiceError(
      "VALIDATION_ERROR",
      firstIssue ? firstIssue.message : "올바른 PIN 형식이 아닙니다.",
      400
    );
  }
  const validatedPin = validationResult.data.pin;

  // 2. UUID format check
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(restroomId)) {
    throw new RestroomPinServiceError(
      "VALIDATION_ERROR",
      "유효한 화장실 UUID가 아닙니다.",
      400
    );
  }
  if (!uuidRegex.test(userId)) {
    throw new RestroomPinServiceError(
      "UNAUTHENTICATED",
      "유효한 사용자 인증이 필요합니다.",
      401
    );
  }

  // 2-B. Idempotency key validation: reject empty or whitespace-only keys
  let cleanIdempotencyKey: string | null = null;
  if (idempotencyKey !== undefined && idempotencyKey !== null) {
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
      throw new RestroomPinServiceError(
        "VALIDATION_ERROR",
        "Idempotency-Key는 비어 있거나 공백만으로 구성될 수 없습니다.",
        400
      );
    }
    cleanIdempotencyKey = idempotencyKey.trim();
  }

  // 3. Verify server environment configuration
  if (!isServiceRoleConfigured()) {
    throw new RestroomPinServiceError(
      "CONFIG_REQUIRED",
      "서버 DB 보안 서비스 설정이 필요합니다.",
      503
    );
  }

  // 4. Encrypt PIN using server-only AES-256-GCM
  let encryptedPayload;
  try {
    encryptedPayload = encryptPin(validatedPin);
  } catch (err: any) {
    if (err instanceof PinCryptoError) {
      throw new RestroomPinServiceError(err.code, err.message, err.statusCode);
    }
    throw new RestroomPinServiceError(
      "ENCRYPTION_FAILED",
      "도어락 PIN 암호화 처리에 실패했습니다.",
      500
    );
  }

  // 5. Compute server-derived PIN HMAC for persistent DB idempotency comparison
  // Invariant: Never store plaintext PIN or simple SHA-256(pin) in persistent database
  let pinHmac: string | null = null;
  if (cleanIdempotencyKey) {
    try {
      pinHmac = computePinHmac(validatedPin);
    } catch (err: any) {
      if (err instanceof PinCryptoError) {
        throw new RestroomPinServiceError(err.code, err.message, err.statusCode);
      }
      throw new RestroomPinServiceError(
        "HMAC_FAILED",
        "도어락 PIN 멱등성 검증 해시 처리에 실패했습니다.",
        500
      );
    }
  }

  // 6. Execute atomic database RPC using service_role admin client
  const adminClient = createAdminClient() as any;

  const { data, error } = await adminClient.rpc("rotate_restroom_pin", {
    p_restroom_id: restroomId,
    p_caller_user_id: userId,
    p_ciphertext_b64: encryptedPayload.ciphertext_b64,
    p_iv_b64: encryptedPayload.iv_b64,
    p_auth_tag_b64: encryptedPayload.auth_tag_b64,
    p_key_version: encryptedPayload.key_version,
    p_idempotency_key: cleanIdempotencyKey,
    p_pin_hmac_b64: pinHmac,
  });

  if (error) {
    const errorMsg = error.message || "";

    if (errorMsg.includes("HM081") || errorMsg.includes("HM086")) {
      throw new RestroomPinServiceError(
        "RESTROOM_NOT_FOUND",
        "화장실을 찾을 수 없습니다.",
        404
      );
    }

    if (errorMsg.includes("HM082") || errorMsg.includes("HM087")) {
      throw new RestroomPinServiceError(
        "FORBIDDEN_PUBLIC_RESTROOM",
        "공공 화장실 또는 제휴되지 않은 화장실에는 PIN을 등록할 수 없습니다.",
        403
      );
    }

    if (errorMsg.includes("HM084")) {
      throw new RestroomPinServiceError(
        "USER_NOT_FOUND",
        "사용자 프로필을 찾을 수 없습니다.",
        404
      );
    }

    if (errorMsg.includes("HM085")) {
      throw new RestroomPinServiceError(
        "ACCOUNT_SUSPENDED",
        "정지되었거나 비활성 상태인 계정은 PIN을 등록할 수 없습니다.",
        403
      );
    }

    if (errorMsg.includes("HM088")) {
      throw new RestroomPinServiceError(
        "MEMBERSHIP_REQUIRED",
        "해당 화장실이 속한 승인된 가게의 관리 권한이 없습니다.",
        403
      );
    }

    if (errorMsg.includes("HM089") || errorMsg.includes("HM090") || errorMsg.includes("HM093")) {
      throw new RestroomPinServiceError(
        "VALIDATION_ERROR",
        "요청 데이터 또는 암호화 페이로드 형식이 올바르지 않습니다.",
        400
      );
    }

    if (errorMsg.includes("HM091") || errorMsg.includes("HM092")) {
      throw new RestroomPinServiceError(
        "IDEMPOTENCY_CONFLICT",
        "동일한 Idempotency-Key로 다른 요청 본문이 전송되었거나 다른 리소스에 사용되었습니다.",
        409
      );
    }

    // Default error mapping
    throw new RestroomPinServiceError(
      "PIN_ROTATION_FAILED",
      "도어락 PIN 등록 및 교체 작업에 실패했습니다.",
      500
    );
  }

  // 7. Return strictly safe response without sensitive data
  const resultData = (typeof data === "string" ? JSON.parse(data) : data) as {
    code_version: number;
    valid_from: string;
    action?: string;
  };

  return {
    ok: true,
    codeVersion: resultData.code_version,
    updatedAt: resultData.valid_from,
    requestId,
    action: resultData.action,
  };
}
