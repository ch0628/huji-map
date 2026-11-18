import { NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  AuthGuardError,
  isSupabaseAuthConfigured,
  requireRole,
} from "@/lib/auth";
import { createServerClientInstance } from "@/lib/supabase/server";
import {
  adminRefundListFilterSchema,
  listAdminRefunds,
  RefundServiceError,
} from "@/lib/payments/refunds";

/**
 * GET /api/v1/admin/refunds
 * Lists test payment refunds (including processing/uncertain/failed states) for administrators.
 * Spec: docs/04_API_CONTRACT.md, tasks/30_refund_server.md
 */
export async function GET(request: Request) {
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

  try {
    const supabase = await createServerClientInstance();
    await requireRole("admin", supabase);

    const { searchParams } = new URL(request.url);
    const parsedFilter = adminRefundListFilterSchema.safeParse({
      status: searchParams.get("status") ?? undefined,
      paymentOrderId: searchParams.get("paymentOrderId") ?? undefined,
      receiptSubmissionId: searchParams.get("receiptSubmissionId") ?? undefined,
      page: searchParams.get("page") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
    });

    if (!parsedFilter.success) {
      const issue = parsedFilter.error.issues[0];
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: issue?.message || "올바르지 않은 환급 조회 조건입니다.",
          },
          requestId,
        },
        { status: 400 }
      );
    }

    const result = await listAdminRefunds(parsedFilter.data);

    return NextResponse.json(
      {
        ok: true,
        items: result.items,
        pagination: result.pagination,
        requestId,
      },
      {
        status: 200,
        headers: { "Cache-Control": "private, no-store" },
      }
    );
  } catch (err: unknown) {
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
          message: "환급 목록 조회 중 서버 오류가 발생했습니다.",
        },
        requestId,
      },
      { status: 500 }
    );
  }
}

