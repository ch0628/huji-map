/**
 * Customer Access Ticket & Doorlock PIN UI Types and Validation
 * Spec: docs/03_DATA_MODEL.md, docs/05_SCREEN_SPEC.md, docs/07_PAYMENT_ACCESS_REFUND.md,
 *       docs/08_SECURITY_OPERATIONS.md, docs/11_DECISIONS.md, tasks/25_pin_ui.md
 *
 * Security Invariants:
 * - Plaintext PIN is NEVER included in CustomerAccessSummary or CustomerAccessDetail.
 * - PIN is only fetched on demand via POST /api/v1/access/:id/reveal-pin and held in volatile React state.
 * - Internal idempotency_key, provider_payment_key, provider_cancel_id, and lock secrets are never serialized.
 */

import { z } from "zod";
import type {
  AccessMethodSnapshot,
  AccessSessionStatus,
  PublicAccessSession,
  VisitConfirmationMethod,
  VisitConfirmationUsageStatus,
} from "@/lib/access/types";
import type {
  PaymentOrderStatus,
  PaymentRefundStatus,
  PublicPaymentOrder,
  PublicPaymentRefund,
} from "@/lib/payments/types";

export const visitConfirmationSubmitSchema = z
  .object({
    usageStatus: z.enum(["success", "failed", "unknown"], {
      message: "유효한 이용 결과 상태(success, failed, unknown)를 선택해 주세요.",
    }),
    failureReason: z
      .string()
      .trim()
      .max(300, "실패 사유는 300자 이내로 입력해 주세요.")
      .optional()
      .nullable(),
  })
  .superRefine((val, ctx) => {
    if (
      val.usageStatus === "failed" &&
      (!val.failureReason || val.failureReason.trim().length < 2)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failureReason"],
        message: "이용 실패를 선택한 경우 사유를 2자 이상 입력해 주세요.",
      });
    }
  });

export type VisitConfirmationSubmitInput = z.infer<
  typeof visitConfirmationSubmitSchema
>;

