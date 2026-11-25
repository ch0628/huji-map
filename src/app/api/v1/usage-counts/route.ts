import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { isSupabaseAuthConfigured } from "@/lib/auth";
import { checkRateLimit } from "@/lib/events/rate-limiter";
import {
  createAdminClient,
  createServerClientInstance,
  isServiceRoleConfigured,
} from "@/lib/supabase/server";
import { recordDailyUsageCount, UsageCountError } from "@/lib/usage-counts";

// Ephemeral per-process salt so transient rate-limit keys in RAM never hold raw IP strings
const EPHEMERAL_RATE_SALT = crypto.randomBytes(16).toString("hex");

function getTransientRateLimitKey(request: Request): string {
  const rawIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "anonymous";
  return `usage:${crypto
    .createHmac("sha256", EPHEMERAL_RATE_SALT)
    .update(rawIp)
    .digest("hex")
    .slice(0, 24)}`;
}

function hasSupabaseAuthCookie(request: Request): boolean {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return false;
  return /(?:^|;\s*)sb-[^=;\s]+=[^;\s]+/.test(cookieHeader);
}

/**
 * POST /api/v1/usage-counts
 * Records a non-identifying daily execution count without requiring user consent or new cookies.
 * When a Supabase auth cookie (`sb-*`) is present, verifies `auth.getUser()` on the server and
 * skips counting for active accounts in `analytics_excluded_accounts`, without persisting user_id.
 */
export async function POST(request: Request) {
  const requestId = crypto.randomUUID();

  if (!isSupabaseAuthConfigured() || !isServiceRoleConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "CONFIG_REQUIRED",
          message: "기본 이용 통계 집계 설정이 필요합니다.",
        },
        requestId,
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
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
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  const rate = checkRateLimit(getTransientRateLimitKey(request), 120, 60_000);
  if (!rate.allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "RATE_LIMIT_EXCEEDED",
          message: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
        },
        requestId,
      },
      { status: 429, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    const hasAuthCookie = hasSupabaseAuthCookie(request);
    let authClient = null;
    if (hasAuthCookie) {
      try {
        authClient = await createServerClientInstance();
      } catch {
        authClient = null;
      }
    }

    const adminClient = createAdminClient();
    const result = await recordDailyUsageCount(adminClient, body, {
      authClient,
      hasAuthCookie,
    });

    return NextResponse.json(
      {
        ok: true,
        data: result,
        requestId,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    if (err instanceof UsageCountError) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: err.code,
            message: err.message,
          },
          requestId,
        },
        { status: err.statusCode, headers: { "Cache-Control": "no-store" } }
      );
    }

    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "기본 이용 통계 처리 중 오류가 발생했습니다.",
        },
        requestId,
      },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
