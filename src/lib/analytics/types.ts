/**
 * Type definitions for PMF (Product-Market Fit) analytics & hypothesis validation.
 * Spec: docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, docs/06_EVENTS_AND_PMF.md, docs/11_DECISIONS.md
 *
 * Rules:
 * - H1: 50 distinct contacted businesses, >= 5 valid approved registrations
 * - H2: Ad landing browser marked travelingNow=true in testing window; among eligible 50 distinct browser IDs, >= 5 performed directions_clicked
 * - H5: Among 50 distinct browser IDs exposed to an approved partner restroom card, >= 5 clicked directions for that SAME partner restroom
 * - rulesComplete: MUST be false until canonical 19 detailed rules are imported
 * - No PII, passwords, tokens, PINs, or raw GPS coordinates
 */

export interface ExperimentMetadata {
  experimentKey: string;
  name: string;
  rulesVersion: string;
  startsAt: string;
  endsAt: string;
  status: "draft" | "running" | "closed";
  /** Canonical 19 sub-rules are not yet finalized in workspace -> MUST be false */
  rulesComplete: false;
  /** Explicit statement explaining provisional nature */
  provisionalNotice: string;
}

export interface MetricHypothesisH1 {
  hypothesisKey: "H1";
  name: string;
  definition: string;
  /** H1 Denominator: Distinct contacted leads with >= 1 contact attempt */
  denominatorCount: number;
  targetDenominator: number;
  /** H1 Numerator: Distinct leads converted into an approved business */
  numeratorCount: number;
  targetNumerator: number;
  /** Conversion rate percentage (0.0 to 100.0) */
  conversionRatePercent: number;
  isTargetMet: boolean;
  isSufficientData: boolean;
  status: "provisional" | "insufficient_data";
}

export interface MetricHypothesisH2 {
  hypothesisKey: "H2";
  name: string;
  definition: string;
  /** H2 Denominator: Distinct browser IDs with ad UTM and travelingNow=true */
  denominatorCount: number;
  targetDenominator: number;
  /** H2 Numerator: Distinct qualified browsers who performed directions_clicked */
  numeratorCount: number;
  targetNumerator: number;
  /** Conversion rate percentage (0.0 to 100.0) */
  conversionRatePercent: number;
  isTargetMet: boolean;
  isSufficientData: boolean;
  status: "provisional" | "insufficient_data";
  /** Exclusions breakdown */
  excludedOrganicCount: number;
  excludedNonTravelingCount: number;
}

export interface MetricHypothesisH5 {
  hypothesisKey: "H5";
  name: string;
  definition: string;
  /** H5 Denominator: Distinct browser IDs exposed to an approved partner restroom card */
  denominatorCount: number;
  targetDenominator: number;
  /** H5 Numerator: Distinct browsers who clicked directions for the SAME partner restroom */
  numeratorCount: number;
  targetNumerator: number;
  /** Conversion rate percentage (0.0 to 100.0) */
  conversionRatePercent: number;
  isTargetMet: boolean;
  isSufficientData: boolean;
  status: "provisional" | "insufficient_data";
  /** Exclusions breakdown */
  excludedPublicDirectionsCount: number;
  excludedMismatchedPartnerDirectionsCount: number;
}

export interface EventBreakdownItem {
  eventName: string;
  rawEventCount: number;
  distinctBrowserCount: number;
}

export type AnalyticsAuthFilter = "all" | "guest" | "authenticated";

export interface PmfAnalyticsFilter {
  experimentKey?: string;
  startsAt?: string;
  endsAt?: string;
  includeTest?: boolean;
  authFilter?: AnalyticsAuthFilter;
}

