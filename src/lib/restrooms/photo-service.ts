import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient, isServiceRoleConfigured } from "@/lib/supabase/server";
import type { RestroomPhoto } from "./types";
import { assertMerchantAccessToRestroom, MerchantRestroomError } from "./merchant-service";
import { createSignedPhotoReadUrlMap } from "./photo-urls";
import {
  RESTROOM_PHOTO_BUCKET,
  MAX_RESTROOM_PHOTOS,
  MAX_RESTROOM_PHOTO_BYTES,
  RestroomPhotoError,
  verifyRestroomPhotoMagicBytes,
  type CreateRestroomPhotoUploadIntentInput,
  type RegisterRestroomPhotoInput,
} from "./photo-validation";

export interface RestroomPhotoUploadIntentResult {
  uploadUrl: string;
  storagePath: string;
  token?: string;
  expiresIn: number;
}

function getExtensionForMime(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/png") return "png";
  return "webp";
}

function mapOwnershipError(err: unknown): never {
  if (err instanceof MerchantRestroomError) {
    throw new RestroomPhotoError(err.code, err.message, err.statusCode);
  }
  throw err;
}

/**
 * Validates ownership, slot/replacement constraints, and issues a short-lived signed upload URL
 * for private Storage bucket `restroom-photos`.
 */
export async function createRestroomPhotoUploadIntent(params: {
  supabase: SupabaseClient<any>;
  userId: string;
  restroomId: string;
  input: CreateRestroomPhotoUploadIntentInput;
}): Promise<RestroomPhotoUploadIntentResult> {
  const { supabase, userId, restroomId, input } = params;

  try {
    await assertMerchantAccessToRestroom(supabase, userId, restroomId);
  } catch (err) {
    mapOwnershipError(err);
  }

  if (!isServiceRoleConfigured()) {
    throw new RestroomPhotoError(
      "CONFIG_REQUIRED",
      "서버 스토리지 서비스 설정이 필요합니다.",
      503
    );
  }

  const adminClient = createAdminClient() as any;

  // Pre-check current photos on this restroom before issuing signed upload URL
  const { data: existingPhotos, error: queryError } = await adminClient
    .from("restroom_photos")
    .select("id, is_primary, moderation_status, replaces_photo_id")
    .eq("restroom_id", restroomId);

  if (queryError) {
    throw new RestroomPhotoError(
      "DATABASE_ERROR",
      "기존 사진 현황을 확인하지 못했습니다.",
      500
    );
  }

  const rows = Array.isArray(existingPhotos) ? existingPhotos : [];

  if (input.replacesPhotoId) {
    const target = rows.find((r: any) => r.id === input.replacesPhotoId);
    if (!target) {
      throw new RestroomPhotoError(
        "TARGET_PHOTO_NOT_FOUND",
        "교체 대상 사진을 찾을 수 없습니다.",
        404
      );
    }
    if (target.moderation_status !== "approved") {
      throw new RestroomPhotoError(
        "INVALID_REPLACEMENT_TARGET",
        "승인된 사진만 교체 요청할 수 있습니다.",
        422
      );
    }
    const existingPendingReplacement = rows.find(
      (r: any) =>
        r.replaces_photo_id === input.replacesPhotoId &&
        r.moderation_status === "pending"
    );
    if (existingPendingReplacement) {
      throw new RestroomPhotoError(
        "PENDING_REPLACEMENT_EXISTS",
        "이미 해당 사진의 교체 심사가 대기 중입니다. 기존 대기 사진을 삭제한 후 다시 시도해 주세요.",
        409
      );
    }
  } else {
    const approvedCount = rows.filter(
      (r: any) => r.moderation_status === "approved"
    ).length;
    const pendingNewCount = rows.filter(
      (r: any) =>
        r.moderation_status === "pending" && !r.replaces_photo_id
    ).length;

    if (approvedCount + pendingNewCount >= MAX_RESTROOM_PHOTOS) {
      throw new RestroomPhotoError(
        "PHOTO_LIMIT_EXCEEDED",
        `화장실당 최대 ${MAX_RESTROOM_PHOTOS}장까지 등록할 수 있습니다. 승인된 사진을 바꾸려면 사진 교체를 이용해 주세요.`,
        422
      );
    }

    const hasApprovedPrimary = rows.some(
      (r: any) => r.is_primary === true && r.moderation_status === "approved"
    );
    if (input.isPrimary && hasApprovedPrimary) {
      throw new RestroomPhotoError(
        "PRIMARY_REPLACEMENT_REQUIRED",
        "이미 승인된 대표 사진이 있습니다. 대표 사진 변경은 기존 대표 사진의 교체 기능을 이용해 주세요.",
        409
      );
    }
  }

  const ext = getExtensionForMime(input.mimeType);
  const storagePath = `restrooms/${restroomId}/${crypto.randomUUID()}.${ext}`;
  const expiresIn = 900;

  const { data: signedData, error: signError } = await adminClient.storage
    .from(RESTROOM_PHOTO_BUCKET)
    .createSignedUploadUrl(storagePath);

  if (signError || !signedData?.signedUrl) {
    throw new RestroomPhotoError(
      "STORAGE_SIGN_FAILED",
      "사진 업로드 URL 발급에 실패했습니다. 잠시 후 다시 시도해 주세요.",
      500
    );
  }

  return {
    uploadUrl: signedData.signedUrl,
    storagePath,
    token: signedData.token,
    expiresIn,
  };
}

