/**
 * @vitest-environment jsdom
 */

import React, { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import {
  OPTIONAL_BEHAVIORAL_EVENTS,
  PRIVACY_POLICY_VERSION,
  CONSENT_PREF_COOKIE_NAME,
  parseConsentPrefCookie,
  getConsentState,
  getAnalyticsConsentStatus,
  setConsentState,
  isAnalyticsEnvEnabled,
  isAnalyticsAllowed,
  getExistingBrowserId,
  ensureVisitorSession,
  trackEvent,
  updateAnalyticsConsent,
  syncAnalyticsAuthBoundary,
  openAnalyticsSettingsModal,
  createVisitorSession,
  ingestClientEvent,
  resetRateLimits,
} from "@/lib/events";
import {
  computeH5Metrics,
  computeServiceUsageMetrics,
  computeEventBreakdown,
} from "@/lib/analytics";
import { POST as eventsPost } from "@/app/api/v1/events/route";
import { POST as sessionsPost } from "@/app/api/v1/sessions/route";
import { POST as privacyConsentPost } from "@/app/api/v1/privacy/consent/route";
import PrivacySettingsClient from "@/components/privacy/PrivacySettingsClient";
import AnalyticsConsentModalHost from "@/components/privacy/AnalyticsConsentModalHost";
import PrivacyRedirectPage from "@/app/privacy/page";
import PrivacySettingsRedirectPage from "@/app/settings/privacy/page";
import MapDiscoveryClient from "@/components/map/MapDiscoveryClient";
import RestroomDetailClient from "@/app/(public)/restrooms/[id]/RestroomDetailClient";
import DepositPaymentButton from "@/components/payment/DepositPaymentButton";
import PmfDashboardClient from "@/app/admin/analytics/pmf/PmfDashboardClient";
import type { MapProvider, MarkerOptions } from "@/lib/maps/types";
import type { PublicRestroomDetail, PublicRestroomSummary } from "@/lib/restrooms/types";

const mockRedirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

vi.mock("next/navigation", () => ({
  redirect: (url: string) => mockRedirect(url),
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/map",
}));

describe("HUJIMAP Complete Behavioral Analytics, Privacy & Dashboard Verification", () => {
  const originalAnalyticsEnv = process.env.NEXT_PUBLIC_ANALYTICS_ENABLED;

  beforeEach(() => {
    resetRateLimits();
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalAnalyticsEnv === undefined) {
      delete process.env.NEXT_PUBLIC_ANALYTICS_ENABLED;
    } else {
      process.env.NEXT_PUBLIC_ANALYTICS_ENABLED = originalAnalyticsEnv;
    }
    vi.unstubAllGlobals();
  });

  describe("1. TASK-07-3 필수 시나리오: 환경변수 및 동의/철회 통제", () => {
    it("시나리오 1: 환경변수 OFF이면 동의가 있어도 선택적 이벤트·세션 전송 및 browser_id 생성 없음", async () => {
      process.env.NEXT_PUBLIC_ANALYTICS_ENABLED = "false";
      setConsentState({ analytics: true });
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      expect(isAnalyticsEnvEnabled()).toBe(false);
      expect(isAnalyticsAllowed()).toBe(false);
      expect(await ensureVisitorSession()).toBeNull();

      await trackEvent({
        eventName: "map_loaded",
        properties: { zoom: 4, restroom_count: 10, filter: "all" },
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(getExistingBrowserId()).toBeNull();
    });

    it("시나리오 2: 환경변수 ON이어도 기본 상태(동의 전/OFF)에서는 이벤트 전송 및 hm_browser_id 영구 저장 없음", async () => {
      process.env.NEXT_PUBLIC_ANALYTICS_ENABLED = "true";
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      // 기본값 확인: OFF
      expect(getConsentState().analytics).toBe(false);
      expect(isAnalyticsAllowed()).toBe(false);
      expect(await ensureVisitorSession()).toBeNull();

      await trackEvent({
        eventName: "map_loaded",
        properties: { zoom: 4, restroom_count: 5, filter: "all" },
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(window.localStorage.getItem("hm_browser_id")).toBeNull();
      expect(window.sessionStorage.getItem("hm_session_id")).toBeNull();
    });

    it("시나리오 3: 환경변수 ON + 분석 동의 ON일 때 확정된 6개 대상 이벤트가 정상 전송된다", async () => {
      process.env.NEXT_PUBLIC_ANALYTICS_ENABLED = "true";
      expect(OPTIONAL_BEHAVIORAL_EVENTS).toEqual([
        "map_loaded",
        "restroom_marker_clicked",
        "restroom_card_viewed",
        "restroom_detail_opened",
        "directions_clicked",
        "payment_button_clicked",
      ]);

      setConsentState({ analytics: true });
      window.sessionStorage.setItem(
        "hm_session_id",
        "11111111-1111-4111-8111-111111111111"
      );

      const sentEvents: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        sentEvents.push(body.eventName);
        return {
          ok: true,
          json: async () => ({
            ok: true,
            data: {
              clientEventId: body.clientEventId,
              receivedAt: new Date().toISOString(),
              deduplicated: false,
            },
          }),
        } as Response;
      });

      const rid = "22222222-2222-4222-8222-222222222222";
      await trackEvent({ eventName: "map_loaded", properties: { zoom: 4, restroom_count: 3, filter: "all" } });
      await trackEvent({ eventName: "restroom_marker_clicked", context: { restroomId: rid }, properties: { restroom_id: rid, type: "public", marker_index: 0, access_method: "open" } });
      await trackEvent({ eventName: "restroom_card_viewed", context: { restroomId: rid }, properties: { card_type: "public", visibility_rule_version: "v1_bottom_sheet", restroom_id: rid, source: "marker_selection" } });
      await trackEvent({ eventName: "restroom_detail_opened", context: { restroomId: rid }, properties: { restroom_id: rid, type: "public", source_component: "direct_url" } });
      await trackEvent({ eventName: "directions_clicked", context: { restroomId: rid }, properties: { service: "kakao", restroom_id: rid, type: "public", has_origin: false } });
      await trackEvent({ eventName: "payment_button_clicked", context: { restroomId: rid }, properties: { restroom_id: rid, policy_id: null, deposit_amount_krw: 1000 } });

      expect(sentEvents).toEqual([...OPTIONAL_BEHAVIORAL_EVENTS]);
      expect(getExistingBrowserId()).not.toBeNull();
    });

    it("시나리오 4: 분석 동의 철회 즉시 hm_browser_id·세션이 삭제되고 추가 전송이 차단된다", async () => {
      process.env.NEXT_PUBLIC_ANALYTICS_ENABLED = "true";
      setConsentState({ analytics: true });
      window.sessionStorage.setItem(
        "hm_session_id",
        "11111111-1111-4111-8111-111111111111"
      );

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            clientEventId: "33333333-3333-4333-8333-333333333333",
            receivedAt: new Date().toISOString(),
            deduplicated: false,
            analytics: false,
            recordedOnServer: false,
          },
        }),
      } as Response);

      await trackEvent({
        eventName: "map_loaded",
        properties: { zoom: 4, restroom_count: 1, filter: "all" },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(window.localStorage.getItem("hm_browser_id")).not.toBeNull();

      fetchSpy.mockClear();

      // 동의 철회
      await updateAnalyticsConsent(false);
      // 철회 API 호출 1회만 허용되고, browser_id / session_id 즉시 삭제됨
      expect(window.localStorage.getItem("hm_browser_id")).toBeNull();
      expect(window.sessionStorage.getItem("hm_session_id")).toBeNull();
      expect(window.sessionStorage.getItem("hm_session_token")).toBeNull();
      expect(isAnalyticsAllowed()).toBe(false);

      fetchSpy.mockClear();

      // 철회 이후 세션 및 이벤트 재전송 완전 차단
      expect(await ensureVisitorSession()).toBeNull();
      await trackEvent({
        eventName: "directions_clicked",
        properties: { service: "kakao", restroom_id: "22222222-2222-4222-8222-222222222222", type: "public", has_origin: false },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("2. TASK-07-3 필수 시나리오: 집계 정합성, 순서, 테스트 제외, 서버 거래 분리, 0건 처리", () => {
    const WINDOW = {
      startsAt: "2026-11-10T00:00:00.000Z",
      endsAt: "2026-11-23T14:59:59.999Z",
    };

    const RESTROOMS = [
      { id: "partner-A", name: "진미 통닭", type: "partner" as const },
      { id: "partner-B", name: "행궁 카페", type: "partner" as const },
      { id: "public-C", name: "화홍문 공중화장실", type: "public" as const },
    ];

    it("시나리오 5~8: 반복 클릭 횟수 vs 고유 브라우저 구분, A 노출 후 B 길찾기 분리, 테스트 방문자 기본 제외, 서버 결제·이용권 분리", () => {
      const events = [
        // Browser 1: map_loaded 2회, partner-A 카드 노출 후 partner-A 길찾기 (정순서 전환!) + 상세 후 결제버튼 클릭
        { browser_id: "b-1", restroom_id: null, event_name: "map_loaded", occurred_at: "2026-11-20T01:00:00Z", is_test: false },
        { browser_id: "b-1", restroom_id: null, event_name: "map_loaded", occurred_at: "2026-11-20T02:00:00Z", is_test: false },
        { browser_id: "b-1", restroom_id: "partner-A", event_name: "restroom_card_viewed", properties: { card_type: "partner" }, occurred_at: "2026-11-20T01:01:00Z", is_test: false },
        { browser_id: "b-1", restroom_id: "partner-A", event_name: "directions_clicked", properties: { type: "partner" }, occurred_at: "2026-11-20T01:02:00Z", is_test: false },
        { browser_id: "b-1", restroom_id: "partner-A", event_name: "directions_clicked", properties: { type: "partner" }, occurred_at: "2026-11-20T01:03:00Z", is_test: false },
        { browser_id: "b-1", restroom_id: "partner-A", event_name: "restroom_detail_opened", properties: { type: "partner" }, occurred_at: "2026-11-20T01:04:00Z", is_test: false },
        { browser_id: "b-1", restroom_id: "partner-A", event_name: "payment_button_clicked", occurred_at: "2026-11-20T01:05:00Z", is_test: false },

        // Browser 2: partner-A 카드 노출 후 partner-B 길찾기 (잘못된 연결 차단!)
        { browser_id: "b-2", restroom_id: "partner-A", event_name: "restroom_card_viewed", properties: { card_type: "partner" }, occurred_at: "2026-11-20T03:00:00Z", is_test: false },
        { browser_id: "b-2", restroom_id: "partner-B", event_name: "directions_clicked", properties: { type: "partner" }, occurred_at: "2026-11-20T03:05:00Z", is_test: false },

        // Browser 3: 역순서 (길찾기 먼저 -> 카드 노출 나중) -> 노출 대비 전환으로 계산 금지!
        { browser_id: "b-3", restroom_id: "public-C", event_name: "directions_clicked", properties: { type: "public" }, occurred_at: "2026-11-20T04:00:00Z", is_test: false },
        { browser_id: "b-3", restroom_id: "public-C", event_name: "restroom_card_viewed", properties: { card_type: "public" }, occurred_at: "2026-11-20T04:05:00Z", is_test: false },

        // Test QA Browser (기본 제외)
        { browser_id: "b-qa", restroom_id: "partner-A", event_name: "directions_clicked", properties: { type: "partner" }, occurred_at: "2026-11-20T05:00:00Z", is_test: true },
      ];

      // H5 순서 검증 (b-1만 전환, b-2는 미스매치)
      const h5 = computeH5Metrics(events, RESTROOMS, WINDOW, false);
      expect(h5.denominatorCount).toBe(2); // b-1, b-2
      expect(h5.numeratorCount).toBe(1); // b-1 only

      // 일반 서비스 이용 집계
      const metrics = computeServiceUsageMetrics({
        sessions: [
          { id: "s1", browser_id: "b-1", started_at: "2026-11-20T01:00:00Z", is_test: false },
          { id: "s-qa", browser_id: "b-qa", started_at: "2026-11-20T05:00:00Z", is_test: true },
        ],
        events,
        restrooms: RESTROOMS,
        orders: [
          { id: "ord-1", status: "approved", payment_mode: "test", approved_at: "2026-11-20T01:06:00Z", created_at: "2026-11-20T01:05:30Z" },
        ],
        accessSessions: [
          { id: "acc-1", status: "code_revealed", authorized_at: "2026-11-20T01:06:00Z", created_at: "2026-11-20T01:05:30Z" },
        ],
        receipts: [],
        refunds: [],
        window: WINDOW,
        includeTest: false,
      });

      // 이벤트 횟수 vs 고유 브라우저 구분
      expect(metrics.overview.mapViews).toBe(2);
      expect(metrics.overview.mapBrowsers).toBe(1);
      expect(metrics.overview.visitingBrowsers).toBe(3); // b-1, b-2, b-3 (b-qa 제외)

      // 길찾기 클릭: b-1(2회) + b-2(1회) + b-3(1회) = 4회 (b-qa 1회 제외!)
      expect(metrics.overview.directionsClicks).toBe(4);
      expect(metrics.overview.directionsClickBrowsers).toBe(3);

      // 카드 노출 -> 동일 화장실 길찾기 전환 (순서 포함): 노출 브라우저 b-1, b-2, b-3 = 3개 중 정순서 동일 화장실 전환 b-1 = 1개 (33.3%)
      expect(metrics.overview.cardToDirectionsExposedBrowsers).toBe(3);
      expect(metrics.overview.cardToDirectionsConvertedBrowsers).toBe(1);
      expect(metrics.overview.cardToDirectionsRatePercent).toBe(33.3);

      // 제휴 상세 -> 결제버튼 클릭 비율: b-1 (1/1 = 100.0%)
      expect(metrics.overview.partnerDetailExposedBrowsers).toBe(1);
      expect(metrics.overview.partnerDetailToPaymentBrowsers).toBe(1);
      expect(metrics.overview.partnerDetailToPaymentRatePercent).toBe(100.0);

      // 테스트 결제 승인 건수 및 이용권 발급 건수는 기존 서버 DB 기준으로 정확히 표시 (실제 결제는 0)
      expect(metrics.overview.testModePayments).toBe(1);
      expect(metrics.overview.approvedPayments).toBe(0);
      expect(metrics.overview.issuedTickets).toBe(1);

      // 화장실별 길찾기 순위
      expect(metrics.directionsRanking[0].restroomId).toBe("partner-A");
      expect(metrics.directionsRanking[0].directionsClicks).toBe(2);

      // KST 일별 추이 (2026-11-20T01:00Z = 2026-11-20 10:00 KST)
      expect(metrics.dailyTrend[0].date).toBe("2026-11-20");
      expect(metrics.dailyTrend[0].mapBrowsers).toBe(1);
    });

    it("시나리오 9: 데이터 0건일 때 오류 없이 null 비율(데이터 부족)과 0건 통계를 반환한다", () => {
      const metrics = computeServiceUsageMetrics({
        sessions: [],
        events: [],
        restrooms: [],
        orders: [],
        accessSessions: [],
        receipts: [],
        refunds: [],
        window: WINDOW,
        includeTest: false,
      });

      expect(metrics.overview.visitingBrowsers).toBe(0);
      expect(metrics.overview.cardToDirectionsRatePercent).toBeNull();
      expect(metrics.overview.partnerDetailToPaymentRatePercent).toBeNull();
      expect(metrics.restroomInterestRanking).toHaveLength(0);
      expect(metrics.directionsRanking).toHaveLength(0);
      expect(metrics.dailyTrend).toHaveLength(0);
    });
  });

  describe("3. UI 컴포넌트: StrictMode 중복 방지, A19 미복원, 6개 이벤트 정확 연결", () => {
    it("RestroomDetailClient: StrictMode 이중 마운트에도 restroom_detail_opened는 1회만 전송된다", async () => {
      process.env.NEXT_PUBLIC_ANALYTICS_ENABLED = "true";
      setConsentState({ analytics: true });
      window.sessionStorage.setItem(
        "hm_session_id",
        "11111111-1111-4111-8111-111111111111"
      );

      const sentEvents: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        if (String(url).includes("/api/v1/events")) {
          const body = JSON.parse(String(init?.body ?? "{}"));
          sentEvents.push(body.eventName);
        }
        return {
          ok: true,
          json: async () => ({
            ok: true,
            data: {
              authenticated: false,
              clientEventId: "44444444-4444-4444-8444-444444444444",
              receivedAt: new Date().toISOString(),
              deduplicated: false,
            },
          }),
        } as Response;
      });

      const mockDetail: PublicRestroomDetail = {
        id: "55555555-5555-4555-8555-555555555555",
        type: "partner",
        name: "진미 통닭",
        road_address: "수원시 팔달구",
        address_detail: null,
        floor: "1층",
        latitude: 37.279,
        longitude: 127.018,
        access_method: "pin",
        gender_type: "separate",
        wheelchair_accessible: false,
        baby_changing_available: false,
        sanitary_products_available: false,
        last_verified_at: null,
        business_id: "66666666-6666-4666-8666-666666666666",
        description: null,
        entrance_instructions: null,
        hours: [],
        hour_exceptions: [],
        photos: [],
        active_policy: {
          id: "77777777-7777-4777-8777-777777777777",
          version: 1,
          access_mode: "test_deposit",
          deposit_amount_krw: 1000,
          refund_eligible: true,
          receipt_window_hours: 24,
          min_purchase_krw: 0,
          effective_from: "2026-11-20T00:00:00Z",
        },
        business: {
          id: "66666666-6666-4666-8666-666666666666",
          name: "진미통닭",
          category: "음식점",
          description: null,
          road_address: "수원시 팔달구",
          jibun_address: null,
          address_detail: null,
          latitude: 37.279,
          longitude: 127.018,
          phone: null,
          website_url: null,
        },
        created_at: "2026-11-20T00:00:00Z",
        updated_at: "2026-11-20T00:00:00Z",
      };

      render(
        <StrictMode>
          <RestroomDetailClient restroom={mockDetail} />
        </StrictMode>
      );

      await waitFor(() => {
        expect(sentEvents.filter((e) => e === "restroom_detail_opened")).toHaveLength(1);
      });

      // 결제 버튼 직접 클릭 시에만 payment_button_clicked 1회 발생
      const payBtn = screen.getByTestId("detail-partner-payment-btn");
      fireEvent.click(payBtn);

      await waitFor(() => {
        expect(sentEvents.filter((e) => e === "payment_button_clicked")).toHaveLength(1);
      });

      // checkout_opened나 payment_unavailable_shown은 발생하지 않음
      expect(sentEvents).not.toContain("checkout_opened");
      expect(sentEvents).not.toContain("payment_unavailable_shown");
    });

    it("MapDiscoveryClient: landing_view나 TravelSurveyBanner(A19)를 발생/노출하지 않고 카드 링크 클릭으로 payment_button_clicked를 중복 발행하지 않는다", async () => {
      process.env.NEXT_PUBLIC_ANALYTICS_ENABLED = "true";
      setConsentState({ analytics: true });
      window.sessionStorage.setItem(
        "hm_session_id",
        "11111111-1111-4111-8111-111111111111"
      );

      let markers: readonly MarkerOptions[] = [];
      const mockProvider = (): MapProvider => ({
        name: "mock",
        init: vi.fn().mockResolvedValue(undefined),
        destroy: vi.fn(),
        getCenter: vi.fn().mockReturnValue({ lat: 37.279, lng: 127.018 }),
        setCenter: vi.fn(),
        getZoomLevel: vi.fn().mockReturnValue(4),
        setZoomLevel: vi.fn(),
        getBounds: vi.fn().mockReturnValue({ south: 37.2, west: 127.0, north: 37.3, east: 127.1 }),
        fitBounds: vi.fn(),
        setMarkers: vi.fn((m) => {
          markers = m;
        }),
        addMarker: vi.fn(),
        removeMarker: vi.fn(),
        clearMarkers: vi.fn(),
        relayout: vi.fn(),
      });

      const partnerItem: PublicRestroomSummary = {
        id: "88888888-8888-4888-8888-888888888888",
        type: "partner",
        name: "진미 통닭",
        road_address: "수원시 팔달구",
        address_detail: null,
        latitude: 37.279,
        longitude: 127.018,
        access_method: "pin",
        gender_type: "separate",
        wheelchair_accessible: false,
        baby_changing_available: false,
        sanitary_products_available: false,
        last_verified_at: null,
        business_id: "66666666-6666-4666-8666-666666666666",
        access_mode: "test_deposit",
        deposit_amount_krw: 1000,
      };

      const sentEvents: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        if (String(url).includes("/api/v1/restrooms")) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              data: { items: [partnerItem], total: 1 },
            }),
          } as Response;
        }
        if (String(url).includes("/api/v1/events")) {
          const body = JSON.parse(String(init?.body ?? "{}"));
          sentEvents.push(body.eventName);
        }
        return {
          ok: true,
          json: async () => ({
            ok: true,
            data: {
              clientEventId: "44444444-4444-4444-8444-444444444444",
              receivedAt: new Date().toISOString(),
              deduplicated: false,
            },
          }),
        } as Response;
      });

      render(<MapDiscoveryClient providerFactory={mockProvider} />);

      await waitFor(() => {
        expect(sentEvents).toContain("map_loaded");
      });

      // A19 여행 설문 및 landing_view는 존재하지 않아야 함
      expect(screen.queryByTestId("travel-survey-banner")).toBeNull();
      expect(sentEvents).not.toContain("landing_view");

      // 데이터 조회 직후에는 restroom_card_viewed가 발생하지 않음
      expect(sentEvents).not.toContain("restroom_card_viewed");

      const marker = markers.find((m) => m.id === partnerItem.id);
      expect(marker).toBeDefined();

      await act(async () => {
        marker!.onClick?.(partnerItem.id);
      });

      await waitFor(() => {
        expect(sentEvents).toContain("restroom_marker_clicked");
        expect(sentEvents).toContain("restroom_card_viewed");
      });

      // 카드의 상세 링크 클릭 시 payment_button_clicked나 restroom_detail_opened가 카드에서 중복 발생하지 않음
      const detailLink = screen.getByTestId(`detail-link-${partnerItem.id}`);
      fireEvent.click(detailLink);

      expect(sentEvents).not.toContain("payment_button_clicked");
      expect(sentEvents).not.toContain("restroom_detail_opened");
    });

    it("PrivacySettingsClient: 기본 미결정/OFF 상태, 동의 ON 및 철회 동작이 정확히 표시된다", async () => {
      process.env.NEXT_PUBLIC_ANALYTICS_ENABLED = "true";
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        return {
          ok: true,
          json: async () => ({
            ok: true,
            data: {
              analytics: Boolean(body.analytics),
              analyticsStatus: body.analytics ? "accepted" : "declined",
              recordedOnServer: true,
            },
          }),
        } as Response;
      });

      render(<PrivacySettingsClient />);

      const toggle = await screen.findByTestId("analytics-consent-toggle");
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      expect(screen.getByTestId("analytics-consent-status-box").textContent).toContain("미결정");

      await act(async () => {
        fireEvent.click(toggle);
      });

      await waitFor(() => {
        expect(toggle.getAttribute("aria-checked")).toBe("true");
        expect(screen.getByTestId("analytics-consent-feedback").textContent).toContain("동의");
      });

      await act(async () => {
        fireEvent.click(toggle);
      });

      await waitFor(() => {
        expect(toggle.getAttribute("aria-checked")).toBe("false");
        expect(screen.getByTestId("analytics-consent-feedback").textContent).toContain("철회");
      });
    });

    it("AnalyticsConsentModalHost: 첫 방문 전체화면형 동의 UI('휴지맵 시작하기'), 접이식 4항목(기술명칭 미노출), 거부 유지, /privacy·/settings/privacy 리다이렉트, 정책 버전 변경 재확인", async () => {
      process.env.NEXT_PUBLIC_ANALYTICS_ENABLED = "true";
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        if (String(url).includes("/api/v1/privacy/consent")) {
          const body = JSON.parse(String(init?.body ?? "{}"));
          return {
            ok: true,
            json: async () => ({
              ok: true,
              data: {
                analytics: Boolean(body.analytics),
                analyticsStatus: body.analytics ? "accepted" : "declined",
                recordedOnServer: true,
              },
            }),
          } as Response;
        }
        if (String(url).includes("/api/v1/restrooms")) {
          return {
            ok: true,
            json: async () => ({ ok: true, data: { items: [], total: 0 } }),
          } as Response;
        }
        return {
          ok: true,
          json: async () => ({
            ok: true,
            data: {
              sessionId: "11111111-1111-4111-8111-111111111111",
              clientEventId: "22222222-2222-4222-8222-222222222222",
              receivedAt: new Date().toISOString(),
              deduplicated: false,
            },
          }),
        } as Response;
      });

      // 0) 별도 /privacy, /settings/privacy 페이지는 독립 화면 없이 /map 내부 핸들링으로 리다이렉트
      mockRedirect.mockClear();
      expect(() => PrivacyRedirectPage()).toThrow("NEXT_REDIRECT:/map?analyticsDetails=1");
      expect(() => PrivacySettingsRedirectPage()).toThrow(
        "NEXT_REDIRECT:/map?analyticsSettings=1"
      );

      // 1) 초기 undecided -> 첫 방문 전체화면형 동의 UI 노출 (접이식 4항목 기본 접힘)
      expect(getAnalyticsConsentStatus()).toBe("undecided");
      const { unmount } = render(<AnalyticsConsentModalHost isAuthenticated={false} />);

      const modal = await screen.findByTestId("first-visit-consent-modal");
      expect(modal.textContent).toContain("휴지맵 시작하기");
      expect(modal.textContent).toContain(
        "더 편리한 화장실 지도를 만들 수 있도록 서비스 이용 통계 수집에 참여해 주세요."
      );
      expect(modal.textContent).toContain("어떤 정보를 수집하나요?");
      expect(modal.textContent).toContain("어디에 활용하나요?");
      expect(modal.textContent).toContain("동의하지 않아도 이용할 수 있나요?");
      expect(modal.textContent).toContain("개인정보 처리 안내");
      expect(modal.textContent).toContain("동의하고 시작하기");
      expect(modal.textContent).toContain("동의 없이 시작하기");
      expect(screen.queryByTestId("consent-privacy-link")).toBeNull();
      expect(screen.queryByTestId("consent-accordion-collected-content")).toBeNull();
      expect(screen.queryByTestId("consent-accordion-purpose-content")).toBeNull();
      expect(screen.queryByTestId("consent-accordion-optional-content")).toBeNull();
      expect(screen.queryByTestId("consent-accordion-privacy-content")).toBeNull();

      // 접이식 항목 4개 펼침 및 내부 기술 명칭 미노출 확인
      const forbiddenTechTerms = [
        "map_loaded",
        "restroom_marker_clicked",
        "hm_browser_id",
        "hm_session_id",
        "is_authenticated",
        "visitor_sessions",
        "event_logs",
        "consent_records",
      ];

      fireEvent.click(screen.getByTestId("consent-accordion-collected"));
      const collectedText = screen.getByTestId("consent-accordion-collected-content").textContent ?? "";
      expect(collectedText).toContain(
        "지도 방문, 화장실 조회, 길찾기, 결제 버튼 클릭 등의 이용 기록을 수집합니다."
      );
      for (const term of forbiddenTechTerms) {
        expect(collectedText).not.toContain(term);
      }

      fireEvent.click(screen.getByTestId("consent-accordion-purpose"));
      expect(screen.getByTestId("consent-accordion-purpose-content").textContent).toContain(
        "어떤 화장실에 관심이 많은지, 길찾기를 얼마나 이용하는지 확인해 화장실 정보와 지도 서비스를 개선합니다."
      );
      expect(screen.queryByTestId("consent-accordion-collected-content")).toBeNull();

      fireEvent.click(screen.getByTestId("consent-accordion-optional"));
      expect(screen.getByTestId("consent-accordion-optional-content").textContent).toContain(
        "네. 동의하지 않아도 지도와 길찾기 등 모든 기능을 이용할 수 있습니다."
      );

      fireEvent.click(screen.getByTestId("consent-accordion-privacy"));
      expect(screen.getByTestId("consent-accordion-privacy-content")).toBeDefined();
      fireEvent.click(screen.getByTestId("consent-privacy-details-toggle"));
      const fullDetailsText = screen.getByTestId("consent-privacy-details-panel").textContent ?? "";
      expect(fullDetailsText).toContain("처리 목적 및 수집 항목");
      expect(fullDetailsText).toContain("보유 및 파기 기준");
      expect(fullDetailsText).toContain("외부 처리업체");
      expect(fullDetailsText).toContain("이용자 권리 및 문의 방법");
      for (const term of forbiddenTechTerms) {
        expect(fullDetailsText).not.toContain(term);
      }

      // 2) ESC 닫기는 동의로 처리하지 않고 undecided 유지 및 hm_browser_id 미생성
      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => {
        expect(screen.queryByTestId("first-visit-consent-modal")).toBeNull();
      });
      expect(getAnalyticsConsentStatus()).toBe("undecided");
      expect(getExistingBrowserId()).toBeNull();
      unmount();

      // 3) 재마운트 후 거부 클릭 -> declined 저장, hm_browser_id 미생성, 재방문 시 반복 노출 안 함
      const render2 = render(<AnalyticsConsentModalHost isAuthenticated={false} />);
      await screen.findByTestId("first-visit-consent-modal");
      await act(async () => {
        fireEvent.click(screen.getByTestId("consent-decline-btn"));
      });
      await waitFor(() => {
        expect(screen.queryByTestId("first-visit-consent-modal")).toBeNull();
      });
      expect(getAnalyticsConsentStatus()).toBe("declined");
      expect(getExistingBrowserId()).toBeNull();
      expect(document.cookie).toContain(`${CONSENT_PREF_COOKIE_NAME}=`);
      expect(parseConsentPrefCookie(`${PRIVACY_POLICY_VERSION}:declined`)).toBe("declined");
      render2.unmount();

      const render3 = render(<AnalyticsConsentModalHost isAuthenticated={false} />);
      expect(screen.queryByTestId("first-visit-consent-modal")).toBeNull();

      // 4) 메뉴에서 이용 통계 설정 모달 열기 테스트 (별도 /privacy 링크 없이 모달 내부 토글/아코디언 제공)
      act(() => {
        openAnalyticsSettingsModal();
      });
      await screen.findByTestId("analytics-settings-modal");
      expect(screen.getByTestId("analytics-consent-status-box").textContent).toContain("비동의");
      expect(screen.queryByTestId("privacy-policy-link")).toBeNull();
      render3.unmount();

      // 5) 정책 버전이 변경되면 이전 동의를 무조건 재사용하지 않고 undecided로 전환
      window.localStorage.setItem(
        "hm_consent_state",
        JSON.stringify({
          analytics: true,
          analyticsStatus: "accepted",
          policyVersion: "2026-01-01-old",
        })
      );
      expect(getAnalyticsConsentStatus()).toBe("undecided");
      expect(parseConsentPrefCookie("2026-01-01-old:accepted")).toBe("undecided");
      expect(isAnalyticsAllowed()).toBe(false);

      // 6) ?analyticsDetails=1 진입 시 첫 방문 화면에서 개인정보 처리 안내 및 상세 내용이 바로 펼쳐진다
      window.history.replaceState(null, "", "/map?analyticsDetails=1");
      const render4 = render(<AnalyticsConsentModalHost isAuthenticated={false} />);
      await screen.findByTestId("first-visit-consent-modal");
      expect(screen.getByTestId("consent-privacy-details-panel").textContent).toContain(
        "처리 목적 및 수집 항목"
      );
      render4.unmount();

      // 7) NEXT_PUBLIC_ANALYTICS_ENABLED=false 환경에서도 undecided 첫 방문 동의 화면은 노출되나 식별자/이벤트는 생성되지 않는다
      process.env.NEXT_PUBLIC_ANALYTICS_ENABLED = "false";
      window.localStorage.clear();
      const render5 = render(<AnalyticsConsentModalHost isAuthenticated={false} />);
      await screen.findByTestId("first-visit-consent-modal");
      await act(async () => {
        fireEvent.click(screen.getByTestId("consent-accept-btn"));
      });
      await waitFor(() => {
        expect(screen.queryByTestId("first-visit-consent-modal")).toBeNull();
      });
      expect(getAnalyticsConsentStatus()).toBe("accepted");
      expect(getExistingBrowserId()).toBeNull();
      expect(isAnalyticsAllowed()).toBe(false);
      render5.unmount();
    });

    it("MapDiscoveryClient: 미결정 상태로 열린 지도에서 뒤늦게 동의하면 map_loaded가 누락 없이 1회 전송된다", async () => {
      process.env.NEXT_PUBLIC_ANALYTICS_ENABLED = "true";
      const sentEvents: string[] = [];

      const mockProvider = (): MapProvider => ({
        name: "mock",
        init: vi.fn().mockResolvedValue(undefined),
        destroy: vi.fn(),
        getCenter: vi.fn().mockReturnValue({ lat: 37.279, lng: 127.018 }),
        setCenter: vi.fn(),
        getZoomLevel: vi.fn().mockReturnValue(4),
        setZoomLevel: vi.fn(),
        getBounds: vi.fn().mockReturnValue({ south: 37.2, west: 127.0, north: 37.3, east: 127.1 }),
        fitBounds: vi.fn(),
        setMarkers: vi.fn(),
        addMarker: vi.fn(),
        removeMarker: vi.fn(),
        clearMarkers: vi.fn(),
        relayout: vi.fn(),
      });

      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        if (String(url).includes("/api/v1/restrooms")) {
          return {
            ok: true,
            json: async () => ({ ok: true, data: { items: [], total: 0 } }),
          } as Response;
        }
        if (String(url).includes("/api/v1/sessions")) {
          return {
            ok: true,
            status: 201,
            json: async () => ({
              ok: true,
              data: {
                sessionId: "11111111-1111-4111-8111-111111111111",
                browserId: "22222222-2222-4222-8222-222222222222",
                startedAt: new Date().toISOString(),
                isTest: false,
              },
            }),
          } as Response;
        }
        if (String(url).includes("/api/v1/events")) {
          const body = JSON.parse(String(init?.body ?? "{}"));
          sentEvents.push(body.eventName);
        }
        return {
          ok: true,
          json: async () => ({
            ok: true,
            data: {
              analytics: true,
              analyticsStatus: "accepted",
              clientEventId: "33333333-3333-4333-8333-333333333333",
              receivedAt: new Date().toISOString(),
              deduplicated: false,
            },
          }),
        } as Response;
      });

      render(
        <>
          <AnalyticsConsentModalHost isAuthenticated={false} />
          <MapDiscoveryClient providerFactory={mockProvider} />
        </>
      );

      // 동의 전에는 map_loaded 미전송
      await screen.findByTestId("first-visit-consent-modal");
      expect(sentEvents).toHaveLength(0);
      expect(getExistingBrowserId()).toBeNull();

      // 동의 클릭 -> 팝업 닫히고 이미 열린 지도에서 map_loaded 즉시 전송
      await act(async () => {
        fireEvent.click(screen.getByTestId("consent-accept-btn"));
      });

      await waitFor(() => {
        expect(sentEvents.filter((e) => e === "map_loaded")).toHaveLength(1);
      });
    });

    it("PmfDashboardClient: 0건일 때 데이터 부족 안내를 렌더링한다", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            experiment: {
              experimentKey: "pmf_r1",
              name: "test",
              rulesVersion: "v1",
              startsAt: "2026-11-10T00:00:00Z",
              endsAt: "2026-11-22T00:00:00Z",
              status: "running",
              rulesComplete: false,
              provisionalNotice: "notice",
            },
            observationWindow: {
              startsAt: "2026-11-10T00:00:00Z",
              endsAt: "2026-11-22T00:00:00Z",
              isOngoing: true,
            },
            summary: {
              totalEvents: 0,
              distinctBrowsers: 0,
              distinctSessions: 0,
              excludedTestEvents: 0,
              excludedTestSessions: 0,
            },
            hypotheses: { h1: {}, h2: {}, h5: {} },
            eventBreakdown: [],
            serviceMetrics: {
              dateRange: { startsAt: "2026-11-10T00:00:00Z", endsAt: "2026-11-22T00:00:00Z" },
              overview: {
                visitingBrowsers: 0,
                mapBrowsers: 0,
                mapViews: 0,
                markerClicks: 0,
                markerClickBrowsers: 0,
                cardClicks: 0,
                cardViewBrowsers: 0,
                detailViews: 0,
                detailViewBrowsers: 0,
                directionsClicks: 0,
                directionsClickBrowsers: 0,
                paymentButtonClicks: 0,
                paymentButtonClickBrowsers: 0,
                partnerDetailViews: 0,
                partnerDetailViewBrowsers: 0,
                cardToDirectionsExposedBrowsers: 0,
                cardToDirectionsConvertedBrowsers: 0,
                cardToDirectionsRatePercent: null,
                partnerDetailExposedBrowsers: 0,
                partnerDetailToPaymentBrowsers: 0,
                partnerDetailToPaymentRatePercent: null,
                approvedPayments: 0,
                testModePayments: 0,
                issuedTickets: 0,
                submittedReceipts: 0,
                approvedReceipts: 0,
                refundsSucceeded: 0,
              },
              byRestroomType: {
                public: { markerClicks: 0, cardClicks: 0, detailViews: 0, directionsClicks: 0, paymentButtonClicks: 0, cardToDirectionsRatePercent: null },
                partner: { markerClicks: 0, cardClicks: 0, detailViews: 0, directionsClicks: 0, paymentButtonClicks: 0, cardToDirectionsRatePercent: null },
              },
              restroomInterestRanking: [],
              directionsRanking: [],
              dailyTrend: [],
              analyticsConfig: {
                nextPublicAnalyticsEnabledEnv: "false",
                actuallyGatedByEnv: true,
                trackedClientEvents: [...OPTIONAL_BEHAVIORAL_EVENTS],
                trackedServerEvents: [],
                untrackedEvents: [],
              },
            },
            generatedAt: new Date().toISOString(),
          },
        }),
      } as Response);

      render(<PmfDashboardClient />);

      await waitFor(() => {
        expect(screen.getByTestId("metric-card-to-directions-rate").textContent).toContain("데이터 부족");
        expect(screen.getByTestId("metric-partner-detail-to-payment-rate").textContent).toContain("데이터 부족");
        expect(screen.getByTestId("daily-trend-empty").textContent).toContain("데이터 부족");
      });
    });
  });

  describe("4. 서버 API 우회 차단 검증 (/api/v1/events, /api/v1/sessions, /api/v1/privacy/consent)", () => {
    it("NEXT_PUBLIC_ANALYTICS_ENABLED !== 'true'이면 POST /api/v1/events 와 POST /api/v1/sessions가 403 ANALYTICS_DISABLED로 차단한다", async () => {
      process.env.NEXT_PUBLIC_ANALYTICS_ENABLED = "false";

      const evRes = await eventsPost(
        new Request("http://localhost:3000/api/v1/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientEventId: "11111111-1111-4111-8111-111111111111",
            eventName: "map_loaded",
          }),
        })
      );
      expect(evRes.status).toBe(403);
      const evBody = await evRes.json();
      expect(evBody.error.code).toBe("ANALYTICS_DISABLED");

      const sessRes = await sessionsPost(
        new Request("http://localhost:3000/api/v1/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            browserId: "11111111-1111-4111-8111-111111111111",
            landingPath: "/map",
            consent: { analytics: true },
          }),
        })
      );
      expect(sessRes.status).toBe(403);
      const sessBody = await sessRes.json();
      expect(sessBody.error.code).toBe("ANALYTICS_DISABLED");
    });

    it("createVisitorSession은 consent.analytics !== true 이면 403 ANALYTICS_CONSENT_REQUIRED로 차단한다", async () => {
      const mockSupabase = {} as any;
      await expect(
        createVisitorSession(
          mockSupabase,
          {
            browserId: "11111111-1111-4111-8111-111111111111",
            landingPath: "/map",
            consent: { analytics: false },
          },
          null
        )
      ).rejects.toThrow("선택적 분석 동의");
    });

    it("ingestClientEvent는 서버 consent_records에 철회(accepted=false) 기록이 있으면 403으로 차단한다", async () => {
      const mockSupabase = {
        from: (table: string) => {
          if (table === "consent_records") {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    order: () => ({
                      limit: () => ({
                        maybeSingle: async () => ({
                          data: {
                            accepted: false,
                            withdrawn_at: "2026-11-22T01:00:00Z",
                          },
                          error: null,
                        }),
                      }),
                    }),
                  }),
                }),
              }),
            };
          }
          return {};
        },
      } as any;

      await expect(
        ingestClientEvent(
          mockSupabase,
          {
            clientEventId: "11111111-1111-4111-8111-111111111111",
            eventName: "map_loaded",
            browserId: "22222222-2222-4222-8222-222222222222",
            properties: { zoom: 4, restroom_count: 1, filter: "all" },
          },
          null
        )
      ).rejects.toThrow("분석 동의가 철회되어");
    });

    it("POST /api/v1/privacy/consent는 동의 철회 시 hm_session_token 쿠키를 만료 삭제한다", async () => {
      const res = await privacyConsentPost(
        new Request("http://localhost:3000/api/v1/privacy/consent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            analytics: false,
            browserId: "11111111-1111-4111-8111-111111111111",
          }),
        })
      );
      expect(res.status).toBe(200);
      const setCookie = res.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("hm_session_token=");
      expect(setCookie).toContain("Max-Age=0");
    });

    it("로그인 전/후 세션 경계: syncAnalyticsAuthBoundary는 동의 상태를 유지한 채 세션만 회전하고, 서버는 비로그인 세션에 로그인 이벤트 혼합을 403 차단한다", async () => {
      process.env.NEXT_PUBLIC_ANALYTICS_ENABLED = "true";
      setConsentState({ analytics: true, policyVersion: PRIVACY_POLICY_VERSION });
      window.sessionStorage.setItem("hm_session_id", "anon-sess-1");
      window.sessionStorage.setItem("hm_session_auth_state", "guest");

      const rotated = syncAnalyticsAuthBoundary(true);
      expect(rotated).toBe(true);
      expect(window.sessionStorage.getItem("hm_session_id")).toBeNull();
      expect(window.sessionStorage.getItem("hm_session_auth_state")).toBe("auth");
      expect(getAnalyticsConsentStatus()).toBe("accepted");

      const mockSupabase = {
        from: (table: string) => {
          if (table === "visitor_sessions") {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: "11111111-1111-4111-8111-111111111111",
                      browser_id: "22222222-2222-4222-8222-222222222222",
                      user_id: null,
                      is_test: false,
                    },
                    error: null,
                  }),
                }),
              }),
            };
          }
          return {};
        },
      } as any;

      await expect(
        ingestClientEvent(
          mockSupabase,
          {
            clientEventId: "33333333-3333-4333-8333-333333333333",
            eventName: "map_loaded",
            browserId: "22222222-2222-4222-8222-222222222222",
            sessionId: "11111111-1111-4111-8111-111111111111",
            properties: { zoom: 4, restroom_count: 1, filter: "all" },
          },
          "auth-user-uuid-1"
        )
      ).rejects.toThrow("비로그인 방문 세션에는 로그인 사용자 이벤트를 기록할 수 없습니다.");
    });

    it("비로그인/로그인 대시보드 필터: 전체·비로그인·로그인 분리가 정확히 적용되고 D 서버 기록은 독립 유지된다", async () => {
      const WINDOW = {
        startsAt: "2026-11-10T00:00:00.000Z",
        endsAt: "2026-11-23T14:59:59.999Z",
      };
      const events = [
        // 같은 브라우저이지만 로그인 전(user_id=null) 1건 + 로그인 후(user_id="u1") 1건 -> 절대 자동 결합 금지
        { browser_id: "b-1", user_id: null, restroom_id: "r1", event_name: "map_loaded", occurred_at: "2026-11-20T01:00:00Z", is_test: false },
        { browser_id: "b-1", user_id: "u1", restroom_id: "r1", event_name: "directions_clicked", properties: { type: "partner" }, occurred_at: "2026-11-20T02:00:00Z", is_test: false },
      ];
      const sessions = [
        { id: "s1", browser_id: "b-1", user_id: null, started_at: "2026-11-20T01:00:00Z", is_test: false },
        { id: "s2", browser_id: "b-1", user_id: "u1", started_at: "2026-11-20T02:00:00Z", is_test: false },
      ];
      const orders = [
        { id: "ord-1", status: "approved", payment_mode: "test", approved_at: "2026-11-20T02:05:00Z", created_at: "2026-11-20T02:04:00Z" },
      ];

      const guestOnly = computeServiceUsageMetrics({
        sessions,
        events,
        restrooms: [{ id: "r1", name: "진미", type: "partner" }],
        orders,
        accessSessions: [],
        receipts: [],
        refunds: [],
        window: WINDOW,
        includeTest: false,
        authFilter: "guest",
      });
      expect(guestOnly.overview.mapViews).toBe(1);
      expect(guestOnly.overview.directionsClicks).toBe(0);
      expect(guestOnly.overview.testModePayments).toBe(1); // D 서버 기록은 독립 유지

      const authedOnly = computeServiceUsageMetrics({
        sessions,
        events,
        restrooms: [{ id: "r1", name: "진미", type: "partner" }],
        orders,
        accessSessions: [],
        receipts: [],
        refunds: [],
        window: WINDOW,
        includeTest: false,
        authFilter: "authenticated",
      });
      expect(authedOnly.overview.mapViews).toBe(0);
      expect(authedOnly.overview.directionsClicks).toBe(1);
      expect(authedOnly.overview.testModePayments).toBe(1); // D 서버 기록은 독립 유지

      expect(computeEventBreakdown(events, WINDOW, false, "guest").find((x) => x.eventName === "directions_clicked")?.rawEventCount).toBe(0);
      expect(computeEventBreakdown(events, WINDOW, false, "authenticated").find((x) => x.eventName === "directions_clicked")?.rawEventCount).toBe(1);
    });

    it("POST /api/v1/privacy/consent는 타인 브라우저 철회 쿠키 불일치 시 403으로 차단한다", async () => {
      const res = await privacyConsentPost(
        new Request("http://localhost:3000/api/v1/privacy/consent", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            cookie: "hm_consent_bid=11111111-1111-4111-8111-111111111111",
          },
          body: JSON.stringify({
            analytics: false,
            browserId: "22222222-2222-4222-8222-222222222222",
          }),
        })
      );
      expect(res.status).toBe(403);
    });
  });
});
