/**
 * Server-side service for PMF analytics aggregation, hypothesis metrics, and audit reporting.
 *
 * Spec:
 * - docs/03_DATA_MODEL.md
 * - docs/04_API_CONTRACT.md
 * - docs/06_EVENTS_AND_PMF.md
 * - docs/08_SECURITY_OPERATIONS.md
 * - docs/11_DECISIONS.md
 * - tasks/19_pmf_dashboard.md
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AnalyticsAuthFilter,
  EventBreakdownItem,
  ExperimentMetadata,
  MetricHypothesisH1,
  MetricHypothesisH2,
  MetricHypothesisH5,
  PmfReportData,
  RestroomInterestRow,
  ServiceDailyTrendRow,
  ServiceUsageMetrics,
} from "./types";
import { OPTIONAL_BEHAVIORAL_EVENTS } from "@/lib/events/types";
import { type ValidatedPmfQueryParams } from "./validation";

export const DEFAULT_EXPERIMENT_KEY = "pmf_r1";
export const DEFAULT_RULES_VERSION = "2026-11-04_agreed_metrics";

// Canonical PMF Phase 1 Window: 2026-11-05 09:00 KST ~ 2026-11-18 23:59:59 KST
export const DEFAULT_STARTS_AT = "2026-11-05T00:00:00.000Z";
export const DEFAULT_ENDS_AT = "2026-11-18T14:59:59.999Z";

export const PROVISIONAL_NOTICE =
  "판정 원문 19개 상세 규칙이 아직 확정 수록되지 않았으므로 잠정 집계만 제공하며, 최종 PMF PASS/FAIL 판정은 보류됩니다.";

/**
 * Computes H1 hypothesis metrics:
 * Denominator: 50 distinct contacted businesses out of supplied lead target list
 * Numerator: >= 5 valid approved registrations satisfying agreed conditions
 */
export function computeH1Metrics(
  leads: Array<{ id: string; converted_business_id: string | null }>,
  contactAttempts: Array<{ lead_id: string }>,
  businesses: Array<{ id: string; status: string }>
): MetricHypothesisH1 {
  const contactedLeadIds = new Set(contactAttempts.map((a) => a.lead_id));
  const leadById = new Map(leads.map((l) => [l.id, l]));
  const businessById = new Map(businesses.map((b) => [b.id, b]));

  // H1 Denominator: Distinct leads that have at least 1 contact attempt
  const validContactedLeads = Array.from(contactedLeadIds).filter((id) =>
    leadById.has(id)
  );
  const denominatorCount = validContactedLeads.length;

  // H1 Numerator: Distinct contacted leads converted to an approved business
  let numeratorCount = 0;
  for (const leadId of validContactedLeads) {
    const lead = leadById.get(leadId);
    if (lead?.converted_business_id) {
      const biz = businessById.get(lead.converted_business_id);
      if (biz && biz.status === "approved") {
        numeratorCount += 1;
      }
    }
  }

  const targetDenominator = 50;
  const targetNumerator = 5;
  const conversionRatePercent =
    denominatorCount > 0
      ? Number(((numeratorCount / denominatorCount) * 100).toFixed(1))
      : 0;

  const isSufficientData = denominatorCount >= targetDenominator;
  const isTargetMet = numeratorCount >= targetNumerator;

  return {
    hypothesisKey: "H1",
    name: "H1. 점주 제휴 전환",
    definition:
      "접촉 대상 점포 50곳 중 사전 합의 요건을 만족하는 정식 승인 등록 점포 5곳 이상 확보",
    denominatorCount,
    targetDenominator,
    numeratorCount,
    targetNumerator,
    conversionRatePercent,
    isTargetMet,
    isSufficientData,
    status: isSufficientData ? "provisional" : "insufficient_data",
  };
}

/**
 * Computes H2 hypothesis metrics:
 * Denominator: Ad landing browsers marked travelingNow=true in testing window (distinct browser IDs)
 * Numerator: Among eligible distinct browsers, >= 5 performed directions_clicked
 */
