/**
 * Types and definitions for user event logs, PMF experiments, visitor sessions, and client SDK.
 * Spec: docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/06_EVENTS_AND_PMF.md, tasks/17_events_backend.md
 */

import type { DeviceType } from "@/lib/db/types";

/**
 * 11 events that clients may emit directly via POST /api/v1/events.
 * travel_answer_submitted is authoritatively emitted by the server via PATCH /api/v1/sessions/:id/travel-answer.
 */
export const DIRECT_CLIENT_EVENTS = [
  "landing_view",
  "map_loaded",
  "restroom_marker_clicked",
  "restroom_card_viewed",
  "restroom_detail_opened",
  "directions_clicked",
  "payment_button_clicked",
  "payment_unavailable_shown",
  "checkout_opened",
  "receipt_upload_clicked",
  "business_registration_submitted",
] as const;

export type DirectClientEventName = (typeof DIRECT_CLIENT_EVENTS)[number];

/**
 * All 12 client-associated event names.
 */
export const ALLOWED_CLIENT_EVENTS = [
  ...DIRECT_CLIENT_EVENTS,
  "travel_answer_submitted",
] as const;

export type AllowedClientEventName = (typeof ALLOWED_CLIENT_EVENTS)[number];

/**
 * 17 required server event names (including travel_answer_submitted which is server-verified).
 * Clients MUST NOT emit these events directly via POST /api/v1/events.
 */
export const SERVER_ONLY_EVENTS = [
  "travel_answer_submitted",
  "business_registration_approved",
  "payment_order_created",
  "payment_confirmed",
  "payment_failed",
  "access_authorized",
  "pin_reveal_requested",
  "pin_reveal_succeeded",
  "pin_reveal_denied",
  "receipt_submitted",
  "receipt_review_approved",
  "receipt_review_rejected",
  "receipt_resubmission_requested",
  "refund_requested",
  "refund_succeeded",
  "refund_failed",
  "visit_confirmation_recorded",
] as const;

export type ServerOnlyEventName = (typeof SERVER_ONLY_EVENTS)[number];

export type EventName = AllowedClientEventName | ServerOnlyEventName;

export type EventSource = "client" | "server";

/**
 * Database representation of an event record.
 */
export interface EventLog {
  id: string; // uuid
  client_event_id: string; // uuid
  event_name: string;
  event_version: number;
  browser_id: string | null;
  session_id: string | null;
  user_id: string | null;
  business_id: string | null;
  restroom_id: string | null;
  access_session_id: string | null;
  experiment_key: string | null;
  page_path: string | null;
  component_id: string | null;
  properties: Record<string, unknown>;
  source: EventSource;
  is_test: boolean;
  occurred_at: string;
  received_at: string;
}

/**
 * PMF Experiment representation.
 */
export interface Experiment {
  id: string; // uuid
  experiment_key: string;
  name: string;
  rules_version: string;
  starts_at: string;
  ends_at: string;
  status: "draft" | "running" | "closed";
  notes: string | null;
  created_at: string;
}

/**
 * Event context for optional relation mapping and UI component tracking.
 */
export interface EventContext {
  businessId?: string | null;
  restroomId?: string | null;
  accessSessionId?: string | null;
  experimentKey?: string | null;
  pagePath?: string | null;
  componentId?: string | null;
}

/**
 * Client event payload received by POST /api/v1/events
 */
export interface ClientEventPayload {
  clientEventId: string; // UUID (idempotency key)
  eventName: DirectClientEventName | AllowedClientEventName;
  eventVersion?: number;
  browserId?: string | null;
  sessionId?: string | null;
  userId?: string | null; // Checked against auth context
  context?: EventContext;
  properties?: Record<string, unknown>;
  occurredAt?: string; // ISO 8601
  isTest?: boolean;
}

/**
 * Ingestion result returned to client
 */
export interface EventIngestResult {
  clientEventId: string;
  receivedAt: string;
  deduplicated: boolean;
  id?: string;
}

/**
 * Visitor session creation input
 */
export interface CreateSessionInput {
  browserId: string;
  landingPath: string;
  referrer?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  utmTerm?: string | null;
  deviceType?: DeviceType;
  language?: string | null;
  isTest?: boolean;
  consent?: {
    analytics?: boolean;
    marketing?: boolean;
    terms?: boolean;
    privacy?: boolean;
    policyVersion?: string;
  };
}

/**
 * Visitor session creation result
 */
export interface SessionCreateResult {
  sessionId: string;
  browserId: string;
  sessionToken?: string;
  startedAt: string;
  isTest: boolean;
}

/**
 * Travel answer submission result
 */
export interface TravelAnswerResult {
  sessionId: string;
  browserId: string;
  travelingNow: boolean;
  updatedAt: string;
  deduplicated?: boolean;
}
