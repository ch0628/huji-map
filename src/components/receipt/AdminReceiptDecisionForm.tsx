"use client";

import React, { useEffect, useRef, useState } from "react";
import type {
  AdminReceiptDecision,
  AdminReceiptListItem,
} from "@/lib/receipts/types";
import {
  ADMIN_RECEIPT_DECISION_LABELS,
  formatKoreanDateTime,
  formatKrwAmount,
  isReceiptReviewable,
  serializeDecisionPayload,
  type AdminReceiptDecisionApiResponse,
  type DecisionFormPayload,
} from "./admin-types";

export interface AdminReceiptDecisionFormProps {
  readonly receipt: AdminReceiptListItem;
  readonly onDecisionSuccess: (
    updatedReceipt: AdminReceiptListItem,
    auditId: string
  ) => void;
  readonly onRefreshRequested?: () => void;
  readonly onAuthError?: (status: number, message: string) => void;
  readonly onDraftChange?: (draft: {
    confirmedStore: string;
    confirmedPurchaseAt: string;
    confirmedAmount: string;
  }) => void;
}

export function AdminReceiptDecisionForm({
  receipt,
  onDecisionSuccess,
  onRefreshRequested,
  onAuthError,
  onDraftChange,
}: AdminReceiptDecisionFormProps) {
  const [selectedDecision, setSelectedDecision] =
    useState<AdminReceiptDecision | null>(null);
  const [reason, setReason] = useState("");
  const [confirmedStore, setConfirmedStore] = useState(
    receipt.storeNameConfirmed ?? receipt.businessName ?? ""
  );
  const [confirmedPurchaseAt, setConfirmedPurchaseAt] = useState("");
  const [confirmedAmount, setConfirmedAmount] = useState("");
  const [receiptReference, setReceiptReference] = useState("");

  const [isConfirmStepOpen, setIsConfirmStepOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<{
    status: number | null;
    code: string | null;
    message: string;
  } | null>(null);
  const [successInfo, setSuccessInfo] = useState<{
    decision: AdminReceiptDecision;
    auditId: string;
  } | null>(null);

  // Synchronous mutex to prevent duplicate concurrent requests on rapid double-clicks
  const inFlightRef = useRef(false);
  // Binds x-idempotency-key to the exact serialized payload for safe retry / replay
  const idempotencyRef = useRef<{
    receiptId: string;
    fingerprint: string;
    key: string;
  } | null>(null);

  const prevReceiptIdRef = useRef<string>(receipt.id);

  // Reset form only when switching to a different receipt ID
  useEffect(() => {
    if (prevReceiptIdRef.current === receipt.id) return;
    prevReceiptIdRef.current = receipt.id;
    setSelectedDecision(null);
    setReason("");
    setConfirmedStore(receipt.storeNameConfirmed ?? receipt.businessName ?? "");
    setConfirmedPurchaseAt("");
    setConfirmedAmount("");
    setReceiptReference("");
    setIsConfirmStepOpen(false);
    setValidationError(null);
    setApiError(null);
    setSuccessInfo(null);
    inFlightRef.current = false;
    idempotencyRef.current = null;
  }, [receipt.id, receipt.businessName, receipt.storeNameConfirmed]);

  // Propagate draft comparison values upward
  useEffect(() => {
    if (onDraftChange) {
      onDraftChange({
        confirmedStore,
        confirmedPurchaseAt,
        confirmedAmount,
      });
    }
  }, [confirmedStore, confirmedPurchaseAt, confirmedAmount, onDraftChange]);

  const reviewable = isReceiptReviewable(receipt.submissionStatus);

  const buildValidatedPayload = (): DecisionFormPayload | null => {
    if (!selectedDecision) {
      setValidationError("심사 판정(승인, 재제출 요청, 반려)을 선택해 주세요.");
      return null;
    }

    const trimmedReason = reason.trim();
    if (trimmedReason.length < 2 || trimmedReason.length > 500) {
      setValidationError(
        "심사 사유는 공백 제외 최소 2자 이상 500자 이하로 입력해야 합니다."
      );
      return null;
    }

    const trimmedStore = confirmedStore.trim();
    if (trimmedStore.length > 100) {
      setValidationError("확인된 가게 상호명은 100자 이하여야 합니다.");
      return null;
    }

    let isoPurchaseAt: string | null = null;
    if (confirmedPurchaseAt.trim()) {
      const parsedDate = Date.parse(confirmedPurchaseAt.trim());
      if (Number.isNaN(parsedDate)) {
        setValidationError("유효한 구매 날짜 및 시각을 입력해 주세요.");
        return null;
      }
      isoPurchaseAt = new Date(parsedDate).toISOString();
    }

    let parsedAmount: number | null = null;
    if (confirmedAmount.trim() !== "") {
      const numeric = Number(confirmedAmount.trim());
      if (!Number.isInteger(numeric) || numeric < 0) {
        setValidationError("확인 구매금액은 0원 이상의 정수로 입력해 주세요.");
        return null;
      }
      parsedAmount = numeric;
    }

    const trimmedRef = receiptReference.trim();
    if (trimmedRef.length > 100) {
      setValidationError("영수증 참조 식별자는 100자 이하여야 합니다.");
      return null;
    }

    setValidationError(null);
    return {
      decision: selectedDecision,
      reason: trimmedReason,
      confirmedStore: trimmedStore || null,
      confirmedPurchaseAt: isoPurchaseAt,
      confirmedAmount: parsedAmount,
      receiptReference: trimmedRef || null,
    };
  };

  const handleReviewBeforeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!reviewable || isSubmitting) return;
    setApiError(null);
    const payload = buildValidatedPayload();
    if (!payload) {
      setIsConfirmStepOpen(false);
      return;
    }
    setIsConfirmStepOpen(true);
  };

  const handleFinalSubmit = async () => {
    if (!reviewable || inFlightRef.current) return;

    const payload = buildValidatedPayload();
    if (!payload) {
      setIsConfirmStepOpen(false);
      return;
    }

    inFlightRef.current = true;
    setIsSubmitting(true);
    setApiError(null);

    const fingerprint = serializeDecisionPayload(payload);
    let idempotencyKey: string;
    if (
      idempotencyRef.current &&
      idempotencyRef.current.receiptId === receipt.id &&
      idempotencyRef.current.fingerprint === fingerprint
    ) {
      idempotencyKey = idempotencyRef.current.key;
    } else {
      idempotencyKey = crypto.randomUUID();
      idempotencyRef.current = {
        receiptId: receipt.id,
        fingerprint,
        key: idempotencyKey,
      };
    }

    try {
      const res = await fetch(`/api/v1/admin/receipts/${receipt.id}/decision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      let data: AdminReceiptDecisionApiResponse | null = null;
      try {
        data = (await res.json()) as AdminReceiptDecisionApiResponse;
      } catch {
        data = null;
      }

      if (!res.ok || !data?.ok || !data.receipt) {
        const errCode = data?.error?.code ?? null;
        const errMessage =
          data?.error?.message ||
          (res.status === 401
            ? "관리자 로그인이 만료되었거나 인증되지 않았습니다 (401)."
            : res.status === 403
              ? "관리자 심사 권한이 없습니다 (403)."
              : res.status === 409
                ? "이미 처리된 영수증이거나 요청 충돌이 발생했습니다 (409)."
                : "영수증 심사 처리 중 오류가 발생했습니다.");

        setApiError({
          status: res.status,
          code: errCode,
          message: errMessage,
        });
        setIsConfirmStepOpen(false);

        if ((res.status === 401 || res.status === 403) && onAuthError) {
          onAuthError(res.status, errMessage);
        }
        return;
      }

      const mergedReceipt: AdminReceiptListItem = {
        ...receipt,
        ...data.receipt,
      };

      setSuccessInfo({
        decision: payload.decision,
        auditId: data.auditId || "",
      });
      setIsConfirmStepOpen(false);
      onDecisionSuccess(mergedReceipt, data.auditId || "");
    } catch {
      setApiError({
        status: null,
        code: "NETWORK_ERROR",
        message:
          "네트워크 오류로 심사 요청을 전송하지 못했습니다. 같은 내용으로 다시 시도하면 동일한 멱등성 키로 안전하게 재처리됩니다.",
      });
    } finally {
      inFlightRef.current = false;
      setIsSubmitting(false);
    }
  };

  // Already reviewed (approved / rejected / resubmission_requested)
  if (!reviewable) {
    return (
      <section
        aria-label="완료된 심사 결과"
        data-testid="receipt-decision-finalized"
        className="rounded-2xl border border-slate-200 bg-slate-50 p-3.5 text-xs dark:border-slate-800 dark:bg-slate-950/60"
      >
        <h3 className="font-bold text-slate-900 dark:text-white">
          심사 처리 완료 (상태 변경 불가)
        </h3>
        <p className="mt-1 text-[11px] text-slate-600 dark:text-slate-400">
          이미 심사 판정이 완료된 영수증입니다. 상태 전이 규칙에 따라 재판정할 수
          없습니다.
        </p>

        {successInfo && (
          <div
            role="status"
            data-testid="decision-success-banner"
            className="mt-2.5 rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
          >
            <p className="font-bold">
              {ADMIN_RECEIPT_DECISION_LABELS[successInfo.decision].shortLabel} 처리가
              저장되었습니다.
            </p>
            {successInfo.decision === "approved" && (
              <p className="mt-1 text-[11px]">
                환급 승인 상태로 반영되었으며, PG 결제 취소(실제 환급)는 아직
                실행되지 않았습니다.
              </p>
            )}
            {successInfo.auditId && (
              <p className="mt-1 font-mono text-[10px] opacity-80">
                감사 기록 ID: {successInfo.auditId}
              </p>
            )}
          </div>
        )}

        <dl className="mt-3 grid grid-cols-1 gap-1.5 rounded-xl border border-slate-200 bg-white p-2.5 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500">심사 완료 일시</dt>
            <dd className="font-medium text-slate-900 dark:text-slate-100">
              {formatKoreanDateTime(receipt.reviewedAt)}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5 border-t border-slate-100 pt-1.5 dark:border-slate-800">
            <dt className="text-slate-500">심사 사유</dt>
            <dd
              data-testid="finalized-review-reason"
              className="break-words font-semibold text-slate-900 dark:text-slate-100"
            >
              {receipt.reviewReason || "기록 없음"}
            </dd>
          </div>
          <div className="flex justify-between gap-2 border-t border-slate-100 pt-1.5 dark:border-slate-800">
            <dt className="text-slate-500">확인 가게명</dt>
            <dd className="font-medium text-slate-900 dark:text-slate-100">
              {receipt.storeNameConfirmed || "미입력"}
            </dd>
          </div>
          <div className="flex justify-between gap-2 border-t border-slate-100 pt-1.5 dark:border-slate-800">
            <dt className="text-slate-500">확인 구매금액</dt>
            <dd className="font-medium text-slate-900 dark:text-slate-100">
              {receipt.purchaseAmountKrw !== null &&
              receipt.purchaseAmountKrw !== undefined
                ? formatKrwAmount(receipt.purchaseAmountKrw)
                : "미입력"}
            </dd>
          </div>
        </dl>
      </section>
    );
  }

  return (
    <section
      aria-label="관리자 영수증 심사 판정"
      data-testid="admin-receipt-decision-section"
      className="rounded-2xl border border-slate-200 bg-white p-3.5 text-xs dark:border-slate-800 dark:bg-slate-900"
    >
      <h3 className="text-xs font-bold text-slate-900 dark:text-white">
        4. 관리자 수동 심사 판정
      </h3>
      <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
        승인, 재제출 요청, 반려 모두 필수 사유(2자 이상)를 입력해야 처리됩니다.
      </p>

      {apiError && (
        <div
          role="alert"
          data-testid="decision-api-error"
          className="mt-3 space-y-2 rounded-xl border border-rose-300 bg-rose-50 p-3 text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <p className="font-bold">
            심사 처리 실패
            {apiError.status ? ` (HTTP ${apiError.status})` : ""}
          </p>
          <p className="leading-relaxed">{apiError.message}</p>
          {apiError.status === 409 && onRefreshRequested && (
            <button
              type="button"
              data-testid="decision-conflict-refresh-button"
              onClick={onRefreshRequested}
              className="min-h-[44px] rounded-xl bg-rose-700 px-3 py-2 text-xs font-bold text-white hover:bg-rose-800"
            >
              최신 목록 새로고침
            </button>
          )}
        </div>
      )}

      {validationError && (
        <div
          role="alert"
          data-testid="decision-validation-error"
          className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 font-semibold text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        >
          {validationError}
        </div>
      )}

      <form onSubmit={handleReviewBeforeSubmit} className="mt-3 space-y-3" noValidate>
        {/* 판정 버튼 그룹 */}
        <fieldset disabled={isSubmitting}>
          <legend className="mb-1.5 font-semibold text-slate-800 dark:text-slate-200">
            판정 선택 *
          </legend>
          <div className="grid grid-cols-1 gap-2">
            {(
              ["approved", "resubmission_requested", "rejected"] as const
            ).map((decisionKey) => {
              const meta = ADMIN_RECEIPT_DECISION_LABELS[decisionKey];
              const isSelected = selectedDecision === decisionKey;
              return (
                <button
                  key={decisionKey}
                  type="button"
                  data-testid={`decision-option-${decisionKey}`}
                  aria-pressed={isSelected}
                  onClick={() => {
                    setSelectedDecision(decisionKey);
                    setIsConfirmStepOpen(false);
                    setValidationError(null);
                  }}
                  className={`flex min-h-[44px] flex-col items-start rounded-xl border p-2.5 text-left transition ${
                    isSelected
                      ? meta.buttonClass
                      : "border-slate-300 bg-slate-50 text-slate-800 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                  }`}
                >
                  <span className="font-bold">{meta.label}</span>
                  <span
                    className={`mt-0.5 text-[11px] leading-snug ${
                      isSelected ? "text-white/90" : "text-slate-500 dark:text-slate-400"
                    }`}
                  >
                    {meta.description}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        {/* 확인된 비교 정보 (선택 입력) */}
        <div className="space-y-2.5 rounded-xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-950/40">
          <p className="text-[11px] font-bold text-slate-700 dark:text-slate-300">
            영수증 판독 기록 (선택 입력 · 감사 로그 저장)
          </p>

          <div>
            <label
              htmlFor={`confirmed-store-${receipt.id}`}
              className="mb-1 block text-[11px] font-medium text-slate-700 dark:text-slate-300"
            >
              확인된 가게 상호명
            </label>
            <input
              id={`confirmed-store-${receipt.id}`}
              data-testid="input-confirmed-store"
              type="text"
              maxLength={100}
              disabled={isSubmitting}
              value={confirmedStore}
              onChange={(e) => {
                setConfirmedStore(e.target.value);
                setIsConfirmStepOpen(false);
              }}
              placeholder="예: 스타벅스 수원점"
              className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
            />
          </div>

          <div>
            <label
              htmlFor={`confirmed-purchase-at-${receipt.id}`}
              className="mb-1 block text-[11px] font-medium text-slate-700 dark:text-slate-300"
            >
              확인된 영수증 구매시각
            </label>
            <input
              id={`confirmed-purchase-at-${receipt.id}`}
              data-testid="input-confirmed-purchase-at"
              type="datetime-local"
              disabled={isSubmitting}
              value={confirmedPurchaseAt}
              onChange={(e) => {
                setConfirmedPurchaseAt(e.target.value);
                setIsConfirmStepOpen(false);
              }}
              className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
            />
          </div>

          <div>
            <label
              htmlFor={`confirmed-amount-${receipt.id}`}
              className="mb-1 block text-[11px] font-medium text-slate-700 dark:text-slate-300"
            >
              확인된 영수증 금액 (원)
            </label>
            <input
              id={`confirmed-amount-${receipt.id}`}
              data-testid="input-confirmed-amount"
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              disabled={isSubmitting}
              value={confirmedAmount}
              onChange={(e) => {
                setConfirmedAmount(e.target.value);
                setIsConfirmStepOpen(false);
              }}
              placeholder="예: 4500"
              className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
            />
          </div>

          <div>
            <label
              htmlFor={`receipt-reference-${receipt.id}`}
              className="mb-1 block text-[11px] font-medium text-slate-700 dark:text-slate-300"
            >
              영수증 승인번호/거래참조 (중복 대조용)
            </label>
            <input
              id={`receipt-reference-${receipt.id}`}
              data-testid="input-receipt-reference"
              type="text"
              maxLength={100}
              disabled={isSubmitting}
              value={receiptReference}
              onChange={(e) => {
                setReceiptReference(e.target.value);
                setIsConfirmStepOpen(false);
              }}
              placeholder="예: APPR-20261116-001"
              className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
            />
          </div>
        </div>

        {/* 필수 심사 사유 */}
        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <label
              htmlFor={`review-reason-${receipt.id}`}
              className="font-semibold text-slate-800 dark:text-slate-200"
            >
              심사 사유 (필수, 2~500자) *
            </label>
            <span className="text-[11px] text-slate-400">
              {reason.trim().length}/500
            </span>
          </div>
          <textarea
            id={`review-reason-${receipt.id}`}
            data-testid="input-review-reason"
            rows={3}
            maxLength={500}
            required
            disabled={isSubmitting}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setIsConfirmStepOpen(false);
            }}
            placeholder="예: 제휴 매장 구매 영수증 상호·구매시각·금액 확인 완료 / 사진 흐림으로 재촬영 요청"
            className="w-full rounded-xl border border-slate-300 bg-white p-3 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
          />
        </div>

        {/* 1단계 제출 버튼 (최종 확인 전 검토) */}
        {!isConfirmStepOpen && (
          <button
            type="submit"
            data-testid="decision-review-submit-button"
            disabled={isSubmitting}
            className="flex min-h-[44px] w-full items-center justify-center rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-bold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-blue-600 dark:hover:bg-blue-700"
          >
            심사 판정 검토 및 최종 확인
          </button>
        )}

        {/* 2단계 최종 제출 전 확인 패널 */}
        {isConfirmStepOpen && selectedDecision && (
          <div
            role="region"
            aria-label="최종 제출 전 확인"
            data-testid="decision-confirm-panel"
            className="space-y-2.5 rounded-xl border-2 border-slate-900 bg-slate-50 p-3 dark:border-blue-500 dark:bg-slate-950"
          >
            <p className="font-bold text-slate-900 dark:text-white">
              최종 심사 제출 확인
            </p>
            <p className="text-[11px] text-slate-700 dark:text-slate-300">
              판정 확정 후에는 감사 로그에 영구 기록되며, 동일 건을 다시 판정할 수
              없습니다.
            </p>

            <div className="space-y-1 rounded-lg bg-white p-2.5 text-[11px] dark:bg-slate-900">
              <p>
                <span className="text-slate-500">선택 판정:</span>{" "}
                <strong className="text-slate-900 dark:text-white">
                  {ADMIN_RECEIPT_DECISION_LABELS[selectedDecision].label}
                </strong>
              </p>
              <p className="break-words">
                <span className="text-slate-500">심사 사유:</span>{" "}
                <strong className="text-slate-900 dark:text-white">
                  {reason.trim()}
                </strong>
              </p>
              {confirmedStore.trim() && (
                <p>
                  <span className="text-slate-500">확인 상호:</span>{" "}
                  {confirmedStore.trim()}
                </p>
              )}
              {confirmedAmount.trim() !== "" && (
                <p>
                  <span className="text-slate-500">확인 금액:</span>{" "}
                  {Number(confirmedAmount.trim()).toLocaleString("ko-KR")}원
                </p>
              )}
            </div>

            {selectedDecision === "approved" && (
              <p
                data-testid="confirm-no-pg-refund-notice"
                className="rounded-lg border border-blue-200 bg-blue-50 p-2 text-[11px] font-semibold text-blue-900 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200"
              >
                안내: 승인 시 환급 자격만 부여되며, PG 결제 취소 및 실제 환급은
                실행되지 않습니다.
              </p>
            )}

            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                data-testid="decision-final-submit-button"
                disabled={isSubmitting}
                onClick={handleFinalSubmit}
                className="flex min-h-[44px] flex-1 items-center justify-center rounded-xl bg-blue-600 px-4 py-2 text-xs font-bold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSubmitting ? "심사 반영 중..." : "최종 확정 제출"}
              </button>
              <button
                type="button"
                data-testid="decision-cancel-confirm-button"
                disabled={isSubmitting}
                onClick={() => setIsConfirmStepOpen(false)}
                className="flex min-h-[44px] items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              >
                수정으로 돌아가기
              </button>
            </div>
          </div>
        )}
      </form>
    </section>
  );
}

export default AdminReceiptDecisionForm;