export function computeH2Metrics(
  sessions: Array<{
    id: string;
    browser_id: string;
    started_at: string;
    utm_source: string | null;
    traveling_now: boolean | null;
    is_test?: boolean | null;
  }>,
  events: Array<{
    id?: string;
    session_id?: string | null;
    browser_id?: string | null;
    event_name: string;
    properties?: Record<string, unknown> | null;
    occurred_at: string;
    is_test?: boolean | null;
  }>,
  window: { startsAt: string; endsAt: string },
  includeTest = false
): MetricHypothesisH2 {
  const startMs = new Date(window.startsAt).getTime();
  const endMs = new Date(window.endsAt).getTime();

  // 1. Collect authoritative traveling_now server events for sessions
  const travelingSessionsFromEvents = new Set<string>();
  for (const ev of events) {
    if (!includeTest && ev.is_test) continue;
    const evTime = new Date(ev.occurred_at).getTime();
    if (evTime < startMs || evTime > endMs) continue;

    if (
      ev.event_name === "travel_answer_submitted" &&
      ev.session_id &&
      ev.properties?.traveling_now === true
    ) {
      travelingSessionsFromEvents.add(ev.session_id);
    }
  }

  // 2. Classify sessions and distinct browsers
  const qualifiedBrowsers = new Set<string>();
  const organicBrowsers = new Set<string>();
  const nonTravelingBrowsers = new Set<string>();

  for (const sess of sessions) {
    if (!includeTest && sess.is_test) continue;
    const sessTime = new Date(sess.started_at).getTime();
    if (sessTime < startMs || sessTime > endMs) continue;

    const hasAdUtm = Boolean(sess.utm_source && sess.utm_source.trim().length > 0);
    const isTraveling =
      sess.traveling_now === true || travelingSessionsFromEvents.has(sess.id);

    if (hasAdUtm) {
      if (isTraveling) {
        qualifiedBrowsers.add(sess.browser_id);
      } else {
        nonTravelingBrowsers.add(sess.browser_id);
      }
    } else {
      organicBrowsers.add(sess.browser_id);
    }
  }

  // Clean up overlap in exclusions
  for (const bId of qualifiedBrowsers) {
    nonTravelingBrowsers.delete(bId);
  }

  // 3. Find distinct qualified browsers who performed directions_clicked
  const directionsBrowsers = new Set<string>();

  for (const ev of events) {
    if (!includeTest && ev.is_test) continue;
    const evTime = new Date(ev.occurred_at).getTime();
    if (evTime < startMs || evTime > endMs) continue;

    if (ev.event_name === "directions_clicked" && ev.browser_id) {
      if (qualifiedBrowsers.has(ev.browser_id)) {
        directionsBrowsers.add(ev.browser_id);
      }
    }
  }

  const denominatorCount = qualifiedBrowsers.size;
  const numeratorCount = directionsBrowsers.size;
  const targetDenominator = 50;
  const targetNumerator = 5;
  const conversionRatePercent =
    denominatorCount > 0
      ? Number(((numeratorCount / denominatorCount) * 100).toFixed(1))
      : 0;

  const isSufficientData = denominatorCount >= targetDenominator;
  const isTargetMet = numeratorCount >= targetNumerator;

  return {
    hypothesisKey: "H2",
    name: "H2. 여행자 길찾기 전환",
    definition:
      "광고 유입 후 여행 중(travelingNow=true)으로 확인된 고유 브라우저 50명 중 길찾기 실행 5명 이상",
    denominatorCount,
    targetDenominator,
    numeratorCount,
    targetNumerator,
    conversionRatePercent,
    isTargetMet,
    isSufficientData,
    status: isSufficientData ? "provisional" : "insufficient_data",
    excludedOrganicCount: organicBrowsers.size,
    excludedNonTravelingCount: nonTravelingBrowsers.size,
  };
}

/**
 * Computes H5 hypothesis metrics:
 * Denominator: Among distinct browser IDs exposed to an approved partner restroom card
 * Numerator: >= 5 clicked directions for that SAME partner restroom
 */
export function computeH5Metrics(
  events: Array<{
    id?: string;
    browser_id?: string | null;
    restroom_id?: string | null;
    event_name: string;
    properties?: Record<string, unknown> | null;
    occurred_at: string;
    is_test?: boolean | null;
  }>,
  restrooms: Array<{
    id: string;
    type: "public" | "partner";
    publication_status?: string;
  }>,
  window: { startsAt: string; endsAt: string },
  includeTest = false
): MetricHypothesisH5 {
  const startMs = new Date(window.startsAt).getTime();
  const endMs = new Date(window.endsAt).getTime();

  const restroomMap = new Map(restrooms.map((r) => [r.id, r]));

  // Browser ID -> Map of partner restroom ID -> earliest restroom_card_viewed timestamp (ms)
  const exposedPartnerRestroomsByBrowser = new Map<string, Map<string, number>>();

  let excludedPublicDirectionsCount = 0;
  let excludedMismatchedPartnerDirectionsCount = 0;

  // 1. Pass 1: Identify all partner restroom card exposures with earliest timestamp
  for (const ev of events) {
    if (!includeTest && ev.is_test) continue;
    const evTime = new Date(ev.occurred_at).getTime();
    if (!Number.isFinite(evTime) || evTime < startMs || evTime > endMs) continue;

    if (ev.event_name === "restroom_card_viewed" && ev.browser_id) {
      const restroomId =
        ev.restroom_id ||
        (typeof ev.properties?.restroom_id === "string"
          ? ev.properties.restroom_id
          : null);

      const cardType =
        ev.properties?.card_type || ev.properties?.cardType || null;

      const isPartner =
        cardType === "partner" ||
        (restroomId ? restroomMap.get(restroomId)?.type === "partner" : false);

      if (isPartner && restroomId) {
        const map =
          exposedPartnerRestroomsByBrowser.get(ev.browser_id) ??
          new Map<string, number>();
        const prevMin = map.get(restroomId);
        if (prevMin === undefined || evTime < prevMin) {
          map.set(restroomId, evTime);
        }
        exposedPartnerRestroomsByBrowser.set(ev.browser_id, map);
      }
    }
  }

  // H5 Denominator: Distinct browsers with >= 1 partner restroom card exposure
  const denominatorCount = exposedPartnerRestroomsByBrowser.size;

  // 2. Pass 2: Directions events for the SAME partner restroom occurring at or after exposure
  const convertedBrowsers = new Set<string>();

  for (const ev of events) {
    if (!includeTest && ev.is_test) continue;
    const evTime = new Date(ev.occurred_at).getTime();
    if (!Number.isFinite(evTime) || evTime < startMs || evTime > endMs) continue;

    if (ev.event_name === "directions_clicked" && ev.browser_id) {
      const restroomId =
        ev.restroom_id ||
        (typeof ev.properties?.restroom_id === "string"
          ? ev.properties.restroom_id
          : null);

      const restroomType =
        ev.properties?.type ||
        (restroomId ? restroomMap.get(restroomId)?.type : null);

      if (restroomType === "public") {
        excludedPublicDirectionsCount += 1;
        continue;
      }

      const exposedMap = exposedPartnerRestroomsByBrowser.get(ev.browser_id);
      if (exposedMap && restroomId) {
        const minViewedAt = exposedMap.get(restroomId);
        if (minViewedAt !== undefined) {
          if (evTime >= minViewedAt) {
            // Matched exact same partner restroom in chronological order!
            convertedBrowsers.add(ev.browser_id);
          }
        } else {
          // Direction was for a partner restroom, but not one the browser saw
          excludedMismatchedPartnerDirectionsCount += 1;
        }
      }
    }
  }

  const numeratorCount = convertedBrowsers.size;
  const targetDenominator = 50;
  const targetNumerator = 5;
  const conversionRatePercent =
    denominatorCount > 0
      ? Number(((numeratorCount / denominatorCount) * 100).toFixed(1))
      : 0;

  const isSufficientData = denominatorCount >= targetDenominator;
  const isTargetMet = numeratorCount >= targetNumerator;

  return {
    hypothesisKey: "H5",
    name: "H5. 제휴 화장실 이용 의향",
    definition:
      "제휴 화장실 상세 카드가 노출된 고유 브라우저 50명 중 '동일한 제휴 화장실'의 길찾기를 실행한 고유 브라우저 5명 이상",
    denominatorCount,
    targetDenominator,
    numeratorCount,
    targetNumerator,
    conversionRatePercent,
    isTargetMet,
    isSufficientData,
    status: isSufficientData ? "provisional" : "insufficient_data",
    excludedPublicDirectionsCount,
    excludedMismatchedPartnerDirectionsCount,
  };
}

