/**
 * Integration Tests for TASK 21: Toss Payments Server API Routes & Flows
 * Covers POST /api/v1/payments/orders, POST /api/v1/payments/confirm, and GET /api/v1/payments/orders/:id.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST as handleCreateOrder } from "@/app/api/v1/payments/orders/route";
import { POST as handleConfirmPayment } from "@/app/api/v1/payments/confirm/route";
import { GET as handleGetOrder } from "@/app/api/v1/payments/orders/[id]/route";

// Mock @/lib/auth
vi.mock("@/lib/auth", () => {
  return {
    AuthGuardError: class extends Error {
      code: string;
      status: number;
      userMessage: string;
      constructor(code: string, status: number, userMessage: string) {
        super(userMessage);
        this.code = code;
        this.status = status;
        this.userMessage = userMessage;
      }
    },
    requireAuth: vi.fn(),
  };
});

// Mock @/lib/supabase/server
vi.mock("@/lib/supabase/server", () => {
  return {
    createServerClientInstance: vi.fn().mockResolvedValue({}),
    createAdminClient: vi.fn(),
  };
});

import { requireAuth } from "@/lib/auth";
import { createAdminClient, createServerClientInstance } from "@/lib/supabase/server";

describe("TASK 21: Toss Payments API Routes Integration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.PAYMENT_MODE = "test";
    process.env.TOSS_TEST_SECRET_KEY = "test_sk_test_key_12345";
    process.env.NEXT_PUBLIC_TOSS_TEST_CLIENT_KEY = "test_ck_test_key_12345";
  });

  describe("POST /api/v1/payments/orders", () => {
    it("returns 401 when user is not authenticated", async () => {
      const { AuthGuardError } = await import("@/lib/auth");
      vi.mocked(requireAuth).mockRejectedValueOnce(
        new AuthGuardError("UNAUTHORIZED", 401, "로그인이 필요한 서비스입니다.")
      );

      const req = new Request("http://localhost:3000/api/v1/payments/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          restroomId: "11111111-1111-4111-a111-111111111111",
          idempotencyKey: "test_idem_001_12345",
        }),
      });

      const res = await handleCreateOrder(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 400 on invalid input payload", async () => {
      vi.mocked(requireAuth).mockResolvedValueOnce({
        user: { id: "user-1" } as any,
        roles: ["customer"],
        isAdmin: false,
        isMerchant: false,
        displayName: "User 1",
        accountStatus: "active",
        profileExists: true,
        sessionExpired: false,
        configReady: true,
      });

      const req = new Request("http://localhost:3000/api/v1/payments/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          restroomId: "invalid-uuid",
          idempotencyKey: "short",
        }),
      });

      const res = await handleCreateOrder(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe("VALIDATION_ERROR");
    });

    it("creates order and returns 201 on valid request", async () => {
      vi.mocked(requireAuth).mockResolvedValueOnce({
        user: { id: "user-1" } as any,
        roles: ["customer"],
        isAdmin: false,
        isMerchant: false,
        displayName: "User 1",
        accountStatus: "active",
        profileExists: true,
        sessionExpired: false,
        configReady: true,
      });

      const mockAdminClient: any = {
        rpc: vi.fn().mockResolvedValue({
          data: {
            reused: false,
            order: {
              id: "ord-uuid-1",
              user_id: "user-1",
              order_id: "hm_ord_20261114_001",
              amount_krw: 1000,
              status: "created",
              provider: "toss",
              payment_mode: "test",
              provider_payment_key: null,
              idempotency_key: "idem_order_001_12345",
              approved_at: null,
              failure_code: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            access_session: {
              id: "session-uuid-1",
              user_id: "user-1",
              restroom_id: "11111111-1111-4111-a111-111111111111",
              policy_id: "policy-uuid-1",
              status: "created",
              access_method_snapshot: "pin",
              idempotency_key: "ses_idem_order_001_12345",
              authorized_at: null,
              code_revealed_at: null,
              expires_at: new Date(Date.now() + 86400000).toISOString(),
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            business_id: "biz-uuid-1",
          },
          error: null,
        }),
        from: (table: string) => {
          if (table === "event_logs") {
            return {
              insert: vi.fn().mockResolvedValue({ error: null }),
            };
          }
          return {};
        },
      };

      vi.mocked(createAdminClient).mockReturnValue(mockAdminClient);

      const req = new Request("http://localhost:3000/api/v1/payments/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          restroomId: "11111111-1111-4111-a111-111111111111",
          idempotencyKey: "idem_order_001_12345",
        }),
      });

      const res = await handleCreateOrder(req);
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.orderId).toBe("hm_ord_20261114_001");
      expect(json.data.amount).toBe(1000);
      expect(json.data.paymentMode).toBe("test");
      expect(json.data.reused).toBe(false);

      // Sensitive fields must be stripped
      expect(json.data.order.provider_payment_key).toBeUndefined();
      expect(json.data.order.idempotency_key).toBeUndefined();
      expect(json.data.accessSession.idempotency_key).toBeUndefined();
    });

    it("returns 200 on reused order", async () => {
      vi.mocked(requireAuth).mockResolvedValueOnce({
        user: { id: "user-1" } as any,
        roles: ["customer"],
        isAdmin: false,
        isMerchant: false,
        displayName: "User 1",
        accountStatus: "active",
        profileExists: true,
        sessionExpired: false,
        configReady: true,
      });

      const mockAdminClient: any = {
        rpc: vi.fn().mockResolvedValue({
          data: {
            reused: true,
            order: {
              id: "ord-uuid-1",
              order_id: "hm_ord_reused",
              amount_krw: 1000,
              status: "created",
            },
            access_session: {
              id: "session-uuid-1",
              status: "created",
            },
          },
          error: null,
        }),
      };
      vi.mocked(createAdminClient).mockReturnValue(mockAdminClient);

      const req = new Request("http://localhost:3000/api/v1/payments/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          restroomId: "11111111-1111-4111-a111-111111111111",
          idempotencyKey: "idem_order_001_12345",
        }),
      });

      const res = await handleCreateOrder(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.reused).toBe(true);
    });
  });

  describe("POST /api/v1/payments/confirm", () => {
    it("returns 401 when unauthenticated", async () => {
      const { AuthGuardError } = await import("@/lib/auth");
      vi.mocked(requireAuth).mockRejectedValueOnce(
        new AuthGuardError("UNAUTHORIZED", 401, "로그인이 필요한 서비스입니다.")
      );

      const req = new Request("http://localhost:3000/api/v1/payments/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: "hm_ord_001",
          paymentKey: "tpay_key_001",
          amount: 1000,
        }),
      });

      const res = await handleConfirmPayment(req);
      expect(res.status).toBe(401);
    });

    it("returns 400 on invalid input parameters", async () => {
      vi.mocked(requireAuth).mockResolvedValueOnce({
        user: { id: "user-1" } as any,
        roles: ["customer"],
        isAdmin: false,
        isMerchant: false,
        displayName: "User 1",
        accountStatus: "active",
        profileExists: true,
        sessionExpired: false,
        configReady: true,
      });

      const req = new Request("http://localhost:3000/api/v1/payments/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: "short",
          paymentKey: "",
          amount: -100,
        }),
      });

      const res = await handleConfirmPayment(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("GET /api/v1/payments/orders/:id", () => {
    it("returns 401 when unauthenticated", async () => {
      const { AuthGuardError } = await import("@/lib/auth");
      vi.mocked(requireAuth).mockRejectedValueOnce(
        new AuthGuardError("UNAUTHORIZED", 401, "로그인이 필요합니다.")
      );

      const req = new Request("http://localhost:3000/api/v1/payments/orders/hm_ord_001");
      const res = await handleGetOrder(req, { params: Promise.resolve({ id: "hm_ord_001" }) });
      expect(res.status).toBe(401);
    });

    it("returns order for owner and strictly omits provider_payment_key", async () => {
      vi.mocked(requireAuth).mockResolvedValueOnce({
        user: { id: "user-1" } as any,
        roles: ["customer"],
        isAdmin: false,
        isMerchant: false,
        displayName: "User 1",
        accountStatus: "active",
        profileExists: true,
        sessionExpired: false,
        configReady: true,
      });

      const mockAdminClient: any = {
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: "ord-uuid-1",
                  user_id: "user-1",
                  order_id: "hm_ord_001",
                  amount_krw: 1000,
                  status: "approved",
                  provider_payment_key: "SECRET_KEY_MUST_BE_OMITTED",
                  idempotency_key: "SECRET_IDEM_KEY_MUST_BE_OMITTED",
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                },
                error: null,
              }),
            }),
          }),
        }),
      };
      vi.mocked(createAdminClient).mockReturnValue(mockAdminClient);

      const req = new Request("http://localhost:3000/api/v1/payments/orders/hm_ord_001");
      const res = await handleGetOrder(req, { params: Promise.resolve({ id: "hm_ord_001" }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.order.order_id).toBe("hm_ord_001");
      expect(json.data.order.status).toBe("approved");
      expect(json.data.order.provider_payment_key).toBeUndefined();
      expect(json.data.order.idempotency_key).toBeUndefined();
    });

    it("selects only explicit safe access_sessions columns (excluding idempotency_key) when access_session_id exists", async () => {
      vi.mocked(requireAuth).mockResolvedValueOnce({
        user: { id: "user-1" } as any,
        roles: ["customer"],
        isAdmin: false,
        isMerchant: false,
        displayName: "User 1",
        accountStatus: "active",
        profileExists: true,
        sessionExpired: false,
        configReady: true,
      });

      const mockAdminClient: any = {
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: "ord-uuid-1",
                  access_session_id: "ses-uuid-1",
                  user_id: "user-1",
                  order_id: "hm_ord_001",
                  provider: "toss",
                  payment_mode: "test",
                  amount_krw: 1000,
                  status: "approved",
                  provider_payment_key: "SECRET_KEY_MUST_BE_OMITTED",
                  idempotency_key: "SECRET_IDEM_KEY_MUST_BE_OMITTED",
                  approved_at: new Date().toISOString(),
                  failure_code: null,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                },
                error: null,
              }),
            }),
          }),
        }),
      };
      vi.mocked(createAdminClient).mockReturnValue(mockAdminClient);

      let selectedColumns = "";
      const mockServerClient: any = {
        from: (table: string) => {
          expect(table).toBe("access_sessions");
          return {
            select: (cols: string) => {
              selectedColumns = cols;
              return {
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: "ses-uuid-1",
                      user_id: "user-1",
                      restroom_id: "restroom-1",
                      policy_id: "policy-1",
                      status: "authorized",
                      access_method_snapshot: "pin",
                      authorized_at: new Date().toISOString(),
                      code_revealed_at: null,
                      expires_at: new Date(Date.now() + 86400000).toISOString(),
                      created_at: new Date().toISOString(),
                      updated_at: new Date().toISOString(),
                    },
                    error: null,
                  }),
                }),
              };
            },
          };
        },
      };
      vi.mocked(createServerClientInstance)
        .mockResolvedValueOnce({} as any)
        .mockResolvedValueOnce(mockServerClient);

      const req = new Request("http://localhost:3000/api/v1/payments/orders/hm_ord_001");
      const res = await handleGetOrder(req, { params: Promise.resolve({ id: "hm_ord_001" }) });
      expect(res.status).toBe(200);
      expect(selectedColumns).not.toBe("*");
      expect(selectedColumns).not.toContain("idempotency_key");
      expect(selectedColumns).toContain("access_method_snapshot");
      const json = await res.json();
      expect(json.data.accessSession.id).toBe("ses-uuid-1");
      expect(json.data.accessSession.status).toBe("authorized");
      expect(json.data.accessSession.idempotency_key).toBeUndefined();
    });
  });
});

