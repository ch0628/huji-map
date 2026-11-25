import type { SupabaseClient } from "@supabase/supabase-js";
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

/**
 * Atomically increments the non-identifying daily execution counter for an allowlisted feature.
 * Never persists user_id, browser_id, session_id, IP, coordinates, search keywords, or restroom IDs.
 */
export async function recordDailyUsageCount(
  supabase: SupabaseClient<any>,
  rawPayload: unknown
): Promise<BasicUsageCountResult> {
  const parsed = recordUsageCountSchema.safeParse(rawPayload);
  if (!parsed.success) {
    throw new UsageCountError(
      "INVALID_USAGE_PAYLOAD",
      parsed.error.issues[0]?.message || "유효하지 않은 기본 통계 요청입니다.",
      400
    );
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
      : getKstTodayDateString();

  return {
    statDate,
    feature: parsed.data.feature,
  };
}