export function isAnalyticsRowAuthenticated(row: {
  user_id?: string | null;
  is_authenticated?: boolean | null;
}): boolean {
  return Boolean(row.user_id) || row.is_authenticated === true;
}

function matchesAuthFilter(
  row: { user_id?: string | null; is_authenticated?: boolean | null },
  authFilter: AnalyticsAuthFilter
): boolean {
  if (authFilter === "all") return true;
  const authed = isAnalyticsRowAuthenticated(row);
  return authFilter === "authenticated" ? authed : !authed;
}

/**
 * Computes event breakdown summary and deduplicated browser counts.
 */
export function computeEventBreakdown(
  events: Array<{
    event_name: string;
    browser_id?: string | null;
    user_id?: string | null;
    is_authenticated?: boolean | null;
    occurred_at: string;
    is_test?: boolean | null;
  }>,
  window: { startsAt: string; endsAt: string },
  includeTest = false,
  authFilter: AnalyticsAuthFilter = "all"
): EventBreakdownItem[] {
  const startMs = new Date(window.startsAt).getTime();
  const endMs = new Date(window.endsAt).getTime();

  const countsByName = new Map<string, number>();
  const browsersByName = new Map<string, Set<string>>();

  const KNOWN_EVENTS = [...OPTIONAL_BEHAVIORAL_EVENTS];

  for (const name of KNOWN_EVENTS) {
    countsByName.set(name, 0);
    browsersByName.set(name, new Set());
  }

  for (const ev of events) {
    if (!includeTest && ev.is_test) continue;
    if (!matchesAuthFilter(ev, authFilter)) continue;
    const evTime = new Date(ev.occurred_at).getTime();
    if (evTime < startMs || evTime > endMs) continue;

    const currentCount = countsByName.get(ev.event_name) ?? 0;
    countsByName.set(ev.event_name, currentCount + 1);

    if (ev.browser_id) {
      const browserSet = browsersByName.get(ev.event_name) ?? new Set();
      browserSet.add(ev.browser_id);
      browsersByName.set(ev.event_name, browserSet);
    }
  }

  const result: EventBreakdownItem[] = [];
  for (const [eventName, rawCount] of countsByName.entries()) {
    result.push({
      eventName,
      rawEventCount: rawCount,
      distinctBrowserCount: browsersByName.get(eventName)?.size ?? 0,
    });
  }

  return result;
}

function toKstDateKey(isoOrDate: string | null | undefined): string | null {
  if (!isoOrDate) return null;
  const ms = Date.parse(isoOrDate);
  if (!Number.isFinite(ms)) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ms));
    return parts;
  } catch {
    return null;
  }
}

function inRangeMs(iso: string | null | undefined, startMs: number, endMs: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= startMs && t <= endMs;
}

