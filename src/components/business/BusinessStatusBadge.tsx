import React from "react";
import type { BusinessRegistrationStatus } from "@/lib/businesses/types";

interface BusinessStatusBadgeProps {
  status: BusinessRegistrationStatus;
  rejectionReason?: string | null;
  showDescription?: boolean;
  className?: string;
}

const STATUS_CONFIG: Record<
  BusinessRegistrationStatus,
  {
    label: string;
    bg: string;
    text: string;
    border: string;
    description: string;
    badgeStyle: string;
  }
> = {
  draft: {
    label: "작성 중 (임시저장)",
    bg: "bg-amber-50 dark:bg-amber-950/40",
    text: "text-amber-800 dark:text-amber-300",
    border: "border-amber-300 dark:border-amber-700",
    description: "필수 정보를 확인한 뒤 심사를 요청할 수 있습니다.",
    badgeStyle: "bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-900/60 dark:text-amber-200 dark:border-amber-700",
  },
  pending: {
    label: "심사 대기 중",
    bg: "bg-blue-50 dark:bg-blue-950/40",
    text: "text-blue-800 dark:text-blue-300",
    border: "border-blue-300 dark:border-blue-700",
    description: "관리자 검토가 진행 중입니다. 심사 중에는 정보 수정이 제한됩니다.",
    badgeStyle: "bg-blue-100 text-blue-900 border-blue-300 dark:bg-blue-900/60 dark:text-blue-200 dark:border-blue-700",
  },
  approved: {
    label: "승인 완료",
    bg: "bg-emerald-50 dark:bg-emerald-950/40",
    text: "text-emerald-800 dark:text-emerald-300",
    border: "border-emerald-300 dark:border-emerald-700",
    description: "승인이 완료된 가게입니다. 일반 운영 정보를 관리할 수 있습니다.",
    badgeStyle: "bg-emerald-100 text-emerald-900 border-emerald-300 dark:bg-emerald-900/60 dark:text-emerald-200 dark:border-emerald-700",
  },
  rejected: {
    label: "반려됨",
    bg: "bg-rose-50 dark:bg-rose-950/40",
    text: "text-rose-800 dark:text-rose-300",
    border: "border-rose-300 dark:border-rose-700",
    description: "심사가 반려되었습니다. 사유를 확인하고 정보를 수정해 다시 제출할 수 있습니다.",
    badgeStyle: "bg-rose-100 text-rose-900 border-rose-300 dark:bg-rose-900/60 dark:text-rose-200 dark:border-rose-700",
  },
  suspended: {
    label: "운영 정지",
    bg: "bg-slate-100 dark:bg-slate-800",
    text: "text-slate-700 dark:text-slate-300",
    border: "border-slate-300 dark:border-slate-600",
    description: "운영 정책 또는 관리자에 의해 정지된 가게입니다.",
    badgeStyle: "bg-slate-200 text-slate-800 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-600",
  },
};

export default function BusinessStatusBadge({
  status,
  rejectionReason,
  showDescription = false,
  className = "",
}: BusinessStatusBadgeProps) {
  const config = STATUS_CONFIG[status] ?? {
    label: status,
    bg: "bg-slate-100",
    text: "text-slate-800",
    border: "border-slate-200",
    description: "",
    badgeStyle: "bg-slate-100 text-slate-800 border-slate-200",
  };

  return (
    <div className={`inline-flex flex-col gap-1.5 ${className}`}>
      <span
        data-testid={`business-status-badge-${status}`}
        className={`inline-flex items-center gap-1.5 self-start rounded-full border px-2.5 py-0.5 text-xs font-semibold ${config.badgeStyle}`}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
        {config.label}
      </span>

      {showDescription && (
        <div
          className={`rounded-xl border p-3 text-xs leading-relaxed ${config.bg} ${config.text} ${config.border}`}
        >
          <p>{config.description}</p>
          {status === "rejected" && rejectionReason && (
            <p className="mt-1.5 font-medium">
              반려 사유: <span className="underline">{rejectionReason}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
