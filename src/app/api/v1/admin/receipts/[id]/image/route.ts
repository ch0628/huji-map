import { NextResponse } from "next/server";
import {
  AuthGuardError,
  isSupabaseAuthConfigured,
  requireRole,
} from "@/lib/auth";
import { createServerClientInstance } from "@/lib/supabase/server";
import {
  createReceiptSignedReadUrl,
  getAdminReceiptById,
  ReceiptServiceError,
} from "@/lib/receipts";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/v1/admin/receipts/:id/image
 * Issues a short-lived signed read URL for private receipt original image.
 * Spec: docs/04_API_CONTRACT.md, tasks/28_manual_review_backend.md
 * Invariant: Never issues public URLs. Admin only. 0 secret/token logs.
 */
export async function GET(request: Request, context: RouteParams) {
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
      { status: 400 }
    );
  }

  try {
    const supabase = await createServerClientInstance();
    await requireRole("admin", supabase);

    const receipt = await getAdminReceiptById(id);

    const expiresIn = 900; // 15 minutes
    const signedUrl = await createReceiptSignedReadUrl({
      storagePath: receipt.storagePath,
      userId: receipt.userId,
      isAdmin: true,
      expiresInSeconds: expiresIn,
    });

    return NextResponse.json(
      {
        ok: true,
        signedUrl,
        expiresIn,
        storagePath: receipt.storagePath,
        receiptId: id,
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
        { status: err.statusCode }
      );
    }

    const message =
      err instanceof Error
        ? err.message
        : "영수증 원본 이미지 조회 중 오류가 발생했습니다.";
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

