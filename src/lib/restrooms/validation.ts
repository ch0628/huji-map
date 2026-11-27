import { z } from "zod";

/**
 * Zod validation schemas for Restrooms, Hours, Policies, and Photos
 * Based on docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/08_SECURITY_OPERATIONS.md,
 * docs/11_DECISIONS.md, and tasks/09_restroom_schema.md
 */

const LATITUDE_MIN = -90;
const LATITUDE_MAX = 90;
const LONGITUDE_MIN = -180;
const LONGITUDE_MAX = 180;

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const DATE_REGEX = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export const createRestroomSchema = z
  .object({
    type: z.enum(["public", "partner"], {
      message: "화장실 종류는 public 또는 partner여야 합니다.",
    }),
    business_id: z
      .string()
      .uuid("유효한 가게 UUID를 입력해 주세요.")
      .optional()
      .nullable(),
    source_id: z
      .string()
      .uuid("유효한 공공 출처 UUID를 입력해 주세요.")
      .optional()
      .nullable(),
    source_record_id: z
      .string()
      .trim()
      .max(100, "원천 식별자는 최대 100자까지 입력할 수 있습니다.")
      .optional()
      .nullable(),
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
      .number()
      .min(LATITUDE_MIN, `위도는 ${LATITUDE_MIN} 이상이어야 합니다.`)
      .max(LATITUDE_MAX, `위도는 ${LATITUDE_MAX} 이하여야 합니다.`)
      .optional()
      .nullable(),
    longitude: z
      .number()
      .min(LONGITUDE_MIN, `경도는 ${LONGITUDE_MIN} 이상이어야 합니다.`)
      .max(LONGITUDE_MAX, `경도는 ${LONGITUDE_MAX} 이하여야 합니다.`)
      .optional()
      .nullable(),
    floor: z
      .string()
      .trim()
      .max(50, "층 정보는 최대 50자까지 입력할 수 있습니다.")
      .optional()
      .nullable(),
    entrance_instructions: z
      .string()
      .trim()
      .max(1000, "입구 설명은 최대 1,000자까지 입력할 수 있습니다.")
      .optional()
      .nullable(),
    gender_type: z
      .enum(["male", "female", "separate", "unisex", "unknown"])
      .default("unknown"),
    wheelchair_accessible: z.boolean().nullable().optional(),
    baby_changing_available: z.boolean().nullable().optional(),
    sanitary_products_available: z.boolean().nullable().optional(),
    access_method: z
      .enum(["open", "ask_staff", "pin"])
      .default("open"),
    publication_status: z
      .enum(["draft", "pending", "published", "suspended", "archived"])
      .default("draft"),
  })
  .superRefine((data, ctx) => {
    // 1) Type-to-reference exclusivity
    if (data.type === "partner") {
      if (!data.business_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "제휴 화장실은 연계된 가게(business_id)가 필수입니다.",
          path: ["business_id"],
        });
      }
      if (data.source_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "제휴 화장실은 공공 출처(source_id)를 가질 수 없습니다.",
          path: ["source_id"],
        });
      }
    } else if (data.type === "public") {
      if (!data.source_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "공공 화장실은 공공 데이터 출처(source_id)가 필수입니다.",
          path: ["source_id"],
        });
      }
      if (data.business_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "공공 화장실은 제휴 가게(business_id)를 가질 수 없습니다.",
          path: ["business_id"],
        });
      }
      // Public restrooms cannot have PIN access method
      if (data.access_method === "pin") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "공공 화장실은 PIN 출입 방식을 사용할 수 없습니다.",
          path: ["access_method"],
        });
      }
    }

    // 2) Coordinates consistency
    const hasLat = data.latitude !== null && data.latitude !== undefined;
    const hasLng = data.longitude !== null && data.longitude !== undefined;
    if ((hasLat && !hasLng) || (!hasLat && hasLng)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "위도와 경도는 함께 제공되거나 둘 다 비워두어야 합니다.",
        path: ["latitude"],
      });
    }

    if (data.publication_status === "published" && (!hasLat || !hasLng)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "공개(published) 화장실은 유효한 위도와 경도가 필수입니다.",
        path: ["latitude"],
      });
    }
  });

