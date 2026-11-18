/**
-- Spec: docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/07_PAYMENT_ACCESS_REFUND.md,
--       docs/08_SECURITY_OPERATIONS.md, docs/11_DECISIONS.md, tasks/26_receipt_backend.md
 */

export type ReceiptSubmissionStatus =
  | "submitted"
  | "review_required"
  | "approved"
  | "rejected"
  | "resubmission_requested";

export type ReceiptMimeType = "image/jpeg" | "image/png" | "image/webp";

export interface ReceiptSubmissionRow {
  id: string;
  access_session_id: string;
  user_id: string;
  storage_path: string;
  mime_type: ReceiptMimeType;
  file_size_bytes: number;
  original_filename: string | null;
  client_submission_id: string;
  submission_status: ReceiptSubmissionStatus;
  store_name_confirmed: string | null;
  purchase_at_confirmed: string | null;
  purchase_amount_krw: number | null;
  receipt_reference: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicReceiptSubmission {
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
  reviewedAt: string | null;
  reviewReason: string | null;
  createdAt: string;
  updatedAt?: string;
}

export function toPublicReceiptSubmission(row: Partial<ReceiptSubmissionRow> & {
  id: string;
  access_session_id: string;
  user_id: string;
  storage_path: string;
  mime_type: string;
  file_size_bytes: number;
  submission_status: string;
  created_at: string;
}): PublicReceiptSubmission {
  return {
    id: row.id,
    accessSessionId: row.access_session_id,
    userId: row.user_id,
    storagePath: row.storage_path,
    mimeType: row.mime_type as ReceiptMimeType,
    fileSizeBytes: row.file_size_bytes,
    originalFilename: row.original_filename ?? null,
    submissionStatus: row.submission_status as ReceiptSubmissionStatus,
    storeNameConfirmed: row.store_name_confirmed ?? null,
    purchaseAtConfirmed: row.purchase_at_confirmed ?? null,
    purchaseAmountKrw: row.purchase_amount_krw ?? null,
    reviewedAt: row.reviewed_at ?? null,
    reviewReason: row.review_reason ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateUploadIntentParams {
  accessSessionId: string;
  mimeType: ReceiptMimeType;
  fileSizeBytes: number;
  originalFilename?: string | null;
  userId: string;
}

export interface CreateUploadIntentResult {
  uploadUrl: string;
  storagePath: string;
  token?: string;
  expiresIn: number;
}

export interface SubmitCustomerReceiptParams {
  accessSessionId: string;
  storagePath: string;
  mimeType: ReceiptMimeType;
  fileSizeBytes: number;
  originalFilename?: string | null;
  clientSubmissionId: string;
  userId: string;
}

export interface SubmitCustomerReceiptResult {
  receipt: PublicReceiptSubmission;
  reused: boolean;
}

export type AdminReceiptDecision =
  | "approved"
  | "rejected"
  | "resubmission_requested";

export interface AdminReceiptDecisionParams {
  submissionId: string;
  reviewerId: string;
  decision: AdminReceiptDecision;
  reason: string;
  confirmedStore?: string | null;
  confirmedPurchaseAt?: string | null;
  confirmedAmount?: number | null;
  receiptReference?: string | null;
  idempotencyKey?: string | null;
  payloadHash?: string | null;
}

export interface AdminReceiptDecisionResult {
  receipt: PublicReceiptSubmission;
  auditId: string;
  reused?: boolean;
}

export interface AdminReceiptsFilter {
  status?: string;
  page?: number;
  limit?: number;
}

export type AdminReceiptRefundStatus =
  | "none"
  | "requested"
  | "processing"
  | "succeeded"
  | "failed";

export interface AdminReceiptListItem extends PublicReceiptSubmission {
  // Store & restroom context
  restroomName?: string | null;
  businessId?: string | null;
  businessName?: string | null;
  businessRoadAddress?: string | null;

  // Submitter display name (non-PII display_name only)
  userDisplayName?: string | null;

  // Access session snapshot
  accessAuthorizedAt?: string | null;
  accessExpiresAt?: string | null;
  accessStatus?: string | null;

  // Versioned policy bound to access_sessions.policy_id
  policyVersion?: number | null;
  depositAmountKrw?: number | null;
  receiptWindowHours?: number | null;
  receiptWindowDeadline?: string | null;
  minPurchaseKrw?: number | null;

  // Actual deposit payment order (payment_orders via access_session_id)
  paymentOrderId?: string | null;
  paymentOrderNumber?: string | null;
  paymentAmountKrw?: number | null;
  paymentStatus?: string | null;
  paymentMode?: string | null;
  paymentApprovedAt?: string | null;

  // Receipt reference (admin-entered / stored on receipt_submissions)
  receiptReference?: string | null;

  // Refund record (payment_refunds via receipt_submission_id; strictly separate from review approval)
  refundStatus?: AdminReceiptRefundStatus;
  refundAmountKrw?: number | null;
  refundRequestedAt?: string | null;
  refundCompletedAt?: string | null;
}

export interface AdminReceiptListResult {
  items: AdminReceiptListItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

