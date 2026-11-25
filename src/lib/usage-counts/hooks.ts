"use client";

import { useCallback, useRef } from "react";
import { trackBasicUsageSafe } from "@/lib/events/client";

/**
 * Hook for non-identifying, consent-free daily execution counts.
 * Deduplicates StrictMode double-mounts and rapid accidental double clicks in memory without creating any identifier.
 */
export function useBasicUsageTracker() {
  const hasTrackedMapOpenedRef = useRef<boolean>(false);
  const openedDetailIdsRef = useRef<Set<string>>(new Set());
  const lastMarkerAtRef = useRef<number>(0);
  const lastSearchAtRef = useRef<number>(0);
  const lastDirectionsAtRef = useRef<number>(0);
  const lastPaymentAtRef = useRef<number>(0);

  const trackBasicMapOpened = useCallback(() => {
    if (hasTrackedMapOpenedRef.current) return;
    hasTrackedMapOpenedRef.current = true;
    void trackBasicUsageSafe("map_opened");
  }, []);

  const trackBasicMarkerClicked = useCallback(() => {
    const now = Date.now();
    if (now - lastMarkerAtRef.current < 300) return;
    lastMarkerAtRef.current = now;
    void trackBasicUsageSafe("restroom_marker_clicked");
  }, []);

  const trackBasicDetailOpened = useCallback((restroomLocalDedupId: string) => {
    // Only used in-memory on the client to prevent React StrictMode double-mount counting; never transmitted.
    if (openedDetailIdsRef.current.has(restroomLocalDedupId)) return;
    openedDetailIdsRef.current.add(restroomLocalDedupId);
    void trackBasicUsageSafe("restroom_detail_opened");
  }, []);

  const trackBasicSearchExecuted = useCallback(() => {
    const now = Date.now();
    if (now - lastSearchAtRef.current < 500) return;
    lastSearchAtRef.current = now;
    void trackBasicUsageSafe("search_executed");
  }, []);

  const trackBasicDirectionsClicked = useCallback(() => {
    const now = Date.now();
    if (now - lastDirectionsAtRef.current < 500) return;
    lastDirectionsAtRef.current = now;
    void trackBasicUsageSafe("directions_clicked");
  }, []);

  const trackBasicPaymentButtonClicked = useCallback(() => {
    const now = Date.now();
    if (now - lastPaymentAtRef.current < 500) return;
    lastPaymentAtRef.current = now;
    void trackBasicUsageSafe("payment_button_clicked");
  }, []);

  return {
    trackBasicMapOpened,
    trackBasicMarkerClicked,
    trackBasicDetailOpened,
    trackBasicSearchExecuted,
    trackBasicDirectionsClicked,
    trackBasicPaymentButtonClicked,
  };
}
