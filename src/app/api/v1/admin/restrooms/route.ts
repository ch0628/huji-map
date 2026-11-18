import { NextResponse } from "next/server";
import {
  AuthGuardError,
  isSupabaseAuthConfigured,
  requireRole,
} from "@/lib/auth";
import { createServerClientInstance } from "@/lib/supabase/server";
import {
  adminRestroomListFilterSchema,
  listRestroomsForAdmin,
  AdminRestroomError,
} from "@/lib/restrooms";

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

  const { searchParams } = new URL(request.url);
  const parsedFilter = adminRestroomListFilterSchema.safeParse({
    status: searchParams.get("status") ?? undefined,
    type: searchParams.get("type") ?? undefined,
    q: searchParams.get("q") ?? undefined,
    limit: searchParams.get("limit") ?? undefined,
    offset: searchParams.get("offset") ?? undefined,
  });

  if (!parsedFilter.success) {
    const firstIssue = parsedFilter.error.issues[0];
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: firstIssue?.message ?? "조회 필터 값이 올바르지 않습니다.",
        },
        requestId,
      },
      { status: 400 }
    );
  }

  try {
    const supabase = await createServerClientInstance();
    await requireRole("admin", supabase);

    const result = await listRestroomsForAdmin(supabase, parsedFilter.data);

    return NextResponse.json(
      {
        ok: true,
        data: result.restrooms,
        count: result.count,
        total: result.total,
        requestId,
      },
      { status: 200 }
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

    if (err instanceof AdminRestroomError) {
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
      err instanceof Error ? err.message : "화장실 심사 목록 조회 중 오류가 발생했습니다.";
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

