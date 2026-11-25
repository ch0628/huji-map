import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  AuthGuardError,
  checkIdempotencyKey,
  isE2eMockSessionAllowed,
  isSupabaseAuthConfigured,
  recordIdempotencyResponse,
  redactAuthSensitiveText,
  requireRole,
} from "@/lib/auth";
import {
  createAdminClient,
  createServerClientInstance,
  isServiceRoleConfigured,
} from "@/lib/supabase/server";
import {
  AnalyticsExclusionError,
  candidateSearchQuerySchema,
  getExcludedAccountsOverview,
  registerExcludedAccounts,
} from "@/lib/analytics/exclusions";

const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" };

function extractCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function getAuthSupabaseClient() {
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

async function authorizeAdminRequest(request: Request): Promise<
  | { ok: true; actorUserId: string | null; isMockAdmin: boolean }
  | { ok: false; response: NextResponse }
> {
  const requestId = crypto.randomUUID();
  const cookieHeader = request.headers.get("cookie") || "";
  const isMockAdmin = isE2eMockSessionAllowed(extractCookie(cookieHeader, "e2e_mock_admin"));
  const isMockCustomer = isE2eMockSessionAllowed(
    extractCookie(cookieHeader, "e2e_mock_customer")
  );

  if (!isSupabaseAuthConfigured() && !isMockAdmin && !isMockCustomer) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          ok: false,
          error: {
            code: "CONFIG_REQUIRED",
            message: "인증 및 데이터베이스 연결 설정이 필요합니다.",
          },
          requestId,
        },
        { status: 503, headers: PRIVATE_NO_STORE }
      ),
    };
  }

  if (isMockCustomer) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          ok: false,
          error: {
            code: "FORBIDDEN",
            message: "관리자(admin) 권한이 없습니다.",
          },
          requestId,
        },
        { status: 403, headers: PRIVATE_NO_STORE }
      ),
    };
  }

  if (isMockAdmin) {
    return { ok: true, actorUserId: null, isMockAdmin: true };
  }

  try {
    const authSupabase = await getAuthSupabaseClient();
    const session = await requireRole("admin", authSupabase);
    return { ok: true, actorUserId: session.user.id, isMockAdmin: false };
  } catch (err) {
    if (err instanceof AuthGuardError) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            ok: false,
            error: {
              code: err.code,
              message: err.userMessage,
            },
            requestId,
          },
          { status: err.status, headers: PRIVATE_NO_STORE }
        ),
      };
    }

    return {
      ok: false,
      response: NextResponse.json(
        {
          ok: false,
          error: {
            code: "UNAUTHORIZED",
            message: "관리자 로그인이 필요한 엔드포인트입니다.",
          },
          requestId,
        },
        { status: 401, headers: PRIVATE_NO_STORE }
      ),
    };
  }
}

export async function GET(request: Request) {
  const requestId = crypto.randomUUID();
  const auth = await authorizeAdminRequest(request);
  if (!auth.ok) return auth.response;

  if (!isServiceRoleConfigured()) {
    if (auth.isMockAdmin) {
      return NextResponse.json(
        {
          ok: true,
          data: {
            activeCount: 0,
            excludedAccounts: [],
            candidates: [],
          },
          requestId,
        },
        { status: 200, headers: PRIVATE_NO_STORE }
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "CONFIG_REQUIRED",
          message: "서버 권한 키(SUPABASE_SECRET_KEY) 설정이 필요합니다.",
        },
        requestId,
      },
      { status: 503, headers: PRIVATE_NO_STORE }
    );
  }

  const { searchParams } = new URL(request.url);
  const parsedQuery = candidateSearchQuerySchema.safeParse({
    q: searchParams.get("q") ?? undefined,
    limit: searchParams.get("limit") ?? undefined,
  });

  if (!parsedQuery.success) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: parsedQuery.error.issues[0]?.message || "유효하지 않은 검색 조건입니다.",
        },
        requestId,
      },
      { status: 400, headers: PRIVATE_NO_STORE }
    );
  }

  try {
    const adminClient = createAdminClient();
    const overview = await getExcludedAccountsOverview(adminClient, parsedQuery.data);
    return NextResponse.json(
      {
        ok: true,
        data: overview,
        requestId,
      },
      { status: 200, headers: PRIVATE_NO_STORE }
    );
  } catch (err) {
    if (err instanceof AnalyticsExclusionError) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: err.code,
            message: err.message,
          },
          requestId,
        },
        { status: err.statusCode, headers: PRIVATE_NO_STORE }
      );
    }

    const safeMessage = redactAuthSensitiveText(
      err instanceof Error ? err.message : "통계 제외 설정 조회 중 오류가 발생했습니다."
    );
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: safeMessage || "통계 제외 설정 조회 중 오류가 발생했습니다.",
        },
        requestId,
      },
      { status: 500, headers: PRIVATE_NO_STORE }
    );
  }
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  const auth = await authorizeAdminRequest(request);
  if (!auth.ok) return auth.response;

  if (!isServiceRoleConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "CONFIG_REQUIRED",
          message: "서버 권한 키(SUPABASE_SECRET_KEY) 설정이 필요합니다.",
        },
        requestId,
      },
      { status: 503, headers: PRIVATE_NO_STORE }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INVALID_JSON",
          message: "유효한 JSON 요청 본문이 필요합니다.",
        },
        requestId,
      },
      { status: 400, headers: PRIVATE_NO_STORE }
    );
  }

  const idempotencyKey = request.headers.get("x-idempotency-key");
  const idem = checkIdempotencyKey(idempotencyKey, "admin:analytics:exclusions:post", body);
  if (idem.isDuplicate) {
    if (idem.action === "replay" && idem.cachedResponse) {
      return NextResponse.json(idem.cachedResponse.body, {
        status: idem.cachedResponse.status,
        headers: PRIVATE_NO_STORE,
      });
    }
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "DUPLICATE_REQUEST",
          message: "동일한 요청이 이미 처리 중이거나 다른 내용으로 중복 전송되었습니다.",
        },
        requestId,
      },
      { status: 409, headers: PRIVATE_NO_STORE }
    );
  }

  try {
    const adminClient = createAdminClient();
    const result = await registerExcludedAccounts(adminClient, body, auth.actorUserId);
    const responseBody = {
      ok: true,
      data: result,
      requestId,
    };
    recordIdempotencyResponse(
      idempotencyKey,
      "admin:analytics:exclusions:post",
      200,
      responseBody
    );

    return NextResponse.json(responseBody, { status: 200, headers: PRIVATE_NO_STORE });
  } catch (err) {
    if (err instanceof AnalyticsExclusionError) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: err.code,
            message: err.message,
          },
          requestId,
        },
        { status: err.statusCode, headers: PRIVATE_NO_STORE }
      );
    }

    const safeMessage = redactAuthSensitiveText(
      err instanceof Error ? err.message : "통계 제외 계정 저장 중 오류가 발생했습니다."
    );
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: safeMessage || "통계 제외 계정 저장 중 오류가 발생했습니다.",
        },
        requestId,
      },
      { status: 500, headers: PRIVATE_NO_STORE }
    );
  }
}
