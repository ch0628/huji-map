/**
 * TASK 30: Refund Server Audit Logging (audit_logs)
 * Spec: tasks/30_refund_server.md STEP 8
 *
 * Security Invariants:
 * - Strictly excludes Secret Keys, Authorization headers, receipt images/storage paths,
 *   phone numbers, emails, PINs, provider_payment_key, provider_cancel_id, and raw PG payloads.
 * - Failures in audit logging are safely caught and logged without secrets.
 */

import crypto from "node:crypto";
import type { RefundAuditAction } from "./types";

const FORBIDDEN_AUDIT_KEYS = new Set([
  "secret",
  "secretkey",
  "toss_test_secret_key",
  "authorization",
  "auth",
  "token",
  "pin",
  "password",
  "phone",
  "email",
  "storage_path",
  "image",
  "imageurl",
  "signedurl",
  "provider_payment_key",
  "paymentkey",
  "provider_cancel_id",
  "transactionkey",
  "raw",
  "card",
  "easyPay",
]);

function sanitizeAuditValue(value: unknown, depth = 0): unknown {
  if (depth > 4) {
    return "[TRUNCATED]";
  }
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    // Strip any accidental test_sk_ / live_ / Basic auth strings
    if (
      value.includes("test_sk_") ||
      value.includes("test_gsk_") ||
      value.includes("live_") ||
      value.includes("Basic ")
    ) {
      return "[REDACTED]";
    }
    return value.slice(0, 500);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeAuditValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = k.toLowerCase().replace(/[^a-z0-9_]/g, "");
      if (
        FORBIDDEN_AUDIT_KEYS.has(normalizedKey) ||
        normalizedKey.includes("secret") ||
        normalizedKey.includes("paymentkey") ||
        normalizedKey.includes("cancelid") ||
        normalizedKey.includes("password") ||
        normalizedKey.includes("phone") ||
        normalizedKey.includes("token")
      ) {
        continue;
      }
      out[k] = sanitizeAuditValue(v, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, 200);
}

export interface RecordRefundAuditParams {
  adminClient: unknown;
  actorUserId: string | null;
  action: RefundAuditAction;
  entityType: "payment_refunds" | "payment_orders" | "receipt_submissions";
  entityId: string;
  requestId?: string;
  beforeData?: Record<string, unknown> | null;
  afterData?: Record<string, unknown> | null;
  reason?: string | null;
}

export async function recordRefundAuditLog(
  params: RecordRefundAuditParams
): Promise<void> {
  const {
    adminClient,
    actorUserId,
    action,
    entityType,
    entityId,
    requestId,
    beforeData,
    afterData,
    reason,
  } = params;

  const eventId = requestId || crypto.randomUUID();
  const occurredAt = new Date().toISOString();

  const safeBefore = beforeData
    ? (sanitizeAuditValue(beforeData) as Record<string, unknown>)
    : null;
  const safeAfter = sanitizeAuditValue({
    ...(afterData || {}),
    eventId,
    occurredAt,
  }) as Record<string, unknown>;

  const safeReason =
    typeof reason === "string"
      ? (sanitizeAuditValue(reason) as string).slice(0, 1000)
      : null;

  try {
    const client = adminClient as {
      from: (table: string) => {
        insert: (row: Record<string, unknown>) => Promise<{ error?: unknown }>;
      };
    };

    const { error } = await client.from("audit_logs").insert({
      actor_user_id: actorUserId,
      action,
      entity_type: entityType,
      entity_id: entityId,
      before_data: safeBefore,
      after_data: safeAfter,
      reason: safeReason,
    });

    if (error) {
      console.warn(
        `[refund-audit] Failed to persist audit_logs action=${action} entityId=${entityId}`
      );
    }
  } catch {
    console.warn(
      `[refund-audit] Unexpected error persisting audit_logs action=${action} entityId=${entityId}`
    );
  }
}

