import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createUploadIntentSchema,
  submitReceiptSchema,
  sanitizeFilename,
  verifyReceiptMagicBytes,
  ReceiptServiceError,
} from "@/lib/receipts/validation";
import {
  toPublicReceiptSubmission,
  type ReceiptSubmissionRow,
} from "@/lib/receipts/types";
import {
  createReceiptUploadIntent,
  submitCustomerReceipt,
  createReceiptSignedReadUrl,
} from "@/lib/receipts/service";

// Mock Supabase Server utilities
const validJpgBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

vi.mock("@/lib/supabase/server", () => {
  const mockStorage = {
    from: vi.fn(() => ({
      createSignedUploadUrl: vi.fn().mockResolvedValue({
        data: { signedUrl: "https://storage.mock/upload/signed-token", token: "mock_token" },
        error: null,
      }),
      createSignedUrl: vi.fn().mockResolvedValue({
        data: { signedUrl: "https://storage.mock/read/signed-url" },
        error: null,
      }),
      download: vi.fn().mockResolvedValue({
        data: new Blob([validJpgBuffer]),
        error: null,
      }),
    })),
  };

  const mockRpc = vi.fn();

  const mockAdminClient = {
    rpc: mockRpc,
    storage: mockStorage,
  };

  return {
    isServiceRoleConfigured: vi.fn(() => true),
    createAdminClient: vi.fn(() => mockAdminClient),
  };
});

