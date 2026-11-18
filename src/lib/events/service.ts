/**
 * Server-side service for event ingestion, visitor session tracking, and PMF metrics logging.
 * Enforces security boundaries:
 * - Server-only execution for event recording RPCs
 * - Strict session ownership verification (authenticated user_id match or anonymous sessionToken/browserId match)
 * - Restricts client-sent events to the strict allowlist (blocks server-only events)
 * - H2 authoritative traveling_now separation (only PATCH API updates state & emits verified server event)
 * - Strips or rejects forbidden PII, credentials, continuous GPS trails, and unapproved property keys
 * - Enforces client_event_id idempotency (deduplicates identical events, rejects collisions)
 * - Enforces sliding window rate limits per browser/IP
 *
 * Spec: docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/06_EVENTS_AND_PMF.md, docs/08_SECURITY_OPERATIONS.md
 */

import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  EventIngestResult,
  SessionCreateResult,
  TravelAnswerResult,
} from "./types";
import {
  clientEventPayloadSchema,
  createVisitorSessionSchema,
  travelAnswerSchema,
  type ValidatedClientEvent,
  type ValidatedVisitorSessionInput,
  type ValidatedTravelAnswerInput,
} from "./validation";
import { checkRateLimit } from "./rate-limiter";

export class EventError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "EventError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Computes a SHA-256 hash of a string (for token verification).
 */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Ingests a client-side event.
 * Ensures user_id authenticity, session ownership, event allowlist, rate limiting, and duplicate handling.
 */
