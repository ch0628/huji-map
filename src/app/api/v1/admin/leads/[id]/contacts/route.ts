import { NextResponse } from "next/server";
import {
  AuthGuardError,
  checkIdempotencyKey,
  isSupabaseAuthConfigured,
} from "@/lib/auth";
import {
  createContactAttemptForAdmin,
  createContactAttemptSchema,
  uuidParamSchema,
} from "@/lib/leads";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const requestId = crypto.randomUUID();

  if (!isSupabaseAuthConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "CONFIG_REQUIRED",
          message: "서버 설정이 필요합니다.",
        },
        requestId,
      },
      { status: 503 }
    );
  }

  const { id } = await context.params;
  const parsedId = uuidParamSchema.safeParse(id);
  if (!parsedId.success) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "유효한 리드 ID(UUID)가 아닙니다.",
        },
        requestId,
      },
      { status: 400 }
    );
  }

  const idempotencyKey = request.headers.get("x-idempotency-key");
  const { isDuplicate } = checkIdempotencyKey(
    idempotencyKey,
    `admin:leads:contact:${parsedId.data}`
  );
  if (isDuplicate) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "DUPLICATE_REQUEST",
          message: "이미 처리 중인 연락 시도 기록 요청입니다.",
        },
        requestId,
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
          message: "요청 본문 형식이 올바르지 않습니다.",
        },
        requestId,
      },
      { status: 400 }
    );
  }

  const parsedBody = createContactAttemptSchema.safeParse(body);
  if (!parsedBody.success) {
    const firstIssue = parsedBody.error.issues[0];
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          field: firstIssue?.path?.[0] ?? "channel",
          message: firstIssue?.message ?? "입력값을 확인해 주세요.",
        },
        requestId,
      },
      { status: 400 }
    );
  }

  try {
    const { attempt, metrics } = await createContactAttemptForAdmin(
      parsedId.data,
      parsedBody.data
    );

    return NextResponse.json(
      {
        ok: true,
        attempt,
        metrics,
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
          message: "연락 시도 기록 저장 중 오류가 발생했습니다.",
        },
        requestId,
      },
      { status: 500 }
    );
  }
}

