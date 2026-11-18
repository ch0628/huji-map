"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ReceiptMimeType } from "@/lib/receipts/types";
import {
  formatBytes,
  type AdminReceiptImageResponse,
} from "./admin-types";

export interface AdminReceiptImageViewerProps {
  readonly receiptId: string;
  readonly mimeType: ReceiptMimeType;
  readonly fileSizeBytes: number;
  readonly originalFilename: string | null;
  readonly onAuthError?: (status: number, message: string) => void;
}

type ZoomMode = "fit" | "100" | "150" | "200";

export function AdminReceiptImageViewer({
  receiptId,
  mimeType,
  fileSizeBytes,
  originalFilename,
  onAuthError,
}: AdminReceiptImageViewerProps) {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [expiresAtMs, setExpiresAtMs] = useState<number | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isExpired, setIsExpired] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [naturalSize, setNaturalSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [zoomMode, setZoomMode] = useState<ZoomMode>("fit");

  const mountedRef = useRef(true);
  const activeReceiptIdRef = useRef(receiptId);

  useEffect(() => {
    mountedRef.current = true;
    activeReceiptIdRef.current = receiptId;
    return () => {
      mountedRef.current = false;
    };
  }, [receiptId]);

  const fetchSignedImageUrl = useCallback(async () => {
    const targetId = receiptId;
    setIsLoading(true);
    setErrorMessage(null);
    setErrorStatus(null);
    setIsExpired(false);
    setSignedUrl(null);
    setNaturalSize(null);
    setExpiresAtMs(null);
    setRemainingSeconds(null);

    try {
      const res = await fetch(`/api/v1/admin/receipts/${targetId}/image`, {
        method: "GET",
        cache: "no-store",
      });

      let data: AdminReceiptImageResponse | null = null;
      try {
        data = (await res.json()) as AdminReceiptImageResponse;
      } catch {
        data = null;
      }

      if (!mountedRef.current || activeReceiptIdRef.current !== targetId) {
        return;
      }

      if (!res.ok || !data?.ok || !data.signedUrl) {
        const msg =
          data?.error?.message ||
          (res.status === 401
            ? "관리자 로그인이 필요합니다 (401)."
            : res.status === 403
              ? "관리자 권한이 필요합니다 (403)."
              : "서명된 영수증 이미지를 불러오지 못했습니다.");
        setErrorStatus(res.status);
        setErrorMessage(msg);
        if ((res.status === 401 || res.status === 403) && onAuthError) {
          onAuthError(res.status, msg);
        }
        return;
      }

      const ttlSeconds =
        typeof data.expiresIn === "number" && data.expiresIn > 0
          ? data.expiresIn
          : 900;

      setSignedUrl(data.signedUrl);
      setExpiresAtMs(Date.now() + ttlSeconds * 1000);
      setRemainingSeconds(ttlSeconds);
    } catch {
      if (!mountedRef.current || activeReceiptIdRef.current !== targetId) {
        return;
      }
      setErrorMessage(
        "네트워크 오류로 비공개 영수증 이미지를 불러오지 못했습니다."
      );
    } finally {
      if (mountedRef.current && activeReceiptIdRef.current === targetId) {
        setIsLoading(false);
      }
    }
  }, [receiptId, onAuthError]);

  useEffect(() => {
    fetchSignedImageUrl();
  }, [fetchSignedImageUrl]);

  // Track signed URL TTL expiration
  useEffect(() => {
    if (!expiresAtMs || !signedUrl) return;

    const updateTimer = () => {
      const diffSec = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
      setRemainingSeconds(diffSec);
      if (diffSec <= 0) {
        setIsExpired(true);
        setSignedUrl(null);
      }
    };

    updateTimer();
    const intervalId = window.setInterval(updateTimer, 1000);
    return () => window.clearInterval(intervalId);
  }, [expiresAtMs, signedUrl]);

  // Close full-screen viewer with Escape key
  useEffect(() => {
    if (!isModalOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsModalOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isModalOpen]);

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      setNaturalSize({
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
    }
  };

  const handleImageError = () => {
    setIsExpired(true);
    setSignedUrl(null);
    setIsModalOpen(false);
    setErrorMessage(
      "이미지 임시 열람 URL이 만료되었거나 원본 파일을 불러올 수 없습니다."
    );
  };

  const formatCountdown = (sec: number | null) => {
    if (sec === null) return "";
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}분 ${String(s).padStart(2, "0")}초`;
  };

  const getModalImageClass = () => {
    if (zoomMode === "fit") {
      return "max-h-[75vh] max-w-full object-contain";
    }
    return "max-w-none";
  };

  const getModalImageStyle = (): React.CSSProperties | undefined => {
    if (zoomMode === "fit" || !naturalSize) return undefined;
    const scale = zoomMode === "100" ? 1 : zoomMode === "150" ? 1.5 : 2;
    return {
      width: `${Math.round(naturalSize.width * scale)}px`,
      height: `${Math.round(naturalSize.height * scale)}px`,
    };
  };

  return (
    <section
      aria-label="제출된 영수증 원본 이미지"
      data-testid="admin-receipt-image-viewer"
      className="min-w-0 rounded-2xl border border-slate-200 bg-white p-3.5 dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5 dark:border-slate-800">
        <div className="min-w-0">
          <h3 className="text-xs font-bold text-slate-900 dark:text-white">
            비공개 영수증 원본 이미지
          </h3>
          <p className="mt-0.5 break-all text-[11px] text-slate-500 dark:text-slate-400">
            {originalFilename || "파일명 미제공"} · {mimeType} ·{" "}
            {formatBytes(fileSizeBytes)}
            {naturalSize
              ? ` · ${naturalSize.width}×${naturalSize.height}px`
              : ""}
          </p>
        </div>

        <span
          data-testid="receipt-image-security-badge"
          className="inline-flex shrink-0 items-center rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
        >
          비공개 서명 URL
        </span>
      </div>

      {remainingSeconds !== null && signedUrl && !isExpired && (
        <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
          <span data-testid="receipt-image-ttl">
            열람 URL 남은 시간: {formatCountdown(remainingSeconds)}
          </span>
          <button
            type="button"
            onClick={fetchSignedImageUrl}
            className="min-h-[36px] rounded-lg px-2 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950/40"
          >
            URL 재발급
          </button>
        </div>
      )}

      <div className="mt-3">
        {isLoading ? (
          <div
            data-testid="receipt-image-loading"
            className="flex min-h-[180px] flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-950/50"
          >
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
            <p className="mt-2">비공개 영수증 이미지를 불러오는 중...</p>
          </div>
        ) : isExpired || errorMessage ? (
          <div
            role="alert"
            data-testid={
              isExpired ? "receipt-image-expired-warning" : "receipt-image-error"
            }
            className="flex flex-col items-center justify-center gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-center text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <p className="font-semibold">
              {isExpired
                ? "임시 이미지 열람 URL이 만료되었거나 로드할 수 없습니다."
                : errorMessage}
            </p>
            {errorStatus && (
              <p className="text-[11px] text-amber-800 dark:text-amber-300">
                응답 상태 코드: HTTP {errorStatus}
              </p>
            )}
            <button
              type="button"
              data-testid="receipt-image-refresh-button"
              onClick={fetchSignedImageUrl}
              className="min-h-[44px] rounded-xl bg-amber-700 px-4 py-2 text-xs font-bold text-white hover:bg-amber-800"
            >
              새 열람 URL 발급
            </button>
          </div>
        ) : signedUrl ? (
          <div className="space-y-2.5">
            <div className="flex justify-center overflow-hidden rounded-xl border border-slate-200 bg-slate-100 p-2 dark:border-slate-700 dark:bg-slate-950">
              <img
                src={signedUrl}
                alt="고객이 제출한 영수증 이미지"
                data-testid="receipt-preview-img"
                onLoad={handleImageLoad}
                onError={handleImageError}
                className="max-h-[320px] w-auto max-w-full rounded object-contain"
              />
            </div>

            <button
              type="button"
              data-testid="open-original-image-viewer"
              onClick={() => {
                setZoomMode("fit");
                setIsModalOpen(true);
              }}
              className="flex min-h-[44px] w-full items-center justify-center rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-800 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
            >
              원본 이미지 전체 보기 (확대 뷰어)
            </button>
          </div>
        ) : null}
      </div>

      {/* Original Full-Resolution Image Modal Viewer */}
      {isModalOpen && signedUrl && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="original-image-viewer-title"
          data-testid="original-image-viewer-modal"
          className="fixed inset-0 z-50 flex flex-col bg-slate-950/95 p-3 text-white"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2.5">
            <div className="min-w-0">
              <h4
                id="original-image-viewer-title"
                className="truncate text-sm font-bold"
              >
                원본 영수증 전체 뷰어
              </h4>
              <p className="text-[11px] text-slate-300">
                {naturalSize
                  ? `원본 해상도 ${naturalSize.width}×${naturalSize.height}px`
                  : "원본 이미지"}
              </p>
            </div>
            <button
              type="button"
              data-testid="close-original-image-viewer"
              onClick={() => setIsModalOpen(false)}
              className="min-h-[44px] rounded-xl bg-slate-800 px-4 py-2 text-xs font-bold text-white hover:bg-slate-700"
            >
              닫기
            </button>
          </div>

          <div
            className="mt-2 flex flex-wrap gap-1.5"
            role="group"
            aria-label="이미지 확대 배율 선택"
          >
            {(
              [
                { key: "fit", label: "화면 맞춤" },
                { key: "100", label: "원본 1:1" },
                { key: "150", label: "150%" },
                { key: "200", label: "200%" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.key}
                type="button"
                data-testid={`zoom-mode-${opt.key}`}
                onClick={() => setZoomMode(opt.key)}
                aria-pressed={zoomMode === opt.key}
                className={`min-h-[44px] rounded-lg px-3 py-1.5 text-xs font-semibold ${
                  zoomMode === opt.key
                    ? "bg-blue-600 text-white"
                    : "bg-slate-800 text-slate-200 hover:bg-slate-700"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="mt-3 flex-1 overflow-auto rounded-xl border border-slate-800 bg-black p-2">
            <div className="flex min-h-full min-w-full items-center justify-center">
              <img
                src={signedUrl}
                alt="영수증 원본 전체 이미지"
                data-testid="receipt-original-full-img"
                onError={handleImageError}
                className={getModalImageClass()}
                style={getModalImageStyle()}
              />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export default AdminReceiptImageViewer;

