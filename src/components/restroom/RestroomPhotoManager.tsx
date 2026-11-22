"use client";

import React, { useEffect, useRef, useState } from "react";
import type { PublicRestroomPhoto, RestroomPhoto, RestroomPhotoType } from "@/lib/restrooms/types";
import {
  ALLOWED_PHOTO_MIME_TYPES,
  MAX_RESTROOM_PHOTOS,
  MAX_RESTROOM_PHOTO_BYTES,
  type RestroomPhotoMimeType,
} from "@/lib/restrooms/photo-validation";

export const PHOTO_TYPE_LABELS: Record<RestroomPhotoType, string> = {
  exterior: "매장/건물 외관",
  entrance: "화장실 출입구",
  interior: "화장실 내부",
  signage: "안내 표지판",
  other: "기타",
};

export interface QueuedRestroomPhoto {
  localId: string;
  file: File;
  previewUrl: string;
  photoType: RestroomPhotoType;
  isPrimary: boolean;
}

export interface UploadedRestroomPhotoResult {
  photo: RestroomPhoto;
}

export type RestroomPhotoUploadFn = (params: {
  restroomId: string;
  file: File;
  photoType: RestroomPhotoType;
  isPrimary: boolean;
  replacesPhotoId?: string | null;
}) => Promise<RestroomPhoto>;

/**
 * Shared client upload pipeline:
 * 1) POST upload-intent -> signed upload URL
 * 2) PUT binary to private Supabase Storage signed URL
 * 3) POST register metadata + server magic-byte validation
 */