describe("TASK 26 — Receipt Backend Unit & Validation Tests", () => {
  describe("Zod Validation: createUploadIntentSchema", () => {
    it("accepts valid upload intent payload", () => {
      const validPayload = {
        accessSessionId: "11111111-1111-4111-8111-111111111111",
        mimeType: "image/jpeg",
        fileSizeBytes: 1024 * 500, // 500KB
        originalFilename: "my_receipt.jpg",
      };

      const parsed = createUploadIntentSchema.safeParse(validPayload);
      expect(parsed.success).toBe(true);
    });

    it("rejects non-UUID accessSessionId", () => {
      const payload = {
        accessSessionId: "invalid-uuid-string",
        mimeType: "image/png",
        fileSizeBytes: 1024,
      };

      const parsed = createUploadIntentSchema.safeParse(payload);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0].message).toContain("UUID");
      }
    });

    it("rejects unsupported MIME types (e.g. image/gif, application/pdf)", () => {
      const pdfPayload = {
        accessSessionId: "11111111-1111-4111-8111-111111111111",
        mimeType: "application/pdf",
        fileSizeBytes: 2048,
      };

      const parsed = createUploadIntentSchema.safeParse(pdfPayload);
      expect(parsed.success).toBe(false);
    });

    it("rejects file size <= 0", () => {
      const payload = {
        accessSessionId: "11111111-1111-4111-8111-111111111111",
        mimeType: "image/webp",
        fileSizeBytes: 0,
      };

      const parsed = createUploadIntentSchema.safeParse(payload);
      expect(parsed.success).toBe(false);
    });

    it("rejects file size > 10MB (10,485,760 bytes)", () => {
      const payload = {
        accessSessionId: "11111111-1111-4111-8111-111111111111",
        mimeType: "image/jpeg",
        fileSizeBytes: 10 * 1024 * 1024 + 1,
      };

      const parsed = createUploadIntentSchema.safeParse(payload);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0].message).toContain("10MB");
      }
    });
  });

  describe("Zod Validation: submitReceiptSchema", () => {
    it("accepts valid receipt submission payload", () => {
      const validPayload = {
        accessSessionId: "11111111-1111-4111-8111-111111111111",
        storagePath: "receipts/user1/session1/photo.jpg",
        mimeType: "image/jpeg",
        fileSizeBytes: 204800,
        originalFilename: "receipt.jpg",
        clientSubmissionId: "client_sub_12345678",
      };

      const parsed = submitReceiptSchema.safeParse(validPayload);
      expect(parsed.success).toBe(true);
    });

    it("rejects clientSubmissionId shorter than 8 characters", () => {
      const payload = {
        accessSessionId: "11111111-1111-4111-8111-111111111111",
        storagePath: "receipts/user1/session1/photo.jpg",
        mimeType: "image/png",
        fileSizeBytes: 2048,
        clientSubmissionId: "short",
      };

      const parsed = submitReceiptSchema.safeParse(payload);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0].message).toContain("8자 이상");
      }
    });

    it("rejects empty storagePath", () => {
      const payload = {
        accessSessionId: "11111111-1111-4111-8111-111111111111",
        storagePath: "",
        mimeType: "image/webp",
        fileSizeBytes: 2048,
        clientSubmissionId: "client_sub_12345678",
      };

      const parsed = submitReceiptSchema.safeParse(payload);
      expect(parsed.success).toBe(false);
    });
  });

  describe("Filename Sanitization: sanitizeFilename", () => {
    it("removes directory traversal sequences and special characters", () => {
      expect(sanitizeFilename("../../etc/passwd.jpg")).toBe("passwd.jpg");
      expect(sanitizeFilename("..\\..\\windows\\receipt.png")).toBe("receipt.png");
      expect(sanitizeFilename("영수증 <script> 100%.jpg")).toBe("영수증 _script_ 100_.jpg");
      expect(sanitizeFilename(null)).toBeNull();
      expect(sanitizeFilename("")).toBeNull();
    });
  });

  describe("Magic Bytes Verification: verifyReceiptMagicBytes", () => {
    it("verifies JPEG magic bytes (FF D8 FF)", () => {
      const validJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
      expect(verifyReceiptMagicBytes(validJpg, "image/jpeg")).toBe(true);
      expect(verifyReceiptMagicBytes(validJpg, "image/png")).toBe(false);
    });

    it("verifies PNG magic bytes (89 50 4E 47 0D 0A 1A 0A)", () => {
      const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
      expect(verifyReceiptMagicBytes(validPng, "image/png")).toBe(true);
      expect(verifyReceiptMagicBytes(validPng, "image/jpeg")).toBe(false);
    });

    it("verifies WebP magic bytes (RIFF....WEBP)", () => {
      // 0..3: RIFF (52 49 46 46), 4..7: size, 8..11: WEBP (57 45 42 50)
      const validWebp = Buffer.from([
        0x52, 0x49, 0x46, 0x46,
        0x24, 0x00, 0x00, 0x00,
        0x57, 0x45, 0x42, 0x50,
      ]);
      expect(verifyReceiptMagicBytes(validWebp, "image/webp")).toBe(true);
      expect(verifyReceiptMagicBytes(validWebp, "image/jpeg")).toBe(false);
    });

    it("rejects buffers shorter than 12 bytes or corrupted headers", () => {
      const shortBuf = Buffer.from([0xff, 0xd8]);
      expect(verifyReceiptMagicBytes(shortBuf, "image/jpeg")).toBe(false);

      const fakeTxt = Buffer.from("Hello world this is text");
      expect(verifyReceiptMagicBytes(fakeTxt, "image/jpeg")).toBe(false);
      expect(verifyReceiptMagicBytes(fakeTxt, "image/png")).toBe(false);
      expect(verifyReceiptMagicBytes(fakeTxt, "image/webp")).toBe(false);
    });
  });

  describe("Public Data Transformation: toPublicReceiptSubmission", () => {
    it("transforms DB row to camelCase PublicReceiptSubmission without sensitive/internal fields", () => {
      const mockRow: ReceiptSubmissionRow = {
        id: "sub-123",
        access_session_id: "sess-456",
        user_id: "user-789",
        storage_path: "receipts/user-789/sess-456/photo.jpg",
        mime_type: "image/jpeg",
        file_size_bytes: 512000,
        original_filename: "receipt.jpg",
        client_submission_id: "client-sub-12345",
        submission_status: "submitted",
        store_name_confirmed: null,
        purchase_at_confirmed: null,
        purchase_amount_krw: null,
        receipt_reference: "INTERNAL_SECRET_REF_999",
        reviewed_by: "admin-uuid-000",
        reviewed_at: null,
        review_reason: null,
        created_at: "2026-11-15T12:00:00Z",
        updated_at: "2026-11-15T12:00:00Z",
      };

      const publicObj = toPublicReceiptSubmission(mockRow);

      expect(publicObj.id).toBe("sub-123");
      expect(publicObj.accessSessionId).toBe("sess-456");
      expect(publicObj.userId).toBe("user-789");
      expect(publicObj.submissionStatus).toBe("submitted");
      expect((publicObj as any).receipt_reference).toBeUndefined();
      expect((publicObj as any).reviewed_by).toBeUndefined();
      expect((publicObj as any).client_submission_id).toBeUndefined();
    });
  });

  describe("Service Layer: createReceiptUploadIntent", () => {
    it("invokes validate_receipt_upload_intent RPC and returns upload credentials", async () => {
      const { createAdminClient } = await import("@/lib/supabase/server");
      const client = createAdminClient();
      (client.rpc as any).mockResolvedValueOnce({
        data: { ok: true, access_session_id: "sess-1", receipt_window_hours: 24 },
        error: null,
      });

      const res = await createReceiptUploadIntent({
        accessSessionId: "11111111-1111-4111-8111-111111111111",
        mimeType: "image/jpeg",
        fileSizeBytes: 10240,
        userId: "22222222-2222-4222-8222-222222222222",
      });

      expect(res.storagePath).toMatch(/^receipts\/22222222-2222-4222-8222-222222222222\/11111111-1111-4111-8111-111111111111\/[a-f0-9\-]+\.jpg$/);
      expect(res.expiresIn).toBe(900);
      expect(res.uploadUrl).toBeDefined();
    });

    it("throws ReceiptServiceError when RPC rejects intent (e.g. PAYMENT_NOT_APPROVED 422)", async () => {
      const { createAdminClient } = await import("@/lib/supabase/server");
      const client = createAdminClient();
      (client.rpc as any).mockResolvedValueOnce({
        data: { ok: false, error_code: "PAYMENT_NOT_APPROVED", message: "결제 승인이 완료되지 않았습니다.", status: 422 },
        error: null,
      });

      await expect(
        createReceiptUploadIntent({
          accessSessionId: "11111111-1111-4111-8111-111111111111",
          mimeType: "image/png",
          fileSizeBytes: 10240,
          userId: "22222222-2222-4222-8222-222222222222",
        })
      ).rejects.toThrow("결제 승인이 완료되지 않았습니다.");
    });
  });

  describe("Service Layer: submitCustomerReceipt", () => {
    it("blocks path traversal or mismatched user/session in storagePath (403 FORBIDDEN)", async () => {
      await expect(
        submitCustomerReceipt({
          accessSessionId: "11111111-1111-4111-8111-111111111111",
          storagePath: "receipts/other_user_id/11111111-1111-4111-8111-111111111111/photo.jpg",
          mimeType: "image/jpeg",
          fileSizeBytes: 10240,
          clientSubmissionId: "client_sub_12345",
          userId: "22222222-2222-4222-8222-222222222222",
        })
      ).rejects.toThrow("타인의 경로 또는 유효하지 않은 저장 경로입니다.");
    });

    it("blocks submission when file does not exist in storage (400 FILE_NOT_FOUND)", async () => {
      const { createAdminClient } = await import("@/lib/supabase/server");
      const client = createAdminClient();
      (client.storage.from as any).mockReturnValueOnce({
        download: vi.fn().mockResolvedValueOnce({
          data: null,
          error: new Error("Object not found"),
        }),
      });

      await expect(
        submitCustomerReceipt({
          accessSessionId: "11111111-1111-4111-8111-111111111111",
          storagePath: "receipts/22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-111111111111/missing.jpg",
          mimeType: "image/jpeg",
          fileSizeBytes: 10240,
          clientSubmissionId: "client_sub_missing",
          userId: "22222222-2222-4222-8222-222222222222",
        })
      ).rejects.toThrow("업로드된 영수증 파일을 스토리지에서 찾을 수 없습니다.");
    });

    it("blocks submission when file content fails magic bytes verification (400 INVALID_FILE_CONTENT)", async () => {
      const { createAdminClient } = await import("@/lib/supabase/server");
      const client = createAdminClient();
      const fakeTxtBuffer = Buffer.from("THIS IS NOT A VALID IMAGE FILE");
      (client.storage.from as any).mockReturnValueOnce({
        download: vi.fn().mockResolvedValueOnce({
          data: new Blob([fakeTxtBuffer]),
          error: null,
        }),
      });

      await expect(
        submitCustomerReceipt({
          accessSessionId: "11111111-1111-4111-8111-111111111111",
          storagePath: "receipts/22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-111111111111/fake.jpg",
          mimeType: "image/jpeg",
          fileSizeBytes: fakeTxtBuffer.byteLength,
          clientSubmissionId: "client_sub_fake",
          userId: "22222222-2222-4222-8222-222222222222",
        })
      ).rejects.toThrow("유효한 이미지(JPG, PNG, WebP) 형식이 아닙니다.");
    });

    it("invokes submit_customer_receipt RPC using server-measured byte length and returns PublicReceiptSubmission", async () => {
      const { createAdminClient } = await import("@/lib/supabase/server");
      const client = createAdminClient();
      (client.storage.from as any).mockReturnValueOnce({
        download: vi.fn().mockResolvedValueOnce({
          data: new Blob([validJpgBuffer]),
          error: null,
        }),
      });
      let capturedRpcParams: any = null;
      (client.rpc as any).mockImplementationOnce((fnName: string, params: any) => {
        capturedRpcParams = params;
        return Promise.resolve({
          data: {
            ok: true,
            reused: false,
            receipt: {
              id: "sub-999",
              access_session_id: params.p_access_session_id,
              user_id: params.p_caller_user_id,
              storage_path: params.p_storage_path,
              mime_type: params.p_mime_type,
              file_size_bytes: params.p_file_size_bytes,
              original_filename: "receipt.jpg",
              submission_status: "submitted",
              created_at: "2026-11-15T12:00:00Z",
            },
          },
          error: null,
        });
      });

      const res = await submitCustomerReceipt({
        accessSessionId: "11111111-1111-4111-8111-111111111111",
        storagePath: "receipts/22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-111111111111/photo.jpg",
        mimeType: "image/jpeg",
        fileSizeBytes: 999999, // Client claims a fake size!
        originalFilename: "receipt.jpg",
        clientSubmissionId: "client_sub_12345",
        userId: "22222222-2222-4222-8222-222222222222",
      });

      expect(res.reused).toBe(false);
      expect(res.receipt.id).toBe("sub-999");
      expect(res.receipt.fileSizeBytes).toBe(validJpgBuffer.byteLength); // Server verified actual size!
      expect(capturedRpcParams.p_file_size_bytes).toBe(validJpgBuffer.byteLength);
    });
  });

  describe("Service Layer: createReceiptSignedReadUrl", () => {
    it("blocks non-admin users from generating signed read URLs for other users' receipts (403)", async () => {
      await expect(
        createReceiptSignedReadUrl({
          storagePath: "receipts/other_user_id/session_1/photo.jpg",
          userId: "my_user_id",
          isAdmin: false,
        })
      ).rejects.toThrow("영수증 이미지에 대한 열람 권한이 없습니다.");
    });

    it("allows owner to generate signed read URL", async () => {
      const url = await createReceiptSignedReadUrl({
        storagePath: "receipts/my_user_id/session_1/photo.jpg",
        userId: "my_user_id",
        isAdmin: false,
      });
      expect(url).toContain("https://storage.mock");
    });

    it("allows admin to generate signed read URL for any receipt", async () => {
      const url = await createReceiptSignedReadUrl({
        storagePath: "receipts/other_user_id/session_1/photo.jpg",
        userId: "admin_user_id",
        isAdmin: true,
      });
      expect(url).toContain("https://storage.mock");
    });
  });
});

