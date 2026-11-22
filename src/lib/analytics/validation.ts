import { z } from "zod";

/**
 * Zod schema for PMF analytics query parameters.
 */
export const pmfQuerySchema = z.object({
  experimentKey: z
    .string()
    .trim()
    .min(1, "실험 키는 필수입니다.")
    .max(100, "실험 키는 100자 이하여야 합니다.")
    .default("pmf_r1"),
  startsAt: z
    .string()
    .datetime({ message: "유효한 ISO 8601 시작 시각이어야 합니다." })
    .optional(),
  endsAt: z
    .string()
    .datetime({ message: "유효한 ISO 8601 종료 시각이어야 합니다." })
    .optional(),
  includeTest: z
    .preprocess((val) => {
      if (typeof val === "boolean") return val;
      if (typeof val === "string") return val.toLowerCase() === "true" || val === "1";
      return false;
    }, z.boolean())
    .default(false),
  authFilter: z.enum(["all", "guest", "authenticated"]).default("all"),
});

export type ValidatedPmfQueryParams = z.infer<typeof pmfQuerySchema>;