export async function ingestClientEvent(
  supabase: SupabaseClient<any>,
  rawPayload: unknown,
  authUserId: string | null = null,
  clientIp: string | null = null
): Promise<EventIngestResult> {
  // 1. Zod schema validation
  const parseResult = clientEventPayloadSchema.safeParse(rawPayload);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    const message = firstIssue?.message || "유효하지 않은 이벤트 데이터입니다.";
    const isServerOnly = message.includes("서버 전용 이벤트") || message.includes("travel_answer_submitted");
    throw new EventError(
      isServerOnly ? "FORBIDDEN_SERVER_EVENT" : "INVALID_EVENT_PAYLOAD",
      message,
      isServerOnly ? 403 : 400
    );
  }

  const data: ValidatedClientEvent = parseResult.data;

  // 2. Security: Verify user_id authenticity
  // Client is NEVER allowed to claim another user's ID or claim an ID when unauthenticated
  if (authUserId) {
    if (data.userId && data.userId !== authUserId) {
      throw new EventError(
        "FORBIDDEN_USER_ID_MISMATCH",
        "인증된 사용자와 다른 user_id로 이벤트를 기록할 수 없습니다.",
        403
      );
    }
  } else {
    if (data.userId) {
      throw new EventError(
        "UNAUTHORIZED_USER_ID",
        "비로그인 상태에서는 user_id를 지정할 수 없습니다.",
        401
      );
    }
  }

  const effectiveUserId = authUserId ?? null;

  // 3. Abuse prevention: Rate limiting (per browserId or client IP)
  const rateLimitKey = data.browserId || clientIp || "anonymous";
  const rateLimit = checkRateLimit(rateLimitKey, 60, 60_000); // 60 events / minute
  if (!rateLimit.allowed) {
    throw new EventError(
      "RATE_LIMIT_EXCEEDED",
      "과도한 이벤트 요청이 감지되었습니다. 잠시 후 다시 시도해 주세요.",
      429
    );
  }

  // 4. [보안 선행 검증] 세션 소유권 및 is_test 권위적 상태 검증
  let resolvedIsTest = false;
  if (data.sessionId) {
    const { data: session, error: sessionErr } = await supabase
      .from("visitor_sessions")
      .select("id, browser_id, user_id, is_test")
      .eq("id", data.sessionId)
      .maybeSingle();

    if (sessionErr || !session) {
      throw new EventError("INVALID_SESSION", "참조된 세션을 찾을 수 없습니다.", 400);
    }

    // 회원 세션에 타인 user_id 연결 시도 차단
    if (session.user_id && session.user_id !== effectiveUserId) {
      throw new EventError(
        "SESSION_OWNERSHIP_MISMATCH",
        "해당 세션은 다른 사용자에게 속해 있습니다.",
        403
      );
    }

    // 회원 세션에 익명 이벤트 위장 차단
    if (session.user_id && !effectiveUserId) {
      throw new EventError(
        "SESSION_OWNERSHIP_MISMATCH",
        "로그인된 회원의 세션에는 익명 이벤트를 기록할 수 없습니다.",
        403
      );
    }

    // 브라우저 식별자 불일치 차단
    if (session.browser_id && data.browserId && session.browser_id !== data.browserId) {
      throw new EventError(
        "SESSION_OWNERSHIP_MISMATCH",
        "세션의 브라우저 식별자와 일치하지 않습니다.",
        403
      );
    }

    // is_test는 세션의 권위적 상태 계승 (클라이언트 임의 조작 방지)
    resolvedIsTest = Boolean(session.is_test);
  } else {
    // 세션이 없는 독립 이벤트의 경우:
    // 프로덕션 환경에서는 클라이언트 임의의 isTest=true 지정으로 인한 분석 누락 방지 (기본 false 강제)
    const isEnvTest = process.env.NODE_ENV === "test" || process.env.NEXT_PUBLIC_APP_ENV === "test";
    resolvedIsTest = isEnvTest ? Boolean(data.isTest ?? true) : false;
  }

  // 5. Try atomic RPC if available in Supabase
  if (typeof supabase.rpc === "function") {
    try {
      const { data: rpcRes, error: rpcError } = await supabase.rpc(
        "log_client_event",
        {
          p_client_event_id: data.clientEventId,
          p_event_name: data.eventName,
          p_event_version: data.eventVersion ?? 1,
          p_browser_id: data.browserId,
          p_session_id: data.sessionId,
          p_user_id: effectiveUserId,
          p_business_id: data.context.businessId,
          p_restroom_id: data.context.restroomId,
          p_access_session_id: data.context.accessSessionId,
          p_experiment_key: data.context.experimentKey,
          p_page_path: data.context.pagePath,
          p_component_id: data.context.componentId,
          p_properties: data.properties,
          p_source: "client",
          p_is_test: resolvedIsTest,
          p_occurred_at: data.occurredAt ?? new Date().toISOString(),
        }
      );

      if (!rpcError && rpcRes) {
        return {
          clientEventId: rpcRes.client_event_id ?? (data.clientEventId as string),
          receivedAt: rpcRes.received_at ?? new Date().toISOString(),
          deduplicated: Boolean(rpcRes.deduplicated),
          id: rpcRes.id,
        };
      }

      // If RPC returned an error code for duplicate collision or permission
      if (rpcError) {
        if (rpcError.code === "23505" || rpcError.message?.includes("collision")) {
          throw new EventError(
            "EVENT_ID_COLLISION",
            "동일한 client_event_id로 다른 이벤트 데이터가 이미 등록되어 있습니다.",
            409
          );
        }
        if (rpcError.code === "42501") {
          throw new EventError(
            "FORBIDDEN_EVENT_ACTION",
            rpcError.message || "이벤트 기록 권한이 없습니다.",
            403
          );
        }
        if (rpcError.code === "22023") {
          throw new EventError(
            "INVALID_EVENT_PAYLOAD",
            rpcError.message || "유효하지 않은 이벤트 데이터입니다.",
            400
          );
        }
        // If RPC function not found (e.g. mock DB in test without RPC), fall through
        const isRpcMissing =
          rpcError.code === "42883" ||
          rpcError.code === "PGRST202" ||
          rpcError.message?.includes("function") ||
          rpcError.message?.includes("does not exist");

        if (!isRpcMissing) {
          throw new EventError("EVENT_INGEST_ERROR", rpcError.message, 500);
        }
      }
    } catch (err) {
      if (err instanceof EventError) throw err;
      // Fall through to table query if not already handled
    }
  }

  // 6. Fallback: Table-level insertion & idempotency handling (comparing full payload)
  // A. Check if client_event_id already exists
  const { data: existing, error: checkError } = await supabase
    .from("event_logs")
    .select("id, client_event_id, event_name, event_version, browser_id, session_id, user_id, business_id, restroom_id, access_session_id, experiment_key, page_path, component_id, properties, source, is_test, received_at")
    .eq("client_event_id", data.clientEventId)
    .maybeSingle();

  if (!checkError && existing) {
    const isSameEvent =
      existing.event_name === data.eventName &&
      (existing.event_version ?? 1) === (data.eventVersion ?? 1) &&
      (existing.session_id ?? null) === (data.sessionId ?? null) &&
      (existing.user_id ?? null) === (effectiveUserId ?? null) &&
      (existing.browser_id ?? null) === (data.browserId ?? null) &&
      (existing.business_id ?? null) === (data.context.businessId ?? null) &&
      (existing.restroom_id ?? null) === (data.context.restroomId ?? null) &&
      (existing.access_session_id ?? null) === (data.context.accessSessionId ?? null) &&
      (existing.experiment_key ?? null) === (data.context.experimentKey ?? null) &&
      (existing.page_path ?? null) === (data.context.pagePath ?? null) &&
      (existing.component_id ?? null) === (data.context.componentId ?? null) &&
      JSON.stringify(existing.properties ?? {}) === JSON.stringify(data.properties ?? {}) &&
      (existing.source ?? "client") === "client" &&
      Boolean(existing.is_test) === resolvedIsTest;

    if (isSameEvent) {
      // Idempotent duplicate: return success with deduplicated = true
      return {
        clientEventId: existing.client_event_id,
        receivedAt: existing.received_at,
        deduplicated: true,
        id: existing.id,
      };
    } else {
      // Conflict: same client_event_id with differing event payload
      throw new EventError(
        "EVENT_ID_COLLISION",
        "동일한 client_event_id로 다른 이벤트 데이터가 이미 등록되어 있습니다.",
        409
      );
    }
  }

  const now = new Date().toISOString();
  const insertPayload = {
    client_event_id: data.clientEventId as string,
    event_name: data.eventName,
    event_version: data.eventVersion ?? 1,
    browser_id: data.browserId,
    session_id: data.sessionId,
    user_id: effectiveUserId,
    business_id: data.context.businessId,
    restroom_id: data.context.restroomId,
    access_session_id: data.context.accessSessionId,
    experiment_key: data.context.experimentKey,
    page_path: data.context.pagePath,
    component_id: data.context.componentId,
    properties: data.properties ?? {},
    source: "client",
    is_test: resolvedIsTest,
    occurred_at: data.occurredAt ?? now,
    received_at: now,
  };

  const { data: inserted, error: insertError } = await supabase
    .from("event_logs")
    .insert(insertPayload)
    .select("id, client_event_id, received_at")
    .single();

  if (insertError) {
    if (insertError.code === "23505" || insertError.message?.includes("duplicate")) {
      // Race condition duplicate
      return {
        clientEventId: (data.clientEventId ?? "") as string,
        receivedAt: now,
        deduplicated: true,
      };
    }
    throw new EventError("EVENT_INSERT_ERROR", insertError.message, 500);
  }

  return {
    clientEventId: inserted.client_event_id,
    receivedAt: inserted.received_at,
    deduplicated: false,
    id: inserted.id,
  };
}

