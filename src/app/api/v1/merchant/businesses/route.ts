import { NextResponse } from "next/server";
import {
  AuthGuardError,
  checkIdempotencyKey,
  isSupabaseAuthConfigured,
  requireAuth,
} from "@/lib/auth";
import { createServerClientInstance } from "@/lib/supabase/server";
import {
  createBusinessForMerchant,
  createBusinessSchema,
  listBusinessesForMerchant,
} from "@/lib/businesses";

export async function GET(request: Request) {
  const requestId = crypto.randomUUID();

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
      { status: 503 }
    );
  }

  try {
    const supabase = await createServerClientInstance();
    const session = await requireAuth(supabase);

    const businesses = await listBusinessesForMerchant(
      supabase,
      session.user.id,
      session.isAdmin
    );

    return NextResponse.json(
      {
        ok: true,
        businesses,
        count: businesses.length,
        requestId,
      },
      { status: 200 }
    );
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
        { status: err.status }
      );
    }

    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "SERVER_ERROR",
          message: "가게 목록을 불러오는 중 오류가 발생했습니다.",
        },
        requestId,
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();

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
      { status: 503 }
    );
  }

  try {
    const supabase = await createServerClientInstance();
    const session = await requireAuth(supabase);

    let bodyJson: unknown;
    try {
      bodyJson = await request.json();
    } catch {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "INVALID_JSON",
            message: "요청 본문이 올바른 JSON 형식이 아닙니다.",
          },
          requestId,
        },
        { status: 400 }
      );
    }

    const idempotencyKey =
      request.headers.get("x-idempotency-key") ??
      request.headers.get("idempotency-key");
    const idempotency = checkIdempotencyKey(
      idempotencyKey,
      `merchant_create_biz_${session.user.id}`
    );
    if (idempotency.isDuplicate) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "CONFLICT",
            message: "이미 처리 중이거나 완료된 요청입니다. 잠시 후 다시 확인해 주세요.",
          },
          requestId,
        },
        { status: 409 }
      );
    }

    const parsed = createBusinessSchema.safeParse(bodyJson);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: firstIssue?.message ?? "입력값 검증에 실패했습니다.",
          },
          requestId,
        },
        { status: 400 }
      );
    }

    // Creator identity comes from the verified session inside the DB function (auth.uid()).
    // No merchant role is granted here; registration is an application, not an approval.
    const business = await createBusinessForMerchant(supabase, parsed.data);

    return NextResponse.json(
      {
        ok: true,
        business,
        requestId,
      },
      { status: 201 }
    );
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
        { status: err.status }
      );
    }

    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "SERVER_ERROR",
          message: "가게 등록 중 오류가 발생했습니다.",
        },
        requestId,
      },
      { status: 500 }
    );
  }
}