export async function uploadRestroomPhotoFile(params: {
  restroomId: string;
  file: File;
  photoType: RestroomPhotoType;
  isPrimary: boolean;
  replacesPhotoId?: string | null;
}): Promise<RestroomPhoto> {
  const { restroomId, file, photoType, isPrimary, replacesPhotoId = null } = params;

  const intentRes = await fetch(
    `/api/v1/merchant/restrooms/${restroomId}/photos/upload-intent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        mimeType: file.type,
        fileSizeBytes: file.size,
        photoType,
        isPrimary,
        replacesPhotoId,
      }),
    }
  );

  const intentJson = await intentRes.json().catch(() => null);
  if (!intentRes.ok || !intentJson?.ok || !intentJson?.data?.uploadUrl) {
    throw new Error(
      intentJson?.error?.message || "사진 업로드 권한을 확인하지 못했습니다."
    );
  }

  const { uploadUrl, storagePath } = intentJson.data as {
    uploadUrl: string;
    storagePath: string;
  };

  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": file.type,
      "x-upsert": "false",
    },
    body: file,
  });

  if (!uploadRes.ok) {
    throw new Error(
      "사진 파일을 스토리지에 전송하지 못했습니다. 잠시 후 다시 시도해 주세요."
    );
  }

  const registerRes = await fetch(
    `/api/v1/merchant/restrooms/${restroomId}/photos`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        storagePath,
        mimeType: file.type,
        photoType,
        isPrimary,
        replacesPhotoId,
      }),
    }
  );

  const registerJson = await registerRes.json().catch(() => null);
  if (!registerRes.ok || !registerJson?.ok || !registerJson?.data) {
    throw new Error(
      registerJson?.error?.message || "업로드한 사진 등록 검증에 실패했습니다."
    );
  }

  return registerJson.data as RestroomPhoto;
}

export function validatePhotoFileSelection(file: File): string | null {
  if (
    !ALLOWED_PHOTO_MIME_TYPES.includes(file.type as RestroomPhotoMimeType)
  ) {
    return "JPG, PNG, WebP 이미지 파일만 첨부할 수 있습니다.";
  }
  if (file.size <= 0 || file.size > MAX_RESTROOM_PHOTO_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(2);
    return `파일 크기는 1바이트 이상 10MB 이하여야 합니다. (선택: ${mb}MB)`;
  }
  return null;
}

interface RestroomPhotoManagerCreateProps {
  mode: "create";
  queuedPhotos: QueuedRestroomPhoto[];
  onQueuedPhotosChange: (next: QueuedRestroomPhoto[]) => void;
  disabled?: boolean;
}

interface RestroomPhotoManagerManageProps {
  mode: "manage";
  restroomId: string;
  photos: RestroomPhoto[];
  onPhotosChanged: () => void | Promise<void>;
  uploadFn?: RestroomPhotoUploadFn;
  disabled?: boolean;
}

type RestroomPhotoManagerProps =
  | RestroomPhotoManagerCreateProps
  | RestroomPhotoManagerManageProps;

export default function RestroomPhotoManager(props: RestroomPhotoManagerProps) {
  const [selectedType, setSelectedType] = useState<RestroomPhotoType>("entrance");
  const replaceTargetIdRef = useRef<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const inFlightRef = useRef(false);

  // Clean up object URLs on unmount in create mode
  const queuedRef = useRef<QueuedRestroomPhoto[]>([]);
  if (props.mode === "create") {
    queuedRef.current = props.queuedPhotos;
  }
  useEffect(() => {
    return () => {
      for (const item of queuedRef.current) {
        try {
          URL.revokeObjectURL(item.previewUrl);
        } catch {
          // ignore
        }
      }
    };
  }, []);

  if (props.mode === "create") {
    const { queuedPhotos, onQueuedPhotosChange, disabled = false } = props;

    const handleQueueFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
      setErrorMsg(null);
      const files = Array.from(e.target.files || []);
      e.target.value = "";
      if (files.length === 0) return;

      const remaining = MAX_RESTROOM_PHOTOS - queuedPhotos.length;
      if (remaining <= 0) {
        setErrorMsg(`사진은 화장실당 최대 ${MAX_RESTROOM_PHOTOS}장까지 첨부할 수 있습니다.`);
        return;
      }

      const nextList = [...queuedPhotos];
      for (const file of files.slice(0, remaining)) {
        const validationErr = validatePhotoFileSelection(file);
        if (validationErr) {
          setErrorMsg(validationErr);
          continue;
        }
        let previewUrl = "";
        try {
          previewUrl = URL.createObjectURL(file);
        } catch {
          previewUrl = "";
        }
        nextList.push({
          localId: crypto.randomUUID(),
          file,
          previewUrl,
          photoType: selectedType,
          isPrimary: nextList.length === 0,
        });
      }

      if (files.length > remaining) {
        setErrorMsg(
          `최대 ${MAX_RESTROOM_PHOTOS}장 제한으로 처음 ${remaining}장만 추가되었습니다.`
        );
      }

      onQueuedPhotosChange(nextList);
    };

    const handleRemoveQueued = (localId: string) => {
      const target = queuedPhotos.find((q) => q.localId === localId);
      if (target?.previewUrl) {
        try {
          URL.revokeObjectURL(target.previewUrl);
        } catch {
          // ignore
        }
      }
      const filtered = queuedPhotos.filter((q) => q.localId !== localId);
      if (filtered.length > 0 && !filtered.some((q) => q.isPrimary)) {
        filtered[0] = { ...filtered[0], isPrimary: true };
      }
      onQueuedPhotosChange(filtered);
    };

    const handleSetQueuedPrimary = (localId: string) => {
      onQueuedPhotosChange(
        queuedPhotos.map((q) => ({
          ...q,
          isPrimary: q.localId === localId,
        }))
      );
    };

    const handleChangeQueuedType = (localId: string, photoType: RestroomPhotoType) => {
      onQueuedPhotosChange(
        queuedPhotos.map((q) =>
          q.localId === localId ? { ...q, photoType } : q
        )
      );
    };

    return (
      <div
        className="space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800"
        data-testid="restroom-photo-create-section"
      >
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">
              5. 화장실 사진 첨부 (선택 · 최대 {MAX_RESTROOM_PHOTOS}장)
            </h3>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              JPG, PNG, WebP (장당 최대 10MB). 첨부한 사진은 관리자 화장실 승인 시 함께 공개됩니다.
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-300">
            {queuedPhotos.length}/{MAX_RESTROOM_PHOTOS}
          </span>
        </div>

        {errorMsg && (
          <div
            role="alert"
            data-testid="restroom-photo-error"
            className="rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
          >
            {errorMsg}
          </div>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <select
            aria-label="새 사진 유형"
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value as RestroomPhotoType)}
            disabled={disabled}
            className="min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
          >
            {Object.entries(PHOTO_TYPE_LABELS).map(([val, label]) => (
              <option key={val} value={val}>
                {label}
              </option>
            ))}
          </select>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            disabled={disabled || queuedPhotos.length >= MAX_RESTROOM_PHOTOS}
            onChange={handleQueueFiles}
            data-testid="restroom-photo-file-input"
            className="sr-only"
          />
          <button
            type="button"
            disabled={disabled || queuedPhotos.length >= MAX_RESTROOM_PHOTOS}
            onClick={() => fileInputRef.current?.click()}
            data-testid="restroom-photo-add-btn"
            className="min-h-[44px] flex-1 rounded-xl border border-dashed border-blue-400 bg-blue-50/50 px-4 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300"
          >
            📸 사진 파일 선택 ({queuedPhotos.length}/{MAX_RESTROOM_PHOTOS})
          </button>
        </div>

        {queuedPhotos.length > 0 && (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
            {queuedPhotos.map((item) => (
              <div
                key={item.localId}
                data-testid={`queued-photo-${item.localId}`}
                className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50 p-2.5 dark:border-slate-800 dark:bg-slate-800/40"
              >
                <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-slate-200 dark:bg-slate-800">
                  {item.previewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.previewUrl}
                      alt={item.file.name}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-[11px] text-slate-500">
                      미리보기 없음
                    </div>
                  )}
                  {item.isPrimary && (
                    <span className="absolute left-1.5 top-1.5 rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                      대표
                    </span>
                  )}
                </div>

                <p className="truncate text-[11px] font-medium text-slate-700 dark:text-slate-300">
                  {item.file.name}
                </p>

                <select
                  aria-label="사진 용도 선택"
                  value={item.photoType}
                  disabled={disabled}
                  onChange={(e) =>
                    handleChangeQueuedType(
                      item.localId,
                      e.target.value as RestroomPhotoType
                    )
                  }
                  className="min-h-[36px] rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                >
                  {Object.entries(PHOTO_TYPE_LABELS).map(([val, label]) => (
                    <option key={val} value={val}>
                      {label}
                    </option>
                  ))}
                </select>

                <div className="flex items-center justify-between gap-1.5">
                  <button
                    type="button"
                    disabled={disabled || item.isPrimary}
                    onClick={() => handleSetQueuedPrimary(item.localId)}
                    className="min-h-[36px] flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                  >
                    {item.isPrimary ? "대표 사진" : "대표로 지정"}
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => handleRemoveQueued(item.localId)}
                    className="min-h-[36px] rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1 text-[11px] font-semibold text-rose-700 hover:bg-rose-100 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
                  >
                    제거
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Manage mode (existing restroom detail)
  const {
    restroomId,
    photos,
    onPhotosChanged,
    uploadFn = uploadRestroomPhotoFile,
    disabled = false,
  } = props;

  const activeApproved = photos.filter((p) => p.moderation_status === "approved");
  const pendingNew = photos.filter(
    (p) => p.moderation_status === "pending" && !p.replaces_photo_id
  );
  const pendingReplacements = photos.filter(
    (p) => p.moderation_status === "pending" && Boolean(p.replaces_photo_id)
  );
  const rejectedPhotos = photos.filter((p) => p.moderation_status === "rejected");
  const slotCount = activeApproved.length + pendingNew.length;
  const canAddNew = slotCount < MAX_RESTROOM_PHOTOS && !disabled && !isBusy;

  const handleManageUpload = async (
    file: File,
    replacesPhotoId: string | null
  ) => {
    if (inFlightRef.current) return;
    const validationErr = validatePhotoFileSelection(file);
    if (validationErr) {
      setErrorMsg(validationErr);
      return;
    }

    inFlightRef.current = true;
    setIsBusy(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      await uploadFn({
        restroomId,
        file,
        photoType: selectedType,
        isPrimary: !replacesPhotoId && activeApproved.every((p) => !p.is_primary) && pendingNew.every((p) => !p.is_primary),
        replacesPhotoId,
      });

      replaceTargetIdRef.current = null;
      setSuccessMsg(
        replacesPhotoId
          ? "교체용 새 사진이 대기(pending) 상태로 등록되었습니다. 관리자 승인 전까지 기존 사진이 계속 공개됩니다."
          : "사진이 업로드되었습니다. 관리자 승인 후 고객에게 공개됩니다."
      );
      await onPhotosChanged();
    } catch (err: unknown) {
      setErrorMsg(
        err instanceof Error ? err.message : "사진 업로드 중 오류가 발생했습니다."
      );
    } finally {
      inFlightRef.current = false;
      setIsBusy(false);
    }
  };

  const handleDeletePending = async (photoId: string) => {
    if (inFlightRef.current || disabled) return;
    inFlightRef.current = true;
    setIsBusy(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const res = await fetch(
        `/api/v1/merchant/restrooms/${restroomId}/photos/${photoId}`,
        { method: "DELETE" }
      );
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error?.message || "사진 삭제에 실패했습니다.");
      }
      setSuccessMsg("대기 중인 사진을 삭제했습니다.");
      await onPhotosChanged();
    } catch (err: unknown) {
      setErrorMsg(
        err instanceof Error ? err.message : "사진 삭제 중 오류가 발생했습니다."
      );
    } finally {
      inFlightRef.current = false;
      setIsBusy(false);
    }
  };

  const renderStatusBadge = (photo: RestroomPhoto) => {
    if (photo.moderation_status === "approved") {
      return (
        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          공개 승인됨
        </span>
      );
    }
    if (photo.moderation_status === "pending") {
      return (
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          {photo.replaces_photo_id ? "교체 심사 대기" : "승인 대기 (pending)"}
        </span>
      );
    }
    return (
      <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-700 dark:bg-slate-800 dark:text-slate-300">
        반려/교체됨
      </span>
    );
  };

  return (
    <section
      data-testid="restroom-photo-manager"
      className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-slate-900 dark:text-white">
            화장실 사진 관리 ({slotCount}/{MAX_RESTROOM_PHOTOS})
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            JPG, PNG, WebP (최대 10MB). 승인된 사진을 교체해도 관리자 승인 전까지는 기존 사진이 계속 공개됩니다.
          </p>
        </div>
      </div>

      {errorMsg && (
        <div
          role="alert"
          data-testid="restroom-photo-manage-error"
          className="rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          {errorMsg}
        </div>
      )}

      {successMsg && (
        <div
          role="status"
          data-testid="restroom-photo-manage-success"
          className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
        >
          {successMsg}
        </div>
      )}

      {/* 새 사진 추가 영역 */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <select
          aria-label="업로드 사진 유형"
          value={selectedType}
          disabled={disabled || isBusy}
          onChange={(e) => setSelectedType(e.target.value as RestroomPhotoType)}
          className="min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
        >
          {Object.entries(PHOTO_TYPE_LABELS).map(([val, label]) => (
            <option key={val} value={val}>
              {label}
            </option>
          ))}
        </select>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={!canAddNew}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void handleManageUpload(file, null);
          }}
          data-testid="restroom-photo-manage-file-input"
          className="sr-only"
        />
        <button
          type="button"
          disabled={!canAddNew}
          onClick={() => fileInputRef.current?.click()}
          data-testid="restroom-photo-manage-add-btn"
          className="min-h-[44px] flex-1 rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isBusy
            ? "업로드 중..."
            : slotCount >= MAX_RESTROOM_PHOTOS
            ? `최대 ${MAX_RESTROOM_PHOTOS}장 등록 완료 (교체 이용)`
            : "+ 새 화장실 사진 업로드"}
        </button>
      </div>

      {/* 교체용 숨겨진 파일 입력 */}
      <input
        ref={replaceInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        disabled={disabled || isBusy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file && replaceTargetIdRef.current) {
            void handleManageUpload(file, replaceTargetIdRef.current);
          }
        }}
        data-testid="restroom-photo-replace-file-input"
        className="sr-only"
      />

      {/* 등록된 사진 목록 */}
      {photos.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
          아직 등록된 화장실 사진이 없습니다.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {[...activeApproved, ...pendingNew, ...pendingReplacements, ...rejectedPhotos].map(
            (photo) => {
              const hasPendingReplacement = pendingReplacements.some(
                (rep) => rep.replaces_photo_id === photo.id
              );

              return (
                <div
                  key={photo.id}
                  data-testid={`merchant-photo-card-${photo.id}`}
                  className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50/60 p-3 dark:border-slate-800 dark:bg-slate-800/30"
                >
                  <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-slate-200 dark:bg-slate-800">
                    {photo.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={photo.image_url}
                        alt={PHOTO_TYPE_LABELS[photo.photo_type] || "화장실 사진"}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-[11px] text-slate-500">
                        {PHOTO_TYPE_LABELS[photo.photo_type] || photo.photo_type}
                      </div>
                    )}
                    {photo.is_primary && (
                      <span className="absolute left-1.5 top-1.5 rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                        대표
                      </span>
                    )}
                  </div>

                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="font-semibold text-slate-800 dark:text-slate-200">
                      {PHOTO_TYPE_LABELS[photo.photo_type] || photo.photo_type}
                    </span>
                    {renderStatusBadge(photo)}
                  </div>

                  {photo.moderation_status === "approved" && (
                    <button
                      type="button"
                      disabled={disabled || isBusy || hasPendingReplacement}
                      onClick={() => {
                        replaceTargetIdRef.current = photo.id;
                        replaceInputRef.current?.click();
                      }}
                      data-testid={`replace-photo-btn-${photo.id}`}
                      className="min-h-[40px] w-full rounded-lg border border-blue-300 bg-white px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-800 dark:bg-slate-900 dark:text-blue-300"
                    >
                      {hasPendingReplacement ? "교체 심사 대기 중" : "이 사진 교체하기"}
                    </button>
                  )}

                  {photo.moderation_status === "pending" && (
                    <button
                      type="button"
                      disabled={disabled || isBusy}
                      onClick={() => void handleDeletePending(photo.id)}
                      data-testid={`delete-pending-photo-btn-${photo.id}`}
                      className="min-h-[40px] w-full rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
                    >
                      대기 사진 삭제
                    </button>
                  )}
                </div>
              );
            }
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Shared read-only public photo slider with lightbox zoom for approved restroom photos (max 3).
 * Follows horizontal scroll-snap carousel accessibility and touch ergonomics.
 */
export function PublicRestroomPhotoGallery({
  restroomName,
  photos,
}: {
  restroomName: string;
  photos?: PublicRestroomPhoto[];
}) {
  const visiblePhotos = React.useMemo(
    () =>
      (photos ?? [])
        .filter((p) => !("moderation_status" in p) || (p as { moderation_status?: string }).moderation_status === "approved")
        .slice(0, 3),
    [photos]
  );

  const trackRef = useRef<HTMLDivElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [zoomIndex, setZoomIndex] = useState<number | null>(null);
  const [loadedMap, setLoadedMap] = useState<Record<string, boolean>>({});
  const [failedMap, setFailedMap] = useState<Record<string, boolean>>({});
  const [liveStatus, setLiveStatus] = useState("");
  const scrollRafRef = useRef<number | null>(null);

  React.useEffect(() => {
    setActiveIndex(0);
    setZoomIndex(null);
  }, [visiblePhotos.length]);

  React.useEffect(() => {
    if (zoomIndex === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setZoomIndex(null);
      } else if (e.key === "ArrowLeft" && visiblePhotos.length > 1) {
        setZoomIndex((prev) =>
          prev === null ? null : (prev - 1 + visiblePhotos.length) % visiblePhotos.length
        );
      } else if (e.key === "ArrowRight" && visiblePhotos.length > 1) {
        setZoomIndex((prev) =>
          prev === null ? null : (prev + 1) % visiblePhotos.length
        );
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [zoomIndex, visiblePhotos.length]);

  if (visiblePhotos.length === 0) return null;

  const total = visiblePhotos.length;
  const clampedActive = Math.min(activeIndex, total - 1);

  const goToSlide = (nextIdx: number) => {
    const normalized = ((nextIdx % total) + total) % total;
    setActiveIndex(normalized);
    setLiveStatus(`${normalized + 1} / ${total}번째 사진`);
    const track = trackRef.current;
    if (track && typeof track.scrollTo === "function") {
      track.scrollTo({
        left: normalized * track.clientWidth,
        behavior: "smooth",
      });
    }
  };

  const handleTrackScroll = () => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const track = trackRef.current;
      if (!track || track.clientWidth <= 0) return;
      const idx = Math.round(track.scrollLeft / track.clientWidth);
      const bounded = Math.max(0, Math.min(total - 1, idx));
      if (bounded !== activeIndex) {
        setActiveIndex(bounded);
        setLiveStatus(`${bounded + 1} / ${total}번째 사진`);
      }
    });
  };

  const zoomedPhoto = zoomIndex !== null ? visiblePhotos[zoomIndex] : null;

  return (
    <section
      data-testid="public-restroom-photos-section"
      role="region"
      aria-roledescription="carousel"
      aria-label={`${restroomName} 화장실 사진`}
      className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="relative overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-800">
        {/* 좌우 네이티브 스와이프 트랙 */}
        <div
          ref={trackRef}
          tabIndex={0}
          role="group"
          aria-label="사진 슬라이드"
          data-testid="restroom-photo-slider-track"
          onScroll={handleTrackScroll}
          style={{
            overscrollBehaviorX: "contain",
            touchAction: "manipulation",
            scrollbarWidth: "none",
          }}
          className="flex snap-x snap-mandatory overflow-x-auto scroll-smooth focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 [&::-webkit-scrollbar]:hidden"
        >
          {visiblePhotos.map((photo, idx) => {
            const label = PHOTO_TYPE_LABELS[photo.photo_type] || photo.photo_type || "현장 사진";
            const isLoaded = Boolean(loadedMap[photo.id]);
            const isFailed = Boolean(failedMap[photo.id]) || !photo.image_url;

            return (
              <div
                key={photo.id}
                role="group"
                aria-roledescription="slide"
                aria-label={`${idx + 1} / ${total} ${label}`}
                data-testid={`public-restroom-photo-${photo.id}`}
                className="relative h-52 w-full flex-[0_0_100%] snap-center sm:h-64"
              >
                {isFailed ? (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-xs text-slate-500 dark:text-slate-400">
                    <span aria-hidden="true">🖼️</span>
                    <span>사진을 불러올 수 없습니다.</span>
                  </div>
                ) : (
                  <button
                    type="button"
                    data-testid={`public-restroom-photo-zoom-btn-${idx}`}
                    aria-label={`${label} 크게 보기 (${idx + 1}/${total})`}
                    onClick={() => setZoomIndex(idx)}
                    className="relative block h-full w-full cursor-zoom-in focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
                  >
                    {!isLoaded && (
                      <div
                        aria-hidden="true"
                        className="absolute inset-0 animate-pulse bg-slate-200 dark:bg-slate-700"
                      />
                    )}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={photo.image_url!}
                      alt={`${restroomName} ${label}`}
                      onLoad={() =>
                        setLoadedMap((prev) => ({ ...prev, [photo.id]: true }))
                      }
                      onError={() =>
                        setFailedMap((prev) => ({ ...prev, [photo.id]: true }))
                      }
                      className="h-full w-full object-cover"
                    />
                  </button>
                )}

                <span className="pointer-events-none absolute bottom-2.5 left-2.5 rounded-md bg-slate-900/75 px-2 py-0.5 text-[11px] font-medium text-white">
                  {photo.is_primary ? "대표 · " : ""}
                  {label}
                </span>
              </div>
            );
          })}
        </div>

        {/* 사진 순서 표시 */}
        <span
          data-testid="restroom-photo-counter"
          className="pointer-events-none absolute right-2.5 top-2.5 rounded-full bg-slate-900/75 px-2.5 py-0.5 text-[11px] font-semibold text-white"
        >
          {clampedActive + 1} / {total}
        </span>

        {/* 이전 / 다음 버튼 (2장 이상일 때) */}
        {total > 1 && (
          <div className="pointer-events-none absolute inset-y-0 left-0 right-0 flex items-center justify-between px-2">
            <button
              type="button"
              data-testid="restroom-photo-prev-btn"
              aria-label="이전 사진"
              onClick={() => goToSlide(clampedActive - 1)}
              className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full bg-slate-900/65 text-white shadow hover:bg-slate-900/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              ‹
            </button>
            <button
              type="button"
              data-testid="restroom-photo-next-btn"
              aria-label="다음 사진"
              onClick={() => goToSlide(clampedActive + 1)}
              className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full bg-slate-900/65 text-white shadow hover:bg-slate-900/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              ›
            </button>
          </div>
        )}
      </div>

      {/* 하단 슬라이드 점 표시 (2장 이상일 때, >=24px 터치 영역) */}
      {total > 1 && (
        <nav
          aria-label="사진 선택"
          className="mt-2 flex items-center justify-center gap-1"
        >
          {visiblePhotos.map((photo, idx) => {
            const isCurrent = idx === clampedActive;
            return (
              <button
                key={photo.id}
                type="button"
                data-testid={`restroom-photo-dot-${idx}`}
                aria-label={`${idx + 1}번째 사진으로 이동`}
                aria-current={isCurrent ? "true" : undefined}
                onClick={() => goToSlide(idx)}
                className="flex min-h-[24px] min-w-[24px] items-center justify-center"
              >
                <span
                  className={`block h-2 rounded-full transition-all ${
                    isCurrent
                      ? "w-5 bg-slate-800 dark:bg-white"
                      : "w-2 bg-slate-300 dark:bg-slate-600"
                  }`}
                />
              </button>
            );
          })}
        </nav>
      )}

      <p className="sr-only" role="status" aria-live="polite">
        {liveStatus}
      </p>

      {/* 사진 확대 모달 */}
      {zoomedPhoto && zoomIndex !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="화장실 사진 확대 보기"
          data-testid="restroom-photo-zoom-modal"
          onClick={() => setZoomIndex(null)}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/85 p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative flex w-full max-w-2xl flex-col items-center gap-3"
          >
            <div className="flex w-full items-center justify-between text-xs text-white">
              <span className="font-semibold">
                {zoomIndex + 1} / {total} ·{" "}
                {PHOTO_TYPE_LABELS[zoomedPhoto.photo_type] || "현장 사진"}
              </span>
              <button
                type="button"
                data-testid="restroom-photo-zoom-close-btn"
                aria-label="확대 보기 닫기"
                onClick={() => setZoomIndex(null)}
                className="flex h-10 w-10 items-center justify-center rounded-lg text-white hover:bg-white/15"
              >
                ✕
              </button>
            </div>

            {zoomedPhoto.image_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={zoomedPhoto.image_url}
                alt={`${restroomName} 확대 사진`}
                data-testid="restroom-photo-zoom-img"
                className="max-h-[75vh] w-full rounded-xl object-contain"
              />
            )}

            {total > 1 && (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  aria-label="이전 확대 사진"
                  onClick={() =>
                    setZoomIndex((zoomIndex - 1 + total) % total)
                  }
                  className="min-h-[40px] rounded-xl bg-white/15 px-4 py-2 text-xs font-semibold text-white hover:bg-white/25"
                >
                  ‹ 이전
                </button>
                <button
                  type="button"
                  aria-label="다음 확대 사진"
                  onClick={() => setZoomIndex((zoomIndex + 1) % total)}
                  className="min-h-[40px] rounded-xl bg-white/15 px-4 py-2 text-xs font-semibold text-white hover:bg-white/25"
                >
                  다음 ›
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
