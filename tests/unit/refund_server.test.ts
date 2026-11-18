/**
 * TASK 30: Admin Test Refund Server Unit & Route Integration Tests
 * Covers all 20 scenarios in tasks/30_refund_server.md STEP 9.
 * Uses mocked Toss API and in-memory Supabase/DB simulation (no live payments, no secret leakage).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DefaultTossRefundClient,
  FIXED_TEST_CANCEL_REASON,
  listAdminRefunds,
  reconcileAdminRefund,
  RefundServiceError,
  requestAdminRefund,
  TOSS_IDEMPOTENCY_TTL_MS,
  verifyTossFullCancellation,
  type ITossRefundClient,
  type TossPaymentWithCancelsResponse,
} from "@/lib/payments/refunds";
import { PaymentConfigError } from "@/lib/payments/config";
import { TossPaymentError } from "@/lib/payments/toss-client";
import { POST as handlePostRefund } from "@/app/api/v1/admin/refunds/[paymentOrderId]/request/route";
import { POST as handleReconcileRefund } from "@/app/api/v1/admin/refunds/[paymentOrderId]/reconcile/route";
import { GET as handleGetRefunds } from "@/app/api/v1/admin/refunds/route";

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    isSupabaseAuthConfigured: vi.fn(() => true),
    requireRole: vi.fn(),
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createServerClientInstance: vi.fn().mockResolvedValue({}),
  isServiceRoleConfigured: vi.fn(() => true),
  createAdminClient: vi.fn(),
}));

import { AuthGuardError, isSupabaseAuthConfigured, requireRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/server";

const IDS = {
  admin1: "11111111-1111-4111-a111-111111111101",
  admin2: "11111111-1111-4111-a111-111111111102",
  inactiveAdmin: "11111111-1111-4111-a111-111111111103",
  customer: "22222222-2222-4222-a222-222222222201",
  customer2: "22222222-2222-4222-a222-222222222202",
  session1: "33333333-3333-4333-a333-333333333301",
  session2: "33333333-3333-4333-a333-333333333302",
  policy1: "44444444-4444-4444-a444-444444444401",
  order1: "55555555-5555-4555-a555-555555555501",
  orderFailed: "55555555-5555-4555-a555-555555555502",
  orderNonTest: "55555555-5555-4555-a555-555555555503",
  receipt1: "66666666-6666-4666-a666-666666666601",
  receiptPending: "66666666-6666-4666-a666-666666666602",
  receiptOtherApproved: "66666666-6666-4666-a666-666666666603",
  receiptMissing: "66666666-6666-4666-a666-666666666699",
};

interface MockStore {
  profiles: Array<{ id: string; account_status: string; display_name?: string; phone?: string }>;
  user_roles: Array<{ user_id: string; role: string }>;
  restroom_access_policies: Array<{
    id: string;
    access_mode: string;
    deposit_amount_krw: number | null;
  }>;
  access_sessions: Array<{
    id: string;
    user_id: string;
    restroom_id: string;
    policy_id: string;
    status: string;
  }>;
  payment_orders: Array<{
    id: string;
    access_session_id: string;
    user_id: string;
    order_id: string;
    provider: string;
    payment_mode: string;
    amount_krw: number;
    status: string;
    provider_payment_key: string | null;
    idempotency_key: string;
    approved_at: string | null;
    failure_code: string | null;
    created_at: string;
    updated_at: string;
  }>;
  receipt_submissions: Array<{
    id: string;
    access_session_id: string;
    user_id: string;
    storage_path: string;
    submission_status: string;
    reviewed_by: string | null;
    reviewed_at: string | null;
  }>;
  payment_refunds: Array<{
    id: string;
    payment_order_id: string;
    receipt_submission_id: string | null;
    amount_krw: number;
    status: string;
    idempotency_key: string;
    requested_by: string;
    provider_cancel_id: string | null;
    failure_reason: string | null;
    requested_at: string;
    completed_at: string | null;
  }>;
  audit_logs: Array<{
    id: string;
    actor_user_id: string | null;
    action: string;
    entity_type: string;
    entity_id: string;
    before_data: Record<string, unknown> | null;
    after_data: Record<string, unknown> | null;
    reason: string | null;
    created_at: string;
  }>;
  failRefundUpdateAfterToss?: boolean;
}

function createSeededStore(): MockStore {
  return {
    profiles: [
      { id: IDS.admin1, account_status: "active", display_name: "관리자1" },
      { id: IDS.admin2, account_status: "active", display_name: "관리자2" },
      { id: IDS.inactiveAdmin, account_status: "suspended", display_name: "정지관리자" },
      { id: IDS.customer, account_status: "active", display_name: "홍길동", phone: "010-1234-5678" },
      { id: IDS.customer2, account_status: "active", display_name: "김철수" },
    ],
    user_roles: [
      { user_id: IDS.admin1, role: "admin" },
      { user_id: IDS.admin2, role: "admin" },
      { user_id: IDS.inactiveAdmin, role: "admin" },
      { user_id: IDS.customer, role: "customer" },
      { user_id: IDS.customer2, role: "customer" },
    ],
    restroom_access_policies: [
      { id: IDS.policy1, access_mode: "test_deposit", deposit_amount_krw: 1000 },
    ],
    access_sessions: [
      {
        id: IDS.session1,
        user_id: IDS.customer,
        restroom_id: "77777777-7777-4777-a777-777777777701",
        policy_id: IDS.policy1,
        status: "authorized",
      },
      {
        id: IDS.session2,
        user_id: IDS.customer2,
        restroom_id: "77777777-7777-4777-a777-777777777701",
        policy_id: IDS.policy1,
        status: "authorized",
      },
    ],
    payment_orders: [
      {
        id: IDS.order1,
        access_session_id: IDS.session1,
        user_id: IDS.customer,
        order_id: "hm_ord_test_001",
        provider: "toss",
        payment_mode: "test",
        amount_krw: 1000,
        status: "approved",
        provider_payment_key: "tgen_test_paykey_001",
        idempotency_key: "order_idem_001",
        approved_at: "2026-11-16T00:00:00.000Z",
        failure_code: null,
        created_at: "2026-11-16T00:00:00.000Z",
        updated_at: "2026-11-16T00:00:00.000Z",
      },
      {
        id: IDS.orderFailed,
        access_session_id: IDS.session1,
        user_id: IDS.customer,
        order_id: "hm_ord_failed_002",
        provider: "toss",
        payment_mode: "test",
        amount_krw: 1000,
        status: "failed",
        provider_payment_key: null,
        idempotency_key: "order_idem_002",
        approved_at: null,
        failure_code: "CARD_DECLINED",
        created_at: "2026-11-16T00:00:00.000Z",
        updated_at: "2026-11-16T00:00:00.000Z",
      },
      {
        id: IDS.orderNonTest,
        access_session_id: IDS.session2,
        user_id: IDS.customer2,
        order_id: "hm_ord_live_003",
        provider: "toss",
        payment_mode: "live",
        amount_krw: 1000,
        status: "approved",
        provider_payment_key: "live_paykey_should_block",
        idempotency_key: "order_idem_003",
        approved_at: "2026-11-16T00:00:00.000Z",
        failure_code: null,
        created_at: "2026-11-16T00:00:00.000Z",
        updated_at: "2026-11-16T00:00:00.000Z",
      },
    ],
    receipt_submissions: [
      {
        id: IDS.receipt1,
        access_session_id: IDS.session1,
        user_id: IDS.customer,
        storage_path: `receipts/${IDS.customer}/${IDS.session1}/secret-receipt.jpg`,
        submission_status: "approved",
        reviewed_by: IDS.admin1,
        reviewed_at: "2026-11-16T01:00:00.000Z",
      },
      {
        id: IDS.receiptPending,
        access_session_id: IDS.session1,
        user_id: IDS.customer,
        storage_path: `receipts/${IDS.customer}/${IDS.session1}/pending-receipt.jpg`,
        submission_status: "submitted",
        reviewed_by: null,
        reviewed_at: null,
      },
      {
        id: IDS.receiptOtherApproved,
        access_session_id: IDS.session2,
        user_id: IDS.customer2,
        storage_path: `receipts/${IDS.customer2}/${IDS.session2}/other-receipt.jpg`,
        submission_status: "approved",
        reviewed_by: IDS.admin1,
        reviewed_at: "2026-11-16T01:00:00.000Z",
      },
    ],
    payment_refunds: [],
    audit_logs: [],
  };
}

/**
 * In-memory Supabase admin client enforcing PostgreSQL UNIQUE constraints and trigger invariants.
 */
