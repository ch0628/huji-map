/**
 * @vitest-environment jsdom
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type {
  PublicRestroomSummary,
  PublicRestroomDetail,
} from "@/lib/restrooms/types";
import PublicRestroomCard from "@/components/restroom/PublicRestroomCard";
import PublicRestroomDetailView from "@/components/restroom/PublicRestroomDetailView";
import MapDirectionsModal from "@/components/map/MapDirectionsModal";
import MapFilterBar from "@/components/map/MapFilterBar";
import MapBottomSheet from "@/components/map/MapBottomSheet";
import MapDiscoveryClient from "@/components/map/MapDiscoveryClient";
import type { MapProvider } from "@/lib/maps/types";

describe("TASK 16: Map Discovery UI - Cards, Filters, BottomSheet, Directions & Details", () => {
  const mockPublicRestroom: PublicRestroomSummary = {
    id: "11111111-1111-4111-8111-111111111111",
    type: "public",
    name: "수원화성 장안문 공중화장실",
    road_address: "경기도 수원시 팔달구 정조로 900",
    address_detail: "장안문 동측 매표소 옆",
    latitude: 37.2882,
    longitude: 127.0145,
    access_method: "open",
    gender_type: "separate",
    wheelchair_accessible: true,
    baby_changing_available: true,
    sanitary_products_available: false,
    last_verified_at: "2026-11-10T10:00:00Z",
    business_id: null,
  };

  const mockPartnerRestroom: PublicRestroomSummary = {
    id: "22222222-2222-4222-8222-222222222222",
    type: "partner",
    name: "행궁카페 화장실",
    road_address: "경기도 수원시 팔달구 신풍로 23",
    address_detail: "1층 안쪽",
    latitude: 37.2831,
    longitude: 127.0162,
    access_method: "pin",
    gender_type: "unisex",
    wheelchair_accessible: null, // 미확인
    baby_changing_available: false,
    sanitary_products_available: true,
    last_verified_at: "2026-11-10T11:00:00Z",
    business_id: "33333333-3333-4333-8333-333333333333",
    business_name: "행궁카페 본점",
    deposit_amount_krw: 1000,
    access_mode: "test_deposit",
  };

  describe("1. PublicRestroomCard (화장실 정보 카드 컴포넌트)", () => {
    it("무료 공공 화장실을 올바르게 렌더링하고 결제 버튼을 절대 노출하지 않는다", () => {
      const onDirectionsClick = vi.fn();
      render(
        <PublicRestroomCard
          restroom={mockPublicRestroom}
          onDirectionsClick={onDirectionsClick}
        />
      );

      // 공공 화장실 뱃지 확인
      expect(
        screen.getByTestId("restroom-type-public-badge").textContent
      ).toContain("무료 공공");
      expect(screen.getByText("수원화성 장안문 공중화장실")).toBeDefined();
      expect(screen.getByText(/누구나 무료 이용/)).toBeDefined();

      // 길찾기 버튼 확인 및 클릭 동작
      const directionsBtn = screen.getByTestId(
        `directions-btn-${mockPublicRestroom.id}`
      );
      expect(directionsBtn).toBeDefined();
      fireEvent.click(directionsBtn);
      expect(onDirectionsClick).toHaveBeenCalledWith(mockPublicRestroom);

      // 공공 화장실은 결제 버튼이 없어야 함 (중요 규칙)
      expect(
        screen.queryByTestId(`partner-payment-btn-${mockPublicRestroom.id}`)
      ).toBeNull();
    });

    it("안심 제휴 화장실(test_deposit)의 DB 보증금 및 상세 결제 안내를 올바르게 렌더링한다", () => {
      render(<PublicRestroomCard restroom={mockPartnerRestroom} />);

      // 제휴 뱃지 확인
      expect(
        screen.getByTestId("restroom-type-partner-badge").textContent
      ).toContain("안심 제휴");
      expect(screen.getByText("행궁카페 화장실")).toBeDefined();
      expect(screen.getByText("1,000원")).toBeDefined();
      expect(screen.queryByText(/결제 기능 준비 중/)).toBeNull();

      // 상세 페이지에서 실제 테스트 결제 가능 안내 및 링크 확인
      const detailLink = screen.getByTestId(
        `detail-link-${mockPartnerRestroom.id}`
      );
      expect(detailLink.textContent).toContain("보증금 결제 · 상세");
    });

    it("무료 정책(free) 제휴 화장실은 무료로 표시하고 1,000원이나 결제 버튼을 노출하지 않는다", () => {
      render(
        <PublicRestroomCard
          restroom={{
            ...mockPartnerRestroom,
            access_mode: "free",
            deposit_amount_krw: 0,
          }}
        />
      );

      expect(screen.getByText("무료")).toBeDefined();
      expect(screen.queryByText("1,000원")).toBeNull();
      expect(screen.queryByText(/보증금 결제/)).toBeNull();
    });

    it("test_deposit 보증금 금액이 변경되면 변경된 DB 금액을 그대로 표시한다", () => {
      render(
        <PublicRestroomCard
          restroom={{
            ...mockPartnerRestroom,
            access_mode: "test_deposit",
            deposit_amount_krw: 2500,
          }}
        />
      );

      expect(screen.getByText("2,500원")).toBeDefined();
      expect(screen.queryByText("1,000원")).toBeNull();
    });

    it("그 외 정책(real_deposit / 미설정)에서도 1,000원을 임의로 표시하지 않는다", () => {
      const { rerender } = render(
        <PublicRestroomCard
          restroom={{
            ...mockPartnerRestroom,
            access_mode: "real_deposit",
            deposit_amount_krw: 3000,
          }}
        />
      );
      expect(screen.getByText("결제 미지원")).toBeDefined();
      expect(screen.queryByText("1,000원")).toBeNull();

      rerender(
        <PublicRestroomCard
          restroom={{
            ...mockPartnerRestroom,
            access_mode: null,
            deposit_amount_krw: null,
          }}
        />
      );
      expect(screen.getByText("정책 확인 필요")).toBeDefined();
      expect(screen.queryByText("1,000원")).toBeNull();
    });

    it("편의시설(휠체어, 기저귀대 등)의 정보 상태(이용가능/미확인)를 구분하여 표시한다", () => {
      // 1) 휠체어 이용 가능
      const { unmount } = render(
        <PublicRestroomCard restroom={mockPublicRestroom} />
      );
      expect(screen.getByText("♿ 휠체어 이용 가능")).toBeDefined();
      expect(screen.getByText("👶 기저귀대")).toBeDefined();
      unmount();

      // 2) 휠체어 정보 미확인 (null)
      render(<PublicRestroomCard restroom={mockPartnerRestroom} />);
      expect(screen.getByText("휠체어 정보 미확인")).toBeDefined();
      expect(screen.getByText("🧴 위생용품")).toBeDefined();
    });
  });

  describe("2. MapDirectionsModal (3사 길찾기 URL 연동 모달)", () => {
    it("카카오, 네이버, 구글 3사의 공식 길찾기 링크를 정확한 파라미터로 생성한다", () => {
      const onClose = vi.fn();
      render(
        <MapDirectionsModal
          isOpen={true}
          onClose={onClose}
          target={{
            name: "수원화성 장안문 공중화장실",
            address: "경기도 수원시 팔달구 정조로 900",
            coords: { lat: 37.2882, lng: 127.0145 },
          }}
          origin={{
            name: "내 위치",
            coords: { lat: 37.2635, lng: 127.0286 },
          }}
        />
      );

      const kakaoLink = screen.getByTestId("directions-kakao-link");
      const naverLink = screen.getByTestId("directions-naver-link");
      const googleLink = screen.getByTestId("directions-google-link");

      // 카카오 URL 검증
      expect(kakaoLink.getAttribute("href")).toContain(
        "https://map.kakao.com/link/to/"
      );
      expect(kakaoLink.getAttribute("href")).toContain("37.2882,127.0145");

      // 네이버 URL 검증
      expect(naverLink.getAttribute("href")).toContain(
        "https://map.naver.com/index.nhn?"
      );
      expect(naverLink.getAttribute("href")).toContain("elng=127.0145");
      expect(naverLink.getAttribute("href")).toContain("elat=37.2882");

      // 구글 URL 검증
      expect(googleLink.getAttribute("href")).toContain(
        "https://www.google.com/maps/dir/?api=1&destination=37.2882%2C127.0145"
      );
    });

    it("Esc 키 입력 시 모달 닫기 콜백이 호출된다", () => {
      const onClose = vi.fn();
      render(
        <MapDirectionsModal
          isOpen={true}
          onClose={onClose}
          target={{
            name: "테스트",
            coords: { lat: 37.28, lng: 127.01 },
          }}
        />
      );

      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe("3. MapFilterBar (검색창, 필터 칩 및 내 위치 버튼)", () => {
    it("검색어 입력 및 초기화 버튼이 정상 동작한다", () => {
      const onSearchChange = vi.fn();
      render(
        <MapFilterBar
          searchKeyword="장안문"
          onSearchChange={onSearchChange}
          filterType="all"
          onFilterTypeChange={vi.fn()}
          onCurrentLocationClick={vi.fn()}
        />
      );

      const input = screen.getByTestId("map-search-input");
      expect((input as HTMLInputElement).value).toBe("장안문");

      const clearBtn = screen.getByTestId("map-search-clear-btn");
      fireEvent.click(clearBtn);
      expect(onSearchChange).toHaveBeenCalledWith("");
    });

    it("필터 칩(전체, 무료 공공, 안심 제휴) 클릭 시 적절한 타입으로 변경 콜백을 호출한다", () => {
      const onFilterTypeChange = vi.fn();
      render(
        <MapFilterBar
          searchKeyword=""
          onSearchChange={vi.fn()}
          filterType="all"
          onFilterTypeChange={onFilterTypeChange}
          onCurrentLocationClick={vi.fn()}
        />
      );

      fireEvent.click(screen.getByTestId("filter-chip-public"));
      expect(onFilterTypeChange).toHaveBeenCalledWith("public");

      fireEvent.click(screen.getByTestId("filter-chip-partner"));
      expect(onFilterTypeChange).toHaveBeenCalledWith("partner");
    });
  });

  describe("4. MapBottomSheet (바텀시트: 선택, 목록, 빈 상태)", () => {
    it("선택된 화장실이 있을 때 해당 화장실 카드를 표시하고 닫기 버튼을 제공한다", () => {
      const onCloseSelected = vi.fn();
      render(
        <MapBottomSheet
          selectedRestroom={mockPublicRestroom}
          restrooms={[mockPublicRestroom]}
          onSelectRestroom={vi.fn()}
          onCloseSelected={onCloseSelected}
          onDirectionsClick={vi.fn()}
          isExpanded={false}
          onToggleExpand={vi.fn()}
        />
      );

      expect(screen.getByTestId("map-bottom-sheet-selected")).toBeDefined();
      const closeBtn = screen.getByTestId("bottom-sheet-close-btn");
      fireEvent.click(closeBtn);
      expect(onCloseSelected).toHaveBeenCalled();
    });

    it("선택된 화장실이 없을 때 피크 바를 표시하고 확장 시 목록을 렌더링한다", () => {
      render(
        <MapBottomSheet
          selectedRestroom={null}
          restrooms={[mockPublicRestroom, mockPartnerRestroom]}
          onSelectRestroom={vi.fn()}
          onCloseSelected={vi.fn()}
          onDirectionsClick={vi.fn()}
          isExpanded={true}
          onToggleExpand={vi.fn()}
        />
      );

      expect(screen.getByText("이 지역 화장실 2곳")).toBeDefined();
      expect(screen.getByTestId("bottom-sheet-expanded-content")).toBeDefined();
      expect(
        screen.getByTestId(`public-restroom-card-${mockPublicRestroom.id}`)
      ).toBeDefined();
      expect(
        screen.getByTestId(`public-restroom-card-${mockPartnerRestroom.id}`)
      ).toBeDefined();
    });

    it("화장실이 0건일 때 빈 상태 안내를 제공한다", () => {
      render(
        <MapBottomSheet
          selectedRestroom={null}
          restrooms={[]}
          onSelectRestroom={vi.fn()}
          onCloseSelected={vi.fn()}
          onDirectionsClick={vi.fn()}
          isExpanded={true}
          onToggleExpand={vi.fn()}
        />
      );

      expect(screen.getByTestId("bottom-sheet-empty-state")).toBeDefined();
      expect(screen.getByText("표시할 화장실이 없습니다")).toBeDefined();
    });
  });

  describe("5. PublicRestroomDetailView (화장실 상세 화면)", () => {
    const mockDetail: PublicRestroomDetail = {
      ...mockPublicRestroom,
      description: "화성행궁 북쪽 성곽길에 위치한 쾌적한 화장실",
      floor: "1층",
      entrance_instructions: "장안문 주차장 입구 우측 진입로 이용",
      business: null,
      active_policy: null,
      created_at: "2026-11-10T10:00:00Z",
      updated_at: "2026-11-10T10:00:00Z",
      hours: [
        {
          id: "h-0",
          weekday: 0,
          opens_at: "09:00:00",
          closes_at: "22:00:00",
          is_closed: false,
          crosses_midnight: false,
        },
        {
          id: "h-1",
          weekday: 1,
          opens_at: null,
          closes_at: null,
          is_closed: true,
          crosses_midnight: false,
        },
      ],
      hour_exceptions: [],
      photos: [],
    };

    it("공공 화장실 상세 정보를 정확히 표시하고 도어락 PIN은 일체 노출하지 않는다", () => {
      render(<PublicRestroomDetailView restroom={mockDetail} />);

      expect(
        screen.getByTestId("detail-public-badge").textContent
      ).toContain("무료 공공 화장실");
      expect(screen.getByText("수원화성 장안문 공중화장실")).toBeDefined();
      expect(screen.getByText("장안문 주차장 입구 우측 진입로 이용")).toBeDefined();
      expect(screen.getByText("일요일")).toBeDefined();
      expect(screen.getByText("09:00 ~ 22:00")).toBeDefined();
      expect(screen.getByText("휴무")).toBeDefined();

      // 길찾기 버튼 확인
      expect(screen.getByTestId("detail-directions-btn")).toBeDefined();

      // 결제 버튼 없어야 함
      expect(screen.queryByTestId("detail-partner-payment-btn")).toBeNull();

      // PIN 및 비밀번호 문구 미포함 검증
      expect(screen.queryByText(/PIN 번호: [0-9]+/)).toBeNull();
    });

    it("운영시간이 비어있으면 '운영시간 정보 없음'을 표시하고 임의로 '24시간 운영'을 표시하지 않는다", () => {
      render(
        <PublicRestroomDetailView
          restroom={{
            ...mockDetail,
            hours: [],
          }}
        />
      );

      expect(screen.getByText("운영시간 정보 없음")).toBeDefined();
      expect(screen.queryByText("24시간 운영")).toBeNull();
    });
  });

  describe("6. MapDiscoveryClient (지도 탐색 통합 컨트롤러)", () => {
    const createMockProvider = (): MapProvider => ({
      name: "mock-provider",
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
      setMarkers: vi.fn(),
      addMarker: vi.fn(),
      removeMarker: vi.fn(),
      clearMarkers: vi.fn(),
      relayout: vi.fn(),
    });

    beforeEach(() => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            items: [mockPublicRestroom, mockPartnerRestroom],
            total: 2,
            limit: 100,
            offset: 0,
          },
        }),
      } as any);
    });

    it("커스텀 MapProvider 주입을 통해 지도를 초기화하고 컨트롤 요소들을 렌더링한다", async () => {
      const mockFactory = () => createMockProvider();

      render(<MapDiscoveryClient providerFactory={mockFactory} />);

      expect(screen.getByTestId("map-discovery-container")).toBeDefined();
      expect(screen.getByTestId("map-filter-bar")).toBeDefined();
      expect(screen.getByTestId("map-zoom-in-btn")).toBeDefined();
      expect(screen.getByTestId("map-zoom-out-btn")).toBeDefined();
      expect(screen.getByTestId("map-recenter-btn")).toBeDefined();
      expect(screen.getByTestId("map-bottom-sheet-drawer")).toBeDefined();
    });
  });
});
