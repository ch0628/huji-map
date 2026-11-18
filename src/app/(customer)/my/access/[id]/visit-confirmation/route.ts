import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { AuthGuardError, isSupabaseAuthConfigured, requireAuth } from "@/lib/auth";
import { createServerClientInstance } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/events/rate-limiter";
import {
  CustomerAccessError,
  submitCustomerVisitConfirmation,
} from "@/components/access/access-server";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
};

export async function POST(request: Request, context: RouteParams) {
  const requestId = crypto.randomUUID();
  const { id } = await context.params;

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
      { status: 503, headers: NO_STORE_HEADERS }
    );
  }

  let authSession;
  try {
    const supabase = await createServerClientInstance();
    authSession = await requireAuth(supabase);
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
        { status: err.status, headers: NO_STORE_HEADERS }
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "UNAUTHORIZED",
          message: "로그인이 필요한 서비스입니다.",
        },
        requestId,
      },
      { status: 401, headers: NO_STORE_HEADERS }
    );
  }

  const userId = authSession.user.id;

  // Rate limit: max 15 visit confirmation submissions per minute per user
  const rate = checkRateLimit(`visit_confirm:${userId}`, 15, 60_000);
  if (!rate.allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "TOO_MANY_REQUESTS",
          message: "방문 확인 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
        },
        requestId,
      },
      {
        status: 429,
        headers: {
          ...NO_STORE_HEADERS,
          "Retry-After": Math.ceil(rate.resetMs / 1000).toString(),
        },
      }
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "유효한 JSON 요청 본문이 필요합니다.",
        },
        requestId,
      },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  try {
    const result = await submitCustomerVisitConfirmation({
      userId,
      accessSessionId: id,
      rawInput: rawBody,
    });

    return NextResponse.json(
      {
        ok: true,
        data: result,
        requestId,
      },
      {
        status: result.reused ? 200 : 201,
        headers: NO_STORE_HEADERS,
      }
    );
  } catch (err) {
    if (err instanceof CustomerAccessError) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: err.code,
            message: err.message,
          },
          requestId,
        },
        { status: err.statusCode, headers: NO_STORE_HEADERS }
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "방문 확인 기록 처리 중 오류가 발생했습니다.",
        },
        requestId,
      },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}

