import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  AuthGuardError,
  isSupabaseAuthConfigured,
  requireRole,
  isE2eMockSessionAllowed,
} from "@/lib/auth";
import {
  createServerClientInstance,
  createAdminClient,
  isServiceRoleConfigured,
} from "@/lib/supabase/server";
import { getPmfReport, pmfQuerySchema } from "@/lib/analytics";

function extractCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function getSafeDbClient() {
  if (isServiceRoleConfigured()) {
    return createAdminClient();
  }
  try {
    return await createServerClientInstance();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("cookies") || msg.includes("request scope")) {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://example.supabase.co";
      const key =
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
        "dummy-key";
      return createClient(url, key);
    }
    throw err;
  }
}

export async function GET(request: Request) {
  const requestId = crypto.randomUUID();

  // 1. Check for E2E mock bypass in non-production environments
  const cookieHeader = request.headers.get("cookie") || "";
  const isMockAdmin = isE2eMockSessionAllowed(extractCookie(cookieHeader, "e2e_mock_admin"));
  const isMockCustomer = isE2eMockSessionAllowed(extractCookie(cookieHeader, "e2e_mock_customer"));

  if (!isSupabaseAuthConfigured() && !isMockAdmin && !isMockCustomer) {
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

  // 2. Authentication & Admin Authorization
  if (isMockCustomer) {
    return NextResponse.json(
      {
        ok: false,
        success: false,
        error: {
          code: "FORBIDDEN",
          message: "관리자(admin) 권한이 없습니다.",
        },
        requestId,
      },
      { status: 403 }
    );
  }

  let dbClient: any;
  if (isMockAdmin) {
    dbClient = await getSafeDbClient();
  } else {
    try {
      const supabase = await getSafeDbClient();
      await requireRole("admin", supabase);
      dbClient = dbClient || supabase;
    } catch (err) {
      if (err instanceof AuthGuardError) {
        return NextResponse.json(
          {
            ok: false,
            success: false,
            error: {
              code: err.code,
              message: err.userMessage,
            },
            requestId,
          },
          { status: err.status }
        );
      }
      return NextResponse.json(
        {
          ok: false,
          success: false,
          error: {
            code: "UNAUTHORIZED",
            message: "관리자 로그인이 필요한 엔드포인트입니다.",
          },
          requestId,
        },
        { status: 401 }
      );
    }
  }

  // 3. Query Parameters Validation
  const { searchParams } = new URL(request.url);
  const parseResult = pmfQuerySchema.safeParse({
    experimentKey: searchParams.get("experimentKey") ?? undefined,
    startsAt: searchParams.get("startsAt") ?? undefined,
    endsAt: searchParams.get("endsAt") ?? undefined,
    includeTest: searchParams.get("includeTest") ?? undefined,
    authFilter: searchParams.get("authFilter") ?? undefined,
  });

  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    return NextResponse.json(
      {
        ok: false,
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: firstIssue?.message || "유효하지 않은 조회 파라미터입니다.",
        },
        requestId,
      },
      { status: 400 }
    );
  }

  // 4. Generate Report using server DB client
  try {
    const report = await getPmfReport(dbClient, parseResult.data);

    return NextResponse.json(
      {
        ok: true,
        success: true,
        data: report,
        requestId,
      },
      { status: 200 }
    );
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "PMF 지표 리포트 생성 중 오류가 발생했습니다.";

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
