/**
 * Zod validation schemas for event ingestion, visitor sessions, and travel answers.
 * Spec: docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/06_EVENTS_AND_PMF.md, docs/08_SECURITY_OPERATIONS.md
 */

import { z } from "zod";
import {
  DIRECT_CLIENT_EVENTS,
  SERVER_ONLY_EVENTS,
} from "./types";

/**
 * Forbidden keys that MUST NOT appear anywhere in event properties.
 * Prevents PII, authentication tokens, payment details, doorlock PINs, and continuous GPS trails.
 */
export const FORBIDDEN_PROPERTY_KEYS = [
  "pin",
  "password",
  "secret",
  "secret_key",
  "token",
  "card",
  "card_number",
  "cvv",
  "payment_key",
  "provider_payment_key",
  "receipt_image",
  "receipt_data",
  "email",
  "phone",
  "phone_number",
  "lat",
  "lng",
  "latitude",
  "longitude",
  "coords",
  "gps_trail",
] as const;

/**
 * Event-type specific allowed property keys.
 * Enforces least-privilege telemetry and prevents arbitrary payload injection.
 */
export const ALLOWED_EVENT_PROPERTY_KEYS: Record<string, string[]> = {
  landing_view: [
    "landing_path",
    "referrer",
    "device_type",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
  ],
  map_loaded: ["zoom", "restroom_count", "filter", "center_region"],
  restroom_marker_clicked: ["restroom_id", "type", "marker_index", "access_method"],
  restroom_card_viewed: ["card_type", "visibility_rule_version", "restroom_id", "source"],
  restroom_detail_opened: ["restroom_id", "type", "source_component"],
  directions_clicked: ["service", "restroom_id", "type", "has_origin"],
  payment_button_clicked: ["restroom_id", "policy_id", "deposit_amount_krw"],
  payment_unavailable_shown: ["restroom_id", "reason"],
  checkout_opened: ["restroom_id", "policy_id", "deposit_amount_krw"],
  receipt_upload_clicked: ["restroom_id", "access_session_id"],
  business_registration_submitted: ["business_id"],
  travel_answer_submitted: ["traveling_now", "server_verified"],
};

/**
 * Checks whether an object contains any forbidden property keys (case-insensitive & recursive across objects and arrays).
 */
export function containsForbiddenKeys(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;

  const stack: unknown[] = [obj];
  const forbiddenSet = new Set<string>(FORBIDDEN_PROPERTY_KEYS.map((k) => k.toLowerCase()));

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;

    if (Array.isArray(current)) {
      for (const item of current) {
        if (typeof item === "object" && item !== null) stack.push(item);
      }
      continue;
    }

    for (const [key, val] of Object.entries(current as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      if (forbiddenSet.has(lower)) {
        return true;
      }
      if (val && typeof val === "object") {
        stack.push(val);
      }
    }
  }

  return false;
}

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const uuidSchema = z.string().regex(uuidRegex, "유효한 UUID 형식이어야 합니다.");

export const optionalUuidSchema = z
  .string()
  .optional()
  .nullable()
  .refine((val) => !val || val === "" || uuidRegex.test(val), {
    message: "유효한 UUID 형식이어야 합니다.",
  })
  .transform((val) => (val && val.trim() !== "" ? val : null));

/**
 * Context validation schema
 */
export const eventContextSchema = z
  .object({
    businessId: optionalUuidSchema,
    business_id: optionalUuidSchema,
    restroomId: optionalUuidSchema,
    restroom_id: optionalUuidSchema,
    accessSessionId: optionalUuidSchema,
    access_session_id: optionalUuidSchema,
    experimentKey: z.string().max(100).optional().nullable(),
    experiment_key: z.string().max(100).optional().nullable(),
    pagePath: z.string().max(500).optional().nullable(),
    page_path: z.string().max(500).optional().nullable(),
    componentId: z.string().max(100).optional().nullable(),
    component_id: z.string().max(100).optional().nullable(),
  })
  .passthrough()
  .optional()
  .nullable()
  .transform((data) => {
    if (!data) return {};
    const rawPath = data.pagePath ?? data.page_path ?? null;
    return {
      businessId: data.businessId ?? data.business_id ?? null,
      restroomId: data.restroomId ?? data.restroom_id ?? null,
      accessSessionId: data.accessSessionId ?? data.access_session_id ?? null,
      experimentKey: data.experimentKey ?? data.experiment_key ?? null,
      pagePath: rawPath,
      componentId: data.componentId ?? data.component_id ?? null,
    };
  })
  .refine(
    (ctx) => {
      if (!ctx.pagePath) return true;
      const lower = ctx.pagePath.toLowerCase();
      return !lower.includes("pin=") && !lower.includes("password=") && !lower.includes("token=") && !lower.includes("secret=");
    },
    {
      message: "pagePath에 민감한 매개변수(pin, password, token, secret)를 포함할 수 없습니다.",
      path: ["pagePath"],
    }
  );

