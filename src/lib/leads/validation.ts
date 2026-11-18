import { z } from "zod";
import type {
  LeadChannel,
  LeadContactResult,
  LeadFilterChannel,
  LeadFilterResult,
} from "./types";

export const LEAD_CHANNELS: readonly [LeadChannel, ...LeadChannel[]] = [
  "visit",
  "phone",
  "message",
  "email",
];

export const LEAD_CONTACT_RESULTS: readonly [
  LeadContactResult,
  ...LeadContactResult[],
] = ["no_answer", "rejected", "interested", "agreed", "follow_up"];

export const LEAD_FILTER_RESULTS: readonly [
  LeadFilterResult,
  ...LeadFilterResult[],
] = [
  "all",
  "uncontacted",
  "no_answer",
  "rejected",
  "interested",
  "agreed",
  "follow_up",
];

export const LEAD_FILTER_CHANNELS: readonly [
  LeadFilterChannel,
  ...LeadFilterChannel[],
] = ["all", "visit", "phone", "message", "email"];

export const uuidParamSchema = z
  .string()
  .trim()
  .uuid("유효한 식별자(UUID) 형식이 아닙니다.");

export const createLeadSchema = z
  .object({
    businessName: z
      .string()
      .trim()
      .min(1, "가게명을 입력해 주세요.")
      .max(120, "가게명은 120자 이하로 입력해 주세요."),
    category: z
      .string()
      .trim()
      .max(60, "업종은 60자 이하로 입력해 주세요.")
      .optional()
      .nullable(),
    roadAddress: z
      .string()
      .trim()
      .max(200, "도로명주소는 200자 이하로 입력해 주세요.")
      .optional()
      .nullable(),
    latitude: z
      .number()
      .min(-90, "위도는 -90 이상이어야 합니다.")
      .max(90, "위도는 90 이하이어야 합니다.")
      .optional()
      .nullable(),
    longitude: z
      .number()
      .min(-180, "경도는 -180 이상이어야 합니다.")
      .max(180, "경도는 180 이하이어야 합니다.")
      .optional()
      .nullable(),
    contactPhone: z
      .string()
      .trim()
      .max(30, "연락처는 30자 이하로 입력해 주세요.")
      .optional()
      .nullable(),
    leadSource: z
      .string()
      .trim()
      .max(80, "확보 경로는 80자 이하로 입력해 주세요.")
      .optional()
      .nullable(),
    assignedUserId: z
      .string()
      .trim()
      .uuid("담당자 ID가 올바른 UUID 형식이 아닙니다.")
      .optional()
      .nullable(),
  })
  .refine(
    (val) => {
      const hasLat = val.latitude !== undefined && val.latitude !== null;
      const hasLng = val.longitude !== undefined && val.longitude !== null;
      return hasLat === hasLng;
    },
    {
      message: "위도(latitude)와 경도(longitude)는 함께 입력하거나 모두 비워야 합니다.",
      path: ["latitude"],
    }
  );

export const createContactAttemptSchema = z.object({
  contactedAt: z
    .string()
    .datetime({ offset: true, message: "연락 시각 형식이 올바르지 않습니다." })
    .optional(),
  channel: z.enum(LEAD_CHANNELS, {
    error: "연락 채널(방문/전화/메시지/이메일)을 선택해 주세요.",
  }),
  result: z.enum(LEAD_CONTACT_RESULTS, {
    error: "연락 결과(응답없음/거절/관심보임/제휴동의/추후연락)를 선택해 주세요.",
  }),
  notes: z
    .string()
    .trim()
    .max(1000, "메모는 1000자 이하로 입력해 주세요.")
    .optional()
    .nullable(),
  nextContactAt: z
    .string()
    .datetime({ offset: true, message: "후속 연락 시각 형식이 올바르지 않습니다." })
    .optional()
    .nullable(),
});

export const leadFilterSchema = z.object({
  result: z.enum(LEAD_FILTER_RESULTS).optional().default("all"),
  channel: z.enum(LEAD_FILTER_CHANNELS).optional().default("all"),
  q: z.string().trim().max(100).optional().default(""),
  limit: z.coerce.number().int().min(1).max(500).optional().default(200),
});

export type CreateLeadInput = z.infer<typeof createLeadSchema>;
export type CreateContactAttemptInput = z.infer<typeof createContactAttemptSchema>;
export type ValidatedLeadFilter = z.infer<typeof leadFilterSchema>;

/**
 * Redacts private phone numbers and sensitive lead notes from error/log strings.
 * AGENTS.md Rule 13 & TASK 05: Never leak phone numbers or private notes in general errors or logs.
 */
export function redactLeadSensitiveText(input: string): string {
  if (!input) return "";
  return input
    .replace(/\b0\d{1,2}[-\s.]?\d{3,4}[-\s.]?\d{4}\b/g, "[REDACTED_PHONE]")
    .replace(/(contact_phone|notes)\s*[:=]\s*\S+/gi, "$1=[REDACTED]");
}

