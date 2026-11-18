/**
 * Client-side SDK helper for event tracking, browser identification, session management, and consent state.
 * Spec: docs/04_API_CONTRACT.md, docs/06_EVENTS_AND_PMF.md, docs/08_SECURITY_OPERATIONS.md
 */

import type {
  DirectClientEventName,
  ClientEventPayload,
  CreateSessionInput,
  EventIngestResult,
  SessionCreateResult,
  TravelAnswerResult,
} from "./types";
import { SERVER_ONLY_EVENTS } from "./types";
import type { DeviceType } from "@/lib/db/types";

const BROWSER_ID_STORAGE_KEY = "hm_browser_id";
const SESSION_ID_STORAGE_KEY = "hm_session_id";
const SESSION_TOKEN_STORAGE_KEY = "hm_session_token";
const CONSENT_STORAGE_KEY = "hm_consent_state";

export interface UserConsentState {
  analytics: boolean;
  marketing: boolean;
  terms: boolean;
  privacy: boolean;
  policyVersion: string;
}

const DEFAULT_CONSENT: UserConsentState = {
  analytics: true,
  marketing: false,
  terms: true,
  privacy: true,
  policyVersion: "2026-11-06",
};

/**
 * Retrieves the current user consent state from localStorage.
 */
export function getConsentState(): UserConsentState {
  if (typeof window === "undefined") {
    return DEFAULT_CONSENT;
  }
  try {
    const raw = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_CONSENT,
        ...parsed,
      };
    }
  } catch {}
  return DEFAULT_CONSENT;
}

/**
 * Updates the user consent state in localStorage.
 */
export function setConsentState(state: Partial<UserConsentState>): void {
  if (typeof window === "undefined") return;
  try {
    const current = getConsentState();
    const updated: UserConsentState = {
      ...current,
      ...state,
    };
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(updated));
  } catch {}
}

/**
 * Checks whether analytics event tracking is permitted by the user consent policy.
 */
export function isAnalyticsAllowed(): boolean {
  return getConsentState().analytics !== false;
}

/**
 * Detects device type based on user agent and screen dimensions.
 */
export function getDeviceType(): DeviceType {
  if (typeof window === "undefined") return "mobile";
  const ua = (navigator.userAgent || "").toLowerCase();
  const width = window.innerWidth;
  if (/mobile|android|iphone|ipod|blackberry|iemobile|opera mini/i.test(ua) || width < 768) {
    if (/tablet|ipad/i.test(ua) || (width >= 600 && width < 1024)) {
      return "tablet";
    }
    return "mobile";
  }
  if (width < 1024) return "tablet";
  return "desktop";
}

/**
 * Retrieves the persistent anonymous browser ID from localStorage,
 * or generates and stores a new UUID if none exists.
 * Does NOT track human identity or GPS trails.
 */
export function getOrCreateBrowserId(): string {
  if (typeof window === "undefined") {
    return "00000000-0000-0000-0000-000000000000";
  }

  try {
    const existing = window.localStorage.getItem(BROWSER_ID_STORAGE_KEY);
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (existing && uuidRegex.test(existing)) {
      return existing;
    }

    const newId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            const v = c === "x" ? r : (r & 0x3) | 0x8;
            return v.toString(16);
          });

    window.localStorage.setItem(BROWSER_ID_STORAGE_KEY, newId);
    return newId;
  } catch {
    return "00000000-0000-0000-0000-000000000000";
  }
}

/**
 * Gets the current active visitor session ID from sessionStorage.
 */
export function getActiveSessionId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(SESSION_ID_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Stores the active visitor session ID in sessionStorage.
 */
export function setActiveSessionId(sessionId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SESSION_ID_STORAGE_KEY, sessionId);
  } catch {}
}

/**
 * Gets the active anonymous session token from sessionStorage.
 */
export function getActiveSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(SESSION_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Stores the anonymous session token in sessionStorage.
 */
export function setActiveSessionToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SESSION_TOKEN_STORAGE_KEY, token);
  } catch {}
}

/**
 * Generates a client_event_id (UUID) for idempotency and duplicate prevention.
 */
export function createClientEventId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * In-flight promise for session initialization to prevent concurrent duplicate requests.
 */
let sessionInitPromise: Promise<string | null> | null = null;

/**
 * Ensures an active visitor session exists.
 * If one is already stored in sessionStorage, returns it immediately.
 * Otherwise, initiates a session creation request and coordinates concurrent callers.
 */
export async function ensureVisitorSession(
  options?: Partial<CreateSessionInput>
): Promise<string | null> {
  const existing = getActiveSessionId();
  if (existing) {
    return existing;
  }

  if (sessionInitPromise) {
    return sessionInitPromise;
  }

  sessionInitPromise = (async () => {
    try {
      const browserId = getOrCreateBrowserId();
      let landingPath = "/map";
      let referrer: string | null = null;
      let utmSource: string | null = null;
      let utmMedium: string | null = null;
      let utmCampaign: string | null = null;
      let utmContent: string | null = null;
      let utmTerm: string | null = null;

      if (typeof window !== "undefined") {
        landingPath = window.location.pathname || "/map";
        referrer = document.referrer || null;
        try {
          const sp = new URLSearchParams(window.location.search);
          utmSource = sp.get("utm_source");
          utmMedium = sp.get("utm_medium");
          utmCampaign = sp.get("utm_campaign");
          utmContent = sp.get("utm_content");
          utmTerm = sp.get("utm_term");
        } catch {}
      }

      const consent = getConsentState();

      const result = await initializeVisitorSession({
        landingPath: options?.landingPath ?? landingPath,
        referrer: options?.referrer ?? referrer,
        utmSource: options?.utmSource ?? utmSource,
        utmMedium: options?.utmMedium ?? utmMedium,
        utmCampaign: options?.utmCampaign ?? utmCampaign,
        utmContent: options?.utmContent ?? utmContent,
        utmTerm: options?.utmTerm ?? utmTerm,
        deviceType: options?.deviceType ?? getDeviceType(),
        consent: options?.consent ?? {
          analytics: consent.analytics,
          marketing: consent.marketing,
          terms: consent.terms,
          privacy: consent.privacy,
          policyVersion: consent.policyVersion,
        },
        isTest: options?.isTest,
        ...options,
        browserId,
      });

      return result.sessionId;
    } catch (err) {
      // In case of failure, return null safely and allow retry later
      return null;
    } finally {
      sessionInitPromise = null;
    }
  })();

  return sessionInitPromise;
}

