"use client";

import React from "react";
import Link from "next/link";
import { AccessMethodBadge, AccessStatusBadge } from "./AccessStatusBadge";
import {
  getPaymentQualificationLabel,
  type CustomerAccessListItem,
} from "./types";

export interface AccessSessionCardProps {
  readonly item: CustomerAccessListItem;
}

export default function AccessSessionCard({ item }: AccessSessionCardProps) {
  const {
    session,
    effectiveStatus,
    restroom,
    order,
    refund,
    latestVisitConfirmation,
    eligibleForPinReveal,
  } = item;

  const partnerName =
    restroom?.business_name || restroom?.name || "제휴 매장 화장실";
  const restroomTitle = restroom?.name || "제휴 화장실";
  const addressText = restroom
    ? `${restroom.road_address}${
        restroom.address_detail ? ` ${restroom.address_detail}` : ""
      }${restroom.floor ? ` (${restroom.floor})` : ""}`
    : "주소 정보 확인 중";

  const paymentLabel = getPaymentQualificationLabel(order, refund);

  return (
    <article
      data-testid={`access-session-card-${session.id}`}
      className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-purple-300 dark:border-slate-800 dark:bg-slate-900"
    >
      {/* 상단 상태 뱃지 영역 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <AccessStatusBadge
            status={effectiveStatus}
            testId={`card-status-${session.id}`}
          />
          <AccessMethodBadge method={session.access_method_snapshot} />
        </div>

        <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-800 border border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800">
          TEST 보증금
        </span>
      </div>

      {/* 매장 및 화장실 이름 */}
      <div>
        <p
          data-testid={`card-partner-name-${session.id}`}
          className="text-xs font-bold text-purple-700 dark:text-purple-400"
        >
          🏬 {partnerName}
        </p>
        <h2 className="mt-0.5 text-base font-bold text-slate-900 dark:text-white break-words">
          {restroomTitle}
        </h2>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 break-words">
          📍 {addressText}
        </p>
      </div>

      {/* 결제 자격 및 유효기한 요약 */}
      <div className="rounded-xl bg-slate-50 p-3 text-xs space-y-1.5 dark:bg-slate-800/60">
        <div className="flex items-center justify-between gap-2">
          <span className="text-slate-500 dark:text-slate-400">결제/자격 상태</span>
          <span
            data-testid={`card-payment-status-${session.id}`}
            className="font-semibold text-slate-800 dark:text-slate-200 text-right"
          >
            {paymentLabel}
          </span>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-slate-500 dark:text-slate-400">유효기한</span>
          <span
            data-testid={`card-expires-at-${session.id}`}
            className="font-medium text-slate-800 dark:text-slate-200 text-right"
          >
            {new Date(session.expires_at).toLocaleString("ko-KR")}
          </span>
        </div>

        {latestVisitConfirmation && (
          <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-200/70 dark:border-slate-700/60">
            <span className="text-slate-500 dark:text-slate-400">방문 확인 기록</span>
            <span className="font-semibold text-slate-700 dark:text-slate-300">
              {latestVisitConfirmation.usage_status === "success"
                ? "✓ 출입 성공 기록됨"
                : latestVisitConfirmation.usage_status === "failed"
                ? "⚠️ 출입 불편/실패 신고됨"
                : "확인 기록됨"}
            </span>
          </div>
        )}
      </div>

      {/* 하단 액션 버튼 (44px 이상 터치 타겟) */}
      <div className="flex items-center justify-between gap-2 pt-1">
        <Link
          href={`/my/access/${session.id}`}
          data-testid={`card-detail-link-${session.id}`}
          className={`flex min-h-[44px] w-full items-center justify-center rounded-xl px-4 py-2.5 text-xs font-bold transition ${
            eligibleForPinReveal
              ? "bg-purple-600 text-white shadow-sm hover:bg-purple-700"
              : "bg-slate-100 text-slate-800 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          }`}
        >
          {eligibleForPinReveal
            ? "🔐 이용권 상세 · 도어락 PIN 확인"
            : session.access_method_snapshot === "ask_staff" &&
              (effectiveStatus === "authorized" ||
                effectiveStatus === "code_revealed")
            ? "🙋 이용권 상세 · 직원 제시 화면 열기"
            : "이용권 상세 보기"}
        </Link>
      </div>
    </article>
  );
}