/**
 * Client event payload schema
 */
export const clientEventPayloadSchema = z
  .object({
    clientEventId: z.string().optional(),
    client_event_id: z.string().optional(),
    eventName: z.string().optional(),
    event_name: z.string().optional(),
    eventVersion: z.number().int().min(1).max(100).optional(),
    event_version: z.number().int().min(1).max(100).optional(),
    browserId: optionalUuidSchema,
    browser_id: optionalUuidSchema,
    sessionId: optionalUuidSchema,
    session_id: optionalUuidSchema,
    userId: optionalUuidSchema,
    user_id: optionalUuidSchema,
    context: eventContextSchema,
    properties: z
      .record(z.string(), z.unknown())
      .optional()
      .nullable()
      .default({})
      .superRefine((val, ctx) => {
        if (!val) return;
        const serialized = JSON.stringify(val);
        if (serialized.length > 4096) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "이벤트 속성(properties) 크기는 4KB 이하여야 합니다.",
          });
        }
        if (containsForbiddenKeys(val)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "이벤트 속성에 금지된 개인정보(전화번호/이메일), 비밀값(PIN/토큰/결제키), 또는 정밀 GPS 정보가 포함되어 있습니다.",
          });
        }
      }),
    occurredAt: z.string().optional(),
    occurred_at: z.string().optional(),
    isTest: z.boolean().optional(),
    is_test: z.boolean().optional(),
  })
  .passthrough()
  .transform((data) => {
    const rawClientEventId = data.clientEventId ?? data.client_event_id;
    const rawEventName = data.eventName ?? data.event_name;
    const rawEventVersion = data.eventVersion ?? data.event_version ?? 1;
    const rawBrowserId = data.browserId ?? data.browser_id ?? null;
    const rawSessionId = data.sessionId ?? data.session_id ?? null;
    const rawUserId = data.userId ?? data.user_id ?? null;
    const rawOccurredAt = data.occurredAt ?? data.occurred_at;
    const rawIsTest = data.isTest ?? data.is_test ?? false;

    return {
      clientEventId: rawClientEventId,
      eventName: rawEventName,
      eventVersion: rawEventVersion,
      browserId: rawBrowserId,
      sessionId: rawSessionId,
      userId: rawUserId,
      context: data.context ?? {},
      properties: data.properties ?? {},
      occurredAt: rawOccurredAt,
      isTest: rawIsTest,
    };
  })
  .superRefine((data, ctx) => {
    // 1. clientEventId format
    if (!data.clientEventId || !uuidRegex.test(data.clientEventId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clientEventId"],
        message: "유효한 UUID 형식의 clientEventId가 필요합니다.",
      });
    }

    // 2. eventName checks
    if (!data.eventName || typeof data.eventName !== "string") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["eventName"],
        message: "eventName이 필요합니다.",
      });
      return;
    }

    const trimmed = data.eventName.trim();

    // H2 권위성: travel_answer_submitted는 PATCH /sessions/:id/travel-answer 전용
    if (trimmed === "travel_answer_submitted") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["eventName"],
        message: "travel_answer_submitted 이벤트는 PATCH /api/v1/sessions/:id/travel-answer 엔드포인트를 통해서만 권위적으로 기록할 수 있습니다.",
      });
      return;
    }

    // Check if client tried to emit a server-only event
    if (SERVER_ONLY_EVENTS.includes(trimmed as any)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["eventName"],
        message: `서버 전용 이벤트("${trimmed}")는 클라이언트에서 직접 수집할 수 없습니다.`,
      });
      return;
    }

    // Check if event is in the direct client allowlist
    if (!DIRECT_CLIENT_EVENTS.includes(trimmed as any)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["eventName"],
        message: `허용되지 않은 이벤트 이름입니다: "${trimmed}"`,
      });
      return;
    }

    // Check event-specific allowed property keys
    const allowedKeys = ALLOWED_EVENT_PROPERTY_KEYS[trimmed];
    if (allowedKeys && data.properties) {
      for (const propKey of Object.keys(data.properties)) {
        if (!allowedKeys.includes(propKey)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["properties", propKey],
            message: `이벤트 "${trimmed}"에 허용되지 않은 속성입니다: "${propKey}"`,
          });
        }
      }
    }

    // 3. occurredAt date validation
    if (data.occurredAt) {
      const parsed = Date.parse(data.occurredAt);
      if (isNaN(parsed)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["occurredAt"],
          message: "occurredAt은 유효한 ISO 8601 날짜 문자열이어야 합니다.",
        });
      } else {
        const now = Date.now();
        // Disallow occurredAt more than 10 minutes in the future
        if (parsed > now + 10 * 60 * 1000) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["occurredAt"],
            message: "occurredAt 시각이 미래일 수 없습니다.",
          });
        }
      }
    }
  });

