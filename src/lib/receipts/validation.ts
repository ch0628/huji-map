import { z } from "zod";
import type { ReceiptMimeType } from "./types";

export const ALLOWED_MIME_TYPES: readonly ReceiptMimeType[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const MAX_RECEIPT_FILE_SIZE = 10 * 1024 * 1024; // 10MB in bytes

export class ReceiptServiceError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "ReceiptServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Zod schema for POST /api/v1/receipts/upload-intent
 */
export const createUploadIntentSchema = z.object({
  accessSessionId: z
    .string()
    .uuid("유효한 UUID 형식이어야 합니다."),
  mimeType: z
    .string()
    .refine(
      (val): val is ReceiptMimeType =>
        ALLOWED_MIME_TYPES.includes(val as ReceiptMimeType),
      {
        message:
          "지원하지 않는 파일 형식입니다. JPG, PNG, WebP 형식만 가능합니다.",
      }
    ),
  fileSizeBytes: z
    .number()
    .int("파일 크기는 정수여야 합니다.")
    .min(1, "파일 크기는 1바이트 이상이어야 합니다.")
    .max(MAX_RECEIPT_FILE_SIZE, "영수증 이미지 파일 크기는 최대 10MB까지 가능합니다."),
  originalFilename: z
    .string()
    .max(255, "파일명은 255자 이하여야 합니다.")
    .optional()
    .nullable(),
});

export type CreateUploadIntentInput = z.infer<typeof createUploadIntentSchema>;

/**
 * Zod schema for POST /api/v1/receipts
 */
export const submitReceiptSchema = z.object({
  accessSessionId: z
    .string()
    .uuid("유효한 UUID 형식이어야 합니다."),
  storagePath: z
    .string()
    .min(1, "저장 경로를 입력해주세요.")
    .max(500, "저장 경로는 500자 이하여야 합니다."),
  mimeType: z
    .string()
    .refine(
      (val): val is ReceiptMimeType =>
        ALLOWED_MIME_TYPES.includes(val as ReceiptMimeType),
      {
        message:
          "지원하지 않는 파일 형식입니다. JPG, PNG, WebP 형식만 가능합니다.",
      }
    ),
  fileSizeBytes: z
    .number()
    .int("파일 크기는 정수여야 합니다.")
    .min(1, "파일 크기는 1바이트 이상이어야 합니다.")
    .max(MAX_RECEIPT_FILE_SIZE, "영수증 이미지 파일 크기는 최대 10MB까지 가능합니다."),
  originalFilename: z
    .string()
    .max(255, "파일명은 255자 이하여야 합니다.")
    .optional()
    .nullable(),
  clientSubmissionId: z
    .string()
    .min(8, "제출 식별자는 8자 이상이어야 합니다.")
    .max(128, "제출 식별자는 128자 이하여야 합니다."),
});

export type SubmitReceiptInput = z.infer<typeof submitReceiptSchema>;

/**
 * Sanitizes original filename to prevent path traversal or special character attacks.
 */
export function sanitizeFilename(filename: string | null | undefined): string | null {
  if (!filename) return null;
  const basename = filename.split(/[/\\]/).pop() || "";
  const cleaned = basename
    .replace(/[^a-zA-Z0-9._\-가-힣\s]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/\.+/g, ".")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 255) : null;
}

/**
 * Magic Bytes validator for supported receipt image formats.
 * JPG: FF D8 FF
 * PNG: 89 50 4E 47 0D 0A 1A 0A
 * WebP: 52 49 46 46 (RIFF) + 57 45 42 50 (WEBP)
 */
export function verifyReceiptMagicBytes(
  buffer: Buffer | Uint8Array,
  declaredMimeType: ReceiptMimeType
): boolean {
  if (!buffer || buffer.length < 12) {
    return false;
  }

  const bytes = buffer instanceof Buffer ? buffer : Buffer.from(buffer);

  if (declaredMimeType === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }

  if (declaredMimeType === "image/png") {
    return (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }

  if (declaredMimeType === "image/webp") {
    const isRiff =
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46;
    const isWebp =
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50;
    return isRiff && isWebp;
  }

  return false;
}

/**
 * Zod schema for POST /api/v1/admin/receipts/:id/decision
 */
export const adminReceiptDecisionSchema = z.object({
  decision: z.enum(["approved", "rejected", "resubmission_requested"]),
  reason: z
    .string()
    .trim()
    .min(2, "심사 사유는 최소 2자 이상 입력해야 합니다.")
    .max(500, "심사 사유는 최대 500자까지 가능합니다."),
  confirmedStore: z
    .string()
    .trim()
    .max(100, "확인된 가게 상호명은 100자 이하여야 합니다.")
    .optional()
    .nullable(),
  confirmedPurchaseAt: z
    .string()
    .refine((val) => !val || !isNaN(Date.parse(val)), {
      message: "유효한 날짜 및 시각 형식이어야 합니다.",
    })
    .optional()
    .nullable(),
  confirmedAmount: z
    .number()
    .int("확인 금액은 정수여야 합니다.")
    .min(0, "확인 금액은 0원 이상이어야 합니다.")
    .optional()
    .nullable(),
  receiptReference: z
    .string()
    .trim()
    .max(100, "영수증 참조 식별자는 100자 이하여야 합니다.")
    .optional()
    .nullable(),
});

export type AdminReceiptDecisionInput = z.infer<typeof adminReceiptDecisionSchema>;

/**
 * Zod schema for GET /api/v1/admin/receipts query params
 */
export const adminReceiptsFilterSchema = z.object({
  status: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type AdminReceiptsFilterInput = z.infer<typeof adminReceiptsFilterSchema>;

