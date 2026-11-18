import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { GET as handleListReceipts } from "@/app/api/v1/admin/receipts/route";
import { GET as handleGetReceiptDetail } from "@/app/api/v1/admin/receipts/[id]/route";
import { GET as handleGetReceiptImage } from "@/app/api/v1/admin/receipts/[id]/image/route";
import { POST as handleReceiptDecision } from "@/app/api/v1/admin/receipts/[id]/decision/route";
import {
  adminReceiptDecisionSchema,
  adminReceiptsFilterSchema,
  ReceiptServiceError,
} from "@/lib/receipts";
import { AuthGuardError, clearIdempotencyStoreForTests } from "@/lib/auth";

let mockUser: { id: string; role: "admin" | "customer" } | null = {
  id: "fa280000-0000-4000-a000-000000000001",
  role: "admin",
};

let mockReceiptStore = new Map<string, any>();
let mockIdempotencyMap = new Map<
  string,
  { submissionId: string; payloadHash: string; result: any }
>();

function resetMockStore() {
  mockReceiptStore.clear();
  mockIdempotencyMap.clear();
  mockReceiptStore.set("11111111-1111-4111-8111-111111111111", {
    id: "11111111-1111-4111-8111-111111111111",
    accessSessionId: "aaaa1111-1111-4111-8111-111111111111",
    userId: "bbbb1111-1111-4111-8111-111111111111",
    storagePath:
      "receipts/bbbb1111-1111-4111-8111-111111111111/aaaa1111-1111-4111-8111-111111111111/photo.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: 204800,
    originalFilename: "receipt.jpg",
    submissionStatus: "submitted",
    storeNameConfirmed: null,
    purchaseAtConfirmed: null,
    purchaseAmountKrw: null,
    receiptReference: null,
    reviewedBy: null,
    reviewedAt: null,
    reviewReason: null,
    createdAt: "2026-11-15T12:00:00Z",
    updatedAt: "2026-11-15T12:00:00Z",
    restroomName: "테스트 제휴 화장실 1호",
    businessName: "스타벅스 수원점",
    depositAmountKrw: 1000,
    userDisplayName: "홍길동",
  });

  mockReceiptStore.set("22222222-2222-4222-8222-222222222222", {
    id: "22222222-2222-4222-8222-222222222222",
    accessSessionId: "aaaa2222-2222-4222-8222-222222222222",
    userId: "bbbb2222-2222-4222-8222-222222222222",
    storagePath:
      "receipts/bbbb2222-2222-4222-8222-222222222222/aaaa2222-2222-4222-8222-222222222222/photo2.png",
    mimeType: "image/png",
    fileSizeBytes: 102400,
    originalFilename: "receipt2.png",
    submissionStatus: "approved",
    storeNameConfirmed: "이디야커피",
    purchaseAtConfirmed: "2026-11-15T10:00:00Z",
    purchaseAmountKrw: 3500,
    receiptReference: "EDIYA-001",
    reviewedBy: "fa280000-0000-4000-a000-000000000001",
    reviewedAt: "2026-11-15T13:00:00Z",
    reviewReason: "구매 영수증 확인 완료",
    createdAt: "2026-11-15T11:00:00Z",
    updatedAt: "2026-11-15T13:00:00Z",
  });
}

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    isSupabaseAuthConfigured: vi.fn(() => true),
    requireRole: vi.fn(async (role: string) => {
      if (!mockUser) {
        throw new actual.AuthGuardError(
          "UNAUTHORIZED",
          401,
          "로그인이 필요한 기능입니다."
        );
      }
      if (role === "admin" && mockUser.role !== "admin") {
        throw new actual.AuthGuardError(
          "FORBIDDEN",
          403,
          "관리자 권한이 필요합니다."
        );
      }
      return {
        user: { id: mockUser.id, email: "admin@hujimap.local" },
        roles: [mockUser.role],
        isAdmin: mockUser.role === "admin",
        isMerchant: false,
        displayName: "관리자",
        accountStatus: "active",
        profileExists: true,
        sessionExpired: false,
        configReady: true,
      };
    }),
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createServerClientInstance: vi.fn(async () => ({})),
  createAdminClient: vi.fn(() => ({})),
  isServiceRoleConfigured: vi.fn(() => true),
}));

