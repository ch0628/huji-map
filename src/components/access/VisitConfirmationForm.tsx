"use client";

import React, { useState, useRef } from "react";
import type {
  AccessSessionStatus,
  VisitConfirmationUsageStatus,
} from "@/lib/access/types";
import type { PublicPaymentOrder } from "@/lib/payments/types";
import type { PublicVisitConfirmation } from "./types";

export interface VisitConfirmationFormProps {
  readonly accessSessionId: string;
  readonly sessionStatus: AccessSessionStatus;
  readonly order: PublicPaymentOrder | null;
  readonly initialConfirmations: PublicVisitConfirmation[];
  readonly onConfirmationRecorded?: (
    confirmation: PublicVisitConfirmation
  ) => void;
  readonly injectedSubmitRequester?: (params: {
    accessSessionId: string;
    usageStatus: VisitConfirmationUsageStatus;
    failureReason?: string | null;
  }) => Promise<{
    httpStatus: number;
    body: {
      ok: boolean;
      data?: {
        confirmation: PublicVisitConfirmation;
        reused?: boolean;
      };
      error?: { code?: string; message?: string };
    };
  }>;
}

export default function VisitConfirmationForm({
  accessSessionId,
  sessionStatus,
  order,
  initialConfirmations,
  onConfirmationRecorded,
  injectedSubmitRequester,
}: VisitConfirmationFormProps) {
  const [confirmations, setConfirmations] =
    useState<PublicVisitConfirmation[]>(initialConfirmations);
  const [selectedStatus, setSelectedStatus] =
    useState<VisitConfirmationUsageStatus>("success");
  const [failureReason, setFailureReason] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);

  const inFlightRef = useRef<boolean>(false);

  const latest = confirmations[0] ?? null;
  const canSubmit =
    order?.status === "approved" &&
    sessionStatus !== "created" &&
    sessionStatus !== "canceled" &&
    sessionStatus !== "failed";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (inFlightRef.current || isSubmitting || !canSubmit) return;

    setErrorMessage(null);
    setSuccessNotice(null);

    if (
      selectedStatus === "failed" &&
      (!failureReason || failureReason.trim().length < 2)
    ) {
      setErrorMessage("출입 실패를 선택한 경우 사유를 2자 이상 입력해 주세요.");
      return;
    }

    inFlightRef.current = true;
    setIsSubmitting(true);

    try {
      let httpStatus: number;
      let body: any;

      const payload = {
        usageStatus: selectedStatus,
        failureReason:
          selectedStatus === "failed" ? failureReason.trim() : null,
      };

      if (injectedSubmitRequester) {
        const res = await injectedSubmitRequester({
          accessSessionId,
          ...payload,
        });
        httpStatus = res.httpStatus;
        body = res.body;
      } else {
        const res = await fetch(
          `/my/access/${encodeURIComponent(
            accessSessionId
          )}/visit-confirmation`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              "Cache-Control": "no-store",
            },
            cache: "no-store",
            credentials: "same-origin",
            body: JSON.stringify(payload),
          }
        );
        httpStatus = res.status;
        body = await res.json().catch(() => null);
      }

      if (
        (httpStatus === 200 || httpStatus === 201) &&
        body?.ok &&
        body?.data?.confirmation
      ) {
        const recorded = body.data.confirmation as PublicVisitConfirmation;
        setConfirmations((prev) => {
          const filtered = prev.filter((c) => c.id !== recorded.id);
          return [recorded, ...filtered];
        });
        setSuccessNotice(
          body.data.reused
            ? "이미 동일한 내용의 방문 확인 기록이 서버에 저장되어 있습니다."
            : "방문 확인 기록이 서버에 저장되었습니다."
        );
        if (selectedStatus === "success") {
          setFailureReason("");
        }
        onConfirmationRecorded?.(recorded);
      } else {
        setErrorMessage(
          body?.error?.message ||
            "방문 확인 기록 저장에 실패했습니다. 잠시 후 다시 시도해 주세요."
        );
      }
    } catch {
      setErrorMessage(
        "네트워크 오류로 방문 확인을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요."
      );
    } finally {
      inFlightRef.current = false;
      setIsSubmitting(false);
    }
  };

  return (
    <section
      data-testid="visit-confirmation-section"
      aria-label="화장실 방문 및 출입 확인"
      className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <h2 className="text-sm font-bold text-slate-900 dark:text-white">
          📍 화장실 도착 및 출입 확인 기록
        </h2>
        <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-300">
          고객 확인
        </span>
      </div>

      <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-400 mb-4">
        현장 도착 후 실제 출입 성공 여부나 불편 사항(문 잠김·비밀번호 불일치 등)을
        기록할 수 있습니다.{" "}
        <span className="text-slate-500">
          (※ 방문 확인 기록은 고객 신고 내역이며, 보증금 환급은 영수증 수동 심사
          승인 후 별도로 처리됩니다.)
        </span>
      </p>

      {/* 최근 서버 확인 내역 */}
      {latest && (
        <div
          data-testid="latest-visit-confirmation"
          data-usage-status={latest.usage_status}
          className={`mb-4 rounded-xl border p-3.5 text-xs ${
            latest.usage_status === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-950 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200"
              : "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
          }`}
        >
          <div className="flex items-center justify-between gap-2 font-bold">
            <span>
              {latest.usage_status === "success"
                ? "✓ 서버 기록됨: 정상 출입 및 이용 확인"
                : latest.usage_status === "failed"
                ? "⚠️ 서버 기록됨: 출입 불편/실패 신고"
                : "서버 기록됨: 상태 미상"}
            </span>
            <span className="text-[11px] font-normal opacity-80">
              {new Date(
                latest.arrival_confirmed_at || latest.created_at
              ).toLocaleTimeString("ko-KR", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
          {latest.failure_reason && (
            <p
              data-testid="latest-visit-failure-reason"
              className="mt-1.5 text-[11px] leading-relaxed"
            >
              신고 사유: {latest.failure_reason}
            </p>
          )}
        </div>
      )}

      {!canSubmit ? (
        <div
          data-testid="visit-confirmation-disabled"
          className="rounded-xl bg-slate-50 p-3 text-xs text-slate-500 dark:bg-slate-800/50 dark:text-slate-400"
        >
          정상 결제 승인이 완료된 이용권에서만 방문 확인을 등록할 수 있습니다.
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                setSelectedStatus("success");
                setErrorMessage(null);
              }}
              data-testid="visit-status-success-btn"
              aria-pressed={selectedStatus === "success"}
              className={`flex min-h-[44px] items-center justify-center rounded-xl border px-3 py-2 text-xs font-bold transition ${
                selectedStatus === "success"
                  ? "border-emerald-600 bg-emerald-50 text-emerald-900 dark:border-emerald-500 dark:bg-emerald-950/60 dark:text-emerald-200"
                  : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
              }`}
            >
              ✓ 정상 출입 성공
            </button>

            <button
              type="button"
              onClick={() => {
                setSelectedStatus("failed");
                setErrorMessage(null);
              }}
              data-testid="visit-status-failed-btn"
              aria-pressed={selectedStatus === "failed"}
              className={`flex min-h-[44px] items-center justify-center rounded-xl border px-3 py-2 text-xs font-bold transition ${
                selectedStatus === "failed"
                  ? "border-amber-600 bg-amber-50 text-amber-900 dark:border-amber-500 dark:bg-amber-950/60 dark:text-amber-200"
                  : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
              }`}
            >
              ⚠️ 출입 불가/불편
            </button>
          </div>

          {selectedStatus === "failed" && (
            <div>
              <label
                htmlFor="visit-failure-reason"
                className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
              >
                출입 불가 또는 불편 사유 (필수, 2자 이상)
              </label>
              <input
                id="visit-failure-reason"
                type="text"
                maxLength={300}
                value={failureReason}
                onChange={(e) => setFailureReason(e.target.value)}
                placeholder="예: 도어락 비밀번호 불일치, 매장 임시 휴무 등"
                data-testid="visit-failure-reason-input"
                className="min-h-[44px] w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs text-slate-900 focus:border-purple-600 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
              />
            </div>
          )}

          {errorMessage && (
            <p
              role="alert"
              data-testid="visit-confirmation-error"
              className="rounded-xl bg-rose-50 p-2.5 text-xs font-medium text-rose-700 border border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800"
            >
              {errorMessage}
            </p>
          )}

          {successNotice && (
            <p
              role="status"
              data-testid="visit-confirmation-success"
              className="rounded-xl bg-emerald-50 p-2.5 text-xs font-medium text-emerald-800 border border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800"
            >
              {successNotice}
            </p>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            data-testid="submit-visit-confirmation-btn"
            className="flex min-h-[44px] w-full items-center justify-center rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-bold text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
          >
            {isSubmitting ? "저장 중..." : "방문 확인 기록 저장"}
          </button>
        </form>
      )}
    </section>
  );
}

