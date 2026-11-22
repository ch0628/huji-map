// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import MapBottomSheet from "@/components/map/MapBottomSheet";
import PublicRestroomDetailView from "@/components/restroom/PublicRestroomDetailView";
import { evaluateOperatingStatus } from "@/components/restroom/restroom-detail-shared";
import RestroomDetailClient from "@/app/(public)/restrooms/[id]/RestroomDetailClient";
import type { PublicRestroomDetail } from "@/lib/restrooms/types";
import type { CustomerAccessDetail } from "@/components/access/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
  usePathname: () => "/restrooms/b2222222-2222-4222-8222-222222222222",
}));

afterEach(() => {
  cleanup();
});

const FULL_WEEK_HOURS = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  id: `hr_${weekday}`,
  weekday,
  opens_at: "00:00",
  closes_at: "23:59",
  is_closed: false,
  crosses_midnight: false,
}));

const PARTNER_RESTROOM: PublicRestroomDetail = {
  id: "b2222222-2222-4222-8222-222222222222",
  type: "partner",
  name: "DEMO/TEST 제휴카페 화장실",
  description: null,
  road_address: "경기도 수원시 팔달구 테스트로 123",
  address_detail: "1층 안쪽",
  latitude: 37.2636,
  longitude: 127.0286,
  floor: "1층",
  entrance_instructions: "카운터 왼쪽 복도",
  gender_type: "unisex",
  wheelchair_accessible: true,
  baby_changing_available: false,
  sanitary_products_available: false,
  access_method: "pin",
  last_verified_at: "2026-11-01T00:00:00Z",
  business_id: "biz_1",
  business: {
    id: "biz_1",
    name: "DEMO/TEST 진미통닭",
    category: "음식점",
    description: null,
    road_address: "경기도 수원시 팔달구 테스트로 123",
    jibun_address: null,
    address_detail: null,
    latitude: 37.2636,
    longitude: 127.0286,
    phone: "031-000-1234",
    website_url: null,
  },
  hours: FULL_WEEK_HOURS,
  hour_exceptions: [],
  active_policy: {
    id: "pol_1",
    version: 1,
    access_mode: "test_deposit",
    deposit_amount_krw: 1000,
    refund_eligible: true,
    receipt_window_hours: 24,
    min_purchase_krw: 1000,
    effective_from: "2026-11-01T00:00:00Z",
  },
  photos: [],
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
};

const ACTIVE_ACCESS_DETAIL: CustomerAccessDetail = {
  session: {
    id: "acc_1",
    user_id: "usr_1",
    restroom_id: PARTNER_RESTROOM.id,
    policy_id: "pol_1",
    status: "authorized",
    access_method_snapshot: "pin",
    authorized_at: "2026-11-01T00:00:00Z",
    code_revealed_at: null,
    expires_at: "2099-01-01T00:00:00Z",
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
  },
  effectiveStatus: "authorized",
  restroom: {
    id: PARTNER_RESTROOM.id,
    name: PARTNER_RESTROOM.name,
    road_address: PARTNER_RESTROOM.road_address,
    address_detail: PARTNER_RESTROOM.address_detail,
    floor: PARTNER_RESTROOM.floor,
    entrance_instructions: PARTNER_RESTROOM.entrance_instructions,
    access_method: "pin",
    publication_status: "published",
    business_id: "biz_1",
    business_name: "DEMO/TEST 진미통닭",
    business_category: "음식점",
    business_phone: "031-000-1234",
  },
  order: {
    id: "ord_1",
    user_id: "usr_1",
    access_session_id: "acc_1",
    order_id: "hm_ord_1",
    provider: "toss",
    payment_mode: "test",
    amount_krw: 1000,
    status: "approved",
    approved_at: "2026-11-01T00:00:00Z",
    failure_code: null,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
  },
  refund: null,
  latestVisitConfirmation: null,
  eligibleForPinReveal: true,
  policy: {
    id: "pol_1",
    version: 1,
    access_mode: "test_deposit",
    deposit_amount_krw: 1000,
    refund_eligible: true,
    receipt_window_hours: 24,
    min_purchase_krw: 1000,
  },
  visitConfirmations: [],
};