/**
 * Verifies the uploaded binary in private Storage (presence, byte size <= 10MB, magic bytes)
 * and atomically registers the pending photo row via SECURITY DEFINER RPC.
 */
export async function registerMerchantRestroomPhoto(params: {
  supabase: SupabaseClient<any>;
  userId: string;
  restroomId: string;
  input: RegisterRestroomPhotoInput;
}): Promise<RestroomPhoto> {
  const { supabase, userId, restroomId, input } = params;

  try {
    await assertMerchantAccessToRestroom(supabase, userId, restroomId);
  } catch (err) {
    mapOwnershipError(err);
  }

  if (!isServiceRoleConfigured()) {
    throw new RestroomPhotoError(
      "CONFIG_REQUIRED",
      "서버 스토리지 서비스 설정이 필요합니다.",
      503
    );
  }

  const expectedPrefix = `restrooms/${restroomId}/`;
  if (!input.storagePath.startsWith(expectedPrefix)) {
    throw new RestroomPhotoError(
      "FORBIDDEN",
      "유효하지 않은 저장 경로입니다.",
      403
    );
  }

  const adminClient = createAdminClient() as any;

  // 1. Download and verify actual uploaded file from private Storage
  let fileBuffer: Buffer;
  try {
    const { data: blobData, error: downloadError } = await adminClient.storage
      .from(RESTROOM_PHOTO_BUCKET)
      .download(input.storagePath);

    if (downloadError || !blobData) {
      throw new RestroomPhotoError(
        "FILE_NOT_FOUND",
        "업로드된 사진 파일을 스토리지에서 찾을 수 없습니다. 다시 업로드해 주세요.",
        400
      );
    }

    const arrayBuffer = await blobData.arrayBuffer();
    fileBuffer = Buffer.from(arrayBuffer);
  } catch (err) {
    if (err instanceof RestroomPhotoError) throw err;
    throw new RestroomPhotoError(
      "FILE_NOT_FOUND",
      "업로드된 사진 파일을 확인할 수 없습니다. 다시 업로드해 주세요.",
      400
    );
  }

  const actualSizeBytes = fileBuffer.byteLength;
  if (actualSizeBytes <= 0 || actualSizeBytes > MAX_RESTROOM_PHOTO_BYTES) {
    await safeRemoveStorageFile(adminClient, input.storagePath);
    throw new RestroomPhotoError(
      "INVALID_FILE_SIZE",
      `실제 파일 크기(${actualSizeBytes} bytes)가 허용 범위(1B ~ 10MB)를 벗어났습니다.`,
      400
    );
  }

  if (!verifyRestroomPhotoMagicBytes(fileBuffer, input.mimeType)) {
    await safeRemoveStorageFile(adminClient, input.storagePath);
    throw new RestroomPhotoError(
      "INVALID_FILE_CONTENT",
      "업로드된 파일의 실제 내용이 유효한 JPG, PNG, WebP 이미지가 아닙니다.",
      400
    );
  }

  // 2. Atomically register photo in DB
  const { data: rpcData, error: rpcError } = await adminClient.rpc(
    "register_merchant_restroom_photo",
    {
      p_restroom_id: restroomId,
      p_caller_user_id: userId,
      p_storage_path: input.storagePath,
      p_photo_type: input.photoType,
      p_is_primary: input.isPrimary,
      p_replaces_photo_id: input.replacesPhotoId ?? null,
    }
  );

  if (rpcError) {
    await safeRemoveStorageFile(adminClient, input.storagePath);
    throw new RestroomPhotoError(
      "DATABASE_ERROR",
      "화장실 사진 등록 중 오류가 발생했습니다.",
      500
    );
  }

  const result = typeof rpcData === "string" ? JSON.parse(rpcData) : rpcData;
  if (!result?.ok || !result.photo) {
    await safeRemoveStorageFile(adminClient, input.storagePath);
    throw new RestroomPhotoError(
      result?.error_code || "PHOTO_REGISTER_FAILED",
      result?.message || "화장실 사진을 등록할 수 없습니다.",
      result?.status || 400
    );
  }

  const photo = result.photo as RestroomPhoto;
  const signedMap = await createSignedPhotoReadUrlMap([photo.storage_path]);
  return {
    ...photo,
    image_url: signedMap.get(photo.storage_path) ?? null,
  };
}

