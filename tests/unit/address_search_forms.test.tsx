/**
 * @vitest-environment jsdom
 */

import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BusinessForm from "@/components/business/BusinessForm";
import RestroomForm from "@/components/restroom/RestroomForm";
import {
  mapKakaoAddressResults,
  mapKakaoPlaceToAddressResults,
  type AddressSearchResult,
} from "@/lib/maps/address-search";
import {
  createBusinessSchema,
  updateBusinessSchema,
} from "@/lib/businesses/validation";
import {
  createMerchantRestroomSchema,
  updateMerchantRestroomSchema,
} from "@/lib/restrooms/merchant-validation";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    refresh: vi.fn(),
  }),
}));

const ROAD_RESULT: AddressSearchResult = {
  id: "addr-road-1",
  roadAddress: "경기도 수원시 팔달구 매산로 1",
  jibunAddress: "경기도 수원시 팔달구 매산로1가 18",
  displayAddress: "경기도 수원시 팔달구 매산로 1",
  buildingName: "수원역빌딩",
  lat: 37.2661,
  lng: 127.0011,
  source: "road",
};

const JIBUN_RESULT: AddressSearchResult = {
  id: "addr-jibun-1",
  roadAddress: "경기도 수원시 팔달구 정조로 825",
  jibunAddress: "경기도 수원시 팔달구 남창동 6-2",
  displayAddress: "경기도 수원시 팔달구 정조로 825",
  buildingName: null,
  lat: 37.2822,
  lng: 127.0155,
  source: "jibun",
};

