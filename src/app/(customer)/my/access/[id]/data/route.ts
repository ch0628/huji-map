import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { AuthGuardError, isSupabaseAuthConfigured, requireAuth } from "@/lib/auth";
import { createServerClientInstance } from "@/lib/supabase/server";
import {
  CustomerAccessError,
  getCustomerAccessSessionDetail,
} from "@/components/access/access-server";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
};

export async function GET(_request: Request, context: RouteParams) {
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

  try {
    const detail = await getCustomerAccessSessionDetail({
      userId: authSession.user.id,
      accessSessionId: id,
    });

    return NextResponse.json(
      {
        ok: true,
        data: { detail },
        requestId,
      },
      { status: 200, headers: NO_STORE_HEADERS }
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
          message: "이용권 상세 정보를 조회하는 중 오류가 발생했습니다.",
        },
        requestId,
      },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}

