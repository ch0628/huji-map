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
  reconcileAdminRefund,
  RefundServiceError,
} from "@/lib/payments/refunds";

interface RouteParams {
  params: Promise<{ paymentOrderId: string }>;
}

/**
 * POST /api/v1/admin/refunds/:paymentOrderId/reconcile
 * Reconciles an uncertain/processing refund attempt by querying Toss payment status
 * without sending a new cancel request.
 */
export async function POST(_request: Request, context: RouteParams) {
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

  try {
    const result = await reconcileAdminRefund({
      adminUserId: session.user.id,
      paymentOrderId: parsedParams.data.paymentOrderId,
      requestId,
    });

    return NextResponse.json(
      {
        ok: true,
        refund: result.refund,
        reconciled: result.reconciled,
        pgStatus: result.pgStatus,
        requestId,
      },
      {
        status: 200,
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
          message: "환급 상태 재조회 중 서버 오류가 발생했습니다.",
        },
        requestId,
      },
      { status: 500 }
    );
  }
}

