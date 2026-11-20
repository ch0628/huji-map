import { z } from "zod";

export const adminRestroomListFilterSchema = z.object({
  status: z
    .enum(["all", "draft", "pending", "published", "suspended", "archived", "pending_photos"])
    .default("pending"),
  type: z.enum(["all", "partner", "public"]).default("all"),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type AdminRestroomListFilter = z.infer<typeof adminRestroomListFilterSchema>;

export const adminRestroomDecisionSchema = z
  .object({
    decision: z.enum(["publish", "reject", "suspend"], {
      message: "결정 유형은 publish, reject, suspend 중 하나여야 합니다.",
    }),
    reason: z
      .string()
      .trim()
      .max(1000, "사유는 최대 1,000자까지 입력 가능합니다.")
      .optional()
      .nullable(),
    review_notes: z
      .string()
      .trim()
      .max(1000, "검수 메모는 최대 1,000자까지 입력 가능합니다.")
      .optional()
      .nullable(),
  })
  .strict()
  .refine(
    (data) => {
      if (data.decision === "reject" || data.decision === "suspend") {
        return typeof data.reason === "string" && data.reason.trim().length >= 2;
      }
      return true;
    },
    {
      message: "반려 또는 공개 중단 시 구체적인 사유(2자 이상)를 필수로 입력해야 합니다.",
      path: ["reason"],
    }
  );

export type AdminRestroomDecisionInput = z.infer<typeof adminRestroomDecisionSchema>;

export const adminPhotoReplacementDecisionSchema = z
  .object({
    decision: z.enum(["approve", "reject"], {
      message: "사진 심사 결정은 approve 또는 reject 중 하나여야 합니다.",
    }),
    reason: z
      .string()
      .trim()
      .max(1000, "사유는 최대 1,000자까지 입력 가능합니다.")
      .optional()
      .nullable(),
  })
  .strict()
  .refine(
    (data) => {
      if (data.decision === "reject") {
        return typeof data.reason === "string" && data.reason.trim().length >= 2;
      }
      return true;
    },
    {
      message: "사진 반려 시 구체적인 사유(2자 이상)를 필수로 입력해야 합니다.",
      path: ["reason"],
    }
  );

export type AdminPhotoReplacementDecisionInput = z.infer<
  typeof adminPhotoReplacementDecisionSchema
>;

