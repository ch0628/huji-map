/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import {
  LatLng,
  MapBounds,
  MapOptions,
  MapProvider,
  MarkerOptions,
  SUWON_DEFAULT_CENTER,
  isValidLatLng,
} from "@/lib/maps/types";
import {
  buildKakaoMapDirectionsUrl,
  buildNaverMapDirectionsUrl,
  buildGoogleMapsDirectionsUrl,
  buildAllDirectionUrls,
} from "@/lib/maps/directions";
import { getCurrentUserLocation } from "@/lib/maps/location";
import {
  KAKAO_SDK_SCRIPT_ID,
  getKakaoMapApiKey,
  isKakaoSdkLoaded,
  loadKakaoMapSdk,
  resetKakaoSdkStateForTesting,
} from "@/lib/maps/kakao-sdk";
import { KakaoMapProvider } from "@/lib/maps/kakao-provider";
import MapCanvas from "@/components/map/MapCanvas";

describe("TASK 15: Map Provider & Kakao SDK Integration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.NEXT_PUBLIC_KAKAO_MAP_JS_KEY;
    resetKakaoSdkStateForTesting();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    delete (window as any).kakao;
  });

  afterEach(() => {
    process.env = originalEnv;
    resetKakaoSdkStateForTesting();
    vi.restoreAllMocks();
  });

  describe("1. WGS84 좌표계 유효성 검증 (isValidLatLng)", () => {
    it("정상 범위의 WGS84 좌표를 올바르게 통과시킨다", () => {
      expect(isValidLatLng({ lat: 37.2635727, lng: 127.0286009 })).toBe(true);
      expect(isValidLatLng({ lat: 0, lng: 0 })).toBe(true);
      expect(isValidLatLng({ lat: -90, lng: -180 })).toBe(true);
      expect(isValidLatLng({ lat: 90, lng: 180 })).toBe(true);
    });

    it("유효하지 않은 좌표(범위 초과, NaN, 무한대, 잘못된 타입)를 안전하게 거부한다", () => {
      expect(isValidLatLng(null)).toBe(false);
      expect(isValidLatLng(undefined)).toBe(false);
      expect(isValidLatLng({})).toBe(false);
      expect(isValidLatLng({ lat: "37.26", lng: "127.02" })).toBe(false);
      expect(isValidLatLng({ lat: 91, lng: 127.02 })).toBe(false);
      expect(isValidLatLng({ lat: -91, lng: 127.02 })).toBe(false);
      expect(isValidLatLng({ lat: 37.26, lng: 181 })).toBe(false);
      expect(isValidLatLng({ lat: 37.26, lng: -181 })).toBe(false);
      expect(isValidLatLng({ lat: NaN, lng: 127.02 })).toBe(false);
      expect(isValidLatLng({ lat: 37.26, lng: Infinity })).toBe(false);
    });
  });

  describe("2. 길찾기 URL 헬퍼 검증 (directions)", () => {
    const target = {
      name: "수원역 화장실",
      coords: { lat: 37.2661, lng: 127.0003 },
    };
    const origin = {
      name: "현재 위치",
      coords: { lat: 37.2635, lng: 127.0286 },
    };

    it("카카오맵 공식 길찾기 URL을 올바른 규격으로 생성한다", () => {
      const singleUrl = buildKakaoMapDirectionsUrl(target);
      expect(singleUrl).toBe(
        `https://map.kakao.com/link/to/${encodeURIComponent("수원역 화장실")},37.2661,127.0003`
      );

      const routeUrl = buildKakaoMapDirectionsUrl(target, origin);
      expect(routeUrl).toBe(
        `https://map.kakao.com/link/to/${encodeURIComponent("수원역 화장실")},37.2661,127.0003/from/${encodeURIComponent("현재 위치")},37.2635,127.0286`
      );
    });

    it("네이버 지도 공식 길찾기 URL을 올바른 파라미터(elng, elat, etext, menu=route)로 생성한다", () => {
      const singleUrl = buildNaverMapDirectionsUrl(target);
      expect(singleUrl).toContain("https://map.naver.com/index.nhn?");
      expect(singleUrl).toContain("elng=127.0003");
      expect(singleUrl).toContain("elat=37.2661");
      expect(singleUrl).toContain("etext=%EC%88%98%EC%9B%90%EC%97%AD+%ED%99%94%EC%9E%A5%EC%8B%A4");
      expect(singleUrl).toContain("menu=route");

      const routeUrl = buildNaverMapDirectionsUrl(target, origin);
      expect(routeUrl).toContain("slng=127.0286");
      expect(routeUrl).toContain("slat=37.2635");
      expect(routeUrl).toContain("stext=%ED%98%84%EC%9E%AC+%EC%9C%84%EC%B9%98");
    });

    it("구글 지도 공식 길찾기 URL을 생성한다", () => {
      const singleUrl = buildGoogleMapsDirectionsUrl(target);
      expect(singleUrl).toBe("https://www.google.com/maps/dir/?api=1&destination=37.2661%2C127.0003");

      const routeUrl = buildGoogleMapsDirectionsUrl(target, origin);
      expect(routeUrl).toBe(
        "https://www.google.com/maps/dir/?api=1&destination=37.2661%2C127.0003&origin=37.2635%2C127.0286"
      );
    });

    it("3사 길찾기 링크를 한 번에 생성할 수 있다", () => {
      const urls = buildAllDirectionUrls(target, origin);
      expect(urls.kakao).toContain("map.kakao.com");
      expect(urls.naver).toContain("map.naver.com");
      expect(urls.google).toContain("google.com/maps");
    });

    it("유효하지 않은 좌표 제공 시 예외를 던진다", () => {
      expect(() =>
        buildKakaoMapDirectionsUrl({ name: "오류", coords: { lat: 999, lng: 0 } })
      ).toThrow("Invalid target coordinates");
    });
  });

  describe("3. 브라우저 위치 권한 및 Geolocation 안전 처리 (location)", () => {
    it("Geolocation 미지원 브라우저 환경에서 충돌 없이 실패 결과와 기본 좌표를 반환한다", async () => {
      // navigator.geolocation 비활성화
      const originalGeo = (navigator as any).geolocation;
      delete (navigator as any).geolocation;

      const result = await getCurrentUserLocation();
      expect(result.success).toBe(false);
      expect(result.coords).toEqual(SUWON_DEFAULT_CENTER);
      expect(result.error?.code).toBe("UNSUPPORTED");

      (navigator as any).geolocation = originalGeo;
    });

    it("사용자가 위치 권한을 거부한 경우(PERMISSION_DENIED) 충돌 없이 안전하게 처리한다", async () => {
      (navigator as any).geolocation = {
        getCurrentPosition: vi.fn((_success, error) => {
          error({
            code: 1, // PERMISSION_DENIED
            PERMISSION_DENIED: 1,
            POSITION_UNAVAILABLE: 2,
            TIMEOUT: 3,
            message: "User denied Geolocation",
          });
        }),
      };

      const result = await getCurrentUserLocation();
      expect(result.success).toBe(false);
      expect(result.coords).toEqual(SUWON_DEFAULT_CENTER);
      expect(result.error?.code).toBe("PERMISSION_DENIED");
      expect(result.error?.message).toContain("접근 권한이 거부되었습니다");
    });

    it("위치 정보 확인 성공 시 정상 WGS84 좌표를 반환한다", async () => {
      (navigator as any).geolocation = {
        getCurrentPosition: vi.fn((success) => {
          success({
            coords: {
              latitude: 37.2635,
              longitude: 127.0286,
              accuracy: 10,
            },
          });
        }),
      };

      const result = await getCurrentUserLocation();
      expect(result.success).toBe(true);
      expect(result.coords.lat).toBe(37.2635);
      expect(result.coords.lng).toBe(127.0286);
      expect(result.error).toBeUndefined();
    });
  });

  describe("4. 카카오 SDK 로더 동작 및 중복 방지 (kakao-sdk)", () => {
    it("키가 설정되지 않은 경우 getKakaoMapApiKey는 null을 반환하고 로드는 실패한다", async () => {
      expect(getKakaoMapApiKey()).toBeNull();
      await expect(loadKakaoMapSdk()).rejects.toThrow(
        "NEXT_PUBLIC_KAKAO_MAP_JS_KEY 환경변수가 설정되지 않았습니다"
      );
      expect(document.getElementById(KAKAO_SDK_SCRIPT_ID)).toBeNull();
    });

    it("유효한 키가 주어졌을 때 스크립트 태그를 생성하고 중복 주입을 방지한다", async () => {
      const mockKey = "test-kakao-javascript-key-1234";

      const loadPromise = loadKakaoMapSdk(mockKey);
      const scriptTag = document.getElementById(KAKAO_SDK_SCRIPT_ID) as HTMLScriptElement;

      expect(scriptTag).not.toBeNull();
      expect(scriptTag.src).toContain(mockKey);
      expect(scriptTag.src).toContain("autoload=false");

      // 동일한 시점에 두 번째 로드 호출 시 동일한 프로미스 반환
      const secondPromise = loadKakaoMapSdk(mockKey);
      expect(secondPromise).toBe(loadPromise);

      // DOM에 스크립트 태그가 1개만 존재하는지 확인
      expect(document.querySelectorAll(`script#${KAKAO_SDK_SCRIPT_ID}`).length).toBe(1);

      // 모킹된 SDK 객체 준비 및 load 트리거
      (window as any).kakao = {
        maps: {
          load: vi.fn((cb) => {
            (window as any).kakao.maps.Map = vi.fn();
            cb();
          }),
        },
      };

      scriptTag.dispatchEvent(new Event("load"));

      const loadedKakao = await loadPromise;
      expect(loadedKakao).toBe((window as any).kakao);
      expect(isKakaoSdkLoaded()).toBe(true);
    });

    it("스크립트 로드 실패 시 script 태그를 정리하고 reject한다", async () => {
      const mockKey = "test-failing-key";
      const loadPromise = loadKakaoMapSdk(mockKey);
      const scriptTag = document.getElementById(KAKAO_SDK_SCRIPT_ID) as HTMLScriptElement;

      expect(scriptTag).not.toBeNull();
      scriptTag.dispatchEvent(new Event("error"));

      await expect(loadPromise).rejects.toThrow("Failed to load Kakao Maps SDK script.");
      // 실패 시 태그 정리 확인
      expect(document.getElementById(KAKAO_SDK_SCRIPT_ID)).toBeNull();
    });
  });

  describe("5. KakaoMapProvider 계약 및 마커/이벤트 추적 (KakaoMapProvider)", () => {
    let mockKakao: any;

    beforeEach(() => {
      const eventListeners = new Map<string, Array<(...args: any[]) => void>>();

      mockKakao = {
        maps: {
          load: vi.fn((cb) => cb()),
          LatLng: vi.fn().mockImplementation(function (this: any, lat: number, lng: number) {
            return {
              getLat: () => lat,
              getLng: () => lng,
            };
          }),
          LatLngBounds: vi.fn().mockImplementation(function (this: any, sw: any, ne: any) {
            return {
              getSouthWest: () => sw,
              getNorthEast: () => ne,
            };
          }),
          Map: vi.fn().mockImplementation(function (this: any, container: any, options: any) {
            let center = options.center;
            let level = options.level;
            return {
              getCenter: vi.fn(() => center),
              setCenter: vi.fn((c) => {
                center = c;
              }),
              panTo: vi.fn((c) => {
                center = c;
              }),
              getLevel: vi.fn(() => level),
              setLevel: vi.fn((l) => {
                level = l;
              }),
              getBounds: vi.fn(() => ({
                getSouthWest: () => ({ getLat: () => 37.2, getLng: () => 127.0 }),
                getNorthEast: () => ({ getLat: () => 37.3, getLng: () => 127.1 }),
              })),
              setBounds: vi.fn(),
              setMinLevel: vi.fn(),
              setMaxLevel: vi.fn(),
              relayout: vi.fn(),
            };
          }),
          Marker: vi.fn().mockImplementation(function (this: any, options: any) {
            let currentMap = options.map;
            return {
              setMap: vi.fn((m) => {
                currentMap = m;
              }),
              getMap: () => currentMap,
              getPosition: () => options.position,
              getTitle: () => options.title,
            };
          }),
          event: {
            addListener: vi.fn((target, type, handler) => {
              if (!eventListeners.has(type)) eventListeners.set(type, []);
              eventListeners.get(type)!.push(handler);
            }),
            removeListener: vi.fn((target, type, handler) => {
              const list = eventListeners.get(type);
              if (list) {
                const idx = list.indexOf(handler);
                if (idx >= 0) list.splice(idx, 1);
              }
            }),
          },
        },
      };

      (window as any).kakao = mockKakao;
    });

    it("초기화 전 메소드 호출 시 예외를 던진다", () => {
      const provider = new KakaoMapProvider();
      expect(() => provider.getCenter()).toThrow("KakaoMapProvider is not initialized");
      expect(() => provider.getZoomLevel()).toThrow("KakaoMapProvider is not initialized");
    });

    it("정상 초기화 후 중심 좌표, 줌 레벨, 가시 영역을 올바르게 제어한다", async () => {
      const provider = new KakaoMapProvider();
      const container = document.createElement("div");

      await provider.init(container, {
        center: { lat: 37.26, lng: 127.02 },
        zoomLevel: 3,
      });

      expect(provider.name).toBe("kakao");
      expect(provider.getCenter()).toEqual({ lat: 37.26, lng: 127.02 });
      expect(provider.getZoomLevel()).toBe(3);

      provider.setCenter({ lat: 37.27, lng: 127.03 });
      expect(provider.getCenter()).toEqual({ lat: 37.27, lng: 127.03 });

      provider.setZoomLevel(4);
      expect(provider.getZoomLevel()).toBe(4);

      const bounds = provider.getBounds();
      expect(bounds.south).toBe(37.2);
      expect(bounds.north).toBe(37.3);
      expect(bounds.west).toBe(127.0);
      expect(bounds.east).toBe(127.1);
    });

    it("마커 추가, 개별 제거, 일괄 제거 및 클릭 리스너를 정상 처리한다", async () => {
      const provider = new KakaoMapProvider();
      const container = document.createElement("div");

      await provider.init(container, {
        center: { lat: 37.26, lng: 127.02 },
        zoomLevel: 3,
      });

      const clickSpy = vi.fn();
      const markers: MarkerOptions[] = [
        {
          id: "m-1",
          position: { lat: 37.261, lng: 127.021 },
          title: "공공화장실 1",
          type: "public",
          onClick: clickSpy,
        },
        {
          id: "m-2",
          position: { lat: 37.262, lng: 127.022 },
          title: "제휴화장실 2",
          type: "partner",
        },
      ];

      provider.setMarkers(markers);
      expect(mockKakao.maps.Marker).toHaveBeenCalledTimes(2);

      // 개별 마커 제거
      provider.removeMarker("m-1");
      // 전체 마커 제거
      provider.clearMarkers();
      // destroy 호출 시 안전하게 정리
      provider.destroy();
    });
  });

  describe("6. MapCanvas 컴포넌트 렌더링 및 상태 처리", () => {
    it("API 키가 없을 때 '지도 연동 설정 필요' 배너와 설정 가이드를 표시한다", async () => {
      render(React.createElement(MapCanvas));

      const banner = await screen.findByTestId("map-missing-key-banner");
      expect(banner).toBeDefined();
      expect(screen.getByText("지도 연동 설정 필요")).toBeDefined();
      expect(
        screen.getByText(/카카오 지도 JavaScript API 키가 설정되지 않았습니다/)
      ).toBeDefined();
      expect(screen.getByText("NEXT_PUBLIC_KAKAO_MAP_JS_KEY")).toBeDefined();
      expect(screen.getByText(/안전 모드 \(가짜 지도 생성 방지됨\)/)).toBeDefined();
    });

    it("커스텀 providerFactory를 주입받아 모킹 지도 엔진을 성공적으로 로드한다", async () => {
      const mockDestroy = vi.fn();
      const mockSetMarkers = vi.fn();
      const mockInit = vi.fn().mockResolvedValue(undefined);

      const mockProvider: MapProvider = {
        name: "mock-provider",
        init: mockInit,
        getCenter: () => ({ lat: 37.26, lng: 127.02 }),
        setCenter: vi.fn(),
        getZoomLevel: () => 3,
        setZoomLevel: vi.fn(),
        getBounds: () => ({ south: 37.2, west: 127.0, north: 37.3, east: 127.1 }),
        fitBounds: vi.fn(),
        setMarkers: mockSetMarkers,
        addMarker: vi.fn(),
        removeMarker: vi.fn(),
        clearMarkers: vi.fn(),
        relayout: vi.fn(),
        destroy: mockDestroy,
      };

      const readySpy = vi.fn();
      const { unmount } = render(
        React.createElement(MapCanvas, {
          providerFactory: () => mockProvider,
          onMapReady: readySpy,
          markers: [
            { id: "test-m1", position: { lat: 37.26, lng: 127.02 }, title: "테스트 마커" },
          ],
        })
      );

      await waitFor(() => {
        expect(mockInit).toHaveBeenCalled();
        expect(readySpy).toHaveBeenCalledWith(mockProvider);
        expect(mockSetMarkers).toHaveBeenCalled();
      });

      // 언마운트 시 destroy 호출 검증
      unmount();
      expect(mockDestroy).toHaveBeenCalled();
    });

    it("지도 초기화 중 에러가 발생하면 에러 배너와 다시 시도 버튼을 표시한다", async () => {
      const failingProvider: MapProvider = {
        name: "failing-provider",
        init: vi.fn().mockRejectedValue(new Error("네트워크 연결 실패")),
        getCenter: () => ({ lat: 0, lng: 0 }),
        setCenter: vi.fn(),
        getZoomLevel: () => 1,
        setZoomLevel: vi.fn(),
        getBounds: () => ({ south: 0, west: 0, north: 0, east: 0 }),
        fitBounds: vi.fn(),
        setMarkers: vi.fn(),
        addMarker: vi.fn(),
        removeMarker: vi.fn(),
        clearMarkers: vi.fn(),
        relayout: vi.fn(),
        destroy: vi.fn(),
      };

      render(
        React.createElement(MapCanvas, {
          providerFactory: () => failingProvider,
        })
      );

      const errorBanner = await screen.findByTestId("map-error-banner");
      expect(errorBanner).toBeDefined();
      expect(screen.getByText("지도를 불러오지 못했습니다")).toBeDefined();
      expect(screen.getByText("네트워크 연결 실패")).toBeDefined();
      expect(screen.getByText("다시 시도")).toBeDefined();
    });
  });
});
