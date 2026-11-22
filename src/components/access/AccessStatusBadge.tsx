"use client";

import React from "react";
import type { AccessMethodSnapshot, AccessSessionStatus } from "@/lib/access/types";
import { getAccessStatusLabel } from "./types";

export interface AccessStatusBadgeProps {
  readonly status: AccessSessionStatus;
  readonly testId?: string;
}

const STATUS_STYLES: Record<AccessSessionStatus, string> = {
  created:
    "bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-950/70 dark:text-amber-200 dark:border-amber-800/60",
  authorized:
    "bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-950/70 dark:text-emerald-200 dark:border-emerald-800/60",
  code_revealed:
    "bg-purple-100 text-purple-900 border-purple-200 dark:bg-purple-950/70 dark:text-purple-200 dark:border-purple-800/60",
  completed:
    "bg-blue-100 text-blue-900 border-blue-200 dark:bg-blue-950/70 dark:text-blue-200 dark:border-blue-800/60",
  expired:
    "bg-slate-200 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700",
  canceled:
    "bg-rose-100 text-rose-900 border-rose-200 dark:bg-rose-950/70 dark:text-rose-200 dark:border-rose-800/60",
  failed:
    "bg-red-100 text-red-900 border-red-200 dark:bg-red-950/70 dark:text-red-200 dark:border-red-800/60",
};

export function AccessStatusBadge({
  status,
  testId = "access-status-badge",
}: AccessStatusBadgeProps) {
  return (
    <span
      data-testid={testId}
      data-status={status}
      className={`inline-flex items-center rounded-md border px-2.5 py-0.5 text-[11px] font-bold ${
        STATUS_STYLES[status] || STATUS_STYLES.created
      }`}
    >
      {getAccessStatusLabel(status)}
    </span>
  );
}

export function AccessMethodBadge({
  method,
}: {
  readonly method: AccessMethodSnapshot;
}) {
  if (method === "pin") {
    return (
      <span
        data-testid="access-method-badge"
        className="inline-flex shrink-0 whitespace-nowrap items-center gap-1 rounded-md bg-purple-50 px-2 py-0.5 text-[11px] font-semibold text-purple-800 border border-purple-200 dark:bg-purple-950/50 dark:text-purple-300 dark:border-purple-800/60"
      >
        <span aria-hidden="true">🔐</span>
        <span>도어락 비밀번호</span>
      </span>
    );
  }
  if (method === "ask_staff") {
    return (
      <span
        data-testid="access-method-badge"
        className="inline-flex shrink-0 whitespace-nowrap items-center gap-1 rounded-md bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-800 border border-blue-200 dark:bg-blue-950/50 dark:text-blue-300 dark:border-blue-800/60"
      >
        <span aria-hidden="true">🙋</span>
        <span>직원 확인 이용</span>
      </span>
    );
  }
  return (
    <span
      data-testid="access-method-badge"
      className="inline-flex shrink-0 whitespace-nowrap items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700 border border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700"
    >
      <span aria-hidden="true">🚪</span>
      <span>바로 이용</span>
    </span>
  );
}

export default AccessStatusBadge;

