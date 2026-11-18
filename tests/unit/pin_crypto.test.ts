import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import {
  getPinEncryptionKey,
  encryptPin,
  decryptPin,
  PinCryptoError,
} from "@/lib/access/crypto";

describe("TASK 23 — Doorlock PIN AES-256-GCM Crypto Tests (T01 ~ T06)", () => {
  const originalEnv = process.env.PIN_ENCRYPTION_KEY;
  const originalVersion = process.env.PIN_KEY_VERSION;
  // Valid 256-bit (32 bytes) hex key (64 hex characters)
  const validHexKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  // Valid 256-bit (32 bytes) base64 key
  const validBase64Key = Buffer.from("0123456789abcdef0123456789abcdef", "utf8").toString("base64");

  beforeEach(() => {
    process.env.PIN_ENCRYPTION_KEY = validHexKey;
    process.env.PIN_KEY_VERSION = "1";
  });

  afterEach(() => {
    process.env.PIN_ENCRYPTION_KEY = originalEnv;
    process.env.PIN_KEY_VERSION = originalVersion;
  });

  it("T01: PIN 암호화 후 복호화 시 원본과 일치해야 한다", () => {
    const originalPin = "1234*#";
    const encrypted = encryptPin(originalPin);

    expect(encrypted.ciphertext_b64).toBeDefined();
    expect(encrypted.iv_b64).toBeDefined();
    expect(encrypted.auth_tag_b64).toBeDefined();
    expect(encrypted.key_version).toBe(1);

    const decrypted = decryptPin(encrypted);
    expect(decrypted).toBe(originalPin);
  });

  it("T01: 다양한 PIN 형식(숫자, 기호)도 원본과 일치하여 복호화된다", () => {
    const pins = ["0000", "12345678", "9876*", "*1234#", "999999999999"];
    for (const pin of pins) {
      const encrypted = encryptPin(pin);
      const decrypted = decryptPin(encrypted);
      expect(decrypted).toBe(pin);
    }
  });

  it("T02: 동일 PIN 반복 암호화 시 서로 다른 IV와 암호문이 생성되어야 한다", () => {
    const pin = "1234";
    const enc1 = encryptPin(pin);
    const enc2 = encryptPin(pin);
    const enc3 = encryptPin(pin);

    // Each IV must be unique
    expect(enc1.iv_b64).not.toBe(enc2.iv_b64);
    expect(enc2.iv_b64).not.toBe(enc3.iv_b64);
    expect(enc1.iv_b64).not.toBe(enc3.iv_b64);

    // Each ciphertext must be unique due to distinct IVs
    expect(enc1.ciphertext_b64).not.toBe(enc2.ciphertext_b64);
    expect(enc2.ciphertext_b64).not.toBe(enc3.ciphertext_b64);

    // All must decrypt to same original PIN
    expect(decryptPin(enc1)).toBe(pin);
    expect(decryptPin(enc2)).toBe(pin);
    expect(decryptPin(enc3)).toBe(pin);
  });

  it("T03: 암호문 변조 시 복호화가 안전하게 실패해야 한다", () => {
    const pin = "5678";
    const encrypted = encryptPin(pin);

    // Tamper ciphertext
    const rawCipher = Buffer.from(encrypted.ciphertext_b64, "base64");
    rawCipher[0] = rawCipher[0] ^ 0xff; // flip bits
    const tamperedPayload = {
      ...encrypted,
      ciphertext_b64: rawCipher.toString("base64"),
    };

    expect(() => decryptPin(tamperedPayload)).toThrow(PinCryptoError);
    expect(() => decryptPin(tamperedPayload)).toThrowError(/무결성 검증에 실패했습니다/);
  });

  it("T04: 인증 태그 변조 시 복호화가 안전하게 실패해야 한다", () => {
    const pin = "7890*";
    const encrypted = encryptPin(pin);

    // Tamper auth tag
    const rawTag = Buffer.from(encrypted.auth_tag_b64, "base64");
    rawTag[rawTag.length - 1] = rawTag[rawTag.length - 1] ^ 0x01;
    const tamperedPayload = {
      ...encrypted,
      auth_tag_b64: rawTag.toString("base64"),
    };

    expect(() => decryptPin(tamperedPayload)).toThrow(PinCryptoError);
    expect(() => decryptPin(tamperedPayload)).toThrowError(/무결성 검증에 실패했습니다/);
  });

  it("T05: PIN_ENCRYPTION_KEY 누락 시 안전 실패해야 한다", () => {
    delete process.env.PIN_ENCRYPTION_KEY;
    delete process.env.PIN_ENCRYPTION_KEY_BASE64;

    expect(() => getPinEncryptionKey()).toThrow(PinCryptoError);
    expect(() => encryptPin("1234")).toThrow(PinCryptoError);
    expect(() => encryptPin("1234")).toThrowError(/설정이 필요합니다/);
  });

  it("T06: 잘못된 길이의 암호화키(32바이트 미만/초과)는 거절되어야 한다", () => {
    // 16 bytes key (too short)
    process.env.PIN_ENCRYPTION_KEY = "1234567890123456";
    expect(() => getPinEncryptionKey()).toThrow(PinCryptoError);
    expect(() => getPinEncryptionKey()).toThrowError(/정확히 256비트/);

    // 40 bytes key (too long)
    process.env.PIN_ENCRYPTION_KEY = "1234567890123456789012345678901234567890";
    expect(() => getPinEncryptionKey()).toThrow(PinCryptoError);
    expect(() => getPinEncryptionKey()).toThrowError(/정확히 256비트/);

    // Invalid hex string
    process.env.PIN_ENCRYPTION_KEY = "not-a-valid-hex-or-base64-key";
    expect(() => getPinEncryptionKey()).toThrow(PinCryptoError);
  });

  it("T06: Base64 형식 32바이트 키도 정상 지원된다", () => {
    process.env.PIN_ENCRYPTION_KEY = validBase64Key;
    const { keyBuffer } = getPinEncryptionKey();
    expect(keyBuffer.length).toBe(32);

    const encrypted = encryptPin("1234");
    expect(decryptPin(encrypted)).toBe("1234");
  });

  it("보안 검증: 빈 PIN이나 유효하지 않은 입력은 거부되어야 한다", () => {
    expect(() => encryptPin("")).toThrow(PinCryptoError);
    expect(() => encryptPin("   ")).toThrow(PinCryptoError);
  });

  it("멱등성 보안: 서버 전용 HKDF 키 파생 및 PIN HMAC 계산 검증", async () => {
    const { getPinIdempotencyHmacKey, computePinHmac } = await import("@/lib/access/crypto");
    const hmacKey = getPinIdempotencyHmacKey();
    expect(hmacKey).toBeInstanceOf(Buffer);
    expect(hmacKey.length).toBe(32);

    const pin = "1234*#";
    const hmac1 = computePinHmac(pin);
    const hmac2 = computePinHmac(pin);
    expect(hmac1).toBe(hmac2);

    // Different PIN must produce different HMAC
    const diffHmac = computePinHmac("5678");
    expect(diffHmac).not.toBe(hmac1);

    // Simple SHA-256 is NOT identical to server-keyed HMAC (avoids rainbow table vulnerability)
    const simpleSha = crypto.createHash("sha256").update(pin).digest("base64");
    expect(hmac1).not.toBe(simpleSha);
  });
});

