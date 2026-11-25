import type { SupabaseClient } from "@supabase/supabase-js";
import { isUserExcludedFromAnalytics } from "@/lib/analytics/exclusions";
import type { BasicUsageCountResult } from "./types";
import { recordUsageCountSchema } from "./validation";

export class UsageCountError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "UsageCountError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface RecordDailyUsageCountOptions {
  /**
   * Cookie-bound Supabase server client for authoritative `auth.getUser()` verification.
   * When omitted, the request is treated as a pure unauthenticated guest request.
   */
  authClient?: SupabaseClient<any> | null;
  /**
   * True when the incoming request carried a Supabase auth cookie (`sb-*`) and therefore
   * requires server auth verification before counting.
   */
  hasAuthCookie?: boolean;
}

function getKstTodayDateString(): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function isAuthSystemOutage(
  error: { name?: string; message?: string; status?: number; code?: string } | null
): boolean {
  if (!error) return false;
  if (typeof error.status === "number" && (error.status >= 500 || error.status === 0)) {
    return true;
  }
  const name = (error.name || "").toLowerCase();
  if (name.includes("retryable") || name.includes("fetch")) {
    return true;
  }
  const msg = (error.message || "").toLowerCase();
  const code = (error.code || "").toLowerCase();
  return (
    msg.includes("fetch") ||
    msg.includes("network") ||
    msg.includes("timeout") ||
    msg.includes("econn") ||
    msg.includes("500") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("service unavailable") ||
    code === "internal_server_error" ||
    code === "unexpected_failure"
  );
}

/**
 * Atomically increments the non-identifying daily execution counter for an allowlisted feature.
 * When an authenticated user is verified via server `getUser()` and registered in
 * `analytics_excluded_accounts`, skips incrementing without storing any user identifier.
 * On auth outage or exclusion lookup failure when auth cookies are present, fails closed
 * (skips counting) without disrupting user-facing map/search/payment UX.
 */
export async function recordDailyUsageCount(
  supabase: SupabaseClient<any>,
  rawPayload: unknown,
  options?: RecordDailyUsageCountOptions
): Promise<BasicUsageCountResult> {
  const parsed = recordUsageCountSchema.safeParse(rawPayload);
  if (!parsed.success) {
    throw new UsageCountError(
      "INVALID_USAGE_PAYLOAD",
      parsed.error.issues[0]?.message || "유효하지 않은 기본 통계 요청입니다.",
      400
    );
  }

  const statDateFallback = getKstTodayDateString();

  // Check server-verified authentication & exclusion only when auth client or auth cookie is present
  if (options?.hasAuthCookie && !options.authClient) {
    // Auth cookie existed, but server auth client failed to initialize -> fail closed (skip counting)
    return {
      statDate: statDateFallback,
      feature: parsed.data.feature,
    };
  }

  if (options?.authClient) {
    let verifiedUserId: string | null = null;
    try {
      const { data: authData, error: authError } = await options.authClient.auth.getUser();
      if (authError) {
        if (isAuthSystemOutage(authError)) {
          return {
            statDate: statDateFallback,
            feature: parsed.data.feature,
          };
        }
        // Normal expired / missing / invalid session -> treat as logged-out guest
        verifiedUserId = null;
      } else {
        verifiedUserId = authData?.user?.id ?? null;
      }
    } catch {
      // Auth service exception -> fail closed (do not miscount potential excluded user)
      return {
        statDate: statDateFallback,
        feature: parsed.data.feature,
      };
    }

    if (verifiedUserId) {
      try {
        const excluded = await isUserExcludedFromAnalytics(supabase, verifiedUserId);
        if (excluded) {
          return {
            statDate: statDateFallback,
            feature: parsed.data.feature,
          };
        }
      } catch {
        // Exclusion lookup outage -> fail closed (skip counting) without breaking UX
        return {
          statDate: statDateFallback,
          feature: parsed.data.feature,
        };
      }
    }
  }

  const isEnvTest =
    process.env.NODE_ENV === "test" || process.env.NEXT_PUBLIC_APP_ENV === "test";
  const resolvedIsTest = isEnvTest ? Boolean(parsed.data.isTest ?? true) : false;

  const { data, error } = await supabase.rpc("increment_daily_usage_count", {
    p_feature_key: parsed.data.feature,
    p_is_test: resolvedIsTest,
  });

  if (error) {
    if (error.code === "42501") {
      throw new UsageCountError(
        "FORBIDDEN_USAGE_COUNTER",
        "기본 통계 카운터 실행 권한이 없습니다.",
        403
      );
    }
    if (error.code === "22023") {
      throw new UsageCountError(
        "INVALID_USAGE_PAYLOAD",
        "허용되지 않은 통계 항목입니다.",
        400
      );
    }
    throw new UsageCountError(
      "USAGE_COUNTER_FAILED",
      "기본 이용 통계 기록 중 일시적 오류가 발생했습니다.",
      500
    );
  }

  const statDate =
    data && typeof (data as { stat_date?: unknown }).stat_date === "string"
      ? (data as { stat_date: string }).stat_date
      : statDateFallback;

  return {
    statDate,
    feature: parsed.data.feature,
  };
}
