import { NextResponse } from "next/server";
import { z } from "zod";
import { isSupabaseAuthConfigured, getServerAuthSession } from "@/lib/auth";
import {
  createServerClientInstance,
  createAdminClient,
  isServiceRoleConfigured,
} from "@/lib/supabase/server";
import { checkRateLimit, PRIVACY_POLICY_VERSION } from "@/lib/events";

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const consentUpdateSchema = z
  .object({
    analytics: z.boolean(),
    analyticsStatus: z.enum(["accepted", "declined"]).optional(),
    browserId: z
      .string()
      .regex(uuidRegex, "유효한 UUID 형식의 browserId여야 합니다.")
      .optional()
      .nullable(),
    policyVersion: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .optional()
      .default(PRIVACY_POLICY_VERSION),
  })
  .refine(
    (d) =>
      !d.analyticsStatus ||
      (d.analyticsStatus === "accepted") === d.analytics,
    { message: "동의 여부와 상태 값이 일치하지 않습니다." }
  );

function extractCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();

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

  const parsed = consentUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message:
            parsed.error.issues[0]?.message ?? "유효하지 않은 동의 요청입니다.",
        },
        requestId,
      },
      { status: 400 }
    );
  }

  const clientIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "anonymous";
  const rateLimitKey = `consent:${parsed.data.browserId || clientIp}`;
  const rate = checkRateLimit(rateLimitKey, 30, 60_000);
  if (!rate.allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "RATE_LIMIT_EXCEEDED",
          message: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
        },
        requestId,
      },
      { status: 429 }
    );
  }

  let recordedOnServer = false;
  let isAuthenticated = false;
  const cookieConsentBrowserId = extractCookieValue(
    request.headers.get("cookie"),
    "hm_consent_bid"
  );

  if (isSupabaseAuthConfigured()) {
    try {
      const supabase = await createServerClientInstance();
      const authSession = await getServerAuthSession(supabase);
      const authUserId = authSession.user?.id ?? null;
      isAuthenticated = Boolean(authUserId);
      const browserId = parsed.data.browserId ?? null;

      // 타인의 브라우저 식별자/동의 기록 임의 철회 또는 덮어쓰기 차단
      if (
        !authUserId &&
        browserId &&
        cookieConsentBrowserId &&
        cookieConsentBrowserId !== browserId
      ) {
        return NextResponse.json(
          {
            ok: false,
            error: {
              code: "CONSENT_OWNERSHIP_MISMATCH",
              message: "다른 브라우저의 동의 기록을 변경할 수 없습니다.",
            },
            requestId,
          },
          { status: 403 }
        );
      }

      if (authUserId || browserId) {
        const dbClient = isServiceRoleConfigured()
          ? createAdminClient()
          : supabase;

        if (!authUserId && browserId && !cookieConsentBrowserId) {
          const { data: latestForBrowser } = await (dbClient.from("consent_records") as any)
            .select("user_id")
            .eq("consent_type", "analytics")
            .eq("browser_id", browserId)
            .order("recorded_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (latestForBrowser?.user_id) {
            return NextResponse.json(
              {
                ok: false,
                error: {
                  code: "CONSENT_OWNERSHIP_MISMATCH",
                  message: "인증이 필요한 동의 기록은 로그인 없이 변경할 수 없습니다.",
                },
                requestId,
              },
              { status: 403 }
            );
          }
        }

        const now = new Date().toISOString();
        const { error } = await (dbClient.from("consent_records") as any).insert({
          user_id: authUserId,
          browser_id: browserId,
          consent_type: "analytics",
          policy_version: parsed.data.policyVersion,
          accepted: parsed.data.analytics,
          recorded_at: now,
          withdrawn_at: parsed.data.analytics ? null : now,
        });
        if (!error) {
          recordedOnServer = true;
        }
      }
    } catch {
      recordedOnServer = false;
    }
  } else if (
    !parsed.data.analytics &&
    parsed.data.browserId &&
    cookieConsentBrowserId &&
    cookieConsentBrowserId !== parsed.data.browserId
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "CONSENT_OWNERSHIP_MISMATCH",
          message: "다른 브라우저의 동의 기록을 변경할 수 없습니다.",
        },
        requestId,
      },
      { status: 403 }
    );
  }

  const analyticsStatus = parsed.data.analytics ? "accepted" : "declined";
  const response = NextResponse.json(
    {
      ok: true,
      data: {
        analytics: parsed.data.analytics,
        analyticsStatus,
        policyVersion: parsed.data.policyVersion,
        recordedOnServer,
        isAuthenticated,
      },
      requestId,
    },
    { status: 200 }
  );

  if (parsed.data.analytics && parsed.data.browserId) {
    response.cookies.set("hm_consent_bid", parsed.data.browserId, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      maxAge: 365 * 24 * 60 * 60,
    });
  } else if (!parsed.data.analytics) {
    response.cookies.set("hm_consent_bid", "", {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      maxAge: 0,
    });
    response.cookies.set("hm_session_token", "", {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      maxAge: 0,
    });
  }

  return response;
}
