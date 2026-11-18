import { NextResponse } from "next/server";
import {
  AuthGuardError,
  checkIdempotencyKey,
  isSupabaseAuthConfigured,
} from "@/lib/auth";
import {
  createLeadForAdmin,
  createLeadSchema,
  leadFilterSchema,
  listLeadsForAdmin,
} from "@/lib/leads";

export async function GET(request: Request) {
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

  const { searchParams } = new URL(request.url);
  const parsedFilter = leadFilterSchema.safeParse({
    result: searchParams.get("result") ?? undefined,
    channel: searchParams.get("channel") ?? undefined,
    q: searchParams.get("q") ?? undefined,
    limit: searchParams.get("limit") ?? undefined,
  });

  if (!parsedFilter.success) {
    const firstIssue = parsedFilter.error.issues[0];
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: firstIssue?.message ?? "조회 필터 값이 올바르지 않습니다.",
        },
        requestId,
      },
      { status: 400 }
    );
  }

  try {
    const { items, metrics } = await listLeadsForAdmin(parsedFilter.data);
    return NextResponse.json(
      {
        ok: true,
        items,
        metrics,
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
          message: "가게 리드 목록을 불러오는 중 오류가 발생했습니다.",
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
          message: "서버 설정이 필요합니다.",
        },
        requestId,
      },
      { status: 503 }
    );
  }

  const idempotencyKey = request.headers.get("x-idempotency-key");
  const { isDuplicate } = checkIdempotencyKey(idempotencyKey, "admin:leads:create");
  if (isDuplicate) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "DUPLICATE_REQUEST",
          message: "이미 처리 중인 리드 등록 요청입니다.",
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

  const parsed = createLeadSchema.safeParse(body);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          field: firstIssue?.path?.[0] ?? "businessName",
          message: firstIssue?.message ?? "입력값을 확인해 주세요.",
        },
        requestId,
      },
      { status: 400 }
    );
  }

  try {
    const lead = await createLeadForAdmin(parsed.data);
    return NextResponse.json(
      {
        ok: true,
        lead,
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
          message: "가게 리드 등록 중 오류가 발생했습니다.",
        },
        requestId,
      },
      { status: 500 }
    );
  }
}