export const updateRestroomSchema = z.object({
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
    .number()
    .min(LATITUDE_MIN, `위도는 ${LATITUDE_MIN} 이상이어야 합니다.`)
    .max(LATITUDE_MAX, `위도는 ${LATITUDE_MAX} 이하여야 합니다.`)
    .optional(),
  longitude: z
    .number()
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
    .max(1000, "입구 설명은 최대 1,000자까지 입력할 수 있습니다.")
    .optional()
    .nullable(),
  gender_type: z
    .enum(["male", "female", "separate", "unisex", "unknown"])
    .optional(),
  wheelchair_accessible: z.boolean().nullable().optional(),
  baby_changing_available: z.boolean().nullable().optional(),
  sanitary_products_available: z.boolean().nullable().optional(),
  access_method: z.enum(["open", "ask_staff", "pin"]).optional(),
});

export const restroomHourSchema = z
  .object({
    restroom_id: z.string().uuid("유효한 화장실 UUID를 입력해 주세요."),
    weekday: z
      .number()
      .int()
      .min(0, "요일은 0(일요일)부터 6(토요일) 사이여야 합니다.")
      .max(6, "요일은 0(일요일)부터 6(토요일) 사이여야 합니다."),
    opens_at: z
      .string()
      .regex(TIME_REGEX, "올바른 시간 형식(HH:MM 또는 HH:MM:SS)을 입력해 주세요.")
      .optional()
      .nullable(),
    closes_at: z
      .string()
      .regex(TIME_REGEX, "올바른 시간 형식(HH:MM 또는 HH:MM:SS)을 입력해 주세요.")
      .optional()
      .nullable(),
    is_closed: z.boolean().default(false),
    crosses_midnight: z.boolean().default(false),
  })
  .refine(
    (data) => {
      if (data.is_closed) return true;
      return Boolean(data.opens_at && data.closes_at);
    },
    {
      message: "휴무가 아닌 경우 여는 시간과 닫는 시간이 모두 필요합니다.",
      path: ["opens_at"],
    }
  );

export const restroomHourExceptionSchema = z
  .object({
    restroom_id: z.string().uuid("유효한 화장실 UUID를 입력해 주세요."),
    exception_date: z
      .string()
      .regex(DATE_REGEX, "올바른 날짜 형식(YYYY-MM-DD)을 입력해 주세요."),
    is_closed: z.boolean().default(false),
    opens_at: z
      .string()
      .regex(TIME_REGEX, "올바른 시간 형식(HH:MM 또는 HH:MM:SS)을 입력해 주세요.")
      .optional()
      .nullable(),
    closes_at: z
      .string()
      .regex(TIME_REGEX, "올바른 시간 형식(HH:MM 또는 HH:MM:SS)을 입력해 주세요.")
      .optional()
      .nullable(),
    reason: z
      .string()
      .trim()
      .max(500, "사유는 최대 500자까지 입력할 수 있습니다.")
      .optional()
      .nullable(),
  })
  .refine(
    (data) => {
      if (data.is_closed) return true;
      return Boolean(data.opens_at && data.closes_at);
    },
    {
      message: "휴무가 아닌 경우 여는 시간과 닫는 시간이 모두 필요합니다.",
      path: ["opens_at"],
    }
  );

