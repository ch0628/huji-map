import { NextResponse } from "next/server";
import {
  AuthGuardError,
  isSupabaseAuthConfigured,
  requireRole,
} from "@/lib/auth";
import { createServerClientInstance } from "@/lib/supabase/server";
import {
  adminReceiptsFilterSchema,
  listAdminReceipts,
  ReceiptServiceError,
} from "@/lib/receipts";

/**
 * GET /api/v1/admin/receipts
 * Retrieves list of receipt submissions for administrator manual review.
 * Spec: docs/04_API_CONTRACT.md, tasks/28_manual_review_backend.md
 * Invariant: Strictly gated to verified administrators.
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
    const parsedFilter = adminReceiptsFilterSchema.safeParse({
      status: searchParams.get("status") ?? undefined,
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
            message: issue?.message || "올바르지 않은 조회 조건입니다.",
          },
          requestId,
        },
        { status: 400 }
      );
    }

    const result = await listAdminReceipts(parsedFilter.data);

    return NextResponse.json(
      {
        ok: true,
        items: result.items,
        pagination: result.pagination,
        requestId,
      },
      { status: 200 }
    );
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
        : "영수증 대기 목록 조회 중 오류가 발생했습니다.";
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

