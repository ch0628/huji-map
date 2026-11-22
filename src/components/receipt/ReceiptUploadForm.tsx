"use client";

import React, { useState, useRef, useCallback } from "react";
import type { ReceiptMimeType, PublicReceiptSubmission } from "@/lib/receipts/types";
import { MAX_RECEIPT_FILE_SIZE } from "@/lib/receipts/validation";
import { focusFirstErrorField } from "@/lib/forms/validation-ux";

export interface ReceiptUploadFormProps {
  readonly accessSessionId: string;
  readonly partnerName?: string;
  readonly restroomName?: string;
  readonly hideContextSummary?: boolean;
  readonly onSuccess?: (receipt: PublicReceiptSubmission) => void;
  readonly onCancel?: () => void;
  readonly injectedUploadIntentRequester?: (params: {
    accessSessionId: string;
    mimeType: ReceiptMimeType;
    fileSizeBytes: number;
    originalFilename?: string;
  }) => Promise<{ uploadUrl: string; storagePath: string; token?: string }>;
  readonly injectedStorageUploader?: (params: {
    uploadUrl: string;
    file: File;
    token?: string;
  }) => Promise<void>;
  readonly injectedSubmitRequester?: (params: {
    accessSessionId: string;
    storagePath: string;
    mimeType: ReceiptMimeType;
    fileSizeBytes: number;
    originalFilename?: string;
    clientSubmissionId: string;
  }) => Promise<{ ok: boolean; receipt: PublicReceiptSubmission; reused: boolean }>;
}

const ALLOWED_MIME_TYPES: readonly ReceiptMimeType[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
];

type UploadStep = "idle" | "selected" | "requesting_intent" | "uploading_file" | "submitting" | "completed" | "error";

