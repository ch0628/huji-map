"use client";

import React, { useState, useRef, useCallback } from "react";
import type { ReceiptMimeType, PublicReceiptSubmission } from "@/lib/receipts/types";
import { MAX_RECEIPT_FILE_SIZE } from "@/lib/receipts/validation";

export interface ReceiptUploadFormProps {
  readonly accessSessionId: string;
  readonly partnerName?: string;
  readonly restroomName?: string;
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
      setErrorMessage(
        `파일 크기는 1바이트 이상 10MB 이하여야 합니다. (선택한 파일: ${(
          file.size / (1024 * 1024)
        ).toFixed(2)}MB)`
      );
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
    if (!selectedFile || !accessSessionId) return;

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
    }
  };

  const isProcessing =
    step === "requesting_intent" ||
    step === "uploading_file" ||
    step === "submitting";

  // 완료 화면
  if (step === "completed" && submittedReceipt) {
    return (
      <div
        data-testid="receipt-upload-completed"
        className="rounded-2xl border border-emerald-300 bg-emerald-50 p-5 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
      >
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xl">✅</span>
          <h3 className="text-base font-bold">영수증 제출이 완료되었습니다</h3>
        </div>
        <p className="text-xs leading-relaxed text-emerald-900 dark:text-emerald-300">
          제출된 영수증은 <strong>관리자 수동 검토 대기열</strong>에 안전하게 등록되었습니다.
          검토 및 승인이 완료되면 보증금(테스트 결제 취소) 환급 처리가 진행됩니다.
        </p>

        <div className="mt-4 rounded-xl bg-white p-3.5 text-xs space-y-1.5 border border-emerald-200 dark:border-emerald-900/60 dark:bg-slate-900">
          <div className="flex justify-between">
            <span className="text-slate-500">진행 상태:</span>
            <span
              data-testid="completed-receipt-status"
              className="font-bold text-amber-600 dark:text-amber-400"
            >
              관리자 검토 중 (OCR/자동 승인 없음)
            </span>
          </div>
          {partnerName && (
            <div className="flex justify-between">
              <span className="text-slate-500">제휴 매장:</span>
              <span className="font-semibold text-slate-800 dark:text-slate-200">
                {partnerName}
              </span>
            </div>
          )}
          {submittedReceipt.originalFilename && (
            <div className="flex justify-between">
              <span className="text-slate-500">파일명:</span>
              <span className="font-mono text-[11px] text-slate-700 dark:text-slate-300 truncate max-w-[200px]">
                {submittedReceipt.originalFilename}
              </span>
            </div>
          )}
        </div>

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
        <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
          <span>🧾</span>
          <span>영수증 사진 업로드</span>
        </h3>
        {partnerName && (
          <p className="mt-0.5 text-xs text-purple-700 dark:text-purple-400 font-semibold">
            {partnerName} {restroomName ? `(${restroomName})` : ""}
          </p>
        )}
        <p className="mt-1 text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
          제휴 매장 실제 이용(구매) 영수증 사진을 등록해 주세요. 관리자 수동 확인 후 테스트 보증금이 환급됩니다.
        </p>
      </div>

      {/* 안내 박스 */}
      <div className="mb-4 rounded-xl bg-slate-50 p-3 text-[11px] text-slate-600 dark:bg-slate-800/60 dark:text-slate-400 space-y-1">
        <p>• 허용 확장자: <strong>JPG, PNG, WebP</strong></p>
        <p>• 최대 파일 크기: <strong>10MB</strong> 이하</p>
        <p>• 주의: OCR 자동 승인 및 즉시 환급은 지원되지 않으며, 관리자 검토를 거칩니다.</p>
      </div>

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
          type="button"
          data-testid="receipt-select-file-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={isProcessing}
          className="flex min-h-[96px] w-full flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 bg-slate-50/50 p-4 text-center hover:border-purple-400 hover:bg-purple-50/30 dark:border-slate-700 dark:bg-slate-800/40 dark:hover:border-purple-600 transition"
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

          <div className="flex items-center justify-between text-xs">
            <div className="min-w-0 pr-2">
              <p className="font-semibold text-slate-800 dark:text-slate-200 truncate">
                {selectedFile.name}
              </p>
              <p className="text-[11px] text-slate-500">
                {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB · {selectedFile.type}
              </p>
            </div>
            {!isProcessing && (
              <button
                type="button"
                data-testid="receipt-reselect-file-btn"
                onClick={() => fileInputRef.current?.click()}
                className="shrink-0 text-xs font-semibold text-purple-600 hover:text-purple-700 dark:text-purple-400"
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
          className="mt-4 rounded-xl bg-purple-50 p-3.5 text-center text-xs text-purple-900 dark:bg-purple-950/40 dark:text-purple-200 border border-purple-200 dark:border-purple-800"
        >
          <div className="mx-auto mb-2 h-5 w-5 animate-spin rounded-full border-2 border-purple-600 border-t-transparent" />
          <p className="font-bold">
            {step === "requesting_intent" && "업로드 보안 권한 확인 중..."}
            {step === "uploading_file" && "영수증 사진 안전 전송 중..."}
            {step === "submitting" && "영수증 심사 등록 중..."}
          </p>
          <p className="mt-0.5 text-[11px] text-purple-700 dark:text-purple-300">
            잠시만 기다려 주세요. 화면을 벗어나지 마세요.
          </p>
        </div>
      )}

      {/* 액션 버튼 */}
      <div className="mt-4 flex gap-2">
        {onCancel && (
          <button
            type="button"
            data-testid="receipt-upload-cancel-btn"
            onClick={onCancel}
            disabled={isProcessing}
            className="flex min-h-[44px] flex-1 items-center justify-center rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 disabled:opacity-50"
          >
            취소
          </button>
        )}

        {step === "error" ? (
          <button
            type="button"
            data-testid="receipt-upload-retry-btn"
            onClick={handleUploadAndSubmit}
            disabled={!selectedFile || isProcessing}
            className="flex min-h-[44px] flex-1 items-center justify-center rounded-xl bg-rose-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-rose-700 disabled:opacity-50"
          >
            다시 시도하기
          </button>
        ) : (
          <button
            type="button"
            data-testid="receipt-upload-submit-btn"
            onClick={handleUploadAndSubmit}
            disabled={!selectedFile || isProcessing}
            className="flex min-h-[44px] flex-1 items-center justify-center rounded-xl bg-purple-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-purple-700 disabled:opacity-50"
          >
            {isProcessing ? "제출 처리 중..." : "영수증 제출하기"}
          </button>
        )}
      </div>
    </div>
  );
}

export default ReceiptUploadForm;

