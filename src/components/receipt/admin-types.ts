import type {
  AdminReceiptDecision,
  AdminReceiptListItem,
  AdminReceiptRefundStatus,
  ReceiptSubmissionStatus,
} from "@/lib/receipts/types";
import type { RefundStatus } from "./types";

export type AdminReceiptFilterTab =
  | "pending"
  | "approved"
  | "rejected"
  | "resubmission_requested"
  | "all";

export const ADMIN_RECEIPT_FILTER_TABS: readonly {
  readonly key: AdminReceiptFilterTab;
  readonly label: string;
}[] = [
  { key: "pending", label: "심사 대기" },
  { key: "approved", label: "승인 완료" },
  { key: "rejected", label: "반려됨" },
  { key: "resubmission_requested", label: "재제출 요청" },
  { key: "all", label: "전체" },
] as const;

export const ADMIN_RECEIPT_DECISION_LABELS: Record<
  AdminReceiptDecision,
  {
    readonly label: string;
    readonly shortLabel: string;
    readonly description: string;
    readonly buttonClass: string;
  }
> = {
  approved: {
    label: "승인 (환급 자격 부여)",
    shortLabel: "승인",
    description:
      "실제 제휴 가게 구매 영수증이 확인되어 보증금 환급 자격을 부여합니다. (PG 결제 취소는 별도 단계에서 진행)",
    buttonClass:
      "border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700",
  },
  resubmission_requested: {
    label: "재제출 요청",
    shortLabel: "재제출 요청",
    description:
      "사진 흐림, 영수증 일부 누락 등으로 다시 촬영하여 제출하도록 요청합니다.",
    buttonClass:
      "border-amber-600 bg-amber-600 text-white hover:bg-amber-700",
  },
  rejected: {
    label: "반려 (환급 불가)",
    shortLabel: "반려",
    description:
      "제휴 매장·구매 조건 불일치 등으로 보증금 환급 불가 판정을 내립니다.",
    buttonClass:
      "border-rose-600 bg-rose-600 text-white hover:bg-rose-700",
  },
};

export interface AdminReceiptImageResponse {
  ok: boolean;
  signedUrl?: string;
  expiresIn?: number;
  storagePath?: string;
  receiptId?: string;
  requestId?: string;
  error?: {
    code: string;
    message: string;
  };
}

export interface AdminReceiptListApiResponse {
  ok: boolean;
  items?: AdminReceiptListItem[];
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  requestId?: string;
  error?: {
    code: string;
    message: string;
  };
}

export interface AdminReceiptDecisionApiResponse {
  ok: boolean;
  receipt?: AdminReceiptListItem;
  auditId?: string;
  requestId?: string;
  error?: {
    code: string;
    message: string;
  };
}

export interface DecisionFormPayload {
  decision: AdminReceiptDecision;
  reason: string;
  confirmedStore: string | null;
  confirmedPurchaseAt: string | null;
  confirmedAmount: number | null;
  receiptReference: string | null;
}

export function toBadgeRefundStatus(
  refundStatus: AdminReceiptRefundStatus | undefined
): RefundStatus {
  if (refundStatus === "succeeded") return "completed";
  if (refundStatus === "requested" || refundStatus === "processing") {
    return "pending";
  }
  if (refundStatus === "failed") return "failed";
  return "none";
}

export function isReceiptReviewable(status: ReceiptSubmissionStatus): boolean {
  return status === "submitted" || status === "review_required";
}

