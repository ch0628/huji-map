"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import type { PublicRestroomSummary, PublicRestroomDetail } from "@/lib/restrooms/types";
import {
  ensureVisitorSession,
  getOrCreateBrowserId,
  getActiveSessionId,
  trackEventSafe,
  submitTravelAnswer,
  getDeviceType,
  type TrackEventOptions,
} from "./client";
import type { EventIngestResult, TravelAnswerResult } from "./types";

export interface UseVisitorSessionResult {
  sessionId: string | null;
  browserId: string;
  isReady: boolean;
  error: Error | null;
}

/**
 * React hook to manage visitor session initialization on client mount.
 * Deduplicates in StrictMode and ensures session is registered before event dispatch.
 */
export function useVisitorSession(): UseVisitorSessionResult {
  const [sessionId, setSessionId] = useState<string | null>(() => getActiveSessionId());
  const [browserId, setBrowserId] = useState<string>("");
  const [isReady, setIsReady] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);
  const isInitializingRef = useRef<boolean>(false);

  useEffect(() => {
    const bId = getOrCreateBrowserId();
    setBrowserId(bId);

    const active = getActiveSessionId();
    if (active) {
      setSessionId(active);
      setIsReady(true);
      return;
    }

    if (isInitializingRef.current) return;
    isInitializingRef.current = true;

    ensureVisitorSession()
      .then((newSessionId) => {
        setSessionId(newSessionId);
        setIsReady(true);
      })
      .catch((err) => {
        setError(err instanceof Error ? err : new Error("세션 초기화 실패"));
        setIsReady(true); // 비차단 복구
      });
  }, []);

  return { sessionId, browserId, isReady, error };
}

export interface TrackMapLoadedInput {
  zoom: number;
  restroomCount: number;
  filter: "all" | "public" | "partner";
  centerRegion?: string;
  pagePath?: string;
}

export interface TrackMarkerClickedInput {
  restroom: PublicRestroomSummary;
  markerIndex: number;
  pagePath?: string;
}

export interface TrackCardViewedInput {
  restroom: PublicRestroomSummary;
  source?: "marker_selection" | "list_drawer" | "direct_query";
  pagePath?: string;
}

export interface TrackDetailOpenedInput {
  restroom: PublicRestroomSummary | PublicRestroomDetail;
  sourceComponent?: "card_detail_link" | "direct_url";
  pagePath?: string;
}

export interface TrackDirectionsClickedInput {
  restroom: {
    id: string;
    type: "public" | "partner";
    business_id?: string | null;
  };
  service: "kakao" | "naver" | "google";
  hasOrigin: boolean;
  pagePath?: string;
}

export interface TrackPaymentButtonClickedInput {
  restroom: PublicRestroomSummary | PublicRestroomDetail;
  policyId?: string | null;
  depositAmountKrw?: number;
  pagePath?: string;
}

export interface TrackPaymentUnavailableShownInput {
  restroom: PublicRestroomSummary | PublicRestroomDetail;
  reason?: string;
  pagePath?: string;
}

/**
 * Hook providing deduplicated event tracking methods for all required UI actions.
 * Prevents duplicate events caused by React StrictMode, re-renders, and rapid clicks.
 */
