import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST as handleUploadIntent } from "@/app/api/v1/receipts/upload-intent/route";
import { POST as handleSubmitReceipt } from "@/app/api/v1/receipts/route";
import { AuthGuardError } from "@/lib/auth";

let mockAuthUser: { id: string; email: string } | null = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "customer@example.com",
};

let mockUploadIntentResult: any = {
  uploadUrl: "https://storage.mock/upload/receipts/2222.../test.jpg",
  storagePath: "receipts/22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-111111111111/test.jpg",
  token: "mock-token",
  expiresIn: 900,
};

let mockSubmitResult: any = {
  receipt: {
    id: "sub-1234",
    accessSessionId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    storagePath: "receipts/22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-111111111111/test.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: 204800,
    originalFilename: "receipt.jpg",
    submissionStatus: "submitted",
    createdAt: "2026-11-15T12:00:00Z",
  },
  reused: false,
};

vi.mock("@/lib/auth", () => ({
  isSupabaseAuthConfigured: vi.fn(() => true),
  requireAuth: vi.fn(async () => {
    if (!mockAuthUser) {
      throw new AuthGuardError("UNAUTHORIZED", 401, "로그인이 필요한 서비스입니다.");
    }
    return {
      user: mockAuthUser,
      profile: { id: mockAuthUser.id, account_status: "active" },
    };
  }),
  AuthGuardError: class extends Error {
    constructor(public code: string, public status: number, public userMessage: string) {
      super(userMessage);
    }
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClientInstance: vi.fn(async () => ({})),
  createAdminClient: vi.fn(() => ({})),
  isServiceRoleConfigured: vi.fn(() => true),
}));

vi.mock("@/lib/receipts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/receipts")>();
  return {
    ...actual,
    createReceiptUploadIntent: vi.fn(async (params) => {
      if (params.accessSessionId === "99999999-9999-4999-8999-999999999999") {
        throw new actual.ReceiptServiceError("PAYMENT_NOT_APPROVED", "결제 승인이 완료되지 않은 이용권입니다.", 422);
      }
      return mockUploadIntentResult;
    }),
    submitCustomerReceipt: vi.fn(async (params) => {
      if (params.accessSessionId === "88888888-8888-4888-8888-888888888888") {
        throw new actual.ReceiptServiceError("FORBIDDEN", "본인의 이용권에 대해서만 영수증을 제출할 수 있습니다.", 403);
      }
      return mockSubmitResult;
    }),
  };
});

describe("TASK 26 — Receipt Route Handlers", () => {
  beforeEach(() => {
    mockAuthUser = {
      id: "22222222-2222-4222-8222-222222222222",
      email: "customer@example.com",
    };
  });

  describe("POST /api/v1/receipts/upload-intent", () => {
    it("returns 401 when customer is unauthenticated", async () => {
      mockAuthUser = null;

      const req = new Request("http://localhost:3000/api/v1/receipts/upload-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessSessionId: "11111111-1111-4111-8111-111111111111",
          mimeType: "image/jpeg",
          fileSizeBytes: 102400,
        }),
      });

      const res = await handleUploadIntent(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 400 on malformed JSON payload", async () => {
      const req = new Request("http://localhost:3000/api/v1/receipts/upload-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "NOT_VALID_JSON",
      });

      const res = await handleUploadIntent(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe("INVALID_JSON");
    });

    it("returns 400 when Zod validation fails (e.g. invalid MIME type)", async () => {
      const req = new Request("http://localhost:3000/api/v1/receipts/upload-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessSessionId: "11111111-1111-4111-8111-111111111111",
          mimeType: "image/gif", // Invalid
          fileSizeBytes: 102400,
        }),
      });

      const res = await handleUploadIntent(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe("VALIDATION_ERROR");
      expect(json.error.message).toContain("JPG, PNG, WebP");
    });

    it("returns 422 when access session has unapproved payment", async () => {
      const req = new Request("http://localhost:3000/api/v1/receipts/upload-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessSessionId: "99999999-9999-4999-8999-999999999999",
          mimeType: "image/jpeg",
          fileSizeBytes: 102400,
        }),
      });

      const res = await handleUploadIntent(req);
      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe("PAYMENT_NOT_APPROVED");
    });

    it("returns 200 with signed upload intent on valid input", async () => {
      const req = new Request("http://localhost:3000/api/v1/receipts/upload-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessSessionId: "11111111-1111-4111-8111-111111111111",
          mimeType: "image/jpeg",
          fileSizeBytes: 102400,
          originalFilename: "receipt.jpg",
        }),
      });

      const res = await handleUploadIntent(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toContain("no-store");
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.uploadUrl).toBeDefined();
      expect(json.storagePath).toBeDefined();
      expect(json.expiresIn).toBe(900);
      expect(json.requestId).toBeDefined();
    });
  });

  describe("POST /api/v1/receipts", () => {
    it("returns 401 when customer is unauthenticated", async () => {
      mockAuthUser = null;

      const req = new Request("http://localhost:3000/api/v1/receipts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessSessionId: "11111111-1111-4111-8111-111111111111",
          storagePath: "receipts/22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-111111111111/test.jpg",
          mimeType: "image/jpeg",
          fileSizeBytes: 102400,
          clientSubmissionId: "client_sub_12345",
        }),
      });

      const res = await handleSubmitReceipt(req);
      expect(res.status).toBe(401);
    });

    it("returns 403 when session ownership is denied", async () => {
      const req = new Request("http://localhost:3000/api/v1/receipts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessSessionId: "88888888-8888-4888-8888-888888888888",
          storagePath: "receipts/22222222-2222-4222-8222-222222222222/88888888-8888-4888-8888-888888888888/test.jpg",
          mimeType: "image/jpeg",
          fileSizeBytes: 102400,
          clientSubmissionId: "client_sub_12345",
        }),
      });

      const res = await handleSubmitReceipt(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe("FORBIDDEN");
    });

    it("returns 201 on first successful receipt submission", async () => {
      mockSubmitResult = {
        ...mockSubmitResult,
        reused: false,
      };

      const req = new Request("http://localhost:3000/api/v1/receipts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessSessionId: "11111111-1111-4111-8111-111111111111",
          storagePath: "receipts/22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-111111111111/test.jpg",
          mimeType: "image/jpeg",
          fileSizeBytes: 102400,
          clientSubmissionId: "client_sub_12345",
          originalFilename: "receipt.jpg",
        }),
      });

      const res = await handleSubmitReceipt(req);
      expect(res.status).toBe(201);
      expect(res.headers.get("Cache-Control")).toContain("no-store");
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.reused).toBe(false);
      expect(json.receipt.id).toBe("sub-1234");
      expect(json.receipt.submissionStatus).toBe("submitted");
    });

    it("returns 200 on idempotent resubmission with reused:true", async () => {
      mockSubmitResult = {
        ...mockSubmitResult,
        reused: true,
      };

      const req = new Request("http://localhost:3000/api/v1/receipts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessSessionId: "11111111-1111-4111-8111-111111111111",
          storagePath: "receipts/22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-111111111111/test.jpg",
          mimeType: "image/jpeg",
          fileSizeBytes: 102400,
          clientSubmissionId: "client_sub_12345",
          originalFilename: "receipt.jpg",
        }),
      });

      const res = await handleSubmitReceipt(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.reused).toBe(true);
    });
  });
});
