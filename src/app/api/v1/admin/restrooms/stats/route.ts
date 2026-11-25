import { NextResponse } from "next/server";
import {
  AuthGuardError,
  isSupabaseAuthConfigured,
  requireRole,
} from "@/lib/auth";
import { createServerClientInstance } from "@/lib/supabase/server";
import { AdminRestroomError, getAdminRestroomStats } from "@/lib/restrooms";

export async function GET() {
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

    const stats = await getAdminRestroomStats(supabase);
    return NextResponse.json({ ok: true, data: stats, requestId }, { status: 200 });
  } catch (err: unknown) {
    if (err instanceof AuthGuardError) {
      return NextResponse.json(
        {
          ok: false,
          error: { code: err.code, message: err.userMessage },
          requestId,
        },
        { status: err.status }
      );
    }
    if (err instanceof AdminRestroomError) {
      return NextResponse.json(
        {
          ok: false,
          error: { code: err.code, message: err.message },
          requestId,
        },
        { status: err.statusCode }
      );
    }
    const message =
      err instanceof Error ? err.message : "화장실 통계 조회 중 오류가 발생했습니다.";
    return NextResponse.json(
      {
        ok: false,
        error: { code: "INTERNAL_ERROR", message },
        requestId,
      },
      { status: 500 }
    );
  }
}
