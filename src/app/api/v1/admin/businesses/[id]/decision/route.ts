import { NextResponse } from "next/server";
import {
  AuthGuardError,
  checkIdempotencyKey,
  isSupabaseAuthConfigured,
  requireRole,
} from "@/lib/auth";
import { createServerClientInstance } from "@/lib/supabase/server";
import {
  adminBusinessDecisionSchema,
  decideBusinessApproval,
} from "@/lib/businesses";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, { params }: RouteParams) {
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

  const { id } = await params;
  if (!id || typeof id !== "string") {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "가게 식별자가 올바르지 않습니다.",
        },
        requestId,
      },
      { status: 400 }
    );
  }

  // Idempotency key check
  const idempotencyHeader = request.headers.get("x-idempotency-key");
  const idempotencyResult = checkIdempotencyKey(
    idempotencyHeader,
    `admin_decision_${id}`
  );
  if (idempotencyResult.isDuplicate) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "CONFLICT",
          message: "이미 처리 중이거나 완료된 심사 결정 요청입니다.",
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
          code: "INVALID_INPUT",
          message: "JSON 형식의 요청 본문이 필요합니다.",
        },
        requestId,
      },
      { status: 400 }
    );
  }

  const parsed = adminBusinessDecisionSchema.safeParse(body);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: firstIssue?.message ?? "심사 결정 입력값이 올바르지 않습니다.",
        },
        requestId,
      },
      { status: 400 }
    );
  }

  try {
    const supabase = await createServerClientInstance();
    await requireRole("admin", supabase);

    const business = await decideBusinessApproval(supabase, id, parsed.data);

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

    const message =
      err instanceof Error ? err.message : "가게 심사 처리 중 오류가 발생했습니다.";
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message,
        },
        requestId,
      },
      { status: 500 }
    );
  }
}
