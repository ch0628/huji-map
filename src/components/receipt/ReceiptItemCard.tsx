"use client";

import React, { useCallback, useEffect, useState } from "react";
import { ReceiptStatusBadge } from "./ReceiptStatusBadge";
import type { CustomerReceiptItem } from "./types";

export interface ReceiptSignedImageBoxProps {
  readonly receiptId: string;
  readonly testIdPrefix?: string;
}

export function ReceiptSignedImageBox({
  receiptId,
  testIdPrefix = "customer-receipt",
}: ReceiptSignedImageBoxProps) {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState<boolean>(true);
  const [imageError, setImageError] = useState<string | null>(null);

  const loadSignedImage = useCallback(async () => {
    setImageLoading(true);
    setImageError(null);
    try {
      const res = await fetch(
        `/api/v1/receipts/${encodeURIComponent(receiptId)}/image`,
        {
          method: "GET",
          cache: "no-store",
        }
      );
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok || !body.signedUrl) {
        setSignedUrl(null);
        setImageError("영수증 이미지를 불러오지 못했습니다.");
        return;
      }
      setSignedUrl(body.signedUrl);
    } catch {
      setSignedUrl(null);
      setImageError("영수증 이미지를 불러오지 못했습니다.");
    } finally {
      setImageLoading(false);
    }
  }, [receiptId]);

  useEffect(() => {
    let cancelled = false;
    setImageLoading(true);
    setImageError(null);
    setSignedUrl(null);

    (async () => {
      try {
        const res = await fetch(
          `/api/v1/receipts/${encodeURIComponent(receiptId)}/image`,
          {
            method: "GET",
            cache: "no-store",
          }
        );
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !body?.ok || !body.signedUrl) {
          setSignedUrl(null);
          setImageError("영수증 이미지를 불러오지 못했습니다.");
        } else {
          setSignedUrl(body.signedUrl);
        }
      } catch {
        if (!cancelled) {
          setSignedUrl(null);
          setImageError("영수증 이미지를 불러오지 못했습니다.");
        }
      } finally {
        if (!cancelled) setImageLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [receiptId]);

  return (
    <div
      data-testid={`${testIdPrefix}-image-box`}
      className="rounded-xl border border-slate-200 bg-slate-50 p-2.5 dark:border-slate-800 dark:bg-slate-800/40"
    >
      {imageLoading ? (
        <div className="flex min-h-[72px] items-center justify-center text-[11px] text-slate-500">
          영수증 이미지를 불러오는 중...
        </div>
      ) : signedUrl ? (
        <div className="flex justify-center overflow-hidden rounded-lg bg-white p-1 dark:bg-slate-900">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={signedUrl}
            alt="제출한 영수증 이미지"
            data-testid={`${testIdPrefix}-signed-img`}
            onError={() => {
              setSignedUrl(null);
              setImageError("영수증 이미지를 불러오지 못했습니다.");
            }}
            className="max-h-48 w-auto rounded object-contain"
          />
        </div>
      ) : imageError ? (
        <div
          data-testid={`${testIdPrefix}-image-error`}
          className="flex flex-col items-center gap-1.5 py-2 text-center text-[11px] text-slate-500 dark:text-slate-400"
        >
          <p>{imageError}</p>
          <button
            type="button"
            data-testid={`${testIdPrefix}-image-retry-btn`}
            onClick={loadSignedImage}
            className="min-h-[36px] rounded-lg border border-slate-300 bg-white px-3 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
          >
            다시 불러오기
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function getReceiptStatusHeadline(
  submissionStatus: CustomerReceiptItem["submissionStatus"]
): string {
  switch (submissionStatus) {
    case "submitted":
    case "review_required":
      return "영수증을 확인하고 있습니다.";
    case "resubmission_requested":
      return "영수증을 다시 제출해 주세요.";
    case "approved":
      return "영수증이 승인되었습니다.";
    case "rejected":
      return "영수증이 반려되었습니다.";
  }
}

export interface ReceiptItemCardProps {
  readonly receipt: CustomerReceiptItem;
  readonly previousReceipts?: readonly CustomerReceiptItem[];
  readonly enableImagePreview?: boolean;
  readonly canResubmit?: boolean;
  readonly onResubmit?: (accessSessionId: string) => void;
}

export function ReceiptItemCard({
  receipt,
  previousReceipts = [],
  enableImagePreview = false,
  canResubmit,
  onResubmit,
}: ReceiptItemCardProps) {
  const allowResubmit =
    canResubmit ?? receipt.submissionStatus === "resubmission_requested";
  const [isImageOpen, setIsImageOpen] = useState<boolean>(enableImagePreview);
  const [showPrevious, setShowPrevious] = useState<boolean>(false);
  const [openedHistoryImageIds, setOpenedHistoryImageIds] = useState<
    Record<string, boolean>
  >({});

  useEffect(() => {
    if (enableImagePreview) {
      setIsImageOpen(true);
    }
  }, [enableImagePreview]);

  const formattedDate = new Date(receipt.createdAt).toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const statusHeadline = getReceiptStatusHeadline(receipt.submissionStatus);

  return (
    <article
      data-testid="customer-receipt-card"
      data-receipt-id={receipt.id}
      data-session-id={receipt.accessSessionId}
      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 flex flex-col gap-3"
    >
      {/* 헤더: 최신 상태 배지 및 최신 제출 일시 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ReceiptStatusBadge
          status={receipt.submissionStatus}
          refundStatus={receipt.refundStatus}
          testId="card-receipt-status-badge"
        />
        <time
          dateTime={receipt.createdAt}
          data-testid="card-receipt-created-at"
          className="text-[11px] text-slate-500"
        >
          {formattedDate}
        </time>
      </div>

      {/* 화장실 및 매장 요약 */}
      <div className="min-w-0">
        <h4 className="text-sm font-bold text-slate-900 dark:text-white break-keep">
          {receipt.restroomName}
        </h4>
        <div className="mt-0.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
          <span className="break-keep">🏬 {receipt.partnerName}</span>
          <span className="font-semibold text-slate-700 dark:text-slate-300">
            {receipt.depositAmountKrw.toLocaleString()}원 (테스트)
          </span>
        </div>
      </div>

      {/* 상태별 핵심 안내 */}
      {receipt.submissionStatus === "approved" ? (
        <div
          data-testid="receipt-approved-summary"
          className="rounded-xl border border-blue-200 bg-blue-50/60 p-2.5 text-[11px] space-y-1 text-blue-950 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200 break-keep"
        >
          <p className="font-bold text-blue-900 dark:text-blue-300">
            ✓ {statusHeadline}
          </p>
          {receipt.refundStatus === "completed" ? (
            <p className="font-bold text-emerald-700 dark:text-emerald-400">
              보증금 {receipt.depositAmountKrw.toLocaleString()}원 환급이 완료되었습니다.
            </p>
          ) : (
            <p className="text-slate-600 dark:text-slate-400">
              보증금 환급 절차가 진행 중입니다.
            </p>
          )}
        </div>
      ) : receipt.submissionStatus === "rejected" ||
        receipt.submissionStatus === "resubmission_requested" ? (
        <div
          data-testid="receipt-review-reason-box"
          className="rounded-xl border border-rose-200 bg-rose-50 p-2.5 text-[11px] text-rose-950 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200 break-keep space-y-1"
        >
          <p className="font-bold text-rose-900 dark:text-rose-300">
            {statusHeadline}
          </p>
          {receipt.reviewReason && (
            <p className="leading-relaxed">
              <span className="font-semibold">
                {receipt.submissionStatus === "rejected"
                  ? "반려 사유: "
                  : "요청 사유: "}
              </span>
              {receipt.reviewReason}
            </p>
          )}
        </div>
      ) : (
        <p
          data-testid="receipt-pending-status-msg"
          className="rounded-xl bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700 dark:bg-slate-800/60 dark:text-slate-200"
        >
          {statusHeadline}
        </p>
      )}

      {/* 제출한 영수증 보기 / 이미지 뷰어 */}
      {!enableImagePreview && (
        <button
          type="button"
          data-testid="toggle-receipt-image-btn"
          aria-expanded={isImageOpen}
          onClick={() => setIsImageOpen((prev) => !prev)}
          className="flex min-h-[40px] w-full items-center justify-center rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
        >
          {isImageOpen ? "제출한 영수증 닫기" : "제출한 영수증 보기"}
        </button>
      )}

      {isImageOpen && <ReceiptSignedImageBox receiptId={receipt.id} />}

      {/* 재제출 요청 상태이고 제출 가능할 때만 액션 버튼 노출 */}
      {allowResubmit && onResubmit && (
        <button
          type="button"
          data-testid="resubmit-receipt-btn"
          onClick={() => onResubmit(receipt.accessSessionId)}
          className="flex min-h-[44px] w-full items-center justify-center rounded-xl bg-orange-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-orange-700"
        >
          영수증 다시 제출하기
        </button>
      )}

      {/* 이전 제출 기록 (기본 숨김, 클릭 시에만 펼침) */}
      {previousReceipts.length > 0 && (
        <div className="border-t border-slate-100 pt-2 dark:border-slate-800">
          <button
            type="button"
            data-testid="toggle-previous-receipts-btn"
            aria-expanded={showPrevious}
            onClick={() => setShowPrevious((prev) => !prev)}
            className="flex w-full items-center justify-between py-1 text-xs font-semibold text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
          >
            <span>이전 제출 기록 보기 ({previousReceipts.length}건)</span>
            <span>{showPrevious ? "접기 ▲" : "보기 ▼"}</span>
          </button>

          {showPrevious && (
            <ul
              data-testid="previous-receipts-list"
              className="mt-2 space-y-2"
            >
              {previousReceipts.map((prev) => (
                <li
                  key={prev.id}
                  data-testid="previous-receipt-item"
                  className="rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-[11px] space-y-1.5 dark:border-slate-800 dark:bg-slate-800/50"
                >
                  <div className="flex items-center justify-between gap-2">
                    <ReceiptStatusBadge
                      status={prev.submissionStatus}
                      refundStatus={prev.refundStatus}
                      testId="previous-receipt-status-badge"
                    />
                    <time
                      dateTime={prev.createdAt}
                      className="text-slate-500 dark:text-slate-400"
                    >
                      {new Date(prev.createdAt).toLocaleDateString("ko-KR", {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </div>
                  {prev.reviewReason && (
                    <p className="text-slate-600 dark:text-slate-300 break-keep">
                      사유: {prev.reviewReason}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      setOpenedHistoryImageIds((curr) => ({
                        ...curr,
                        [prev.id]: !curr[prev.id],
                      }))
                    }
                    className="text-[11px] font-semibold text-blue-600 hover:underline dark:text-blue-400"
                  >
                    {openedHistoryImageIds[prev.id]
                      ? "영수증 닫기"
                      : "이전 영수증 보기"}
                  </button>
                  {openedHistoryImageIds[prev.id] && (
                    <ReceiptSignedImageBox
                      receiptId={prev.id}
                      testIdPrefix={`prev-receipt-${prev.id}`}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}

export default ReceiptItemCard;
