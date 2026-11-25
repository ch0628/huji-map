import { z } from "zod";
import { BASIC_USAGE_FEATURES } from "./types";

/**
 * Strict allowlist schema for anonymous basic usage counting.
 * `.strict()` rejects any unexpected field (e.g. userId, browserId, sessionId, query, keyword, restroomId, lat, lng, occurredAt).
 */
export const recordUsageCountSchema = z
  .object({
    feature: z.enum(BASIC_USAGE_FEATURES, {
      message: "허용되지 않은 통계 항목입니다.",
    }),
    isTest: z.boolean().optional(),
  })
  .strict();

export type ValidatedUsageCountInput = z.infer<typeof recordUsageCountSchema>;