function createMockSupabaseAdmin(store: MockStore) {
  function filterRows(
    rows: any[],
    filters: Array<{ type: string; col: string; val: any }>
  ) {
    return rows.filter((row) =>
      filters.every((f) => {
        if (f.type === "eq") return row[f.col] === f.val;
        if (f.type === "neq") return row[f.col] !== f.val;
        if (f.type === "in") return Array.isArray(f.val) && f.val.includes(row[f.col]);
        return true;
      })
    );
  }

  return {
    from(table: keyof MockStore) {
      const filters: Array<{ type: string; col: string; val: any }> = [];
      let orderBy: { col: string; ascending: boolean } | null = null;
      let rangeSlice: [number, number] | null = null;

      const buildChain = (op: "select" | "insert" | "update", payload?: any) => {
        const execute = async (): Promise<{ data: any; error: any; count?: number }> => {
          const arr = store[table] as any[];

          if (op === "select") {
            let matched = filterRows(arr, filters);
            const total = matched.length;
            if (orderBy) {
              matched = [...matched].sort((a, b) => {
                const av = a[orderBy!.col] ?? "";
                const bv = b[orderBy!.col] ?? "";
                return orderBy!.ascending
                  ? String(av).localeCompare(String(bv))
                  : String(bv).localeCompare(String(av));
              });
            }
            if (rangeSlice) {
              matched = matched.slice(rangeSlice[0], rangeSlice[1] + 1);
            }
            return { data: matched.map((r) => ({ ...r })), error: null, count: total };
          }

          if (op === "insert") {
            const rowsToInsert = Array.isArray(payload) ? payload : [payload];
            const inserted: any[] = [];
            for (const item of rowsToInsert) {
              if (table === "payment_refunds") {
                if (
                  arr.some((r) => r.payment_order_id === item.payment_order_id) ||
                  arr.some((r) => r.idempotency_key === item.idempotency_key)
                ) {
                  return {
                    data: null,
                    error: {
                      code: "23505",
                      message: "duplicate key value violates unique constraint",
                    },
                  };
                }
                const order = store.payment_orders.find(
                  (o) => o.id === item.payment_order_id
                );
                if (!order || order.status !== "approved") {
                  return {
                    data: null,
                    error: { code: "22023", message: "HM040: Only approved orders" },
                  };
                }
                if (item.amount_krw !== order.amount_krw) {
                  return {
                    data: null,
                    error: { code: "22023", message: "HM041: Amount mismatch" },
                  };
                }
              }
              const row = {
                id: item.id ?? `00000000-0000-4000-a000-${String(arr.length + 1).padStart(12, "0")}`,
                requested_at: item.requested_at ?? new Date().toISOString(),
                completed_at: item.completed_at ?? null,
                provider_cancel_id: item.provider_cancel_id ?? null,
                failure_reason: item.failure_reason ?? null,
                created_at: item.created_at ?? new Date().toISOString(),
                ...item,
              };
              arr.push(row);
              inserted.push({ ...row });
            }
            return { data: Array.isArray(payload) ? inserted : inserted[0], error: null };
          }

          if (op === "update") {
            if (
              table === "payment_refunds" &&
              payload.status === "succeeded" &&
              store.failRefundUpdateAfterToss
            ) {
              return {
                data: null,
                error: { code: "08006", message: "simulated DB connection lost" },
              };
            }

            const matched = filterRows(arr, filters);
            const updated: any[] = [];
            for (const row of matched) {
              if (table === "payment_refunds") {
                if (row.status === "succeeded" && payload.status && payload.status !== "succeeded") {
                  return {
                    data: null,
                    error: { code: "22023", message: "HM044: Succeeded refund is terminal" },
                  };
                }
                if (payload.status === "succeeded" && !payload.provider_cancel_id) {
                  return {
                    data: null,
                    error: { code: "22023", message: "HM051: provider_cancel_id required" },
                  };
                }
              }
              Object.assign(row, payload);
              updated.push({ ...row });
            }
            return { data: updated, error: null };
          }

          return { data: null, error: null };
        };

        const chain: any = {
          eq(col: string, val: any) {
            filters.push({ type: "eq", col, val });
            return chain;
          },
          neq(col: string, val: any) {
            filters.push({ type: "neq", col, val });
            return chain;
          },
          in(col: string, val: any[]) {
            filters.push({ type: "in", col, val });
            return chain;
          },
          order(col: string, opts: { ascending: boolean }) {
            orderBy = { col, ascending: opts.ascending };
            return chain;
          },
          range(from: number, to: number) {
            rangeSlice = [from, to];
            return chain;
          },
          select() {
            return chain;
          },
          async maybeSingle() {
            const res = await execute();
            if (res.error) return { data: null, error: res.error };
            const first = Array.isArray(res.data) ? res.data[0] ?? null : res.data;
            return { data: first, error: null };
          },
          async single() {
            const res = await execute();
            if (res.error) return { data: null, error: res.error };
            const first = Array.isArray(res.data) ? res.data[0] ?? null : res.data;
            if (!first) {
              return { data: null, error: { code: "PGRST116", message: "0 rows" } };
            }
            return { data: first, error: null };
          },
          then(resolve: any, reject: any) {
            return execute().then(resolve, reject);
          },
        };
        return chain;
      };

      return {
        select() {
          return buildChain("select");
        },
        insert(payload: any) {
          return buildChain("insert", payload);
        },
        update(payload: any) {
          return buildChain("update", payload);
        },
      };
    },
  };
}

