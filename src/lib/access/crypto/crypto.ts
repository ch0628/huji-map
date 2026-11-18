/**
 * Node.js Server-only AES-256-GCM Doorlock PIN Encryption & Decryption Module
 * Spec: docs/07_PAYMENT_ACCESS_REFUND.md, docs/08_SECURITY_OPERATIONS.md,
 *       docs/11_DECISIONS.md, tasks/23_pin_storage.md
 * AGENTS.md Rules 8 & 10: PIN_ENCRYPTION_KEY is handled exclusively on server.
 * Never exposed to browser, console logs, git, or error messages.
 */

import crypto from "node:crypto";
import type { EncryptedPinPayload } from "./types";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12; // 96 bits standard for GCM
const AUTH_TAG_LENGTH_BYTES = 16; // 128 bits standard for GCM
const KEY_LENGTH_BYTES = 32; // 256 bits required for AES-256

export class PinCryptoError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 500) {
    super(message);
    this.name = "PinCryptoError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Loads and validates the 256-bit AES encryption key.
 * Strictly uses server-only environment variable PIN_ENCRYPTION_KEY
 * (with fallback check to PIN_ENCRYPTION_KEY_BASE64 from docs/10_CONFIG_AND_BLOCKERS.md).
 *
 * Invariant: Fails closed. NEVER falls back to hardcoded default keys.
 * Invariant: Never echoes or prints the key in error messages.
 */
export function getPinEncryptionKey(customKey?: string): {
  keyBuffer: Buffer;
  keyVersion: number;
} {
  // If in client browser environment, immediately block
  if (typeof window !== "undefined") {
    throw new PinCryptoError(
      "SECURITY_VIOLATION",
      "PIN 암호화 연산은 브라우저에서 수행할 수 없습니다.",
      500
    );
  }

  const rawKey =
    customKey ??
    process.env.PIN_ENCRYPTION_KEY ??
    process.env.PIN_ENCRYPTION_KEY_BASE64;

  if (!rawKey || typeof rawKey !== "string" || rawKey.trim().length === 0) {
    throw new PinCryptoError(
      "PIN_KEY_MISSING",
      "도어락 PIN 암호화키(PIN_ENCRYPTION_KEY) 설정이 필요합니다.",
      503
    );
  }

  const trimmed = rawKey.trim();
  let keyBuffer: Buffer;

  // Support 64 hex characters (32 bytes) or base64 (32 bytes) or raw 32-byte string
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    keyBuffer = Buffer.from(trimmed, "hex");
  } else if (/^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length >= 43 && trimmed.length <= 48) {
    keyBuffer = Buffer.from(trimmed, "base64");
  } else if (Buffer.byteLength(trimmed, "utf8") === KEY_LENGTH_BYTES) {
    keyBuffer = Buffer.from(trimmed, "utf8");
  } else {
    try {
      const b64Decoded = Buffer.from(trimmed, "base64");
      if (b64Decoded.length === KEY_LENGTH_BYTES) {
        keyBuffer = b64Decoded;
      } else {
        throw new Error("Invalid length");
      }
    } catch {
      throw new PinCryptoError(
        "INVALID_PIN_KEY_LENGTH",
        "도어락 PIN 암호화키는 정확히 256비트(32바이트)여야 합니다.",
        500
      );
    }
  }

  if (keyBuffer.length !== KEY_LENGTH_BYTES) {
    throw new PinCryptoError(
      "INVALID_PIN_KEY_LENGTH",
      "도어락 PIN 암호화키는 정확히 256비트(32바이트)여야 합니다.",
      500
    );
  }

  // Parse key version from environment or default to 1
  const rawVersion = process.env.PIN_KEY_VERSION;
  const keyVersion = rawVersion ? parseInt(rawVersion, 10) : 1;
  const validKeyVersion = Number.isInteger(keyVersion) && keyVersion > 0 ? keyVersion : 1;

  return { keyBuffer, keyVersion: validKeyVersion };
}

/**
 * Encrypts a plaintext PIN with AES-256-GCM.
 * Generates a cryptographically secure fresh random IV for every encryption call.
 * Returns Base64-encoded ciphertext, IV, and 16-byte auth tag.
 */