vi.mock("@/lib/receipts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/receipts")>();
  return {
    ...actual,
    listAdminReceipts: vi.fn(async (filter = {}) => {
      let items = Array.from(mockReceiptStore.values());
      const status = filter.status?.trim();
      if (status && status !== "all") {
        if (status === "pending") {
          items = items.filter((i) =>
            ["submitted", "review_required"].includes(i.submissionStatus)
          );
        } else {
          items = items.filter((i) => i.submissionStatus === status);
        }
      } else if (!status) {
        items = items.filter((i) =>
          ["submitted", "review_required"].includes(i.submissionStatus)
        );
      }

      return {
        items,
        pagination: {
          page: filter.page ?? 1,
          limit: filter.limit ?? 20,
          total: items.length,
          totalPages: 1,
        },
      };
    }),

    getAdminReceiptById: vi.fn(async (submissionId: string) => {
      const receipt = mockReceiptStore.get(submissionId);
      if (!receipt) {
        throw new actual.ReceiptServiceError(
          "RECEIPT_NOT_FOUND",
          "영수증 정보를 찾을 수 없습니다.",
          404
        );
      }
      return receipt;
    }),

    createReceiptSignedReadUrl: vi.fn(async (params) => {
      if (!params.isAdmin) {
        throw new actual.ReceiptServiceError("FORBIDDEN", "권한이 없습니다.", 403);
      }
      return `https://storage.mock/signed-read/${encodeURIComponent(params.storagePath)}?token=mock-token`;
    }),

    decideReceiptReview: vi.fn(async (params) => {
      if (params.idempotencyKey) {
        const existing = mockIdempotencyMap.get(params.idempotencyKey);
        if (existing) {
          if (
            existing.submissionId === params.submissionId &&
            existing.payloadHash === params.payloadHash
          ) {
            return {
              receipt: existing.result,
              auditId: "fa280000-0000-4000-e000-000000000001",
              reused: true,
            };
          }
          throw new actual.ReceiptServiceError(
            "CONFLICT",
            "동일한 Idempotency-Key로 다른 요청 본문이 전송되었거나 충돌이 발생했습니다.",
            409
          );
        }
      }

      const receipt = mockReceiptStore.get(params.submissionId);
      if (!receipt) {
        throw new actual.ReceiptServiceError(
          "RECEIPT_NOT_FOUND",
          "영수증 제출 정보를 찾을 수 없습니다.",
          404
        );
      }

      if (receipt.submissionStatus === "approved") {
        throw new actual.ReceiptServiceError(
          "STATUS_CONFLICT",
          "이미 승인 완료된 영수증입니다.",
          409
        );
      }

      if (
        ["rejected", "resubmission_requested"].includes(receipt.submissionStatus)
      ) {
        throw new actual.ReceiptServiceError(
          "STATUS_CONFLICT",
          "이미 처리가 완료된 영수증입니다.",
          409
        );
      }

      const updated = {
        ...receipt,
        submissionStatus: params.decision,
        reviewedBy: params.reviewerId,
        reviewedAt: new Date().toISOString(),
        reviewReason: params.reason,
        storeNameConfirmed: params.confirmedStore ?? receipt.storeNameConfirmed,
        purchaseAtConfirmed:
          params.confirmedPurchaseAt ?? receipt.purchaseAtConfirmed,
        purchaseAmountKrw:
          params.confirmedAmount ?? receipt.purchaseAmountKrw,
        receiptReference:
          params.receiptReference ?? receipt.receiptReference,
      };

      mockReceiptStore.set(params.submissionId, updated);

      if (params.idempotencyKey) {
        mockIdempotencyMap.set(params.idempotencyKey, {
          submissionId: params.submissionId,
          payloadHash: params.payloadHash ?? "",
          result: updated,
        });
      }

      return {
        receipt: updated,
        auditId: "fa280000-0000-4000-e000-000000000001",
        reused: false,
      };
    }),
  };
});

