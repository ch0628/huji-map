import { NextResponse } from "next/server";
import { AuthGuardError, requireAuth } from "@/lib/auth";
import { createServerClientInstance } from "@/lib/supabase/server";
import {
  confirmPaymentRequestSchema,
  confirmPayment,
  PaymentConfigError,
  PaymentServiceError,
} from "@/lib/payments";

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();

  // 1. Authenticate customer
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

  // 2. Parse and validate JSON payload
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INVALID_JSON",
          message: "유효한 JSON 요청 본문이 필요합니다.",
        },
        requestId,
      },
      { status: 400 }
    );
  }

  const parseResult = confirmPaymentRequestSchema.safeParse(body);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: firstIssue?.message || "입력값이 유효하지 않습니다.",
        },
        requestId,
      },
      { status: 400 }
    );
  }

  const { orderId, paymentKey, amount } = parseResult.data;

  // 3. Confirm payment with Toss Payments and authorize access
  try {
    const result = await confirmPayment({
      userId: authSession.user.id,
      orderId,
      paymentKey,
      amount,
    });

    return NextResponse.json(
      {
        ok: true,
        data: result,
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

    console.error(`[${requestId}] Failed to confirm payment for order ${orderId}:`, err);
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "결제 승인 처리 중 서버 오류가 발생했습니다.",
        },
        requestId,
      },
      { status: 500 }
    );
  }
}

