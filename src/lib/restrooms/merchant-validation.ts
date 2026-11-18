import { z } from "zod";

const LATITUDE_MIN = -90;
const LATITUDE_MAX = 90;
const LONGITUDE_MIN = -180;
const LONGITUDE_MAX = 180;

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

function normalizeTimeValue(time: string): string {
  const trimmed = time.trim();
  return trimmed.length === 5 ? `${trimmed}:00` : trimmed;
}

export const restroomHourInputSchema = z
  .object({
    weekday: z
      .number({ message: "요일은 0(일)~6(토) 사이 정수여야 합니다." })
      .int("요일은 정수여야 합니다.")
      .min(0, "요일은 0(일) 이상이어야 합니다.")
      .max(6, "요일은 6(토) 이하여야 합니다."),
    is_closed: z.boolean().default(false),
    opens_at: z
      .string()
      .trim()
      .regex(TIME_REGEX, "시작 시간은 HH:MM 형식이어야 합니다.")
      .optional()
      .nullable(),
    closes_at: z
      .string()
      .trim()
      .regex(TIME_REGEX, "종료 시간은 HH:MM 형식이어야 합니다.")
      .optional()
      .nullable(),
    crosses_midnight: z.boolean().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.is_closed) {
      return;
    }
    if (!val.opens_at || !val.closes_at) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "휴무가 아닌 요일은 시작 시간과 종료 시간을 모두 입력해야 합니다.",
      });
      return;
    }
    if (val.opens_at.slice(0, 5) === val.closes_at.slice(0, 5)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "시작 시간과 종료 시간은 같을 수 없습니다.",
      });
    }
  });

export type RestroomHourInput = z.infer<typeof restroomHourInputSchema>;

export interface NormalizedRestroomHour {
  weekday: number;
  is_closed: boolean;
  opens_at: string | null;
  closes_at: string | null;
  crosses_midnight: boolean;
}

export function normalizeRestroomHours(
  hours: readonly RestroomHourInput[]
): NormalizedRestroomHour[] {
  return hours.map((item) => {
    if (item.is_closed) {
      return {
        weekday: item.weekday,
        is_closed: true,
        opens_at: null,
        closes_at: null,
        crosses_midnight: false,
      };
    }
    const opens = normalizeTimeValue(item.opens_at!);
    const closes = normalizeTimeValue(item.closes_at!);
    const crossesMidnight =
      typeof item.crosses_midnight === "boolean"
        ? item.crosses_midnight
        : closes.slice(0, 5) < opens.slice(0, 5);
    return {
      weekday: item.weekday,
      is_closed: false,
      opens_at: opens,
      closes_at: closes,
      crosses_midnight: crossesMidnight,
    };
  });
}

export const restroomHoursArraySchema = z
  .array(restroomHourInputSchema)
  .max(21, "운영시간 항목은 최대 21개까지 등록할 수 있습니다.");

/**
 * Validation schema for registering a new partner restroom by merchant owner/manager
 * Based on docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, and tasks/12_restroom_merchant_api.md
 */