/**
 * Creates or registers a visitor session with UTM parameters, consent state, and a cryptographic session token.
 */
export async function createVisitorSession(
  supabase: SupabaseClient<any>,
  rawPayload: unknown,
  authUserId: string | null = null
): Promise<SessionCreateResult> {
  const parseResult = createVisitorSessionSchema.safeParse(rawPayload);
  if (!parseResult.success) {
    const msg = parseResult.error.issues[0]?.message || "유효하지 않은 세션 정보입니다.";
    throw new EventError("INVALID_SESSION_PAYLOAD", msg, 400);
  }

  const data: ValidatedVisitorSessionInput = parseResult.data;

  // Generate cryptographically secure session token and hash for ownership verification
  const sessionToken = crypto.randomBytes(32).toString("hex");
  const sessionTokenHash = hashToken(sessionToken);

  const now = new Date().toISOString();
  const sessionRecord = {
    browser_id: data.browserId,
    user_id: authUserId ?? null,
    started_at: now,
    last_seen_at: now,
    landing_path: data.landingPath,
    referrer: data.referrer,
    utm_source: data.utmSource,
    utm_medium: data.utmMedium,
    utm_campaign: data.utmCampaign,
    utm_content: data.utmContent,
    utm_term: data.utmTerm,
    device_type: data.deviceType,
    language: data.language,
    is_test: data.isTest,
    session_token_hash: sessionTokenHash,
  };

  const { data: created, error } = await supabase
    .from("visitor_sessions")
    .insert(sessionRecord)
    .select("id, browser_id, started_at, is_test")
    .single();

  if (error || !created) {
    throw new EventError("SESSION_CREATE_ERROR", error?.message || "세션 생성 실패", 500);
  }

  // Record consent if provided
  if (data.consent) {
    const consentTypes: Array<"analytics" | "marketing" | "terms" | "privacy"> = [
      "analytics",
      "marketing",
      "terms",
      "privacy",
    ];

    for (const cType of consentTypes) {
      const accepted = data.consent[cType];
      if (typeof accepted === "boolean") {
        await supabase.from("consent_records").insert({
          user_id: authUserId ?? null,
          browser_id: data.browserId,
          consent_type: cType,
          policy_version: data.consent.policyVersion || "2026-11-06",
          accepted,
          recorded_at: now,
        });
      }
    }
  }

  return {
    sessionId: created.id,
    browserId: created.browser_id,
    sessionToken,
    startedAt: created.started_at,
    isTest: created.is_test,
  };
}