export function encryptPin(
  pin: string,
  options?: { key?: string; keyVersion?: number }
): EncryptedPinPayload {
  if (!pin || typeof pin !== "string" || pin.trim().length === 0) {
    throw new PinCryptoError("INVALID_PIN_INPUT", "암호화할 PIN이 비어 있습니다.", 400);
  }

  const { keyBuffer, keyVersion } = getPinEncryptionKey(options?.key);
  const version = options?.keyVersion ?? keyVersion;

  // Generate cryptographically secure random 12-byte IV
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);

  const cipher = crypto.createCipheriv(ALGORITHM, keyBuffer, iv, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });

  const ciphertext = Buffer.concat([
    cipher.update(pin.trim(), "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return {
    ciphertext_b64: ciphertext.toString("base64"),
    iv_b64: iv.toString("base64"),
    auth_tag_b64: authTag.toString("base64"),
    key_version: version,
  };
}

/**
 * Decrypts an encrypted PIN payload using AES-256-GCM.
 * Strictly verifies authentication tag; if tampered, throws safe integrity failure.
 */
export function decryptPin(
  payload: EncryptedPinPayload,
  options?: { key?: string }
): string {
  if (
    !payload ||
    !payload.ciphertext_b64 ||
    !payload.iv_b64 ||
    !payload.auth_tag_b64
  ) {
    throw new PinCryptoError(
      "INVALID_PAYLOAD",
      "암호문 페이로드 구조가 올바르지 않습니다.",
      400
    );
  }

  const { keyBuffer } = getPinEncryptionKey(options?.key);

  let ciphertext: Buffer;
  let iv: Buffer;
  let authTag: Buffer;

  try {
    ciphertext = Buffer.from(payload.ciphertext_b64, "base64");
    iv = Buffer.from(payload.iv_b64, "base64");
    authTag = Buffer.from(payload.auth_tag_b64, "base64");
  } catch {
    throw new PinCryptoError(
      "PAYLOAD_DECODE_FAILED",
      "Base64 페이로드 디코딩에 실패했습니다.",
      400
    );
  }

  if (iv.length !== IV_LENGTH_BYTES) {
    throw new PinCryptoError(
      "INVALID_IV_LENGTH",
      "초기화 벡터(IV)의 길이가 올바르지 않습니다.",
      400
    );
  }

  if (authTag.length !== AUTH_TAG_LENGTH_BYTES) {
    throw new PinCryptoError(
      "INVALID_AUTH_TAG_LENGTH",
      "인증 태그(Auth Tag)의 길이가 올바르지 않습니다.",
      400
    );
  }

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, keyBuffer, iv, {
      authTagLength: AUTH_TAG_LENGTH_BYTES,
    });

    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString("utf8");
  } catch (err: any) {
    // Defense in depth: Never reveal internal cipher details or stack traces to callers
    throw new PinCryptoError(
      "DECRYPTION_INTEGRITY_FAILED",
      "암호화 데이터가 변조되었거나 무결성 검증에 실패했습니다.",
      400
    );
  }
}

/**
 * Derives a dedicated 256-bit server-only HMAC key using RFC 5869 HKDF
 * from the master PIN_ENCRYPTION_KEY.
 *
 * Invariant: Never stores plaintext PIN or simple SHA-256(pin) in DB.
 * Invariant: Server-only derivation, domain-separated from AES cipher.
 */
export function getPinIdempotencyHmacKey(customKey?: string): Buffer {
  const { keyBuffer } = getPinEncryptionKey(customKey);
  const salt = Buffer.from("hujimap-pin-idempotency-salt-v1", "utf8");
  const info = Buffer.from("hujimap-pin-idempotency-hmac-key", "utf8");
  return Buffer.from(crypto.hkdfSync("sha256", keyBuffer, salt, info, KEY_LENGTH_BYTES));
}

/**
 * Computes a keyed HMAC-SHA256 of the PIN using the derived server secret.
 * Reversing this hash requires knowledge of the 256-bit server key,
 * preventing rainbow table attacks on low-entropy 4~8 digit PINs.
 */
export function computePinHmac(pin: string, customKey?: string): string {
  if (!pin || typeof pin !== "string" || pin.trim().length === 0) {
    throw new PinCryptoError("INVALID_PIN_INPUT", "HMAC을 계산할 PIN이 비어 있습니다.", 400);
  }
  const hmacKey = getPinIdempotencyHmacKey(customKey);
  const hmac = crypto.createHmac("sha256", hmacKey);
  hmac.update(pin.trim(), "utf8");
  return hmac.digest("base64");
}


