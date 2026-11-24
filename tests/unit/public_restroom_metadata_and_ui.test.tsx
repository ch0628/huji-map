/**
 * @vitest-environment jsdom
 */

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import RestroomDetailClient from "@/app/(public)/restrooms/[id]/RestroomDetailClient";
import PublicRestroomCard from "@/components/restroom/PublicRestroomCard";
import { RestroomFacilitiesCard } from "@/components/restroom/restroom-detail-shared";
import {
  normalizePublicRestroomMetadata,
  parseOfficialOperatingHours,
  resolveAmenityDisplay,
} from "@/lib/restrooms/public-metadata";
import { getPublicRestroomDetail } from "@/lib/restrooms/service";
import type { PublicRestroomDetail } from "@/lib/restrooms/types";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("@/lib/events/hooks", () => ({
  useVisitorSession: vi.fn(),
  useEventTracker: () => ({
    trackDetailOpened: vi.fn(),
    trackDirectionsClicked: vi.fn(),
    trackPaymentButtonClicked: vi.fn(),
  }),
}));

const BASE_SEOUL_ILWON: PublicRestroomDetail = {
  id: "224ff8f3-de19-4906-bc2b-69882ba0f363",
  type: "public",
  name: "일원본동주민센터",
  description:
    "개방시간: 정시(09:00~18:00,평일) / 관리: 강남구 자원순환과 / 전화: 02-3423-5964 / 출처: 서울특별시(2026년) · '서울시 공중화장실 위치정보(OA-22586)' · 공공누리 제1유형 (서울 열린데이터광장) / 휴무안내(공식자료): 토요일·일요일 / 기준일: 2026-11-20 / 안내: 공식 공공데이터 기준 · 현장 직접 확인 미완료",
  road_address: "서울특별시 강남구 광평로 126",
  address_detail: "(지번) 서울특별시 강남구 일원동 735-3",
  latitude: 37.4833791,
  longitude: 127.08648282,
  floor: null,
  entrance_instructions: null,
  gender_type: "separate",
  wheelchair_accessible: true,
  baby_changing_available: false,
  sanitary_products_available: null,
  access_method: "open",
  last_verified_at: "2026-11-20T00:00:00Z",
  coordinate_source: "seoul_public_toilet_info",
  business_id: null,
  business: null,
  hours: [],
  hour_exceptions: [],
  active_policy: null,
  photos: [],
  created_at: "2026-11-22T00:00:00Z",
  updated_at: "2026-11-22T00:00:00Z",
};

const BASE_SUWON_CITY_HALL_ANNEX: PublicRestroomDetail = {
  id: "ecc3df48-f5a5-43d5-b07d-c5d6221fadf8",
  type: "public",
  name: "수원시청 별관",
  description: "개방시간: 09:00~18:00 / 관리: 수원시청",
  road_address: "경기도 수원시 팔달구 효원로 241",
  address_detail: "(지번) 경기도 수원시 팔달구 인계동 1111",
  latitude: 37.2635,
  longitude: 127.0286,
  floor: null,
  entrance_instructions: null,
  gender_type: "unknown",
  wheelchair_accessible: true,
  baby_changing_available: true,
  sanitary_products_available: null,
  access_method: "open",
  last_verified_at: "2026-02-20T00:00:00Z",
  coordinate_source: "gg_publtolt_15011425",
  data_source: {
    id: "20135dca-dd0d-46be-ad67-6af8b084cd43",
    provider_name: "경기도 수원시",
    dataset_name: "공중화장실 현황",
    source_url: "https://www.data.go.kr/data/15012892/fileData.do",
    license_name: "공공누리 제1유형: 출처표시",
    license_url: "https://www.kogl.or.kr/info/licenseType1.do",
    attribution_text: "출처: 공공데이터포털(data.go.kr) / 경기도 수원시",
    last_synced_at: "2026-11-20T02:03:05.717Z",
  },
  business_id: null,
  business: null,
  hours: [],
  hour_exceptions: [],
  active_policy: null,
  photos: [],
  created_at: "2026-11-20T00:00:00Z",
  updated_at: "2026-11-20T00:00:00Z",
};

