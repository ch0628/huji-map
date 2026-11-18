import React from "react";
import Link from "next/link";
import type { Restroom, GenderType, AccessMethod } from "@/lib/restrooms/types";
import RestroomStatusBadge from "./RestroomStatusBadge";

interface RestroomCardProps {
  restroom: Pick<
    Restroom,
    | "id"
    | "name"
    | "road_address"
    | "address_detail"
    | "floor"
    | "gender_type"
    | "access_method"
    | "publication_status"
    | "wheelchair_accessible"
    | "baby_changing_available"
    | "sanitary_products_available"
    | "created_at"
  >;
}

const GENDER_LABELS: Record<GenderType, string> = {
  separate: "남녀 분리",
  unisex: "남녀 공용",
  male: "남성 전용",
  female: "여성 전용",
  unknown: "성별 구분 미확인",
};

const ACCESS_METHOD_LABELS: Record<AccessMethod, string> = {
  open: "상시 개방",
  ask_staff: "직원 문의",
  pin: "도어락 비밀번호",
};

export default function RestroomCard({ restroom }: RestroomCardProps) {
  const isDraft = restroom.publication_status === "draft";

  return (
    <article
      data-testid={`restroom-card-${restroom.id}`}
      className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="truncate text-base font-bold text-slate-900 dark:text-white">
              {restroom.name}
            </h2>
            {restroom.floor && (
              <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                {restroom.floor}
              </span>
            )}
          </div>
          <p className="mt-1 truncate text-xs text-slate-600 dark:text-slate-400">
            {restroom.road_address}
            {restroom.address_detail ? ` ${restroom.address_detail}` : ""}
          </p>
        </div>
        <RestroomStatusBadge status={restroom.publication_status} />
      </div>

      {/* 속성 배지 목록 */}
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="rounded-md bg-blue-50 px-2 py-0.5 font-medium text-blue-700 dark:bg-blue-950/60 dark:text-blue-300">
          {GENDER_LABELS[restroom.gender_type] || "성별 구분"}
        </span>
        <span className="rounded-md bg-purple-50 px-2 py-0.5 font-medium text-purple-700 dark:bg-purple-950/60 dark:text-purple-300">
          {ACCESS_METHOD_LABELS[restroom.access_method] || "출입 방식"}
        </span>
        {restroom.wheelchair_accessible && (
          <span className="rounded-md bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
            ♿ 휠체어
          </span>
        )}
        {restroom.baby_changing_available && (
          <span className="rounded-md bg-amber-50 px-2 py-0.5 font-medium text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
            👶 기저귀대
          </span>
        )}
        {restroom.sanitary_products_available && (
          <span className="rounded-md bg-pink-50 px-2 py-0.5 font-medium text-pink-700 dark:bg-pink-950/60 dark:text-pink-300">
            🧴 위생용품
          </span>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-slate-100 pt-3 dark:border-slate-800/80">
        <span className="text-[11px] text-slate-400">
          등록일: {new Date(restroom.created_at).toLocaleDateString("ko-KR")}
        </span>

        <Link
          href={`/merchant/restrooms/${restroom.id}`}
          className="inline-flex min-h-[36px] items-center justify-center rounded-lg bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100 dark:bg-blue-950/60 dark:text-blue-300 dark:hover:bg-blue-900/60"
        >
          {isDraft ? "수정 및 심사 요청 →" : "상세 및 정책 관리 →"}
        </Link>
      </div>
    </article>
  );
}

