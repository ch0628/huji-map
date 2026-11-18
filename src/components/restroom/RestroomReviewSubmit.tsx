"use client";

import React, { useState } from "react";
import type { Restroom, PublicationStatus } from "@/lib/restrooms/types";

interface RestroomReviewSubmitProps {
  restroom: Partial<Restroom> & { id: string; publication_status: PublicationStatus };
  onSubmitted?: (updatedRestroom: any) => void;
}

export default function RestroomReviewSubmit({
  restroom,
  onSubmitted,
}: RestroomReviewSubmitProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const status = restroom.publication_status;
  const isDraft = status === "draft";

  const handleSubmit = async () => {
    if (!isDraft || isSubmitting) return;

    setServerError(null);
    setSuccessMessage(null);

    // Client-side pre-validation
    if (
      !restroom.name?.trim() ||
      !restroom.road_address?.trim() ||
      restroom.latitude === null ||
      restroom.latitude === undefined ||
      restroom.longitude === null ||
      restroom.longitude === undefined
    ) {
      setServerError("화장실 이름, 도로명주소, 좌표(위도·경도)가 모두 입력되어야 심사를 요청할 수 있습니다.");
      return;
    }

    setIsSubmitting(true);
    const idempotencyKey = crypto.randomUUID();

    try {
      const res = await fetch(`/api/v1/merchant/restrooms/${restroom.id}/submit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": idempotencyKey,
        },
      });

      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.error?.message || "심사 제출에 실패했습니다.");
      }

      setSuccessMessage("관리자에게 심사가 요청되었습니다. 승인이 완료되면 지도에 공개됩니다.");
      if (onSubmitted) {
        onSubmitted(data.data);
      }
    } catch (err: unknown) {
      setServerError(err instanceof Error ? err.message : "심사 요청 중 오류가 발생했습니다.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      data-testid="restroom-review-submit-card"
      className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold text-slate-900 dark:text-white">심사 제출 및 공개 관리</h2>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            isDraft
              ? "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
              : status === "pending"
              ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
              : status === "published"
              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
              : "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200"
          }`}
        >
          {isDraft
            ? "임시저장 (심사 전)"
            : status === "pending"
            ? "심사 대기 중"
            : status === "published"
            ? "공개 승인됨"
            : status === "suspended"
            ? "일시 중단"
            : "보관 처리"}
        </span>
      </div>

      {/* 에러 및 성공 안내 */}
      {serverError && (
        <div
          role="alert"
          data-testid="restroom-submit-error"
          className="rounded-xl border border-rose-300 bg-rose-50 p-3.5 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <p className="font-semibold">⚠️ {serverError}</p>
        </div>
      )}

      {successMessage && (
        <div
          role="status"
          data-testid="restroom-submit-success"
          className="rounded-xl border border-emerald-300 bg-emerald-50 p-3.5 text-xs text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
        >
          <p className="font-semibold">✓ {successMessage}</p>
        </div>
      )}

      {isDraft ? (
        <div className="space-y-3">
          <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
            필수 정보(화장실 이름, 주소, 좌표) 입력을 확인한 후 심사를 요청해 주세요. 관리자 승인 후 지도에 공개되어 이용자에게 노출됩니다.
          </p>

          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting}
            data-testid="submit-restroom-review-button"
            className="inline-flex min-h-[44px] w-full items-center justify-center rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-semibold text-white shadow-sm hover:bg-blue-700 active:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting ? "심사 요청 중..." : "🚀 관리자 심사 요청하기"}
          </button>
        </div>
      ) : status === "pending" ? (
        <div className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="font-semibold">⏳ 현재 관리자 심사 대기 중입니다.</p>
          <p className="mt-1 leading-relaxed text-[11px] text-amber-800 dark:text-amber-300">
            관리자가 화장실 위치 및 시설 정보를 검토하고 있습니다. 승인이 완료되면 공개(published) 상태로 자동 전환됩니다.
          </p>
        </div>
      ) : status === "published" ? (
        <div className="rounded-xl bg-emerald-50 p-3 text-xs text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
          <p className="font-semibold">✅ 지도에 정상 공개 중입니다.</p>
          <p className="mt-1 leading-relaxed text-[11px] text-emerald-800 dark:text-emerald-300">
            이용자가 화장실 지도를 통해 찾을 수 있으며, 길찾기 및 정책에 따른 이용이 가능합니다.
          </p>
        </div>
      ) : (
        <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-700 dark:bg-slate-800/40 dark:text-slate-300">
          <p className="font-semibold">이 화장실은 현재 비공개 상태입니다.</p>
        </div>
      )}
    </div>
  );
}

