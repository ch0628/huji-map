import { NextResponse } from "next/server";
import { AuthGuardError, requireAuth } from "@/lib/auth";
import { createServerClientInstance } from "@/lib/supabase/server";
import { toPublicAccessSession, type AccessSessionRow } from "@/lib/access/types";
import {
  getPaymentOrder,
  orderIdParamSchema,
  PaymentConfigError,
  PaymentServiceError,
} from "@/lib/payments";

const SAFE_ACCESS_SESSION_COLUMNS =
  "id, user_id, restroom_id, policy_id, status, access_method_snapshot, authorized_at, code_revealed_at, expires_at, created_at, updated_at";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const requestId = crypto.randomUUID();

  // 1. Authenticate user
  let authSession;
  try {
    const supabase = await createServerClientInstance();
    authSession = await requireAuth(supabase);
  } catch (authErr) {
    if (authErr instanceof AuthGuardError) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: authErr.code,
            message: authErr.userMessage,
          },
          requestId,
        },
        { status: authErr.status }
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "UNAUTHORIZED",
          message: "로그인이 필요한 서비스입니다.",
        },
        requestId,
      },
      { status: 401 }
    );
  }

  // 2. Validate route parameter
  const rawParams = await context.params;
  const parseResult = orderIdParamSchema.safeParse(rawParams);
  if (!parseResult.success) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "주문 식별자 파라미터가 유효하지 않습니다.",
        },
        requestId,
      },
      { status: 400 }
    );
  }

  const { id } = parseResult.data;

  // 3. Fetch order status
  try {
    const order = await getPaymentOrder({
      userId: authSession.user.id,
      isAdmin: authSession.isAdmin,
      orderIdOrId: id,
    });

    let accessSession = null;
    if (order.access_session_id) {
      const supabase = await createServerClientInstance();
      const { data: sessionData } = await supabase
        .from("access_sessions")
        .select(SAFE_ACCESS_SESSION_COLUMNS)
        .eq("id", order.access_session_id)
        .maybeSingle();

      if (sessionData) {
        accessSession = toPublicAccessSession(sessionData as unknown as AccessSessionRow);
      }
    }

    return NextResponse.json(
      {
        ok: true,
        data: {
          order,
          accessSession,
        },
        requestId,
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    if (err instanceof PaymentConfigError) {
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

    if (err instanceof PaymentServiceError) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: err.code,
            message: err.userMessage,
          },
          requestId,
        },
        { status: err.statusCode }
      );
    }

    console.error(`[${requestId}] Failed to fetch payment order ${id}:`, err);
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "주문 정보 조회 중 오류가 발생했습니다.",
        },
        requestId,
      },
      { status: 500 }
    );
  }
}

