"use client";

import React from "react";
import { ReceiptStatusBadge } from "./ReceiptStatusBadge";
import type { CustomerReceiptItem } from "./types";

export interface ReceiptItemCardProps {
  readonly receipt: CustomerReceiptItem;
  readonly onResubmit?: (accessSessionId: string) => void;
}

export function ReceiptItemCard({
  receipt,
  onResubmit,
}: ReceiptItemCardProps) {
  const canResubmit = receipt.submissionStatus === "resubmission_requested";

  return (
    <article
      data-testid="customer-receipt-card"
      data-receipt-id={receipt.id}
      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 flex flex-col gap-3"
    >
      {/* 헤더: 상태 뱃지 및 제출 일시 */}
      <div className="flex items-center justify-between gap-2">
        <ReceiptStatusBadge
          status={receipt.submissionStatus}
          refundStatus={receipt.refundStatus}
          testId="card-receipt-status-badge"
        />
        <time
          dateTime={receipt.createdAt}
          className="text-[11px] text-slate-500"
        >
          {new Date(receipt.createdAt).toLocaleDateString("ko-KR", {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
      </div>

      {/* 매장 및 화장실 정보 */}
      <div>
        <p className="text-xs font-bold text-purple-700 dark:text-purple-400">
          🏬 {receipt.partnerName}
        </p>
        <h4 className="text-sm font-bold text-slate-900 dark:text-white mt-0.5">
          {receipt.restroomName}
        </h4>
        <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 truncate">
          📍 {receipt.roadAddress}
        </p>
      </div>

      {/* 영수증 파일 및 보증금 정보 */}
      <div className="rounded-xl bg-slate-50 p-2.5 text-xs space-y-1 dark:bg-slate-800/60 text-slate-700 dark:text-slate-300">
        <div className="flex justify-between items-center text-[11px]">
          <span className="text-slate-500">결제 보증금:</span>
          <span className="font-semibold text-slate-900 dark:text-white">
            {receipt.depositAmountKrw.toLocaleString()}원 (테스트)
          </span>
        </div>

        {receipt.originalFilename && (
          <div className="flex justify-between items-center text-[11px]">
            <span className="text-slate-500">파일명:</span>
            <span className="font-mono text-[11px] text-slate-600 dark:text-slate-400 truncate max-w-[180px]">
              {receipt.originalFilename}
            </span>
          </div>
        )}

        <div className="flex justify-between items-center text-[11px]">
          <span className="text-slate-500">파일 크기:</span>
          <span className="text-slate-600 dark:text-slate-400">
            {(receipt.fileSizeBytes / (1024 * 1024)).toFixed(2)} MB ({receipt.mimeType.replace("image/", "")})
          </span>
        </div>
      </div>

      {/* 관리자 확인 정보 (승인된 경우) */}
      {receipt.submissionStatus === "approved" && (
        <div
          data-testid="receipt-approved-summary"
          className="rounded-xl border border-blue-200 bg-blue-50/60 p-2.5 text-[11px] space-y-1 text-blue-950 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200"
        >
          <p className="font-bold text-blue-900 dark:text-blue-300">
            ✓ 관리자 심사 확인 완료
          </p>
          {receipt.storeNameConfirmed && (
            <div className="flex justify-between">
              <span className="text-blue-800 dark:text-blue-400">확인 매장:</span>
              <span className="font-semibold">{receipt.storeNameConfirmed}</span>
            </div>
          )}
          {receipt.purchaseAmountKrw !== null && (
            <div className="flex justify-between">
              <span className="text-blue-800 dark:text-blue-400">구매 금액:</span>
              <span className="font-semibold">{receipt.purchaseAmountKrw.toLocaleString()}원</span>
            </div>
          )}
          {receipt.refundStatus === "completed" ? (
            <p className="mt-1 font-bold text-emerald-700 dark:text-emerald-400">
              🎉 보증금 {receipt.depositAmountKrw.toLocaleString()}원 테스트 환급(결제 취소) 완료
            </p>
          ) : (
            <p className="mt-1 text-slate-600 dark:text-slate-400">
              보증금 취소(환급) 처리 진행 중입니다.
            </p>
          )}
        </div>
      )}

      {/* 반려 또는 재제출 요청 사유 */}
      {(receipt.submissionStatus === "rejected" ||
        receipt.submissionStatus === "resubmission_requested") &&
        receipt.reviewReason && (
          <div
            data-testid="receipt-review-reason-box"
            className="rounded-xl border border-rose-200 bg-rose-50 p-2.5 text-[11px] text-rose-950 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200"
          >
            <p className="font-bold text-rose-900 dark:text-rose-300">
              {receipt.submissionStatus === "rejected"
                ? "반려 사유:"
                : "재제출 요청 사유:"}
            </p>
            <p className="mt-0.5 leading-relaxed">{receipt.reviewReason}</p>
          </div>
        )}

      {/* 재제출 요청 시 액션 버튼 */}
      {canResubmit && onResubmit && (
        <button
          type="button"
          data-testid="resubmit-receipt-btn"
          onClick={() => onResubmit(receipt.accessSessionId)}
          className="flex min-h-[44px] w-full items-center justify-center rounded-xl bg-orange-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-orange-700"
        >
          영수증 다시 제출하기
        </button>
      )}
    </article>
  );
}

export default ReceiptItemCard;