function makeTossDonePayment(
  overrides: Partial<TossPaymentWithCancelsResponse> = {}
): TossPaymentWithCancelsResponse {
  return {
    paymentKey: "tgen_test_paykey_001",
    orderId: "hm_ord_test_001",
    status: "DONE",
    totalAmount: 1000,
    balanceAmount: 1000,
    cancels: null,
    ...overrides,
  };
}

function makeTossCanceledPayment(
  overrides: Partial<TossPaymentWithCancelsResponse> = {}
): TossPaymentWithCancelsResponse {
  return {
    paymentKey: "tgen_test_paykey_001",
    orderId: "hm_ord_test_001",
    status: "CANCELED",
    totalAmount: 1000,
    balanceAmount: 0,
    cancels: [
      {
        transactionKey: "tx_cancel_001",
        cancelAmount: 1000,
        cancelReason: FIXED_TEST_CANCEL_REASON,
        canceledAt: new Date().toISOString(),
        cancelStatus: "DONE",
      },
    ],
    ...overrides,
  };
}

describe("TASK 30: Approved Receipt Test Refund Server API (20 Scenarios)", () => {
  const originalEnv = process.env;
  let store: MockStore;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.PAYMENT_MODE = "test";
    process.env.TOSS_TEST_SECRET_KEY = "test_sk_mock_secret_do_not_leak";
    store = createSeededStore();
    vi.mocked(isSupabaseAuthConfigured).mockReturnValue(true);
    vi.mocked(createAdminClient).mockReturnValue(createMockSupabaseAdmin(store) as any);
  });

  // Scenario 1
  it("1. 관리자의 정상 환급 요청 — 전액 취소 성공, audit_logs 기록, 비밀키 미노출", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      user: { id: IDS.admin1 } as any,
      roles: ["admin"],
      isAdmin: true,
      isMerchant: false,
      displayName: "관리자1",
      accountStatus: "active",
      profileExists: true,
      sessionExpired: false,
      configReady: true,
    });

    const mockToss: ITossRefundClient = {
      getPaymentByPaymentKey: vi.fn().mockResolvedValue(makeTossDonePayment()),
      cancelPayment: vi.fn().mockResolvedValue(makeTossCanceledPayment()),
    };

    const result = await requestAdminRefund({
      adminUserId: IDS.admin1,
      paymentOrderId: IDS.order1,
      receiptSubmissionId: IDS.receipt1,
      idempotencyKey: "refund_idem_0001",
      tossClient: mockToss,
      injectedAdminClient: createMockSupabaseAdmin(store),
    });

    expect(result.reused).toBe(false);
    expect(result.outcome).toBe("succeeded");
    expect(result.refund.status).toBe("succeeded");
    expect(result.refund.amount_krw).toBe(1000);
    expect((result.refund as any).provider_cancel_id).toBeUndefined();
    expect((result.refund as any).idempotency_key).toBeUndefined();

    expect(mockToss.getPaymentByPaymentKey).toHaveBeenCalledWith("tgen_test_paykey_001");
    expect(mockToss.cancelPayment).toHaveBeenCalledWith({
      paymentKey: "tgen_test_paykey_001",
      cancelReason: FIXED_TEST_CANCEL_REASON,
      idempotencyKey: "refund_idem_0001",
    });

    const actions = store.audit_logs.map((a) => a.action);
    expect(actions).toContain("refund_requested");
    expect(actions).toContain("refund_toss_cancel_requested");
    expect(actions).toContain("refund_toss_cancel_succeeded");
  });

  // Scenario 2
  it("2. 비로그인 사용자 차단 — 401 UNAUTHORIZED", async () => {
    vi.mocked(requireRole).mockRejectedValueOnce(
      new AuthGuardError("UNAUTHORIZED", 401, "로그인이 필요한 기능입니다.")
    );

    const req = new Request(
      `http://localhost:3000/api/v1/admin/refunds/${IDS.order1}/request`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          receiptSubmissionId: IDS.receipt1,
          idempotencyKey: "refund_idem_0002",
        }),
      }
    );

    const res = await handlePostRefund(req, {
      params: Promise.resolve({ paymentOrderId: IDS.order1 }),
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("UNAUTHORIZED");
  });

  // Scenario 3
  it("3. 비관리자 차단 — route 403 FORBIDDEN 및 service 계층 정지/비관리자 차단", async () => {
    vi.mocked(requireRole).mockRejectedValueOnce(
      new AuthGuardError("FORBIDDEN", 403, "접근 권한이 없습니다.")
    );

    const req = new Request(
      `http://localhost:3000/api/v1/admin/refunds/${IDS.order1}/request`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          receiptSubmissionId: IDS.receipt1,
          idempotencyKey: "refund_idem_0003",
        }),
      }
    );

    const res = await handlePostRefund(req, {
      params: Promise.resolve({ paymentOrderId: IDS.order1 }),
    });
    expect(res.status).toBe(403);

    // Service-level defense in depth for customer & suspended admin
    const mockToss: ITossRefundClient = {
      getPaymentByPaymentKey: vi.fn(),
      cancelPayment: vi.fn(),
    };

    await expect(
      requestAdminRefund({
        adminUserId: IDS.customer,
        paymentOrderId: IDS.order1,
        receiptSubmissionId: IDS.receipt1,
        idempotencyKey: "refund_idem_0003_svc",
        tossClient: mockToss,
        injectedAdminClient: createMockSupabaseAdmin(store),
      })
    ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });

    await expect(
      requestAdminRefund({
        adminUserId: IDS.inactiveAdmin,
        paymentOrderId: IDS.order1,
        receiptSubmissionId: IDS.receipt1,
        idempotencyKey: "refund_idem_0003_susp",
        tossClient: mockToss,
        injectedAdminClient: createMockSupabaseAdmin(store),
      })
    ).rejects.toMatchObject({ statusCode: 403, code: "ACCOUNT_SUSPENDED" });

    expect(mockToss.cancelPayment).not.toHaveBeenCalled();
  });

  // Scenario 4
  it("4. 미승인 영수증 환급 거부 — 422 RECEIPT_NOT_APPROVED", async () => {
    const mockToss: ITossRefundClient = {
      getPaymentByPaymentKey: vi.fn(),
      cancelPayment: vi.fn(),
    };

    await expect(
      requestAdminRefund({
        adminUserId: IDS.admin1,
        paymentOrderId: IDS.order1,
        receiptSubmissionId: IDS.receiptPending,
        idempotencyKey: "refund_idem_0004",
        tossClient: mockToss,
        injectedAdminClient: createMockSupabaseAdmin(store),
      })
    ).rejects.toMatchObject({ statusCode: 422, code: "RECEIPT_NOT_APPROVED" });

    expect(mockToss.cancelPayment).not.toHaveBeenCalled();
    expect(store.audit_logs.some((a) => a.action === "refund_precheck_failed")).toBe(true);
  });

  // Scenario 5
  it("5. 존재하지 않는 영수증 거부 — 404 RECEIPT_NOT_FOUND", async () => {
    const mockToss: ITossRefundClient = {
      getPaymentByPaymentKey: vi.fn(),
      cancelPayment: vi.fn(),
    };

    await expect(
      requestAdminRefund({
        adminUserId: IDS.admin1,
        paymentOrderId: IDS.order1,
        receiptSubmissionId: IDS.receiptMissing,
        idempotencyKey: "refund_idem_0005",
        tossClient: mockToss,
        injectedAdminClient: createMockSupabaseAdmin(store),
      })
    ).rejects.toMatchObject({ statusCode: 404, code: "RECEIPT_NOT_FOUND" });

    expect(mockToss.cancelPayment).not.toHaveBeenCalled();
  });

  // Scenario 6
  it("6. 실패한 결제 주문 환급 거부 — 422 PAYMENT_ORDER_NOT_APPROVED", async () => {
    const mockToss: ITossRefundClient = {
      getPaymentByPaymentKey: vi.fn(),
      cancelPayment: vi.fn(),
    };

    await expect(
      requestAdminRefund({
        adminUserId: IDS.admin1,
        paymentOrderId: IDS.orderFailed,
        receiptSubmissionId: IDS.receipt1,
        idempotencyKey: "refund_idem_0006",
        tossClient: mockToss,
        injectedAdminClient: createMockSupabaseAdmin(store),
      })
    ).rejects.toMatchObject({ statusCode: 422, code: "PAYMENT_ORDER_NOT_APPROVED" });

    expect(mockToss.cancelPayment).not.toHaveBeenCalled();
  });

  // Scenario 7
  it("7. 테스트 거래가 아닌 주문 거부 & live_ API 키 차단", async () => {
    const mockToss: ITossRefundClient = {
      getPaymentByPaymentKey: vi.fn(),
      cancelPayment: vi.fn(),
    };

    // Non-test payment_mode in DB
    await expect(
      requestAdminRefund({
        adminUserId: IDS.admin1,
        paymentOrderId: IDS.orderNonTest,
        receiptSubmissionId: IDS.receiptOtherApproved,
        idempotencyKey: "refund_idem_0007",
        tossClient: mockToss,
        injectedAdminClient: createMockSupabaseAdmin(store),
      })
    ).rejects.toMatchObject({ statusCode: 422, code: "NON_TEST_PAYMENT_FORBIDDEN" });

    // Live Toss secret key blocked
    process.env.TOSS_TEST_SECRET_KEY = "live_sk_forbidden_key_12345";
    await expect(
      requestAdminRefund({
        adminUserId: IDS.admin1,
        paymentOrderId: IDS.order1,
        receiptSubmissionId: IDS.receipt1,
        idempotencyKey: "refund_idem_0007_live",
        tossClient: mockToss,
        injectedAdminClient: createMockSupabaseAdmin(store),
      })
    ).rejects.toBeInstanceOf(PaymentConfigError);

    // PAYMENT_MODE=live blocked
    process.env.TOSS_TEST_SECRET_KEY = "test_sk_mock_secret_do_not_leak";
    process.env.PAYMENT_MODE = "live";
    await expect(
      requestAdminRefund({
        adminUserId: IDS.admin1,
        paymentOrderId: IDS.order1,
        receiptSubmissionId: IDS.receipt1,
        idempotencyKey: "refund_idem_0007_mode",
        tossClient: mockToss,
        injectedAdminClient: createMockSupabaseAdmin(store),
      })
    ).rejects.toMatchObject({ code: "SECURITY_VIOLATION_LIVE_MODE" });

    expect(mockToss.cancelPayment).not.toHaveBeenCalled();
  });

  // Scenario 8
  it("8. 결제 주문과 영수증 연결 불일치 거부 — 422 RECEIPT_ORDER_MISMATCH", async () => {
    const mockToss: ITossRefundClient = {
      getPaymentByPaymentKey: vi.fn(),
      cancelPayment: vi.fn(),
    };

    await expect(
      requestAdminRefund({
        adminUserId: IDS.admin1,
        paymentOrderId: IDS.order1,
        receiptSubmissionId: IDS.receiptOtherApproved, // belongs to session2/customer2!
        idempotencyKey: "refund_idem_0008",
        tossClient: mockToss,
        injectedAdminClient: createMockSupabaseAdmin(store),
      })
    ).rejects.toMatchObject({ statusCode: 422, code: "RECEIPT_ORDER_MISMATCH" });

    expect(mockToss.cancelPayment).not.toHaveBeenCalled();
  });

  // Scenario 9
  it("9. 동일 주문 중복 요청 차단 — 완료 후 새 키 거부 409, 동일 키는 PG 미호출 재반환", async () => {
    const mockToss: ITossRefundClient = {
      getPaymentByPaymentKey: vi.fn().mockResolvedValue(makeTossDonePayment()),
      cancelPayment: vi.fn().mockResolvedValue(makeTossCanceledPayment()),
    };
    const adminClient = createMockSupabaseAdmin(store);

    const first = await requestAdminRefund({
      adminUserId: IDS.admin1,
      paymentOrderId: IDS.order1,
      receiptSubmissionId: IDS.receipt1,
      idempotencyKey: "refund_idem_0009_a",
      tossClient: mockToss,
      injectedAdminClient: adminClient,
    });
    expect(first.refund.status).toBe("succeeded");

    // Different key -> blocked 409
    await expect(
      requestAdminRefund({
        adminUserId: IDS.admin1,
        paymentOrderId: IDS.order1,
        receiptSubmissionId: IDS.receipt1,
        idempotencyKey: "refund_idem_0009_b",
        tossClient: mockToss,
        injectedAdminClient: adminClient,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "REFUND_ALREADY_SUCCEEDED" });

    // Same key -> idempotent replay without calling Toss cancel again
    const replay = await requestAdminRefund({
      adminUserId: IDS.admin1,
      paymentOrderId: IDS.order1,
      receiptSubmissionId: IDS.receipt1,
      idempotencyKey: "refund_idem_0009_a",
      tossClient: mockToss,
      injectedAdminClient: adminClient,
    });
    expect(replay.reused).toBe(true);
    expect(replay.outcome).toBe("already_succeeded");
    expect(mockToss.cancelPayment).toHaveBeenCalledTimes(1);
  });

  // Scenario 10
  it("10. 서로 다른 관리자 동시 요청 — 단 1건만 취소 실행, 나머지 409 차단", async () => {
    let cancelCalls = 0;
    const mockToss: ITossRefundClient = {
      getPaymentByPaymentKey: vi.fn().mockResolvedValue(makeTossDonePayment()),
      cancelPayment: vi.fn().mockImplementation(async () => {
        cancelCalls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return makeTossCanceledPayment();
      }),
    };
    const adminClient = createMockSupabaseAdmin(store);

    const [res1, res2] = await Promise.allSettled([
      requestAdminRefund({
        adminUserId: IDS.admin1,
        paymentOrderId: IDS.order1,
        receiptSubmissionId: IDS.receipt1,
        idempotencyKey: "refund_idem_admin1_conc",
        tossClient: mockToss,
        injectedAdminClient: adminClient,
      }),
      requestAdminRefund({
        adminUserId: IDS.admin2,
        paymentOrderId: IDS.order1,
        receiptSubmissionId: IDS.receipt1,
        idempotencyKey: "refund_idem_admin2_conc",
        tossClient: mockToss,
        injectedAdminClient: adminClient,
      }),
    ]);

    const fulfilled = [res1, res2].filter((r) => r.status === "fulfilled");
    const rejected = [res1, res2].filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      statusCode: 409,
    });
    expect(cancelCalls).toBe(1);
    expect(store.payment_refunds).toHaveLength(1);
  });

  // Scenario 11
  it("11. 다른 영수증에서 동일 주문 환급 시도 — 409 DUPLICATE_REFUND_FOR_ORDER 차단", async () => {
    // Even if another approved receipt somehow exists on same session/user
    const receiptAltId = "66666666-6666-4666-a666-666666666609";
    store.receipt_submissions.push({
      id: receiptAltId,
      access_session_id: IDS.session1,
      user_id: IDS.customer,
      storage_path: `receipts/${IDS.customer}/${IDS.session1}/alt.jpg`,
      submission_status: "approved",
      reviewed_by: IDS.admin1,
      reviewed_at: "2026-11-16T01:05:00.000Z",
    });

    const mockToss: ITossRefundClient = {
      getPaymentByPaymentKey: vi.fn().mockResolvedValue(makeTossDonePayment()),
      cancelPayment: vi.fn().mockResolvedValue(makeTossCanceledPayment()),
    };
    const adminClient = createMockSupabaseAdmin(store);

    await requestAdminRefund({
      adminUserId: IDS.admin1,
      paymentOrderId: IDS.order1,
      receiptSubmissionId: IDS.receipt1,
      idempotencyKey: "refund_idem_0011_first",
      tossClient: mockToss,
      injectedAdminClient: adminClient,
    });

    await expect(
      requestAdminRefund({
        adminUserId: IDS.admin1,
        paymentOrderId: IDS.order1,
        receiptSubmissionId: receiptAltId,
        idempotencyKey: "refund_idem_0011_second",
        tossClient: mockToss,
        injectedAdminClient: adminClient,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "DUPLICATE_REFUND_FOR_ORDER" });

    expect(mockToss.cancelPayment).toHaveBeenCalledTimes(1);
  });

  // Scenario 12
  it("12. 서버 재시작 후 동일 요청 재사용 — DB 영구 상태 기반 멱등 재사용 및 기존 키 유지", async () => {
    const adminClient1 = createMockSupabaseAdmin(store);
    const mockToss1: ITossRefundClient = {
      getPaymentByPaymentKey: vi.fn().mockResolvedValue(makeTossDonePayment()),
      cancelPayment: vi.fn().mockResolvedValue(makeTossCanceledPayment()),
    };

    await requestAdminRefund({
      adminUserId: IDS.admin1,
      paymentOrderId: IDS.order1,
      receiptSubmissionId: IDS.receipt1,
      idempotencyKey: "refund_idem_restart_012",
      tossClient: mockToss1,
      injectedAdminClient: adminClient1,
    });

    // Simulate brand-new server instance with fresh client reading same persisted store
    const adminClient2 = createMockSupabaseAdmin(store);
    const mockToss2: ITossRefundClient = {
      getPaymentByPaymentKey: vi.fn(),
      cancelPayment: vi.fn(),
    };

    const replayed = await requestAdminRefund({
      adminUserId: IDS.admin2,
      paymentOrderId: IDS.order1,
      receiptSubmissionId: IDS.receipt1,
      idempotencyKey: "refund_idem_restart_012",
      tossClient: mockToss2,
      injectedAdminClient: adminClient2,
    });

    expect(replayed.reused).toBe(true);
    expect(replayed.outcome).toBe("already_succeeded");
    expect(mockToss2.cancelPayment).not.toHaveBeenCalled();
  });

  // Scenario 13
  it("13. Toss API 타임아웃 — 실패 단정 금지, processing 불확실 상태 보존 및 감사로그", async () => {
    const mockToss: ITossRefundClient = {
      getPaymentByPaymentKey: vi
        .fn()
        .mockResolvedValueOnce(makeTossDonePayment())
        .mockRejectedValueOnce(
          new TossPaymentError("PG_TIMEOUT", "timeout", 504, { isRetryable: true })
        ),
      cancelPayment: vi
        .fn()
        .mockRejectedValueOnce(
          new TossPaymentError("PG_TIMEOUT", "timeout", 504, { isRetryable: true })
        ),
    };
    const adminClient = createMockSupabaseAdmin(store);

    await expect(
      requestAdminRefund({
        adminUserId: IDS.admin1,
        paymentOrderId: IDS.order1,
        receiptSubmissionId: IDS.receipt1,
        idempotencyKey: "refund_idem_timeout_013",
        tossClient: mockToss,
        injectedAdminClient: adminClient,
      })
    ).rejects.toMatchObject({ statusCode: 504, code: "PG_REFUND_TIMEOUT_UNCERTAIN" });

    expect(store.payment_refunds).toHaveLength(1);
    expect(store.payment_refunds[0].status).toBe("processing");
    expect(store.payment_refunds[0].failure_reason).toContain("UNCERTAIN_TIMEOUT");
    expect(store.audit_logs.some((a) => a.action === "refund_toss_timeout_uncertain")).toBe(true);
  });

  // Scenario 14
  it("14. Toss 성공 후 로컬 DB 기록 실패 — failed 덮어쓰기 금지, 재시도/재조회로 안전 복구", async () => {
    store.failRefundUpdateAfterToss = true;
    const mockToss1: ITossRefundClient = {
      getPaymentByPaymentKey: vi.fn().mockResolvedValue(makeTossDonePayment()),
      cancelPayment: vi.fn().mockResolvedValue(makeTossCanceledPayment()),
    };
    const adminClient = createMockSupabaseAdmin(store);

    await expect(
      requestAdminRefund({
        adminUserId: IDS.admin1,
        paymentOrderId: IDS.order1,
        receiptSubmissionId: IDS.receipt1,
        idempotencyKey: "refund_idem_dbfail_014",
        tossClient: mockToss1,
        injectedAdminClient: adminClient,
      })
    ).rejects.toMatchObject({ statusCode: 500, code: "DB_REFUND_UPDATE_FAILED" });

    // Remains requested (NOT failed)
    expect(store.payment_refunds[0].status).toBe("requested");

    // DB recovers -> reconcile / retry recovers without calling cancelPayment again
    store.failRefundUpdateAfterToss = false;
    const mockToss2: ITossRefundClient = {
      getPaymentByPaymentKey: vi.fn().mockResolvedValue(makeTossCanceledPayment()),
      cancelPayment: vi.fn(),
    };

    const recovered = await requestAdminRefund({
      adminUserId: IDS.admin1,
      paymentOrderId: IDS.order1,
      receiptSubmissionId: IDS.receipt1,
      idempotencyKey: "refund_idem_dbfail_014",
      tossClient: mockToss2,
      injectedAdminClient: adminClient,
    });

    expect(recovered.refund.status).toBe("succeeded");
    expect(recovered.outcome).toBe("reconciled_succeeded");
    expect(mockToss2.cancelPayment).not.toHaveBeenCalled();
  });

  // Scenario 15
  it("15. Toss 응답과 DB 금액 불일치 — 사전 조회 및 취소 응답 불일치 모두 완료 차단", async () => {
    const adminClient = createMockSupabaseAdmin(store);

    // Precheck mismatch
    const mockTossPreMismatch: ITossRefundClient = {
      getPaymentByPaymentKey: vi
        .fn()
        .mockResolvedValue(makeTossDonePayment({ totalAmount: 5000 })),
      cancelPayment: vi.fn(),
    };

    await expect(
      requestAdminRefund({
        adminUserId: IDS.admin1,
        paymentOrderId: IDS.order1,
        receiptSubmissionId: IDS.receipt1,
        idempotencyKey: "refund_idem_mismatch_015a",
        tossClient: mockTossPreMismatch,
        injectedAdminClient: adminClient,
      })
    ).rejects.toMatchObject({ statusCode: 422, code: "PG_ORDER_MISMATCH" });
    expect(mockTossPreMismatch.cancelPayment).not.toHaveBeenCalled();

    // Cancel response cancelAmount mismatch (new store)
    const store2 = createSeededStore();
    const mockTossCancelMismatch: ITossRefundClient = {
      getPaymentByPaymentKey: vi.fn().mockResolvedValue(makeTossDonePayment()),
      cancelPayment: vi.fn().mockResolvedValue(
        makeTossCanceledPayment({
          cancels: [
            {
              transactionKey: "tx_bad_amt",
              cancelAmount: 500,
              cancelStatus: "DONE",
            },
          ],
        })
      ),
    };

    await expect(
      requestAdminRefund({
        adminUserId: IDS.admin1,
        paymentOrderId: IDS.order1,
        receiptSubmissionId: IDS.receipt1,
        idempotencyKey: "refund_idem_mismatch_015b",
        tossClient: mockTossCancelMismatch,
        injectedAdminClient: createMockSupabaseAdmin(store2),
      })
    ).rejects.toMatchObject({ statusCode: 422, code: "PG_CANCEL_AMOUNT_MISMATCH" });
    expect(store2.payment_refunds[0].status).not.toBe("succeeded");
  });

  // Scenario 16
  it("16. 이미 취소된 PG 거래 처리 — DB 환급 이력 없으면 불일치 감지 후 완료/신규취소 차단", async () => {
    const mockToss: ITossRefundClient = {
      getPaymentByPaymentKey: vi.fn().mockResolvedValue(makeTossCanceledPayment()),
      cancelPayment: vi.fn(),
    };
    const adminClient = createMockSupabaseAdmin(store);

    await expect(
      requestAdminRefund({
        adminUserId: IDS.admin1,
        paymentOrderId: IDS.order1,
        receiptSubmissionId: IDS.receipt1,
        idempotencyKey: "refund_idem_already_pg_016",
        tossClient: mockToss,
        injectedAdminClient: adminClient,
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "PG_ALREADY_CANCELED_STATE_MISMATCH",
    });

    expect(mockToss.cancelPayment).not.toHaveBeenCalled();
    expect(store.payment_refunds[0].status).toBe("processing");
    expect(store.payment_refunds[0].failure_reason).toContain("PG_ALREADY_CANCELED_UNLINKED");
  });

  // Scenario 17
  it("17. 부분 취소된 PG 거래 거부 — 422 PARTIAL_CANCELED_NOT_SUPPORTED", async () => {
    const mockToss: ITossRefundClient = {
      getPaymentByPaymentKey: vi.fn().mockResolvedValue({
        paymentKey: "tgen_test_paykey_001",
        orderId: "hm_ord_test_001",
        status: "PARTIAL_CANCELED",
        totalAmount: 1000,
        balanceAmount: 500,
        cancels: [
          {
            transactionKey: "tx_part_001",
            cancelAmount: 500,
            cancelStatus: "DONE",
          },
        ],
      }),
      cancelPayment: vi.fn(),
    };

    await expect(
      requestAdminRefund({
        adminUserId: IDS.admin1,
        paymentOrderId: IDS.order1,
        receiptSubmissionId: IDS.receipt1,
        idempotencyKey: "refund_idem_partial_017",
        tossClient: mockToss,
        injectedAdminClient: createMockSupabaseAdmin(store),
      })
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "PARTIAL_CANCELED_NOT_SUPPORTED",
    });

    expect(mockToss.cancelPayment).not.toHaveBeenCalled();
  });

  // Scenario 18
  it("18. 불확실 상태에서 결제 재조회 — 409/타임아웃 후 reconcileAdminRefund 및 재요청 복구", async () => {
    store.payment_refunds.push({
      id: "88888888-8888-4888-a888-888888888801",
      payment_order_id: IDS.order1,
      receipt_submission_id: IDS.receipt1,
      amount_krw: 1000,
      status: "processing",
      idempotency_key: "refund_idem_uncertain_018",
      requested_by: IDS.admin1,
      provider_cancel_id: null,
      failure_reason: "UNCERTAIN_409_PROCESSING: check",
      requested_at: new Date().toISOString(),
      completed_at: null,
    });

    const mockToss: ITossRefundClient = {
      getPaymentByPaymentKey: vi.fn().mockResolvedValue(makeTossCanceledPayment()),
      cancelPayment: vi.fn(),
    };

    const res = await reconcileAdminRefund({
      adminUserId: IDS.admin2,
      paymentOrderId: IDS.order1,
      tossClient: mockToss,
      injectedAdminClient: createMockSupabaseAdmin(store),
    });

    expect(res.reconciled).toBe(true);
    expect(res.pgStatus).toBe("CANCELED");
    expect(res.refund.status).toBe("succeeded");
    expect(mockToss.cancelPayment).not.toHaveBeenCalled();
    expect(store.audit_logs.some((a) => a.action === "refund_reconcile_result")).toBe(true);
  });

  // Scenario 19
  it("19. 15일 이상 지난 불확실 요청의 안전한 처리 — 자동 재취소 금지 및 연관성 미확정 시 수동 확인 유지", async () => {
    const sixteenDaysAgo = new Date(
      Date.now() - TOSS_IDEMPOTENCY_TTL_MS - 24 * 60 * 60 * 1000
    ).toISOString();

    store.payment_refunds.push({
      id: "88888888-8888-4888-a888-888888888802",
      payment_order_id: IDS.order1,
      receipt_submission_id: IDS.receipt1,
      amount_krw: 1000,
      status: "processing",
      idempotency_key: "refund_idem_expired_019",
      requested_by: IDS.admin1,
      provider_cancel_id: null,
      failure_reason: "UNCERTAIN_TIMEOUT: old",
      requested_at: sixteenDaysAgo,
      completed_at: null,
    });

    // Case A: Toss still DONE after 16 days -> NEVER re-call cancelPayment!
    const mockTossStillDone: ITossRefundClient = {
      getPaymentByPaymentKey: vi.fn().mockResolvedValue(makeTossDonePayment()),
      cancelPayment: vi.fn(),
    };
    const adminClient = createMockSupabaseAdmin(store);

    await expect(
      requestAdminRefund({
        adminUserId: IDS.admin1,
        paymentOrderId: IDS.order1,
        receiptSubmissionId: IDS.receipt1,
        idempotencyKey: "refund_idem_expired_019",
        tossClient: mockTossStillDone,
        injectedAdminClient: adminClient,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "MANUAL_VERIFICATION_REQUIRED" });
    expect(mockTossStillDone.cancelPayment).not.toHaveBeenCalled();
    expect(store.payment_refunds[0].failure_reason).toContain("MANUAL_CHECK_REQUIRED");

    // Case B: Toss shows CANCELED after 16 days with unrelated cancelReason -> kept for manual verification
    const mockTossAmbiguousCancel: ITossRefundClient = {
      getPaymentByPaymentKey: vi.fn().mockResolvedValue(
        makeTossCanceledPayment({
          cancels: [
            {
              transactionKey: "tx_unknown",
              cancelAmount: 1000,
              cancelReason: "고객 변심 수동 취소",
              canceledAt: new Date().toISOString(),
              cancelStatus: "DONE",
            },
          ],
        })
      ),
      cancelPayment: vi.fn(),
    };

    await expect(
      requestAdminRefund({
        adminUserId: IDS.admin1,
        paymentOrderId: IDS.order1,
        receiptSubmissionId: IDS.receipt1,
        idempotencyKey: "refund_idem_expired_019",
        tossClient: mockTossAmbiguousCancel,
        injectedAdminClient: adminClient,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "MANUAL_VERIFICATION_REQUIRED" });
    expect(store.payment_refunds[0].status).toBe("processing");
  });

  // Scenario 20
  it("20. 개인정보 및 Secret Key 미노출 — API 응답, 목록, 감사로그 전수 검사", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      user: { id: IDS.admin1 } as any,
      roles: ["admin"],
      isAdmin: true,
      isMerchant: false,
      displayName: "관리자1",
      accountStatus: "active",
      profileExists: true,
      sessionExpired: false,
      configReady: true,
    });

    // Test Toss client Auth header & no cancelAmount in body
    const capturedRequests: Array<{ url: string; headers: any; body?: string }> = [];
    const realFetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedRequests.push({
        url: String(input),
        headers: init?.headers,
        body: init?.body ? String(init.body) : undefined,
      });
      if (String(input).endsWith("/cancel")) {
        return new Response(JSON.stringify(makeTossCanceledPayment()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(makeTossDonePayment()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = new DefaultTossRefundClient({
      secretKey: "test_sk_mock_secret_do_not_leak",
      fetcher: realFetchMock,
    });

    const tossRes = await client.cancelPayment({
      paymentKey: "tgen_test_paykey_001",
      cancelReason: FIXED_TEST_CANCEL_REASON,
      idempotencyKey: "refund_idem_0020",
    });
    expect(tossRes.status).toBe("CANCELED");

    const cancelCall = capturedRequests[0];
    expect(cancelCall.url).toContain("/payments/tgen_test_paykey_001/cancel");
    expect(cancelCall.headers["Idempotency-Key"]).toBe("refund_idem_0020");
    expect(cancelCall.headers["Authorization"]).toMatch(/^Basic /);
    expect(JSON.parse(cancelCall.body!)).toEqual({
      cancelReason: FIXED_TEST_CANCEL_REASON,
    });
    expect(JSON.parse(cancelCall.body!)).not.toHaveProperty("cancelAmount");

    // Seed refund & audit log and verify GET /api/v1/admin/refunds & audit_logs leak zero secrets
    store.payment_refunds.push({
      id: "88888888-8888-4888-a888-888888888820",
      payment_order_id: IDS.order1,
      receipt_submission_id: IDS.receipt1,
      amount_krw: 1000,
      status: "succeeded",
      idempotency_key: "refund_idem_0020",
      requested_by: IDS.admin1,
      provider_cancel_id: "tx_secret_cancel_id_020",
      failure_reason: null,
      requested_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });

    const listRes = await handleGetRefunds(
      new Request("http://localhost:3000/api/v1/admin/refunds?status=succeeded")
    );
    expect(listRes.status).toBe(200);
    const listText = await listRes.text();
    expect(listText).not.toContain("test_sk_");
    expect(listText).not.toContain("tgen_test_paykey_001");
    expect(listText).not.toContain("tx_secret_cancel_id_020");
    expect(listText).not.toContain("refund_idem_0020");
    expect(listText).not.toContain("010-1234-5678");
    expect(listText).not.toContain("secret-receipt.jpg");

    const auditSerialized = JSON.stringify(store.audit_logs);
    expect(auditSerialized).not.toContain("test_sk_");
    expect(auditSerialized).not.toContain("tgen_test_paykey_001");
    expect(auditSerialized).not.toContain("010-1234-5678");
    expect(auditSerialized).not.toContain("secret-receipt.jpg");
  });

  // Extra security checks: tampered request body, HTTP 409 processing, route reconcile, verifyTossFullCancellation
  it("추가 검증: 클라이언트 paymentKey/amount 변조 차단 & Toss 409 processing 재조회 처리", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      user: { id: IDS.admin1 } as any,
      roles: ["admin"],
      isAdmin: true,
      isMerchant: false,
      displayName: "관리자1",
      accountStatus: "active",
      profileExists: true,
      sessionExpired: false,
      configReady: true,
    });

    // Reject client-supplied paymentKey or amount
    const tamperedReq = new Request(
      `http://localhost:3000/api/v1/admin/refunds/${IDS.order1}/request`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          receiptSubmissionId: IDS.receipt1,
          idempotencyKey: "refund_idem_tampered",
          paymentKey: "attacker_paykey",
          amount: 999999,
        }),
      }
    );
    const tamperedRes = await handlePostRefund(tamperedReq, {
      params: Promise.resolve({ paymentOrderId: IDS.order1 }),
    });
    expect(tamperedRes.status).toBe(400);

    // Toss 409 IDEMPOTENT_REQUEST_PROCESSING -> preserves processing state
    const mockToss409: ITossRefundClient = {
      getPaymentByPaymentKey: vi.fn().mockResolvedValue(makeTossDonePayment()),
      cancelPayment: vi.fn().mockRejectedValue(
        new TossPaymentError(
          "IDEMPOTENT_REQUEST_PROCESSING",
          "processing",
          409,
          { isProcessing: true, isRetryable: true }
        )
      ),
    };

    await expect(
      requestAdminRefund({
        adminUserId: IDS.admin1,
        paymentOrderId: IDS.order1,
        receiptSubmissionId: IDS.receipt1,
        idempotencyKey: "refund_idem_409_proc",
        tossClient: mockToss409,
        injectedAdminClient: createMockSupabaseAdmin(store),
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "PG_REFUND_PROCESSING" });
    expect(store.payment_refunds[0].status).toBe("processing");

    // Reconcile route works when refund exists
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeTossCanceledPayment()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

    const reconcileRes = await handleReconcileRefund(
      new Request(
        `http://localhost:3000/api/v1/admin/refunds/${IDS.order1}/reconcile`,
        { method: "POST" }
      ),
      { params: Promise.resolve({ paymentOrderId: IDS.order1 }) }
    );
    expect(reconcileRes.status).toBe(200);
    const recJson = await reconcileRes.json();
    expect(recJson.reconciled).toBe(true);
    expect(recJson.refund.status).toBe("succeeded");
    fetchSpy.mockRestore();

    // Direct listAdminRefunds check
    const listed = await listAdminRefunds({}, createMockSupabaseAdmin(store));
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].orderNumber).toBe("hm_ord_test_001");

    // verifyTossFullCancellation rejects HTTP 200 without CANCELED status
    const notCanceled = verifyTossFullCancellation({
      tossPayment: makeTossDonePayment(),
      expectedPaymentKey: "tgen_test_paykey_001",
      expectedOrderId: "hm_ord_test_001",
      expectedAmountKrw: 1000,
    });
    expect(notCanceled.valid).toBe(false);
  });
});