export const restroomAccessPolicySchema = z
  .object({
    restroom_id: z.string().uuid("유효한 화장실 UUID를 입력해 주세요."),
    version: z.number().int().min(1, "버전은 1 이상이어야 합니다.").default(1),
    access_mode: z.enum(["free", "test_deposit", "real_deposit"], {
      message: "올바른 이용 방식(free, test_deposit)을 선택해 주세요.",
    }),
    deposit_amount_krw: z
      .number()
      .int()
      .min(0, "보증금은 0원 이상이어야 합니다.")
      .optional()
      .nullable(),
    refund_eligible: z.boolean().default(false),
    receipt_window_hours: z
      .number()
      .int()
      .min(1, "영수증 제출 기한은 1시간 이상이어야 합니다.")
      .optional()
      .nullable(),
    min_purchase_krw: z
      .number()
      .int()
      .min(0, "최소 구매금액은 0원 이상이어야 합니다.")
      .optional()
      .nullable(),
    is_active: z.boolean().default(false),
    effective_from: z.string().datetime({
      message: "유효 시작 시각은 올바른 ISO 날짜-시각 형식이어야 합니다.",
    }),
  })
  .superRefine((data, ctx) => {
    // Real money deposit mode is strictly prohibited
    if (data.access_mode === "real_deposit") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "실거래 보증금 모드는 현재 비활성화되어 있습니다.",
        path: ["access_mode"],
      });
    }

    if (data.access_mode === "free") {
      if (data.deposit_amount_krw && data.deposit_amount_krw > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "무료 이용 방식은 보증금을 0원 또는 비워두어야 합니다.",
          path: ["deposit_amount_krw"],
        });
      }
      if (data.refund_eligible) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "무료 이용 방식은 환급 대상이 될 수 없습니다.",
          path: ["refund_eligible"],
        });
      }
    } else if (data.access_mode === "test_deposit") {
      if (!data.deposit_amount_krw || data.deposit_amount_krw <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "테스트 보증금 모드는 0원 초과의 보증금 금액이 필요합니다.",
          path: ["deposit_amount_krw"],
        });
      }
    }
  });

export const restroomPhotoSchema = z.object({
  restroom_id: z.string().uuid("유효한 화장실 UUID를 입력해 주세요."),
  storage_path: z
    .string()
    .trim()
    .min(1, "저장 경로를 입력해 주세요.")
    .max(500, "저장 경로는 최대 500자까지 입력할 수 있습니다."),
  photo_type: z
    .enum(["exterior", "entrance", "interior", "signage", "other"])
    .default("other"),
  is_primary: z.boolean().default(false),
  moderation_status: z
    .enum(["pending", "approved", "rejected"])
    .default("pending"),
});

export const MAX_NEARBY_RADIUS_M = 400;
export const DEFAULT_NEARBY_RADIUS_M = 400;
export const DEFAULT_BBOX_LIMIT = 50;
export const DEFAULT_NEARBY_LIMIT = 100;
export const MAX_CATALOG_LIMIT = 100;

const optionalCoordinateNumber = (fieldLabel: string) =>
  z.preprocess(
    (val) => {
      if (val === undefined || val === null) return undefined;
      if (typeof val === "string" && val.trim() === "") return NaN;
      return val;
    },
    z.coerce
      .number({ message: `${fieldLabel}은(는) 유효한 숫자여야 합니다.` })
      .finite(`${fieldLabel}은(는) 유한한 숫자여야 합니다.`)
      .optional()
  );

const optionalRadiusNumber = z.preprocess(
  (val) => {
    if (val === undefined || val === null) return undefined;
    if (typeof val === "string" && val.trim() === "") return NaN;
    return val;
  },
  z.coerce
    .number({ message: "반경(radiusM)은 유효한 숫자여야 합니다." })
    .int("반경(radiusM)은 정수여야 합니다.")
    .min(1, "반경(radiusM)은 1m 이상이어야 합니다.")
    .max(
      MAX_NEARBY_RADIUS_M,
      `반경(radiusM)은 최대 ${MAX_NEARBY_RADIUS_M}m까지 조회할 수 있습니다.`
    )
    .optional()
);

/**
 * Query schema for GET /api/v1/restrooms
 * Supports:
 * - Nearby mode: ?centerLat=...&centerLng=...&radiusM=400&type=all|public|partner&limit=100&offset=0
 * - Legacy BBox mode: ?bbox=south,west,north,east&type=all|public|partner&limit=50&offset=0
 */
