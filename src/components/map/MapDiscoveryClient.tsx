"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  LatLng,
  MapBounds,
  MapProvider,
  MarkerOptions,
  SUWON_DEFAULT_CENTER,
  DEFAULT_ZOOM_LEVEL,
} from "@/lib/maps/types";
import { getCurrentUserLocation } from "@/lib/maps/location";
import type { PublicRestroomSummary } from "@/lib/restrooms/types";
import MapCanvas from "./MapCanvas";
import MapFilterBar, { RestroomFilterType } from "./MapFilterBar";
import MapBottomSheet from "./MapBottomSheet";
import MapDirectionsModal from "./MapDirectionsModal";
import PlaceSearchResults, { PlaceSearchStatus } from "./PlaceSearchResults";
import { searchKakaoPlaces } from "@/lib/maps/place-search";
import type { PlaceSearchFn, PlaceSearchResult } from "@/lib/maps/place-search";
import {
  OUT_OF_SERVICE_MESSAGE,
  bboxAround,
  boundsCenter,
  haversineMeters,
  isInServiceArea,
} from "@/lib/maps/geo";
import { useVisitorSession, useEventTracker } from "@/lib/events/hooks";

const SUWON_DEFAULT_BOUNDS: MapBounds = {
  south: 37.24,
  west: 126.98,
  north: 37.31,
  east: 127.06,
};

export interface MapDiscoveryClientProps {
  readonly initialRestroomId?: string;
  readonly initialFilterType?: RestroomFilterType;
  /** 테스트 및 커스텀 공급자 주입 지원 */
  readonly providerFactory?: () => MapProvider;
  readonly onRestroomsLoaded?: (items: PublicRestroomSummary[]) => void;
  /** 장소 검색 함수 주입 (기본: 카카오 장소 검색) */
  readonly placeSearchFn?: PlaceSearchFn;
}

type AnchorMode = "search" | "user" | "center";

const SEARCH_DEBOUNCE_MS = 350;
/** 프로그래밍 이동 직후 애니메이션 중 bounds 이벤트를 수동 이동으로 오인하지 않는 시간 */
const PROGRAMMATIC_MOVE_GRACE_MS = 1500;
/** 이 거리 이상 지도 중심이 벗어나면 사용자가 직접 이동한 것으로 간주 */
const MANUAL_PAN_THRESHOLD_M = 400;

