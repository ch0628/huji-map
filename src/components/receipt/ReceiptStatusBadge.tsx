import React from "react";
import {
  getReceiptStatusBadgeInfo,
  type ReceiptSubmissionStatus,
  type RefundStatus,
} from "./types";

export interface ReceiptStatusBadgeProps {
  readonly status: ReceiptSubmissionStatus;
  readonly refundStatus?: RefundStatus;
  readonly testId?: string;
  readonly className?: string;
}

export function ReceiptStatusBadge({
  status,
  refundStatus = "none",
  testId = "receipt-status-badge",
  className = "",
}: ReceiptStatusBadgeProps) {
  const badgeInfo = getReceiptStatusBadgeInfo(status, refundStatus);

  return (
    <span
      data-testid={testId}
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold ${badgeInfo.colorClass} ${className}`}
      title={badgeInfo.description}
    >
      {badgeInfo.label}
    </span>
  );
}

export default ReceiptStatusBadge;