export const catalogQuerySchema = z
  .object({
    bbox: z.string().optional(),
    centerLat: optionalCoordinateNumber("중심 위도(centerLat)"),
    centerLng: optionalCoordinateNumber("중심 경도(centerLng)"),
    radiusM: optionalRadiusNumber,
    type: z.enum(["all", "public", "partner"]).default("all"),
    limit: z.coerce
      .number()
      .int("조회 개수는 정수여야 합니다.")
      .min(1, "최소 1개 이상 조회해야 합니다.")
      .max(MAX_CATALOG_LIMIT, `최대 ${MAX_CATALOG_LIMIT}개까지 조회할 수 있습니다.`)
      .optional(),
    offset: z.coerce
      .number()
      .int("오프셋은 정수여야 합니다.")
      .min(0, "오프셋은 0 이상이어야 합니다.")
      .default(0),
    page: z.coerce
      .number()
      .int("페이지 번호는 정수여야 합니다.")
      .min(1, "페이지 번호는 1 이상이어야 합니다.")
      .optional(),
  })
  .transform((data) => {
    const isNearby =
      data.centerLat !== undefined && data.centerLng !== undefined;
    const resolvedLimit =
      data.limit ?? (isNearby ? DEFAULT_NEARBY_LIMIT : DEFAULT_BBOX_LIMIT);
    const resolvedRadiusM = isNearby
      ? (data.radiusM ?? DEFAULT_NEARBY_RADIUS_M)
      : data.radiusM;
    const calculatedOffset =
      data.page !== undefined ? (data.page - 1) * resolvedLimit : data.offset;
    return {
      ...data,
      limit: resolvedLimit,
      radiusM: resolvedRadiusM,
      offset: calculatedOffset,
    };
  })
  .superRefine((data, ctx) => {
    const hasCenterLat = data.centerLat !== undefined;
    const hasCenterLng = data.centerLng !== undefined;

    if (hasCenterLat !== hasCenterLng) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "중심 좌표(centerLat, centerLng)는 함께 제공되어야 합니다.",
        path: [hasCenterLat ? "centerLng" : "centerLat"],
      });
      return;
    }

    if (hasCenterLat && hasCenterLng) {
      if (data.centerLat! < LATITUDE_MIN || data.centerLat! > LATITUDE_MAX) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `중심 위도(centerLat)는 ${LATITUDE_MIN}에서 ${LATITUDE_MAX} 사이여야 합니다.`,
          path: ["centerLat"],
        });
      }
      if (data.centerLng! < LONGITUDE_MIN || data.centerLng! > LONGITUDE_MAX) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `중심 경도(centerLng)는 ${LONGITUDE_MIN}에서 ${LONGITUDE_MAX} 사이여야 합니다.`,
          path: ["centerLng"],
        });
      }
    }

    if (data.bbox === undefined) {
      if (!hasCenterLat || !hasCenterLng) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "지도 영역(bbox) 또는 중심 좌표(centerLat, centerLng)가 필요합니다.",
          path: ["bbox"],
        });
      }
      return;
    }

    const parts = data.bbox.split(",").map((p) => p.trim());
    if (parts.length !== 4 || parts.some((p) => p === "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "bbox는 'south,west,north,east' 형식이어야 합니다.",
        path: ["bbox"],
      });
      return;
    }

    const [south, west, north, east] = parts.map(Number);
    if (
      Number.isNaN(south) ||
      Number.isNaN(west) ||
      Number.isNaN(north) ||
      Number.isNaN(east)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "bbox의 모든 좌표는 유효한 숫자여야 합니다.",
        path: ["bbox"],
      });
      return;
    }

    if (south < LATITUDE_MIN || south > LATITUDE_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `남단 위도(south)는 ${LATITUDE_MIN}에서 ${LATITUDE_MAX} 사이여야 합니다.`,
        path: ["bbox"],
      });
    }

    if (north < LATITUDE_MIN || north > LATITUDE_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `북단 위도(north)는 ${LATITUDE_MIN}에서 ${LATITUDE_MAX} 사이여야 합니다.`,
        path: ["bbox"],
      });
    }

    if (west < LONGITUDE_MIN || west > LONGITUDE_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `서단 경도(west)는 ${LONGITUDE_MIN}에서 ${LONGITUDE_MAX} 사이여야 합니다.`,
        path: ["bbox"],
      });
    }

    if (east < LONGITUDE_MIN || east > LONGITUDE_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `동단 경도(east)는 ${LONGITUDE_MIN}에서 ${LONGITUDE_MAX} 사이여야 합니다.`,
        path: ["bbox"],
      });
    }

    if (south > north) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "남단 위도(south)는 북단 위도(north)보다 작거나 같아야 합니다.",
        path: ["bbox"],
      });
    }

    if (west > east) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "서단 경도(west)는 동단 경도(east)보다 작거나 같아야 합니다.",
        path: ["bbox"],
      });
    }

    // Maximum bounding box span limit (1.0 degree ≈ 111km) to avoid full table scans
    const MAX_SPAN_DEG = 1.0;
    if (north - south > MAX_SPAN_DEG || east - west > MAX_SPAN_DEG) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `검색 영역(bbox)이 너무 넓습니다. 위도·경도 각 방향 최대 ${MAX_SPAN_DEG}도 이내로 요청해 주세요.`,
        path: ["bbox"],
      });
    }
  });

