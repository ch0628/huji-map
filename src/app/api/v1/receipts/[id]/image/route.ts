import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { AuthGuardError, isSupabaseAuthConfigured, requireAuth } from "@/lib/auth";
import { createServerClientInstance } from "@/lib/supabase/server";
import { getCustomerReceiptImageSignedUrl, ReceiptServiceError } from "@/lib/receipts";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
};

/**
 * GET /api/v1/receipts/:id/image
 * Issues a short-lived signed read URL for a customer's own private receipt image.
 * Invariant: Strictly checks authenticated user ownership. Never exposes public URLs.
 */
export async function GET(_request: Request, context: RouteParams) {
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
      { status: 503, headers: NO_STORE_HEADERS }
    );
  }

  const { id } = await context.params;
  if (!id || !UUID_REGEX.test(id)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "유효한 영수증 식별자(UUID)가 아닙니다.",
        },
        requestId,
      },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  try {
    const supabase = await createServerClientInstance();
    const authSession = await requireAuth(supabase);

    const { signedUrl, expiresIn } = await getCustomerReceiptImageSignedUrl({
      receiptId: id,
      userId: authSession.user.id,
      expiresInSeconds: 300,
    });

    return NextResponse.json(
      {
        ok: true,
        signedUrl,
        expiresIn,
        receiptId: id,
        requestId,
      },
      { status: 200, headers: NO_STORE_HEADERS }
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
        { status: err.status, headers: NO_STORE_HEADERS }
      );
    }

    if (err instanceof ReceiptServiceError) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: err.code,
            message: err.message,
          },
          requestId,
        },
        { status: err.statusCode, headers: NO_STORE_HEADERS }
      );
    }

    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "SERVER_ERROR",
          message: "영수증 이미지를 불러오는 중 오류가 발생했습니다.",
        },
        requestId,
      },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}