export const createMerchantRestroomSchema = z
  .object({
    business_id: z.string().uuid("유효한 가게 UUID를 입력해 주세요."),
    name: z
      .string()
      .trim()
      .min(1, "화장실 이름은 최소 1자 이상이어야 합니다.")
      .max(200, "화장실 이름은 최대 200자까지 입력할 수 있습니다."),
    description: z
      .string()
      .trim()
      .max(2000, "설명은 최대 2,000자까지 입력할 수 있습니다.")
      .optional()
      .nullable(),
    road_address: z
      .string()
      .trim()
      .min(1, "도로명주소를 입력해 주세요.")
      .max(300, "도로명주소는 최대 300자까지 입력할 수 있습니다."),
    address_detail: z
      .string()
      .trim()
      .max(200, "상세주소는 최대 200자까지 입력할 수 있습니다.")
      .optional()
      .nullable(),
    latitude: z
      .number({ message: "주소 검색을 통해 유효한 위도를 생성해 주세요." })
      .finite("위도는 유한한 숫자여야 합니다.")
      .min(LATITUDE_MIN, `위도는 ${LATITUDE_MIN} 이상이어야 합니다.`)
      .max(LATITUDE_MAX, `위도는 ${LATITUDE_MAX} 이하여야 합니다.`),
    longitude: z
      .number({ message: "주소 검색을 통해 유효한 경도를 생성해 주세요." })
      .finite("경도는 유한한 숫자여야 합니다.")
      .min(LONGITUDE_MIN, `경도는 ${LONGITUDE_MIN} 이상이어야 합니다.`)
      .max(LONGITUDE_MAX, `경도는 ${LONGITUDE_MAX} 이하여야 합니다.`),
    floor: z
      .string()
      .trim()
      .max(50, "층 정보는 최대 50자까지 입력할 수 있습니다.")
      .optional()
      .nullable(),
    entrance_instructions: z
      .string()
      .trim()
      .max(500, "입구 안내는 최대 500자까지 입력할 수 있습니다.")
      .optional()
      .nullable(),
    gender_type: z
      .enum(["male", "female", "separate", "unisex", "unknown"], {
        message: "유효한 화장실 성별 구분을 선택해 주세요.",
      })
      .default("unknown"),
    wheelchair_accessible: z.boolean().optional().nullable(),
    baby_changing_available: z.boolean().optional().nullable(),
    sanitary_products_available: z.boolean().optional().nullable(),
    access_method: z
      .enum(["open", "ask_staff", "pin"], {
        message: "출입 방식을 선택해 주세요 (open, ask_staff, pin).",
      })
      .default("ask_staff"),
    access_mode: z.enum(["free", "test_deposit"]).optional(),
    policy_mode: z.enum(["free_with_ad", "deposit_with_ad"]).optional(),
    deposit_amount_krw: z.number().int().min(0).optional(),
    refund_eligible: z.boolean().optional(),
    receipt_window_hours: z.number().int().min(1).max(168).optional().nullable(),
    min_purchase_krw: z.number().int().min(0).optional().nullable(),
    hours: restroomHoursArraySchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.latitude === 0 && data.longitude === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "임의 좌표(0, 0)는 저장할 수 없습니다. 주소 검색을 통해 위치를 선택해 주세요.",
        path: ["latitude"],
      });
    }
  });

export type CreateMerchantRestroomInput = z.infer<typeof createMerchantRestroomSchema>;

/**
 * Validation schema for updating partner restroom by merchant owner/manager
 */
export const updateMerchantRestroomSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "화장실 이름은 최소 1자 이상이어야 합니다.")
      .max(200, "화장실 이름은 최대 200자까지 입력할 수 있습니다.")
      .optional(),
    description: z
      .string()
      .trim()
      .max(2000, "설명은 최대 2,000자까지 입력할 수 있습니다.")
      .optional()
      .nullable(),
    road_address: z
      .string()
      .trim()
      .min(1, "도로명주소를 입력해 주세요.")
      .max(300, "도로명주소는 최대 300자까지 입력할 수 있습니다.")
      .optional(),
    address_detail: z
      .string()
      .trim()
      .max(200, "상세주소는 최대 200자까지 입력할 수 있습니다.")
      .optional()
      .nullable(),
    latitude: z
      .number({ message: "주소 검색을 통해 유효한 위도를 생성해 주세요." })
      .finite("위도는 유한한 숫자여야 합니다.")
      .min(LATITUDE_MIN, `위도는 ${LATITUDE_MIN} 이상이어야 합니다.`)
      .max(LATITUDE_MAX, `위도는 ${LATITUDE_MAX} 이하여야 합니다.`)
      .optional(),
    longitude: z
      .number({ message: "주소 검색을 통해 유효한 경도를 생성해 주세요." })
      .finite("경도는 유한한 숫자여야 합니다.")
      .min(LONGITUDE_MIN, `경도는 ${LONGITUDE_MIN} 이상이어야 합니다.`)
      .max(LONGITUDE_MAX, `경도는 ${LONGITUDE_MAX} 이하여야 합니다.`)
      .optional(),
    floor: z
      .string()
      .trim()
      .max(50, "층 정보는 최대 50자까지 입력할 수 있습니다.")
      .optional()
      .nullable(),
    entrance_instructions: z
      .string()
      .trim()
      .max(500, "입구 안내는 최대 500자까지 입력할 수 있습니다.")
      .optional()
      .nullable(),
    gender_type: z
      .enum(["male", "female", "separate", "unisex", "unknown"])
      .optional(),
    wheelchair_accessible: z.boolean().optional().nullable(),
    baby_changing_available: z.boolean().optional().nullable(),
    sanitary_products_available: z.boolean().optional().nullable(),
    access_method: z.enum(["open", "ask_staff", "pin"]).optional(),
    hours: restroomHoursArraySchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const hasLat = data.latitude !== undefined;
    const hasLng = data.longitude !== undefined;
    if (hasLat !== hasLng) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "위도와 경도는 함께 제공되어야 합니다.",
        path: ["latitude"],
      });
    }
    if (hasLat && hasLng && data.latitude === 0 && data.longitude === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "임의 좌표(0, 0)는 저장할 수 없습니다. 주소 검색을 통해 위치를 선택해 주세요.",
        path: ["latitude"],
      });
    }
    if (data.road_address !== undefined && (!hasLat || !hasLng)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "주소 변경 시 변환된 위도·경도가 함께 제공되어야 합니다.",
        path: ["latitude"],
      });
    }
  });