/**
 * Deletes an unapproved ('pending') photo owned by the merchant and removes its Storage object.
 */
export async function deleteMerchantRestroomPhoto(params: {
  supabase: SupabaseClient<any>;
  userId: string;
  restroomId: string;
  photoId: string;
}): Promise<{ deletedId: string }> {
  const { supabase, userId, restroomId, photoId } = params;

  try {
    await assertMerchantAccessToRestroom(supabase, userId, restroomId);
  } catch (err) {
    mapOwnershipError(err);
  }

  if (!isServiceRoleConfigured()) {
    throw new RestroomPhotoError(
      "CONFIG_REQUIRED",
      "서버 스토리지 서비스 설정이 필요합니다.",
      503
    );
  }

  const adminClient = createAdminClient() as any;

  const { data: rpcData, error: rpcError } = await adminClient.rpc(
    "delete_merchant_restroom_photo",
    {
      p_restroom_id: restroomId,
      p_photo_id: photoId,
      p_caller_user_id: userId,
    }
  );

  if (rpcError) {
    throw new RestroomPhotoError(
      "DATABASE_ERROR",
      "사진 삭제 중 데이터베이스 오류가 발생했습니다.",
      500
    );
  }

  const result = typeof rpcData === "string" ? JSON.parse(rpcData) : rpcData;
  if (!result?.ok || !result.deleted) {
    throw new RestroomPhotoError(
      result?.error_code || "PHOTO_DELETE_FAILED",
      result?.message || "사진을 삭제할 수 없습니다.",
      result?.status || 400
    );
  }

  if (result.deleted.storage_path) {
    await safeRemoveStorageFile(adminClient, result.deleted.storage_path);
  }

  return { deletedId: photoId };
}

async function safeRemoveStorageFile(adminClient: any, storagePath: string): Promise<void> {
  try {
    await adminClient.storage?.from(RESTROOM_PHOTO_BUCKET)?.remove([storagePath]);
  } catch {
    // Best-effort cleanup
  }
}
