/**
 * @vitest-environment jsdom
 */

import React, { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

const mockCreateServerClientInstance = vi.fn();
const mockCreateAdminClient = vi.fn();
const mockIsServiceRoleConfigured = vi.fn();
const mockGetPmfReport = vi.fn();

vi.mock("@/lib/supabase/server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/supabase/server")>(
    "@/lib/supabase/server"
  );
  return {
    ...actual,
    createServerClientInstance: () => mockCreateServerClientInstance(),
    createAdminClient: () => mockCreateAdminClient(),
    isServiceRoleConfigured: () => mockIsServiceRoleConfigured(),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/map",
}));

import { GET as pmfGet } from "@/app/api/v1/admin/analytics/pmf/route";
import { POST as usageCountsPost } from "@/app/api/v1/usage-counts/route";
import {
  BASIC_USAGE_FEATURES,
  recordDailyUsageCount,
  recordUsageCountSchema,
} from "@/lib/usage-counts";
import { computeBasicUsageMetrics } from "@/lib/analytics";
import * as analyticsModule from "@/lib/analytics";
import {
  getExistingBrowserId,
  resetRateLimits,
  setConsentState,
} from "@/lib/events";
import MapDiscoveryClient from "@/components/map/MapDiscoveryClient";
import RestroomDetailClient from "@/app/(public)/restrooms/[id]/RestroomDetailClient";
import AnalyticsConsentModalHost from "@/components/privacy/AnalyticsConsentModalHost";
import PmfDashboardClient from "@/app/admin/analytics/pmf/PmfDashboardClient";
import type { MapProvider, MarkerOptions } from "@/lib/maps/types";
import type { PublicRestroomDetail, PublicRestroomSummary } from "@/lib/restrooms/types";

function makeSupabaseAuthMock(userId: string | null, roles: string[] = []) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue(
        userId
          ? { data: { user: { id: userId, user_metadata: {} } }, error: null }
          : { data: { user: null }, error: { message: "Auth session missing" } }
      ),
    },
    from: vi.fn((table: string) => {
      if (table === "user_roles") {
        return {
          select: () => ({
            eq: async () => ({
              data: roles.map((role) => ({ role })),
              error: null,
            }),
          }),
        };
      }
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: userId
                  ? { display_name: "관리자", account_status: "active" }
                  : null,
                error: null,
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
          data: [],
        }),
      };
    }),
  };
}