export type ValidatedClientEvent = z.infer<typeof clientEventPayloadSchema>;

/**
 * Visitor session creation schema
 */
export const createVisitorSessionSchema = z
  .object({
    browserId: z.string().optional(),
    browser_id: z.string().optional(),
    landingPath: z.string().max(500).optional(),
    landing_path: z.string().max(500).optional(),
    referrer: z.string().max(1000).optional().nullable(),
    utmSource: z.string().max(100).optional().nullable(),
    utm_source: z.string().max(100).optional().nullable(),
    utmMedium: z.string().max(100).optional().nullable(),
    utm_medium: z.string().max(100).optional().nullable(),
    utmCampaign: z.string().max(100).optional().nullable(),
    utm_campaign: z.string().max(100).optional().nullable(),
    utmContent: z.string().max(100).optional().nullable(),
    utm_content: z.string().max(100).optional().nullable(),
    utmTerm: z.string().max(100).optional().nullable(),
    utm_term: z.string().max(100).optional().nullable(),
    deviceType: z.enum(["mobile", "tablet", "desktop", "unknown"]).optional(),
    device_type: z.enum(["mobile", "tablet", "desktop", "unknown"]).optional(),
    language: z.string().max(20).optional().nullable(),
    isTest: z.boolean().optional(),
    is_test: z.boolean().optional(),
    consent: z
      .object({
        analytics: z.boolean().optional(),
        marketing: z.boolean().optional(),
        terms: z.boolean().optional(),
        privacy: z.boolean().optional(),
        policyVersion: z.string().max(50).optional(),
        policy_version: z.string().max(50).optional(),
      })
      .optional()
      .nullable(),
  })
  .passthrough()
  .transform((data) => {
    const rawBrowserId = data.browserId ?? data.browser_id;
    const rawLandingPath = data.landingPath ?? data.landing_path ?? "/";
    const rawDeviceType = data.deviceType ?? data.device_type ?? "unknown";
    const rawIsTest = data.isTest ?? data.is_test ?? false;

    return {
      browserId: rawBrowserId,
      landingPath: rawLandingPath,
      referrer: data.referrer ?? null,
      utmSource: data.utmSource ?? data.utm_source ?? null,
      utmMedium: data.utmMedium ?? data.utm_medium ?? null,
      utmCampaign: data.utmCampaign ?? data.utm_campaign ?? null,
      utmContent: data.utmContent ?? data.utm_content ?? null,
      utmTerm: data.utmTerm ?? data.utm_term ?? null,
      deviceType: rawDeviceType,
      language: data.language ?? null,
      isTest: rawIsTest,
      consent: data.consent
        ? {
            analytics: data.consent.analytics,
            marketing: data.consent.marketing,
            terms: data.consent.terms,
            privacy: data.consent.privacy,
            policyVersion: data.consent.policyVersion ?? data.consent.policy_version ?? "2026-11-06",
          }
        : null,
    };
  })
  .superRefine((data, ctx) => {
    if (!data.browserId || !uuidRegex.test(data.browserId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["browserId"],
        message: "유효한 UUID 형식의 browserId가 필요합니다.",
      });
    }
  });

export type ValidatedVisitorSessionInput = z.infer<typeof createVisitorSessionSchema>;

/**
 * Travel answer submission schema
 */
export const travelAnswerSchema = z
  .object({
    travelingNow: z.boolean().optional(),
    traveling_now: z.boolean().optional(),
    browserId: optionalUuidSchema,
    browser_id: optionalUuidSchema,
    sessionToken: z.string().max(200).optional().nullable(),
    session_token: z.string().max(200).optional().nullable(),
    clientEventId: optionalUuidSchema,
    client_event_id: optionalUuidSchema,
  })
  .transform((data) => {
    const rawTravelingNow = data.travelingNow ?? data.traveling_now;
    const rawBrowserId = data.browserId ?? data.browser_id ?? null;
    const rawSessionToken = data.sessionToken ?? data.session_token ?? null;
    const rawClientEventId = data.clientEventId ?? data.client_event_id ?? null;
    return {
      travelingNow: rawTravelingNow,
      browserId: rawBrowserId,
      sessionToken: rawSessionToken,
      clientEventId: rawClientEventId,
    };
  })
  .superRefine((data, ctx) => {
    if (typeof data.travelingNow !== "boolean") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["travelingNow"],
        message: "travelingNow는 필수 boolean 값입니다.",
      });
    }
  });

export type ValidatedTravelAnswerInput = z.infer<typeof travelAnswerSchema>;
