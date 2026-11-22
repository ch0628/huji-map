import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { AuthGuardError, isSupabaseAuthConfigured, requireAuth } from "@/lib/auth";
import { createServerClientInstance } from "@/lib/supabase/server";
import {
  CustomerReceiptError,
  listCustomerReceiptsAndEligibleSessions,
} from "@/components/receipt/receipt-server";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
};

export async function GET(request: Request) {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);
  const accessSessionId = url.searchParams.get("accessSessionId");

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
    const data = await listCustomerReceiptsAndEligibleSessions({
      userId: authSession.user.id,
      accessSessionId,
    });

    return NextResponse.json(
      {
        ok: true,
        data,
        requestId,
      },
      { status: 200, headers: NO_STORE_HEADERS }
    );
  } catch (err) {
    if (err instanceof CustomerReceiptError) {
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
          message: "영수증 목록을 불러오는 중 오류가 발생했습니다.",
        },
        requestId,
      },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}

