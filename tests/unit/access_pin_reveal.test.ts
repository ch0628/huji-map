/**
 * Unit & Security Route Tests for TASK 24 Customer Doorlock PIN Reveal API
 * Tests T01 - T20:
 *   [정상 테스트]
 *   T01. 인증된 고객 + 유효한 이용 권한 → 정상 PIN 반환
 *   T02. 정상 PIN 복호화 → 기존 TASK 23 암호화 데이터와 일치
 *   T03. PIN 버전 변경 후 조회 → 현재 활성 PIN만 반환
 *   [인증 및 권한 테스트]
 *   T04. 비로그인 사용자 → 거부 (401)
 *   T05. 다른 고객의 이용 세션 → 거부 (403)
 *   T06. 정지된 사용자 → 거부 (403)
 *   T07. 결제 미완료 → 거부 (422)
 *   T08. 결제 취소·환불 → 거부 (422)
 *   T09. 이용 기간 만료 → 거부 (422)
 *   T10. 권한 없는 점주/관리자 → 고객용 조회 권한 우회 불가 (403)
 *   [PIN 상태 테스트]
 *   T11. 활성 PIN 없음 → 안전 실패 (404)
 *   T12. 폐기 또는 교체된 PIN → 반환 금지
 *   T13. 공공화장실 또는 PIN 미사용 화장실 → 거부 (400)
 *   T14. 암호화 키 누락 → 안전 실패 (503)
 *   T15. 암호문 또는 인증 태그 변조 → 복호화 거부 (500)
 *   [보안 테스트]
 *   T16. 응답 Cache-Control: private, no-store 확인
 *   T17. 권한 없는 응답에 PIN 비노출
 *   T18. 감사로그에 PIN 평문·암호문 비노출
 *   T19. 클라이언트 제공 결제 성공 정보로 서버 측 결제 상태 검증을 우회할 수 없음
 *   T20. 동시 PIN 교체와 PIN 조회 시 비활성 PIN 노출 여부 검증
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST as handleRevealPin } from "@/app/api/v1/access/[id]/reveal-pin/route";
import * as authLib from "@/lib/auth";
import * as supabaseServer from "@/lib/supabase/server";
import { encryptPin, decryptPin } from "@/lib/access/crypto";
import { resetRateLimits } from "@/lib/events/rate-limiter";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof authLib>();
  return {
    ...actual,
    requireAuth: vi.fn(),
    isSupabaseAuthConfigured: vi.fn().mockReturnValue(true),
  };
});

vi.mock("@/lib/supabase/server", async (importOriginal) => {
  const actual = await importOriginal<typeof supabaseServer>();
  return {
    ...actual,
    createServerClientInstance: vi.fn().mockResolvedValue({}),
    createAdminClient: vi.fn(),
    isServiceRoleConfigured: vi.fn().mockReturnValue(true),
  };
});

describe("TASK 24 — Customer Doorlock PIN Reveal API (T01 - T20)", () => {
  const validAccessSessionId = "11111111-1111-4111-8111-111111111111";
  const customerUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const otherUserId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const testRestroomId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  const validHexKey =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const originalEnvKey = process.env.PIN_ENCRYPTION_KEY;
  const originalEnvVersion = process.env.PIN_KEY_VERSION;

  let mockRpc: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
    process.env.PIN_ENCRYPTION_KEY = validHexKey;
    process.env.PIN_KEY_VERSION = "1";

    mockRpc = vi.fn().mockImplementation(async (rpcName: string, params: any) => {
      if (rpcName === "confirm_pin_revealed") {
        return { data: { ok: true, code_version: params.p_code_version }, error: null };
      }
      if (rpcName === "record_pin_reveal_audit") {
        return { data: "mock-audit-id", error: null };
      }
      return { data: null, error: null };
    });
    vi.mocked(supabaseServer.createAdminClient).mockReturnValue({
      rpc: mockRpc,
    } as any);

    // Default mock: valid customer authenticated
    vi.mocked(authLib.requireAuth).mockResolvedValue({
      user: { id: customerUserId, email: "customer@test.com" } as any,
      roles: ["customer"],
      isAdmin: false,
      isMerchant: false,
      displayName: "테스트고객",
      accountStatus: "active",
      profileExists: true,
      sessionExpired: false,
      configReady: true,
    });
  });

  afterEach(() => {
    process.env.PIN_ENCRYPTION_KEY = originalEnvKey;
    process.env.PIN_KEY_VERSION = originalEnvVersion;
  });

  // ==========================================================================
  // [정상 테스트] T01 - T03
  // ==========================================================================

  it("T01: 인증된 고객 + 유효한 이용 권한 → 정상 PIN 반환", async () => {
    const rawPin = "1234#";
    const encrypted = encryptPin(rawPin);

    mockRpc.mockResolvedValueOnce({
      data: {
        ok: true,
        ciphertext_b64: encrypted.ciphertext_b64,
        iv_b64: encrypted.iv_b64,
        auth_tag_b64: encrypted.auth_tag_b64,
        key_version: encrypted.key_version,
        code_version: 1,
        expires_at: "2026-11-15T12:00:00.000Z",
        restroom_id: testRestroomId,
      },
      error: null,
    });

    const req = new Request(
      `http://localhost:3000/api/v1/access/${validAccessSessionId}/reveal-pin`,
      { method: "POST" }
    );
    const res = await handleRevealPin(req, {
      params: Promise.resolve({ id: validAccessSessionId }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.pin).toBe("1234#");
    expect(body.codeVersion).toBe(1);
    expect(body.expiresAt).toBe("2026-11-15T12:00:00.000Z");
    expect(body.requestId).toBeDefined();

    // Verify sensitive encryption artifacts are NOT leaked
    expect(body.ciphertext_b64).toBeUndefined();
    expect(body.iv_b64).toBeUndefined();
    expect(body.auth_tag_b64).toBeUndefined();
    expect(body.key_version).toBeUndefined();

    // Verify confirm_pin_revealed RPC was called after successful decryption
    expect(mockRpc).toHaveBeenCalledWith("confirm_pin_revealed", {
      p_access_session_id: validAccessSessionId,
      p_caller_user_id: customerUserId,
      p_restroom_id: testRestroomId,
      p_code_version: 1,
      p_secret_id: null,
      p_request_id: expect.any(String),
    });
  });

  it("T02: 정상 PIN 복호화 → 기존 TASK 23 암호화 데이터와 일치", () => {
    const testSecret = "9876*";
    const encrypted = encryptPin(testSecret);
    const decrypted = decryptPin(encrypted);

    expect(decrypted).toBe(testSecret);
  });

  it("T03: PIN 버전 변경 후 조회 → 현재 활성 PIN만 반환", async () => {
    // Version 2 active pin
    const version2Pin = "5555#";
    const encryptedV2 = encryptPin(version2Pin);

    mockRpc.mockResolvedValueOnce({
      data: {
        ok: true,
        ciphertext_b64: encryptedV2.ciphertext_b64,
        iv_b64: encryptedV2.iv_b64,
        auth_tag_b64: encryptedV2.auth_tag_b64,
        key_version: encryptedV2.key_version,
        code_version: 2,
        expires_at: "2026-11-15T12:00:00.000Z",
        restroom_id: testRestroomId,
      },
      error: null,
    });

    const req = new Request(
      `http://localhost:3000/api/v1/access/${validAccessSessionId}/reveal-pin`,
      { method: "POST" }
    );
    const res = await handleRevealPin(req, {
      params: Promise.resolve({ id: validAccessSessionId }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.pin).toBe("5555#");
    expect(body.codeVersion).toBe(2);
  });

  // ==========================================================================
  // [인증 및 권한 테스트] T04 - T10
  // ==========================================================================

  it("T04: 비로그인 사용자 → 거부 (401)", async () => {
    vi.mocked(authLib.requireAuth).mockRejectedValueOnce(
      new authLib.AuthGuardError("UNAUTHORIZED", 401, "로그인이 필요한 기능입니다.")
    );

    const req = new Request(
      `http://localhost:3000/api/v1/access/${validAccessSessionId}/reveal-pin`,
      { method: "POST" }
    );
    const res = await handleRevealPin(req, {
      params: Promise.resolve({ id: validAccessSessionId }),
    });
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.pin).toBeUndefined();
  });

  it("T05: 다른 고객의 이용 세션 → 거부 (403)", async () => {
    // RPC returns ownership mismatch
    mockRpc.mockResolvedValueOnce({
      data: {
        ok: false,
        error_code: "FORBIDDEN",
        message: "해당 화장실 이용권의 도어락 PIN 조회 권한이 없습니다.",
        status: 403,
      },
      error: null,
    });

    const req = new Request(
      `http://localhost:3000/api/v1/access/${validAccessSessionId}/reveal-pin`,
      { method: "POST" }
    );
    const res = await handleRevealPin(req, {
      params: Promise.resolve({ id: validAccessSessionId }),
    });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.pin).toBeUndefined();
  });

  it("T06: 정지된 사용자 → 거부 (403)", async () => {
    vi.mocked(authLib.requireAuth).mockRejectedValueOnce(
      new authLib.AuthGuardError("ACCOUNT_SUSPENDED", 403, "현재 이용이 제한된 계정입니다.")
    );

    const req = new Request(
      `http://localhost:3000/api/v1/access/${validAccessSessionId}/reveal-pin`,
      { method: "POST" }
    );
    const res = await handleRevealPin(req, {
      params: Promise.resolve({ id: validAccessSessionId }),
    });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("ACCOUNT_SUSPENDED");
    expect(body.pin).toBeUndefined();
  });

  it("T07: 결제 미완료 → 거부 (422)", async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        ok: false,
        error_code: "PAYMENT_REQUIRED",
        message: "결제가 완료되지 않은 이용권입니다.",
        status: 422,
      },
      error: null,
    });

    const req = new Request(
      `http://localhost:3000/api/v1/access/${validAccessSessionId}/reveal-pin`,
      { method: "POST" }
    );
    const res = await handleRevealPin(req, {
      params: Promise.resolve({ id: validAccessSessionId }),
    });
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("PAYMENT_REQUIRED");
    expect(body.pin).toBeUndefined();
  });

  it("T08: 결제 취소·환불 → 거부 (422)", async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        ok: false,
        error_code: "ACCESS_CANCELED",
        message: "취소되었거나 환불된 이용권입니다.",
        status: 422,
      },
      error: null,
    });

    const req = new Request(
      `http://localhost:3000/api/v1/access/${validAccessSessionId}/reveal-pin`,
      { method: "POST" }
    );
    const res = await handleRevealPin(req, {
      params: Promise.resolve({ id: validAccessSessionId }),
    });
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("ACCESS_CANCELED");
    expect(body.pin).toBeUndefined();
  });

  it("T09: 이용 기간 만료 → 거부 (422)", async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        ok: false,
        error_code: "ACCESS_EXPIRED",
        message: "화장실 이용권의 유효 시간이 만료되었습니다.",
        status: 422,
      },
      error: null,
    });

    const req = new Request(
      `http://localhost:3000/api/v1/access/${validAccessSessionId}/reveal-pin`,
      { method: "POST" }
    );
    const res = await handleRevealPin(req, {
      params: Promise.resolve({ id: validAccessSessionId }),
    });
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("ACCESS_EXPIRED");
    expect(body.pin).toBeUndefined();
  });

  it("T10: 권한 없는 점주/관리자 → 고객용 조회 권한 우회 불가 (403)", async () => {
    // Authenticated user is admin, but not the session owner
    vi.mocked(authLib.requireAuth).mockResolvedValueOnce({
      user: { id: otherUserId, email: "admin@test.com" } as any,
      roles: ["admin"],
      isAdmin: true,
      isMerchant: false,
      displayName: "관리자",
      accountStatus: "active",
      profileExists: true,
      sessionExpired: false,
      configReady: true,
    });

    mockRpc.mockResolvedValueOnce({
      data: {
        ok: false,
        error_code: "FORBIDDEN",
        message: "해당 화장실 이용권의 도어락 PIN 조회 권한이 없습니다.",
        status: 403,
      },
      error: null,
    });

    const req = new Request(
      `http://localhost:3000/api/v1/access/${validAccessSessionId}/reveal-pin`,
      { method: "POST" }
    );
    const res = await handleRevealPin(req, {
      params: Promise.resolve({ id: validAccessSessionId }),
    });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.pin).toBeUndefined();
  });

  // ==========================================================================
  // [PIN 상태 테스트] T11 - T15
  // ==========================================================================

  it("T11: 활성 PIN 없음 → 안전 실패 (404)", async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        ok: false,
        error_code: "PIN_NOT_AVAILABLE",
        message: "현재 유효한 활성 도어락 PIN이 등록되어 있지 않습니다.",
        status: 404,
      },
      error: null,
    });

    const req = new Request(
      `http://localhost:3000/api/v1/access/${validAccessSessionId}/reveal-pin`,
      { method: "POST" }
    );
    const res = await handleRevealPin(req, {
      params: Promise.resolve({ id: validAccessSessionId }),
    });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("PIN_NOT_AVAILABLE");
    expect(body.pin).toBeUndefined();
  });

  it("T12: 폐기 또는 교체된 PIN → 반환 금지 (RPC에서 active만 조회)", async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        ok: false,
        error_code: "PIN_NOT_AVAILABLE",
        message: "현재 유효한 활성 도어락 PIN이 등록되어 있지 않습니다.",
        status: 404,
      },
      error: null,
    });

    const req = new Request(
      `http://localhost:3000/api/v1/access/${validAccessSessionId}/reveal-pin`,
      { method: "POST" }
    );
    const res = await handleRevealPin(req, {
      params: Promise.resolve({ id: validAccessSessionId }),
    });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.pin).toBeUndefined();
  });

  it("T13: 공공화장실 또는 PIN 미사용 화장실 → 거부 (400)", async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        ok: false,
        error_code: "PIN_NOT_SUPPORTED",
        message: "도어락 PIN 출입 방식을 사용하지 않는 화장실입니다.",
        status: 400,
      },
      error: null,
    });

    const req = new Request(
      `http://localhost:3000/api/v1/access/${validAccessSessionId}/reveal-pin`,
      { method: "POST" }
    );
    const res = await handleRevealPin(req, {
      params: Promise.resolve({ id: validAccessSessionId }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("PIN_NOT_SUPPORTED");
    expect(body.pin).toBeUndefined();
  });

  it("T14: 암호화 키 누락 → 안전 실패 (503)", async () => {
    delete process.env.PIN_ENCRYPTION_KEY;
    delete process.env.PIN_ENCRYPTION_KEY_BASE64;

    mockRpc.mockResolvedValueOnce({
      data: {
        ok: true,
        ciphertext_b64: "some-ciphertext",
        iv_b64: "some-iv-b64=",
        auth_tag_b64: "some-tag-b64=",
        key_version: 1,
        code_version: 1,
        expires_at: "2026-11-15T12:00:00.000Z",
        restroom_id: testRestroomId,
      },
      error: null,
    });

    const req = new Request(
      `http://localhost:3000/api/v1/access/${validAccessSessionId}/reveal-pin`,
      { method: "POST" }
    );
    const res = await handleRevealPin(req, {
      params: Promise.resolve({ id: validAccessSessionId }),
    });
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("PIN_KEY_MISSING");
    expect(body.pin).toBeUndefined();
  });

  it("T15: 암호문 또는 인증 태그 변조 → 복호화 거부 (500)", async () => {
    const encrypted = encryptPin("1234");
    // Tamper with the auth tag
    const tamperedTag = Buffer.from(encrypted.auth_tag_b64, "base64");
    tamperedTag[0] ^= 0xff;

    mockRpc.mockResolvedValueOnce({
      data: {
        ok: true,
        ciphertext_b64: encrypted.ciphertext_b64,
        iv_b64: encrypted.iv_b64,
        auth_tag_b64: tamperedTag.toString("base64"),
        key_version: 1,
        code_version: 1,
        expires_at: "2026-11-15T12:00:00.000Z",
        restroom_id: testRestroomId,
      },
      error: null,
    });

    const req = new Request(
      `http://localhost:3000/api/v1/access/${validAccessSessionId}/reveal-pin`,
      { method: "POST" }
    );
    const res = await handleRevealPin(req, {
      params: Promise.resolve({ id: validAccessSessionId }),
    });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("DECRYPTION_FAILED");
    expect(body.pin).toBeUndefined();

    // Verify confirm_pin_revealed was NOT called when decryption failed
    expect(mockRpc).not.toHaveBeenCalledWith("confirm_pin_revealed", expect.anything());

    // Verify error audit log was recorded
    expect(mockRpc).toHaveBeenCalledWith("record_pin_reveal_audit", expect.objectContaining({
      p_access_session_id: validAccessSessionId,
      p_caller_user_id: customerUserId,
      p_result: "error",
      p_reason: "decryption_failed",
    }));
  });

  it("T21: 복호화 실패 시 confirm_pin_revealed 미호출 및 오류 감사로그만 기록 (세션 상태 불변 보장)", async () => {
    // Return corrupted payload from RPC
    mockRpc.mockResolvedValueOnce({
      data: {
        ok: true,
        ciphertext_b64: "invalid-cipher-base64",
        iv_b64: "aXZfY3Jvc3NfYg==",
        auth_tag_b64: "dGFnX2Nyb3NzX2I=",
        key_version: 1,
        code_version: 1,
        expires_at: "2026-11-15T12:00:00.000Z",
        restroom_id: testRestroomId,
      },
      error: null,
    });

    const req = new Request(
      `http://localhost:3000/api/v1/access/${validAccessSessionId}/reveal-pin`,
      { method: "POST" }
    );
    const res = await handleRevealPin(req, {
      params: Promise.resolve({ id: validAccessSessionId }),
    });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("DECRYPTION_FAILED");

    // Must NOT call confirm_pin_revealed
    expect(mockRpc).not.toHaveBeenCalledWith("confirm_pin_revealed", expect.anything());

    // Must record error audit
    expect(mockRpc).toHaveBeenCalledWith("record_pin_reveal_audit", {
      p_access_session_id: validAccessSessionId,
      p_caller_user_id: customerUserId,
      p_restroom_id: testRestroomId,
      p_code_version: 1,
      p_result: "error",
      p_reason: "decryption_failed",
      p_request_id: expect.any(String),
    });
  });

  // ==========================================================================
  // [보안 테스트] T16 - T20
  // ==========================================================================

  it("T16: 응답 Cache-Control: private, no-store 확인", async () => {
    const encrypted = encryptPin("1234#");

    mockRpc.mockResolvedValueOnce({
      data: {
        ok: true,
        ciphertext_b64: encrypted.ciphertext_b64,
        iv_b64: encrypted.iv_b64,
        auth_tag_b64: encrypted.auth_tag_b64,
        key_version: encrypted.key_version,
        code_version: 1,
        expires_at: "2026-11-15T12:00:00.000Z",
        restroom_id: testRestroomId,
      },
      error: null,
    });

    const req = new Request(
      `http://localhost:3000/api/v1/access/${validAccessSessionId}/reveal-pin`,
      { method: "POST" }
    );
    const res = await handleRevealPin(req, {
      params: Promise.resolve({ id: validAccessSessionId }),
    });

    const cacheControl = res.headers.get("Cache-Control");
    expect(cacheControl).toBeDefined();
    expect(cacheControl).toContain("private");
    expect(cacheControl).toContain("no-store");
  });

  it("T17: 권한 없는 응답에 PIN 비노출", async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        ok: false,
        error_code: "FORBIDDEN",
        message: "조회 권한이 없습니다.",
        status: 403,
      },
      error: null,
    });

    const req = new Request(
      `http://localhost:3000/api/v1/access/${validAccessSessionId}/reveal-pin`,
      { method: "POST" }
    );
    const res = await handleRevealPin(req, {
      params: Promise.resolve({ id: validAccessSessionId }),
    });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.pin).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("1234");
  });

  it("T18: 감사로그에 PIN 평문·암호문 비노출", async () => {
    // When RPC is called, verify arguments passed to DB
    const encrypted = encryptPin("9999*");
    mockRpc.mockResolvedValueOnce({
      data: {
        ok: true,
        ciphertext_b64: encrypted.ciphertext_b64,
        iv_b64: encrypted.iv_b64,
        auth_tag_b64: encrypted.auth_tag_b64,
        key_version: 1,
        code_version: 1,
        expires_at: "2026-11-15T12:00:00.000Z",
        restroom_id: testRestroomId,
      },
      error: null,
    });

    const req = new Request(
      `http://localhost:3000/api/v1/access/${validAccessSessionId}/reveal-pin`,
      { method: "POST" }
    );
    await handleRevealPin(req, {
      params: Promise.resolve({ id: validAccessSessionId }),
    });

    expect(mockRpc).toHaveBeenCalledWith("reveal_access_pin", {
      p_access_session_id: validAccessSessionId,
      p_caller_user_id: customerUserId,
      p_request_id: expect.any(String),
    });

    const callArgs = JSON.stringify(mockRpc.mock.calls);
    expect(callArgs).not.toContain("9999*");
  });

  it("T19: 클라이언트 제공 결제 성공 정보로 서버 측 결제 상태 검증을 우회할 수 없음", async () => {
    // Even if client sends malicious body claiming payment is successful
    mockRpc.mockResolvedValueOnce({
      data: {
        ok: false,
        error_code: "PAYMENT_NOT_APPROVED",
        message: "서버에서 확인된 정상 결제 승인 내역이 없습니다.",
        status: 422,
      },
      error: null,
    });

    const req = new Request(
      `http://localhost:3000/api/v1/access/${validAccessSessionId}/reveal-pin`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentStatus: "paid",
          paid: true,
          success: true,
          amount: 1000,
          userId: customerUserId,
        }),
      }
    );
    const res = await handleRevealPin(req, {
      params: Promise.resolve({ id: validAccessSessionId }),
    });
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("PAYMENT_NOT_APPROVED");
    expect(body.pin).toBeUndefined();
  });

  it("T20: 동시 PIN 교체와 PIN 조회 시 비활성 PIN 노출 여부 검증 (Unit simulation)", async () => {
    // Simulate sequential state where active secret in DB is rotated
    const oldSecret = encryptPin("1111#");
    const newSecret = encryptPin("2222#");

    // During rotation, DB returns the newly committed active PIN (version 2)
    mockRpc.mockResolvedValueOnce({
      data: {
        ok: true,
        ciphertext_b64: newSecret.ciphertext_b64,
        iv_b64: newSecret.iv_b64,
        auth_tag_b64: newSecret.auth_tag_b64,
        key_version: 1,
        code_version: 2,
        expires_at: "2026-11-15T12:00:00.000Z",
        restroom_id: testRestroomId,
      },
      error: null,
    });

    const req = new Request(
      `http://localhost:3000/api/v1/access/${validAccessSessionId}/reveal-pin`,
      { method: "POST" }
    );
    const res = await handleRevealPin(req, {
      params: Promise.resolve({ id: validAccessSessionId }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.pin).toBe("2222#");
    expect(body.codeVersion).toBe(2);
    expect(body.pin).not.toBe("1111#");
  });

  it("T22: confirm_pin_revealed에서 PIN_STALE_ROTATED(409) 반환 시 평문 PIN 비노출 및 409 응답", async () => {
    const rawPin = "1234#";
    const encrypted = encryptPin(rawPin);

    // 1st call (reveal_access_pin): returns v1
    mockRpc.mockResolvedValueOnce({
      data: {
        ok: true,
        secret_id: "sec-0001",
        ciphertext_b64: encrypted.ciphertext_b64,
        iv_b64: encrypted.iv_b64,
        auth_tag_b64: encrypted.auth_tag_b64,
        key_version: 1,
        code_version: 1,
        expires_at: "2026-11-15T12:00:00.000Z",
        restroom_id: testRestroomId,
      },
      error: null,
    });

    // 2nd call (confirm_pin_revealed): rejected because merchant rotated to v2 in the interim
    mockRpc.mockResolvedValueOnce({
      data: {
        ok: false,
        error_code: "PIN_STALE_ROTATED",
        message: "도어락 PIN이 조회 도중 변경되었습니다. 다시 조회해 주세요.",
        status: 409,
      },
      error: null,
    });

    const req = new Request(
      `http://localhost:3000/api/v1/access/${validAccessSessionId}/reveal-pin`,
      { method: "POST" }
    );
    const res = await handleRevealPin(req, {
      params: Promise.resolve({ id: validAccessSessionId }),
    });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("PIN_STALE_ROTATED");
    expect(body.pin).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("1234#");
  });

  it("T23: confirm_pin_revealed에서 중간 환불(422 PAYMENT_REFUNDED) 감지 시 422 응답 및 PIN 비노출", async () => {
    const rawPin = "1234#";
    const encrypted = encryptPin(rawPin);

    mockRpc.mockResolvedValueOnce({
      data: {
        ok: true,
        secret_id: "sec-0001",
        ciphertext_b64: encrypted.ciphertext_b64,
        iv_b64: encrypted.iv_b64,
        auth_tag_b64: encrypted.auth_tag_b64,
        key_version: 1,
        code_version: 1,
        expires_at: "2026-11-15T12:00:00.000Z",
        restroom_id: testRestroomId,
      },
      error: null,
    });

    mockRpc.mockResolvedValueOnce({
      data: {
        ok: false,
        error_code: "PAYMENT_REFUNDED",
        message: "환불되었거나 취소 처리된 결제입니다.",
        status: 422,
      },
      error: null,
    });

    const req = new Request(
      `http://localhost:3000/api/v1/access/${validAccessSessionId}/reveal-pin`,
      { method: "POST" }
    );
    const res = await handleRevealPin(req, {
      params: Promise.resolve({ id: validAccessSessionId }),
    });
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("PAYMENT_REFUNDED");
    expect(body.pin).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("1234#");
  });

  it("T24: confirm_pin_revealed에서 중간 만료(422 ACCESS_EXPIRED) 감지 시 422 응답 및 PIN 비노출", async () => {
    const rawPin = "1234#";
    const encrypted = encryptPin(rawPin);

    mockRpc.mockResolvedValueOnce({
      data: {
        ok: true,
        secret_id: "sec-0001",
        ciphertext_b64: encrypted.ciphertext_b64,
        iv_b64: encrypted.iv_b64,
        auth_tag_b64: encrypted.auth_tag_b64,
        key_version: 1,
        code_version: 1,
        expires_at: "2026-11-15T12:00:00.000Z",
        restroom_id: testRestroomId,
      },
      error: null,
    });

    mockRpc.mockResolvedValueOnce({
      data: {
        ok: false,
        error_code: "ACCESS_EXPIRED",
        message: "화장실 이용권의 유효 시간이 만료되었습니다.",
        status: 422,
      },
      error: null,
    });

    const req = new Request(
      `http://localhost:3000/api/v1/access/${validAccessSessionId}/reveal-pin`,
      { method: "POST" }
    );
    const res = await handleRevealPin(req, {
      params: Promise.resolve({ id: validAccessSessionId }),
    });
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("ACCESS_EXPIRED");
    expect(body.pin).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("1234#");
  });
});

