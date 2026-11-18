import { NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  AuthGuardError,
  checkIdempotencyKey,
  recordIdempotencyResponse,
  isSupabaseAuthConfigured,
  requireRole,
} from "@/lib/auth";
import { createServerClientInstance } from "@/lib/supabase/server";
import {
  setOrRotateRestroomPin,
  computePinHmac,
  RestroomPinServiceError,
  PinCryptoError,
} from "@/lib/access/crypto";

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
    // 1. Authenticate user & ensure merchant or admin role
    const session = await requireRole(["merchant", "admin"], supabase);

    // 2. Parse request body
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

    if (!body || typeof body !== "object" || typeof body.pin !== "string") {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "도어락 비밀번호(pin)를 입력해 주세요.",
          },
          requestId,
        },
        { status: 400 }
      );
    }

    // 3. Idempotency handling:
    // Security note: Use server-derived keyed HMAC so plaintext PIN or raw SHA-256 is NEVER stored in cache
    const idempotencyHeader = request.headers.get("x-idempotency-key");
    if (idempotencyHeader !== null && idempotencyHeader.trim().length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Idempotency-Key는 비어 있거나 공백만으로 구성될 수 없습니다.",
          },
          requestId,
        },
        { status: 400 }
      );
    }
    const cleanIdempotencyKey = idempotencyHeader ? idempotencyHeader.trim() : null;
    const idempotencyScope = `merchant-restrooms-pin:${session.user.id}:${id}`;
    let pinHmac: string | null = null;

    if (cleanIdempotencyKey) {
      pinHmac = computePinHmac(body.pin);
      const idempotencyBody = { pinHmac };

      const idempotency = checkIdempotencyKey(
        cleanIdempotencyKey,
        idempotencyScope,
        idempotencyBody
      );

      // In-memory fast-path replay cache
      if (idempotency.action === "replay" && idempotency.cachedResponse) {
        return NextResponse.json(idempotency.cachedResponse.body, {
          status: idempotency.cachedResponse.status,
        });
      }

      // In-memory fast-path collision check
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
    }

    // 4. Execute PIN encryption and atomic rotation with persistent database idempotency
    const result = await setOrRotateRestroomPin({
      restroomId: id,
      userId: session.user.id,
      pin: body.pin,
      requestId,
      idempotencyKey: cleanIdempotencyKey,
    });

    const responsePayload = {
      ok: true,
      codeVersion: result.codeVersion,
      updatedAt: result.updatedAt,
      requestId,
    };

    recordIdempotencyResponse(
      idempotencyHeader,
      idempotencyScope,
      200,
      responsePayload
    );

    return NextResponse.json(responsePayload, { status: 200 });
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

    if (err instanceof RestroomPinServiceError || err instanceof PinCryptoError) {
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

    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "도어락 비밀번호 등록 처리 중 오류가 발생했습니다.",
        },
        requestId,
      },
      { status: 500 }
    );
  }
}

