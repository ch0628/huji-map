import { NextResponse } from "next/server";
import {
  AuthGuardError,
  checkIdempotencyKey,
  recordIdempotencyResponse,
  isSupabaseAuthConfigured,
  requireRole,
} from "@/lib/auth";
import { createServerClientInstance } from "@/lib/supabase/server";
import {
  adminRestroomDecisionSchema,
  decideRestroomReview,
  AdminRestroomError,
} from "@/lib/restrooms";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteParams) {
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
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!id || !uuidRegex.test(id)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "유효한 화장실 식별자(UUID)가 아닙니다.",
        },
        requestId,
      },
      { status: 400 }
    );
  }

  try {
    const supabase = await createServerClientInstance();
    const session = await requireRole("admin", supabase);

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
    const idempotencyScope = `admin-restroom-decision:${session.user.id}:${id}`;
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

    const parsed = adminRestroomDecisionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: parsed.error.issues[0]?.message || "심사 결정 입력값이 올바르지 않습니다.",
            issues: parsed.error.issues,
          },
          requestId,
        },
        { status: 400 }
      );
    }

    const updated = await decideRestroomReview(
      supabase,
      session.user.id,
      id,
      parsed.data
    );

    const responsePayload = {
      ok: true,
      data: updated,
      requestId,
    };

    recordIdempotencyResponse(
      idempotencyHeader,
      idempotencyScope,
      200,
      responsePayload
    );

    return NextResponse.json(responsePayload, { status: 200 });
  } catch (err: unknown) {
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

    if (err instanceof AdminRestroomError) {
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

    console.error(`[POST /api/v1/admin/restrooms/[id]/decision] ${requestId}`, err);
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "화장실 심사 결정 처리 중 오류가 발생했습니다.",
        },
        requestId,
      },
      { status: 500 }
    );
  }
}

