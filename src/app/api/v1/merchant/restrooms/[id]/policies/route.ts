import { NextResponse } from "next/server";
import {
  AuthGuardError,
  checkIdempotencyKey,
  recordIdempotencyResponse,
  isSupabaseAuthConfigured,
  requireAuth,
} from "@/lib/auth";
import { createServerClientInstance } from "@/lib/supabase/server";
import {
  createMerchantPolicySchema,
  createMerchantRestroomPolicy,
  MerchantRestroomError,
} from "@/lib/restrooms";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteParams) {
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
      { status: 503 }
    );
  }

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!id || !uuidRegex.test(id)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "유효한 화장실 UUID가 아닙니다.",
        },
        requestId,
      },
      { status: 400 }
    );
  }

  try {
    const supabase = await createServerClientInstance();
    const session = await requireAuth(supabase);

    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "요청 본문이 올바른 JSON 형식이 아닙니다.",
          },
          requestId,
        },
        { status: 400 }
      );
    }

    const idempotencyHeader = request.headers.get("x-idempotency-key");
    const idempotencyScope = `merchant-restrooms-policy:${session.user.id}:${id}`;
    const idempotency = checkIdempotencyKey(
      idempotencyHeader,
      idempotencyScope,
      body
    );

    if (idempotency.action === "replay" && idempotency.cachedResponse) {
      return NextResponse.json(idempotency.cachedResponse.body, {
        status: idempotency.cachedResponse.status,
      });
    }

    if (idempotency.isDuplicate) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "DUPLICATE_REQUEST",
            message: "동일한 Idempotency-Key로 다른 요청 본문이 전송되었거나 이미 처리 중입니다.",
          },
          requestId,
        },
        { status: 409 }
      );
    }

    const parsed = createMerchantPolicySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: parsed.error.issues[0]?.message || "입력값이 올바르지 않습니다.",
            issues: parsed.error.issues,
          },
          requestId,
        },
        { status: 400 }
      );
    }

    const policy = await createMerchantRestroomPolicy(supabase, session.user.id, id, parsed.data);

    const responsePayload = {
      ok: true,
      data: policy,
      requestId,
    };

    recordIdempotencyResponse(
      idempotencyHeader,
      idempotencyScope,
      201,
      responsePayload
    );

    return NextResponse.json(responsePayload, { status: 201 });
  } catch (err: any) {
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
        { status: typeof err.status === "number" ? err.status : 401 }
      );
    }

    if (err instanceof MerchantRestroomError) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: err.code,
            message: err.message,
          },
          requestId,
        },
        { status: err.statusCode }
      );
    }

    console.error(`[POST /api/v1/merchant/restrooms/[id]/policies] ${requestId}`, err);
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "정책 버전 생성 처리 중 오류가 발생했습니다.",
        },
        requestId,
      },
      { status: 500 }
    );
  }
}
