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
  adminPhotoReplacementDecisionSchema,
  decideRestroomPhotoReplacement,
  AdminRestroomError,
} from "@/lib/restrooms";

interface RouteParams {
  params: Promise<{ id: string; photoId: string }>;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request, context: RouteParams) {
  const requestId = crypto.randomUUID();
  const { id, photoId } = await context.params;

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

  if (!id || !UUID_REGEX.test(id) || !photoId || !UUID_REGEX.test(photoId)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "유효한 화장실 또는 사진 UUID가 아닙니다.",
        },
        requestId,
      },
      { status: 400 }
    );
  }

  try {
    const supabase = await createServerClientInstance();
    const session = await requireRole("admin", supabase);

    let body: unknown;
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
    const idempotencyScope = `admin-restroom-photo-decision:${session.user.id}:${id}:${photoId}`;
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
            message:
              "동일한 Idempotency-Key로 다른 요청이 전송되었거나 이미 처리 중입니다.",
          },
          requestId,
        },
        { status: 409 }
      );
    }

    const parsed = adminPhotoReplacementDecisionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message:
              parsed.error.issues[0]?.message ||
              "사진 심사 결정 입력값이 올바르지 않습니다.",
            issues: parsed.error.issues,
          },
          requestId,
        },
        { status: 400 }
      );
    }

    const updatedPhoto = await decideRestroomPhotoReplacement(
      supabase,
      session.user.id,
      id,
      photoId,
      parsed.data
    );

    const responsePayload = {
      ok: true,
      data: updatedPhoto,
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

    console.error(
      `[POST /api/v1/admin/restrooms/${id}/photos/${photoId}/decision] ${requestId}`,
      err
    );
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "화장실 사진 심사 처리 중 오류가 발생했습니다.",
        },
        requestId,
      },
      { status: 500 }
    );
  }
}
