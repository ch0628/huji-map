/**
 * @vitest-environment jsdom
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import MapDiscoveryClient from "@/components/map/MapDiscoveryClient";
import type { MapProvider } from "@/lib/maps/types";
import type { PlaceSearchResult } from "@/lib/maps/place-search";
import { mapKakaoPlaces } from "@/lib/maps/place-search";
import {
  formatDistance,
  haversineMeters,
  isInServiceArea,
} from "@/lib/maps/geo";
import { getMarkerIcon } from "@/lib/maps/marker-icons";
import type { PublicRestroomSummary } from "@/lib/restrooms/types";

const base = {
  address_detail: null,
  access_method: "open",
  gender_type: "separate",
  wheelchair_accessible: true,
  baby_changing_available: false,
  sanitary_products_available: false,
  last_verified_at: null,
  business_id: null,
} as const;

const FAR: PublicRestroomSummary = {
  ...base,
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  type: "public",
  name: "DEMO 먼 화장실",
  road_address: "DEMO 주소 1",
  latitude: 37.2882,
  longitude: 127.0145,
} as PublicRestroomSummary;

const NEAR: PublicRestroomSummary = {
  ...base,
  id: "bbbbbbbb-0000-4000-8000-000000000002",
  type: "public",
  name: "DEMO 가까운 화장실",
  road_address: "DEMO 주소 2",
  latitude: 37.2831,
  longitude: 127.0162,
} as PublicRestroomSummary;

const SUWON_STATION: PlaceSearchResult = {
  id: "p1",
  name: "수원역 1호선",
  address: "경기 수원시 팔달구 덕영대로 924",
  category: "지하철역",
  lat: 37.2831,
  lng: 127.0162,
};
const YATAP: PlaceSearchResult = {
  id: "p2",
  name: "야탑역 분당선",
  address: "경기 성남시 분당구 야탑동",
  category: "지하철역",
  lat: 37.4113,
  lng: 127.1288,
};

const createProvider = (): MapProvider & {
  setCenter: ReturnType<typeof vi.fn>;
  setMarkers: ReturnType<typeof vi.fn>;
} =>
  ({
    name: "mock",
    init: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    getCenter: vi.fn().mockReturnValue({ lat: 37.2635, lng: 127.0286 }),
    setCenter: vi.fn(),
    getZoomLevel: vi.fn().mockReturnValue(3),
    setZoomLevel: vi.fn(),
    getBounds: vi
      .fn()
      .mockReturnValue({ south: 37.25, west: 127.01, north: 37.27, east: 127.03 }),
    fitBounds: vi.fn(),
    setMarkers: vi.fn(),
    addMarker: vi.fn(),
    removeMarker: vi.fn(),
    clearMarkers: vi.fn(),
    relayout: vi.fn(),
  }) as any;

function mockFetch(searchableRestrooms: PublicRestroomSummary[] = []) {
  const fn = vi.fn().mockImplementation(async (url: string) => {
    if (url.includes("/api/v1/restrooms/search")) {
      const q = decodeURIComponent(url.split("q=")[1]?.split("&")[0] ?? "").toLowerCase();
      const matched = searchableRestrooms.filter((r) =>
        r.name.toLowerCase().includes(q)
      );
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: { items: matched, total: matched.length, limit: 10 },
        }),
      };
    }
    const parsedUrl = new URL(url, "http://localhost");
    const centerLat = Number(parsedUrl.searchParams.get("centerLat"));
    const inSuwon = centerLat > 37.2 && centerLat < 37.35;
    const items = inSuwon ? [FAR, NEAR] : [];
    return {
      ok: true,
      json: async () => ({
        ok: true,
        data: { items, total: items.length, limit: 100, offset: 0 },
      }),
    };
  });
  global.fetch = fn as any;
  return fn;
}

const nearbyFetchCalls = (fn: ReturnType<typeof mockFetch>) =>
  fn.mock.calls.filter(([u]) => String(u).includes("centerLat="));

describe("지역·장소 검색 유틸", () => {
  it("거리 계산·표시 형식", () => {
    expect(
      Math.round(
        haversineMeters({ lat: 37.2831, lng: 127.0162 }, { lat: 37.2831, lng: 127.0162 })
      )
    ).toBe(0);
    const d = haversineMeters(
      { lat: 37.2831, lng: 127.0162 },
      { lat: 37.2882, lng: 127.0145 }
    );
    expect(d).toBeGreaterThan(500);
    expect(d).toBeLessThan(700);
    expect(formatDistance(350)).toBe("350m");
    expect(formatDistance(1530)).toBe("1.5km");
  });

  it("수원 서비스 지역 판별: 수원역 포함 / 야탑역 제외", () => {
    expect(isInServiceArea({ lat: SUWON_STATION.lat, lng: SUWON_STATION.lng })).toBe(true);
    expect(isInServiceArea({ lat: YATAP.lat, lng: YATAP.lng })).toBe(false);
  });

  it("카카오 장소 응답 매핑 (좌표 오류 항목 제외)", () => {
    const out = mapKakaoPlaces([
      { id: "1", place_name: "수원역", road_address_name: "도로명", address_name: "지번", category_group_name: "지하철역", x: "127.0", y: "37.2" },
      { id: "2", place_name: "나쁜좌표", x: "abc", y: "37" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: "수원역", address: "도로명", lat: 37.2, lng: 127.0 });
  });

  it("마커 아이콘: 현재 위치(점), 검색 장소(초록 핀), 공공/제휴 화장실 핀을 구분한다", () => {
    const me = getMarkerIcon("current_location")!;
    const pub = getMarkerIcon("public")!;
    const partner = getMarkerIcon("partner")!;
    const searchPlace = getMarkerIcon("search_place")!;
    const sel = getMarkerIcon("public", true)!;
    const dec = (s: string) => decodeURIComponent(s);
    expect(dec(me.src)).toContain("<circle");
    expect(dec(me.src)).not.toContain("<path");
    expect(dec(me.src)).toContain("#ffffff");
    expect(dec(pub.src)).toContain("<path");
    expect(dec(pub.src)).toContain("#2563eb");
    expect(dec(partner.src)).toContain("#7e22ce");
    expect(dec(searchPlace.src)).toContain("<path");
    expect(dec(searchPlace.src)).toContain("#16a34a");
    expect(dec(searchPlace.src)).not.toContain("WC");
    expect(sel.height).toBeGreaterThan(pub.height);
    expect(dec(sel.src)).toContain("#f59e0b");
    expect(getMarkerIcon("default")).toBeNull();
  });
});

describe("MapDiscoveryClient 지역·장소 검색", () => {
  let provider: ReturnType<typeof createProvider>;
  let fetchMock: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    provider = createProvider();
    fetchMock = mockFetch();
  });

  const renderClient = (
    placeSearchFn: any,
    restroomSearchFn?: any
  ) =>
    render(
      <MapDiscoveryClient
        providerFactory={() => provider}
        placeSearchFn={placeSearchFn}
        restroomSearchFn={restroomSearchFn}
      />
    );

  // 지도 초기화 직후 디바운스된 초기 조회가 끝날 때까지 대기 (기준선 안정화)
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 700)); });

  const type = (v: string) =>
    fireEvent.change(screen.getByTestId("map-search-input"), { target: { value: v } });

  it("안내 문구가 장소·화장실 이름 검색이다", async () => {
    renderClient(vi.fn());
    const input = screen.getByTestId("map-search-input") as HTMLInputElement;
    expect(input.placeholder).toBe("장소 또는 화장실 이름 검색 (예: 수원역, 장안문)");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it("입력 중에는 지도 이동·재조회 없이 결과만 표시하고, 선택 시 이동·초록 마커 표시·재조회한다", async () => {
    const search = vi.fn().mockResolvedValue([SUWON_STATION, YATAP]);
    renderClient(search, vi.fn().mockResolvedValue([]));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(provider.init).toHaveBeenCalled());
    await settle();
    const fetchesBefore = nearbyFetchCalls(fetchMock).length;
    const centerCallsBefore = provider.setCenter.mock.calls.length;

    type("수원역");
    await waitFor(() => expect(screen.getByTestId("place-search-results")).toBeDefined());
    await waitFor(() => expect(screen.getByTestId("place-result-p1")).toBeDefined());
    expect(search).toHaveBeenCalledWith("수원역");
    // 결과 선택 전: 이동 및 주변 화장실 재조회 없음
    expect(provider.setCenter.mock.calls.length).toBe(centerCallsBefore);
    expect(nearbyFetchCalls(fetchMock).length).toBe(fetchesBefore);

    fireEvent.click(screen.getByTestId("place-result-p1"));
    await waitFor(() =>
      expect(provider.setCenter).toHaveBeenCalledWith(
        { lat: SUWON_STATION.lat, lng: SUWON_STATION.lng },
        true
      )
    );
    await waitFor(() =>
      expect(nearbyFetchCalls(fetchMock).length).toBe(fetchesBefore + 1)
    );
    const lastUrl = new URL(
      nearbyFetchCalls(fetchMock).at(-1)![0] as string,
      "http://localhost"
    );
    expect(Number(lastUrl.searchParams.get("centerLat"))).toBeCloseTo(
      SUWON_STATION.lat,
      6
    );
    expect(Number(lastUrl.searchParams.get("centerLng"))).toBeCloseTo(
      SUWON_STATION.lng,
      6
    );
    expect(lastUrl.searchParams.get("bbox")).toBeNull();
    expect(screen.queryByTestId("place-search-results")).toBeNull();
    expect(screen.queryByTestId("out-of-service-banner")).toBeNull();

    // 선택한 장소에 초록색 전용 마커(search_place)가 표시되고 기존 공공/제휴 마커는 유지된다
    const latestMarkers = provider.setMarkers.mock.calls.at(-1)?.[0] ?? [];
    const anchorMarker = latestMarkers.find(
      (m: any) => m.id === "search_place_anchor"
    );
    expect(anchorMarker).toMatchObject({
      type: "search_place",
      title: SUWON_STATION.name,
      position: { lat: SUWON_STATION.lat, lng: SUWON_STATION.lng },
    });
    expect(latestMarkers.some((m: any) => m.type === "public")).toBe(true);

    // 목록이 검색 장소에서 가까운 순 + 거리 표시
    fireEvent.click(screen.getByTestId("bottom-sheet-toggle-btn"));
    const cards = await screen.findAllByTestId(/^public-restroom-card-/);
    expect(cards[0].getAttribute("data-testid")).toContain(NEAR.id);
    expect(cards[1].getAttribute("data-testid")).toContain(FAR.id);
    expect(screen.getByTestId(`restroom-distance-${NEAR.id}`).textContent).toMatch(/0m|\d+m/);
    expect(screen.getByTestId("bottom-sheet-sort-basis").textContent).toContain("수원역 1호선 기준");
  });

  it("카카오 장소 검색 결과와 휴지맵 화장실 이름 검색 결과를 구분 표시하고 화장실 선택 시 해당 위치로 이동한다", async () => {
    const partnerHit: PublicRestroomSummary = {
      ...base,
      id: "cccccccc-0000-4000-8000-000000000003",
      type: "partner",
      name: "수원역 제휴 카페 화장실",
      road_address: "경기도 수원시 팔달구 매산로 10",
      latitude: 37.2661,
      longitude: 127.0012,
      business_id: "dddddddd-0000-4000-8000-000000000004",
      business_name: "DEMO 카페",
      access_mode: "test_deposit",
      deposit_amount_krw: 1000,
    };
    const placeSearch = vi.fn().mockResolvedValue([SUWON_STATION]);
    const restroomSearch = vi.fn().mockResolvedValue([NEAR, partnerHit]);

    renderClient(placeSearch, restroomSearch);
    await waitFor(() => expect(provider.init).toHaveBeenCalled());
    await settle();

    type("수원");
    await waitFor(() =>
      expect(screen.getByTestId("search-section-restrooms")).toBeDefined()
    );
    expect(screen.getByTestId("search-section-places")).toBeDefined();
    expect(screen.getByTestId(`restroom-search-result-${NEAR.id}`)).toBeDefined();
    expect(screen.getByTestId(`restroom-search-result-${partnerHit.id}`)).toBeDefined();
    expect(screen.getByTestId("place-result-p1")).toBeDefined();

    // 휴지맵 제휴 화장실 검색 결과 선택
    fireEvent.click(screen.getByTestId(`restroom-search-result-${partnerHit.id}`));
    await waitFor(() =>
      expect(provider.setCenter).toHaveBeenCalledWith(
        { lat: partnerHit.latitude, lng: partnerHit.longitude },
        true
      )
    );
    expect(screen.getByTestId("map-bottom-sheet-selected")).toBeDefined();
    expect(screen.getByText("수원역 제휴 카페 화장실")).toBeDefined();
    // 화장실 직접 선택 시 초록 장소 마커는 남지 않고 해당 화장실 마커가 선택 상태가 됨
    const latestMarkers = provider.setMarkers.mock.calls.at(-1)?.[0] ?? [];
    expect(latestMarkers.find((m: any) => m.id === "search_place_anchor")).toBeUndefined();
    expect(
      latestMarkers.find((m: any) => m.id === partnerHit.id)?.selected
    ).toBe(true);
  });

  it("수원시 밖 장소도 제한 배너 없이 해당 좌표 기준으로 주변 화장실을 조회한다", async () => {
    renderClient(vi.fn().mockResolvedValue([YATAP]), vi.fn().mockResolvedValue([]));
    await waitFor(() => expect(provider.init).toHaveBeenCalled());
    const fetchesBefore = nearbyFetchCalls(fetchMock).length;

    type("야탑역");
    fireEvent.click(await screen.findByTestId("place-result-p2"));

    await waitFor(() =>
      expect(provider.setCenter).toHaveBeenCalledWith(
        { lat: YATAP.lat, lng: YATAP.lng },
        true
      )
    );
    await waitFor(() =>
      expect(nearbyFetchCalls(fetchMock).length).toBe(fetchesBefore + 1)
    );
    const lastUrl = new URL(
      nearbyFetchCalls(fetchMock).at(-1)![0] as string,
      "http://localhost"
    );
    expect(Number(lastUrl.searchParams.get("centerLat"))).toBeCloseTo(YATAP.lat, 6);
    expect(Number(lastUrl.searchParams.get("centerLng"))).toBeCloseTo(YATAP.lng, 6);
    expect(screen.queryByTestId("out-of-service-banner")).toBeNull();
  });

  it("결과가 없으면 안내하고 기존 지도 마커는 유지한다", async () => {
    renderClient(vi.fn().mockResolvedValue([]), vi.fn().mockResolvedValue([]));
    await waitFor(() => expect(provider.setMarkers).toHaveBeenCalled());
    await settle();
    const markerCalls = provider.setMarkers.mock.calls.length;
    const fetches = nearbyFetchCalls(fetchMock).length;
    type("존재하지않는장소zzz");
    expect((await screen.findByTestId("place-search-empty")).textContent).toContain("검색 결과가 없습니다");
    expect(provider.setMarkers.mock.calls.length).toBe(markerCalls);
    expect(nearbyFetchCalls(fetchMock).length).toBe(fetches);
  });

  it("검색 실패 시 오류를 표시하되 기존 화장실 데이터는 보존한다", async () => {
    renderClient(vi.fn().mockRejectedValue(new Error("boom")));
    await waitFor(() => expect(screen.getByTestId("map-bottom-sheet-drawer")).toBeDefined());
    await waitFor(() =>
      expect(screen.getByTestId("map-bottom-sheet-drawer").textContent).toContain("이 지역 화장실 2곳")
    );
    type("수원역");
    expect(await screen.findByTestId("place-search-error")).toBeDefined();
    expect(screen.getByTestId("map-bottom-sheet-drawer").textContent).toContain("이 지역 화장실 2곳");
  });

  it("검색어를 지우면 결과만 닫히고 지도는 그대로다", async () => {
    renderClient(vi.fn().mockResolvedValue([SUWON_STATION]));
    await waitFor(() => expect(provider.init).toHaveBeenCalled());
    await settle();
    const centers = provider.setCenter.mock.calls.length;
    type("수원역");
    await screen.findByTestId("place-result-p1");
    fireEvent.click(screen.getByTestId("map-search-clear-btn"));
    await waitFor(() => expect(screen.queryByTestId("place-search-results")).toBeNull());
    expect(provider.setCenter.mock.calls.length).toBe(centers);
  });

  it("빠른 연속 검색에서 이전(느린) 응답이 최신 결과를 덮어쓰지 않는다", async () => {
    let resolveSlow: (v: PlaceSearchResult[]) => void = () => {};
    const slow = new Promise<PlaceSearchResult[]>((r) => (resolveSlow = r));
    const search = vi.fn().mockImplementation((q: string) =>
      q === "수원" ? slow : Promise.resolve([SUWON_STATION])
    );
    renderClient(search);
    await waitFor(() => expect(provider.init).toHaveBeenCalled());

    type("수원");
    await waitFor(() => expect(search).toHaveBeenCalledWith("수원"));
    type("수원역");
    await screen.findByTestId("place-result-p1");

    await act(async () => {
      resolveSlow([YATAP]);
      await Promise.resolve();
    });
    expect(screen.queryByTestId("place-result-p2")).toBeNull();
    expect(screen.getByTestId("place-result-p1")).toBeDefined();
  });
});
