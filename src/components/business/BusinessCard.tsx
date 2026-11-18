import React from "react";
import Link from "next/link";
import type { BusinessSummaryItem } from "@/lib/businesses/types";
import BusinessStatusBadge from "./BusinessStatusBadge";

interface BusinessCardProps {
  business: BusinessSummaryItem;
}

export default function BusinessCard({ business }: BusinessCardProps) {
  const isDraft = business.registration_status === "draft";
  const isRejected = business.registration_status === "rejected";

  return (
    <article
      data-testid={`business-card-${business.id}`}
      className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-bold text-slate-900 dark:text-white">
              {business.name}
            </h2>
            <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-400">
              {business.category}
            </span>
          </div>
          <p className="mt-1 truncate text-xs text-slate-600 dark:text-slate-400">
            {business.road_address}
          </p>
        </div>
        <BusinessStatusBadge status={business.registration_status} />
      </div>

      <div className="flex items-center justify-between border-t border-slate-100 pt-3 dark:border-slate-800/80 gap-2 flex-wrap">
        <span className="text-[11px] text-slate-400">
          신청일: {new Date(business.created_at).toLocaleDateString("ko-KR")}
        </span>

        <div className="flex items-center gap-1.5">
          {business.registration_status === "approved" && (
            <Link
              href={`/merchant/restrooms?businessId=${business.id}`}
              className="inline-flex min-h-[36px] items-center justify-center rounded-lg bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/60 dark:text-emerald-300 dark:hover:bg-emerald-900/60"
            >
              화장실 관리 🚻
            </Link>
          )}
          <Link
            href={`/merchant/businesses/${business.id}`}
            className="inline-flex min-h-[36px] items-center justify-center rounded-lg bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100 dark:bg-blue-950/60 dark:text-blue-300 dark:hover:bg-blue-900/60"
          >
            {isDraft || isRejected ? "신청서 작성/수정 →" : "가게 상세 보기 →"}
          </Link>
        </div>
      </div>
    </article>
  );
}
