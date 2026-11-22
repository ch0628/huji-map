import { NextResponse } from "next/server";
import { isSupabaseAuthConfigured, getServerAuthSession } from "@/lib/auth";
import {
  createServerClientInstance,
  createAdminClient,
  isServiceRoleConfigured,
} from "@/lib/supabase/server";
import { ingestClientEvent, EventError } from "@/lib/events";

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();

  const analyticsEnabled =
    (process.env["NEXT_PUBLIC_ANALYTICS_ENABLED"] ??
      process.env.NEXT_PUBLIC_ANALYTICS_ENABLED) === "true";

  if (!analyticsEnabled) {
    return NextResponse.json(
      {
        ok: false,
        success: false,
        error: {
          code: "ANALYTICS_DISABLED",
          message: "현재 환경에서는 선택적 행동 분석 수집이 비활성화되어 있습니다.",
        },
        requestId,
      },
      { status: 403 }
    );
  }

  if (!isSupabaseAuthConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        success: false,
        error: {
          code: "CONFIG_REQUIRED",
          message: "데이터베이스 연결 설정이 필요합니다.",
        },
        requestId,
      },
      { status: 503 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        success: false,
        error: {
          code: "INVALID_JSON",
          message: "유효한 JSON 요청 본문이 필요합니다.",
        },
        requestId,
      },
      { status: 400 }
    );
  }

  try {
    const supabase = await createServerClientInstance();
    const authSession = await getServerAuthSession(supabase);
    const authUserId = authSession.user?.id ?? null;

    const clientIp =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      null;

    const cookieHeader = request.headers.get("cookie") || "";
    const sessionTokenMatch = cookieHeader.match(/(?:^|;\s*)hm_session_token=([^;]+)/);
    const requestSessionToken = sessionTokenMatch
      ? decodeURIComponent(sessionTokenMatch[1])
      : null;

    const dbClient = isServiceRoleConfigured() ? createAdminClient() : supabase;
    const result = await ingestClientEvent(dbClient, body, authUserId, clientIp, {
      requestSessionToken,
      enforceAnonymousSessionToken: true,
    });

    return NextResponse.json(
      {
        ok: true,
        success: true,
        data: result,
        requestId,
      },
      { status: 200 }
    );
  } catch (err) {
    if (err instanceof EventError) {
      return NextResponse.json(
        {
          ok: false,
          success: false,
          error: {
            code: err.code,
            message: err.message,
          },
          requestId,
        },
        { status: err.statusCode }
      );
    }

    const message = err instanceof Error ? err.message : "이벤트 처리 중 오류가 발생했습니다.";
    return NextResponse.json(
      {
        ok: false,
        success: false,
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

