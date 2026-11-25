/**
 * Client-side SDK helper for event tracking, browser identification, session management, and consent state.
 * Spec: docs/04_API_CONTRACT.md, docs/06_EVENTS_AND_PMF.md, docs/08_SECURITY_OPERATIONS.md
 */

import type {
  AnalyticsConsentStatus,
  DirectClientEventName,
  ClientEventPayload,
  CreateSessionInput,
  EventIngestResult,
  SessionCreateResult,
  TravelAnswerResult,
} from "./types";
import {
  CONSENT_PREF_COOKIE_NAME,
  PRIVACY_POLICY_VERSION,
  SERVER_ONLY_EVENTS,
} from "./types";
import type { DeviceType } from "@/lib/db/types";
import type { BasicUsageFeatureKey } from "@/lib/usage-counts/types";

const BROWSER_ID_STORAGE_KEY = "hm_browser_id";
const SESSION_ID_STORAGE_KEY = "hm_session_id";
const SESSION_TOKEN_STORAGE_KEY = "hm_session_token";
const SESSION_AUTH_STATE_STORAGE_KEY = "hm_session_auth_state";
const CONSENT_STORAGE_KEY = "hm_consent_state";

export const ANALYTICS_CONSENT_CHANGED_EVENT = "hm-analytics-consent-changed";
export const ANALYTICS_SESSION_RESET_EVENT = "hm-analytics-session-reset";
export const OPEN_ANALYTICS_SETTINGS_EVENT = "hm-open-analytics-settings";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface UserConsentState {
  analyticsStatus: AnalyticsConsentStatus;
  analytics: boolean;
  decidedAt?: string | null;
  withdrawnAt?: string | null;
  marketing: boolean;
  terms: boolean;
  privacy: boolean;
  policyVersion: string;
  updatedAt?: string;
}

const DEFAULT_CONSENT: UserConsentState = {
  analyticsStatus: "undecided",
  analytics: false,
  decidedAt: null,
  withdrawnAt: null,
  marketing: false,
  terms: false,
  privacy: false,
  policyVersion: PRIVACY_POLICY_VERSION,
};

/**
 * Retrieves the current user consent state from localStorage.
 * Defaults to analyticsStatus: "undecided" (analytics: false, strict opt-in).
 * Invalidates prior consent if the privacy policy version substantially changed.
 */
export function getConsentState(): UserConsentState {
  if (typeof window === "undefined") {
    return DEFAULT_CONSENT;
  }
  try {
    const raw = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const storedVersion =
        typeof parsed?.policyVersion === "string" ? parsed.policyVersion : null;
      if (storedVersion !== null && storedVersion !== PRIVACY_POLICY_VERSION) {
        return DEFAULT_CONSENT;
      }

      let status: AnalyticsConsentStatus = "undecided";
      if (
        parsed?.analyticsStatus === "accepted" ||
        parsed?.analyticsStatus === "declined" ||
        parsed?.analyticsStatus === "undecided"
      ) {
        status = parsed.analyticsStatus;
      } else if (parsed?.analytics === true) {
        status = "accepted";
      }

      return {
        ...DEFAULT_CONSENT,
        ...parsed,
        analyticsStatus: status,
        analytics: status === "accepted",
        policyVersion: storedVersion ?? PRIVACY_POLICY_VERSION,
      };
    }
  } catch {}
  return DEFAULT_CONSENT;
}

/**
 * Checks whether the user has explicitly consented to optional analytics.
 */
export function hasAnalyticsConsent(): boolean {
  return getConsentState().analyticsStatus === "accepted";
}

/**
 * Returns the tri-state analytics consent decision ("undecided" | "accepted" | "declined").
 */
export function getAnalyticsConsentStatus(): AnalyticsConsentStatus {
  return getConsentState().analyticsStatus;
}

/**
 * Dispatches an application-wide request to open the analytics settings modal.
 */
export function openAnalyticsSettingsModal(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(OPEN_ANALYTICS_SETTINGS_EVENT));
  } catch {}
}

/**
 * Syncs the non-identifying UI preference cookie so SSR can avoid consent flicker.
 * Stores only policyVersion + "accepted"|"declined" (never browserId or sessionId).
 */
export function syncConsentPrefCookie(
  status: AnalyticsConsentStatus,
  policyVersion: string = PRIVACY_POLICY_VERSION
): void {
  if (typeof document === "undefined") return;
  try {
    if (status === "accepted" || status === "declined") {
      const value = encodeURIComponent(`${policyVersion}:${status}`);
      document.cookie = `${CONSENT_PREF_COOKIE_NAME}=${value}; path=/; max-age=31536000; samesite=lax`;
    } else {
      document.cookie = `${CONSENT_PREF_COOKIE_NAME}=; path=/; max-age=0; samesite=lax`;
    }
  } catch {}
}

/**
 * Updates the user consent state in localStorage and notifies listeners.
 * When analytics consent is not accepted, clears analytics identifiers from browser storage.
 */