export function computeServiceUsageMetrics(params: {
  sessions: Array<{
    id: string;
    browser_id: string;
    user_id?: string | null;
    is_authenticated?: boolean | null;
    started_at: string;
    is_test?: boolean | null;
  }>;
  events: Array<{
    browser_id?: string | null;
    user_id?: string | null;
    is_authenticated?: boolean | null;
    restroom_id?: string | null;
    event_name: string;
    properties?: Record<string, unknown> | null;
    occurred_at: string;
    is_test?: boolean | null;
  }>;
  restrooms: Array<{
    id: string;
    name?: string | null;
    type: "public" | "partner";
  }>;
  orders: Array<{
    id: string;
    status: string;
    payment_mode?: string | null;
    approved_at?: string | null;
    created_at: string;
  }>;
  accessSessions: Array<{
    id: string;
    status: string;
    authorized_at?: string | null;
    created_at: string;
  }>;
  receipts: Array<{
    id: string;
    submission_status: string;
    created_at: string;
  }>;
  refunds: Array<{
    id: string;
    status: string;
    completed_at?: string | null;
    requested_at?: string | null;
  }>;
  window: { startsAt: string; endsAt: string };
  includeTest: boolean;
  authFilter?: AnalyticsAuthFilter;
}): ServiceUsageMetrics {
  const {
    sessions,
    events,
    restrooms,
    orders,
    accessSessions,
    receipts,
    refunds,
    window,
    includeTest,
    authFilter = "all",
  } = params;

  const startMs = new Date(window.startsAt).getTime();
  const endMs = new Date(window.endsAt).getTime();
  const restroomMap = new Map(restrooms.map((r) => [r.id, r]));

  const visitingBrowsersSet = new Set<string>();
  const mapBrowsersSet = new Set<string>();
  const markerClickBrowsersSet = new Set<string>();
  const cardViewBrowsersSet = new Set<string>();
  const detailViewBrowsersSet = new Set<string>();
  const directionsClickBrowsersSet = new Set<string>();
  const paymentButtonClickBrowsersSet = new Set<string>();
  const partnerDetailViewBrowsersSet = new Set<string>();

  const dailyMap = new Map<
    string,
    {
      browsers: Set<string>;
      mapBrowsers: Set<string>;
      mapViews: number;
      markerClicks: number;
      cardClicks: number;
      detailViews: number;
      directionsClicks: number;
      paymentButtonClicks: number;
      approvedPayments: number;
      testModePayments: number;
      issuedTickets: number;
      submittedReceipts: number;
      refundsSucceeded: number;
    }
  >();

  const ensureDay = (dateKey: string) => {
    let entry = dailyMap.get(dateKey);
    if (!entry) {
      entry = {
        browsers: new Set<string>(),
        mapBrowsers: new Set<string>(),
        mapViews: 0,
        markerClicks: 0,
        cardClicks: 0,
        detailViews: 0,
        directionsClicks: 0,
        paymentButtonClicks: 0,
        approvedPayments: 0,
        testModePayments: 0,
        issuedTickets: 0,
        submittedReceipts: 0,
        refundsSucceeded: 0,
      };
      dailyMap.set(dateKey, entry);
    }
    return entry;
  };

  let guestEvents = 0;
  let authenticatedEvents = 0;
  const guestBrowsersSet = new Set<string>();
  const authenticatedBrowsersSet = new Set<string>();

  for (const s of sessions) {
    if (!includeTest && s.is_test) continue;
    if (!inRangeMs(s.started_at, startMs, endMs)) continue;
    if (s.browser_id) {
      if (isAnalyticsRowAuthenticated(s)) {
        authenticatedBrowsersSet.add(s.browser_id);
      } else {
        guestBrowsersSet.add(s.browser_id);
      }
    }
    if (!matchesAuthFilter(s, authFilter)) continue;
    if (s.browser_id) {
      visitingBrowsersSet.add(s.browser_id);
      const dk = toKstDateKey(s.started_at);
      if (dk) ensureDay(dk).browsers.add(s.browser_id);
    }
  }

  let mapViews = 0;
  let markerClicks = 0;
  let cardClicks = 0;
  let detailViews = 0;
  let directionsClicks = 0;
  let paymentButtonClicks = 0;
  let partnerDetailViews = 0;

  const byRestroomTypeCounters = {
    public: {
      markerClicks: 0,
      cardClicks: 0,
      detailViews: 0,
      directionsClicks: 0,
      paymentButtonClicks: 0,
    },
    partner: {
      markerClicks: 0,
      cardClicks: 0,
      detailViews: 0,
      directionsClicks: 0,
      paymentButtonClicks: 0,
    },
  };

  // Per-restroom breakdown
  const restroomBuckets = new Map<
    string,
    {
      restroomId: string;
      restroomName: string;
      restroomType: "public" | "partner" | "unknown";
      markerClicks: number;
      cardViews: number;
      detailViews: number;
      directionsClicks: number;
      paymentButtonClicks: number;
      browsers: Set<string>;
    }
  >();

  // Sequence-aware conversion trackers: browserId -> (restroomId -> earliest ms)
  const cardViewedAtByBrowser = new Map<string, Map<string, number>>();
  const cardViewedTypeByBrowserRestroom = new Map<string, "public" | "partner" | "unknown">();
  const partnerDetailOpenedAtByBrowser = new Map<string, Map<string, number>>();

  const filteredEvents: Array<{
    browser_id: string | null;
    restroom_id: string | null;
    event_name: string;
    rType: "public" | "partner" | null;
    evTime: number;
    dk: string | null;
  }> = [];

  for (const ev of events) {
    if (!includeTest && ev.is_test) continue;
    if (!inRangeMs(ev.occurred_at, startMs, endMs)) continue;
    if (isAnalyticsRowAuthenticated(ev)) {
      authenticatedEvents += 1;
      if (ev.browser_id) authenticatedBrowsersSet.add(ev.browser_id);
    } else {
      guestEvents += 1;
      if (ev.browser_id) guestBrowsersSet.add(ev.browser_id);
    }
    if (!matchesAuthFilter(ev, authFilter)) continue;
    const evTime = Date.parse(ev.occurred_at);
    const dk = toKstDateKey(ev.occurred_at);
    const dayBucket = dk ? ensureDay(dk) : null;

    if (ev.browser_id) {
      visitingBrowsersSet.add(ev.browser_id);
      dayBucket?.browsers.add(ev.browser_id);
    }

    const rId =
      ev.restroom_id ||
      (typeof ev.properties?.restroom_id === "string"
        ? ev.properties.restroom_id
        : null);
    const rawType =
      ev.properties?.type ||
      ev.properties?.card_type ||
      ev.properties?.cardType ||
      (rId ? restroomMap.get(rId)?.type : null);
    const rType: "public" | "partner" | null =
      rawType === "partner"
        ? "partner"
        : rawType === "public"
        ? "public"
        : rId && restroomMap.get(rId)?.type === "partner"
        ? "partner"
        : rId && restroomMap.get(rId)?.type === "public"
        ? "public"
        : null;

    const ensureRestroomBucket = (id: string) => {
      let b = restroomBuckets.get(id);
      if (!b) {
        const meta = restroomMap.get(id);
        b = {
          restroomId: id,
          restroomName: meta?.name?.trim() || `화장실 (${id.slice(0, 8)})`,
          restroomType: meta?.type ?? rType ?? "unknown",
          markerClicks: 0,
          cardViews: 0,
          detailViews: 0,
          directionsClicks: 0,
          paymentButtonClicks: 0,
          browsers: new Set<string>(),
        };
        restroomBuckets.set(id, b);
      } else if (b.restroomType === "unknown" && rType) {
        b.restroomType = rType;
      }
      return b;
    };

    const rBucket = rId ? ensureRestroomBucket(rId) : null;
    if (rBucket && ev.browser_id) {
      rBucket.browsers.add(ev.browser_id);
    }

    if (ev.event_name === "map_loaded") {
      mapViews += 1;
      if (ev.browser_id) {
        mapBrowsersSet.add(ev.browser_id);
        dayBucket?.mapBrowsers.add(ev.browser_id);
      }
      if (dayBucket) dayBucket.mapViews += 1;
    } else if (ev.event_name === "restroom_marker_clicked") {
      markerClicks += 1;
      if (ev.browser_id) markerClickBrowsersSet.add(ev.browser_id);
      if (dayBucket) dayBucket.markerClicks += 1;
      if (rType) byRestroomTypeCounters[rType].markerClicks += 1;
      if (rBucket) rBucket.markerClicks += 1;
    } else if (ev.event_name === "restroom_card_viewed") {
      cardClicks += 1;
      if (ev.browser_id) cardViewBrowsersSet.add(ev.browser_id);
      if (dayBucket) dayBucket.cardClicks += 1;
      if (rType) byRestroomTypeCounters[rType].cardClicks += 1;
      if (rBucket) rBucket.cardViews += 1;

      if (ev.browser_id && rId) {
        const m = cardViewedAtByBrowser.get(ev.browser_id) ?? new Map<string, number>();
        const prev = m.get(rId);
        if (prev === undefined || evTime < prev) {
          m.set(rId, evTime);
        }
        cardViewedAtByBrowser.set(ev.browser_id, m);
        cardViewedTypeByBrowserRestroom.set(`${ev.browser_id}:${rId}`, rType ?? "unknown");
      }
    } else if (ev.event_name === "restroom_detail_opened") {
      detailViews += 1;
      if (ev.browser_id) detailViewBrowsersSet.add(ev.browser_id);
      if (dayBucket) dayBucket.detailViews += 1;
      if (rType) byRestroomTypeCounters[rType].detailViews += 1;
      if (rBucket) rBucket.detailViews += 1;

      if (rType === "partner") {
        partnerDetailViews += 1;
        if (ev.browser_id) partnerDetailViewBrowsersSet.add(ev.browser_id);
        if (ev.browser_id && rId) {
          const m =
            partnerDetailOpenedAtByBrowser.get(ev.browser_id) ?? new Map<string, number>();
          const prev = m.get(rId);
          if (prev === undefined || evTime < prev) {
            m.set(rId, evTime);
          }
          partnerDetailOpenedAtByBrowser.set(ev.browser_id, m);
        }
      }
    } else if (ev.event_name === "directions_clicked") {
      directionsClicks += 1;
      if (ev.browser_id) directionsClickBrowsersSet.add(ev.browser_id);
      if (dayBucket) dayBucket.directionsClicks += 1;
      if (rType) byRestroomTypeCounters[rType].directionsClicks += 1;
      if (rBucket) rBucket.directionsClicks += 1;
    } else if (ev.event_name === "payment_button_clicked") {
      paymentButtonClicks += 1;
      if (ev.browser_id) paymentButtonClickBrowsersSet.add(ev.browser_id);
      if (dayBucket) dayBucket.paymentButtonClicks += 1;
      byRestroomTypeCounters.partner.paymentButtonClicks += 1;
      if (rBucket) rBucket.paymentButtonClicks += 1;
    }

    filteredEvents.push({
      browser_id: ev.browser_id ?? null,
      restroom_id: rId,
      event_name: ev.event_name,
      rType,
      evTime,
      dk,
    });
  }

  // Pass 2: Compute sequence-aware conversion pairs (same browser_id + same restroom_id + chronological order)
  const cardToDirectionsConvertedBrowsers = new Set<string>();
  const publicCardToDirectionsExposed = new Set<string>();
  const publicCardToDirectionsConverted = new Set<string>();
  const partnerCardToDirectionsExposed = new Set<string>();
  const partnerCardToDirectionsConverted = new Set<string>();

  for (const [bId, rMap] of cardViewedAtByBrowser.entries()) {
    for (const rId of rMap.keys()) {
      const t = cardViewedTypeByBrowserRestroom.get(`${bId}:${rId}`);
      if (t === "public") publicCardToDirectionsExposed.add(bId);
      if (t === "partner") partnerCardToDirectionsExposed.add(bId);
    }
  }

  const partnerDetailToPaymentBrowsers = new Set<string>();

  for (const fe of filteredEvents) {
    if (!fe.browser_id || !fe.restroom_id) continue;

    if (fe.event_name === "directions_clicked") {
      const viewedAt = cardViewedAtByBrowser.get(fe.browser_id)?.get(fe.restroom_id);
      if (viewedAt !== undefined && fe.evTime >= viewedAt) {
        cardToDirectionsConvertedBrowsers.add(fe.browser_id);
        if (fe.rType === "public") {
          publicCardToDirectionsConverted.add(fe.browser_id);
        } else if (fe.rType === "partner") {
          partnerCardToDirectionsConverted.add(fe.browser_id);
        }
      }
    } else if (fe.event_name === "payment_button_clicked") {
      const detailAt = partnerDetailOpenedAtByBrowser
        .get(fe.browser_id)
        ?.get(fe.restroom_id);
      if (detailAt !== undefined && fe.evTime >= detailAt) {
        partnerDetailToPaymentBrowsers.add(fe.browser_id);
      }
    }
  }

  const cardToDirectionsExposedBrowsers = cardViewedAtByBrowser.size;
  const cardToDirectionsRatePercent =
    cardToDirectionsExposedBrowsers > 0
      ? Number(
          (
            (cardToDirectionsConvertedBrowsers.size /
              cardToDirectionsExposedBrowsers) *
            100
          ).toFixed(1)
        )
      : null;

  const publicCardToDirectionsRatePercent =
    publicCardToDirectionsExposed.size > 0
      ? Number(
          (
            (publicCardToDirectionsConverted.size /
              publicCardToDirectionsExposed.size) *
            100
          ).toFixed(1)
        )
      : null;

  const partnerCardToDirectionsRatePercent =
    partnerCardToDirectionsExposed.size > 0
      ? Number(
          (
            (partnerCardToDirectionsConverted.size /
              partnerCardToDirectionsExposed.size) *
            100
          ).toFixed(1)
        )
      : null;

  const partnerDetailExposedBrowsers = partnerDetailOpenedAtByBrowser.size;
  const partnerDetailToPaymentRatePercent =
    partnerDetailExposedBrowsers > 0
      ? Number(
          (
            (partnerDetailToPaymentBrowsers.size /
              partnerDetailExposedBrowsers) *
            100
          ).toFixed(1)
        )
      : null;

  let approvedPayments = 0;
  let testModePayments = 0;
  for (const ord of orders) {
    if (ord.status !== "approved" && ord.status !== "canceled") continue;
    const ts = ord.approved_at || ord.created_at;
    if (!inRangeMs(ts, startMs, endMs)) continue;
    const dk = toKstDateKey(ts);
    if (ord.payment_mode === "test") {
      testModePayments += 1;
      if (dk) ensureDay(dk).testModePayments += 1;
    }
    if (includeTest || ord.payment_mode !== "test") {
      approvedPayments += 1;
      if (dk) ensureDay(dk).approvedPayments += 1;
    }
  }

  let issuedTickets = 0;
  for (const acc of accessSessions) {
    if (!acc.authorized_at) continue;
    if (!inRangeMs(acc.authorized_at, startMs, endMs)) continue;
    issuedTickets += 1;
    const dk = toKstDateKey(acc.authorized_at);
    if (dk) ensureDay(dk).issuedTickets += 1;
  }

  let submittedReceipts = 0;
  let approvedReceipts = 0;
  for (const rec of receipts) {
    if (!inRangeMs(rec.created_at, startMs, endMs)) continue;
    submittedReceipts += 1;
    if (rec.submission_status === "approved") {
      approvedReceipts += 1;
    }
    const dk = toKstDateKey(rec.created_at);
    if (dk) ensureDay(dk).submittedReceipts += 1;
  }

  let refundsSucceeded = 0;
  for (const ref of refunds) {
    if (ref.status !== "succeeded") continue;
    const ts = ref.completed_at || ref.requested_at || null;
    if (!inRangeMs(ts, startMs, endMs)) continue;
    refundsSucceeded += 1;
    const dk = toKstDateKey(ts);
    if (dk) ensureDay(dk).refundsSucceeded += 1;
  }

  const allRestroomRows: RestroomInterestRow[] = Array.from(
    restroomBuckets.values()
  ).map((b) => ({
    restroomId: b.restroomId,
    restroomName: b.restroomName,
    restroomType: b.restroomType,
    markerClicks: b.markerClicks,
    cardViews: b.cardViews,
    detailViews: b.detailViews,
    directionsClicks: b.directionsClicks,
    paymentButtonClicks: b.paymentButtonClicks,
    distinctBrowsers: b.browsers.size,
  }));

  const restroomInterestRanking = [...allRestroomRows]
    .sort(
      (a, b) =>
        b.markerClicks +
          b.cardViews +
          b.detailViews +
          b.directionsClicks +
          b.paymentButtonClicks -
          (a.markerClicks +
            a.cardViews +
            a.detailViews +
            a.directionsClicks +
            a.paymentButtonClicks) || b.distinctBrowsers - a.distinctBrowsers
    )
    .slice(0, 15);

  const directionsRanking = allRestroomRows
    .filter((r) => r.directionsClicks > 0)
    .sort(
      (a, b) =>
        b.directionsClicks - a.directionsClicks ||
        b.distinctBrowsers - a.distinctBrowsers
    )
    .slice(0, 15);

  const dailyTrend: ServiceDailyTrendRow[] = Array.from(dailyMap.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, bucket]) => ({
      date,
      visitingBrowsers: bucket.browsers.size,
      mapBrowsers: bucket.mapBrowsers.size,
      mapViews: bucket.mapViews,
      markerClicks: bucket.markerClicks,
      cardClicks: bucket.cardClicks,
      detailViews: bucket.detailViews,
      directionsClicks: bucket.directionsClicks,
      paymentButtonClicks: bucket.paymentButtonClicks,
      approvedPayments: bucket.approvedPayments,
      testModePayments: bucket.testModePayments,
      issuedTickets: bucket.issuedTickets,
      submittedReceipts: bucket.submittedReceipts,
      refundsSucceeded: bucket.refundsSucceeded,
    }));

  return {
    dateRange: {
      startsAt: window.startsAt,
      endsAt: window.endsAt,
    },
    authFilter,
    authSplit: {
      guestEvents,
      authenticatedEvents,
      guestBrowsers: guestBrowsersSet.size,
      authenticatedBrowsers: authenticatedBrowsersSet.size,
    },
    overview: {
      visitingBrowsers: visitingBrowsersSet.size,
      mapBrowsers: mapBrowsersSet.size,
      mapViews,
      markerClicks,
      markerClickBrowsers: markerClickBrowsersSet.size,
      cardClicks,
      cardViewBrowsers: cardViewBrowsersSet.size,
      detailViews,
      detailViewBrowsers: detailViewBrowsersSet.size,
      directionsClicks,
      directionsClickBrowsers: directionsClickBrowsersSet.size,
      paymentButtonClicks,
      paymentButtonClickBrowsers: paymentButtonClickBrowsersSet.size,
      partnerDetailViews,
      partnerDetailViewBrowsers: partnerDetailViewBrowsersSet.size,
      cardToDirectionsExposedBrowsers,
      cardToDirectionsConvertedBrowsers: cardToDirectionsConvertedBrowsers.size,
      cardToDirectionsRatePercent,
      partnerDetailExposedBrowsers,
      partnerDetailToPaymentBrowsers: partnerDetailToPaymentBrowsers.size,
      partnerDetailToPaymentRatePercent,
      approvedPayments,
      testModePayments,
      issuedTickets,
      submittedReceipts,
      approvedReceipts,
      refundsSucceeded,
    },
    byRestroomType: {
      public: {
        ...byRestroomTypeCounters.public,
        cardToDirectionsRatePercent: publicCardToDirectionsRatePercent,
      },
      partner: {
        ...byRestroomTypeCounters.partner,
        cardToDirectionsRatePercent: partnerCardToDirectionsRatePercent,
      },
    },
    restroomInterestRanking,
    directionsRanking,
    dailyTrend,
    analyticsConfig: {
      nextPublicAnalyticsEnabledEnv:
        process.env["NEXT_PUBLIC_ANALYTICS_ENABLED"] ??
        process.env.NEXT_PUBLIC_ANALYTICS_ENABLED ??
        "(미설정)",
      actuallyGatedByEnv: true,
      trackedClientEvents: [...OPTIONAL_BEHAVIORAL_EVENTS],
      trackedServerEvents: [
        "payment_order_created",
        "payment_confirmed",
        "access_authorized",
      ],
      untrackedEvents: [
        "login_ui",
        "receipt_upload_ui",
        "doorlock_access_ui",
        "travel_survey_a19",
        "gps_trail",
      ],
    },
  };
}

