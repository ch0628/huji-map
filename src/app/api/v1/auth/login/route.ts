import { NextResponse } from "next/server";
import { createServerClientInstance } from "@/lib/supabase/server";
import {
  checkIdempotencyKey,
  getDefaultRouteForRoles,
  isSupabaseAuthConfigured,
  loginSchema,
  recordQaAuthEvent,
  sanitizeReturnTo,
} from "@/lib/auth";
import { getUserRoles } from "@/lib/supabase/auth";

function mapSupabaseLoginError(error: { message?: string; code?: string }): {
  status: number;
  code: string;
  message: string;
} {
  const rawMessage = (error.message || "").toLowerCase();
  const rawCode = (error.code || "").toLowerCase();

  if (
    rawCode === "invalid_credentials" ||
    rawMessage.includes("invalid login credentials")
  ) {
    return {
      status: 401,
      code: "INVALID_CREDENTIALS",
      message: "이메일 또는 비밀번호가 올바르지 않습니다.",
    };
  }

  if (
    rawCode === "email_not_confirmed" ||
    rawMessage.includes("email not confirmed")
  ) {
    return {
      status: 403,
      code: "EMAIL_NOT_CONFIRMED",
      message: "이메일 인증이 완료되지 않았습니다. 수신함을 확인해 주세요.",
    };
  }

  if (
    rawCode === "over_request_rate_limit" ||
    rawMessage.includes("rate limit")
  ) {
    return {
      status: 429,
      code: "RATE_LIMITED",
      message: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
    };
  }

  return {
    status: 400,
    code: "AUTH_FAILED",
    message: "로그인을 처리할 수 없습니다. 입력 정보를 확인 후 다시 시도해 주세요.",
  };
}

export async function POST(request: Request) {
  if (!isSupabaseAuthConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "CONFIG_REQUIRED",
          message: "인증 서비스 설정이 필요합니다. 환경변수를 확인해 주세요.",
        },
      },
      { status: 503 }
    );
  }

  const idempotencyKey = request.headers.get("x-idempotency-key");
  const { isDuplicate } = checkIdempotencyKey(idempotencyKey, "auth:login");
  if (isDuplicate) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "DUPLICATE_REQUEST",
          message: "이미 처리 중인 로그인 요청입니다. 잠시만 기다려 주세요.",
        },
      },
      { status: 409 }
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
          message: "요청 형식이 올바르지 않습니다.",
        },
      },
      { status: 400 }
    );
  }

  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          field: firstIssue?.path?.[0] ?? "email",
          message: firstIssue?.message ?? "입력값을 확인해 주세요.",
        },
      },
      { status: 400 }
    );
  }

  try {
    const supabase = await createServerClientInstance();
    const { data, error } = await supabase.auth.signInWithPassword({
      email: parsed.data.email,
      password: parsed.data.password,
    });

    if (error || !data.user) {
      const mapped = mapSupabaseLoginError(error ?? {});
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: mapped.code,
            message: mapped.message,
          },
        },
        { status: mapped.status }
      );
    }

    const roles = await getUserRoles(supabase, data.user.id);
    const effectiveRoles = roles.length > 0 ? roles : (["customer"] as const);
    const hasExplicitReturnTo =
      typeof parsed.data.returnTo === "string" &&
      parsed.data.returnTo.trim().length > 0;
    const redirectTo = hasExplicitReturnTo
      ? sanitizeReturnTo(parsed.data.returnTo)
      : getDefaultRouteForRoles(effectiveRoles);

    recordQaAuthEvent({
      type: "login_success",
      userId: data.user.id,
      roles: [...effectiveRoles],
    });

    return NextResponse.json(
      {
        ok: true,
        redirectTo,
        user: {
          id: data.user.id,
          displayName:
            typeof data.user.user_metadata?.display_name === "string"
              ? data.user.user_metadata.display_name
              : null,
          roles: effectiveRoles,
        },
      },
      { status: 200 }
    );
  } catch {
    // AGENTS.md Rule 8 & 13: Never log or expose credentials, emails, or stack traces
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "SERVER_ERROR",
          message: "일시적인 인증 서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
        },
      },
      { status: 500 }
    );
  }
}
