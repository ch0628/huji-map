import { NextResponse } from "next/server";
import { isSupabaseAuthConfigured, getServerAuthSession } from "@/lib/auth";
import {
  createServerClientInstance,
  createAdminClient,
  isServiceRoleConfigured,
} from "@/lib/supabase/server";
import { recordTravelAnswer, EventError } from "@/lib/events";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function PATCH(request: Request, context: RouteContext) {
  const requestId = crypto.randomUUID();

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

  const { id } = await context.params;
  if (!id || !UUID_REGEX.test(id)) {
    return NextResponse.json(
      {
        ok: false,
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "유효한 세션 식별자(UUID)가 아닙니다.",
        },
        requestId,
      },
      { status: 400 }
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

    // Retrieve session token from cookie or header
    const cookieHeader = request.headers.get("cookie") || "";
    let cookieToken: string | null = null;
    const match = cookieHeader.match(/hm_session_token=([^;]+)/);
    if (match) {
      cookieToken = decodeURIComponent(match[1]);
    }
    const headerToken = request.headers.get("x-session-token");
    const sessionToken = headerToken || cookieToken || null;

    const dbClient = isServiceRoleConfigured() ? createAdminClient() : supabase;
    const result = await recordTravelAnswer(dbClient, id, body, authUserId, sessionToken);

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

    const message = err instanceof Error ? err.message : "여행 응답 처리 중 오류가 발생했습니다.";
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
