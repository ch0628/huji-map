import { NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  AuthGuardError,
  isSupabaseAuthConfigured,
  requireRole,
} from "@/lib/auth";
import { createServerClientInstance } from "@/lib/supabase/server";
import { PaymentConfigError } from "@/lib/payments/config";
import {
  adminRefundPathParamSchema,
  adminRefundRequestBodySchema,
  RefundServiceError,
  requestAdminRefund,
} from "@/lib/payments/refunds";

interface RouteParams {
  params: Promise<{ paymentOrderId: string }>;
}

/**
 * POST /api/v1/admin/refunds/:paymentOrderId/request
 * Admin-only full test cancellation for an approved receipt linked to a Toss test payment order.
 * Spec: docs/04_API_CONTRACT.md, docs/07_PAYMENT_ACCESS_REFUND.md, tasks/30_refund_server.md
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

  let session;
  try {
    const supabase = await createServerClientInstance();
    session = await requireRole("admin", supabase);
  } catch (authErr: unknown) {
    if (authErr instanceof AuthGuardError) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: authErr.code,
            message: authErr.userMessage,
          },
          requestId,
        },
        { status: authErr.status }
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "UNAUTHORIZED",
          message: "관리자 인증이 필요합니다.",
        },
        requestId,
      },
      { status: 401 }
    );
  }

  const rawParams = await context.params;
  const parsedParams = adminRefundPathParamSchema.safeParse(rawParams);
  if (!parsedParams.success) {
    const issue = parsedParams.error.issues[0];
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: issue?.message || "유효한 결제 주문 식별자(UUID)가 아닙니다.",
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
          code: "INVALID_JSON",
          message: "JSON 형식의 요청 본문이 필요합니다.",
        },
        requestId,
      },
      { status: 400 }
    );
  }

  const parsedBody = adminRefundRequestBodySchema.safeParse(body);
  if (!parsedBody.success) {
    const issue = parsedBody.error.issues[0];
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: issue?.message || "환급 요청 본문이 올바르지 않습니다.",
        },
        requestId,
      },
      { status: 400 }
    );
  }

  const headerIdempotencyKey = request.headers.get("x-idempotency-key")?.trim();
  if (
    headerIdempotencyKey &&
    headerIdempotencyKey !== parsedBody.data.idempotencyKey
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message:
            "x-idempotency-key 헤더와 요청 본문의 idempotencyKey가 일치하지 않습니다.",
        },
        requestId,
      },
      { status: 400 }
    );
  }

  try {
    const result = await requestAdminRefund({
      adminUserId: session.user.id,
      paymentOrderId: parsedParams.data.paymentOrderId,
      receiptSubmissionId: parsedBody.data.receiptSubmissionId,
      idempotencyKey: parsedBody.data.idempotencyKey,
      requestId,
    });

    return NextResponse.json(
      {
        ok: true,
        refund: result.refund,
        reused: result.reused,
        outcome: result.outcome,
        requestId,
      },
      {
        status: result.reused ? 200 : 201,
        headers: { "Cache-Control": "private, no-store" },
      }
    );
  } catch (err: unknown) {
    if (err instanceof PaymentConfigError) {
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

    if (err instanceof RefundServiceError) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: err.code,
            message: err.userMessage,
          },
          requestId,
        },
        { status: err.statusCode }
      );
    }

    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "테스트 환급 처리 중 서버 오류가 발생했습니다.",
        },
        requestId,
      },
      { status: 500 }
    );
  }
}

