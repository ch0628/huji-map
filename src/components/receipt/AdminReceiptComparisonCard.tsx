"use client";

import React from "react";
import type { AdminReceiptListItem } from "@/lib/receipts/types";
import ReceiptStatusBadge from "./ReceiptStatusBadge";
import {
  formatAccessStatusLabel,
  formatKoreanDateTime,
  formatKrwAmount,
  formatPaymentStatusLabel,
  getAdminRefundStatusSummary,
  toBadgeRefundStatus,
} from "./admin-types";

export interface AdminReceiptComparisonCardProps {
  readonly receipt: AdminReceiptListItem;
  readonly draftConfirmedStore?: string;
  readonly draftConfirmedPurchaseAt?: string;
  readonly draftConfirmedAmount?: string;
}

export function AdminReceiptComparisonCard({
  receipt,
  draftConfirmedStore,
  draftConfirmedPurchaseAt,
  draftConfirmedAmount,
}: AdminReceiptComparisonCardProps) {
  const refundStatus = receipt.refundStatus ?? "none";
  const refundSummary = getAdminRefundStatusSummary(
    receipt.submissionStatus,
    refundStatus
  );

  const displayedConfirmedStore =
    receipt.storeNameConfirmed ||
    (draftConfirmedStore?.trim()
      ? `${draftConfirmedStore.trim()} (입력 중)`
      : "미확인");

  const displayedConfirmedPurchaseAt = receipt.purchaseAtConfirmed
    ? formatKoreanDateTime(receipt.purchaseAtConfirmed)
    : draftConfirmedPurchaseAt?.trim()
      ? `${formatKoreanDateTime(draftConfirmedPurchaseAt)} (입력 중)`
      : "미확인";

  const parsedDraftAmount =
    draftConfirmedAmount && draftConfirmedAmount.trim() !== ""
      ? Number(draftConfirmedAmount)
      : null;

  const displayedConfirmedAmount =
    receipt.purchaseAmountKrw !== null && receipt.purchaseAmountKrw !== undefined
      ? formatKrwAmount(receipt.purchaseAmountKrw)
      : parsedDraftAmount !== null && !Number.isNaN(parsedDraftAmount)
        ? `${parsedDraftAmount.toLocaleString("ko-KR")}원 (입력 중)`
        : "미확인";

  const hasPaymentOrder = Boolean(
    receipt.paymentOrderId || receipt.paymentOrderNumber || receipt.paymentStatus
  );
  const hasRefundRecord = refundStatus !== "none";

  let windowCheckText = "기한 정보 없음";
  if (receipt.receiptWindowDeadline && receipt.createdAt) {
    const deadlineMs = Date.parse(receipt.receiptWindowDeadline);
    const submittedMs = Date.parse(receipt.createdAt);
    if (!Number.isNaN(deadlineMs) && !Number.isNaN(submittedMs)) {
      windowCheckText =
        submittedMs <= deadlineMs ? "기한 내 제출" : "기한 초과 제출";
    }
  }

  return (
    <div
      data-testid="admin-receipt-comparison-card"
      className="flex min-w-0 flex-col gap-3 text-xs"
    >
      {/* 1. 심사 및 환급 현재 상태 (승인 후 환급 대기 여부 명확히 분리) */}
      <section
        aria-label="심사 및 환급 상태"
        data-testid="receipt-refund-status-panel"
        className={`rounded-2xl border p-3.5 ${refundSummary.toneClass}`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-bold">심사 · 환급 상태</span>
          <ReceiptStatusBadge
            status={receipt.submissionStatus}
            refundStatus={toBadgeRefundStatus(refundStatus)}
            testId="detail-receipt-status-badge"
          />
        </div>
        <p className="mt-1.5 font-semibold" data-testid="admin-refund-status-label">
          {refundSummary.label}
        </p>
        {receipt.submissionStatus === "approved" && refundStatus !== "succeeded" && (
          <p className="mt-1 text-[11px] font-medium opacity-90">
            영수증은 승인되었으며, 실제 환급은 환급 관리에서 별도로 처리해야 합니다.
          </p>
        )}
      </section>

      {/* 2. 심사에 필요한 핵심 정보 */}
      <section
        aria-label="영수증 심사 핵심 정보"
        data-testid="comparison-store-section"
        className="rounded-2xl border border-slate-200 bg-white p-3.5 dark:border-slate-800 dark:bg-slate-900 space-y-3"
      >
        <h3 className="text-xs font-bold text-slate-900 dark:text-white">
          심사 대조 정보
        </h3>

        <dl className="grid grid-cols-1 gap-2">
          <div className="flex flex-col gap-0.5 rounded-lg bg-slate-50 p-2.5 dark:bg-slate-950/60">
            <dt className="text-[11px] text-slate-500">등록된 제휴 가게</dt>
            <dd
              data-testid="compare-business-name"
              className="break-words font-bold text-slate-900 dark:text-slate-100"
            >
              {receipt.businessName ?? "가게 정보 없음"}
            </dd>
          </div>

          <div className="flex flex-col gap-0.5 rounded-lg bg-slate-50 p-2.5 dark:bg-slate-950/60">
            <dt className="text-[11px] text-slate-500">가게 주소</dt>
            <dd
              data-testid="compare-business-address"
              className="break-words font-medium text-slate-800 dark:text-slate-200"
            >
              {receipt.businessRoadAddress ?? "주소 정보 없음"}
            </dd>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="flex flex-col gap-0.5 rounded-lg bg-slate-50 p-2.5 dark:bg-slate-950/60">
              <dt className="text-[11px] text-slate-500">결제 보증금 금액</dt>
              <dd
                data-testid="compare-payment-amount"
                className="font-bold text-slate-900 dark:text-slate-100"
              >
                {hasPaymentOrder
                  ? `${formatKrwAmount(receipt.paymentAmountKrw)} (${formatPaymentStatusLabel(receipt.paymentStatus)})`
                  : "결제 주문 기록 없음"}
              </dd>
            </div>

            <div className="flex flex-col gap-0.5 rounded-lg bg-slate-50 p-2.5 dark:bg-slate-950/60">
              <dt className="text-[11px] text-slate-500">제출 시각 · 기한 준수</dt>
              <dd
                data-testid="compare-submitted-at"
                className="font-semibold text-slate-900 dark:text-slate-100"
              >
                {formatKoreanDateTime(receipt.createdAt)} ·{" "}
                <span
                  className={
                    windowCheckText === "기한 내 제출"
                      ? "text-emerald-700 dark:text-emerald-400"
                      : "text-amber-700 dark:text-amber-300"
                  }
                >
                  {windowCheckText}
                </span>
              </dd>
            </div>
          </div>
        </dl>

        {/* 영수증 원본 확인값 */}
        <div className="border-t border-slate-100 pt-2.5 dark:border-slate-800">
          <p className="text-[11px] font-bold text-blue-900 dark:text-blue-300 mb-1.5">
            영수증 상 확인된 내용
          </p>
          <dl className="grid grid-cols-1 gap-1.5 rounded-xl border border-blue-200 bg-blue-50/50 p-2.5 dark:border-blue-900 dark:bg-blue-950/20">
            <div className="flex justify-between gap-2">
              <dt className="text-[11px] text-blue-800 dark:text-blue-300">가게명</dt>
              <dd
                data-testid="compare-confirmed-store"
                className="font-semibold text-slate-900 dark:text-slate-100 text-right break-words"
              >
                {displayedConfirmedStore}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-[11px] text-blue-800 dark:text-blue-300">구매일시</dt>
              <dd
                data-testid="compare-confirmed-purchase-at"
                className="font-semibold text-slate-900 dark:text-slate-100 text-right"
              >
                {displayedConfirmedPurchaseAt}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-[11px] text-blue-800 dark:text-blue-300">구매금액</dt>
              <dd
                data-testid="compare-confirmed-amount"
                className="font-semibold text-slate-900 dark:text-slate-100 text-right"
              >
                {displayedConfirmedAmount}
              </dd>
            </div>
          </dl>
        </div>
      </section>

      {/* 3. 내부 기록/식별자·정책·감사 상세 (기본 접힘) */}
      <details
        data-testid="admin-receipt-internal-details"
        className="rounded-2xl border border-slate-200 bg-white p-3.5 dark:border-slate-800 dark:bg-slate-900"
      >
        <summary className="cursor-pointer font-bold text-slate-700 dark:text-slate-200">
          상세 기록 보기 (내부 식별자 · 정책 · 환급 세부 상태)
        </summary>

        <div className="mt-3 space-y-3 border-t border-slate-100 pt-3 dark:border-slate-800">
          <dl className="grid grid-cols-1 gap-1.5 rounded-xl bg-slate-50 p-2.5 text-[11px] dark:bg-slate-950/60">
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">제휴 화장실 · 가게 ID</dt>
              <dd data-testid="compare-restroom-name" className="break-all text-right font-medium">
                {receipt.restroomName ?? "화장실 정보 없음"}
                {receipt.businessId ? ` (${receipt.businessId})` : ""}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">영수증 심사 상태</dt>
              <dd data-testid="compare-submission-status" className="font-mono font-semibold">
                {receipt.submissionStatus}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">PG 환급 상태</dt>
              <dd data-testid="compare-pg-refund-status" className="font-semibold">
                {refundSummary.pgStatusLabel}
              </dd>
            </div>
            {hasRefundRecord && (
              <>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">환급 금액</dt>
                  <dd data-testid="compare-refund-amount" className="font-semibold">
                    {formatKrwAmount(receipt.refundAmountKrw)}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">환급 요청 시각</dt>
                  <dd data-testid="compare-refund-requested-at" className="font-medium">
                    {formatKoreanDateTime(receipt.refundRequestedAt, "기록 없음")}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">환급 완료 시각</dt>
                  <dd data-testid="compare-refund-completed-at" className="font-medium">
                    {formatKoreanDateTime(receipt.refundCompletedAt, "미완료")}
                  </dd>
                </div>
              </>
            )}
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">이용권 상태 · 승인 시각</dt>
              <dd data-testid="compare-access-authorized-at" className="font-medium text-right">
                {formatAccessStatusLabel(receipt.accessStatus)} ·{" "}
                {formatKoreanDateTime(receipt.accessAuthorizedAt, "승인 시각 없음")}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">영수증 제출 기한</dt>
              <dd data-testid="compare-receipt-window" className="font-medium text-right">
                {receipt.receiptWindowHours !== null &&
                receipt.receiptWindowHours !== undefined
                  ? `${receipt.receiptWindowHours}시간`
                  : "정책 기한 없음"}
                {receipt.receiptWindowDeadline
                  ? ` · 마감 ${formatKoreanDateTime(receipt.receiptWindowDeadline)}`
                  : ""}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">주문번호 · 결제 승인시각</dt>
              <dd data-testid="compare-payment-order-meta" className="break-all text-right font-medium">
                {hasPaymentOrder
                  ? `${receipt.paymentOrderNumber ?? receipt.paymentOrderId ?? "주문번호 없음"} · ${formatKoreanDateTime(receipt.paymentApprovedAt, "미승인")}`
                  : "결제 주문 기록 없음"}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">정책 보증금 · 최소 구매</dt>
              <dd data-testid="compare-deposit-amount" className="text-right font-medium">
                정책 보증금 {formatKrwAmount(receipt.depositAmountKrw)} · 최소 구매{" "}
                {receipt.minPurchaseKrw !== null &&
                receipt.minPurchaseKrw !== undefined
                  ? `${receipt.minPurchaseKrw.toLocaleString("ko-KR")}원`
                  : "별도 최소 기준 미설정"}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">영수증 참조번호</dt>
              <dd data-testid="compare-receipt-reference" className="font-mono break-all">
                {receipt.receiptReference ?? "미확인"}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">고객 · 이용권 ID</dt>
              <dd className="break-all text-right font-mono">
                {receipt.userDisplayName ?? "표시명 미제공"} · {receipt.accessSessionId}
              </dd>
            </div>
          </dl>

          <section
            aria-label="검증 조건 및 주의사항"
            data-testid="verification-guidelines-section"
            className="rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-[11px] text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200 space-y-1"
          >
            <p className="font-bold">심사 기준 참고</p>
            <p>보증금과 구매금액 구분: 보증금 결제금액과 매장 실제 구매금액은 별개입니다.</p>
            <p>승인 후 환급 분리: 영수증 승인 후 환급은 환급 관리 화면에서 별도 실행됩니다.</p>
          </section>
        </div>
      </details>
    </div>
  );
}

export default AdminReceiptComparisonCard;
