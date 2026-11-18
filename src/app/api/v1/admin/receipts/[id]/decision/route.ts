import { NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  AuthGuardError,
  checkIdempotencyKey,
  isSupabaseAuthConfigured,
  recordIdempotencyResponse,
  requireRole,
} from "@/lib/auth";
import { createServerClientInstance } from "@/lib/supabase/server";
import {
  adminReceiptDecisionSchema,
  decideReceiptReview,
  ReceiptServiceError,
} from "@/lib/receipts";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/v1/admin/receipts/:id/decision
 * Executes administrator manual review decision (approve, reject, request resubmission).
 * Spec: docs/04_API_CONTRACT.md, docs/07_PAYMENT_ACCESS_REFUND.md, tasks/28_manual_review_backend.md
 * Invariant: Atomic single transaction, row-level locking, append-only review audit trail,
 *            strict reason check, NO automatic refund, and conflict prevention.
 */
export async function POST(request: Request, context: RouteParams) {
  const requestId = crypto.randomUUID();

  if (!isSupabaseAuthConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "CONFIG_REQUIRED",
          message: "인증 서비스 설정이 필요합니다.",
        },
        requestId,
      },
      { status: 503 }
    );
  }

  const { id } = await context.params;
  if (!id || !UUID_REGEX.test(id)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "유효한 영수증 식별자(UUID)가 아닙니다.",
        },
        requestId,
      },
      { status: 400 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "JSON 형식의 요청 본문이 필요합니다.",
        },
        requestId,
      },
      { status: 400 }
    );
  }

  const parsed = adminReceiptDecisionSchema.safeParse(body);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message:
            firstIssue?.message ?? "심사 결정 입력값이 올바르지 않습니다.",
        },
        requestId,
      },
      { status: 400 }
    );
  }

  try {
    const supabase = await createServerClientInstance();
    const session = await requireRole("admin", supabase);

    // In-memory fast cache check
    const idempotencyHeader = request.headers.get("x-idempotency-key");
    const idempotencyScope = `admin_receipt_decision:${id}`;
    const idempotencyResult = checkIdempotencyKey(
      idempotencyHeader,
      idempotencyScope,
      body
    );

    if (idempotencyResult.action === "replay" && idempotencyResult.cachedResponse) {
      return NextResponse.json(idempotencyResult.cachedResponse.body, {
        status: idempotencyResult.cachedResponse.status,
      });
    }

    if (idempotencyResult.isDuplicate) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "CONFLICT",
            message:
              "동일한 Idempotency-Key로 다른 요청 본문이 전송되었거나 이미 처리 중입니다.",
          },
          requestId,
        },
        { status: 409 }
      );
    }

    // Compute deterministic payload hash for DB-level multi-instance idempotency verification
    const payloadHash = idempotencyHeader
      ? crypto
          .createHash("sha256")
          .update(JSON.stringify(parsed.data))
          .digest("hex")
      : undefined;

    const result = await decideReceiptReview({
      submissionId: id,
      reviewerId: session.user.id,
      decision: parsed.data.decision,
      reason: parsed.data.reason,
      confirmedStore: parsed.data.confirmedStore ?? null,
      confirmedPurchaseAt: parsed.data.confirmedPurchaseAt ?? null,
      confirmedAmount: parsed.data.confirmedAmount ?? null,
      receiptReference: parsed.data.receiptReference ?? null,
      idempotencyKey: idempotencyHeader ?? null,
      payloadHash: payloadHash ?? null,
    });

    const responsePayload = {
      ok: true,
      receipt: result.receipt,
      auditId: result.auditId,
      requestId,
    };

    recordIdempotencyResponse(
      idempotencyHeader,
      idempotencyScope,
      200,
      responsePayload
    );

    return NextResponse.json(responsePayload, { status: 200 });
  } catch (err) {
    if (err instanceof AuthGuardError) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: err.code,
            message: err.userMessage,
          },
          requestId,
        },
        { status: err.status }
      );
    }

    if (err instanceof ReceiptServiceError) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: err.code,
            message: err.message,
          },
          requestId,
        },
        { status: err.statusCode }
      );
    }

    const message =
      err instanceof Error
        ? err.message
        : "영수증 심사 처리 중 오류가 발생했습니다.";
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message,
        },
        requestId,
      },
      { status: 500 }
    );
  }
}
