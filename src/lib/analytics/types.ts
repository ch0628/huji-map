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

export interface PmfAnalyticsFilter {
  experimentKey?: string;
  startsAt?: string;
  endsAt?: string;
  includeTest?: boolean;
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
  generatedAt: string;
}