export interface PublicVisitConfirmation {
  id: string;
  access_session_id: string;
  usage_status: VisitConfirmationUsageStatus;
  verification_method: VisitConfirmationMethod;
  arrival_confirmed_at: string | null;
  failure_reason: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AccessRestroomSummary {
  id: string;
  name: string;
  road_address: string;
  address_detail: string | null;
  floor: string | null;
  entrance_instructions: string | null;
  access_method: AccessMethodSnapshot;
  publication_status: string;
  business_id: string | null;
  business_name: string | null;
  business_category: string | null;
  business_phone: string | null;
}

export interface AccessPolicySummary {
  id: string;
  version: number;
  access_mode: "free" | "test_deposit" | "real_deposit";
  deposit_amount_krw: number | null;
  refund_eligible: boolean;
  receipt_window_hours: number | null;
  min_purchase_krw: number | null;
}

export interface CustomerAccessListItem {
  session: PublicAccessSession;
  effectiveStatus: AccessSessionStatus;
  restroom: AccessRestroomSummary | null;
  order: PublicPaymentOrder | null;
  refund: PublicPaymentRefund | null;
  latestVisitConfirmation: PublicVisitConfirmation | null;
  eligibleForPinReveal: boolean;
}

export interface CustomerAccessDetail extends CustomerAccessListItem {
  policy: AccessPolicySummary | null;
  visitConfirmations: PublicVisitConfirmation[];
}

export type PinRevealErrorCategory =
  | "unauthenticated"
  | "forbidden"
  | "payment_incomplete"
  | "canceled_or_refunded"
  | "expired"
  | "stale_rotated"
  | "rate_limited"
  | "not_supported"
  | "unavailable"
  | "server_error";

export interface ClassifiedPinError {
  category: PinRevealErrorCategory;
  code: string;
  title: string;
  message: string;
  canRetry: boolean;
  requiresLogin: boolean;
  isRotatedConflict: boolean;
}

/**
 * Computes effective session status considering current clock time vs expires_at.
 */
export function resolveEffectiveAccessStatus(
  session: Pick<PublicAccessSession, "status" | "expires_at">,
  refund: Pick<PublicPaymentRefund, "status"> | null = null,
  now = new Date()
): AccessSessionStatus {
  if (
    refund &&
    (refund.status === "succeeded" ||
      refund.status === "processing" ||
      refund.status === "requested")
  ) {
    return "canceled";
  }

  if (
    session.status === "completed" ||
    session.status === "failed" ||
    session.status === "canceled" ||
    session.status === "expired"
  ) {
    return session.status;
  }

  const expiryMs = new Date(session.expires_at).getTime();
  if (Number.isFinite(expiryMs) && now.getTime() >= expiryMs) {
    return "expired";
  }

  return session.status;
}

/**
 * Evaluates whether a customer access session is eligible to request doorlock PIN reveal.
 * Must have:
 * 1) access_method_snapshot === 'pin'
 * 2) effectiveStatus in ('authorized', 'code_revealed')
 * 3) order?.status === 'approved'
 * 4) no active/completed refund
 * 5) unexpired time
 */
export function evaluatePinRevealEligibility(params: {
  session: Pick<
    PublicAccessSession,
    "status" | "expires_at" | "access_method_snapshot"
  >;
  order: Pick<PublicPaymentOrder, "status"> | null;
  refund: Pick<PublicPaymentRefund, "status"> | null;
  restroom?: Pick<AccessRestroomSummary, "publication_status" | "access_method"> | null;
  now?: Date;
}): {
  eligible: boolean;
  reasonCode:
    | "ELIGIBLE"
    | "NOT_PIN_METHOD"
    | "PAYMENT_REQUIRED"
    | "CANCELED_OR_REFUNDED"
    | "EXPIRED"
    | "COMPLETED"
    | "FAILED"
    | "RESTROOM_UNAVAILABLE";
  reasonLabel: string;
} {
  const { session, order, refund, restroom, now = new Date() } = params;
  const effectiveStatus = resolveEffectiveAccessStatus(session, refund, now);

  if (
    refund &&
    (refund.status === "succeeded" ||
      refund.status === "processing" ||
      refund.status === "requested")
  ) {
    return {
      eligible: false,
      reasonCode: "CANCELED_OR_REFUNDED",
      reasonLabel: "환불 또는 취소 처리된 이용권은 PIN을 조회할 수 없습니다.",
    };
  }

  if (effectiveStatus === "canceled") {
    return {
      eligible: false,
      reasonCode: "CANCELED_OR_REFUNDED",
      reasonLabel: "취소된 이용권은 PIN을 조회할 수 없습니다.",
    };
  }

  if (effectiveStatus === "expired") {
    return {
      eligible: false,
      reasonCode: "EXPIRED",
      reasonLabel: "이용권 유효기한이 만료되어 PIN을 조회할 수 없습니다.",
    };
  }

  if (effectiveStatus === "failed") {
    return {
      eligible: false,
      reasonCode: "FAILED",
      reasonLabel: "결제 또는 발급에 실패한 이용권입니다.",
    };
  }

  if (effectiveStatus === "created" || !order || order.status !== "approved") {
    return {
      eligible: false,
      reasonCode: "PAYMENT_REQUIRED",
      reasonLabel: "결제 승인 후 확인 가능 (보증금 결제 승인이 완료되어야 합니다).",
    };
  }

  if (session.access_method_snapshot !== "pin") {
    return {
      eligible: false,
      reasonCode: "NOT_PIN_METHOD",
      reasonLabel:
        session.access_method_snapshot === "ask_staff"
          ? "직원 문의 출입 화장실입니다. 아래 이용권 화면을 매장 직원에게 제시해 주세요."
          : "별도 도어락 비밀번호 없이 출입 가능한 개방형 제휴 화장실입니다.",
    };
  }

  if (restroom && restroom.publication_status !== "published") {
    return {
      eligible: false,
      reasonCode: "RESTROOM_UNAVAILABLE",
      reasonLabel: "현재 매장의 화장실 운영이 일시 중단되어 PIN을 조회할 수 없습니다.",
    };
  }

  if (effectiveStatus === "completed") {
    return {
      eligible: false,
      reasonCode: "COMPLETED",
      reasonLabel: "이용 완료 처리된 이용권입니다.",
    };
  }

  return {
    eligible: true,
    reasonCode: "ELIGIBLE",
    reasonLabel: "결제 승인 및 이용 자격이 확인되었습니다. 버튼을 눌러 PIN을 확인하세요.",
  };
}

/**
 * Classifies HTTP status and error code from POST /api/v1/access/:id/reveal-pin
 * into structured user-facing Korean messages per TASK 25 spec.
 */
export function classifyPinRevealError(
  httpStatus: number,
  errorCode?: string | null,
  serverMessage?: string | null
): ClassifiedPinError {
  const code = (errorCode || "UNKNOWN_ERROR").toUpperCase();

  // 1. 비로그인 / 세션 만료 (401)
  if (
    httpStatus === 401 ||
    code === "UNAUTHORIZED" ||
    code === "UNAUTHENTICATED" ||
    code === "SESSION_EXPIRED"
  ) {
    return {
      category: "unauthenticated",
      code,
      title: "로그인이 필요합니다",
      message:
        serverMessage ||
        "로그인 세션이 만료되었거나 로그인되지 않았습니다. 다시 로그인한 뒤 이용해 주세요.",
      canRetry: false,
      requiresLogin: true,
      isRotatedConflict: false,
    };
  }

  // 2. PIN 교체로 인한 409 충돌 (409 PIN_STALE_ROTATED)
  if (httpStatus === 409 || code === "PIN_STALE_ROTATED") {
    return {
      category: "stale_rotated",
      code: "PIN_STALE_ROTATED",
      title: "도어락 비밀번호가 최근 변경되었습니다",
      message:
        "매장에서 도어락 비밀번호를 새로 교체하여 이전 비밀번호는 표시되지 않습니다. 아래 '최신 PIN 다시 조회하기' 버튼을 눌러 새 비밀번호를 확인해 주세요.",
      canRetry: true,
      requiresLogin: false,
      isRotatedConflict: true,
    };
  }

  // 3. 타인 이용권 또는 계정 권한 없음 (403)
  if (
    httpStatus === 403 ||
    code === "FORBIDDEN" ||
    code === "ACCOUNT_SUSPENDED"
  ) {
    return {
      category: "forbidden",
      code,
      title: "PIN 조회 권한이 없습니다",
      message:
        serverMessage ||
        "본인이 결제한 유효한 이용권만 도어락 비밀번호를 조회할 수 있습니다.",
      canRetry: false,
      requiresLogin: false,
      isRotatedConflict: false,
    };
  }

  // 4. 결제 미완료 (422 PAYMENT_REQUIRED / PAYMENT_NOT_APPROVED)
  if (code === "PAYMENT_REQUIRED" || code === "PAYMENT_NOT_APPROVED") {
    return {
      category: "payment_incomplete",
      code,
      title: "결제 승인 후 확인 가능",
      message:
        serverMessage ||
        "서버에서 확인된 정상 보증금 결제 승인 내역이 없습니다. 결제가 완료된 후 이용해 주세요.",
      canRetry: false,
      requiresLogin: false,
      isRotatedConflict: false,
    };
  }

  // 5. 취소·환불 (422 ACCESS_CANCELED / PAYMENT_REFUNDED)
  if (code === "ACCESS_CANCELED" || code === "PAYMENT_REFUNDED") {
    return {
      category: "canceled_or_refunded",
      code,
      title: "취소·환불된 이용권",
      message:
        serverMessage ||
        "이미 취소되었거나 보증금 환불 처리가 진행/완료된 이용권은 PIN을 조회할 수 없습니다.",
      canRetry: false,
      requiresLogin: false,
      isRotatedConflict: false,
    };
  }

  // 6. 유효기간 만료 (422 ACCESS_EXPIRED)
  if (code === "ACCESS_EXPIRED") {
    return {
      category: "expired",
      code,
      title: "이용권 유효기한 만료",
      message:
        serverMessage ||
        "화장실 이용권의 유효 시간이 만료되어 도어락 PIN을 조회할 수 없습니다.",
      canRetry: false,
      requiresLogin: false,
      isRotatedConflict: false,
    };
  }

  // 7. PIN 미지원 화장실 (400 PIN_NOT_SUPPORTED)
  if (code === "PIN_NOT_SUPPORTED") {
    return {
      category: "not_supported",
      code,
      title: "도어락 PIN 미사용 화장실",
      message:
        serverMessage ||
        "이 화장실은 도어락 비밀번호 방식을 사용하지 않습니다. 출입 안내를 확인해 주세요.",
      canRetry: false,
      requiresLogin: false,
      isRotatedConflict: false,
    };
  }

  // 8. 화장실 비공개/미등록 PIN/이용권 미존재 (404 / 422 RESTROOM_UNAVAILABLE)
  if (
    httpStatus === 404 ||
    code === "ACCESS_NOT_FOUND" ||
    code === "RESTROOM_NOT_FOUND" ||
    code === "PIN_NOT_AVAILABLE" ||
    code === "RESTROOM_UNAVAILABLE" ||
    code === "ACCESS_INVALID"
  ) {
    return {
      category: "unavailable",
      code,
      title: "현재 PIN을 조회할 수 없습니다",
      message:
        serverMessage ||
        "이용권 또는 매장의 활성 도어락 비밀번호 정보를 확인할 수 없습니다. 매장 직원에게 문의해 주세요.",
      canRetry: false,
      requiresLogin: false,
      isRotatedConflict: false,
    };
  }

  // 9. 요청 횟수 초과 (429 TOO_MANY_REQUESTS)
  if (httpStatus === 429 || code === "TOO_MANY_REQUESTS") {
    return {
      category: "rate_limited",
      code: "TOO_MANY_REQUESTS",
      title: "조회 요청이 너무 많습니다",
      message:
        serverMessage ||
        "단시간에 너무 많은 PIN 조회 요청이 발생했습니다. 잠시 후 다시 시도해 주세요.",
      canRetry: true,
      requiresLogin: false,
      isRotatedConflict: false,
    };
  }

  // 10. 서버 오류 또는 일시적 조회 실패 (500 / 503 / 네트워크)
  return {
    category: "server_error",
    code,
    title: "일시적인 조회 오류",
    message:
      serverMessage ||
      "서버 통신 중 일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
    canRetry: true,
    requiresLogin: false,
    isRotatedConflict: false,
  };
}

export function getAccessStatusLabel(status: AccessSessionStatus): string {
  switch (status) {
    case "created":
      return "결제 승인 대기";
    case "authorized":
      return "이용 가능 (결제 완료)";
    case "code_revealed":
      return "이용 중 (PIN 확인됨)";
    case "completed":
      return "방문 완료";
    case "expired":
      return "유효기한 만료";
    case "canceled":
      return "취소·환불됨";
    case "failed":
      return "결제/발급 실패";
    default:
      return status;
  }
}

export function getPaymentQualificationLabel(
  order: Pick<PublicPaymentOrder, "status" | "amount_krw"> | null,
  refund: Pick<PublicPaymentRefund, "status" | "amount_krw"> | null
): string {
  if (!order) {
    return "결제 내역 없음";
  }
  if (refund) {
    if (refund.status === "succeeded") {
      return `테스트 환급 완료 (${refund.amount_krw.toLocaleString()}원)`;
    }
    if (refund.status === "processing" || refund.status === "requested") {
      return "환급(결제 취소) 처리 중";
    }
  }
  switch (order.status as PaymentOrderStatus) {
    case "approved":
      return `테스트 결제 승인 (${order.amount_krw.toLocaleString()}원)`;
    case "pending":
    case "created":
      return "결제 승인 대기 중";
    case "canceled":
      return "결제 취소됨";
    case "failed":
      return "결제 실패";
    default:
      return order.status;
  }
}

export function getRefundStatusBadgeLabel(
  refundStatus: PaymentRefundStatus | null | undefined
): string | null {
  if (!refundStatus) return null;
  switch (refundStatus) {
    case "requested":
      return "환급 요청됨";
    case "processing":
      return "환급 처리 중";
    case "succeeded":
      return "테스트 환급 완료";
    case "failed":
      return "환급 처리 실패";
    default:
      return null;
  }
}

