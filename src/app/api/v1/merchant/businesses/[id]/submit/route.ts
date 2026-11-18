import { NextResponse } from "next/server";
import {
  AuthGuardError,
  checkIdempotencyKey,
  isSupabaseAuthConfigured,
  requireAuth,
} from "@/lib/auth";
import { createServerClientInstance } from "@/lib/supabase/server";
import { submitBusinessForMerchant } from "@/lib/businesses";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request, context: RouteContext) {
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

  const { id } = await context.params;
  if (!UUID_REGEX.test(id)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "유효한 가게 식별자(UUID)가 아닙니다.",
        },
        requestId,
      },
      { status: 400 }
    );
  }

  try {
    const supabase = await createServerClientInstance();
    const session = await requireAuth(supabase);

    const idempotencyKey =
      request.headers.get("x-idempotency-key") ??
      request.headers.get("idempotency-key");
    const idempotency = checkIdempotencyKey(
      idempotencyKey,
      `merchant_submit_biz_${id}_${session.user.id}`
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

    const business = await submitBusinessForMerchant(supabase, id);

    return NextResponse.json(
      {
        ok: true,
        business,
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
          message: "가게 심사 요청 중 오류가 발생했습니다.",
        },
        requestId,
      },
      { status: 500 }
    );
  }
}
