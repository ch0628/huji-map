/**
 * Unit & Route Tests for TASK 23 Doorlock PIN Registration & Rotation
 * Covers POST /api/v1/merchant/restrooms/:id/pin (T11, T12, T13, T14, T18)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST as handleSetPin } from "@/app/api/v1/merchant/restrooms/[id]/pin/route";
import * as authLib from "@/lib/auth";
import * as supabaseServer from "@/lib/supabase/server";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof authLib>();
  return {
    ...actual,
    requireRole: vi.fn(),
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

describe("TASK 23 — Merchant PIN Route Tests (T11, T12, T13, T14, T18)", () => {
  const validRestroomId = "11111111-1111-4111-8111-111111111111";
  const otherRestroomId = "22222222-2222-4222-8222-222222222222";
  const merchantUser = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    email: "merchant@test.com",
    role: "authenticated",
  };
  const customerUser = {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    email: "customer@test.com",
    role: "authenticated",
  };

  const validHexKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const originalEnv = process.env.PIN_ENCRYPTION_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PIN_ENCRYPTION_KEY = validHexKey;
    process.env.PIN_KEY_VERSION = "1";
    authLib.clearIdempotencyStoreForTests();
  });

  afterEach(() => {
    process.env.PIN_ENCRYPTION_KEY = originalEnv;
  });

  it("T12: 비로그인(401) 및 일반 고객(403) 접근이 차단되어야 한다", async () => {
    // 1. Unauthenticated (401)
    vi.mocked(authLib.requireRole).mockRejectedValueOnce(
      new authLib.AuthGuardError("UNAUTHORIZED", 401, "로그인이 필요한 서비스입니다.")
    );

    const reqUnauth = new Request(
      `http://localhost:3000/api/v1/merchant/restrooms/${validRestroomId}/pin`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: "1234" }),
      }
    );

    const resUnauth = await handleSetPin(reqUnauth, {
      params: Promise.resolve({ id: validRestroomId }),
    });
    const bodyUnauth = await resUnauth.json();

    expect(resUnauth.status).toBe(401);
    expect(bodyUnauth.ok).toBe(false);
    expect(bodyUnauth.error.code).toBe("UNAUTHORIZED");

    // 2. Customer without merchant or admin role (403)
    vi.mocked(authLib.requireRole).mockRejectedValueOnce(
      new authLib.AuthGuardError("FORBIDDEN", 403, "점주 또는 관리자 권한이 필요합니다.")
    );

    const reqCustomer = new Request(
      `http://localhost:3000/api/v1/merchant/restrooms/${validRestroomId}/pin`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: "1234" }),
      }
    );

    const resCustomer = await handleSetPin(reqCustomer, {
      params: Promise.resolve({ id: validRestroomId }),
    });
    const bodyCustomer = await resCustomer.json();

    expect(resCustomer.status).toBe(403);
    expect(bodyCustomer.ok).toBe(false);
    expect(bodyCustomer.error.code).toBe("FORBIDDEN");
  });

  it("입력값 검증: 비어있거나 너무 짧거나 특수기호가 잘못된 PIN은 400으로 거부되어야 한다", async () => {
    vi.mocked(authLib.requireRole).mockResolvedValue({
      user: merchantUser,
      roles: ["merchant"],
      primaryRole: "merchant",
      isAdmin: false,
      isMerchant: true,
      accountStatus: "active",
      profileExists: true,
    } as any);

    const invalidBodies = [
      {},
      { pin: "" },
      { pin: "12" }, // < 4 chars
      { pin: "123456789012345678901" }, // > 20 chars
      { pin: "123a" }, // alphabetic not allowed
      { pin: "12!@" }, // special chars other than * and #
    ];

    for (const b of invalidBodies) {
      const req = new Request(
        `http://localhost:3000/api/v1/merchant/restrooms/${validRestroomId}/pin`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(b),
        }
      );

      const res = await handleSetPin(req, {
        params: Promise.resolve({ id: validRestroomId }),
      });
      const data = await res.json();
      expect(res.status).toBe(400);
      expect(data.ok).toBe(false);
    }
  });

  it("T18: PIN 등록 성공 시 응답에 PIN 및 암호문, IV, 인증태그, 암호화키가 일체 포함되지 않아야 한다", async () => {
    vi.mocked(authLib.requireRole).mockResolvedValue({
      user: merchantUser,
      roles: ["merchant"],
      primaryRole: "merchant",
      isAdmin: false,
      isMerchant: true,
      accountStatus: "active",
      profileExists: true,
    } as any);

    const mockAdminRpc = vi.fn().mockResolvedValue({
      data: {
        success: true,
        code_version: 1,
        valid_from: "2026-11-13T12:00:00.000Z",
      },
      error: null,
    });

    vi.mocked(supabaseServer.createAdminClient).mockReturnValue({
      rpc: mockAdminRpc,
    } as any);

    const inputPin = "1234*#";
    const req = new Request(
      `http://localhost:3000/api/v1/merchant/restrooms/${validRestroomId}/pin`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: inputPin }),
      }
    );

    const res = await handleSetPin(req, {
      params: Promise.resolve({ id: validRestroomId }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.codeVersion).toBe(1);
    expect(body.updatedAt).toBe("2026-11-13T12:00:00.000Z");
    expect(body.requestId).toBeDefined();

    // STRICT INVARIANTS: ABSOLUTELY NO SENSITIVE FIELDS
    expect(body.pin).toBeUndefined();
    expect(body.ciphertext_b64).toBeUndefined();
    expect(body.iv_b64).toBeUndefined();
    expect(body.auth_tag_b64).toBeUndefined();
    expect(body.PIN_ENCRYPTION_KEY).toBeUndefined();

    // Verify RPC was called with encrypted data and never plaintext PIN
    expect(mockAdminRpc).toHaveBeenCalledTimes(1);
    const rpcArgs = mockAdminRpc.mock.calls[0][1];
    expect(rpcArgs.p_restroom_id).toBe(validRestroomId);
    expect(rpcArgs.p_caller_user_id).toBe(merchantUser.id);
    expect(rpcArgs.p_ciphertext_b64).toBeDefined();
    expect(rpcArgs.p_ciphertext_b64).not.toBe(inputPin);
    expect(rpcArgs.p_iv_b64).toBeDefined();
    expect(rpcArgs.p_auth_tag_b64).toBeDefined();
    expect(rpcArgs.p_key_version).toBe(1);
    expect(JSON.stringify(rpcArgs)).not.toContain(inputPin);
  });

  it("T11: merchant A가 merchant B의 화장실 PIN 변경 시도 시 403 차단되어야 한다", async () => {
    vi.mocked(authLib.requireRole).mockResolvedValue({
      user: merchantUser,
      roles: ["merchant"],
      primaryRole: "merchant",
      isAdmin: false,
      isMerchant: true,
      accountStatus: "active",
      profileExists: true,
    } as any);

    // RPC raises HM088 when caller is not member of approved business owning this restroom
    vi.mocked(supabaseServer.createAdminClient).mockReturnValue({
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "HM088: Caller is not an active member of the approved business owning this restroom" },
      }),
    } as any);

    const req = new Request(
      `http://localhost:3000/api/v1/merchant/restrooms/${otherRestroomId}/pin`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: "9999" }),
      }
    );

    const res = await handleSetPin(req, {
      params: Promise.resolve({ id: otherRestroomId }),
    });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("MEMBERSHIP_REQUIRED");
  });

  it("T13: 공공 화장실(HM082) 또는 미승인 가게 화장실에 대한 PIN 등록은 403 차단되어야 한다", async () => {
    vi.mocked(authLib.requireRole).mockResolvedValue({
      user: merchantUser,
      roles: ["merchant"],
      primaryRole: "merchant",
      isAdmin: false,
      isMerchant: true,
      accountStatus: "active",
      profileExists: true,
    } as any);

    vi.mocked(supabaseServer.createAdminClient).mockReturnValue({
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "HM082: Cannot register doorlock PIN secret on non-partner restroom" },
      }),
    } as any);

    const req = new Request(
      `http://localhost:3000/api/v1/merchant/restrooms/${validRestroomId}/pin`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: "1234" }),
      }
    );

    const res = await handleSetPin(req, {
      params: Promise.resolve({ id: validRestroomId }),
    });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("FORBIDDEN_PUBLIC_RESTROOM");
  });

  it("T14: 중복 요청(동일 Idempotency-Key) 시 캐시된 응답이 재반환되어야 한다", async () => {
    vi.mocked(authLib.requireRole).mockResolvedValue({
      user: merchantUser,
      roles: ["merchant"],
      primaryRole: "merchant",
      isAdmin: false,
      isMerchant: true,
      accountStatus: "active",
      profileExists: true,
    } as any);

    const mockAdminRpc = vi.fn().mockResolvedValue({
      data: {
        success: true,
        code_version: 1,
        valid_from: "2026-11-13T12:00:00.000Z",
      },
      error: null,
    });

    vi.mocked(supabaseServer.createAdminClient).mockReturnValue({
      rpc: mockAdminRpc,
    } as any);

    const idempotencyKey = "idem-test-pin-rotation-0001";

    // First request
    const req1 = new Request(
      `http://localhost:3000/api/v1/merchant/restrooms/${validRestroomId}/pin`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({ pin: "1234" }),
      }
    );

    const res1 = await handleSetPin(req1, {
      params: Promise.resolve({ id: validRestroomId }),
    });
    const body1 = await res1.json();
    expect(res1.status).toBe(200);
    expect(body1.codeVersion).toBe(1);
    expect(mockAdminRpc).toHaveBeenCalledTimes(1);

    // Second request with same idempotency key and same payload
    const req2 = new Request(
      `http://localhost:3000/api/v1/merchant/restrooms/${validRestroomId}/pin`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({ pin: "1234" }),
      }
    );

    const res2 = await handleSetPin(req2, {
      params: Promise.resolve({ id: validRestroomId }),
    });
    const body2 = await res2.json();
    expect(res2.status).toBe(200);
    expect(body2.codeVersion).toBe(1);

    // RPC must NOT have been called a second time!
    expect(mockAdminRpc).toHaveBeenCalledTimes(1);
  });

  it("T14-DB: 서버 재시작(인메모리 캐시 초기화) 후 동일 멱등키 재요청 시 DB 멱등성에 의해 기존 codeVersion을 반환해야 한다", async () => {
    vi.mocked(authLib.requireRole).mockResolvedValue({
      user: merchantUser,
      roles: ["merchant"],
      primaryRole: "merchant",
      isAdmin: false,
      isMerchant: true,
      accountStatus: "active",
      profileExists: true,
    } as any);

    // Simulate DB RPC returning replay action after server restart
    const mockAdminRpc = vi.fn().mockResolvedValue({
      data: {
        success: true,
        code_version: 3,
        valid_from: "2026-11-13T12:00:00.000Z",
        action: "replay",
      },
      error: null,
    });

    vi.mocked(supabaseServer.createAdminClient).mockReturnValue({
      rpc: mockAdminRpc,
    } as any);

    // Simulate in-memory cache being cleared (server restart)
    authLib.clearIdempotencyStoreForTests();

    const idempotencyKey = "persisted-idem-key-restart-001";
    const req = new Request(
      `http://localhost:3000/api/v1/merchant/restrooms/${validRestroomId}/pin`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({ pin: "1234" }),
      }
    );

    const res = await handleSetPin(req, {
      params: Promise.resolve({ id: validRestroomId }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.codeVersion).toBe(3);
    expect(body.updatedAt).toBe("2026-11-13T12:00:00.000Z");

    // Verify RPC received idempotency key and HMAC
    expect(mockAdminRpc).toHaveBeenCalledTimes(1);
    const rpcArgs = mockAdminRpc.mock.calls[0][1];
    expect(rpcArgs.p_idempotency_key).toBe(idempotencyKey);
    expect(rpcArgs.p_pin_hmac_b64).toBeDefined();
    expect(typeof rpcArgs.p_pin_hmac_b64).toBe("string");
  });

  it("T14-DB-Conflict-PIN: 서버 재시작 후 동일 멱등키에 다른 PIN 전송 시 DB에서 409 IDEMPOTENCY_CONFLICT로 차단되어야 한다", async () => {
    vi.mocked(authLib.requireRole).mockResolvedValue({
      user: merchantUser,
      roles: ["merchant"],
      primaryRole: "merchant",
      isAdmin: false,
      isMerchant: true,
      accountStatus: "active",
      profileExists: true,
    } as any);

    // Simulate DB RPC returning HM092 collision
    vi.mocked(supabaseServer.createAdminClient).mockReturnValue({
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "HM092: Idempotency conflict: key already used with different PIN payload" },
      }),
    } as any);

    authLib.clearIdempotencyStoreForTests();

    const req = new Request(
      `http://localhost:3000/api/v1/merchant/restrooms/${validRestroomId}/pin`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": "persisted-idem-key-conflict-001",
        },
        body: JSON.stringify({ pin: "9999" }),
      }
    );

    const res = await handleSetPin(req, {
      params: Promise.resolve({ id: validRestroomId }),
    });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("T14-DB-Conflict-Target: 서버 재시작 후 동일 멱등키에 다른 화장실/사용자 전송 시 DB에서 409 IDEMPOTENCY_CONFLICT로 차단되어야 한다", async () => {
    vi.mocked(authLib.requireRole).mockResolvedValue({
      user: merchantUser,
      roles: ["merchant"],
      primaryRole: "merchant",
      isAdmin: false,
      isMerchant: true,
      accountStatus: "active",
      profileExists: true,
    } as any);

    // Simulate DB RPC returning HM091 collision
    vi.mocked(supabaseServer.createAdminClient).mockReturnValue({
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "HM091: Idempotency conflict: key already used for another restroom or user" },
      }),
    } as any);

    authLib.clearIdempotencyStoreForTests();

    const req = new Request(
      `http://localhost:3000/api/v1/merchant/restrooms/${otherRestroomId}/pin`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": "persisted-idem-key-conflict-002",
        },
        body: JSON.stringify({ pin: "1234" }),
      }
    );

    const res = await handleSetPin(req, {
      params: Promise.resolve({ id: otherRestroomId }),
    });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("T14-Validation: 공백 또는 빈 문자열 Idempotency-Key는 400 VALIDATION_ERROR로 거부되어야 한다", async () => {
    vi.mocked(authLib.requireRole).mockResolvedValue({
      user: merchantUser,
      roles: ["merchant"],
      primaryRole: "merchant",
      isAdmin: false,
      isMerchant: true,
      accountStatus: "active",
      profileExists: true,
    } as any);

    const blankKeys = ["", "   ", "\t  \n"];
    for (const blankKey of blankKeys) {
      const req = new Request(
        `http://localhost:3000/api/v1/merchant/restrooms/${validRestroomId}/pin`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-idempotency-key": blankKey,
          },
          body: JSON.stringify({ pin: "1234" }),
        }
      );

      const res = await handleSetPin(req, {
        params: Promise.resolve({ id: validRestroomId }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toContain("Idempotency-Key");
    }
  });

  it("T11-Admin-Unapproved: 관리자도 미승인 가게의 화장실 PIN 등록 시 403 MEMBERSHIP_REQUIRED로 거부되어야 한다", async () => {
    const adminUser = {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      email: "admin@test.com",
      role: "authenticated",
    };
    vi.mocked(authLib.requireRole).mockResolvedValue({
      user: adminUser,
      roles: ["admin"],
      primaryRole: "admin",
      isAdmin: true,
      isMerchant: false,
      accountStatus: "active",
      profileExists: true,
    } as any);

    // RPC raises HM088 when business owning this restroom is not approved
    vi.mocked(supabaseServer.createAdminClient).mockReturnValue({
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "HM088: Business owning this restroom is not approved" },
      }),
    } as any);

    const req = new Request(
      `http://localhost:3000/api/v1/merchant/restrooms/${validRestroomId}/pin`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: "1234" }),
      }
    );

    const res = await handleSetPin(req, {
      params: Promise.resolve({ id: validRestroomId }),
    });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("MEMBERSHIP_REQUIRED");
  });

  it("T11-Revoked-Replay: 점포 소속이 해제된 사용자가 과거 멱등키로 replay 시도 시 403 MEMBERSHIP_REQUIRED로 거부되어야 한다", async () => {
    vi.mocked(authLib.requireRole).mockResolvedValue({
      user: merchantUser,
      roles: ["merchant"],
      primaryRole: "merchant",
      isAdmin: false,
      isMerchant: true,
      accountStatus: "active",
      profileExists: true,
    } as any);

    // RPC raises HM088 because membership is not active owner even when idempotency key exists
    vi.mocked(supabaseServer.createAdminClient).mockReturnValue({
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "HM088: Caller is not an active owner of the approved business owning this restroom" },
      }),
    } as any);

    authLib.clearIdempotencyStoreForTests();

    const req = new Request(
      `http://localhost:3000/api/v1/merchant/restrooms/${validRestroomId}/pin`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": "revoked-user-old-key-001",
        },
        body: JSON.stringify({ pin: "1234" }),
      }
    );

    const res = await handleSetPin(req, {
      params: Promise.resolve({ id: validRestroomId }),
    });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("MEMBERSHIP_REQUIRED");
  });
});