describe("Requirement B: 주소 자동 변환 및 좌표 수동 입력 제거", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("1. 카카오 지오코딩 응답 매핑 및 좌표 실패 방어", () => {
    it("도로명주소 및 지번주소 결과를 정규화하고 유효하지 않은/0,0 좌표는 제외한다", () => {
      const mapped = mapKakaoAddressResults([
        {
          address_name: "경기도 수원시 팔달구 매산로 1",
          x: "127.0011",
          y: "37.2661",
          road_address: {
            address_name: "경기도 수원시 팔달구 매산로 1",
            building_name: "수원역빌딩",
          },
          address: { address_name: "경기도 수원시 팔달구 매산로1가 18" },
        },
        {
          address_name: "경기도 수원시 팔달구 매산로1가 99",
          x: "127.0022",
          y: "37.2672",
          road_address: null,
          address: { address_name: "경기도 수원시 팔달구 매산로1가 99" },
        },
        {
          address_name: "좌표 오류 항목",
          x: "0",
          y: "0",
        },
        {
          address_name: "NaN 좌표 항목",
          x: "invalid",
          y: "37.2",
        },
      ]);

      expect(mapped).toHaveLength(2);
      expect(mapped[0]).toMatchObject({
        roadAddress: "경기도 수원시 팔달구 매산로 1",
        jibunAddress: "경기도 수원시 팔달구 매산로1가 18",
        lat: 37.2661,
        lng: 127.0011,
        source: "road",
      });
      expect(mapped[1]).toMatchObject({
        roadAddress: "경기도 수원시 팔달구 매산로1가 99",
        jibunAddress: "경기도 수원시 팔달구 매산로1가 99",
        lat: 37.2672,
        lng: 127.0022,
        source: "jibun",
      });
    });

    it("장소 fallback 매핑에서도 유효하지 않은 좌표는 임의로 채우지 않는다", () => {
      const mapped = mapKakaoPlaceToAddressResults([
        {
          id: "p1",
          place_name: "수원시청",
          road_address_name: "경기도 수원시 팔달구 효원로 241",
          address_name: "경기도 수원시 팔달구 인계동 1111",
          x: "127.0286",
          y: "37.2636",
        },
        {
          id: "p2",
          place_name: "잘못된장소",
          road_address_name: "수원시",
          x: "250",
          y: "37.2",
        },
      ]);

      expect(mapped).toHaveLength(1);
      expect(mapped[0].lat).toBe(37.2636);
      expect(mapped[0].lng).toBe(127.0286);
    });
  });

  describe("2. BusinessForm (가게 등록 주소 검색 및 자동 좌표 생성)", () => {
    it("수동 위도·경도 입력란이 존재하지 않으며 도로명주소 선택 시 좌표를 자동 생성해 제출한다", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          business: { id: "biz-1", registration_status: "draft" },
        }),
      } as Response);

      const addressSearchFn = vi.fn().mockResolvedValue([ROAD_RESULT]);
      const onSuccess = vi.fn();

      render(<BusinessForm mode="create" onSuccess={onSuccess} addressSearchFn={addressSearchFn} />);

      // 위도·경도 수동 입력란이 제거되었는지 확인
      expect(screen.queryByLabelText(/위도/)).toBeNull();
      expect(screen.queryByLabelText(/경도/)).toBeNull();
      expect(screen.queryByPlaceholderText(/위도/)).toBeNull();
      expect(screen.queryByPlaceholderText(/경도/)).toBeNull();

      fireEvent.change(screen.getByLabelText(/상호명/), {
        target: { value: "DEMO 테스트 카페" },
      });

      // 주소 검색 및 결과 선택
      fireEvent.change(screen.getByTestId("address-search-input"), {
        target: { value: "매산로 1" },
      });
      fireEvent.click(screen.getByTestId("address-search-button"));

      const resultBtn = await screen.findByTestId("address-search-result-0");
      fireEvent.click(resultBtn);

      expect(screen.getByTestId("address-coords-confirmed")).toBeDefined();
      expect((screen.getByLabelText(/^도로명주소/) as HTMLInputElement).value).toBe(
        ROAD_RESULT.roadAddress
      );
      expect((screen.getByLabelText(/^지번주소/) as HTMLInputElement).value).toBe(
        ROAD_RESULT.jibunAddress
      );

      // 상세주소 별도 입력
      fireEvent.change(screen.getByLabelText(/상세주소/), {
        target: { value: "2층 201호" },
      });

      fireEvent.click(screen.getByTestId("business-form-submit-button"));

      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      const sentBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(sentBody.road_address).toBe(ROAD_RESULT.roadAddress);
      expect(sentBody.jibun_address).toBe(ROAD_RESULT.jibunAddress);
      expect(sentBody.address_detail).toBe("2층 201호");
      expect(sentBody.latitude).toBe(ROAD_RESULT.lat);
      expect(sentBody.longitude).toBe(ROAD_RESULT.lng);
      expect(onSuccess).toHaveBeenCalled();
    });

    it("지번주소 검색 결과 선택 시에도 위도·경도를 자동 생성한다", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          business: { id: "biz-2", registration_status: "draft" },
        }),
      } as Response);

      const addressSearchFn = vi.fn().mockResolvedValue([JIBUN_RESULT]);
      render(<BusinessForm mode="create" onSuccess={vi.fn()} addressSearchFn={addressSearchFn} />);

      fireEvent.change(screen.getByLabelText(/상호명/), {
        target: { value: "DEMO 행궁 상점" },
      });
      fireEvent.change(screen.getByTestId("address-search-input"), {
        target: { value: "남창동 6-2" },
      });
      fireEvent.click(screen.getByTestId("address-search-button"));
      fireEvent.click(await screen.findByTestId("address-search-result-0"));
      fireEvent.click(screen.getByTestId("business-form-submit-button"));

      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      const sentBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(sentBody.latitude).toBe(JIBUN_RESULT.lat);
      expect(sentBody.longitude).toBe(JIBUN_RESULT.lng);
      expect(sentBody.jibun_address).toBe(JIBUN_RESULT.jibunAddress);
    });

    it("주소 변환 실패 시 임의 좌표를 저장하지 않고 등록 제출을 차단한다", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const addressSearchFn = vi
        .fn()
        .mockRejectedValue(new Error("카카오 주소 변환 실패"));

      render(<BusinessForm mode="create" addressSearchFn={addressSearchFn} />);

      fireEvent.change(screen.getByLabelText(/상호명/), {
        target: { value: "DEMO 실패 테스트" },
      });
      fireEvent.change(screen.getByTestId("address-search-input"), {
        target: { value: "알수없는주소" },
      });
      fireEvent.click(screen.getByTestId("address-search-button"));

      expect(await screen.findByTestId("address-search-error")).toBeDefined();
      expect(screen.getByTestId("address-coords-missing")).toBeDefined();

      fireEvent.click(screen.getByTestId("business-form-submit-button"));
      expect(screen.getByTestId("business-form-error")).toBeDefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("3. RestroomForm (제휴 화장실 주소 검색, 층수/상세주소 분리, 공개 위치 잠금)", () => {
    it("수동 위도·경도 입력란이 없으며 도로명주소 선택 + 상세주소·층수 별도 입력 후 제출한다", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          data: { id: "rr-1" },
        }),
      } as Response);

      const addressSearchFn = vi.fn().mockResolvedValue([ROAD_RESULT]);
      render(
        <RestroomForm
          businessId="11111111-1111-4111-8111-111111111111"
          mode="create"
          onSuccess={vi.fn()}
          addressSearchFn={addressSearchFn}
        />
      );

      expect(screen.queryByLabelText(/위도/)).toBeNull();
      expect(screen.queryByLabelText(/경도/)).toBeNull();

      fireEvent.change(screen.getByLabelText(/화장실 이름/), {
        target: { value: "DEMO 제휴 화장실" },
      });
      fireEvent.change(screen.getByTestId("address-search-input"), {
        target: { value: "매산로 1" },
      });
      fireEvent.click(screen.getByTestId("address-search-button"));
      fireEvent.click(await screen.findByTestId("address-search-result-0"));

      fireEvent.change(screen.getByLabelText(/상세주소/), {
        target: { value: "후문 좌측" },
      });
      fireEvent.change(screen.getByLabelText(/층수/), {
        target: { value: "지하 1층" },
      });

      fireEvent.click(screen.getByTestId("restroom-form-submit-button"));

      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      const sentBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(sentBody.road_address).toBe(ROAD_RESULT.roadAddress);
      expect(sentBody.latitude).toBe(ROAD_RESULT.lat);
      expect(sentBody.longitude).toBe(ROAD_RESULT.lng);
      expect(sentBody.address_detail).toBe("후문 좌측");
      expect(sentBody.floor).toBe("지하 1층");
    });

    it("주소 변환 실패/미선택 시 임의 좌표를 저장하지 않는다", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const addressSearchFn = vi.fn().mockResolvedValue([]);

      render(
        <RestroomForm
          businessId="11111111-1111-4111-8111-111111111111"
          mode="create"
          addressSearchFn={addressSearchFn}
        />
      );

      fireEvent.change(screen.getByLabelText(/화장실 이름/), {
        target: { value: "DEMO 화장실" },
      });
      fireEvent.change(screen.getByTestId("address-search-input"), {
        target: { value: "없는주소" },
      });
      fireEvent.click(screen.getByTestId("address-search-button"));

      expect(await screen.findByTestId("address-search-empty")).toBeDefined();
      fireEvent.click(screen.getByTestId("restroom-form-submit-button"));
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("이미 공개된(published) 화장실은 주소 검색을 비활성화하고 기존 위치 변경 제한을 유지한다", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          data: { id: "rr-pub-1" },
        }),
      } as Response);

      render(
        <RestroomForm
          businessId="11111111-1111-4111-8111-111111111111"
          mode="edit"
          publicationStatus="published"
          initialData={{
            id: "rr-pub-1",
            name: "공개 제휴 화장실",
            road_address: "경기도 수원시 팔달구 정조로 825",
            address_detail: "1층",
            floor: "1층",
            latitude: 37.2822,
            longitude: 127.0155,
          }}
        />
      );

      expect(screen.getByTestId("restroom-location-locked-alert")).toBeDefined();
      expect(screen.queryByTestId("address-search-input")).toBeNull();
      expect((screen.getByLabelText(/^도로명주소/) as HTMLInputElement).disabled).toBe(true);

      // 상세주소·층수는 수정 가능하며 PATCH 요청에 좌표/도로명주소는 포함되지 않음
      fireEvent.change(screen.getByLabelText(/층수/), {
        target: { value: "2층" },
      });
      fireEvent.click(screen.getByTestId("restroom-form-submit-button"));

      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      const sentBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(sentBody.floor).toBe("2층");
      expect(sentBody.road_address).toBeUndefined();
      expect(sentBody.latitude).toBeUndefined();
      expect(sentBody.longitude).toBeUndefined();
    });
  });

  describe("4. 서버측 주소·좌표 유효성 검증 스키마", () => {
    it("(0, 0) 임의 좌표와 NaN/Infinity, 쌍이 맞지 않는 좌표 업데이트를 차단한다", () => {
      expect(
        createBusinessSchema.safeParse({
          name: "가게",
          category: "카페",
          road_address: "경기도 수원시 팔달구 매산로 1",
          latitude: 0,
          longitude: 0,
        }).success
      ).toBe(false);

      expect(
        createMerchantRestroomSchema.safeParse({
          business_id: "11111111-1111-4111-8111-111111111111",
          name: "화장실",
          road_address: "경기도 수원시 팔달구 매산로 1",
          latitude: 0,
          longitude: 0,
        }).success
      ).toBe(false);

      expect(
        updateBusinessSchema.safeParse({
          latitude: 37.28,
        }).success
      ).toBe(false);

      expect(
        updateBusinessSchema.safeParse({
          road_address: "경기도 수원시 팔달구 매산로 1",
        }).success
      ).toBe(false);

      expect(
        updateMerchantRestroomSchema.safeParse({
          longitude: 127.01,
        }).success
      ).toBe(false);

      expect(
        updateMerchantRestroomSchema.safeParse({
          road_address: "경기도 수원시 팔달구 매산로 1",
        }).success
      ).toBe(false);
    });
  });
});
