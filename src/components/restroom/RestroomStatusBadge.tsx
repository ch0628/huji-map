import React from "react";
import type { PublicationStatus } from "@/lib/restrooms/types";

interface RestroomStatusBadgeProps {
  status: PublicationStatus;
  showDescription?: boolean;
  className?: string;
}

const STATUS_CONFIG: Record<
  PublicationStatus,
  {
    label: string;
    bg: string;
    text: string;
    border: string;
    icon: string;
    description: string;
  }
> = {
  draft: {
    label: "임시저장",
    bg: "bg-slate-100 dark:bg-slate-800",
    text: "text-slate-700 dark:text-slate-300",
    border: "border-slate-300 dark:border-slate-700",
    icon: "📝",
    description: "임시저장 상태입니다. 필수 정보 입력 후 관리자에게 심사를 요청할 수 있습니다.",
  },
  pending: {
    label: "심사대기",
    bg: "bg-amber-100 dark:bg-amber-950/60",
    text: "text-amber-800 dark:text-amber-200",
    border: "border-amber-300 dark:border-amber-800",
    icon: "⏳",
    description: "관리자 심사 대기 중입니다. 관리자 승인 전까지 공개되지 않습니다.",
  },
  published: {
    label: "공개됨",
    bg: "bg-emerald-100 dark:bg-emerald-950/60",
    text: "text-emerald-800 dark:text-emerald-200",
    border: "border-emerald-300 dark:border-emerald-800",
    icon: "✅",
    description: "지도에 정상 공개 중입니다. 이용자가 화장실을 찾고 길을 안내받을 수 있습니다.",
  },
  suspended: {
    label: "일시중단",
    bg: "bg-rose-100 dark:bg-rose-950/60",
    text: "text-rose-800 dark:text-rose-200",
    border: "border-rose-300 dark:border-rose-800",
    icon: "⛔",
    description: "관리자에 의해 일시 중단된 상태입니다.",
  },
  archived: {
    label: "보관됨",
    bg: "bg-zinc-100 dark:bg-zinc-800",
    text: "text-zinc-600 dark:text-zinc-400",
    border: "border-zinc-300 dark:border-zinc-700",
    icon: "📦",
    description: "운영이 종료되어 보관 처리된 화장실입니다.",
  },
};

export default function RestroomStatusBadge({
  status,
  showDescription = false,
  className = "",
}: RestroomStatusBadgeProps) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.draft;

  return (
    <div className={`inline-flex flex-col gap-1 ${className}`}>
      <span
        data-testid="restroom-status-badge"
        data-status={status}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${config.bg} ${config.text} ${config.border}`}
      >
        <span aria-hidden="true">{config.icon}</span>
        <span>{config.label}</span>
      </span>

      {showDescription && (
        <p
          data-testid="restroom-status-description"
          className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed"
        >
          {config.description}
        </p>
      )}
    </div>
  );
}

