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
      : "미확인 (원본 대조 필요)");

  const displayedConfirmedPurchaseAt = receipt.purchaseAtConfirmed
    ? formatKoreanDateTime(receipt.purchaseAtConfirmed)
    : draftConfirmedPurchaseAt?.trim()
      ? `${formatKoreanDateTime(draftConfirmedPurchaseAt)} (입력 중)`
      : "미확인 (원본 대조 필요)";

  const parsedDraftAmount =
    draftConfirmedAmount && draftConfirmedAmount.trim() !== ""
      ? Number(draftConfirmedAmount)
      : null;

  const displayedConfirmedAmount =
    receipt.purchaseAmountKrw !== null && receipt.purchaseAmountKrw !== undefined
      ? formatKrwAmount(receipt.purchaseAmountKrw)
      : parsedDraftAmount !== null && !Number.isNaN(parsedDraftAmount)
        ? `${parsedDraftAmount.toLocaleString("ko-KR")}원 (입력 중)`
        : "미확인 (원본 대조 필요)";

  const hasPaymentOrder = Boolean(
    receipt.paymentOrderId || receipt.paymentOrderNumber || receipt.paymentStatus
  );
  const hasRefundRecord = refundStatus !== "none";

  // Check if receipt submission was within window deadline (informational only)
  let windowCheckText = "기한 정보 없음";
  if (receipt.receiptWindowDeadline && receipt.createdAt) {
    const deadlineMs = Date.parse(receipt.receiptWindowDeadline);
    const submittedMs = Date.parse(receipt.createdAt);
    if (!Number.isNaN(deadlineMs) && !Number.isNaN(submittedMs)) {
      windowCheckText =
        submittedMs <= deadlineMs
          ? "기한 내 제출됨"
          : "제출 기한 이후 제출됨";
    }
  }

  return (
    <div
      data-testid="admin-receipt-comparison-card"
      className="flex min-w-0 flex-col gap-3 text-xs"
    >
      {/* 1. 영수증 심사 상태 vs 실제 PG 환급 상태 (분리 표시) */}
      <section
        aria-label="심사 및 환급 상태"
        data-testid="receipt-refund-status-panel"
        className={`rounded-2xl border p-3.5 ${refundSummary.toneClass}`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-bold">심사 및 실제 PG 환급 상태</span>
          <ReceiptStatusBadge
            status={receipt.submissionStatus}
            refundStatus={toBadgeRefundStatus(refundStatus)}
            testId="detail-receipt-status-badge"
          />
        </div>
        <p className="mt-2 font-semibold" data-testid="admin-refund-status-label">
          {refundSummary.label}
        </p>
        <p className="mt-1 text-[11px] leading-relaxed opacity-90">
          {refundSummary.detail}
        </p>

        <dl className="mt-2.5 grid grid-cols-1 gap-1.5 rounded-xl bg-white/65 p-2.5 text-[11px] dark:bg-slate-950/40">
          <div className="flex justify-between gap-2">
            <dt className="opacity-80">영수증 심사 상태 (receipt_submissions)</dt>
            <dd
              data-testid="compare-submission-status"
              className="font-semibold"
            >
              {receipt.submissionStatus}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="opacity-80">실제 PG 환급 상태 (payment_refunds)</dt>
            <dd
              data-testid="compare-pg-refund-status"
              className="font-semibold"
            >
              {refundSummary.pgStatusLabel}
            </dd>
          </div>
          {hasRefundRecord && (
            <>
              <div className="flex justify-between gap-2">
                <dt className="opacity-80">환급 금액 (payment_refunds)</dt>
                <dd data-testid="compare-refund-amount" className="font-semibold">
                  {formatKrwAmount(receipt.refundAmountKrw)}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="opacity-80">환급 요청 시각</dt>
                <dd data-testid="compare-refund-requested-at" className="font-medium">
                  {formatKoreanDateTime(receipt.refundRequestedAt, "기록 없음")}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="opacity-80">환급 완료 시각</dt>
                <dd data-testid="compare-refund-completed-at" className="font-medium">
                  {formatKoreanDateTime(receipt.refundCompletedAt, "미완료")}
                </dd>
              </div>
            </>
          )}
        </dl>
      </section>

      {/* 2. 가게 정보 비교 */}
      <section
        aria-label="가게 정보 비교"
        data-testid="comparison-store-section"
        className="rounded-2xl border border-slate-200 bg-white p-3.5 dark:border-slate-800 dark:bg-slate-900"
      >
        <h3 className="text-xs font-bold text-slate-900 dark:text-white">
          1. 가게 정보 비교
        </h3>
        <dl className="mt-2.5 grid grid-cols-1 gap-2">
          <div className="flex flex-col gap-0.5 rounded-lg bg-slate-50 p-2 dark:bg-slate-950/60">
            <dt className="text-[11px] text-slate-500">
              등록된 제휴 가게 이름 (출처: businesses)
            </dt>
            <dd
              data-testid="compare-business-name"
              className="break-words font-semibold text-slate-900 dark:text-slate-100"
            >
              {receipt.businessName ?? "가게 정보 없음"}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5 rounded-lg bg-slate-50 p-2 dark:bg-slate-950/60">
            <dt className="text-[11px] text-slate-500">
              등록된 가게 주소 (출처: businesses)
            </dt>
            <dd
              data-testid="compare-business-address"
              className="break-words font-medium text-slate-800 dark:text-slate-200"
            >
              {receipt.businessRoadAddress ?? "주소 정보 없음"}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5 rounded-lg bg-slate-50 p-2 dark:bg-slate-950/60">
            <dt className="text-[11px] text-slate-500">
              제휴 화장실 · 가게 ID (출처: restrooms / businesses)
            </dt>
            <dd
              data-testid="compare-restroom-name"
              className="break-all font-medium text-slate-800 dark:text-slate-200"
            >
              {receipt.restroomName ?? "화장실 정보 없음"}
              {receipt.businessId ? ` (${receipt.businessId})` : ""}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5 rounded-lg border border-blue-200 bg-blue-50/50 p-2 dark:border-blue-900 dark:bg-blue-950/20">
            <dt className="text-[11px] text-blue-800 dark:text-blue-300">
              영수증 원본 상 확인 가게명 (출처: 관리자 확인값)
            </dt>
            <dd
              data-testid="compare-confirmed-store"
              className="break-words font-semibold text-slate-900 dark:text-slate-100"
            >
              {displayedConfirmedStore}
            </dd>
          </div>
        </dl>
      </section>

      {/* 3. 이용 정보 및 세션 적용 정책 비교 */}
      <section
        aria-label="이용 및 정책 정보 비교"
        data-testid="comparison-time-section"
        className="rounded-2xl border border-slate-200 bg-white p-3.5 dark:border-slate-800 dark:bg-slate-900"
      >
        <h3 className="text-xs font-bold text-slate-900 dark:text-white">
          2. 이용 정보 · 적용 정책 · 영수증 구매시각 비교
        </h3>
        <dl className="mt-2.5 grid grid-cols-1 gap-2">
          <div className="flex flex-col gap-0.5 rounded-lg bg-slate-50 p-2 dark:bg-slate-950/60">
            <dt className="text-[11px] text-slate-500">
              이용권 상태 · 이용 승인 시각 (출처: access_sessions)
            </dt>
            <dd
              data-testid="compare-access-authorized-at"
              className="font-semibold text-slate-900 dark:text-slate-100"
            >
              {formatAccessStatusLabel(receipt.accessStatus)} ·{" "}
              {formatKoreanDateTime(receipt.accessAuthorizedAt, "승인 시각 없음")}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5 rounded-lg bg-slate-50 p-2 dark:bg-slate-950/60">
            <dt className="text-[11px] text-slate-500">
              이용권 만료 시각 · 세션 ID (출처: access_sessions)
            </dt>
            <dd className="break-all font-medium text-slate-800 dark:text-slate-200">
              {formatKoreanDateTime(receipt.accessExpiresAt, "만료 시각 없음")} ·{" "}
              {receipt.userDisplayName ?? "표시명 미제공"} ·{" "}
              <span className="font-mono text-[11px]">{receipt.accessSessionId}</span>
            </dd>
          </div>
          <div className="flex flex-col gap-0.5 rounded-lg bg-slate-50 p-2 dark:bg-slate-950/60">
            <dt className="text-[11px] text-slate-500">
              영수증 인정 기한 · 마감시각 (출처: 세션에 적용된 정책
              {receipt.policyVersion ? ` v${receipt.policyVersion}` : ""})
            </dt>
            <dd
              data-testid="compare-receipt-window"
              className="font-semibold text-slate-900 dark:text-slate-100"
            >
              {receipt.receiptWindowHours !== null &&
              receipt.receiptWindowHours !== undefined
                ? `${receipt.receiptWindowHours}시간`
                : "정책 기한 없음"}
              {receipt.receiptWindowDeadline
                ? ` · 마감 ${formatKoreanDateTime(receipt.receiptWindowDeadline)} (${windowCheckText})`
                : ""}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5 rounded-lg bg-slate-50 p-2 dark:bg-slate-950/60">
            <dt className="text-[11px] text-slate-500">
              영수증 제출 시각 (출처: receipt_submissions)
            </dt>
            <dd
              data-testid="compare-submitted-at"
              className="font-semibold text-slate-900 dark:text-slate-100"
            >
              {formatKoreanDateTime(receipt.createdAt)}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5 rounded-lg border border-blue-200 bg-blue-50/50 p-2 dark:border-blue-900 dark:bg-blue-950/20">
            <dt className="text-[11px] text-blue-800 dark:text-blue-300">
              영수증 원본 상 확인 구매시각 (출처: 관리자 확인값)
            </dt>
            <dd
              data-testid="compare-confirmed-purchase-at"
              className="font-semibold text-slate-900 dark:text-slate-100"
            >
              {displayedConfirmedPurchaseAt}
            </dd>
          </div>
        </dl>
      </section>

      {/* 4. 결제 보증금 vs 가게 영수증 구매금액 비교 */}
      <section
        aria-label="보증금 결제금액 및 영수증 구매금액 비교"
        data-testid="comparison-amount-section"
        className="rounded-2xl border border-slate-200 bg-white p-3.5 dark:border-slate-800 dark:bg-slate-900"
      >
        <h3 className="text-xs font-bold text-slate-900 dark:text-white">
          3. 보증금 결제 정보 · 최소 구매 기준 · 영수증 구매금액 비교
        </h3>
        <dl className="mt-2.5 grid grid-cols-1 gap-2">
          <div className="flex flex-col gap-0.5 rounded-lg bg-slate-50 p-2 dark:bg-slate-950/60">
            <dt className="text-[11px] text-slate-500">
              보증금 결제금액 (출처: payment_orders · 환급 기준 원금)
            </dt>
            <dd
              data-testid="compare-payment-amount"
              className="font-semibold text-slate-900 dark:text-slate-100"
            >
              {hasPaymentOrder
                ? `${formatKrwAmount(receipt.paymentAmountKrw)} (${formatPaymentStatusLabel(receipt.paymentStatus)}${receipt.paymentMode ? ` · ${receipt.paymentMode}` : ""})`
                : "결제 주문 기록 없음"}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5 rounded-lg bg-slate-50 p-2 dark:bg-slate-950/60">
            <dt className="text-[11px] text-slate-500">
              결제 주문번호 · 결제 승인시각 (출처: payment_orders)
            </dt>
            <dd
              data-testid="compare-payment-order-meta"
              className="break-all font-medium text-slate-800 dark:text-slate-200"
            >
              {hasPaymentOrder
                ? `${receipt.paymentOrderNumber ?? receipt.paymentOrderId ?? "주문번호 없음"} · ${formatKoreanDateTime(receipt.paymentApprovedAt, "미승인")}`
                : "결제 주문 기록 없음"}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5 rounded-lg bg-slate-50 p-2 dark:bg-slate-950/60">
            <dt className="text-[11px] text-slate-500">
              정책 보증금 · 최소 구매금액 (출처: 세션에 적용된 정책
              {receipt.policyVersion ? ` v${receipt.policyVersion}` : ""})
            </dt>
            <dd
              data-testid="compare-deposit-amount"
              className="font-semibold text-slate-900 dark:text-slate-100"
            >
              정책 보증금 {formatKrwAmount(receipt.depositAmountKrw)} · 최소 구매{" "}
              {receipt.minPurchaseKrw !== null &&
              receipt.minPurchaseKrw !== undefined
                ? `${receipt.minPurchaseKrw.toLocaleString("ko-KR")}원`
                : "별도 최소 기준 미설정"}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5 rounded-lg border border-blue-200 bg-blue-50/50 p-2 dark:border-blue-900 dark:bg-blue-950/20">
            <dt className="text-[11px] text-blue-800 dark:text-blue-300">
              영수증 구매금액 (출처: 관리자 확인값 · 보증금 결제금액과 별개)
            </dt>
            <dd
              data-testid="compare-confirmed-amount"
              className="font-semibold text-slate-900 dark:text-slate-100"
            >
              {displayedConfirmedAmount}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5 rounded-lg bg-slate-50 p-2 dark:bg-slate-950/60">
            <dt className="text-[11px] text-slate-500">
              영수증 참조번호 (출처: 관리자 확인값)
            </dt>
            <dd
              data-testid="compare-receipt-reference"
              className="break-all font-medium text-slate-800 dark:text-slate-200"
            >
              {receipt.receiptReference ?? "미확인"}
            </dd>
          </div>
        </dl>
      </section>

      {/* 5. 명세 검증 조건 및 주의사항 */}
      <section
        aria-label="검증 조건 및 주의사항"
        data-testid="verification-guidelines-section"
        className="rounded-2xl border border-amber-200 bg-amber-50/70 p-3.5 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
      >
        <h3 className="text-xs font-bold">검증 조건 및 수동 심사 주의사항</h3>
        <ul className="mt-2 list-disc space-y-1.5 pl-4 text-[11px] leading-relaxed">
          <li>
            <strong>OCR 자동 승인 없음:</strong> 관리자가 원본 이미지를 직접
            확인해 제휴 매장명·주소·구매 일시·금액을 대조한 뒤 판정합니다.
          </li>
          <li>
            <strong>보증금과 구매금액 구분:</strong> <code>payment_orders</code>의
            보증금 결제금액과 제휴 가게 실제 구매금액은 서로 다른 값입니다.
          </li>
          <li>
            <strong>테스트 정책 기준 안내:</strong> 보증금 1,000원·제출 기한
            24시간·최소 구매 금액 기준은 QA 테스트 기본값이며 상용 약관으로 확정된
            정책이 아닙니다.
          </li>
          <li>
            <strong>승인 후 환급 분리:</strong> 승인 시 환급 자격만 부여되며,
            실제 테스트 결제 취소(PG 환급)는 이 화면에서 실행되지 않습니다.
          </li>
        </ul>
      </section>
    </div>
  );
}

export default AdminReceiptComparisonCard;
