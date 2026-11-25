/**
 * Non-identifying daily feature usage counter types.
 * Strictly stores only (KST date, feature key, total count) without any user/browser/location/query PII.
 */

export const BASIC_USAGE_FEATURES = [
  "map_opened",
  "restroom_marker_clicked",
  "restroom_detail_opened",
  "search_executed",
  "directions_clicked",
  "payment_button_clicked",
] as const;

export type BasicUsageFeatureKey = (typeof BASIC_USAGE_FEATURES)[number];

export interface BasicUsageCountResult {
  statDate: string;
  feature: BasicUsageFeatureKey;
}

export interface DailyUsageCountRow {
  stat_date: string;
  feature_key: BasicUsageFeatureKey;
  is_test: boolean;
  total_count: number;
}