describe("STEP 1~5 Verification: Admin Auth Fix, Non-identifying Daily Counts, Non-blocking Consent & Dashboard", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
    window.localStorage.clear();
    window.sessionStorage.clear();
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_key",
      SUPABASE_SECRET_KEY: "sb_secret_test_key",
      NEXT_PUBLIC_ANALYTICS_ENABLED: "true",
    };
    delete process.env.ALLOW_E2E_MOCK;
    mockIsServiceRoleConfigured.mockReturnValue(true);
    mockCreateAdminClient.mockReturnValue(makeSupabaseAuthMock(null, []));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe("1. STEP 1 — 실제 관리자 로그인 서버 인증 수정 (createAdminClient 오용 방지)", () => {
    it("SERVICE_ROLE_KEY가 설정된 운영 환경에서도 쿠키 기반 관리자 세션으로 /api/v1/admin/analytics/pmf가 200을 반환한다", async () => {
      // Cookie-bound server client has verified admin session; admin client has no user session
      mockCreateServerClientInstance.mockResolvedValue(
        makeSupabaseAuthMock("admin-uuid-1", ["customer", "admin"])
      );
      mockCreateAdminClient.mockReturnValue(makeSupabaseAuthMock(null, []));
      vi.spyOn(analyticsModule, "getPmfReport").mockResolvedValueOnce({
        experiment: {
          experimentKey: "pmf_r1",
          name: "pmf",
          rulesVersion: "v1",
          startsAt: "2026-11-01T00:00:00Z",
          endsAt: "2026-11-30T00:00:00Z",
          status: "running",
          rulesComplete: false,
          provisionalNotice: "notice",
        },
        observationWindow: {
          startsAt: "2026-11-01T00:00:00Z",
          endsAt: "2026-11-30T00:00:00Z",
          isOngoing: true,
        },
        summary: {
          totalEvents: 0,
          distinctBrowsers: 0,
          distinctSessions: 0,
          excludedTestEvents: 0,
          excludedTestSessions: 0,
        },
        hypotheses: { h1: {} as any, h2: {} as any, h5: {} as any },
        eventBreakdown: [],
        basicUsageMetrics: {
          dateRange: { startsAt: "2026-11-01T00:00:00Z", endsAt: "2026-11-30T00:00:00Z" },
          includeTest: false,
          totals: {
            mapOpened: 5,
            searchExecuted: 3,
            markerClicks: 4,
            detailOpened: 2,
            directionsClicks: 1,
            paymentButtonClicks: 1,
          },
          dailyTrend: [],
        },
        generatedAt: new Date().toISOString(),
      });

      const res = await pmfGet(
        new Request("https://hujimap-staging.run.app/api/v1/admin/analytics/pmf")
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.basicUsageMetrics.totals.mapOpened).toBe(5);
    });

    it("비로그인 요청은 401 UNAUTHORIZED, 일반 회원 요청은 403 FORBIDDEN을 정확히 구분 반환한다", async () => {
      mockCreateServerClientInstance.mockResolvedValueOnce(
        makeSupabaseAuthMock(null, [])
      );
      const unauthRes = await pmfGet(
        new Request("https://hujimap-staging.run.app/api/v1/admin/analytics/pmf")
      );
      expect(unauthRes.status).toBe(401);
      expect((await unauthRes.json()).error.code).toBe("UNAUTHORIZED");

      mockCreateServerClientInstance.mockResolvedValueOnce(
        makeSupabaseAuthMock("customer-uuid-1", ["customer"])
      );
      const forbiddenRes = await pmfGet(
        new Request("https://hujimap-staging.run.app/api/v1/admin/analytics/pmf")
      );
      expect(forbiddenRes.status).toBe(403);
      expect((await forbiddenRes.json()).error.code).toBe("FORBIDDEN");
    });
  });

  describe("2. STEP 2 — 비식별 기본 이용 통계 API 및 개인정보 차단", () => {
    it("허용된 6개 기능만 통과시키고 식별자·검색어·좌표·화장실 ID 등 추가 필드는 모두 400으로 거부한다", async () => {
      expect(BASIC_USAGE_FEATURES).toEqual([
        "map_opened",
        "restroom_marker_clicked",
        "restroom_detail_opened",
        "search_executed",
        "directions_clicked",
        "payment_button_clicked",
      ]);

      const rpcMock = vi.fn().mockResolvedValue({
        data: { stat_date: "2026-11-25", feature_key: "search_executed", total_count: 1 },
        error: null,
      });
      mockCreateAdminClient.mockReturnValue({ rpc: rpcMock });

      for (const feature of BASIC_USAGE_FEATURES) {
        const res = await usageCountsPost(
          new Request("http://localhost:3000/api/v1/usage-counts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ feature }),
          })
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("set-cookie")).toBeNull();
      }
      expect(rpcMock).toHaveBeenCalledTimes(6);

      // Reject PII / extra fields strictly
      const forbiddenPayloads = [
        { feature: "search_executed", query: "수원역" },
        { feature: "search_executed", keyword: "장안문" },
        { feature: "map_opened", browserId: "11111111-1111-4111-8111-111111111111" },
        { feature: "map_opened", userId: "u-1" },
        { feature: "map_opened", lat: 37.26, lng: 127.02 },
        { feature: "restroom_detail_opened", restroomId: "rr-1" },
        { feature: "map_opened", occurredAt: "2026-11-25T10:00:00Z" },
        { feature: "unknown_event" },
      ];

      for (const payload of forbiddenPayloads) {
        expect(recordUsageCountSchema.safeParse(payload).success).toBe(false);
        const res = await usageCountsPost(
          new Request("http://localhost:3000/api/v1/usage-counts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        );
        expect(res.status).toBe(400);
      }
      expect(rpcMock).toHaveBeenCalledTimes(6);
    });

    it("서버 설정(SUPABASE_SECRET_KEY)이 없으면 성공으로 위장하지 않고 503을 반환한다", async () => {
      mockIsServiceRoleConfigured.mockReturnValue(false);
      const res = await usageCountsPost(
        new Request("http://localhost:3000/api/v1/usage-counts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ feature: "map_opened" }),
        })
      );
      expect(res.status).toBe(503);
      expect((await res.json()).error.code).toBe("CONFIG_REQUIRED");
    });

    it("운영 환경에서는 클라이언트가 isTest=true를 보내도 서버가 is_test=false로 강제한다", async () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      delete process.env.NEXT_PUBLIC_APP_ENV;
      const rpcMock = vi.fn().mockResolvedValue({
        data: { stat_date: "2026-11-25", feature_key: "map_opened", total_count: 1 },
        error: null,
      });

      await recordDailyUsageCount({ rpc: rpcMock } as any, {
        feature: "map_opened",
        isTest: true,
      });

      expect(rpcMock).toHaveBeenCalledWith("increment_daily_usage_count", {
        p_feature_key: "map_opened",
        p_is_test: false,
      });
    });
  });

  describe("3. STEP 2 & 3 — 비동의 방문 기본 집계 + 개별 행동 미기록 + 비차단 동의 UI", () => {
    it("비동의 상태에서도 지도·검색·핀·길찾기·상세·결제버튼 횟수가 전송되되, 검색어/식별자/개별이벤트(/api/v1/events)는 전혀 생성되지 않는다", async () => {
      // Consent undecided (default)
      expect(getExistingBrowserId()).toBeNull();

      const usageCalls: Array<{ feature: string; keys: string[] }> = [];
      const detailedEventCalls: string[] = [];
      const sessionCalls: string[] = [];

      const partnerItem: PublicRestroomSummary = {
        id: "88888888-8888-4888-8888-888888888888",
        type: "partner",
        name: "행궁 제휴 화장실",
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

      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const u = String(url);
        if (u.includes("/api/v1/usage-counts")) {
          const body = JSON.parse(String(init?.body ?? "{}"));
          usageCalls.push({ feature: body.feature, keys: Object.keys(body) });
          return {
            ok: false, // Simulate API error to also verify non-blocking resilience!
            status: 500,
            json: async () => ({ ok: false }),
          } as Response;
        }
        if (u.includes("/api/v1/events")) {
          detailedEventCalls.push(u);
        }
        if (u.includes("/api/v1/sessions")) {
          sessionCalls.push(u);
        }
        if (u.includes("/api/v1/restrooms")) {
          return {
            ok: true,
            json: async () => ({ ok: true, data: { items: [partnerItem], total: 1 } }),
          } as Response;
        }
        return {
          ok: true,
          json: async () => ({ authenticated: false, user: null }),
        } as Response;
      });

      const placeSearchMock = vi.fn().mockResolvedValue([]);
      const restroomSearchMock = vi.fn().mockResolvedValue([partnerItem]);

      render(
        <MapDiscoveryClient
          providerFactory={mockProvider}
          placeSearchFn={placeSearchMock}
          restroomSearchFn={restroomSearchMock}
        />
      );

      // 1) map_opened
      await waitFor(() => {
        expect(usageCalls.map((c) => c.feature)).toContain("map_opened");
      });

      // 2) search_executed (on submit) without sending search keyword!
      const searchInput = screen.getByTestId("map-search-input");
      fireEvent.change(searchInput, { target: { value: "수원역비밀검색어" } });
      fireEvent.keyDown(searchInput, { key: "Enter" });

      await waitFor(() => {
        expect(usageCalls.map((c) => c.feature)).toContain("search_executed");
      });

      // 3) marker click -> directions click
      const marker = markers.find((m) => m.id === partnerItem.id);
      expect(marker).toBeDefined();
      await act(async () => {
        marker!.onClick?.(partnerItem.id);
      });

      await waitFor(() => {
        expect(usageCalls.map((c) => c.feature)).toContain("restroom_marker_clicked");
      });

      fireEvent.click(screen.getByTestId(`directions-btn-${partnerItem.id}`));
      fireEvent.click(screen.getByTestId("directions-kakao-link"));
      // Rapid double-click within 500ms should be deduplicated
      fireEvent.click(screen.getByTestId("directions-kakao-link"));

      await waitFor(() => {
        expect(
          usageCalls.filter((c) => c.feature === "directions_clicked")
        ).toHaveLength(1);
      });

      // 4) Restroom detail + payment button (StrictMode double-mount deduplication)
      const detailFixture: PublicRestroomDetail = {
        ...partnerItem,
        floor: "1층",
        description: null,
        entrance_instructions: null,
        hours: [],
        hour_exceptions: [],
        photos: [],
        active_policy: {
          id: "pol-1",
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
          name: "행궁카페",
          category: "카페",
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
          <RestroomDetailClient restroom={detailFixture} />
        </StrictMode>
      );

      await waitFor(() => {
        expect(
          usageCalls.filter((c) => c.feature === "restroom_detail_opened")
        ).toHaveLength(1);
      });

      fireEvent.click(screen.getByTestId("detail-partner-payment-btn"));
      await waitFor(() => {
        expect(usageCalls.map((c) => c.feature)).toContain("payment_button_clicked");
      });

      // Verify ZERO detailed behavioral events, ZERO sessions, ZERO browserId, and ONLY `feature` key sent
      expect(detailedEventCalls).toHaveLength(0);
      expect(sessionCalls).toHaveLength(0);
      expect(getExistingBrowserId()).toBeNull();
      expect(window.localStorage.getItem("hm_browser_id")).toBeNull();
      expect(window.sessionStorage.getItem("hm_session_id")).toBeNull();
      for (const call of usageCalls) {
        expect(call.keys).toEqual(["feature"]);
      }
    });

    it("첫 방문 동의 UI는 비차단 하단 시트로 표시되며 X 버튼으로 동의 결정 없이 닫을 수 있다", async () => {
      render(<AnalyticsConsentModalHost isAuthenticated={false} />);
      const banner = await screen.findByTestId("first-visit-consent-modal");
      expect(banner.getAttribute("aria-modal")).toBe("false");
      expect(banner.className).toContain("pointer-events-none");

      fireEvent.click(screen.getByTestId("consent-dismiss-btn"));
      await waitFor(() => {
        expect(screen.queryByTestId("first-visit-consent-modal")).toBeNull();
      });
    });

    it("동의 후에는 기본 집계와 기존 6종 상세 분석 이벤트가 모두 정상 작동한다", async () => {
      setConsentState({ analytics: true });
      window.sessionStorage.setItem(
        "hm_session_id",
        "11111111-1111-4111-8111-111111111111"
      );

      const usageFeatures: string[] = [];
      const detailedEvents: string[] = [];

      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const u = String(url);
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (u.includes("/api/v1/usage-counts")) {
          usageFeatures.push(body.feature);
        } else if (u.includes("/api/v1/events")) {
          detailedEvents.push(body.eventName);
        } else if (u.includes("/api/v1/restrooms")) {
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
              clientEventId: body.clientEventId ?? "id-1",
              receivedAt: new Date().toISOString(),
              deduplicated: false,
            },
          }),
        } as Response;
      });

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

      render(<MapDiscoveryClient providerFactory={mockProvider} />);

      await waitFor(() => {
        expect(usageFeatures).toContain("map_opened");
        expect(detailedEvents).toContain("map_loaded");
      });
    });
  });

  describe("4. STEP 4 — 관리자 이용 통계 화면 A(전체 이용량)/B(동의 상세 분석) 분리", () => {
    it("computeBasicUsageMetrics가 날짜별·기능별 총횟수만 집계하고 테스트 데이터를 기본 제외한다", () => {
      const result = computeBasicUsageMetrics(
        [
          { stat_date: "2026-11-24", feature_key: "map_opened", is_test: false, total_count: 10 },
          { stat_date: "2026-11-24", feature_key: "search_executed", is_test: false, total_count: 4 },
          { stat_date: "2026-11-24", feature_key: "map_opened", is_test: true, total_count: 99 },
          { stat_date: "2026-11-25", feature_key: "directions_clicked", is_test: false, total_count: 3 },
        ],
        {
          startsAt: "2026-11-24T00:00:00+09:00",
          endsAt: "2026-11-25T23:59:59+09:00",
        },
        false
      );

      expect(result.totals.mapOpened).toBe(10);
      expect(result.totals.searchExecuted).toBe(4);
      expect(result.totals.directionsClicks).toBe(3);
      expect(result.dailyTrend).toHaveLength(2);
      expect(result.dailyTrend[0].date).toBe("2026-11-25");
    });

    it("PmfDashboardClient가 A(전체 이용량)와 B(동의 상세 분석) 영역을 명확히 구분해 표시한다", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        const u = String(url);
        if (u.includes("/api/v1/admin/analytics/excluded-accounts")) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              data: { activeCount: 0, excludedAccounts: [], candidates: [] },
            }),
          } as Response;
        }
        return {
          ok: true,
          json: async () => ({
            ok: true,
            data: {
            experiment: {
              experimentKey: "pmf_r1",
              name: "test",
              rulesVersion: "v1",
              startsAt: "2026-11-10T00:00:00Z",
              endsAt: "2026-11-25T00:00:00Z",
              status: "running",
              rulesComplete: false,
              provisionalNotice: "notice",
            },
            observationWindow: {
              startsAt: "2026-11-10T00:00:00Z",
              endsAt: "2026-11-25T00:00:00Z",
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
            basicUsageMetrics: {
              dateRange: { startsAt: "2026-11-10T00:00:00Z", endsAt: "2026-11-25T00:00:00Z" },
              includeTest: false,
              totals: {
                mapOpened: 12,
                searchExecuted: 7,
                markerClicks: 9,
                detailOpened: 5,
                directionsClicks: 4,
                paymentButtonClicks: 2,
              },
              dailyTrend: [
                {
                  date: "2026-11-25",
                  mapOpened: 12,
                  searchExecuted: 7,
                  markerClicks: 9,
                  detailOpened: 5,
                  directionsClicks: 4,
                  paymentButtonClicks: 2,
                },
              ],
            },
            serviceMetrics: {
              dateRange: { startsAt: "2026-11-10T00:00:00Z", endsAt: "2026-11-25T00:00:00Z" },
              overview: {
                visitingBrowsers: 2,
                mapBrowsers: 2,
                mapViews: 3,
                markerClicks: 2,
                markerClickBrowsers: 2,
                cardClicks: 2,
                cardViewBrowsers: 2,
                detailViews: 1,
                detailViewBrowsers: 1,
                directionsClicks: 1,
                directionsClickBrowsers: 1,
                paymentButtonClicks: 1,
                paymentButtonClickBrowsers: 1,
                partnerDetailViews: 1,
                partnerDetailViewBrowsers: 1,
                cardToDirectionsExposedBrowsers: 2,
                cardToDirectionsConvertedBrowsers: 1,
                cardToDirectionsRatePercent: 50.0,
                partnerDetailExposedBrowsers: 1,
                partnerDetailToPaymentBrowsers: 1,
                partnerDetailToPaymentRatePercent: 100.0,
                approvedPayments: 0,
                testModePayments: 1,
                issuedTickets: 1,
                submittedReceipts: 0,
                approvedReceipts: 0,
                refundsSucceeded: 0,
              },
              byRestroomType: {
                public: { markerClicks: 1, cardClicks: 1, detailViews: 0, directionsClicks: 0, paymentButtonClicks: 0, cardToDirectionsRatePercent: null },
                partner: { markerClicks: 1, cardClicks: 1, detailViews: 1, directionsClicks: 1, paymentButtonClicks: 1, cardToDirectionsRatePercent: 100.0 },
              },
              restroomInterestRanking: [],
              directionsRanking: [],
              dailyTrend: [],
              analyticsConfig: {
                nextPublicAnalyticsEnabledEnv: "true",
                actuallyGatedByEnv: true,
                trackedClientEvents: [],
                trackedServerEvents: [],
                untrackedEvents: [],
              },
            },
            generatedAt: new Date().toISOString(),
          },
        }),
      } as Response;
      });

      render(<PmfDashboardClient />);

      const overallSection = await screen.findByTestId("section-overall-usage");
      const consentedSection = await screen.findByTestId("section-consented-analytics");

      expect(overallSection.textContent).toContain("A. 전체 이용량");
      expect(overallSection.textContent).toContain("고유 이용자 수(방문자 수)가 아닙니다");
      expect(screen.getByTestId("basic-metric-map-opened").textContent).toBe("12회");
      expect(screen.getByTestId("basic-metric-search-executed").textContent).toBe("7회");
      expect(screen.getByTestId("basic-metric-marker-clicks").textContent).toBe("9회");
      expect(screen.getByTestId("basic-metric-detail-opened").textContent).toBe("5회");
      expect(screen.getByTestId("basic-metric-directions-clicks").textContent).toBe("4회");
      expect(screen.getByTestId("basic-metric-payment-button-clicks").textContent).toBe("2회");

      expect(consentedSection.textContent).toContain("B. 동의한 이용자의 상세 분석");
      expect(screen.getByTestId("metric-visiting-browsers").textContent).toBe("2");
    });
  });
});
