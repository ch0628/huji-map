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

    const dbClient = isServiceRoleConfigured() ? createAdminClient() : supabase;
    const result = await ingestClientEvent(dbClient, body, authUserId, clientIp);

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