export interface TrackEventOptions {
  clientEventId?: string;
  eventName: DirectClientEventName;
  eventVersion?: number;
  sessionId?: string | null;
  browserId?: string | null;
  context?: ClientEventPayload["context"];
  properties?: Record<string, unknown>;
  occurredAt?: string;
  isTest?: boolean;
}

/**
 * Sends a client event to the backend API.
 * Uses standard fetch with JSON payload.
 *
 * Enforces:
 * - Direct client events only (blocks server-only events like travel_answer_submitted)
 * - Consent-aware tracking (skips when user opted out of analytics)
 * - Session readiness awaiting before dispatch
 * - clientEventId preservation for retries
 */
export async function trackEvent(options: TrackEventOptions): Promise<EventIngestResult> {
  // 1. Consent check: if analytics is not permitted, silently bypass network telemetry
  if (!isAnalyticsAllowed()) {
    return {
      clientEventId: options.clientEventId ?? createClientEventId(),
      receivedAt: new Date().toISOString(),
      deduplicated: false,
    };
  }

  // 2. Prohibit client from directly sending server-only events
  if ((SERVER_ONLY_EVENTS as readonly string[]).includes(options.eventName)) {
    throw new Error(
      `서버 전용 이벤트('${options.eventName}')는 클라이언트에서 직접 전송할 수 없습니다.`
    );
  }

  const browserId = options.browserId ?? getOrCreateBrowserId();

  // 3. Resolve session ID: if not explicitly supplied, ensure session is ready
  let sessionId = options.sessionId;
  if (sessionId === undefined) {
    sessionId = getActiveSessionId();
    if (!sessionId && typeof window !== "undefined") {
      sessionId = await ensureVisitorSession();
    }
  }

  const clientEventId = options.clientEventId ?? createClientEventId();
  const occurredAt = options.occurredAt ?? new Date().toISOString();

  const payload: ClientEventPayload = {
    clientEventId,
    eventName: options.eventName,
    eventVersion: options.eventVersion ?? 1,
    browserId,
    sessionId: sessionId ?? null,
    context: options.context ?? {},
    properties: options.properties ?? {},
    occurredAt,
    isTest: options.isTest,
  };

  const res = await fetch("/api/v1/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await res.json();
  if (!res.ok) {
    throw new Error(body?.error?.message || `이벤트 전송 실패 (${res.status})`);
  }

  return body.data;
}

/**
 * Safe wrapper around trackEvent that catches and suppresses any network/server error.
 * Ensures that UI actions (map exploration, directions opening, etc.) are NEVER blocked by event failures.
 */
export async function trackEventSafe(
  options: TrackEventOptions
): Promise<EventIngestResult | null> {
  try {
    return await trackEvent(options);
  } catch {
    return null;
  }
}

/**
 * Retries a failed event using the exact same clientEventId for idempotent deduplication.
 */
export async function retryTrackEvent(
  options: TrackEventOptions,
  clientEventId: string
): Promise<EventIngestResult> {
  return trackEvent({
    ...options,
    clientEventId,
  });
}

/**
 * Initializes or creates a visitor session with UTM parameters and consent state.
 */
export async function initializeVisitorSession(
  input: Omit<CreateSessionInput, "browserId"> & { browserId?: string }
): Promise<SessionCreateResult> {
  const browserId = input.browserId ?? getOrCreateBrowserId();

  const payload: CreateSessionInput = {
    ...input,
    browserId,
  };

  const res = await fetch("/api/v1/sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await res.json();
  if (!res.ok) {
    throw new Error(body?.error?.message || `세션 생성 실패 (${res.status})`);
  }

  const result: SessionCreateResult = body.data;
  setActiveSessionId(result.sessionId);
  if (result.sessionToken) {
    setActiveSessionToken(result.sessionToken);
  }
  return result;
}

/**
 * Submits the user's travel status answer ('travelingNow') for H2 PMF qualification.
 * Calls PATCH /api/v1/sessions/:id/travel-answer to ensure atomic server verification.
 */
export async function submitTravelAnswer(
  travelingNow: boolean,
  sessionId?: string | null
): Promise<TravelAnswerResult> {
  const targetSessionId = sessionId ?? getActiveSessionId();
  if (!targetSessionId) {
    throw new Error("활성 세션 ID가 없습니다. 먼저 세션을 초기화해 주세요.");
  }

  const sessionToken = getActiveSessionToken();
  const browserId = getOrCreateBrowserId();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (sessionToken) {
    headers["x-session-token"] = sessionToken;
  }

  const res = await fetch(`/api/v1/sessions/${targetSessionId}/travel-answer`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      travelingNow,
      browserId,
      sessionToken,
      clientEventId: createClientEventId(),
    }),
  });

  const body = await res.json();
  if (!res.ok) {
    throw new Error(body?.error?.message || `여행 응답 전송 실패 (${res.status})`);
  }

  return body.data;
}