export default function MapDiscoveryClient({
  initialRestroomId,
  initialFilterType = "all",
  providerFactory,
  onRestroomsLoaded,
  placeSearchFn = searchKakaoPlaces,
}: MapDiscoveryClientProps) {
  const [center, setCenter] = useState<LatLng>(SUWON_DEFAULT_CENTER);
  const [zoomLevel, setZoomLevel] = useState<number>(DEFAULT_ZOOM_LEVEL);
  const [bounds, setBounds] = useState<MapBounds | null>(null);

  const [filterType, setFilterType] =
    useState<RestroomFilterType>(initialFilterType);
  const [searchKeyword, setSearchKeyword] = useState<string>("");

  const [rawRestrooms, setRawRestrooms] = useState<PublicRestroomSummary[]>([]);
  const [selectedRestroomId, setSelectedRestroomId] = useState<string | null>(
    initialRestroomId ?? null
  );

  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [apiError, setApiError] = useState<string | null>(null);

  const [isLocating, setIsLocating] = useState<boolean>(false);
  const [userLocation, setUserLocation] = useState<LatLng | null>(null);
  const [locationNotice, setLocationNotice] = useState<string | null>(null);

  const [isSheetExpanded, setIsSheetExpanded] = useState<boolean>(false);
  const [directionsTarget, setDirectionsTarget] =
    useState<PublicRestroomSummary | null>(null);

  // 지역/장소 검색 상태
  const [searchResults, setSearchResults] = useState<PlaceSearchResult[]>([]);
  const [searchStatus, setSearchStatus] = useState<PlaceSearchStatus>("idle");
  const [searchAnchor, setSearchAnchor] = useState<{
    name: string;
    point: LatLng;
  } | null>(null);
  const [anchorMode, setAnchorMode] = useState<AnchorMode>("center");
  const [viewCenter, setViewCenter] = useState<LatLng | null>(null);

  const searchSeqRef = useRef(0);
  const searchTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastMoveRef = useRef<{ point: LatLng; at: number }>({
    point: SUWON_DEFAULT_CENTER,
    at: 0,
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const mapProviderRef = useRef<MapProvider | null>(null);

  // 방문자 세션 초기화 및 이벤트 추적기 연동
  useVisitorSession();
  const {
    trackLandingView,
    trackMapLoaded,
    trackMarkerClicked,
    trackCardViewed,
    trackDetailOpened,
    trackDirectionsClicked,
    trackPaymentButtonClicked,
    trackPaymentUnavailableShown,
  } = useEventTracker();

  // 최초 마운트 시 landing_view 이벤트 기록
  useEffect(() => {
    trackLandingView();
  }, [trackLandingView]);

  // 최초 마운트 시 기본 수원 권역 화장실 목록 조회
  useEffect(() => {
    fetchRestrooms(SUWON_DEFAULT_BOUNDS, filterType);

    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // BBox 기반 화장실 목록 API 요청
  const fetchRestrooms = useCallback(
    async (targetBounds: MapBounds, targetType: RestroomFilterType) => {
      // 진행 중인 이전 요청 취소
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setIsLoading(true);
      setApiError(null);

      try {
        const bboxParam = `${targetBounds.south},${targetBounds.west},${targetBounds.north},${targetBounds.east}`;
        const PAGE_SIZE = 100;
        const MAX_PAGES = 10; // 안전 상한 (최대 1,000건)
        const collected: PublicRestroomSummary[] = [];
        let total = Infinity;

        for (
          let page = 0;
          page < MAX_PAGES && collected.length < total;
          page++
        ) {
          const url = `/api/v1/restrooms?bbox=${encodeURIComponent(
            bboxParam
          )}&type=${targetType}&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`;
          const res = await fetch(url, { signal: controller.signal });
          if (!res.ok) {
            throw new Error(`API 응답 오류: ${res.status}`);
          }
          const json = await res.json();
          if (!(json.ok && json.data)) {
            throw new Error(json.error?.message || "화장실 목록 조회 실패");
          }
          const pageItems: PublicRestroomSummary[] = json.data.items ?? [];
          collected.push(...pageItems);
          total = typeof json.data.total === "number" ? json.data.total : 0;
          if (pageItems.length === 0) break;
        }

        const seen = new Set<string>();
        const items = collected.filter((r) =>
          seen.has(r.id) ? false : (seen.add(r.id), true)
        );
        setRawRestrooms(items);
        onRestroomsLoaded?.(items);      } catch (err: any) {
        if (err.name === "AbortError") {
          return; // 디바운스에 의한 정상 취소
        }
        setApiError(err.message || "화장실 정보를 가져오지 못했습니다.");
      } finally {
        setIsLoading(false);
      }
    },
    [onRestroomsLoaded]
  );

  // 프로그래밍 방식 지도 이동 (사용자 직접 이동과 구분하기 위해 기록)
  const moveTo = useCallback((point: LatLng) => {
    lastMoveRef.current = { point, at: Date.now() };
    setCenter(point);
  }, []);

  // 지도 bounds 변경 시 디바운스 호출
  const handleBoundsChanged = useCallback(
    (newBounds: MapBounds) => {
      setBounds(newBounds);

      const vc = boundsCenter(newBounds);
      setViewCenter(vc);

      // 프로그래밍 이동이 아닌 사용자 직접 이동이면 탐색 기준을 지도 중심으로 갱신
      const last = lastMoveRef.current;
      if (
        Date.now() - last.at > PROGRAMMATIC_MOVE_GRACE_MS &&
        haversineMeters(vc, last.point) > MANUAL_PAN_THRESHOLD_M
      ) {
        setAnchorMode("center");
      }

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      debounceTimerRef.current = setTimeout(() => {
        fetchRestrooms(newBounds, filterType);
      }, 350);
    },
    [fetchRestrooms, filterType]
  );

  // 장소 검색 실행 (최신 요청만 반영)
  const runPlaceSearch = useCallback(
    async (keyword: string) => {
      const trimmed = keyword.trim();
      const seq = ++searchSeqRef.current;
      if (!trimmed) {
        setSearchResults([]);
        setSearchStatus("idle");
        return;
      }
      setSearchStatus("loading");
      try {
        const results = await placeSearchFn(trimmed);
        if (seq !== searchSeqRef.current) return; // 오래된 응답 무시
        setSearchResults(results);
        setSearchStatus(results.length > 0 ? "ok" : "empty");
      } catch {
        if (seq !== searchSeqRef.current) return;
        // 검색 실패 시에도 기존 지도·화장실 데이터는 건드리지 않는다
        setSearchResults([]);
        setSearchStatus("error");
      }
    },
    [placeSearchFn]
  );

  // 검색어 입력: 지도는 이동하지 않고 결과 목록만 갱신
  const handleSearchChange = useCallback(
    (keyword: string) => {
      setSearchKeyword(keyword);
      searchSeqRef.current += 1; // 진행 중이던 이전 검색 무효화
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
        searchTimerRef.current = null;
      }
      if (!keyword.trim()) {
        setSearchResults([]);
        setSearchStatus("idle");
        return;
      }
      searchTimerRef.current = setTimeout(() => {
        runPlaceSearch(keyword);
      }, SEARCH_DEBOUNCE_MS);
    },
    [runPlaceSearch]
  );

  const handleSearchSubmit = useCallback(
    (keyword: string) => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
        searchTimerRef.current = null;
      }
      runPlaceSearch(keyword);
    },
    [runPlaceSearch]
  );

  // 검색 결과 선택: 해당 좌표로 이동하고 주변 화장실 재조회
  const handleSelectPlace = useCallback(
    (place: PlaceSearchResult) => {
      searchSeqRef.current += 1;
      const point: LatLng = { lat: place.lat, lng: place.lng };
      setSearchKeyword(place.name);
      setSearchResults([]);
      setSearchStatus("idle");
      setSearchAnchor({ name: place.name, point });
      setAnchorMode("search");
      setSelectedRestroomId(null);
      setZoomLevel(4);
      moveTo(point);
      if (isInServiceArea(point)) {
        fetchRestrooms(bboxAround(point), filterType);
      }
    },
    [fetchRestrooms, filterType, moveTo]
  );

  // 필터 타입 변경 시 즉시 재조회
  const handleFilterTypeChange = useCallback(
    (newType: RestroomFilterType) => {
      setFilterType(newType);
      const targetBounds = bounds ?? SUWON_DEFAULT_BOUNDS;
      fetchRestrooms(targetBounds, newType);
    },
    [bounds, fetchRestrooms]
  );

  // 탐색 기준점 (검색 장소 > 내 위치 > 지도 중심)
  const reference = useMemo(() => {
    if (anchorMode === "search" && searchAnchor) {
      return {
        point: searchAnchor.point,
        label: `${searchAnchor.name} 기준 가까운 순`,
      };
    }
    if (anchorMode === "user" && userLocation) {
      return { point: userLocation, label: "내 위치 기준 가까운 순" };
    }
    return {
      point: viewCenter ?? center,
      label: "지도 중심 기준 가까운 순",
    };
  }, [anchorMode, searchAnchor, userLocation, viewCenter, center]);

  // 서비스 지역(수원시) 밖 여부
  const isOutOfService = useMemo(() => {
    const focus =
      anchorMode === "search" && searchAnchor
        ? searchAnchor.point
        : (viewCenter ?? center);
    return !isInServiceArea(focus);
  }, [anchorMode, searchAnchor, viewCenter, center]);

  // 기준점으로부터의 거리순 정렬 (공공/제휴 필터는 서버 조회 + 클라이언트 이중 적용)
  const { filteredRestrooms, distancesById } = useMemo(() => {
    let list = rawRestrooms;
    if (filterType === "public") {
      list = list.filter((r) => r.type === "public");
    } else if (filterType === "partner") {
      list = list.filter((r) => r.type === "partner");
    }

    const distances: Record<string, number> = {};
    const withDistance = list.map((r) => {
      const d = haversineMeters(reference.point, {
        lat: r.latitude,
        lng: r.longitude,
      });
      distances[r.id] = d;
      return { r, d };
    });
    withDistance.sort((a, b) => a.d - b.d || a.r.id.localeCompare(b.r.id));

    return {
      filteredRestrooms: withDistance.map((x) => x.r),
      distancesById: distances,
    };
  }, [rawRestrooms, filterType, reference]);


  // 선택된 화장실 객체
  const selectedRestroom = useMemo(() => {
    if (!selectedRestroomId) return null;
    return rawRestrooms.find((r) => r.id === selectedRestroomId) ?? null;
  }, [rawRestrooms, selectedRestroomId]);

  // 화장실 카드가 바텀시트에 노출될 때 restroom_card_viewed 기록
  useEffect(() => {
    if (selectedRestroom) {
      trackCardViewed({
        restroom: selectedRestroom,
        source: "marker_selection",
      });
      if (selectedRestroom.type === "partner") {
        trackPaymentUnavailableShown({
          restroom: selectedRestroom,
          reason: "feature_in_preparation",
        });
      }
    }
  }, [selectedRestroom, trackCardViewed, trackPaymentUnavailableShown]);

  // 마커 목록 생성
  const markers: MarkerOptions[] = useMemo(() => {
    const list: MarkerOptions[] = filteredRestrooms
      .filter((r) => r.latitude !== null && r.longitude !== null)
      .map((r, index) => ({
        id: r.id,
        position: { lat: r.latitude, lng: r.longitude },
        title: `[${r.type === "partner" ? "제휴" : "공공"}] ${r.name}`,
        type: r.type,
        selected: r.id === selectedRestroomId,
        zIndex: r.id === selectedRestroomId ? 15 : 2,
        onClick: (id: string) => {
          trackMarkerClicked({
            restroom: r,
            markerIndex: index,
          });
          setSelectedRestroomId(id);
          setIsSheetExpanded(false);
          // 선택된 화장실로 지도 부드럽게 이동
          moveTo({ lat: r.latitude, lng: r.longitude });
        },
      }));

    // 현재 사용자 위치 마커 추가
    if (userLocation) {
      list.push({
        id: "user_current_location",
        position: userLocation,
        title: "내 현재 위치",
        type: "current_location",
        zIndex: 25,
      });
    }

    return list;
  }, [filteredRestrooms, selectedRestroomId, userLocation, moveTo]);

  // 내 위치 조회 핸들러
  const handleCurrentLocationClick = useCallback(async () => {
    setIsLocating(true);
    setLocationNotice(null);

    const result = await getCurrentUserLocation({
      timeoutMs: 7000,
      highAccuracy: true,
      fallback: SUWON_DEFAULT_CENTER,
    });

    setIsLocating(false);

    if (result.success) {
      setUserLocation(result.coords);
      setAnchorMode("user");
      setSearchAnchor(null);
      moveTo(result.coords);
      setLocationNotice("현재 위치로 이동했습니다.");
      setTimeout(() => setLocationNotice(null), 3500);
    } else {
      setLocationNotice(
        result.error?.message ||
          "위치 정보를 가져올 수 없어 수원시 기본 위치로 유지합니다."
      );
      setTimeout(() => setLocationNotice(null), 5000);
    }
  }, [moveTo]);

  // 줌 제어 핸들러
  const handleZoomIn = () => {
    setZoomLevel((prev) => Math.max(1, prev - 1)); // 카카오맵은 레벨이 작을수록 확대
  };

  const handleZoomOut = () => {
    setZoomLevel((prev) => Math.min(14, prev + 1));
  };

  const handleResetCenter = () => {
    setAnchorMode(userLocation ? "user" : "center");
    moveTo(userLocation ?? SUWON_DEFAULT_CENTER);
  };

  return (
    <div
      data-testid="map-discovery-container"
      className="relative flex flex-1 h-full w-full flex-col overflow-hidden bg-slate-100 dark:bg-slate-900"
    >
      {/* 상단 검색 및 필터 바 (바텀시트보다 상위 z-index 유지) */}
      <div className="absolute top-2 left-2 right-2 z-40">
        <MapFilterBar
          searchKeyword={searchKeyword}
          onSearchChange={handleSearchChange}
          onSearchSubmit={handleSearchSubmit}
          filterType={filterType}
          onFilterTypeChange={handleFilterTypeChange}
          onCurrentLocationClick={handleCurrentLocationClick}
          isLocating={isLocating}
          totalCount={filteredRestrooms.length}
          isLoading={isLoading}
        />

        {/* 지역/장소 검색 결과 (선택 전에는 지도 이동 없음) */}
        <PlaceSearchResults
          status={searchStatus}
          results={searchResults}
          query={searchKeyword.trim()}
          onSelect={handleSelectPlace}
          onRetry={() => runPlaceSearch(searchKeyword)}
        />

        {/* 서비스 지역 밖 안내 */}
        {isOutOfService && (
          <div
            data-testid="out-of-service-banner"
            role="status"
            className="mt-1.5 rounded-xl bg-amber-100 px-3 py-2 text-xs font-medium text-amber-900 shadow-lg dark:bg-amber-900 dark:text-amber-100"
          >
            {OUT_OF_SERVICE_MESSAGE}
          </div>
        )}

        {/* 위치 권한 거부 또는 상태 안내 토스트 */}
        {locationNotice && (
          <div
            data-testid="location-notice-banner"
            className="mt-1.5 rounded-xl bg-slate-900/90 px-3 py-2 text-xs font-medium text-white shadow-lg backdrop-blur-sm dark:bg-white/90 dark:text-slate-900 animate-in fade-in duration-150"
          >
            <span>ℹ️ {locationNotice}</span>
          </div>
        )}

        {/* API 오류 안내 배너 */}
        {apiError && (
          <div
            data-testid="api-error-banner"
            className="mt-1.5 flex items-center justify-between rounded-xl bg-red-600/90 px-3 py-2 text-xs font-medium text-white shadow-lg backdrop-blur-sm"
          >
            <span>⚠️ {apiError}</span>
            <button
              type="button"
              onClick={() => bounds && fetchRestrooms(bounds, filterType)}
              className="ml-2 rounded bg-white/20 px-2 py-0.5 text-[11px] font-semibold hover:bg-white/30"
            >
              다시 시도
            </button>
          </div>
        )}
      </div>

      {/* 카카오 지도 캔버스 */}
      <div className="relative flex-1 w-full min-h-[400px]">
        <MapCanvas
          center={center}
          zoomLevel={zoomLevel}
          markers={markers}
          providerFactory={providerFactory}
          onBoundsChanged={handleBoundsChanged}
          onMapReady={(provider) => {
            mapProviderRef.current = provider;
            try {
              const currentBounds = provider.getBounds();
              handleBoundsChanged(currentBounds);
            } catch {
              // 초기화 직후 bounds 미생성 시 무시
            }
            trackMapLoaded({
              zoom: zoomLevel,
              restroomCount: rawRestrooms.length,
              filter: filterType,
              centerRegion: "수원시",
            });
          }}
          className="absolute inset-0 w-full h-full min-h-[400px]"
        />
      </div>

      {/* 지도 플로팅 컨트롤 (우측 상단/중간) */}
      <div className="absolute right-3 top-28 z-20 flex flex-col gap-1.5">
        <button
          type="button"
          onClick={handleZoomIn}
          data-testid="map-zoom-in-btn"
          aria-label="지도 확대"
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white/95 text-base font-bold text-slate-700 shadow-md backdrop-blur-sm hover:bg-slate-50 active:scale-95 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
        >
          +
        </button>
        <button
          type="button"
          onClick={handleZoomOut}
          data-testid="map-zoom-out-btn"
          aria-label="지도 축소"
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white/95 text-base font-bold text-slate-700 shadow-md backdrop-blur-sm hover:bg-slate-50 active:scale-95 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
        >
          −
        </button>
        <button
          type="button"
          onClick={handleResetCenter}
          data-testid="map-recenter-btn"
          aria-label="수원 중심 복귀"
          title="중심 위치로 복귀"
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white/95 text-xs text-slate-700 shadow-md backdrop-blur-sm hover:bg-slate-50 active:scale-95 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
        >
          🎯
        </button>
      </div>

      {/* 하단 바텀시트 (선택된 화장실 상세 또는 지역 화장실 목록) */}
      <MapBottomSheet
        selectedRestroom={selectedRestroom}
        restrooms={filteredRestrooms}
        onSelectRestroom={(restroom) => {
          setSelectedRestroomId(restroom.id);
          setIsSheetExpanded(false);
          moveTo({ lat: restroom.latitude, lng: restroom.longitude });
          trackCardViewed({
            restroom,
            source: "list_drawer",
          });
        }}
        onCloseSelected={() => setSelectedRestroomId(null)}
        onDirectionsClick={(restroom) => setDirectionsTarget(restroom)}
        onPaymentClick={(restroom) => {
          trackPaymentButtonClicked({ restroom });
          trackPaymentUnavailableShown({
            restroom,
            reason: "feature_in_preparation",
          });
        }}
        onDetailClick={(restroom) => {
          trackDetailOpened({
            restroom,
            sourceComponent: "card_detail_link",
          });
        }}
        isExpanded={isSheetExpanded}
        onToggleExpand={() => setIsSheetExpanded((prev) => !prev)}
        isLoading={isLoading}
        distancesById={distancesById}
        sortBasisLabel={reference.label}
      />

      {/* 길찾기 3사 연결 모달 */}
      <MapDirectionsModal
        isOpen={Boolean(directionsTarget)}
        onClose={() => setDirectionsTarget(null)}
        onDirectionsClick={(service) => {
          if (directionsTarget) {
            trackDirectionsClicked({
              restroom: directionsTarget,
              service,
              hasOrigin: Boolean(userLocation),
            });
          }
        }}
        target={
          directionsTarget
            ? {
                id: directionsTarget.id,
                name: directionsTarget.name,
                type: directionsTarget.type,
                businessId: directionsTarget.business_id,
                address: directionsTarget.road_address,
                coords: {
                  lat: directionsTarget.latitude,
                  lng: directionsTarget.longitude,
                },
              }
            : null
        }
        origin={
          userLocation
            ? {
                name: "현재 위치",
                coords: userLocation,
              }
            : null
        }
      />
    </div>
  );
}