export function setConsentState(state: Partial<UserConsentState>): void {
  if (typeof window === "undefined") return;
  try {
    const current = getConsentState();
    const now = new Date().toISOString();

    let nextStatus: AnalyticsConsentStatus = current.analyticsStatus;
    if (
      state.analyticsStatus === "undecided" ||
      state.analyticsStatus === "accepted" ||
      state.analyticsStatus === "declined"
    ) {
      nextStatus = state.analyticsStatus;
    } else if (state.analytics === true) {
      nextStatus = "accepted";
    } else if (state.analytics === false) {
      nextStatus = "declined";
    }

    const nextDecidedAt =
      nextStatus === "undecided"
        ? null
        : state.decidedAt ?? current.decidedAt ?? now;
    const nextWithdrawnAt =
      nextStatus === "accepted"
        ? null
        : state.withdrawnAt !== undefined
        ? state.withdrawnAt
        : current.analyticsStatus === "accepted" && nextStatus === "declined"
        ? now
        : current.withdrawnAt ?? null;

    const updated: UserConsentState = {
      ...current,
      ...state,
      analyticsStatus: nextStatus,
      analytics: nextStatus === "accepted",
      decidedAt: nextDecidedAt,
      withdrawnAt: nextWithdrawnAt,
      policyVersion: state.policyVersion ?? PRIVACY_POLICY_VERSION,
      updatedAt: now,
    };
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(updated));
    syncConsentPrefCookie(updated.analyticsStatus, updated.policyVersion);
    if (updated.analyticsStatus !== "accepted") {
      clearAnalyticsClientState();
    }
    window.dispatchEvent(
      new CustomEvent(ANALYTICS_CONSENT_CHANGED_EVENT, {
        detail: {
          analytics: updated.analytics,
          analyticsStatus: updated.analyticsStatus,
        },
      })
    );
  } catch {}
}

/**
 * Clears persistent analytics browser ID and session state from browser storage.
 */
export function clearAnalyticsClientState(): void {
  sessionInitPromise = null;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(BROWSER_ID_STORAGE_KEY);
  } catch {}
  try {
    window.sessionStorage.removeItem(SESSION_ID_STORAGE_KEY);
    window.sessionStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
    window.sessionStorage.removeItem(SESSION_AUTH_STATE_STORAGE_KEY);
  } catch {}
}

/**
 * Isolates visitor sessions across login/logout transitions without altering analytics consent
 * or linking anonymous pre-login sessions to authenticated accounts.
 */
export function syncAnalyticsAuthBoundary(isAuthenticated: boolean): boolean {
  if (typeof window === "undefined") return false;
  const nextAuthState = isAuthenticated ? "auth" : "guest";
  try {
    const prevAuthState = window.sessionStorage.getItem(
      SESSION_AUTH_STATE_STORAGE_KEY
    );
    window.sessionStorage.setItem(SESSION_AUTH_STATE_STORAGE_KEY, nextAuthState);
    if (prevAuthState && prevAuthState !== nextAuthState) {
      sessionInitPromise = null;
      window.sessionStorage.removeItem(SESSION_ID_STORAGE_KEY);
      window.sessionStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
      window.dispatchEvent(
        new CustomEvent(ANALYTICS_SESSION_RESET_EVENT, {
          detail: { isAuthenticated },
        })
      );
      return true;
    }
  } catch {}
  return false;
}

/**
 * Reads an existing valid browser ID without creating or persisting a new one.
 */
export function getExistingBrowserId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const existing = window.localStorage.getItem(BROWSER_ID_STORAGE_KEY);
    if (existing && UUID_REGEX.test(existing)) {
      return existing;
    }
  } catch {}
  return null;
}

/**
 * Checks whether client-side optional analytics collection is enabled by environment config.
 * Must be explicitly set to "true" to transmit optional behavioral analytics telemetry.
 */
export function isAnalyticsEnvEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ANALYTICS_ENABLED === "true";
}

/**
 * Checks whether analytics event tracking is permitted by both environment flag
 * and explicit user opt-in consent (analytics === true).
 */
export function isAnalyticsAllowed(): boolean {
  if (!isAnalyticsEnvEnabled()) {
    return false;
  }
  return getConsentState().analytics === true;
}

/**
 * Persists user consent decision both locally and (when possible) on the server consent_records table.
 * On withdrawal (accepted === false), records withdrawal with the existing browserId if present,
 * then immediately removes hm_browser_id and session storage identifiers.
 */
export async function updateAnalyticsConsent(
  accepted: boolean
): Promise<{
  analytics: boolean;
  analyticsStatus: AnalyticsConsentStatus;
  recordedOnServer: boolean;
}> {
  const existingBrowserId = getExistingBrowserId();
  let browserIdForRecord = existingBrowserId;

  if (accepted && !browserIdForRecord && isAnalyticsEnvEnabled()) {
    browserIdForRecord = getOrCreateBrowserId();
  }

  const nextStatus: AnalyticsConsentStatus = accepted ? "accepted" : "declined";
  let recordedOnServer = false;
  if (typeof window !== "undefined") {
    try {
      const res = await fetch("/api/v1/privacy/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          analytics: accepted,
          analyticsStatus: nextStatus,
          browserId: browserIdForRecord,
          policyVersion: PRIVACY_POLICY_VERSION,
        }),
      });
      if (res.ok) {
        const body = await res.json().catch(() => null);
        recordedOnServer = Boolean(body?.data?.recordedOnServer);
      }
    } catch {
      recordedOnServer = false;
    }
  }

  setConsentState({
    analyticsStatus: nextStatus,
    analytics: accepted,
    policyVersion: PRIVACY_POLICY_VERSION,
  });

  return { analytics: accepted, analyticsStatus: nextStatus, recordedOnServer };
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
  if (!isAnalyticsAllowed()) {
    return null;
  }

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
 * Increments a non-identifying daily feature counter without requiring user consent or browser/session IDs.
 * Strictly sends only `{ feature }` and suppresses any network/API error so service UX is never disrupted.
 */
export async function trackBasicUsageSafe(
  feature: BasicUsageFeatureKey
): Promise<void> {
  if (typeof window === "undefined") {
    return;
  }
  try {
    await fetch("/api/v1/usage-counts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ feature }),
      keepalive: true,
    });
  } catch {
    // Non-blocking: basic usage counting failures must never interrupt map/search/payment UX
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