/**
 * Records the user's travel answer ('travelingNow') for an anonymous or authenticated session.
 * Verifies session ownership and emits an authoritative server-verified travel_answer_submitted event.
 */
export async function recordTravelAnswer(
  supabase: SupabaseClient<any>,
  sessionId: string,
  rawPayload: unknown,
  authUserId: string | null = null,
  requestSessionToken: string | null = null
): Promise<TravelAnswerResult> {
  const parseResult = travelAnswerSchema.safeParse(rawPayload);
  if (!parseResult.success) {
    const msg = parseResult.error.issues[0]?.message || "유효하지 않은 응답 데이터입니다.";
    throw new EventError("INVALID_TRAVEL_ANSWER", msg, 400);
  }

  const data: ValidatedTravelAnswerInput = parseResult.data;
  const travelingNow = Boolean(data.travelingNow);
  const clientEventId = data.clientEventId;

  // 1. 세션 존재 및 소유권 확인
  const { data: session, error: sessionError } = await supabase
    .from("visitor_sessions")
    .select("id, browser_id, user_id, session_token_hash, traveling_now, is_test")
    .eq("id", sessionId)
    .maybeSingle();

  if (sessionError || !session) {
    throw new EventError("SESSION_NOT_FOUND", "방문 세션을 찾을 수 없습니다.", 404);
  }

  // 2. 소유권 검증
  // 회원 세션인 경우: 실제 로그인 사용자 ID와 일치 강제
  if (session.user_id) {
    if (!authUserId || session.user_id !== authUserId) {
      throw new EventError(
        "SESSION_OWNERSHIP_MISMATCH",
        "해당 세션은 다른 사용자에게 속해 있습니다.",
        403
      );
    }
  } else {
    // 익명 세션인 경우: browserId 및 유효한 세션 토큰 검증 필수
    if (!data.browserId || session.browser_id !== data.browserId) {
      throw new EventError(
        "SESSION_OWNERSHIP_MISMATCH",
        "익명 세션 검증에 browserId가 필요하며 세션의 식별자와 일치해야 합니다.",
        403
      );
    }

    // 토큰 없는 기존 익명 세션의 여행 응답 수정 차단 (안전한 거부)
    if (!session.session_token_hash) {
      throw new EventError(
        "SESSION_TOKEN_REQUIRED",
        "토큰이 없는 기존 익명 세션은 여행 응답을 수정할 수 없습니다. 새 세션이 필요합니다.",
        403
      );
    }

    const providedToken = data.sessionToken || requestSessionToken;
    if (!providedToken || hashToken(providedToken) !== session.session_token_hash) {
      throw new EventError(
        "SESSION_OWNERSHIP_MISMATCH",
        "익명 세션 소유권 증명(토큰) 검증에 실패했습니다.",
        403
      );
    }
  }

  const effectiveTokenHash = session.session_token_hash;

  // 3. Try atomic RPC
  if (typeof supabase.rpc === "function") {
    try {
      const { data: rpcRes, error: rpcError } = await supabase.rpc(
        "record_travel_answer",
        {
          p_session_id: sessionId,
          p_traveling_now: travelingNow,
          p_browser_id: data.browserId || session.browser_id,
          p_user_id: session.user_id,
          p_session_token_hash: effectiveTokenHash,
          p_client_event_id: clientEventId,
        }
      );

      if (!rpcError && rpcRes) {
        return {
          sessionId: rpcRes.session_id,
          browserId: rpcRes.browser_id,
          travelingNow: Boolean(rpcRes.traveling_now),
          updatedAt: rpcRes.updated_at,
          deduplicated: Boolean(rpcRes.deduplicated),
        };
      }

      if (rpcError) {
        if (rpcError.code === "P0002" || rpcError.message?.includes("not found")) {
          throw new EventError("SESSION_NOT_FOUND", "방문 세션을 찾을 수 없습니다.", 404);
        }
        if (rpcError.code === "42501") {
          throw new EventError(
            "FORBIDDEN_SESSION_OWNERSHIP",
            rpcError.message || "세션 소유권 검증에 실패했습니다.",
            403
          );
        }
        const isRpcMissing =
          rpcError.code === "42883" ||
          rpcError.code === "PGRST202" ||
          rpcError.message?.includes("function") ||
          rpcError.message?.includes("does not exist");
        if (!isRpcMissing) {
          throw new EventError("TRAVEL_ANSWER_ERROR", rpcError.message, 500);
        }
      }
    } catch (err) {
      if (err instanceof EventError) throw err;
    }
  }

  // 4. Fallback: Table-level update & server event logging
  // 멱등성: 동일한 응답이 이미 기록된 경우
  if (session.traveling_now !== null && session.traveling_now === travelingNow) {
    return {
      sessionId: session.id,
      browserId: session.browser_id,
      travelingNow,
      updatedAt: new Date().toISOString(),
      deduplicated: true,
    };
  }

  const now = new Date().toISOString();

  // Update session traveling_now
  await supabase
    .from("visitor_sessions")
    .update({
      traveling_now: travelingNow,
      last_seen_at: now,
    })
    .eq("id", sessionId);

  // Ingest travel_answer_submitted event with source='server' (authoritative)
  const eventId = clientEventId || crypto.randomUUID();
  const insertPayload = {
    client_event_id: eventId,
    event_name: "travel_answer_submitted",
    event_version: 1,
    browser_id: session.browser_id,
    session_id: session.id,
    user_id: session.user_id,
    properties: {
      traveling_now: travelingNow,
      server_verified: true,
    },
    source: "server",
    is_test: session.is_test,
    occurred_at: now,
    received_at: now,
  };

  await supabase.from("event_logs").insert(insertPayload);

  return {
    sessionId: session.id,
    browserId: session.browser_id,
    travelingNow,
    updatedAt: now,
    deduplicated: false,
  };
}
