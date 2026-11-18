import { NextResponse } from "next/server";
import { AuthGuardError, isSupabaseAuthConfigured } from "@/lib/auth";
import { getLeadDetailForAdmin, uuidParamSchema } from "@/lib/leads";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const requestId = crypto.randomUUID();

  if (!isSupabaseAuthConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "CONFIG_REQUIRED",
          message: "서버 설정이 필요합니다.",
        },
        requestId,
      },
      { status: 503 }
    );
  }

  const { id } = await context.params;
  const parsedId = uuidParamSchema.safeParse(id);
  if (!parsedId.success) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "유효한 리드 ID(UUID)가 아닙니다.",
        },
        requestId,
      },
      { status: 400 }
    );
  }

  try {
    const detail = await getLeadDetailForAdmin(parsedId.data);
    if (!detail) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: "요청한 가게 리드를 찾을 수 없습니다.",
          },
          requestId,
        },
        { status: 404 }
      );
    }

    return NextResponse.json(
      {
        ok: true,
        lead: detail.lead,
        attempts: detail.attempts,
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

    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "SERVER_ERROR",
          message: "리드 상세 정보를 불러오는 중 오류가 발생했습니다.",
        },
        requestId,
      },
      { status: 500 }
    );
  }
}

