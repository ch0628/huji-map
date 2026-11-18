import { z } from "zod";

const LATITUDE_MIN = -90;
const LATITUDE_MAX = 90;
const LONGITUDE_MIN = -180;
const LONGITUDE_MAX = 180;

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
      .number({ message: "위도를 숫자로 입력해 주세요." })
      .min(LATITUDE_MIN, `위도는 ${LATITUDE_MIN} 이상이어야 합니다.`)
      .max(LATITUDE_MAX, `위도는 ${LATITUDE_MAX} 이하여야 합니다.`),
    longitude: z
      .number({ message: "경도를 숫자로 입력해 주세요." })
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
  })
  .strict();

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
      .number({ message: "위도를 숫자로 입력해 주세요." })
      .min(LATITUDE_MIN, `위도는 ${LATITUDE_MIN} 이상이어야 합니다.`)
      .max(LATITUDE_MAX, `위도는 ${LATITUDE_MAX} 이하여야 합니다.`)
      .optional(),
    longitude: z
      .number({ message: "경도를 숫자로 입력해 주세요." })
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
  })
  .strict();

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
  );

export type CreateMerchantPolicyInput = z.infer<typeof createMerchantPolicySchema>;

