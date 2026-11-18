import { NextResponse } from "next/server";
import { isSupabaseAuthConfigured } from "@/lib/auth";
import { createServerClientInstance } from "@/lib/supabase/server";
import {
  restroomSearchQuerySchema,
  searchPublicRestroomsByName,
} from "@/lib/restrooms";

export async function GET(request: Request) {
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

  const { searchParams } = new URL(request.url);
  const rawParams: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    rawParams[key] = value;
  });

  const parsed = restroomSearchQuerySchema.safeParse(rawParams);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: firstIssue?.message || "유효하지 않은 검색 파라미터입니다.",
          details: parsed.error.issues,
        },
        requestId,
      },
      { status: 400 }
    );
  }

  try {
    const supabase = await createServerClientInstance();
    const result = await searchPublicRestroomsByName(supabase, {
      q: parsed.data.q,
      type: parsed.data.type,
      limit: parsed.data.limit,
    });

    return NextResponse.json(
      {
        ok: true,
        data: result,
        requestId,
      },
      { status: 200 }
    );
  } catch (error: unknown) {
    console.error(`[GET /api/v1/restrooms/search] ${requestId}`, error);
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "화장실 이름 검색 중 서버 오류가 발생했습니다.",
        },
        requestId,
      },
      { status: 500 }
    );
  }
}
