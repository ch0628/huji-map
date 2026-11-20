import { NextResponse } from "next/server";
import {
  AuthGuardError,
  isSupabaseAuthConfigured,
  requireRole,
} from "@/lib/auth";
import {
  createAdminClient,
  createServerClientInstance,
  isServiceRoleConfigured,
} from "@/lib/supabase/server";
import { getBusinessDetailForAdmin } from "@/lib/businesses";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, { params }: RouteParams) {
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

  const { id } = await params;
  if (!id || typeof id !== "string") {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "가게 식별자가 올바르지 않습니다.",
        },
        requestId,
      },
      { status: 400 }
    );
  }

  try {
    const supabase = await createServerClientInstance();
    await requireRole("admin", supabase);

    // After verifying admin role with user session, use service_role client to read
    // private verification columns that are protected from authenticated role column-level GRANTs.
    const queryClient = isServiceRoleConfigured() ? createAdminClient() : supabase;
    const business = await getBusinessDetailForAdmin(queryClient, id);

    return NextResponse.json(
      {
        ok: true,
        business,
        requestId,
      },
      { status: 200 }
    );
  } catch (err) {
    if (err instanceof AuthGuardError) {
      if (err.status >= 500) {
        console.error(
          `[GET /api/v1/admin/businesses/[id]] requestId=${requestId} code=${err.safeReasonCode ?? err.code} status=${err.status}`
        );
      }
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

    console.error(
      `[GET /api/v1/admin/businesses/[id]] requestId=${requestId} code=UNEXPECTED_ERROR status=500`
    );
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "가게 상세 조회 중 오류가 발생했습니다.",
        },
        requestId,
      },
      { status: 500 }
    );
  }
}