describe("TASK 28: Admin Manual Review API & Validation Unit Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearIdempotencyStoreForTests();
    mockUser = {
      id: "fa280000-0000-4000-a000-000000000001",
      role: "admin",
    };
    resetMockStore();
  });

  describe("1. Validation Schemas", () => {
    it("adminReceiptsFilterSchema defaults to page 1 and limit 20", () => {
      const parsed = adminReceiptsFilterSchema.parse({});
      expect(parsed.page).toBe(1);
      expect(parsed.limit).toBe(20);
      expect(parsed.status).toBeUndefined();
    });

    it("adminReceiptsFilterSchema accepts valid query parameters", () => {
      const parsed = adminReceiptsFilterSchema.parse({
        status: "submitted",
        page: "2",
        limit: "50",
      });
      expect(parsed.status).toBe("submitted");
      expect(parsed.page).toBe(2);
      expect(parsed.limit).toBe(50);
    });

    it("adminReceiptDecisionSchema accepts valid approval decision", () => {
      const valid = adminReceiptDecisionSchema.safeParse({
        decision: "approved",
        reason: "영수증 상호 및 일시 일치 확인",
        confirmedStore: "스타벅스 수원점",
        confirmedPurchaseAt: "2026-11-15T12:30:00Z",
        confirmedAmount: 4500,
        receiptReference: "REC-12345",
      });
      expect(valid.success).toBe(true);
      if (valid.success) {
        expect(valid.data.decision).toBe("approved");
        expect(valid.data.reason).toBe("영수증 상호 및 일시 일치 확인");
        expect(valid.data.confirmedAmount).toBe(4500);
      }
    });

    it("adminReceiptDecisionSchema rejects missing or short reasons (< 2 chars)", () => {
      const missingReason = adminReceiptDecisionSchema.safeParse({
        decision: "rejected",
      });
      expect(missingReason.success).toBe(false);

      const emptyReason = adminReceiptDecisionSchema.safeParse({
        decision: "rejected",
        reason: "  ",
      });
      expect(emptyReason.success).toBe(false);

      const singleCharReason = adminReceiptDecisionSchema.safeParse({
        decision: "rejected",
        reason: "반",
      });
      expect(singleCharReason.success).toBe(false);

      const validTwoChars = adminReceiptDecisionSchema.safeParse({
        decision: "rejected",
        reason: "반려",
      });
      expect(validTwoChars.success).toBe(true);
    });

    it("adminReceiptDecisionSchema rejects invalid decision enum", () => {
      const invalidDecision = adminReceiptDecisionSchema.safeParse({
        decision: "auto_approved",
        reason: "사유 입력",
      });
      expect(invalidDecision.success).toBe(false);
    });

    it("adminReceiptDecisionSchema accepts resubmission_requested with reason", () => {
      const validResubmission = adminReceiptDecisionSchema.safeParse({
        decision: "resubmission_requested",
        reason: "영수증 날짜가 흐려 판독이 어렵습니다. 재촬영 후 업로드해 주세요.",
      });
      expect(validResubmission.success).toBe(true);
    });
  });

  describe("2. GET /api/v1/admin/receipts (Pending Queue)", () => {
    it("returns 401 when user is unauthenticated", async () => {
      mockUser = null;
      const req = new Request("http://localhost/api/v1/admin/receipts");
      const res = await handleListReceipts(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 403 when user is customer (non-admin)", async () => {
      mockUser = {
        id: "fa280000-0000-4000-a000-000000000002",
        role: "customer",
      };
      const req = new Request("http://localhost/api/v1/admin/receipts");
      const res = await handleListReceipts(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe("FORBIDDEN");
    });

    it("returns 200 with pending queue for admin", async () => {
      const req = new Request("http://localhost/api/v1/admin/receipts");
      const res = await handleListReceipts(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.items).toBeDefined();
      expect(json.items.length).toBe(1);
      expect(json.items[0].submissionStatus).toBe("submitted");
      expect(json.items[0].businessName).toBe("스타벅스 수원점");
    });

    it("supports status=all filter for admin inspection", async () => {
      const req = new Request("http://localhost/api/v1/admin/receipts?status=all");
      const res = await handleListReceipts(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.items.length).toBe(2);
    });
  });

  describe("3. GET /api/v1/admin/receipts/:id/image (Signed Read URL)", () => {
    const validId = "11111111-1111-4111-8111-111111111111";

    it("returns 401 when user is unauthenticated", async () => {
      mockUser = null;
      const req = new Request(`http://localhost/api/v1/admin/receipts/${validId}/image`);
      const res = await handleGetReceiptImage(req, {
        params: Promise.resolve({ id: validId }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 403 when user is customer (non-admin)", async () => {
      mockUser = {
        id: "fa280000-0000-4000-a000-000000000002",
        role: "customer",
      };
      const req = new Request(`http://localhost/api/v1/admin/receipts/${validId}/image`);
      const res = await handleGetReceiptImage(req, {
        params: Promise.resolve({ id: validId }),
      });
      expect(res.status).toBe(403);
    });

    it("returns 400 when id is not a valid UUID", async () => {
      const req = new Request("http://localhost/api/v1/admin/receipts/invalid-uuid/image");
      const res = await handleGetReceiptImage(req, {
        params: Promise.resolve({ id: "invalid-uuid" }),
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe("VALIDATION_ERROR");
    });

    it("returns 404 when receipt does not exist", async () => {
      const nonExistentId = "99999999-9999-4999-8999-999999999999";
      const req = new Request(`http://localhost/api/v1/admin/receipts/${nonExistentId}/image`);
      const res = await handleGetReceiptImage(req, {
        params: Promise.resolve({ id: nonExistentId }),
      });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe("RECEIPT_NOT_FOUND");
    });

    it("returns 200 with short-lived signed URL for admin", async () => {
      const req = new Request(`http://localhost/api/v1/admin/receipts/${validId}/image`);
      const res = await handleGetReceiptImage(req, {
        params: Promise.resolve({ id: validId }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.signedUrl).toContain("https://storage.mock/signed-read/");
      expect(json.expiresIn).toBe(900);
      expect(json.receiptId).toBe(validId);
    });
  });

  describe("4. GET /api/v1/admin/receipts/:id (Detail Inspection)", () => {
    const validId = "11111111-1111-4111-8111-111111111111";

    it("returns 200 with receipt detail for admin", async () => {
      const req = new Request(`http://localhost/api/v1/admin/receipts/${validId}`);
      const res = await handleGetReceiptDetail(req, {
        params: Promise.resolve({ id: validId }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.receipt.id).toBe(validId);
      expect(json.receipt.submissionStatus).toBe("submitted");
    });
  });

  describe("5. POST /api/v1/admin/receipts/:id/decision (Admin Decision Handling)", () => {
    const pendingId = "11111111-1111-4111-8111-111111111111";
    const approvedId = "22222222-2222-4222-8222-222222222222";

    it("returns 401 when user is unauthenticated", async () => {
      mockUser = null;
      const req = new Request(`http://localhost/api/v1/admin/receipts/${pendingId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "approved",
          reason: "승인 완료",
        }),
      });
      const res = await handleReceiptDecision(req, {
        params: Promise.resolve({ id: pendingId }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 403 when user is customer (non-admin)", async () => {
      mockUser = {
        id: "fa280000-0000-4000-a000-000000000002",
        role: "customer",
      };
      const req = new Request(`http://localhost/api/v1/admin/receipts/${pendingId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "approved",
          reason: "승인 완료",
        }),
      });
      const res = await handleReceiptDecision(req, {
        params: Promise.resolve({ id: pendingId }),
      });
      expect(res.status).toBe(403);
    });

    it("returns 400 when reason is missing or empty", async () => {
      const req = new Request(`http://localhost/api/v1/admin/receipts/${pendingId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "approved",
        }),
      });
      const res = await handleReceiptDecision(req, {
        params: Promise.resolve({ id: pendingId }),
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe("VALIDATION_ERROR");
    });

    it("returns 200 when admin approves receipt with confirmation fields", async () => {
      const req = new Request(`http://localhost/api/v1/admin/receipts/${pendingId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "approved",
          reason: "영수증 금액 및 일시 확인 정상",
          confirmedStore: "스타벅스 수원점",
          confirmedPurchaseAt: "2026-11-15T12:15:00Z",
          confirmedAmount: 5500,
          receiptReference: "POS-REF-9988",
        }),
      });
      const res = await handleReceiptDecision(req, {
        params: Promise.resolve({ id: pendingId }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.receipt.submissionStatus).toBe("approved");
      expect(json.receipt.storeNameConfirmed).toBe("스타벅스 수원점");
      expect(json.receipt.purchaseAmountKrw).toBe(5500);
      expect(json.auditId).toBeDefined();
    });

    it("returns 200 when admin rejects receipt with mandatory reason", async () => {
      resetMockStore();
      const req = new Request(`http://localhost/api/v1/admin/receipts/${pendingId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "rejected",
          reason: "제휴 매장이 아닌 타 매장 영수증이 제출되었습니다.",
        }),
      });
      const res = await handleReceiptDecision(req, {
        params: Promise.resolve({ id: pendingId }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.receipt.submissionStatus).toBe("rejected");
      expect(json.receipt.reviewReason).toBe("제휴 매장이 아닌 타 매장 영수증이 제출되었습니다.");
    });

    it("returns 200 when admin requests resubmission with reason", async () => {
      resetMockStore();
      const req = new Request(`http://localhost/api/v1/admin/receipts/${pendingId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "resubmission_requested",
          reason: "영수증 하단 결제금액 부분이 잘려 있어 확인이 어렵습니다. 재촬영 부탁드립니다.",
        }),
      });
      const res = await handleReceiptDecision(req, {
        params: Promise.resolve({ id: pendingId }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.receipt.submissionStatus).toBe("resubmission_requested");
    });

    it("returns 409 when attempting to review an already approved receipt", async () => {
      const req = new Request(`http://localhost/api/v1/admin/receipts/${approvedId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "approved",
          reason: "중복 승인 시도",
        }),
      });
      const res = await handleReceiptDecision(req, {
        params: Promise.resolve({ id: approvedId }),
      });
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error.code).toBe("STATUS_CONFLICT");
      expect(json.error.message).toContain("이미 승인 완료된 영수증입니다.");
    });

    it("supports idempotency replay with x-idempotency-key", async () => {
      resetMockStore();
      const idempotencyKey = "test-idempotency-key-001";
      const payload = {
        decision: "approved",
        reason: "영수증 확인 완료",
      };

      const req1 = new Request(`http://localhost/api/v1/admin/receipts/${pendingId}/decision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      const res1 = await handleReceiptDecision(req1, {
        params: Promise.resolve({ id: pendingId }),
      });
      expect(res1.status).toBe(200);

      // Replay with identical body & key
      const req2 = new Request(`http://localhost/api/v1/admin/receipts/${pendingId}/decision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      const res2 = await handleReceiptDecision(req2, {
        params: Promise.resolve({ id: pendingId }),
      });
      expect(res2.status).toBe(200);
      const json2 = await res2.json();
      expect(json2.ok).toBe(true);
      expect(json2.receipt.submissionStatus).toBe("approved");

      // Collision with different body & same key
      const req3 = new Request(`http://localhost/api/v1/admin/receipts/${pendingId}/decision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          decision: "rejected",
          reason: "다른 내용의 반려 시도",
        }),
      });

      const res3 = await handleReceiptDecision(req3, {
        params: Promise.resolve({ id: pendingId }),
      });
      expect(res3.status).toBe(409);
    });
  });

  describe("6. RPC Hardening Migration Static & Security Invariants", () => {
    const hardeningSql = fs.readFileSync(
      path.resolve(process.cwd(), "supabase/migrations/20261119020000_receipt_review_rpc_hardening.sql"),
      "utf-8"
    );

    it("drops legacy 8-parameter overload with RESTRICT and does not use CASCADE", () => {
      expect(hardeningSql).toMatch(
        /DROP FUNCTION IF EXISTS public\.decide_receipt_review\(\s*uuid,\s*uuid,\s*text,\s*text,\s*text,\s*timestamptz,\s*integer,\s*text\s*\)\s*RESTRICT;/i
      );
      expect(hardeningSql).not.toMatch(/CASCADE/i);
    });

    it("revokes EXECUTE from PUBLIC, anon, and authenticated and grants only to service_role", () => {
      expect(hardeningSql).toMatch(
        /REVOKE ALL ON FUNCTION public\.decide_receipt_review\(\s*uuid,\s*uuid,\s*text,\s*text,\s*text,\s*timestamptz,\s*integer,\s*text,\s*text,\s*text\s*\)\s*FROM PUBLIC,\s*anon,\s*authenticated;/i
      );
      expect(hardeningSql).toMatch(
        /GRANT EXECUTE ON FUNCTION public\.decide_receipt_review\(\s*uuid,\s*uuid,\s*text,\s*text,\s*text,\s*timestamptz,\s*integer,\s*text,\s*text,\s*text\s*\)\s*TO service_role;/i
      );
    });

    it("enforces SECURITY DEFINER, fixed search_path, direct client role block, and actor spoofing protection", () => {
      expect(hardeningSql).toContain("SECURITY DEFINER");
      expect(hardeningSql).toContain("SET search_path = pg_catalog, pg_temp");
      expect(hardeningSql).toContain("FORBIDDEN_DIRECT_RPC");
      expect(hardeningSql).toContain("FORBIDDEN_ACTOR_SPOOFING");
      expect(hardeningSql).toContain("public.is_admin(v_reviewer_id)");
    });
  });
});