export function ReceiptUploadForm({
  accessSessionId,
  partnerName,
  restroomName,
  hideContextSummary = false,
  onSuccess,
  onCancel,
  injectedUploadIntentRequester,
  injectedStorageUploader,
  injectedSubmitRequester,
}: ReceiptUploadFormProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [step, setStep] = useState<UploadStep>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submittedReceipt, setSubmittedReceipt] = useState<PublicReceiptSubmission | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const submitInFlightRef = useRef(false);

  const clearSelection = useCallback(() => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
    setSelectedFile(null);
    setPreviewUrl(null);
    setErrorMessage(null);
    setStep("idle");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, [previewUrl]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setErrorMessage(null);

    // 1. MIME 타입 검증
    if (!ALLOWED_MIME_TYPES.includes(file.type as ReceiptMimeType)) {
      setErrorMessage(
        "지원하지 않는 파일 형식입니다. JPG, PNG, WebP 이미지만 업로드 가능합니다."
      );
      setStep("error");
      return;
    }

    // 2. 파일 크기 검증 (10MB 제한)
    if (file.size <= 0 || file.size > MAX_RECEIPT_FILE_SIZE) {
      setErrorMessage("파일 크기는 1바이트 이상 10MB 이하여야 합니다.");
      setStep("error");
      return;
    }

    // 3. 미리보기 생성
    try {
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);
    } catch {
      setPreviewUrl(null);
    }

    setSelectedFile(file);
    setStep("selected");
  };

  const handleUploadAndSubmit = async () => {
    if (!accessSessionId || submitInFlightRef.current) return;
    if (!selectedFile) {
      setErrorMessage("영수증 사진 파일을 선택해 주세요.");
      setStep("error");
      focusFirstErrorField(
        ["file"],
        { file: "영수증 사진 파일을 선택해 주세요." },
        { file: "receipt-select-file-trigger" }
      );
      return;
    }

    submitInFlightRef.current = true;
    setErrorMessage(null);
    const mimeType = selectedFile.type as ReceiptMimeType;
    const fileSizeBytes = selectedFile.size;
    const originalFilename = selectedFile.name;
    const clientSubmissionId = `sub_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;

    try {
      // 1단계: 업로드 인텐트 발급 요청
      setStep("requesting_intent");
      let intentResult: { uploadUrl: string; storagePath: string; token?: string };

      if (injectedUploadIntentRequester) {
        intentResult = await injectedUploadIntentRequester({
          accessSessionId,
          mimeType,
          fileSizeBytes,
          originalFilename,
        });
      } else {
        const intentRes = await fetch("/api/v1/receipts/upload-intent", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            accessSessionId,
            mimeType,
            fileSizeBytes,
            originalFilename,
          }),
        });

        const intentJson = await intentRes.json().catch(() => null);
        if (!intentRes.ok || !intentJson?.ok) {
          throw new Error(
            intentJson?.error?.message ||
              "영수증 업로드 권한을 확인하지 못했습니다."
          );
        }

        intentResult = {
          uploadUrl: intentJson.uploadUrl,
          storagePath: intentJson.storagePath,
          token: intentJson.token,
        };
      }

      // 2단계: 스토리지에 파일 실제 업로드
      setStep("uploading_file");
      if (injectedStorageUploader) {
        await injectedStorageUploader({
          uploadUrl: intentResult.uploadUrl,
          file: selectedFile,
          token: intentResult.token,
        });
      } else {
        // Supabase signed upload URL은 일반적으로 PUT 요청 사용
        const uploadHeaders: Record<string, string> = {
          "Content-Type": mimeType,
        };
        if (intentResult.token) {
          uploadHeaders["Authorization"] = `Bearer ${intentResult.token}`;
        }

        const uploadRes = await fetch(intentResult.uploadUrl, {
          method: "PUT",
          headers: uploadHeaders,
          body: selectedFile,
        });

        if (!uploadRes.ok) {
          throw new Error(
            "영수증 사진을 스토리지에 전송하지 못했습니다. 다시 시도해 주세요."
          );
        }
      }

      // 3단계: 영수증 메타데이터 제출 및 검증 등록
      setStep("submitting");
      let submitResult: { ok: boolean; receipt: PublicReceiptSubmission; reused: boolean };

      if (injectedSubmitRequester) {
        submitResult = await injectedSubmitRequester({
          accessSessionId,
          storagePath: intentResult.storagePath,
          mimeType,
          fileSizeBytes,
          originalFilename,
          clientSubmissionId,
        });
      } else {
        const submitRes = await fetch("/api/v1/receipts", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            accessSessionId,
            storagePath: intentResult.storagePath,
            mimeType,
            fileSizeBytes,
            originalFilename,
            clientSubmissionId,
          }),
        });

        const submitJson = await submitRes.json().catch(() => null);
        if (!submitRes.ok || !submitJson?.ok) {
          throw new Error(
            submitJson?.error?.message ||
              "영수증 제출 등록 중 오류가 발생했습니다."
          );
        }

        submitResult = submitJson;
      }

      // 완료
      setSubmittedReceipt(submitResult.receipt);
      setStep("completed");
    } catch (err: unknown) {
      setStep("error");
      const message =
        err instanceof Error ? err.message : "영수증 업로드 중 오류가 발생했습니다.";
      setErrorMessage(message);
    } finally {
      submitInFlightRef.current = false;
    }
  };

  const isProcessing =
    step === "requesting_intent" ||
    step === "uploading_file" ||
    step === "submitting";

  // 완료 화면 (UI-11: 핵심 정보 + 업로드 이미지 미리보기 중심, 내부 코드/파일명 제거)
  if (step === "completed" && submittedReceipt) {
    return (
      <div
        data-testid="receipt-upload-completed"
        className="rounded-2xl border border-emerald-300 bg-emerald-50 p-5 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
      >
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xl" aria-hidden="true">✅</span>
          <h3 className="text-base font-bold break-keep">영수증이 제출되었습니다.</h3>
        </div>
        {!hideContextSummary && partnerName && (
          <p className="text-xs font-semibold text-emerald-900 dark:text-emerald-200">
            {partnerName}
          </p>
        )}
        <p
          data-testid="completed-receipt-status"
          className="mt-1.5 text-xs leading-relaxed text-emerald-900 dark:text-emerald-300 break-keep"
        >
          영수증이 승인되면 환급 절차가 진행됩니다.
        </p>

        {previewUrl ? (
          <div className="mt-3 max-h-56 overflow-hidden rounded-xl border border-emerald-200 bg-white p-2 flex items-center justify-center dark:border-emerald-900/60 dark:bg-slate-900">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewUrl}
              alt="제출한 영수증 미리보기"
              data-testid="receipt-completed-preview-img"
              className="max-h-52 w-auto rounded-lg object-contain"
            />
          </div>
        ) : (
          <p className="mt-3 rounded-xl bg-white/80 p-3 text-xs text-slate-600 dark:bg-slate-900/60 dark:text-slate-300">
            영수증 이미지가 안전하게 등록되었습니다.
          </p>
        )}

        <div className="mt-4 flex flex-col gap-2">
          <button
            type="button"
            data-testid="receipt-upload-done-btn"
            onClick={() => {
              if (onSuccess && submittedReceipt) {
                onSuccess(submittedReceipt);
              }
              clearSelection();
            }}
            className="flex min-h-[44px] w-full items-center justify-center rounded-xl bg-emerald-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-emerald-700"
          >
            확인
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="receipt-upload-form"
      className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="mb-4">
        <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-1.5 break-keep">
          <span aria-hidden="true">🧾</span>
          <span>
            영수증 사진 올리기 <span className="text-rose-500">*</span>
          </span>
        </h3>
        {!hideContextSummary && partnerName && (
          <p className="mt-1 text-xs text-slate-700 dark:text-slate-300 font-semibold break-keep">
            {partnerName} {restroomName ? `(${restroomName})` : ""}
          </p>
        )}
        <p className="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-400 break-keep">
          매장에서 구매한 영수증 사진을 제출해 주세요. 확인 후 보증금이 환급됩니다.
        </p>
      </div>

      {/* 파일 형식 및 크기 안내 */}
      <p className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-[11px] font-medium text-slate-600 dark:bg-slate-800/60 dark:text-slate-400">
        JPG, PNG, WebP · 최대 10MB
      </p>

      {/* 파일 선택 인풋 (숨김) */}
      <input
        ref={fileInputRef}
        type="file"
        data-testid="receipt-file-input"
        accept="image/jpeg,image/png,image/webp"
        onChange={handleFileChange}
        disabled={isProcessing}
        className="hidden"
      />

      {/* 파일 선택 버튼 또는 미리보기 영역 */}
      {!selectedFile ? (
        <button
          id="receipt-select-file-trigger"
          type="button"
          data-testid="receipt-select-file-btn"
          aria-invalid={Boolean(errorMessage)}
          aria-describedby={errorMessage ? "receipt-upload-error-text" : undefined}
          onClick={() => fileInputRef.current?.click()}
          disabled={isProcessing}
          className={`flex min-h-[96px] w-full flex-col items-center justify-center rounded-xl border-2 border-dashed bg-slate-50/50 p-4 text-center transition dark:bg-slate-800/40 ${
            errorMessage
              ? "border-rose-500 ring-1 ring-rose-500/30"
              : "border-slate-300 hover:border-slate-400 hover:bg-slate-100/50 dark:border-slate-700 dark:hover:border-slate-500"
          }`}
        >
          <span className="text-2xl mb-1">📸</span>
          <span className="text-xs font-bold text-slate-700 dark:text-slate-200">
            영수증 사진 선택하기
          </span>
          <span className="mt-0.5 text-[11px] text-slate-500">
            카메라로 촬영하거나 앨범에서 선택
          </span>
        </button>
      ) : (
        <div
          data-testid="receipt-file-preview-card"
          className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-800/60"
        >
          {previewUrl && (
            <div className="mb-3 max-h-48 overflow-hidden rounded-lg bg-black/5 flex items-center justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={previewUrl}
                alt="영수증 미리보기"
                data-testid="receipt-preview-img"
                className="max-h-48 w-auto object-contain"
              />
            </div>
          )}

          <div className="flex items-center justify-end text-xs">
            {!isProcessing && (
              <button
                type="button"
                data-testid="receipt-reselect-file-btn"
                onClick={() => fileInputRef.current?.click()}
                className="shrink-0 text-xs font-semibold text-blue-600 hover:text-blue-700 dark:text-blue-400"
              >
                다시 선택
              </button>
            )}
          </div>
        </div>
      )}

      {/* 에러 메시지 및 재시도 UI */}
      {errorMessage && (
        <div
          id="receipt-upload-error-text"
          role="alert"
          data-testid="receipt-upload-error-alert"
          className="mt-3 rounded-xl border border-rose-300 bg-rose-50 p-3 text-xs text-rose-950 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-200"
        >
          <p className="font-bold">⚠️ 오류가 발생했습니다</p>
          <p className="mt-0.5 text-[11px] leading-relaxed">{errorMessage}</p>
        </div>
      )}

      {/* 진행 상태 인디케이터 */}
      {isProcessing && (
        <div
          data-testid="receipt-upload-progress"
          className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-center text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-200"
        >
          <div className="mx-auto mb-2 h-5 w-5 animate-spin rounded-full border-2 border-slate-700 border-t-transparent dark:border-blue-400" />
          <p className="font-bold">업로드 중입니다. 잠시만 기다려 주세요.</p>
        </div>
      )}

      {/* 액션 버튼 */}
      {!isProcessing && (
        <div className="mt-4 flex gap-2">
          {onCancel && (
            <button
              type="button"
              data-testid="receipt-upload-cancel-btn"
              onClick={onCancel}
              className="flex min-h-[44px] flex-1 items-center justify-center rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
            >
              취소
            </button>
          )}

          {step === "error" ? (
            <button
              type="button"
              data-testid="receipt-upload-retry-btn"
              onClick={handleUploadAndSubmit}
              className="flex min-h-[44px] flex-1 items-center justify-center rounded-xl bg-rose-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-rose-700"
            >
              다시 시도하기
            </button>
          ) : (
            <button
              type="button"
              data-testid="receipt-upload-submit-btn"
              onClick={handleUploadAndSubmit}
              className="flex min-h-[44px] flex-1 items-center justify-center rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-bold text-white hover:bg-slate-800 dark:bg-blue-600 dark:hover:bg-blue-700"
            >
              영수증 제출하기
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default ReceiptUploadForm;