describe("Public Restroom Metadata Normalization & Unified UI", () => {
  it("parses official opening hours & closure formats conservatively without guessing weekdays", () => {
    expect(parseOfficialOperatingHours("정시(09:00~18:00,평일)", "토요일|일요일|")).toEqual({
      summaryText: "평일 09:00~18:00",
      needsReview: false,
      rawHoursText: null,
      closedDaysText: "토요일·일요일 휴무",
    });

    expect(parseOfficialOperatingHours("09:00~18:00")).toEqual({
      summaryText: "09:00~18:00",
      needsReview: false,
      rawHoursText: null,
      closedDaysText: null,
    });

    expect(parseOfficialOperatingHours("정시(09:00~18:00)")).toEqual({
      summaryText: "09:00~18:00",
      needsReview: false,
      rawHoursText: null,
      closedDaysText: null,
    });

    expect(parseOfficialOperatingHours("평일 09:00~18:00(매주 월요일 휴무)")).toEqual({
      summaryText: "평일 09:00~18:00",
      needsReview: false,
      rawHoursText: null,
      closedDaysText: "매주 월요일 휴무",
    });

    expect(parseOfficialOperatingHours("평일 7:00~23:00, 주말 7:00~21:00")).toEqual({
      summaryText: "평일 07:00~23:00 · 주말 07:00~21:00",
      needsReview: false,
      rawHoursText: null,
      closedDaysText: null,
    });

    expect(parseOfficialOperatingHours("10:00~23:.00")).toEqual({
      summaryText: "10:00~23:00",
      needsReview: false,
      rawHoursText: null,
      closedDaysText: null,
    });

    expect(parseOfficialOperatingHours("상시")).toEqual({
      summaryText: "상시 (공식 자료 기준)",
      needsReview: false,
      rawHoursText: null,
      closedDaysText: null,
    });

    expect(parseOfficialOperatingHours("20시간")).toEqual({
      summaryText: null,
      needsReview: true,
      rawHoursText: "20시간",
      closedDaysText: null,
    });

    expect(parseOfficialOperatingHours("공연시간 1시간 전후")).toEqual({
      summaryText: null,
      needsReview: true,
      rawHoursText: "공연시간 1시간 전후",
      closedDaysText: null,
    });
  });

  it("strips duplicate phone numbers embedded in managing agency and avoids duplicate raw description", () => {
    const meta = normalizePublicRestroomMetadata({
      ...BASE_SEOUL_ILWON,
      description:
        "개방시간: 정시(09:00~18:00) / 관리: 자양2동주민센터(02-450-1511) / 전화: 02-450-1511 / 출처: 서울특별시(2026년) · '서울시 공중화장실 위치정보(OA-22586)' · 공공누리 제1유형 (서울 열린데이터광장) / 기준일: 2026-11-20 / 안내: 공식 공공데이터 기준 · 현장 직접 확인 미완료",
    });

    expect(meta.operating.summaryText).toBe("09:00~18:00");
    expect(meta.managingAgency).toBe("자양2동주민센터");
    expect(meta.contactPhone).toBe("02-450-1511");
    expect(meta.source.datasetName).toContain("OA-22586");
    expect(meta.source.licenseName).toContain("공공누리 제1유형");
    expect(meta.source.baseDate).toBe("2026-11-20");
    expect(meta.additionalNote).toBeNull();
  });

  it("renders Seoul 일원본동주민센터 with unified sections, hours, closed days, KOGL1 source, and NO retired notice", () => {
    const { container } = render(<RestroomDetailClient restroom={BASE_SEOUL_ILWON} />);

    // 1. Name & address + conservative operating badge
    expect(screen.getByText("일원본동주민센터")).toBeDefined();
    expect(screen.getByTestId("detail-operating-status-badge").textContent).toBe("운영시간 확인");
    expect(screen.queryByText("현재 이용 가능")).toBeNull();

    // 2. Operating hours & closed days (must NOT show '운영시간 정보 없음')
    expect(screen.queryByTestId("restroom-hours-empty")).toBeNull();
    expect(screen.getByTestId("restroom-official-hours-value").textContent).toBe(
      "평일 09:00~18:00"
    );
    expect(screen.getByTestId("restroom-official-closed-days").textContent).toBe(
      "토요일·일요일 휴무"
    );

    // 3. Free access & directions; NO retired/duplicate notice text
    expect(screen.getByTestId("restroom-free-access-card")).toBeDefined();
    expect(screen.queryByText(/공식 자료 기준 · 실제 개방 여부 미확인/)).toBeNull();
    expect(screen.queryByText(/현장 직접 확인 미완료/)).toBeNull();
    expect(screen.queryByText(/정시\(09:00~18:00,평일\)/)).toBeNull();

    // 4. Tri-state amenities (null sanitary must be 미확인, NOT 없음)
    expect(screen.getByTestId("facility-gender-value").textContent).toBe("남녀 분리");
    expect(screen.getByTestId("facility-wheelchair-value").textContent).toBe("이용 가능");
    expect(screen.getByTestId("facility-baby-changing-value").textContent).toBe("없음");
    expect(screen.getByTestId("facility-sanitary-value").textContent).toBe("미확인");

    // 5. Managing agency & phone
    expect(screen.getByTestId("restroom-managing-agency").textContent).toBe("강남구 자원순환과");
    expect(screen.getByTestId("restroom-contact-phone").textContent).toBe("02-3423-5964");

    // 6. Legal source & base date
    const sourceBox = screen.getByTestId("restroom-source-attribution").textContent || "";
    expect(sourceBox).toContain("OA-22586");
    expect(sourceBox).toContain("공공누리 제1유형");
    expect(screen.getByTestId("restroom-source-base-date").textContent).toBe("2026-11-20");

    // Section display order check (free-access -> facilities -> management -> source)
    const html = container.innerHTML;
    expect(html.indexOf("restroom-official-hours")).toBeLessThan(
      html.indexOf("restroom-free-access-card")
    );
    expect(html.indexOf("restroom-free-access-card")).toBeLessThan(
      html.indexOf("restroom-facilities-card")
    );
    expect(html.indexOf("restroom-facilities-card")).toBeLessThan(
      html.indexOf("restroom-management-info")
    );
    expect(html.indexOf("restroom-management-info")).toBeLessThan(
      html.indexOf("restroom-source-attribution")
    );
  });

  it("renders Suwon 수원시청 별관 with 09:00~18:00 without guessing weekdays or unverified KOGL1 license", () => {
    render(<RestroomDetailClient restroom={BASE_SUWON_CITY_HALL_ANNEX} />);

    expect(screen.queryByTestId("restroom-hours-empty")).toBeNull();
    expect(screen.getByTestId("restroom-official-hours-value").textContent).toBe("09:00~18:00");
    expect(screen.queryByText(/평일 09:00~18:00/)).toBeNull();
    expect(screen.getByTestId("restroom-managing-agency").textContent).toBe("수원시청");
    expect(screen.getByTestId("restroom-source-base-date").textContent).toBe("2026-02-20");
    expect(screen.getByTestId("facility-baby-changing-value").textContent).toBe("있음");
    expect(screen.getByTestId("facility-sanitary-value").textContent).toBe("미확인");

    const sourceBox = screen.getByTestId("restroom-source-attribution").textContent || "";
    expect(sourceBox).toContain("이용허락범위 제한 없음");
    expect(sourceBox).not.toContain("공공누리");
  });

  it("normalizes stale DB KOGL license labels on 15011425 to '이용허락범위 제한 없음' while preserving Seoul OA-22586 KOGL1", () => {
    const ggMeta = normalizePublicRestroomMetadata({
      ...BASE_SUWON_CITY_HALL_ANNEX,
      data_source: {
        id: "0deee04a-a6e7-4b5c-9302-65312dfc192b",
        provider_name: "경기도",
        dataset_name: "경기도 공중화장실 현황 (Publtolt / 15011425)",
        source_url: "https://www.data.go.kr/data/15011425/openapi.do",
        license_name: "공공누리 / 경기데이터드림 이용약관 (상용 전 사전확인 필요)",
        license_url: "https://data.gg.go.kr/portal/terms/termsPolicyPage.do",
        attribution_text: "출처: 경기도 / 경기데이터드림(data.gg.go.kr) 공중화장실 현황(15011425)",
        last_synced_at: "2026-11-20T05:59:38.663Z",
      },
    });
    expect(ggMeta.source.licenseName).toBe("이용허락범위 제한 없음");

    const seoulMeta = normalizePublicRestroomMetadata({
      ...BASE_SEOUL_ILWON,
      data_source: {
        id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
        provider_name: "서울특별시",
        dataset_name: "서울시 공중화장실 위치정보 (OA-22586)",
        source_url: "https://data.seoul.go.kr/dataList/OA-22586/S/1/datasetView.do",
        license_name: "공공누리 제1유형 (출처표시)",
        license_url: "https://www.kogl.or.kr/info/licenseType1.do",
        attribution_text:
          "본 서비스는 '서울특별시'에서 '2026년' 작성하여 공공누리 제1유형으로 개방한 '서울시 공중화장실 위치정보(OA-22586)'를 서울 열린데이터광장(https://data.seoul.go.kr/dataList/OA-22586/S/1/datasetView.do)에서 무료로 내려받아 이용하였습니다.",
        last_synced_at: "2026-11-22T13:56:27.036Z",
      },
    });
    expect(seoulMeta.source.licenseName).toBe("공공누리 제1유형 (출처표시)");
  });

  it("does not fabricate KOGL Type 1 license for gg_publtolt_15011425 when data_source is absent", () => {
    const meta = normalizePublicRestroomMetadata({
      ...BASE_SUWON_CITY_HALL_ANNEX,
      data_source: null,
    });
    expect(meta.source.providerName).toBe("경기도");
    expect(meta.source.datasetName).toContain("15011425");
    expect(meta.source.licenseName).toBeNull();
  });

  it("shows '운영시간 정보 없음' only when neither structured hours nor description opening hours exist", () => {
    render(
      <RestroomDetailClient
        restroom={{
          ...BASE_SUWON_CITY_HALL_ANNEX,
          description: null,
          hours: [],
        }}
      />
    );
    expect(screen.getByTestId("restroom-hours-empty").textContent).toContain("운영시간 정보 없음");
  });

  it("preserves unparsed hours text (e.g. '20시간') without showing '운영시간 정보 없음'", () => {
    render(
      <RestroomDetailClient
        restroom={{
          ...BASE_SUWON_CITY_HALL_ANNEX,
          name: "수원시청역 화장실",
          description: "개방시간: 20시간 / 관리: 한국철도공사 수도권동부본부",
        }}
      />
    );
    expect(screen.queryByTestId("restroom-hours-empty")).toBeNull();
    expect(screen.getByTestId("restroom-official-hours-value").textContent).toContain("20시간");
    expect(screen.getByTestId("restroom-official-hours-value").textContent).toContain("확인 필요");
  });

  it("distinguishes true / false / null strictly for all amenities in RestroomFacilitiesCard and PublicRestroomCard", () => {
    expect(resolveAmenityDisplay(true, { available: "있음", unavailable: "없음" })).toEqual({
      state: "available",
      label: "있음",
    });
    expect(resolveAmenityDisplay(false, { available: "있음", unavailable: "없음" })).toEqual({
      state: "unavailable",
      label: "없음",
    });
    expect(resolveAmenityDisplay(null, { available: "있음", unavailable: "없음" })).toEqual({
      state: "unknown",
      label: "미확인",
    });

    const { unmount } = render(
      <RestroomFacilitiesCard
        restroom={{
          ...BASE_SEOUL_ILWON,
          wheelchair_accessible: false,
          baby_changing_available: null,
          sanitary_products_available: true,
        }}
      />
    );
    expect(screen.getByTestId("facility-wheelchair-value").textContent).toBe("어려움");
    expect(screen.getByTestId("facility-baby-changing-value").textContent).toBe("미확인");
    expect(screen.getByTestId("facility-sanitary-value").textContent).toBe("비치됨");
    unmount();

    render(
      <PublicRestroomCard
        restroom={{
          id: "c1",
          type: "public",
          name: "테스트 화장실",
          road_address: "서울시 테스트로 1",
          address_detail: null,
          latitude: 37.5,
          longitude: 127.0,
          access_method: "open",
          gender_type: "separate",
          wheelchair_accessible: null,
          baby_changing_available: null,
          sanitary_products_available: null,
          last_verified_at: "2026-11-20T00:00:00Z",
          business_id: null,
        }}
      />
    );
    expect(screen.getByText("휠체어 정보 미확인")).toBeDefined();
    expect(screen.queryByText(/기저귀대/)).toBeNull();
    expect(screen.queryByText(/위생용품/)).toBeNull();
  });

  it("keeps partner restroom payment/PIN regression behavior intact", () => {
    render(
      <RestroomDetailClient
        restroom={{
          ...BASE_SUWON_CITY_HALL_ANNEX,
          id: "cccccccc-cccc-4ccc-8ccc-dddddddd0001",
          type: "partner",
          name: "DEMO/TEST 카나리 제휴 테스트 화장실",
          description: "DEMO/TEST 제휴 회귀 테스트 전용",
          access_method: "pin",
          baby_changing_available: false,
          sanitary_products_available: null,
          business_id: "bbbbbbbb-bbbb-4bbb-8bbb-cccccccc0001",
          business: {
            id: "bbbbbbbb-bbbb-4bbb-8bbb-cccccccc0001",
            name: "DEMO/TEST 카나리 제휴 회귀 테스트 매장",
            category: "카페",
            description: null,
            road_address: "경기도 수원시 팔달구 효원로 1",
            jibun_address: null,
            address_detail: null,
            latitude: 37.27966,
            longitude: 127.0181,
            phone: "031-000-0000",
            website_url: null,
          },
          active_policy: {
            id: "pol-partner",
            version: 1,
            access_mode: "test_deposit",
            deposit_amount_krw: 1000,
            refund_eligible: true,
            receipt_window_hours: 24,
            min_purchase_krw: 3000,
            effective_from: "2026-11-22T00:00:00Z",
          },
        }}
      />
    );

    expect(screen.getByTestId("detail-partner-badge")).toBeDefined();
    expect(screen.getByTestId("detail-partner-payment-btn")).toBeDefined();
    expect(screen.getByTestId("detail-pin-after-payment-note")).toBeDefined();
    expect(screen.getByTestId("facility-baby-changing-value").textContent).toBe("없음");
    expect(screen.getByTestId("facility-sanitary-value").textContent).toBe("미확인");
    expect(screen.queryByTestId("restroom-source-attribution")).toBeNull();
  });

  it("hydrates public_data_sources in getPublicRestroomDetail when source_id is present", async () => {
    const mockSupabase: any = {
      from(table: string) {
        const makeChain = (rowData: any, listData: any[] = []) => {
          const chain: any = {
            select: () => chain,
            eq: () => chain,
            in: () => chain,
            order: () => chain,
            maybeSingle: () => Promise.resolve({ data: rowData, error: null }),
            then: (onFulfilled: any, onRejected: any) =>
              Promise.resolve({ data: listData, error: null }).then(onFulfilled, onRejected),
          };
          return chain;
        };

        if (table === "restrooms") {
          return makeChain({
            id: "ecc3df48-f5a5-43d5-b07d-c5d6221fadf8",
            type: "public",
            name: "수원시청 별관",
            description: "개방시간: 09:00~18:00 / 관리: 수원시청",
            road_address: "경기도 수원시 팔달구 효원로 241",
            address_detail: null,
            latitude: 37.2635,
            longitude: 127.0286,
            floor: null,
            entrance_instructions: null,
            gender_type: "unknown",
            wheelchair_accessible: true,
            baby_changing_available: false,
            sanitary_products_available: null,
            access_method: "open",
            publication_status: "published",
            last_verified_at: "2026-02-20T00:00:00Z",
            source_id: "src-suwon-1",
            coordinate_source_id: "src-suwon-1",
            coordinate_source: "gg_publtolt_15011425",
            coordinate_type: null,
            coordinate_verification_status: null,
            business_id: null,
            created_at: "2026-11-20T00:00:00Z",
            updated_at: "2026-11-20T00:00:00Z",
          });
        }
        if (table === "public_data_sources") {
          return makeChain({
            id: "src-suwon-1",
            provider_name: "경기도 수원시",
            dataset_name: "공중화장실 현황",
            source_url: "https://www.data.go.kr/data/15012892/fileData.do",
            license_name: "공공누리 제1유형: 출처표시",
            license_url: "https://www.kogl.or.kr/info/licenseType1.do",
            attribution_text: "출처: 공공데이터포털(data.go.kr) / 경기도 수원시",
            last_synced_at: "2026-11-20T02:03:05.717Z",
          });
        }
        return makeChain(null, []);
      },
    };

    const detail = await getPublicRestroomDetail(
      mockSupabase,
      "ecc3df48-f5a5-43d5-b07d-c5d6221fadf8"
    );
    expect(detail).not.toBeNull();
    expect(detail?.source_id).toBe("src-suwon-1");
    expect(detail?.coordinate_source).toBe("gg_publtolt_15011425");
    expect(detail?.data_source?.provider_name).toBe("경기도 수원시");
    expect(detail?.data_source?.license_name).toBe("공공누리 제1유형: 출처표시");
  });
});
