import type {
  ReceiptMimeType,
  ReceiptSubmissionStatus,
} from "@/lib/receipts/types";

export type { ReceiptMimeType, ReceiptSubmissionStatus };

export type RefundStatus = "none" | "pending" | "completed" | "failed";

export interface CustomerReceiptItem {
  id: string;
  accessSessionId: string;
  userId: string;
  storagePath: string;
  mimeType: ReceiptMimeType;
  fileSizeBytes: number;
  originalFilename: string | null;
  submissionStatus: ReceiptSubmissionStatus;
  storeNameConfirmed: string | null;
  purchaseAtConfirmed: string | null;
  purchaseAmountKrw: number | null;
  reviewReason: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt?: string;

  // Linked restroom & partner details
  restroomName: string;
  partnerName: string;
  roadAddress: string;
  depositAmountKrw: number;

  // Linked refund details
  refundStatus: RefundStatus;
  refundAmountKrw: number | null;
  refundCompletedAt: string | null;
}

export interface EligibleAccessSessionItem {
  accessSessionId: string;
  restroomId: string;
  restroomName: string;
  partnerName: string;
  roadAddress: string;
  depositAmountKrw: number;
  authorizedAt: string;
  expiresAt: string;
  receiptWindowHours: number;
  receiptWindowDeadline: string;
  isWindowExpired: boolean;
  hasPendingReceipt: boolean;
  hasApprovedReceipt: boolean;
  hasRejectedReceipt?: boolean;
  isRefunded?: boolean;
  latestSubmissionStatus?: ReceiptSubmissionStatus | null;
}

export interface CustomerReceiptsData {
  receipts: CustomerReceiptItem[];
  eligibleSessions: EligibleAccessSessionItem[];
}

export interface ReceiptStatusBadgeInfo {
  label: string;
  colorClass: string;
  description: string;
}

/**
 * Returns human-readable Korean status badge information.
 * Distinguishes administrator review approval vs actual test refund completion.
 */
export function getReceiptStatusBadgeInfo(
  status: ReceiptSubmissionStatus,
  refundStatus: RefundStatus = "none"
): ReceiptStatusBadgeInfo {
  if (status === "approved") {
    if (refundStatus === "completed") {
      return {
        label: "테스트 환급 완료",
        colorClass:
          "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200 border-emerald-300 dark:border-emerald-800",
        description: "관리자 심사 승인 및 보증금(테스트 결제) 취소가 완료되었습니다.",
      };
    }
    return {
      label: "환급 승인 (환급 처리 대기)",
      colorClass:
        "bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-200 border-blue-300 dark:border-blue-800",
      description: "영수증이 승인되었습니다. 관리자의 테스트 환급 처리가 진행될 예정입니다.",
    };
  }

  if (status === "submitted" || status === "review_required") {
    return {
      label: "관리자 검토 중",
      colorClass:
        "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200 border-amber-300 dark:border-amber-800",
      description: "관리자가 영수증 사진과 매장 이용 내역을 수동 검토 중입니다.",
    };
  }

  if (status === "resubmission_requested") {
    return {
      label: "영수증 재제출 요청",
      colorClass:
        "bg-orange-100 text-orange-800 dark:bg-orange-950/60 dark:text-orange-200 border-orange-300 dark:border-orange-800",
      description: "영수증 사진이 불명확하거나 보완이 필요합니다. 다시 촬영하여 제출해 주세요.",
    };
  }

  if (status === "rejected") {
    return {
      label: "심사 반려",
      colorClass:
        "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-200 border-rose-300 dark:border-rose-800",
      description: "제출된 영수증이 승인 기준에 부합하지 않아 반려되었습니다.",
    };
  }

  return {
    label: "상태 확인 중",
    colorClass:
      "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200 border-slate-300 dark:border-slate-700",
    description: "영수증 상태를 확인하고 있습니다.",
  };
}