export function useEventTracker() {
  const hasTrackedLandingRef = useRef<boolean>(false);
  const hasTrackedMapLoadedRef = useRef<boolean>(false);
  const viewedCardIdsRef = useRef<Set<string>>(new Set());
  const unavailableNoticeIdsRef = useRef<Set<string>>(new Set());
  const lastClickedMarkerRef = useRef<{ id: string; time: number } | null>(null);

  /**
   * Records landing_view once per component lifecycle.
   */
  const trackLandingView = useCallback(
    async (options?: { landingPath?: string; referrer?: string }): Promise<EventIngestResult | null> => {
      if (hasTrackedLandingRef.current) {
        return null;
      }
      hasTrackedLandingRef.current = true;

      let landingPath = options?.landingPath ?? "/map";
      let referrer = options?.referrer ?? null;
      let utmSource: string | null = null;
      let utmMedium: string | null = null;
      let utmCampaign: string | null = null;
      let utmContent: string | null = null;
      let utmTerm: string | null = null;

      if (typeof window !== "undefined") {
        landingPath = options?.landingPath ?? window.location.pathname ?? "/map";
        referrer = options?.referrer ?? (document.referrer || null);
        try {
          const sp = new URLSearchParams(window.location.search);
          utmSource = sp.get("utm_source");
          utmMedium = sp.get("utm_medium");
          utmCampaign = sp.get("utm_campaign");
          utmContent = sp.get("utm_content");
          utmTerm = sp.get("utm_term");
        } catch {}
      }

      const properties: Record<string, unknown> = {
        landing_path: landingPath,
        referrer,
        device_type: getDeviceType(),
      };
      if (utmSource) properties.utm_source = utmSource;
      if (utmMedium) properties.utm_medium = utmMedium;
      if (utmCampaign) properties.utm_campaign = utmCampaign;
      if (utmContent) properties.utm_content = utmContent;
      if (utmTerm) properties.utm_term = utmTerm;

      return trackEventSafe({
        eventName: "landing_view",
        context: {
          pagePath: landingPath,
          componentId: "landing_shell",
        },
        properties,
      });
    },
    []
  );

  /**
   * Records map_loaded when Kakao Map finishes its initial rendering and tile loading.
   * Deduplicated so subsequent panning/zooming does not re-emit map_loaded.
   */
  const trackMapLoaded = useCallback(
    async (input: TrackMapLoadedInput): Promise<EventIngestResult | null> => {
      if (hasTrackedMapLoadedRef.current) {
        return null;
      }
      hasTrackedMapLoadedRef.current = true;

      const pagePath = input.pagePath ?? (typeof window !== "undefined" ? window.location.pathname : "/map");

      return trackEventSafe({
        eventName: "map_loaded",
        context: {
          pagePath,
          componentId: "map_canvas",
        },
        properties: {
          zoom: input.zoom,
          restroom_count: input.restroomCount,
          filter: input.filter,
          center_region: input.centerRegion ?? "수원시",
        },
      });
    },
    []
  );

  /**
   * Records restroom_marker_clicked when user clicks on a marker.
   * Includes 300ms debounce for rapid repeated clicks on the exact same marker.
   */
  const trackMarkerClicked = useCallback(
    async (input: TrackMarkerClickedInput): Promise<EventIngestResult | null> => {
      const now = Date.now();
      if (
        lastClickedMarkerRef.current &&
        lastClickedMarkerRef.current.id === input.restroom.id &&
        now - lastClickedMarkerRef.current.time < 300
      ) {
        return null;
      }
      lastClickedMarkerRef.current = { id: input.restroom.id, time: now };

      const pagePath = input.pagePath ?? (typeof window !== "undefined" ? window.location.pathname : "/map");

      return trackEventSafe({
        eventName: "restroom_marker_clicked",
        context: {
          restroomId: input.restroom.id,
          businessId: input.restroom.business_id ?? null,
          pagePath,
          componentId: "map_marker",
        },
        properties: {
          restroom_id: input.restroom.id,
          type: input.restroom.type,
          marker_index: input.markerIndex,
          access_method: input.restroom.access_method,
        },
      });
    },
    []
  );

  /**
   * Records restroom_card_viewed when a card is exposed to the user in the bottom sheet or list.
   * Deduplicated per restroom ID so parent re-renders do not generate spurious exposures.
   */
  const trackCardViewed = useCallback(
    async (input: TrackCardViewedInput): Promise<EventIngestResult | null> => {
      if (viewedCardIdsRef.current.has(input.restroom.id)) {
        return null;
      }
      viewedCardIdsRef.current.add(input.restroom.id);

      const pagePath = input.pagePath ?? (typeof window !== "undefined" ? window.location.pathname : "/map");

      return trackEventSafe({
        eventName: "restroom_card_viewed",
        context: {
          restroomId: input.restroom.id,
          businessId: input.restroom.business_id ?? null,
          pagePath,
          componentId: "restroom_card",
        },
        properties: {
          card_type: input.restroom.type,
          visibility_rule_version: "v1_bottom_sheet",
          restroom_id: input.restroom.id,
          source: input.source ?? "marker_selection",
        },
      });
    },
    []
  );

  /**
   * Records restroom_detail_opened when user visits /restrooms/[id].
   */
  const trackDetailOpened = useCallback(
    async (input: TrackDetailOpenedInput): Promise<EventIngestResult | null> => {
      const pagePath =
        input.pagePath ?? (typeof window !== "undefined" ? window.location.pathname : `/restrooms/${input.restroom.id}`);

      return trackEventSafe({
        eventName: "restroom_detail_opened",
        context: {
          restroomId: input.restroom.id,
          businessId: input.restroom.business_id ?? null,
          pagePath,
          componentId: "restroom_detail_view",
        },
        properties: {
          restroom_id: input.restroom.id,
          type: input.restroom.type,
          source_component: input.sourceComponent ?? "card_detail_link",
        },
      });
    },
    []
  );

  /**
   * Records directions_clicked when user clicks Kakao/Naver/Google navigation link.
   * Dispatched non-blockingly before opening the external link.
   */
  const trackDirectionsClicked = useCallback(
    async (input: TrackDirectionsClickedInput): Promise<EventIngestResult | null> => {
      const pagePath = input.pagePath ?? (typeof window !== "undefined" ? window.location.pathname : "/map");

      return trackEventSafe({
        eventName: "directions_clicked",
        context: {
          restroomId: input.restroom.id,
          businessId: input.restroom.business_id ?? null,
          pagePath,
          componentId: "directions_modal",
        },
        properties: {
          service: input.service,
          restroom_id: input.restroom.id,
          type: input.restroom.type,
          has_origin: input.hasOrigin,
        },
      });
    },
    []
  );

  /**
   * Records payment_button_clicked when user clicks the deposit payment button on a partner restroom.
   */
  const trackPaymentButtonClicked = useCallback(
    async (input: TrackPaymentButtonClickedInput): Promise<EventIngestResult | null> => {
      const pagePath = input.pagePath ?? (typeof window !== "undefined" ? window.location.pathname : "/map");

      return trackEventSafe({
        eventName: "payment_button_clicked",
        context: {
          restroomId: input.restroom.id,
          businessId: input.restroom.business_id ?? null,
          pagePath,
          componentId: "payment_button",
        },
        properties: {
          restroom_id: input.restroom.id,
          policy_id: input.policyId ?? null,
          deposit_amount_krw: input.depositAmountKrw ?? 1000,
        },
      });
    },
    []
  );

  /**
   * Records payment_unavailable_shown when the partner payment unavailable notice is shown.
   * Deduplicated per restroom ID to avoid flooding logs.
   */
  const trackPaymentUnavailableShown = useCallback(
    async (input: TrackPaymentUnavailableShownInput): Promise<EventIngestResult | null> => {
      if (unavailableNoticeIdsRef.current.has(input.restroom.id)) {
        return null;
      }
      unavailableNoticeIdsRef.current.add(input.restroom.id);

      const pagePath = input.pagePath ?? (typeof window !== "undefined" ? window.location.pathname : "/map");

      return trackEventSafe({
        eventName: "payment_unavailable_shown",
        context: {
          restroomId: input.restroom.id,
          businessId: input.restroom.business_id ?? null,
          pagePath,
          componentId: "payment_unavailable_notice",
        },
        properties: {
          restroom_id: input.restroom.id,
          reason: input.reason ?? "feature_in_preparation",
        },
      });
    },
    []
  );

  /**
   * Submits H2 travel answer via PATCH /api/v1/sessions/:id/travel-answer.
   * Does NOT use trackEvent directly to preserve authoritative server verification.
   */
  const submitTravel = useCallback(
    async (travelingNow: boolean, sessionId?: string | null): Promise<TravelAnswerResult> => {
      return submitTravelAnswer(travelingNow, sessionId);
    },
    []
  );

  return {
    trackLandingView,
    trackMapLoaded,
    trackMarkerClicked,
    trackCardViewed,
    trackDetailOpened,
    trackDirectionsClicked,
    trackPaymentButtonClicked,
    trackPaymentUnavailableShown,
    submitTravel,
  };
}

