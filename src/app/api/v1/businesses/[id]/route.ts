import { NextResponse } from "next/server";
import { isSupabaseAuthConfigured } from "@/lib/auth";
import { createServerClientInstance } from "@/lib/supabase/server";
import { getPublicBusinessDetail } from "@/lib/restrooms";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, context: RouteContext) {
  const requestId = crypto.randomUUID();

  if (!isSupabaseAuthConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "CONFIG_REQUIRED",
          message: "데이터베이스 연결 설정이 필요합니다.",
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
          message: "유효한 가게 식별자(UUID)가 아닙니다.",
        },
        requestId,
      },
      { status: 400 }
    );
  }

  try {
    const supabase = await createServerClientInstance();
    const business = await getPublicBusinessDetail(supabase, id);

    if (!business) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "BUSINESS_NOT_FOUND",
            message: "존재하지 않거나 승인되지 않은 가게입니다.",
          },
          requestId,
        },
        { status: 404 }
      );
    }

    return NextResponse.json(
      {
        ok: true,
        data: business,
        requestId,
      },
      { status: 200 }
    );
  } catch (error: any) {
    console.error(`[GET /api/v1/businesses/${id}] ${requestId}`, error);
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "가게 정보를 조회하는 중 서버 오류가 발생했습니다.",
        },
        requestId,
      },
      { status: 500 }
    );
  }
}