export function getAdminRefundStatusSummary(
  status: ReceiptSubmissionStatus,
  refundStatus: AdminReceiptRefundStatus = "none"
): {
  readonly label: string;
  readonly pgStatusLabel: string;
  readonly detail: string;
  readonly toneClass: string;
} {
  if (refundStatus === "succeeded") {
    return {
      label: "테스트 환급 완료 (PG 취소 완료)",
      pgStatusLabel: "succeeded (테스트 결제 취소 완료)",
      detail:
        "payment_refunds 기준 테스트 결제 취소가 완료되었습니다.",
      toneClass:
        "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200",
    };
  }
  if (refundStatus === "requested" || refundStatus === "processing") {
    return {
      label: "환급 처리 진행 중",
      pgStatusLabel: `${refundStatus} (환급 요청 처리 중)`,
      detail:
        "영수증 심사 승인 이후 payment_refunds 환급 요청이 생성되어 처리 중입니다.",
      toneClass:
        "border-indigo-300 bg-indigo-50 text-indigo-950 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-200",
    };
  }
  if (refundStatus === "failed") {
    return {
      label: "환급 요청 실패 (재확인 필요)",
      pgStatusLabel: "failed (PG 취소 실패)",
      detail:
        "영수증 심사는 승인되었으나 payment_refunds 환급 처리가 실패 상태입니다.",
      toneClass:
        "border-rose-300 bg-rose-50 text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200",
    };
  }

  if (status === "approved") {
    return {
      label: "환급 승인 (환급 미요청 · PG 환급 미실행)",
      pgStatusLabel: "none (payment_refunds 기록 없음)",
      detail:
        "영수증 심사는 승인되었으나 아직 payment_refunds 환급 요청이 없으며, 본 화면에서는 PG 결제 취소 API를 호출하지 않습니다.",
      toneClass:
        "border-blue-300 bg-blue-50 text-blue-950 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200",
    };
  }
  if (status === "rejected") {
    return {
      label: "환급 불가 (심사 반려)",
      pgStatusLabel: "none (반려로 환급 대상 제외)",
      detail: "영수증이 반려되어 보증금 환급 대상에서 제외되었습니다.",
      toneClass:
        "border-rose-300 bg-rose-50 text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200",
    };
  }
  if (status === "resubmission_requested") {
    return {
      label: "환급 보류 (재제출 요청)",
      pgStatusLabel: "none (재제출 대기)",
      detail: "고객의 영수증 재제출 전까지 환급 처리가 보류됩니다.",
      toneClass:
        "border-orange-300 bg-orange-50 text-orange-950 dark:border-orange-800 dark:bg-orange-950/40 dark:text-orange-200",
    };
  }
  return {
    label: "심사 대기 중 (환급 승인 전)",
    pgStatusLabel: "none (환급 요청 없음)",
    detail: "관리자 수동 심사 승인 후 별도 환급 단계로 전환됩니다.",
    toneClass:
      "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
  };
}

export function formatKoreanDateTime(
  iso: string | null | undefined,
  fallback = "미확인"
): string {
  if (!iso) return fallback;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return date.toLocaleString("ko-KR");
  }
}

export function formatKrwAmount(
  amount: number | null | undefined,
  fallback = "정보 없음"
): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) {
    return fallback;
  }
  return `${amount.toLocaleString("ko-KR")}원`;
}

export function formatAccessStatusLabel(
  status: string | null | undefined
): string {
  if (!status) return "정보 없음";
  const labels: Record<string, string> = {
    created: "생성됨 (created)",
    authorized: "이용 승인됨 (authorized)",
    code_revealed: "PIN 확인됨 (code_revealed)",
    completed: "이용 완료 (completed)",
    failed: "실패 (failed)",
    expired: "만료됨 (expired)",
    canceled: "취소됨 (canceled)",
  };
  return labels[status] ?? status;
}

export function formatPaymentStatusLabel(
  status: string | null | undefined
): string {
  if (!status) return "결제 주문 없음";
  const labels: Record<string, string> = {
    created: "주문 생성 (created)",
    pending: "결제 대기 (pending)",
    approved: "결제 승인 완료 (approved)",
    failed: "결제 실패 (failed)",
    canceled: "결제 취소 (canceled)",
  };
  return labels[status] ?? status;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) {
    return "크기 미확인";
  }
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

export function serializeDecisionPayload(
  payload: DecisionFormPayload
): string {
  return JSON.stringify({
    decision: payload.decision,
    reason: payload.reason,
    confirmedStore: payload.confirmedStore,
    confirmedPurchaseAt: payload.confirmedPurchaseAt,
    confirmedAmount: payload.confirmedAmount,
    receiptReference: payload.receiptReference,
  });
}

