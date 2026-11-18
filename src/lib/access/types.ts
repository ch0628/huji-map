/**
 * Restroom Access Sessions Types & Validation
 * Spec: docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/07_PAYMENT_ACCESS_REFUND.md,
 *       docs/08_SECURITY_OPERATIONS.md, docs/11_DECISIONS.md, tasks/20_payment_schema.md
 */

import { z } from "zod";

export const ACCESS_SESSION_STATUSES = [
  "created",
  "authorized",
  "code_revealed",
  "completed",
  "failed",
  "expired",
  "canceled",
] as const;
export type AccessSessionStatus = (typeof ACCESS_SESSION_STATUSES)[number];

export const ACCESS_METHOD_SNAPSHOTS = [
  "open",
  "ask_staff",
  "pin",
] as const;
export type AccessMethodSnapshot = (typeof ACCESS_METHOD_SNAPSHOTS)[number];

/**
 * Full database row representation of `public.access_sessions`
 */
export interface AccessSessionRow {
  id: string; // uuid PK
  user_id: string; // uuid FK to profiles(id)
  restroom_id: string; // uuid FK to restrooms(id)
  policy_id: string; // uuid FK to restroom_access_policies(id)
  status: AccessSessionStatus;
  access_method_snapshot: AccessMethodSnapshot;
  idempotency_key: string;
  authorized_at: string | null;
  code_revealed_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

/**
 * Public client-facing view of an access session
 * Notice: PIN code itself is NEVER a column or property on access_sessions!
 * Internal idempotency_key is strictly omitted for client consumption.
 */
export type PublicAccessSession = Omit<AccessSessionRow, "idempotency_key">;

// ============================================================================
// Zod Validation Scheemas
// ============================================================================

export const accessSessionStatusSchema = z.enum(ACCESS_SESSION_STATUSES);

export const accessMethodSnapshotSchema = z.enum(ACCESS_METHOD_SNAPSHOTS);

/**
 * Creation payload for an access session
 */
export const createAccessSessionSchema = z.object({
  user_id: z.string().uuid("user_id must be a valid UUID"),
  restroom_id: z.string().uuid("restroom_id must be a valid UUID"),
  policy_id: z.string().uuid("policy_id must be a valid UUID"),
  access_method_snapshot: accessMethodSnapshotSchema,
  idempotency_key: z
    .string()
    .trim()
    .min(10, "idempotency_key must be at least 10 characters")
    .max(128, "idempotency_key cannot exceed 128 characters"),
  expires_at: z.string().datetime("expires_at must be an ISO 8601 string"),
});

export type CreateAccessSessionInput = z.infer<typeof createAccessSessionSchema>;

// ============================================================================
// Helper Functions & State Guards
// ============================================================================

/**
 * Checks if an access session is in an active (authorized or code_revealed) state
 * and has not yet expired.
 */
export function isAccessSessionActive(
  session: Pick<AccessSessionRow, "status" | "expires_at">,
  now = new Date()
): boolean {
  if (session.status !== "authorized" && session.status !== "code_revealed") {
    return false;
  }
  const expiry = new Date(session.expires_at);
  return expiry.getTime() > now.getTime();
}

/**
 * Checks if an access session qualifies for doorlock PIN reveal:
 * Must be active, access method must be 'pin', and not expired.
 */
export function canRevealPin(
  session: Pick<AccessSessionRow, "status" | "expires_at" | "access_method_snapshot">,
  now = new Date()
): boolean {
  if (session.access_method_snapshot !== "pin") {
    return false;
  }
  return isAccessSessionActive(session, now);
}

/**
 * Terminal states for access sessions (cannot be transitioned out of)
 */
export function isTerminalAccessSessionStatus(
  status: AccessSessionStatus
): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "expired" ||
    status === "canceled"
  );
}

/**
 * Sanitizes a database access session row for safe public/client consumption
 * Strictly removes internal idempotency_key
 */
export function toPublicAccessSession(row: AccessSessionRow): PublicAccessSession {
  const { idempotency_key: _omittedIdemKey, ...safe } = row;
  return safe;
}

// ============================================================================
// PIN Reveal Audits & Visit Confirmations (TASK 24)
// ============================================================================

export const PIN_REVEAL_AUDIT_RESULTS = ["success", "denied", "error"] as const;
export type PinRevealAuditResult = (typeof PIN_REVEAL_AUDIT_RESULTS)[number];

export interface PinRevealAuditRow {
  id: string; // uuid PK
  access_session_id: string | null;
  user_id: string | null;
  restroom_id: string | null;
  code_version: number | null;
  result: PinRevealAuditResult;
  reason: string | null;
  request_id: string | null;
  created_at: string;
}

export const VISIT_CONFIRMATION_USAGE_STATUSES = [
  "success",
  "failed",
  "unknown",
] as const;
export type VisitConfirmationUsageStatus =
  (typeof VISIT_CONFIRMATION_USAGE_STATUSES)[number];

export const VISIT_CONFIRMATION_METHODS = [
  "user",
  "merchant",
  "operator",
] as const;
export type VisitConfirmationMethod =
  (typeof VISIT_CONFIRMATION_METHODS)[number];

export interface VisitConfirmationRow {
  id: string; // uuid PK
  access_session_id: string;
  usage_status: VisitConfirmationUsageStatus;
  verification_method: VisitConfirmationMethod;
  verified_by: string | null;
  arrival_confirmed_at: string | null;
  failure_reason: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Clean, safe client response for POST /api/v1/access/:id/reveal-pin
 * Invariant: Never contains ciphertext, iv, auth_tag, or encryption keys.
 */
export interface RevealPinResponse {
  ok: true;
  pin: string;
  codeVersion: number;
  expiresAt: string;
  requestId: string;
}

export class AccessPinServiceError extends Error {
  code: string;
  statusCode: number;
  reason?: string;

  constructor(
    code: string,
    message: string,
    statusCode = 400,
    reason?: string
  ) {
    super(message);
    this.name = "AccessPinServiceError";
    this.code = code;
    this.statusCode = statusCode;
    this.reason = reason;
  }
}