export type CatalogQueryInput = z.infer<typeof catalogQuerySchema>;

export interface ParsedBBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export function parseBBoxString(bbox: string): ParsedBBox {
  const [south, west, north, east] = bbox.split(",").map((p) => Number(p.trim()));
  return { south, west, north, east };
}

/**
 * Query schema for GET /api/v1/restrooms/search
 * Format: ?q=keyword&type=all|public|partner&limit=10
 */
export const restroomSearchQuerySchema = z.object({
  q: z
    .string({ message: "검색어(q) 파라미터가 필요합니다." })
    .trim()
    .min(1, "검색어를 1자 이상 입력해 주세요.")
    .max(100, "검색어는 최대 100자까지 입력할 수 있습니다."),
  type: z.enum(["all", "public", "partner"]).default("all"),
  limit: z.coerce
    .number()
    .int("조회 개수는 정수여야 합니다.")
    .min(1, "최소 1개 이상 조회해야 합니다.")
    .max(30, "최대 30개까지 조회할 수 있습니다.")
    .default(10),
});

export type RestroomSearchQueryInput = z.infer<typeof restroomSearchQuerySchema>;

/**
 * Query schema for GET /api/v1/restrooms/candidates
 * Format: ?bbox=south,west,north,east&q=keyword&limit=20
 * Note: Wide bbox spans are validated syntactically here and handled gracefully as `tooWide: true` in service.
 */
export const candidateViewportQuerySchema = z
  .object({
    bbox: z
      .string({ message: "지도 영역(bbox) 파라미터가 필요합니다." })
      .trim()
      .min(1, "지도 영역(bbox) 파라미터가 필요합니다."),
    q: z.string().trim().max(100, "검색어는 최대 100자까지 입력할 수 있습니다.").optional(),
    limit: z.coerce
      .number()
      .int("조회 개수는 정수여야 합니다.")
      .min(1, "최소 1개 이상 조회해야 합니다.")
      .max(40, "한 화면에 최대 40개까지 후보를 조회할 수 있습니다.")
      .default(20),
    cursor: z.string().trim().max(2400, "cursor 길이가 허용 범위를 초과했습니다.").optional(),
    excludeIds: z
      .string()
      .trim()
      .max(10000, "excludeIds 길이가 허용 범위를 초과했습니다.")
      .optional(),
  })
  .superRefine((data, ctx) => {
    const parts = data.bbox.split(",").map((p) => p.trim());
    if (parts.length !== 4) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "bbox는 south,west,north,east 형식의 4개 숫자여야 합니다.",
        path: ["bbox"],
      });
      return;
    }

    const nums = parts.map((p) => Number(p));
    if (nums.some((n) => Number.isNaN(n) || !Number.isFinite(n))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "bbox 좌표는 유효한 숫자여야 합니다.",
        path: ["bbox"],
      });
      return;
    }

    const [south, west, north, east] = nums;
    if (south < -90 || south > 90 || north < -90 || north > 90) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "위도 범위는 -90에서 90 사이여야 합니다.",
        path: ["bbox"],
      });
    }
    if (west < -180 || west > 180 || east < -180 || east > 180) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "경도 범위는 -180에서 180 사이여야 합니다.",
        path: ["bbox"],
      });
    }
    if (south > north) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "남단 위도(south)는 북단 위도(north)보다 작거나 같아야 합니다.",
        path: ["bbox"],
      });
    }
    if (west > east) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "서단 경도(west)는 동단 경도(east)보다 작거나 같아야 합니다.",
        path: ["bbox"],
      });
    }
  });

export type CandidateViewportQueryInput = z.infer<typeof candidateViewportQuerySchema>;

const SAFE_CANDIDATE_ID_RE = /^[a-zA-Z0-9_:-]{1,64}$/;

export function parseCandidateExcludeIds(raw?: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (!id || !SAFE_CANDIDATE_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 220) break;
  }
  return out;
}


