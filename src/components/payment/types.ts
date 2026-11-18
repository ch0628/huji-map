/**
 * Client Payment UI Types & State Models
 * Spec: docs/04_API_CONTRACT.md, docs/05_SCREEN_SPEC.md, docs/07_PAYMENT_ACCESS_REFUND.md,
 *       docs/08_SECURITY_OPERATIONS.md, docs/11_DECISIONS.md, tasks/22_toss_checkout_ui.md
 */

import type { PublicPaymentOrder } from "@/lib/payments/types";
import type { PublicAccessSession } from "@/lib/access/types";

export type PaymentCheckoutState =
  | "idle"
  | "checking_auth"
  | "creating_order"
  | "loading_sdk"
  | "requesting_payment"
  | "redirecting"
  | "error";

export type PaymentConfirmState =
  | "idle"
  | "validating_params"
  | "verifying_auth"
  | "confirming"
  | "confirmed"
  | "failed"
  | "uncertain";

export interface TossCheckoutRequestOptions {
  clientKey: string;
  orderId: string;
  orderName: string;
  amount: number;
  customerKey: string;
  customerEmail?: string | null;
  customerName?: string | null;
  successUrl: string;
  failUrl: string;
}

export interface PaymentSuccessData {
  order: PublicPaymentOrder;
  accessSession: PublicAccessSession;
  alreadyApproved?: boolean;
}

export interface PaymentErrorDetails {
  code: string;
  message: string;
  isRetryable?: boolean;
  isUncertain?: boolean;
}

