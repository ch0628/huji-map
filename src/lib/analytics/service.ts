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
  EventBreakdownItem,
  ExperimentMetadata,
  MetricHypothesisH1,
  MetricHypothesisH2,
  MetricHypothesisH5,
  PmfReportData,
} from "./types";
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

  // Browser ID -> Set of partner restroom IDs the browser was exposed to
  const exposedPartnerRestroomsByBrowser = new Map<string, Set<string>>();

  let excludedPublicDirectionsCount = 0;
  let excludedMismatchedPartnerDirectionsCount = 0;

  // 1. Pass 1: Identify all partner restroom card exposures
  for (const ev of events) {
    if (!includeTest && ev.is_test) continue;
    const evTime = new Date(ev.occurred_at).getTime();
    if (evTime < startMs || evTime > endMs) continue;

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
        const set = exposedPartnerRestroomsByBrowser.get(ev.browser_id) ?? new Set();
        set.add(restroomId);
        exposedPartnerRestroomsByBrowser.set(ev.browser_id, set);
      }
    }
  }

  // H5 Denominator: Distinct browsers with >= 1 partner restroom card exposure
  const denominatorCount = exposedPartnerRestroomsByBrowser.size;

  // 2. Pass 2: Directions events for the SAME partner restroom
  const convertedBrowsers = new Set<string>();

  for (const ev of events) {
    if (!includeTest && ev.is_test) continue;
    const evTime = new Date(ev.occurred_at).getTime();
    if (evTime < startMs || evTime > endMs) continue;

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

      const exposedSet = exposedPartnerRestroomsByBrowser.get(ev.browser_id);
      if (exposedSet && restroomId) {
        if (exposedSet.has(restroomId)) {
          // Matched exact same partner restroom!
          convertedBrowsers.add(ev.browser_id);
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

/**
 * Computes event breakdown summary and deduplicated browser counts.
 */
export function computeEventBreakdown(
  events: Array<{
    event_name: string;
    browser_id?: string | null;
    occurred_at: string;
    is_test?: boolean | null;
  }>,
  window: { startsAt: string; endsAt: string },
  includeTest = false
): EventBreakdownItem[] {
  const startMs = new Date(window.startsAt).getTime();
  const endMs = new Date(window.endsAt).getTime();

  const countsByName = new Map<string, number>();
  const browsersByName = new Map<string, Set<string>>();

  const KNOWN_EVENTS = [
    "landing_view",
    "map_loaded",
    "restroom_marker_clicked",
    "restroom_card_viewed",
    "restroom_detail_opened",
    "directions_clicked",
    "travel_answer_submitted",
    "payment_button_clicked",
    "payment_unavailable_shown",
  ];

  for (const name of KNOWN_EVENTS) {
    countsByName.set(name, 0);
    browsersByName.set(name, new Set());
  }

  for (const ev of events) {
    if (!includeTest && ev.is_test) continue;
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

/**
 * Loads experiment metadata, sessions, event logs, leads, and businesses,
 * then generates the complete PMF report.
 */
export async function getPmfReport(
  supabase: SupabaseClient<any>,
  params: ValidatedPmfQueryParams
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
    .select("id, browser_id, started_at, utm_source, traveling_now, is_test");

  const { data: eventsData } = await supabase
    .from("event_logs")
    .select("id, session_id, browser_id, restroom_id, event_name, properties, occurred_at, is_test");

  const { data: restroomsData } = await supabase
    .from("restrooms")
    .select("id, type, publication_status");

  const window = { startsAt, endsAt };
  const includeTest = Boolean(params.includeTest);

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
    includeTest
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
    generatedAt: new Date().toISOString(),
  };
}

