import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { AuthGuardError, requireAuth, isSupabaseAuthConfigured } from "@/lib/auth";
import { createServerClientInstance } from "@/lib/supabase/server";
import {
  createUploadIntentSchema,
  createReceiptUploadIntent,
  ReceiptServiceError,
} from "@/lib/receipts";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
};

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();

  // 1. Supabase Auth configuration check
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
      {
        status: 503,
        headers: NO_STORE_HEADERS,
      }
    );
  }

  // 2. Customer server-side authentication
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
        {
          status: authErr.status,
          headers: NO_STORE_HEADERS,
        }
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "UNAUTHENTICATED",
          message: "로그인이 필요합니다.",
        },
        requestId,
      },
      {
        status: 401,
        headers: NO_STORE_HEADERS,
      }
    );
  }

  // 3. Request body parsing and Zod validation
  let bodyJson: unknown;
  try {
    bodyJson = await request.json();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INVALID_JSON",
          message: "요청 본문이 올바른 JSON 형식이 아닙니다.",
        },
        requestId,
      },
      {
        status: 400,
        headers: NO_STORE_HEADERS,
      }
    );
  }

  const parsed = createUploadIntentSchema.safeParse(bodyJson);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: issue?.message || "입력값이 유효하지 않습니다.",
        },
        requestId,
      },
      {
        status: 400,
        headers: NO_STORE_HEADERS,
      }
    );
  }

  // 4. Create signed upload intent via authoritative receipt service
  try {
    const result = await createReceiptUploadIntent({
      accessSessionId: parsed.data.accessSessionId,
      mimeType: parsed.data.mimeType,
      fileSizeBytes: parsed.data.fileSizeBytes,
      originalFilename: parsed.data.originalFilename,
      userId: authSession.user.id,
    });

    return NextResponse.json(
      {
        ok: true,
        uploadUrl: result.uploadUrl,
        storagePath: result.storagePath,
        token: result.token,
        expiresIn: result.expiresIn,
        requestId,
      },
      {
        status: 200,
        headers: NO_STORE_HEADERS,
      }
    );
  } catch (err) {
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
        {
          status: err.statusCode,
          headers: NO_STORE_HEADERS,
        }
      );
    }

    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "영수증 업로드 요청 처리 중 오류가 발생했습니다.",
        },
        requestId,
      },
      {
        status: 500,
        headers: NO_STORE_HEADERS,
      }
    );
  }
}
