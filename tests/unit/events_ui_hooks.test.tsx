/**
 * @vitest-environment jsdom
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import {
  getOrCreateBrowserId,
  getActiveSessionId,
  setActiveSessionId,
  getActiveSessionToken,
  setActiveSessionToken,
  createClientEventId,
  ensureVisitorSession,
  trackEvent,
  trackEventSafe,
  retryTrackEvent,
  submitTravelAnswer,
  getConsentState,
  setConsentState,
  isAnalyticsAllowed,
  getDeviceType,
  useEventTracker,
} from "@/lib/events";
import TravelSurveyBanner from "@/components/map/TravelSurveyBanner";
import MapDirectionsModal from "@/components/map/MapDirectionsModal";
import PublicRestroomCard from "@/components/restroom/PublicRestroomCard";
import MapDiscoveryClient from "@/components/map/MapDiscoveryClient";
import type { MapProvider, MarkerOptions } from "@/lib/maps/types";
import type { PublicRestroomSummary } from "@/lib/restrooms/types";

describe("TASK 18: Events UI Hooks & User Tracking Telemetry", () => {
  const UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    setActiveSessionId("00000000-0000-4000-8000-000000000001");
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("1. 방문자 식별 및 세션 초기화", () => {
    it("최초 방문 시 브라우저 ID를 생성하고 localStorage에 영속화한다", () => {
      const browserId = getOrCreateBrowserId();
      expect(browserId).toMatch(UUID_REGEX);
      expect(window.localStorage.getItem("hm_browser_id")).toBe(browserId);

      // 재호출 시 기존 생성된 ID를 그대로 반환
      const secondCall = getOrCreateBrowserId();
      expect(secondCall).toBe(browserId);
    });

    it("활성 세션이 이미 존재하면 네트워크 요청 없이 기존 세션 ID를 재사용한다", async () => {
      const mockSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      setActiveSessionId(mockSessionId);

      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const resolved = await ensureVisitorSession();
      expect(resolved).toBe(mockSessionId);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("세션이 없을 때 POST /api/v1/sessions를 호출하여 세션을 생성하고 토큰을 저장한다", async () => {
      window.sessionStorage.clear();
      const mockSessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const mockToken = "mock_session_secret_token";

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          ok: true,
          data: {
            sessionId: mockSessionId,
            browserId: getOrCreateBrowserId(),
            sessionToken: mockToken,
            startedAt: new Date().toISOString(),
            isTest: false,
          },
        }),
      } as Response);

      const resolved = await ensureVisitorSession();
      expect(resolved).toBe(mockSessionId);
      expect(getActiveSessionId()).toBe(mockSessionId);
      expect(getActiveSessionToken()).toBe(mockToken);
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/v1/sessions",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        })
      );
    });

    it("동시에 여러 ensureVisitorSession이 호출되어도 단 1번의 세션 생성 요청만 전송한다", async () => {
      window.sessionStorage.clear();
      const mockSessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

      let callCount = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 20));
        return {
          ok: true,
          status: 201,
          json: async () => ({
            ok: true,
            data: {
              sessionId: mockSessionId,
              browserId: getOrCreateBrowserId(),
              startedAt: new Date().toISOString(),
              isTest: false,
            },
          }),
        } as Response;
      });

      const [res1, res2, res3] = await Promise.all([
        ensureVisitorSession(),
        ensureVisitorSession(),
        ensureVisitorSession(),
      ]);

      expect(callCount).toBe(1);
      expect(res1).toBe(mockSessionId);
      expect(res2).toBe(mockSessionId);
      expect(res3).toBe(mockSessionId);
    });

    it("세션 생성 API 실패 시 예외를 던지지 않고 안전하게 null을 반환하여 UI를 보호한다", async () => {
      window.sessionStorage.clear();
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({
          ok: false,
          error: { message: "DB 연결 실패" },
        }),
      } as Response);

      const resolved = await ensureVisitorSession();
      expect(resolved).toBeNull();
      expect(getActiveSessionId()).toBeNull();
    });
  });

  describe("2. 사용자 행동 추적 이벤트 전송 규약", () => {
    it("landing_view: 허용된 properties(UTM/기기타입/랜딩경로)와 context를 전송한다", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            clientEventId: createClientEventId(),
            receivedAt: new Date().toISOString(),
            deduplicated: false,
          },
        }),
      } as Response);

      const res = await trackEvent({
        eventName: "landing_view",
        context: {
          pagePath: "/map",
          componentId: "landing_shell",
        },
        properties: {
          landing_path: "/map",
          device_type: "mobile",
          utm_source: "google_ad",
          utm_campaign: "suwon_tour",
        },
      });

      expect(res.deduplicated).toBe(false);
      expect(fetchSpy).toHaveBeenCalledWith("/api/v1/events", expect.anything());

      const sentBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(sentBody.eventName).toBe("landing_view");
      expect(sentBody.properties.utm_source).toBe("google_ad");
      expect(sentBody.properties.utm_campaign).toBe("suwon_tour");
      expect(sentBody.properties.device_type).toBe("mobile");
      expect(sentBody.clientEventId).toMatch(UUID_REGEX);
    });

    it("map_loaded: zoom, restroom_count, filter, center_region을 올바르게 전송한다", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            clientEventId: createClientEventId(),
            receivedAt: new Date().toISOString(),
            deduplicated: false,
          },
        }),
      } as Response);

      await trackEvent({
        eventName: "map_loaded",
        properties: {
          zoom: 3,
          restroom_count: 15,
          filter: "all",
          center_region: "수원시",
        },
      });

      const sentBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(sentBody.eventName).toBe("map_loaded");
      expect(sentBody.properties.zoom).toBe(3);
      expect(sentBody.properties.restroom_count).toBe(15);
      expect(sentBody.properties.filter).toBe("all");
      expect(sentBody.properties.center_region).toBe("수원시");
    });

    it("restroom_marker_clicked: 마커 클릭 정보(restroom_id, type, marker_index, access_method)를 전송한다", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            clientEventId: createClientEventId(),
            receivedAt: new Date().toISOString(),
            deduplicated: false,
          },
        }),
      } as Response);

      const targetId = "11111111-1111-4111-8111-111111111111";
      await trackEvent({
        eventName: "restroom_marker_clicked",
        context: {
          restroomId: targetId,
          componentId: "map_marker",
        },
        properties: {
          restroom_id: targetId,
          type: "public",
          marker_index: 2,
          access_method: "open",
        },
      });

      const sentBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(sentBody.eventName).toBe("restroom_marker_clicked");
      expect(sentBody.properties.restroom_id).toBe(targetId);
      expect(sentBody.properties.type).toBe("public");
      expect(sentBody.properties.marker_index).toBe(2);
      expect(sentBody.properties.access_method).toBe("open");
    });

    it("restroom_card_viewed: 카드 노출 정보(card_type, visibility_rule_version, restroom_id, source)를 전송한다", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            clientEventId: createClientEventId(),
            receivedAt: new Date().toISOString(),
            deduplicated: false,
          },
        }),
      } as Response);

      const targetId = "22222222-2222-4222-8222-222222222222";
      await trackEvent({
        eventName: "restroom_card_viewed",
        context: {
          restroomId: targetId,
          componentId: "restroom_card",
        },
        properties: {
          card_type: "partner",
          visibility_rule_version: "v1_bottom_sheet",
          restroom_id: targetId,
          source: "marker_selection",
        },
      });

      const sentBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(sentBody.eventName).toBe("restroom_card_viewed");
      expect(sentBody.properties.card_type).toBe("partner");
      expect(sentBody.properties.visibility_rule_version).toBe("v1_bottom_sheet");
      expect(sentBody.properties.restroom_id).toBe(targetId);
      expect(sentBody.properties.source).toBe("marker_selection");
    });

    it("directions_clicked: 3사 길찾기 클릭(service, restroom_id, type, has_origin)을 전송한다", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            clientEventId: createClientEventId(),
            receivedAt: new Date().toISOString(),
            deduplicated: false,
          },
        }),
      } as Response);

      const targetId = "33333333-3333-4333-8333-333333333333";
      await trackEvent({
        eventName: "directions_clicked",
        context: {
          restroomId: targetId,
          componentId: "directions_modal",
        },
        properties: {
          service: "kakao",
          restroom_id: targetId,
          type: "public",
          has_origin: true,
        },
      });

      const sentBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(sentBody.eventName).toBe("directions_clicked");
      expect(sentBody.properties.service).toBe("kakao");
      expect(sentBody.properties.restroom_id).toBe(targetId);
      expect(sentBody.properties.type).toBe("public");
      expect(sentBody.properties.has_origin).toBe(true);
    });

    it("payment_button_clicked: 제휴 화장실 결제 버튼 클릭 정보를 전송한다", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            clientEventId: createClientEventId(),
            receivedAt: new Date().toISOString(),
            deduplicated: false,
          },
        }),
      } as Response);

      const targetId = "44444444-4444-4444-8444-444444444444";
      await trackEvent({
        eventName: "payment_button_clicked",
        properties: {
          restroom_id: targetId,
          policy_id: null,
          deposit_amount_krw: 1000,
        },
      });

      const sentBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(sentBody.eventName).toBe("payment_button_clicked");
      expect(sentBody.properties.restroom_id).toBe(targetId);
      expect(sentBody.properties.deposit_amount_krw).toBe(1000);
    });

    it("payment_unavailable_shown: 결제 준비 중 안내 노출 정보를 전송한다", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            clientEventId: createClientEventId(),
            receivedAt: new Date().toISOString(),
            deduplicated: false,
          },
        }),
      } as Response);

      const targetId = "55555555-5555-4555-8555-555555555555";
      await trackEvent({
        eventName: "payment_unavailable_shown",
        properties: {
          restroom_id: targetId,
          reason: "feature_in_preparation",
        },
      });

      const sentBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(sentBody.eventName).toBe("payment_unavailable_shown");
      expect(sentBody.properties.restroom_id).toBe(targetId);
      expect(sentBody.properties.reason).toBe("feature_in_preparation");
    });
  });

  describe("3. 중복 방지 및 멱등성 / 재시도 처리", () => {
    it("useEventTracker 훅: landing_view는 여러 번 호출되어도 최초 1회만 전송한다", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            clientEventId: createClientEventId(),
            receivedAt: new Date().toISOString(),
            deduplicated: false,
          },
        }),
      } as Response);

      function TestLandingComponent() {
        const { trackLandingView } = useEventTracker();
        React.useEffect(() => {
          trackLandingView();
          trackLandingView(); // StrictMode 이중 실행 시뮬레이션
        }, [trackLandingView]);
        return <div>Test Landing</div>;
      }

      render(<TestLandingComponent />);

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      });
    });

    it("useEventTracker 훅: 동일 화장실 카드의 card_viewed는 세션 내 1회만 전송한다", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            clientEventId: createClientEventId(),
            receivedAt: new Date().toISOString(),
            deduplicated: false,
          },
        }),
      } as Response);

      const mockRestroom: PublicRestroomSummary = {
        id: "66666666-6666-4666-8666-666666666666",
        type: "public",
        name: "화홍문 화장실",
        road_address: "수원시 팔달구",
        address_detail: null,
        latitude: 37.28,
        longitude: 127.01,
        access_method: "open",
        gender_type: "separate",
        wheelchair_accessible: true,
        baby_changing_available: false,
        sanitary_products_available: false,
        last_verified_at: null,
        business_id: null,
      };

      function TestCardComponent() {
        const { trackCardViewed } = useEventTracker();
        const [, setTick] = React.useState(0);

        React.useEffect(() => {
          trackCardViewed({ restroom: mockRestroom });
        }, [trackCardViewed]);

        return (
          <button type="button" onClick={() => setTick((t) => t + 1)}>
            Re-render
          </button>
        );
      }

      render(<TestCardComponent />);

      // 첫 렌더링 시 노출 이벤트 기록
      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      });

      // 부모 컴포넌트 재렌더링 트리거
      fireEvent.click(screen.getByText("Re-render"));

      // 동일 화장실 카드 노출 이벤트가 중복 발생하지 않음 확인
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("이벤트 전송 실패 후 재시도 시 동일한 clientEventId를 유지하여 멱등성을 보장한다", async () => {
      const initialClientEventId = "77777777-7777-4777-8777-777777777777";

      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(new Error("네트워크 일시 오류"))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            data: {
              clientEventId: initialClientEventId,
              receivedAt: new Date().toISOString(),
              deduplicated: true,
            },
          }),
        } as Response);

      // 첫 시도 실패
      await expect(
        trackEvent({
          clientEventId: initialClientEventId,
          eventName: "directions_clicked",
          properties: {
            service: "kakao",
            restroom_id: "11111111-1111-4111-8111-111111111111",
            type: "public",
            has_origin: true,
          },
        })
      ).rejects.toThrow("네트워크 일시 오류");

      // retryTrackEvent로 동일한 clientEventId 전달 재시도
      const retryResult = await retryTrackEvent(
        {
          eventName: "directions_clicked",
          properties: {
            service: "kakao",
            restroom_id: "11111111-1111-4111-8111-111111111111",
            type: "public",
            has_origin: true,
          },
        },
        initialClientEventId
      );

      expect(retryResult.clientEventId).toBe(initialClientEventId);
      expect(retryResult.deduplicated).toBe(true);

      const secondCallBody = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string);
      expect(secondCallBody.clientEventId).toBe(initialClientEventId);
    });
  });

  describe("4. H2 여행 여부 응답 및 서버 전용 이벤트 격리", () => {
    it("travel_answer_submitted를 클라이언트 trackEvent로 직접 전송하면 즉시 차단된다", async () => {
      await expect(
        trackEvent({
          eventName: "travel_answer_submitted" as any,
          properties: {},
        })
      ).rejects.toThrow(/서버 전용 이벤트/);
    });

    it("submitTravelAnswer: 활성 세션 토큰과 함께 PATCH /api/v1/sessions/:id/travel-answer를 호출한다", async () => {
      const mockSessionId = "88888888-8888-4888-8888-888888888888";
      const mockToken = "secret_tok_123";
      setActiveSessionId(mockSessionId);
      setActiveSessionToken(mockToken);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            sessionId: mockSessionId,
            browserId: getOrCreateBrowserId(),
            travelingNow: true,
            updatedAt: new Date().toISOString(),
          },
        }),
      } as Response);

      const result = await submitTravelAnswer(true);
      expect(result.travelingNow).toBe(true);
      expect(fetchSpy).toHaveBeenCalledWith(
        `/api/v1/sessions/${mockSessionId}/travel-answer`,
        expect.objectContaining({
          method: "PATCH",
          headers: expect.objectContaining({
            "x-session-token": mockToken,
          }),
        })
      );

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.travelingNow).toBe(true);
      expect(body.clientEventId).toMatch(UUID_REGEX);
    });
  });

  describe("5. 사용자 동의 및 개인정보 보호", () => {
    it("동의 정책상 analytics가 false이면 네트워크 전송을 건너뛰고 안전한 더미 결과를 반환한다", async () => {
      setConsentState({ analytics: false });
      expect(isAnalyticsAllowed()).toBe(false);

      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const res = await trackEvent({
        eventName: "landing_view",
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(res.clientEventId).toMatch(UUID_REGEX);
      expect(res.deduplicated).toBe(false);
    });

    it("동의를 다시 활성화하면 정상적으로 네트워크 이벤트 요청이 전송된다", async () => {
      setConsentState({ analytics: false });
      setConsentState({ analytics: true });
      expect(isAnalyticsAllowed()).toBe(true);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            clientEventId: createClientEventId(),
            receivedAt: new Date().toISOString(),
            deduplicated: false,
          },
        }),
      } as Response);

      await trackEvent({
        eventName: "landing_view",
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("이벤트 전송 실패(500, 네트워크 끊김 등) 시 trackEventSafe는 예외를 던지지 않고 null을 반환한다", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("서버 다운"));

      const res = await trackEventSafe({
        eventName: "directions_clicked",
        properties: {
          service: "kakao",
          restroom_id: "11111111-1111-4111-8111-111111111111",
          type: "public",
          has_origin: false,
        },
      });

      expect(res).toBeNull();
    });
  });

  describe("6. 컴포넌트 UI 연동 및 모바일 반응성", () => {
    it("TravelSurveyBanner: 설문 답변을 누르면 submitTravelAnswer가 호출되고 완료 메시지가 표시된다", async () => {
      setActiveSessionId("99999999-9999-4999-8999-999999999999");

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            sessionId: "99999999-9999-4999-8999-999999999999",
            browserId: getOrCreateBrowserId(),
            travelingNow: true,
            updatedAt: new Date().toISOString(),
          },
        }),
      } as Response);

      const onAnswerSubmitted = vi.fn();
      render(
        <TravelSurveyBanner
          forceVisible={true}
          onAnswerSubmitted={onAnswerSubmitted}
        />
      );

      expect(screen.getByText("현재 수원 여행 중이신가요?")).toBeDefined();

      const yesBtn = screen.getByTestId("survey-answer-yes-btn");
      fireEvent.click(yesBtn);

      await waitFor(() => {
        expect(screen.getByTestId("survey-success-notice")).toBeDefined();
        expect(onAnswerSubmitted).toHaveBeenCalledWith(true);
      });

      expect(fetchSpy).toHaveBeenCalled();
      expect(window.sessionStorage.getItem("hm_travel_answered")).toBe("true");
    });

    it("TravelSurveyBanner: 닫기 버튼을 누르면 서버 전송 없이 배너를 숨긴다", () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const onDismiss = vi.fn();

      render(
        <TravelSurveyBanner forceVisible={true} onDismiss={onDismiss} />
      );

      const dismissBtn = screen.getByTestId("survey-dismiss-btn");
      fireEvent.click(dismissBtn);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(onDismiss).toHaveBeenCalled();
      expect(window.sessionStorage.getItem("hm_travel_survey_dismissed")).toBe("true");
    });

    it("MapDirectionsModal: 3사 링크 클릭 시 onDirectionsClick 콜백을 호출한다", () => {
      const onDirectionsClick = vi.fn();
      render(
        <MapDirectionsModal
          isOpen={true}
          onClose={vi.fn()}
          onDirectionsClick={onDirectionsClick}
          target={{
            id: "11111111-1111-4111-8111-111111111111",
            name: "화서문 화장실",
            coords: { lat: 37.287, lng: 127.009 },
          }}
        />
      );

      const kakaoLink = screen.getByTestId("directions-kakao-link");
      fireEvent.click(kakaoLink);
      expect(onDirectionsClick).toHaveBeenCalledWith("kakao");

      const naverLink = screen.getByTestId("directions-naver-link");
      fireEvent.click(naverLink);
      expect(onDirectionsClick).toHaveBeenCalledWith("naver");

      const googleLink = screen.getByTestId("directions-google-link");
      fireEvent.click(googleLink);
      expect(onDirectionsClick).toHaveBeenCalledWith("google");
    });

    it("PublicRestroomCard: 제휴 화장실 결제 버튼 클릭 시 onPaymentClick을 호출한다", () => {
      const onPaymentClick = vi.fn();
      const mockPartner: PublicRestroomSummary = {
        id: "22222222-2222-4222-8222-222222222222",
        type: "partner",
        name: "화서카페 화장실",
        road_address: "수원시 팔달구",
        address_detail: null,
        latitude: 37.28,
        longitude: 127.01,
        access_method: "pin",
        gender_type: "unisex",
        wheelchair_accessible: true,
        baby_changing_available: false,
        sanitary_products_available: false,
        last_verified_at: null,
        business_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        deposit_amount_krw: 1000,
      };

      render(
        <PublicRestroomCard
          restroom={mockPartner}
          onPaymentClick={onPaymentClick}
        />
      );

      const paymentBtn = screen.getByTestId(`partner-payment-btn-${mockPartner.id}`);
      // Disabled button is wrapped in a clickable div container
      const wrapper = paymentBtn.parentElement!;
      fireEvent.click(wrapper);

      expect(onPaymentClick).toHaveBeenCalledWith(mockPartner);
    });

    it("MapDiscoveryClient: 마커 클릭 시 restroom_marker_clicked 이벤트가 정상 전송된다", async () => {
      let registeredMarkers: readonly MarkerOptions[] = [];
      const createMockProvider = (): MapProvider => ({
        name: "mock-map",
        init: vi.fn().mockResolvedValue(undefined),
        destroy: vi.fn(),
        getCenter: vi.fn().mockReturnValue({ lat: 37.2635, lng: 127.0286 }),
        setCenter: vi.fn(),
        getZoomLevel: vi.fn().mockReturnValue(4),
        setZoomLevel: vi.fn(),
        getBounds: vi.fn().mockReturnValue({
          south: 37.25,
          west: 127.01,
          north: 37.27,
          east: 127.03,
        }),
        fitBounds: vi.fn(),
        setMarkers: vi.fn((m) => {
          registeredMarkers = m;
        }),
        addMarker: vi.fn(),
        removeMarker: vi.fn(),
        clearMarkers: vi.fn(),
        relayout: vi.fn(),
      });

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes("/api/v1/restrooms")) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              data: {
                items: [
                  {
                    id: "target-restroom-1",
                    type: "public",
                    name: "장안문 공중화장실",
                    road_address: "수원시 팔달구",
                    latitude: 37.288,
                    longitude: 127.014,
                    access_method: "open",
                    gender_type: "separate",
                    wheelchair_accessible: true,
                    baby_changing_available: false,
                    sanitary_products_available: false,
                    last_verified_at: null,
                    business_id: null,
                  },
                ],
                total: 1,
              },
            }),
          } as Response;
        }

        return {
          ok: true,
          json: async () => ({
            ok: true,
            data: {
              clientEventId: createClientEventId(),
              receivedAt: new Date().toISOString(),
              deduplicated: false,
            },
          }),
        } as Response;
      });

      render(<MapDiscoveryClient providerFactory={() => createMockProvider()} />);

      // Wait for restrooms to be fetched and markers registered
      await waitFor(() => {
        expect(registeredMarkers.length).toBeGreaterThan(0);
      });

      const targetMarker = registeredMarkers.find((m) => m.id === "target-restroom-1");
      expect(targetMarker).toBeDefined();

      // Trigger the marker onClick callback wrapped in act
      await act(async () => {
        targetMarker!.onClick?.("target-restroom-1");
      });

      // Verify that restroom_marker_clicked event was dispatched
      await waitFor(() => {
        const markerEventCall = fetchSpy.mock.calls.find((call) => {
          if (typeof call[1]?.body === "string") {
            try {
              const body = JSON.parse(call[1].body);
              return body.eventName === "restroom_marker_clicked";
            } catch {
              return false;
            }
          }
          return false;
        });
        expect(markerEventCall).toBeDefined();
        const payload = JSON.parse(markerEventCall![1]?.body as string);
        expect(payload.properties.restroom_id).toBe("target-restroom-1");
        expect(payload.properties.type).toBe("public");
      });
    });
  });
});
