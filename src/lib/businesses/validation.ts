import { z } from "zod";

/**
 * Coordinate and input validation schemas for Businesses
 * Based on docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, and docs/08_SECURITY_OPERATIONS.md
 */

const LATITUDE_MIN = -90;
const LATITUDE_MAX = 90;
const LONGITUDE_MIN = -180;
const LONGITUDE_MAX = 180;

function isZeroZeroPlaceholder(lat: number, lng: number): boolean {
  return lat === 0 && lng === 0;
}

/** Mirrors the CHECK constraints in 20261108000000_business_backend.sql. */
const REGISTRATION_NUMBER_REGEX = /^[0-9]{3}-?[0-9]{2}-?[0-9]{5}$/;
const HTTP_URL_REGEX = /^https?:\/\//i;

export const createBusinessSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "가게명은 최소 1자 이상이어야 합니다.")
      .max(100, "가게명은 최대 100자까지 입력할 수 있습니다."),
    category: z
      .string()
      .trim()
      .min(1, "업종을 입력해 주세요.")
      .max(50, "업종은 최대 50자까지 입력할 수 있습니다."),
    description: z
      .string()
      .trim()
      .max(1000, "가게 설명은 최대 1,000자까지 입력할 수 있습니다.")
      .optional()
      .nullable(),
    road_address: z
      .string()
      .trim()
      .min(1, "도로명주소를 입력해 주세요.")
      .max(200, "도로명주소는 최대 200자까지 입력할 수 있습니다."),
    jibun_address: z
      .string()
      .trim()
      .max(200, "지번주소는 최대 200자까지 입력할 수 있습니다.")
      .optional()
      .nullable(),
    address_detail: z
      .string()
      .trim()
      .max(100, "상세주소는 최대 100자까지 입력할 수 있습니다.")
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
    phone: z
      .string()
      .trim()
      .max(30, "전화번호는 최대 30자까지 입력할 수 있습니다.")
      .optional()
      .nullable(),
    website_url: z
      .string()
      .trim()
      .max(300, "웹사이트 URL은 최대 300자까지 입력할 수 있습니다.")
      .regex(HTTP_URL_REGEX, "웹사이트 URL은 http:// 또는 https://로 시작해야 합니다.")
      .optional()
      .nullable(),
    // 사업자등록번호는 private 검증 근거로만 저장되며 응답/로그에 노출하지 않는다.
    // 영업 리드(lead) 연결은 관리자 전용 흐름(TASK 08)에서만 수행하므로 클라이언트 입력으로 받지 않는다.
    registration_number: z
      .string()
      .trim()
      .regex(
        REGISTRATION_NUMBER_REGEX,
        "사업자등록번호는 000-00-00000 형식(숫자 10자리)이어야 합니다."
      )
      .optional()
      .nullable(),
  })
  .superRefine((data, ctx) => {
    if (isZeroZeroPlaceholder(data.latitude, data.longitude)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "임의 좌표(0, 0)는 저장할 수 없습니다. 주소 검색을 통해 위치를 선택해 주세요.",
        path: ["latitude"],
      });
    }
  });

export type CreateBusinessInput = z.infer<typeof createBusinessSchema>;

export const updateBusinessSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "가게명은 최소 1자 이상이어야 합니다.")
      .max(100, "가게명은 최대 100자까지 입력할 수 있습니다.")
      .optional(),
    category: z
      .string()
      .trim()
      .min(1, "업종을 입력해 주세요.")
      .max(50, "업종은 최대 50자까지 입력할 수 있습니다.")
      .optional(),
    description: z
      .string()
      .trim()
      .max(1000, "가게 설명은 최대 1,000자까지 입력할 수 있습니다.")
      .nullable()
      .optional(),
    road_address: z
      .string()
      .trim()
      .min(1, "도로명주소를 입력해 주세요.")
      .max(200, "도로명주소는 최대 200자까지 입력할 수 있습니다.")
      .optional(),
    jibun_address: z
      .string()
      .trim()
      .max(200, "지번주소는 최대 200자까지 입력할 수 있습니다.")
      .nullable()
      .optional(),
    address_detail: z
      .string()
      .trim()
      .max(100, "상세주소는 최대 100자까지 입력할 수 있습니다.")
      .nullable()
      .optional(),
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
    phone: z
      .string()
      .trim()
      .max(30, "전화번호는 최대 30자까지 입력할 수 있습니다.")
      .nullable()
      .optional(),
    website_url: z
      .string()
      .trim()
      .max(300, "웹사이트 URL은 최대 300자까지 입력할 수 있습니다.")
      .regex(HTTP_URL_REGEX, "웹사이트 URL은 http:// 또는 https://로 시작해야 합니다.")
      .nullable()
      .optional(),
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
    if (hasLat && hasLng && isZeroZeroPlaceholder(data.latitude!, data.longitude!)) {
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

export type UpdateBusinessInput = z.infer<typeof updateBusinessSchema>;

export const submitBusinessSchema = z
  .object({
    confirm: z.boolean().optional(),
    notes: z.string().trim().max(500, "메모는 최대 500자까지 입력할 수 있습니다.").optional(),
  })
  .optional();

export type SubmitBusinessInput = z.infer<typeof submitBusinessSchema>;

export const adminBusinessDecisionSchema = z
  .object({
    decision: z.enum(["approved", "rejected"], {
      message: "결정(decision)은 'approved' 또는 'rejected' 중 하나여야 합니다.",
    }),
    rejection_reason: z
      .string()
      .trim()
      .max(1000, "반려 사유는 최대 1,000자까지 입력할 수 있습니다.")
      .optional()
      .nullable(),
    review_notes: z
      .string()
      .trim()
      .max(1000, "검토 메모는 최대 1,000자까지 입력할 수 있습니다.")
      .optional()
      .nullable(),
  })
  .refine(
    (data) => {
      if (data.decision === "rejected") {
        return Boolean(data.rejection_reason && data.rejection_reason.trim().length > 0);
      }
      return true;
    },
    {
      message: "반려 처리 시 반려 사유(rejection_reason)는 필수 입력 사항입니다.",
      path: ["rejection_reason"],
    }
  );

export type AdminBusinessDecisionInput = z.infer<typeof adminBusinessDecisionSchema>;

export const adminBusinessListFilterSchema = z.object({
  status: z
    .enum(["all", "pending", "approved", "rejected", "suspended", "draft"])
    .optional()
    .default("pending"),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

export type AdminBusinessListFilter = z.input<typeof adminBusinessListFilterSchema>;

