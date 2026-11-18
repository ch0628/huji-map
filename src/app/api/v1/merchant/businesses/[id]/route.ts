import { NextResponse } from "next/server";
import {
  AuthGuardError,
  checkIdempotencyKey,
  isSupabaseAuthConfigured,
  requireAuth,
} from "@/lib/auth";
import { createServerClientInstance } from "@/lib/supabase/server";
import {
  getBusinessDetailForMerchant,
  updateBusinessForMerchant,
  updateBusinessSchema,
} from "@/lib/businesses";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, context: RouteContext) {
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

    const business = await getBusinessDetailForMerchant(
      supabase,
      id,
      session.user.id,
      session.isAdmin
    );

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
          message: "가게 정보를 불러오는 중 오류가 발생했습니다.",
        },
        requestId,
      },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request, context: RouteContext) {
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
      `merchant_patch_biz_${id}_${session.user.id}`
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

    const parsed = updateBusinessSchema.safeParse(bodyJson);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: firstIssue?.message ?? "수정할 입력값 검증에 실패했습니다.",
          },
          requestId,
        },
        { status: 400 }
      );
    }

    const updated = await updateBusinessForMerchant(
      supabase,
      id,
      session.user.id,
      session.isAdmin,
      parsed.data
    );

    return NextResponse.json(
      {
        ok: true,
        business: updated,
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
          message: "가게 정보를 수정하는 중 오류가 발생했습니다.",
        },
        requestId,
      },
      { status: 500 }
    );
  }
}