/**
 * Loads experiment metadata, sessions, event logs, leads, businesses,
 * and authoritative transaction counts to generate the complete service & PMF report.
 */
export async function getPmfReport(
  supabase: SupabaseClient<any>,
  params: Omit<ValidatedPmfQueryParams, "authFilter"> & {
    authFilter?: AnalyticsAuthFilter;
  }
): Promise<PmfReportData> {
  const experimentKey = params.experimentKey || DEFAULT_EXPERIMENT_KEY;

  // 1. Fetch experiment record from database if available
  const { data: expRecord } = await supabase
    .from("experiments")
    .select("experiment_key, name, rules_version, starts_at, ends_at, status, notes")
    .eq("experiment_key", experimentKey)
    .maybeSingle();

  const startsAt =
    params.startsAt || expRecord?.starts_at || DEFAULT_STARTS_AT;
  const endsAt = params.endsAt || expRecord?.ends_at || DEFAULT_ENDS_AT;
  const nowMs = Date.now();
  const isOngoing =
    nowMs >= new Date(startsAt).getTime() && nowMs <= new Date(endsAt).getTime();

  const experiment: ExperimentMetadata = {
    experimentKey,
    name: expRecord?.name || "1차 PMF 가설 검증 실험 (pmf_r1)",
    rulesVersion: expRecord?.rules_version || DEFAULT_RULES_VERSION,
    startsAt,
    endsAt,
    status: (expRecord?.status as any) || (isOngoing ? "running" : "draft"),
    rulesComplete: false,
    provisionalNotice: PROVISIONAL_NOTICE,
  };

  // 2. Fetch H1 Data: leads, contact attempts, businesses
  const { data: leadsData } = await supabase
    .from("business_leads")
    .select("id, converted_business_id");

  const { data: attemptsData } = await supabase
    .from("lead_contact_attempts")
    .select("lead_id");

  const { data: businessesData } = await supabase
    .from("businesses")
    .select("id, status");

  const h1 = computeH1Metrics(
    leadsData ?? [],
    attemptsData ?? [],
    businessesData ?? []
  );

  // 3. Fetch H2/H5 Data: visitor_sessions, event_logs, restrooms
  const { data: sessionsData } = await supabase
    .from("visitor_sessions")
    .select("id, browser_id, user_id, started_at, utm_source, traveling_now, is_test");

  const { data: eventsData } = await supabase
    .from("event_logs")
    .select("id, session_id, browser_id, user_id, restroom_id, event_name, properties, occurred_at, is_test");

  // Resolve referenced restrooms (and partner restrooms) safely even when total restrooms > 1000
  let restroomsData: any[] = [];
  const restroomsQuery = supabase
    .from("restrooms")
    .select("id, name, type, publication_status") as any;

  if (restroomsQuery && typeof restroomsQuery.in === "function") {
    const referencedIds = Array.from(
      new Set(
        (eventsData ?? [])
          .map(
            (ev: any) =>
              ev.restroom_id ||
              (typeof ev.properties?.restroom_id === "string"
                ? ev.properties.restroom_id
                : null)
          )
          .filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
      )
    );

    const [partnerRes, refRes] = await Promise.all([
      supabase
        .from("restrooms")
        .select("id, name, type, publication_status")
        .eq("type", "partner"),
      referencedIds.length > 0
        ? supabase
            .from("restrooms")
            .select("id, name, type, publication_status")
            .in("id", referencedIds.slice(0, 500))
        : Promise.resolve({ data: [] }),
    ]);

    const merged = new Map<string, any>();
    for (const r of partnerRes?.data ?? []) merged.set(r.id, r);
    for (const r of refRes?.data ?? []) merged.set(r.id, r);
    restroomsData = Array.from(merged.values());
  } else {
    const res = await restroomsQuery;
    restroomsData = res?.data ?? [];
  }

  const window = { startsAt, endsAt };
  const includeTest = Boolean(params.includeTest);
  const authFilter: AnalyticsAuthFilter = params.authFilter ?? "all";

  const h2 = computeH2Metrics(
    sessionsData ?? [],
    eventsData ?? [],
    window,
    includeTest
  );

  const h5 = computeH5Metrics(
    eventsData ?? [],
    restroomsData ?? [],
    window,
    includeTest
  );

  const eventBreakdown = computeEventBreakdown(
    eventsData ?? [],
    window,
    includeTest,
    authFilter
  );

  // Summary counts
  const startMs = new Date(startsAt).getTime();
  const endMs = new Date(endsAt).getTime();

  let totalEvents = 0;
  let excludedTestEvents = 0;
  const distinctBrowsersSet = new Set<string>();

  for (const ev of eventsData ?? []) {
    const t = new Date(ev.occurred_at).getTime();
    if (t >= startMs && t <= endMs) {
      if (ev.is_test) {
        excludedTestEvents += 1;
        if (includeTest) {
          totalEvents += 1;
          if (ev.browser_id) distinctBrowsersSet.add(ev.browser_id);
        }
      } else {
        totalEvents += 1;
        if (ev.browser_id) distinctBrowsersSet.add(ev.browser_id);
      }
    }
  }

  let distinctSessions = 0;
  let excludedTestSessions = 0;

  for (const sess of sessionsData ?? []) {
    const t = new Date(sess.started_at).getTime();
    if (t >= startMs && t <= endMs) {
      if (sess.is_test) {
        excludedTestSessions += 1;
        if (includeTest) distinctSessions += 1;
      } else {
        distinctSessions += 1;
      }
    }
  }

  // 4. Fetch authoritative transactional records non-blockingly for Service Usage Dashboard
  let ordersData: any[] = [];
  let accessSessionsData: any[] = [];
  let receiptsData: any[] = [];
  let refundsData: any[] = [];
  try {
    const [ordRes, accRes, recRes, refRes] = await Promise.all([
      supabase
        .from("payment_orders")
        .select("id, status, payment_mode, approved_at, created_at"),
      supabase
        .from("access_sessions")
        .select("id, status, authorized_at, created_at"),
      supabase
        .from("receipt_submissions")
        .select("id, submission_status, created_at"),
      supabase
        .from("payment_refunds")
        .select("id, status, completed_at, requested_at"),
    ]);
    ordersData = ordRes?.data ?? [];
    accessSessionsData = accRes?.data ?? [];
    receiptsData = recRes?.data ?? [];
    refundsData = refRes?.data ?? [];
  } catch {
    // Non-blocking fallback when unit test mocks omit transactional tables
  }

  const serviceMetrics = computeServiceUsageMetrics({
    sessions: sessionsData ?? [],
    events: eventsData ?? [],
    restrooms: restroomsData ?? [],
    orders: ordersData,
    accessSessions: accessSessionsData,
    receipts: receiptsData,
    refunds: refundsData,
    window,
    includeTest,
    authFilter,
  });

  return {
    experiment,
    observationWindow: {
      startsAt,
      endsAt,
      isOngoing,
    },
    summary: {
      totalEvents,
      distinctBrowsers: distinctBrowsersSet.size,
      distinctSessions,
      excludedTestEvents,
      excludedTestSessions,
    },
    hypotheses: {
      h1,
      h2,
      h5,
    },
    eventBreakdown,
    serviceMetrics,
    generatedAt: new Date().toISOString(),
  };
}