export type UpdateMerchantRestroomInput = z.infer<typeof updateMerchantRestroomSchema>;

/**
 * Normalizes user-facing policy_mode ('free_with_ad' | 'deposit_with_ad')
 * and DB-level access_mode ('free' | 'test_deposit').
 */
export function resolvePolicyAccessMode(input: {
  access_mode?: "free" | "test_deposit" | null;
  policy_mode?: "free_with_ad" | "deposit_with_ad" | null;
  deposit_amount_krw?: number | null;
  refund_eligible?: boolean | null;
}): {
  access_mode: "free" | "test_deposit";
  deposit_amount_krw: number;
  refund_eligible: boolean;
} {
  if (input.policy_mode === "free_with_ad" || input.access_mode === "free") {
    return {
      access_mode: "free",
      deposit_amount_krw: 0,
      refund_eligible: false,
    };
  }
  return {
    access_mode: "test_deposit",
    deposit_amount_krw:
      input.deposit_amount_krw !== undefined && input.deposit_amount_krw !== null
        ? input.deposit_amount_krw
        : 1000,
    refund_eligible:
      input.refund_eligible !== undefined && input.refund_eligible !== null
        ? input.refund_eligible
        : true,
  };
}

/**
 * Validation schema for creating a new access policy version for partner restroom
 */
export const createMerchantPolicySchema = z
  .object({
    access_mode: z
      .enum(["free", "test_deposit"], {
        message: "결제 방식은 free 또는 test_deposit이어야 합니다 (실거래 결제 금지).",
      })
      .optional(),
    policy_mode: z
      .enum(["free_with_ad", "deposit_with_ad"], {
        message: "정책 모드는 free_with_ad 또는 deposit_with_ad여야 합니다.",
      })
      .optional(),
    deposit_amount_krw: z
      .number()
      .int("보증금은 정수여야 합니다.")
      .min(0, "보증금은 0원 이상이어야 합니다.")
      .optional(),
    refund_eligible: z.boolean().optional(),
    receipt_window_hours: z
      .number()
      .int("영수증 제출 기한은 정수여야 합니다.")
      .min(1, "최소 1시간 이상이어야 합니다.")
      .max(168, "최대 168시간(7일) 이내여야 합니다.")
      .optional()
      .nullable(),
    min_purchase_krw: z
      .number()
      .int("최소 구매 금액은 정수여야 합니다.")
      .min(0, "최소 구매 금액은 0원 이상이어야 합니다.")
      .optional()
      .nullable(),
    is_active: z.boolean().default(true),
  })
  .strict()
  .refine(
    (data) => data.access_mode !== undefined || data.policy_mode !== undefined,
    { message: "access_mode 또는 policy_mode 중 하나는 필수입니다." }
  )
  .refine(
    (data) => {
      const isFree =
        data.policy_mode === "free_with_ad" || data.access_mode === "free";
      if (!isFree && data.deposit_amount_krw !== undefined) {
        return data.deposit_amount_krw > 0;
      }
      return true;
    },
    {
      message: "테스트 보증금 모드에서는 보증금을 1원 이상으로 입력해 주세요.",
      path: ["deposit_amount_krw"],
    }
  );

export type CreateMerchantPolicyInput = z.infer<typeof createMerchantPolicySchema>;

