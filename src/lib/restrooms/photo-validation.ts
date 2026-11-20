import { z } from "zod";
import type { RestroomPhotoType } from "./types";

export const RESTROOM_PHOTO_BUCKET = "restroom-photos";
export const MAX_RESTROOM_PHOTOS = 3;
export const MAX_RESTROOM_PHOTO_BYTES = 10 * 1024 * 1024; // 10MB

export const ALLOWED_PHOTO_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type RestroomPhotoMimeType = (typeof ALLOWED_PHOTO_MIME_TYPES)[number];

export const RESTROOM_PHOTO_TYPES: readonly RestroomPhotoType[] = [
  "exterior",
  "entrance",
  "interior",
  "signage",
  "other",
] as const;

export class RestroomPhotoError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "RestroomPhotoError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const createRestroomPhotoUploadIntentSchema = z
  .object({
    mimeType: z
      .string()
      .refine(
        (val): val is RestroomPhotoMimeType =>
          ALLOWED_PHOTO_MIME_TYPES.includes(val as RestroomPhotoMimeType),
        {
          message:
            "지원하지 않는 파일 형식입니다. JPG, PNG, WebP 이미지 파일만 업로드할 수 있습니다.",
        }
      ),
    fileSizeBytes: z
      .number()
      .int("파일 크기는 정수여야 합니다.")
      .min(1, "파일 크기는 1바이트 이상이어야 합니다.")
      .max(
        MAX_RESTROOM_PHOTO_BYTES,
        "화장실 사진 파일 크기는 장당 최대 10MB까지 가능합니다."
      ),
    photoType: z
      .enum(["exterior", "entrance", "interior", "signage", "other"])
      .default("other"),
    isPrimary: z.boolean().default(false),
    replacesPhotoId: z
      .string()
      .uuid("유효한 교체 대상 사진 UUID가 아닙니다.")
      .optional()
      .nullable(),
  })
  .strict();

export type CreateRestroomPhotoUploadIntentInput = z.infer<
  typeof createRestroomPhotoUploadIntentSchema
>;

export const registerRestroomPhotoSchema = z
  .object({
    storagePath: z
      .string()
      .trim()
      .min(1, "저장 경로가 필요합니다.")
      .max(500, "저장 경로는 500자 이하여야 합니다."),
    mimeType: z
      .string()
      .refine(
        (val): val is RestroomPhotoMimeType =>
          ALLOWED_PHOTO_MIME_TYPES.includes(val as RestroomPhotoMimeType),
        {
          message:
            "지원하지 않는 파일 형식입니다. JPG, PNG, WebP 이미지 파일만 업로드할 수 있습니다.",
        }
      ),
    photoType: z
      .enum(["exterior", "entrance", "interior", "signage", "other"])
      .default("other"),
    isPrimary: z.boolean().default(false),
    replacesPhotoId: z
      .string()
      .uuid("유효한 교체 대상 사진 UUID가 아닙니다.")
      .optional()
      .nullable(),
  })
  .strict();

export type RegisterRestroomPhotoInput = z.infer<
  typeof registerRestroomPhotoSchema
>;

/**
 * Magic Bytes validator for JPG / PNG / WebP restroom photos.
 */
export function verifyRestroomPhotoMagicBytes(
  buffer: Buffer | Uint8Array,
  declaredMimeType: RestroomPhotoMimeType
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
