import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  PAYMENT_PROVIDER,
  PAYMENT_MODE,
  PAYMENT_ORDER_STATUSES,
  PAYMENT_REFUND_STATUSES,
  createPaymentOrderSchema,
  approvePaymentOrderSchema,
  requestPaymentRefundSchema,
  toPublicPaymentOrder,
  toPublicPaymentRefund,
  isApprovedPaymentOrder,
  isTerminalPaymentOrderStatus,
  isTerminalPaymentRefundStatus,
  type PaymentOrderRow,
  type PaymentRefundRow,
} from "@/lib/payments/types";
import {
  ACCESS_SESSION_STATUSES,
  ACCESS_METHOD_SNAPSHOTS,
  createAccessSessionSchema,
  toPublicAccessSession,
  isAccessSessionActive,
  canRevealPin,
  isTerminalAccessSessionStatus,
  type AccessSessionRow,
} from "@/lib/access/types";

describe("TASK 20: Payment Schema & Types Static Verification", () => {
  describe("Payment Types and Guards", () => {
    it("enforces test-only payment mode and toss provider constants", () => {
      expect(PAYMENT_PROVIDER).toBe("toss");
      expect(PAYMENT_MODE).toBe("test");
      expect(PAYMENT_ORDER_STATUSES).toEqual([
        "created",
        "pending",
        "approved",
        "failed",
        "canceled",
      ]);
      expect(PAYMENT_REFUND_STATUSES).toEqual([
        "requested",
        "processing",
        "succeeded",
        "failed",
      ]);
    });

    it("validates createPaymentOrderSchema correctly", () => {
      const valid = {
        access_session_id: "11111111-1111-4111-a111-111111111111",
        user_id: "22222222-2222-4222-a222-222222222222",
        order_id: "order_test_20261114_001",
        amount_krw: 1000,
        idempotency_key: "idem_order_key_001_123456",
      };

      const parsed = createPaymentOrderSchema.safeParse(valid);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.provider).toBe("toss");
        expect(parsed.data.payment_mode).toBe("test");
      }

      // Rejects non-positive amounts
      expect(
        createPaymentOrderSchema.safeParse({ ...valid, amount_krw: 0 }).success
      ).toBe(false);
      expect(
        createPaymentOrderSchema.safeParse({ ...valid, amount_krw: -100 }).success
      ).toBe(false);

      // Rejects invalid UUID
      expect(
        createPaymentOrderSchema.safeParse({ ...valid, user_id: "not-a-uuid" }).success
      ).toBe(false);
    });

    it("toPublicPaymentOrder strictly strips provider_payment_key and idempotency_key", () => {
      const dbRow: PaymentOrderRow = {
        id: "11111111-1111-4111-a111-111111111111",
        access_session_id: "22222222-2222-4222-a222-222222222222",
        user_id: "33333333-3333-4333-a333-333333333333",
        order_id: "order_test_001",
        provider: "toss",
        payment_mode: "test",
        amount_krw: 1000,
        status: "approved",
        provider_payment_key: "toss_secret_payment_key_xyz",
        idempotency_key: "idem_test_123456",
        approved_at: new Date().toISOString(),
        failure_code: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const publicView = toPublicPaymentOrder(dbRow);
      expect(publicView).not.toHaveProperty("provider_payment_key");
      expect(publicView).not.toHaveProperty("idempotency_key");
      expect((publicView as Record<string, unknown>).provider_payment_key).toBeUndefined();
      expect((publicView as Record<string, unknown>).idempotency_key).toBeUndefined();
      expect(publicView.order_id).toBe("order_test_001");
      expect(publicView.amount_krw).toBe(1000);
      expect(publicView.status).toBe("approved");
    });

    it("toPublicPaymentRefund strictly strips provider_cancel_id, idempotency_key, and requested_by", () => {
      const dbRow: PaymentRefundRow = {
        id: "44444444-4444-4444-a444-444444444444",
        payment_order_id: "11111111-1111-4111-a111-111111111111",
        receipt_submission_id: null,
        amount_krw: 1000,
        status: "succeeded",
        idempotency_key: "refund_idem_secret_key",
        requested_by: "33333333-3333-4333-a333-333333333333",
        provider_cancel_id: "toss_cancel_id_secret_999",
        failure_reason: null,
        requested_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      };

      const publicView = toPublicPaymentRefund(dbRow);
      expect(publicView).not.toHaveProperty("provider_cancel_id");
      expect(publicView).not.toHaveProperty("idempotency_key");
      expect(publicView).not.toHaveProperty("requested_by");
      expect((publicView as Record<string, unknown>).provider_cancel_id).toBeUndefined();
      expect((publicView as Record<string, unknown>).idempotency_key).toBeUndefined();
      expect((publicView as Record<string, unknown>).requested_by).toBeUndefined();
      expect(publicView.amount_krw).toBe(1000);
      expect(publicView.status).toBe("succeeded");
    });

    it("correctly identifies approved and terminal payment states", () => {
      expect(isApprovedPaymentOrder({ status: "approved" })).toBe(true);
      expect(isApprovedPaymentOrder({ status: "created" })).toBe(false);
      expect(isApprovedPaymentOrder({ status: "pending" })).toBe(false);

      expect(isTerminalPaymentOrderStatus("failed")).toBe(true);
      expect(isTerminalPaymentOrderStatus("canceled")).toBe(true);
      expect(isTerminalPaymentOrderStatus("approved")).toBe(false);
      expect(isTerminalPaymentOrderStatus("created")).toBe(false);

      expect(isTerminalPaymentRefundStatus("succeeded")).toBe(true);
      expect(isTerminalPaymentRefundStatus("requested")).toBe(false);
      expect(isTerminalPaymentRefundStatus("processing")).toBe(false);
    });

    it("validates requestPaymentRefundSchema with admin check and positive amount", () => {
      const validRefund = {
        payment_order_id: "11111111-1111-4111-a111-111111111111",
        amount_krw: 1000,
        idempotency_key: "refund_idem_key_001_abcde",
        requested_by: "44444444-4444-4444-a444-444444444444",
      };

      expect(requestPaymentRefundSchema.safeParse(validRefund).success).toBe(true);
      expect(
        requestPaymentRefundSchema.safeParse({ ...validRefund, amount_krw: 0 }).success
      ).toBe(false);
      expect(
        requestPaymentRefundSchema.safeParse({ ...validRefund, amount_krw: -500 }).success
      ).toBe(false);
    });
  });

  describe("Access Session Types and Guards", () => {
    it("defines valid access statuses and method snapshots", () => {
      expect(ACCESS_SESSION_STATUSES).toEqual([
        "created",
        "authorized",
        "code_revealed",
        "completed",
        "failed",
        "expired",
        "canceled",
      ]);
      expect(ACCESS_METHOD_SNAPSHOTS).toEqual(["open", "ask_staff", "pin"]);
    });

    it("validates createAccessSessionSchema correctly", () => {
      const valid = {
        user_id: "11111111-1111-4111-a111-111111111111",
        restroom_id: "22222222-2222-4222-a222-222222222222",
        policy_id: "33333333-3333-4333-a333-333333333333",
        access_method_snapshot: "pin" as const,
        idempotency_key: "access_session_idem_key_001",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      };

      expect(createAccessSessionSchema.safeParse(valid).success).toBe(true);

      // Rejects invalid snapshot
      expect(
        createAccessSessionSchema.safeParse({
          ...valid,
          access_method_snapshot: "rfid_card",
        }).success
      ).toBe(false);
    });

    it("toPublicAccessSession strictly strips idempotency_key", () => {
      const dbRow: AccessSessionRow = {
        id: "11111111-1111-4111-a111-111111111111",
        user_id: "22222222-2222-4222-a222-222222222222",
        restroom_id: "33333333-3333-4333-a333-333333333333",
        policy_id: "44444444-4444-4444-a444-444444444444",
        status: "authorized",
        access_method_snapshot: "pin",
        idempotency_key: "access_session_idem_key_001",
        authorized_at: new Date().toISOString(),
        code_revealed_at: null,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const publicView = toPublicAccessSession(dbRow);
      expect(publicView).not.toHaveProperty("idempotency_key");
      expect((publicView as Record<string, unknown>).idempotency_key).toBeUndefined();
      expect(publicView.status).toBe("authorized");
      expect(publicView.access_method_snapshot).toBe("pin");
    });

    it("guards access session active state and PIN reveal qualification", () => {
      const now = new Date("2026-11-14T12:00:00Z");
      const futureExpiry = "2026-11-14T13:00:00Z";
      const pastExpiry = "2026-11-14T11:00:00Z";

      // Authorized + future expiry = active
      expect(
        isAccessSessionActive(
          { status: "authorized", expires_at: futureExpiry },
          now
        )
      ).toBe(true);

      // Code revealed + future expiry = active
      expect(
        isAccessSessionActive(
          { status: "code_revealed", expires_at: futureExpiry },
          now
        )
      ).toBe(true);

      // Created status is NOT active (payment not yet confirmed)
      expect(
        isAccessSessionActive(
          { status: "created", expires_at: futureExpiry },
          now
        )
      ).toBe(false);

      // Expired time is NOT active even if authorized
      expect(
        isAccessSessionActive(
          { status: "authorized", expires_at: pastExpiry },
          now
        )
      ).toBe(false);

      // canRevealPin requires active + method == 'pin'
      expect(
        canRevealPin(
          {
            status: "authorized",
            expires_at: futureExpiry,
            access_method_snapshot: "pin",
          },
          now
        )
      ).toBe(true);

      // Non-pin methods cannot reveal PIN
      expect(
        canRevealPin(
          {
            status: "authorized",
            expires_at: futureExpiry,
            access_method_snapshot: "ask_staff",
          },
          now
        )
      ).toBe(false);
      expect(
        canRevealPin(
          {
            status: "authorized",
            expires_at: futureExpiry,
            access_method_snapshot: "open",
          },
          now
        )
      ).toBe(false);

      // Expired PIN session cannot reveal PIN
      expect(
        canRevealPin(
          {
            status: "authorized",
            expires_at: pastExpiry,
            access_method_snapshot: "pin",
          },
          now
        )
      ).toBe(false);
    });

    it("identifies terminal access session states", () => {
      expect(isTerminalAccessSessionStatus("completed")).toBe(true);
      expect(isTerminalAccessSessionStatus("failed")).toBe(true);
      expect(isTerminalAccessSessionStatus("expired")).toBe(true);
      expect(isTerminalAccessSessionStatus("canceled")).toBe(true);
      expect(isTerminalAccessSessionStatus("created")).toBe(false);
      expect(isTerminalAccessSessionStatus("authorized")).toBe(false);
      expect(isTerminalAccessSessionStatus("code_revealed")).toBe(false);
    });
  });

  describe("SQL Migration File Static Inspection", () => {
    const migrationPath = path.resolve(
      process.cwd(),
      "supabase/migrations/20261114000000_payment_schema.sql"
    );
    const sql = fs.readFileSync(migrationPath, "utf-8").replace(/\r\n/g, "\n");

    it("defines access_sessions, payment_orders, and payment_refunds tables", () => {
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.access_sessions");
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.payment_orders");
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.payment_refunds");
    });

    it("contains required constraints and single approved payment order invariant", () => {
      expect(sql).toContain("chk_access_sessions_expiry CHECK (expires_at > created_at)");
      expect(sql).toContain("amount_krw integer NOT NULL CHECK (amount_krw > 0)");
      expect(sql).toContain("payment_mode text NOT NULL DEFAULT 'test' CHECK (payment_mode = 'test')");
      expect(sql).toContain("provider text NOT NULL DEFAULT 'toss' CHECK (provider = 'toss')");
      expect(sql).toContain("idx_payment_orders_single_approved_per_session");
      expect(sql).toContain("WHERE status = 'approved'");
      expect(sql).toContain("payment_order_id uuid NOT NULL REFERENCES public.payment_orders(id) ON DELETE RESTRICT UNIQUE");
    });

    it("connects event_logs.access_session_id foreign key with ON DELETE SET NULL", () => {
      expect(sql).toContain("fk_event_logs_access_session_id");
      expect(sql).toContain("FOREIGN KEY (access_session_id)");
      expect(sql).toContain("REFERENCES public.access_sessions(id)");
      expect(sql).toContain("ON DELETE SET NULL");
    });

    it("enforces RLS and restricts table privileges with column-level grants", () => {
      expect(sql).toContain("ALTER TABLE public.access_sessions ENABLE ROW LEVEL SECURITY;");
      expect(sql).toContain("ALTER TABLE public.payment_orders ENABLE ROW LEVEL SECURITY;");
      expect(sql).toContain("ALTER TABLE public.payment_refunds ENABLE ROW LEVEL SECURITY;");
      expect(sql).toContain("REVOKE ALL ON public.access_sessions FROM PUBLIC, anon, authenticated;");
      expect(sql).toContain("REVOKE ALL ON public.payment_orders FROM PUBLIC, anon, authenticated;");
      expect(sql).toContain("REVOKE ALL ON public.payment_refunds FROM PUBLIC, anon, authenticated;");

      // Column-level selective grants (sensitive keys excluded)
      expect(sql).toContain("GRANT SELECT (\n  id,\n  user_id,\n  restroom_id,");
      expect(sql).toContain("GRANT SELECT (\n  id,\n  access_session_id,\n  user_id,\n  order_id,");
      expect(sql).toContain("GRANT SELECT (\n  id,\n  payment_order_id,\n  receipt_submission_id,");
      expect(sql).not.toContain("GRANT SELECT ON public.payment_orders TO authenticated;");

      expect(sql).toContain("GRANT ALL ON public.access_sessions TO service_role;");
      expect(sql).toContain("GRANT ALL ON public.payment_orders TO service_role;");
      expect(sql).toContain("GRANT ALL ON public.payment_refunds TO service_role;");
    });

    it("enforces immutability triggers and dependency constraints", () => {
      // Access session rule: HM022 (authorized requires approved payment), HM029 (initial state must be created)
      expect(sql).toContain("HM022");
      expect(sql).toContain("HM029");

      // Payment order rule: HM036 (provider_payment_key immutability), HM039 (approved_at immutability)
      expect(sql).toContain("HM036");
      expect(sql).toContain("HM039");

      // Payment refund rule: HM046 (provider_cancel_id immutability), HM049 (receipt_submission_id immutability), HM050 (completed_at immutability), HM051 (provider_cancel_id required for succeeded)
      expect(sql).toContain("HM046");
      expect(sql).toContain("HM049");
      expect(sql).toContain("HM050");
      expect(sql).toContain("HM051");
    });

    it("blocks physical deletion of financial and access records", () => {
      expect(sql).toContain("prevent_payment_audit_deletion()");
      expect(sql).toContain("trg_prevent_access_sessions_delete");
      expect(sql).toContain("trg_prevent_payment_orders_delete");
      expect(sql).toContain("trg_prevent_payment_refunds_delete");
    });

    it("does not contain live PG keys or live payment mode", () => {
      expect(sql).not.toContain("live_");
      expect(sql).not.toContain("payment_mode = 'live'");
    });
  });
});
