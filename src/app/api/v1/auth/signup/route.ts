import { NextResponse } from "next/server";
import { createServerClientInstance } from "@/lib/supabase/server";
import {
  checkIdempotencyKey,
  getQaAuthVerificationSummary,
  isSupabaseAuthConfigured,
  recordQaAuthEvent,
  sanitizeReturnTo,
  signupSchema,
} from "@/lib/auth";

function mapSupabaseSignupError(error: { message?: string; code?: string }): {
  status: number;
  code: string;
  message: string;
} {
  const rawMessage = (error.message || "").toLowerCase();
  const rawCode = (error.code || "").toLowerCase();

  if (
    rawCode === "user_already_exists" ||
    rawCode === "email_exists" ||
    rawMessage.includes("already registered") ||
    rawMessage.includes("already exists")
  ) {
    return {
      status: 409,
      code: "EMAIL_ALREADY_EXISTS",
      message: "이미 가입된 이메일 주소입니다. 로그인해 주세요.",
    };
  }

  if (
    rawCode === "weak_password" ||
    rawMessage.includes("password should be")
  ) {
    return {
      status: 400,
      code: "WEAK_PASSWORD",
      message: "비밀번호가 보안 기준에 미달합니다. 8자 이상으로 설정해 주세요.",
    };
  }

  if (
    rawCode === "over_request_rate_limit" ||
    rawCode === "over_email_send_rate_limit" ||
    rawMessage.includes("rate limit")
  ) {
    return {
      status: 429,
      code: "RATE_LIMITED",
      message: "가입 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
    };
  }

  return {
    status: 400,
    code: "SIGNUP_FAILED",
    message: "회원가입을 처리할 수 없습니다. 입력한 이메일과 비밀번호를 확인해 주세요.",
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

  // Enforce single QA test account creation cap when in QA session
  if (getQaAuthVerificationSummary().signupSucceededCount >= 1) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "QA_SIGNUP_LIMIT_REACHED",
          message:
            "QA 테스트 계정이 이미 1건 생성되었습니다. 추가 계정을 생성하지 않고 로그인 화면에서 로그인해 주세요.",
        },
      },
      { status: 429 }
    );
  }

  const idempotencyKey = request.headers.get("x-idempotency-key");
  const { isDuplicate } = checkIdempotencyKey(idempotencyKey, "auth:signup");
  if (isDuplicate) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "DUPLICATE_REQUEST",
          message: "이미 처리 중인 회원가입 요청입니다. 잠시만 기다려 주세요.",
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

  const parsed = signupSchema.safeParse(body);
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
    const displayName =
      parsed.data.displayName && parsed.data.displayName.length > 0
        ? parsed.data.displayName
        : null;

    const origin = new URL(request.url).origin;

    const { data, error } = await supabase.auth.signUp({
      email: parsed.data.email,
      password: parsed.data.password,
      options: {
        emailRedirectTo: `${origin}/login`,
        data: {
          display_name: displayName,
          preferred_language: "ko",
        },
      },
    });

    if (error || !data.user) {
      const mapped = mapSupabaseSignupError(error ?? {});
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

    const requiresEmailVerification = !data.session;
    const redirectTo = parsed.data.returnTo
      ? sanitizeReturnTo(parsed.data.returnTo)
      : "/login";

    recordQaAuthEvent({
      type: "signup_success",
      userId: data.user.id,
      requiresEmailVerification,
    });

    return NextResponse.json(
      {
        ok: true,
        requiresEmailVerification,
        redirectTo,
        user: {
          id: data.user.id,
          displayName,
          roles: ["customer"],
        },
      },
      { status: 201 }
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