export interface ServiceDailyTrendRow {
  date: string; // YYYY-MM-DD (KST)
  visitingBrowsers: number;
  mapBrowsers: number;
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

export interface ServiceRestroomTypeStats {
  markerClicks: number;
  cardClicks: number;
  detailViews: number;
  directionsClicks: number;
  paymentButtonClicks: number;
  cardToDirectionsRatePercent: number | null;
}

export interface RestroomInterestRow {
  restroomId: string;
  restroomName: string;
  restroomType: "public" | "partner" | "unknown";
  markerClicks: number;
  cardViews: number;
  detailViews: number;
  directionsClicks: number;
  paymentButtonClicks: number;
  distinctBrowsers: number;
}

export interface ServiceUsageMetrics {
  dateRange: {
    startsAt: string;
    endsAt: string;
  };
  authFilter?: AnalyticsAuthFilter;
  authSplit?: {
    guestEvents: number;
    authenticatedEvents: number;
    guestBrowsers: number;
    authenticatedBrowsers: number;
  };
  overview: {
    visitingBrowsers: number;
    mapBrowsers: number;
    mapViews: number;
    markerClicks: number;
    markerClickBrowsers: number;
    cardClicks: number;
    cardViewBrowsers: number;
    detailViews: number;
    detailViewBrowsers: number;
    directionsClicks: number;
    directionsClickBrowsers: number;
    paymentButtonClicks: number;
    paymentButtonClickBrowsers: number;
    partnerDetailViews: number;
    partnerDetailViewBrowsers: number;
    cardToDirectionsExposedBrowsers: number;
    cardToDirectionsConvertedBrowsers: number;
    cardToDirectionsRatePercent: number | null;
    partnerDetailExposedBrowsers: number;
    partnerDetailToPaymentBrowsers: number;
    partnerDetailToPaymentRatePercent: number | null;
    approvedPayments: number;
    testModePayments: number;
    issuedTickets: number;
    submittedReceipts: number;
    approvedReceipts: number;
    refundsSucceeded: number;
  };
  byRestroomType: {
    public: ServiceRestroomTypeStats;
    partner: ServiceRestroomTypeStats;
  };
  restroomInterestRanking: RestroomInterestRow[];
  directionsRanking: RestroomInterestRow[];
  dailyTrend: ServiceDailyTrendRow[];
  analyticsConfig: {
    nextPublicAnalyticsEnabledEnv: string;
    actuallyGatedByEnv: boolean;
    trackedClientEvents: string[];
    trackedServerEvents: string[];
    untrackedEvents: string[];
  };
}

export interface BasicUsageSummary {
  mapOpened: number;
  searchExecuted: number;
  markerClicks: number;
  detailOpened: number;
  directionsClicks: number;
  paymentButtonClicks: number;
}

export interface BasicUsageDailyRow extends BasicUsageSummary {
  date: string; // YYYY-MM-DD (KST)
}

export interface BasicUsageMetrics {
  dateRange: {
    startsAt: string;
    endsAt: string;
  };
  includeTest: boolean;
  totals: BasicUsageSummary;
  dailyTrend: BasicUsageDailyRow[];
}

export interface AccountExclusionsSummary {
  activeExcludedAccountsCount: number;
  excludedEventCount: number;
  excludedSessionCount: number;
  excludedOrderCount: number;
  excludedTicketCount: number;
  excludedReceiptCount: number;
  excludedRefundCount: number;
  basicUsageRetroactiveNote: string;
  guestActivityNote: string;
}

export interface PmfReportData {
  experiment: ExperimentMetadata;
  observationWindow: {
    startsAt: string;
    endsAt: string;
    isOngoing: boolean;
  };
  summary: {
    totalEvents: number;
    distinctBrowsers: number;
    distinctSessions: number;
    excludedTestEvents: number;
    excludedTestSessions: number;
  };
  hypotheses: {
    h1: MetricHypothesisH1;
    h2: MetricHypothesisH2;
    h5: MetricHypothesisH5;
  };
  eventBreakdown: EventBreakdownItem[];
  basicUsageMetrics?: BasicUsageMetrics;
  serviceMetrics?: ServiceUsageMetrics;
  accountExclusions?: AccountExclusionsSummary;
  generatedAt: string;
}

