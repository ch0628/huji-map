import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { AuthGuardError, requireAuth, isSupabaseAuthConfigured } from "@/lib/auth";
import { createServerClientInstance } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/events/rate-limiter";
import {
  revealCustomerPin,
  AccessPinServiceError,
} from "@/lib/access";

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

  // 1. Supabase Auth configuration check
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
      {
        status: 503,
        headers: NO_STORE_HEADERS,
      }
    );
  }

  // 2. Access session UUID format check
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!id || !uuidRegex.test(id)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "유효한 이용권 UUID가 아닙니다.",
        },
        requestId,
      },
      {
        status: 400,
        headers: NO_STORE_HEADERS,
      }
    );
  }

  // 3. Authenticate customer using server getUser()
  let authSession;
  try {
    const supabase = await createServerClientInstance();
    authSession = await requireAuth(supabase);
  } catch (authErr) {
    if (authErr instanceof AuthGuardError) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: authErr.code,
            message: authErr.userMessage,
          },
          requestId,
        },
        {
          status: authErr.status,
          headers: NO_STORE_HEADERS,
        }
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
      {
        status: 401,
        headers: NO_STORE_HEADERS,
      }
    );
  }

  const userId = authSession.user.id;

  // 4. Rate limiting: max 10 reveal requests per minute per user
  const rateLimit = checkRateLimit(`pin_reveal:${userId}`, 10, 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "TOO_MANY_REQUESTS",
          message: "PIN 조회 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
        },
        requestId,
      },
      {
        status: 429,
        headers: {
          ...NO_STORE_HEADERS,
          "Retry-After": Math.ceil(rateLimit.resetMs / 1000).toString(),
        },
      }
    );
  }

  // 5. Execute secure PIN reveal
  try {
    const result = await revealCustomerPin({
      accessSessionId: id,
      userId,
      requestId,
    });

    return NextResponse.json(
      {
        ok: true,
        pin: result.pin,
        codeVersion: result.codeVersion,
        expiresAt: result.expiresAt,
        requestId,
      },
      {
        status: 200,
        headers: NO_STORE_HEADERS,
      }
    );
  } catch (err: unknown) {
    if (err instanceof AccessPinServiceError) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: err.code,
            message: err.message,
          },
          requestId,
        },
        {
          status: err.statusCode,
          headers: NO_STORE_HEADERS,
        }
      );
    }

    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "도어락 PIN 조회 처리 중 오류가 발생했습니다.",
        },
        requestId,
      },
      {
        status: 500,
        headers: NO_STORE_HEADERS,
      }
    );
  }
}

