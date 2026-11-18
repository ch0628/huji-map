import { NextResponse } from "next/server";
import { createServerClientInstance } from "@/lib/supabase/server";
import {
  checkIdempotencyKey,
  isSupabaseAuthConfigured,
  recordQaAuthEvent,
} from "@/lib/auth";

export async function POST(request: Request) {
  if (!isSupabaseAuthConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "CONFIG_REQUIRED",
          message: "인증 서비스 설정이 필요합니다.",
        },
      },
      { status: 503 }
    );
  }

  const idempotencyKey = request.headers.get("x-idempotency-key");
  const { isDuplicate } = checkIdempotencyKey(idempotencyKey, "auth:logout");
  if (isDuplicate) {
    return NextResponse.json(
      {
        ok: true,
        redirectTo: "/map",
      },
      { status: 200 }
    );
  }

  try {
    const supabase = await createServerClientInstance();
    await supabase.auth.signOut();

    recordQaAuthEvent({ type: "logout_success" });

    return NextResponse.json(
      {
        ok: true,
        redirectTo: "/map",
      },
      { status: 200 }
    );
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "LOGOUT_FAILED",
          message: "로그아웃 처리 중 오류가 발생했습니다.",
        },
      },
      { status: 500 }
    );
  }
}