describe("UI/UX 1차 작업 검증", () => {
  it("UI-01: MapBottomSheet 선택 상태 닫기 버튼이 스크롤 영역 밖에 독립 헤더로 배치된다", () => {
    const onClose = vi.fn();
    render(
      <MapBottomSheet
        selectedRestroom={{
          id: PARTNER_RESTROOM.id,
          type: "partner",
          name: PARTNER_RESTROOM.name,
          road_address: PARTNER_RESTROOM.road_address,
          address_detail: PARTNER_RESTROOM.address_detail,
          latitude: PARTNER_RESTROOM.latitude!,
          longitude: PARTNER_RESTROOM.longitude!,
          access_method: "pin",
          gender_type: "unisex",
          wheelchair_accessible: true,
          baby_changing_available: false,
          sanitary_products_available: false,
          last_verified_at: PARTNER_RESTROOM.last_verified_at,
          business_id: "biz_1",
          business_name: "DEMO/TEST 진미통닭",
          deposit_amount_krw: 1000,
          access_mode: "test_deposit",
          distance_meters: 100,
        }}
        restrooms={[]}
        onSelectRestroom={vi.fn()}
        onCloseSelected={onClose}
        onDirectionsClick={vi.fn()}
        isExpanded={false}
        onToggleExpand={vi.fn()}
      />
    );

    const closeBtn = screen.getByTestId("bottom-sheet-close-btn");
    expect(closeBtn).toBeTruthy();
    expect(closeBtn.className).toContain("h-10");
    expect(closeBtn.className).toContain("w-10");
    expect(screen.queryByText("선택한 화장실")).toBeNull();
  });

  it("UI-02/06: 공공화장실 상세에 정보 검증일이 노출되지 않고 운영시간 상태 판별이 보수적으로 동작한다", () => {
    render(
      <PublicRestroomDetailView
        restroom={{
          ...PARTNER_RESTROOM,
          id: "a1111111-1111-4111-8111-111111111111",
          type: "public",
          access_method: "open",
          active_policy: null,
          business_id: null,
          business: null,
        }}
      />
    );

    expect(screen.queryByText(/정보 검증일/)).toBeNull();
    expect(screen.getByTestId("detail-operating-status-badge").textContent).toContain(
      "현재 이용 가능"
    );

    const unknownStatus = evaluateOperatingStatus(
      [],
      [],
      new Date("2026-11-21T03:00:00Z")
    );
    expect(unknownStatus.state).toBe("unknown");
    expect(unknownStatus.label).toBe("운영시간 확인");
  });

  it("UI-06/08: 미결제 제휴 화장실은 길찾기 아래 세로 스택 결제 버튼과 결제 후 비밀번호 안내를 표시한다", () => {
    render(
      <RestroomDetailClient
        restroom={PARTNER_RESTROOM}
        currentUser={{ id: "usr_1", email: "user@example.com" }}
        initialActiveAccess={null}
      />
    );

    expect(screen.getByText(/031-000-1234/)).toBeTruthy();
    expect(screen.queryByText("제휴 매장 안내")).toBeNull();
    expect(screen.getByTestId("detail-directions-btn")).toBeTruthy();
    expect(screen.getByTestId("detail-partner-payment-btn")).toBeTruthy();
    expect(screen.getByTestId("detail-pin-after-payment-note").textContent).toContain(
      "결제 후 비밀번호 확인 가능"
    );
    expect(screen.queryByTestId("reveal-pin-btn")).toBeNull();
  });

  it("UI-08: 결제 완료 이용권이 있는 제휴 화장실 상세에서는 도어락 비밀번호 확인 버튼을 바로 표시한다", () => {
    render(
      <RestroomDetailClient
        restroom={PARTNER_RESTROOM}
        currentUser={{ id: "usr_1", email: "user@example.com" }}
        initialActiveAccess={ACTIVE_ACCESS_DETAIL}
      />
    );

    expect(screen.getByTestId("detail-active-access-box")).toBeTruthy();
    expect(screen.getByTestId("reveal-pin-btn").textContent).toContain(
      "비밀번호 확인하기"
    );
    expect(screen.queryByTestId("detail-partner-payment-btn")).toBeNull();
  });

  it("UI-08 보안: open/free 화장실에는 activeAccess가 넘어가도 PIN 버튼이 노출되지 않는다", () => {
    render(
      <RestroomDetailClient
        restroom={{
          ...PARTNER_RESTROOM,
          access_method: "open",
          active_policy: null,
        }}
        currentUser={{ id: "usr_1", email: "user@example.com" }}
        initialActiveAccess={ACTIVE_ACCESS_DETAIL}
      />
    );

    expect(screen.queryByTestId("reveal-pin-btn")).toBeNull();
    expect(screen.queryByTestId("detail-active-access-box")).toBeNull();
  });
});
