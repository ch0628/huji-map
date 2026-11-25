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
  boundsCenter,
  haversineMeters,
} from "@/lib/maps/geo";
import { useVisitorSession, useEventTracker } from "@/lib/events/hooks";
import { useBasicUsageTracker } from "@/lib/usage-counts/hooks";
import {
  ANALYTICS_CONSENT_CHANGED_EVENT,
  ANALYTICS_SESSION_RESET_EVENT,
  isAnalyticsAllowed,
} from "@/lib/events/client";

export interface MapDiscoveryClientProps {
  readonly initialRestroomId?: string;
  readonly initialFilterType?: RestroomFilterType;
  /** 테스트 및 커스텀 공급자 주입 지원 */
  readonly providerFactory?: () => MapProvider;
  readonly onRestroomsLoaded?: (items: PublicRestroomSummary[]) => void;
  /** 장소 검색 함수 주입 (기본: 카카오 장소 검색) */
  readonly placeSearchFn?: PlaceSearchFn;
  /** 휴지맵 DB 공개 화장실 이름 검색 함수 주입 (기본: /api/v1/restrooms/search) */
  readonly restroomSearchFn?: (
    keyword: string
  ) => Promise<PublicRestroomSummary[]>;
}

type AnchorMode = "search" | "user" | "center";

const SEARCH_DEBOUNCE_MS = 350;
const NEARBY_RADIUS_M = 400;
const NEARBY_LIMIT = 100;
/** 프로그래밍 이동 직후 애니메이션 중 bounds/zoom 이벤트를 수동 이동으로 오인하지 않는 시간 */
const PROGRAMMATIC_MOVE_GRACE_MS = 1500;
/** 이 거리 이상 지도 중심이 벗어나면 사용자가 직접 이동한 것으로 간주 */
const MANUAL_PAN_THRESHOLD_M = 400;
/** 프로그래밍 이동 목표 좌표와의 허용 오차(m) */
const PROGRAMMATIC_MOVE_TOLERANCE_M = 50;

async function defaultRestroomSearch(
  keyword: string
): Promise<PublicRestroomSummary[]> {
  const res = await fetch(
    `/api/v1/restrooms/search?q=${encodeURIComponent(keyword)}&type=all&limit=10`
  );
  if (!res.ok) {
    throw new Error(`화장실 검색 API 오류: ${res.status}`);
  }
  const json = await res.json();
  if (!json.ok || !json.data) {
    throw new Error(json.error?.message || "화장실 검색 실패");
  }
  return Array.isArray(json.data.items) ? json.data.items : [];
}

export default function MapDiscoveryClient({
  initialRestroomId,
  initialFilterType = "all",
  providerFactory,
  onRestroomsLoaded,
  placeSearchFn = searchKakaoPlaces,
  restroomSearchFn = defaultRestroomSearch,
}: MapDiscoveryClientProps) {
  const [center, setCenter] = useState<LatLng>(SUWON_DEFAULT_CENTER);
  const [zoomLevel, setZoomLevel] = useState<number>(DEFAULT_ZOOM_LEVEL);

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

  // 지역/장소 + 휴지맵 화장실 이름 검색 상태
  const [searchResults, setSearchResults] = useState<PlaceSearchResult[]>([]);
  const [restroomSearchResults, setRestroomSearchResults] = useState<
    PublicRestroomSummary[]
  >([]);
  const [searchStatus, setSearchStatus] = useState<PlaceSearchStatus>("idle");
  const [searchPartialWarning, setSearchPartialWarning] = useState<
    string | null
  >(null);
  const [pinnedSearchRestroom, setPinnedSearchRestroom] =
    useState<PublicRestroomSummary | null>(null);
  const [searchAnchor, setSearchAnchor] = useState<{
    name: string;
    point: LatLng;
  } | null>(null);
  const [anchorMode, setAnchorMode] = useState<AnchorMode>("center");
  const [searchedCenter, setSearchedCenter] =
    useState<LatLng>(SUWON_DEFAULT_CENTER);
  const [showSearchHere, setShowSearchHere] = useState<boolean>(false);

  const searchSeqRef = useRef(0);
  const fetchSeqRef = useRef(0);
  const searchTimerRef = useRef<NodeJS.Timeout | null>(null);
  const currentMapCenterRef = useRef<LatLng>(SUWON_DEFAULT_CENTER);
  const lastMoveRef = useRef<{ point: LatLng; at: number }>({
    point: SUWON_DEFAULT_CENTER,
    at: Date.now(),
  });
  const lastZoomRef = useRef<{ zoom: number; at: number }>({
    zoom: DEFAULT_ZOOM_LEVEL,
    at: Date.now(),
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  const mapProviderRef = useRef<MapProvider | null>(null);
  const isMapReadyRef = useRef<boolean>(false);
  const latestMapMetaRef = useRef<{
    zoom: number;
    restroomCount: number;
    filter: RestroomFilterType;
  }>({
    zoom: DEFAULT_ZOOM_LEVEL,
    restroomCount: 0,
    filter: initialFilterType,
  });
  const selectionSourceRef = useRef<
    "marker_selection" | "list_drawer" | "direct_query"
  >("marker_selection");

  // 방문자 세션 초기화 및 이벤트 추적기 연동 (선택적 분석 6종 전용)
  useVisitorSession();
  const {
    trackMapLoaded,
    trackMarkerClicked,
    trackCardViewed,
    trackDirectionsClicked,
  } = useEventTracker();
  const {
    trackBasicMapOpened,
    trackBasicMarkerClicked,
    trackBasicSearchExecuted,
    trackBasicDirectionsClicked,
  } = useBasicUsageTracker();

  useEffect(() => {
    latestMapMetaRef.current = {
      zoom: zoomLevel,
      restroomCount: rawRestrooms.length,
      filter: filterType,
    };
  }, [zoomLevel, rawRestrooms.length, filterType]);

  // 동의 직후(또는 로그인/로그아웃 세션 전환 후) 이미 열린 지도에서 map_loaded가 누락되지 않도록 보완
  useEffect(() => {
    const handleAnalyticsSync = () => {
      if (isAnalyticsAllowed() && isMapReadyRef.current) {
        trackMapLoaded({
          zoom: latestMapMetaRef.current.zoom,
          restroomCount: latestMapMetaRef.current.restroomCount,
          filter: latestMapMetaRef.current.filter,
          centerRegion: "수원시",
        });
      }
    };
    window.addEventListener(ANALYTICS_CONSENT_CHANGED_EVENT, handleAnalyticsSync);
    window.addEventListener(ANALYTICS_SESSION_RESET_EVENT, handleAnalyticsSync);
    return () => {
      window.removeEventListener(ANALYTICS_CONSENT_CHANGED_EVENT, handleAnalyticsSync);
      window.removeEventListener(ANALYTICS_SESSION_RESET_EVENT, handleAnalyticsSync);
    };
  }, [trackMapLoaded]);

  // 중심 좌표 기반 주변 화장실 단일 API 요청 (거리순 최대 100건)
  const fetchRestrooms = useCallback(
    async (targetCenter: LatLng, targetType: RestroomFilterType) => {
      // 진행 중인 이전 요청 취소
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const seq = ++fetchSeqRef.current;

      setIsLoading(true);
      setApiError(null);

      try {
        const params = new URLSearchParams({
          centerLat: String(targetCenter.lat),
          centerLng: String(targetCenter.lng),
          radiusM: String(NEARBY_RADIUS_M),
          type: targetType,
          limit: String(NEARBY_LIMIT),
        });
        const url = `/api/v1/restrooms?${params.toString()}`;
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
          throw new Error(`API 응답 오류: ${res.status}`);
        }
        const json = await res.json();
        if (!(json.ok && json.data)) {
          throw new Error(json.error?.message || "화장실 목록 조회 실패");
        }
        if (controller.signal.aborted || seq !== fetchSeqRef.current) {
          return;
        }
        const rawItems: PublicRestroomSummary[] = Array.isArray(json.data.items)
          ? json.data.items
          : [];
        const seen = new Set<string>();
        const items = rawItems.filter((r) =>
          seen.has(r.id) ? false : (seen.add(r.id), true)
        );
        setSearchedCenter(targetCenter);
        setRawRestrooms(items);
        onRestroomsLoaded?.(items);
      } catch (err: any) {
        if (
          err?.name === "AbortError" ||
          controller.signal.aborted ||
          seq !== fetchSeqRef.current
        ) {
          return; // 이전 요청 취소/무효화 시 상태 및 로딩 유지
        }
        setApiError(err?.message || "화장실 정보를 가져오지 못했습니다.");
      } finally {
        if (seq === fetchSeqRef.current) {
          setIsLoading(false);
        }
      }
    },
    [onRestroomsLoaded]
  );

  // 최초 마운트 시 현재 지도 중심 기준으로 1회만 조회
  useEffect(() => {
    fetchRestrooms(SUWON_DEFAULT_CENTER, filterType);

    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 프로그래밍 방식 지도 이동 (사용자 직접 이동과 구분하기 위해 기록)
  const moveTo = useCallback((point: LatLng) => {
    lastMoveRef.current = { point, at: Date.now() };
    currentMapCenterRef.current = point;
    setCenter(point);
  }, []);

  const setProgrammaticZoom = useCallback((level: number) => {
    lastZoomRef.current = { zoom: level, at: Date.now() };
    setZoomLevel(level);
  }, []);

  // 지도 bounds 변경 시: 자동 재조회 없이 수동 재검색 버튼만 표시
  const handleBoundsChanged = useCallback((newBounds: MapBounds) => {
    const vc = boundsCenter(newBounds);
    currentMapCenterRef.current = vc;

    const last = lastMoveRef.current;
    const isProgrammaticMove =
      Date.now() - last.at <= PROGRAMMATIC_MOVE_GRACE_MS &&
      haversineMeters(vc, last.point) <= PROGRAMMATIC_MOVE_TOLERANCE_M;

    if (!isProgrammaticMove) {
      setShowSearchHere(true);
      if (haversineMeters(vc, last.point) > MANUAL_PAN_THRESHOLD_M) {
        setAnchorMode("center");
      }
    }
  }, []);

  // 지도 줌 변경 시: 자동 재조회 없이 수동 재검색 버튼만 표시
  const handleZoomChanged = useCallback((newZoom: number) => {
    setZoomLevel(newZoom);
    const last = lastZoomRef.current;
    const isProgrammaticZoom =
      Date.now() - last.at <= PROGRAMMATIC_MOVE_GRACE_MS &&
      last.zoom === newZoom;
    if (!isProgrammaticZoom) {
      setShowSearchHere(true);
    }
  }, []);

  // 장소 + 공개 화장실 이름 병렬 검색 실행 (최신 요청만 반영)
  const runPlaceSearch = useCallback(
    async (keyword: string) => {
      const trimmed = keyword.trim();
      const seq = ++searchSeqRef.current;
      if (!trimmed) {
        setSearchResults([]);
        setRestroomSearchResults([]);
        setSearchPartialWarning(null);
        setSearchStatus("idle");
        return;
      }
      setSearchStatus("loading");
      setSearchPartialWarning(null);
      trackBasicSearchExecuted();

      const [placeRes, restroomRes] = await Promise.allSettled([
        placeSearchFn(trimmed),
        restroomSearchFn(trimmed),
      ]);

      if (seq !== searchSeqRef.current) return; // 오래된 응답 무시

      const places = placeRes.status === "fulfilled" ? placeRes.value : [];
      const restrooms =
        restroomRes.status === "fulfilled" ? restroomRes.value : [];

      const placeFailed = placeRes.status === "rejected";
      const restroomFailed = restroomRes.status === "rejected";

      if (
        (placeFailed && restroomFailed) ||
        (placeFailed && restrooms.length === 0) ||
        (restroomFailed && places.length === 0)
      ) {
        // 검색 실패 시에도 기존 지도·화장실 데이터는 건드리지 않는다
        setSearchResults([]);
        setRestroomSearchResults([]);
        setSearchPartialWarning(null);
        setSearchStatus("error");
        return;
      }

      if (placeFailed) {
        setSearchPartialWarning(
          "카카오 장소 검색에 일시적 오류가 있어 휴지맵 등록 화장실만 표시합니다."
        );
      } else if (restroomFailed) {
        setSearchPartialWarning(
          "휴지맵 화장실 검색에 일시적 오류가 있어 카카오 장소만 표시합니다."
        );
      }

      setSearchResults(places);
      setRestroomSearchResults(restrooms);
      setSearchStatus(places.length + restrooms.length > 0 ? "ok" : "empty");
    },
    [placeSearchFn, restroomSearchFn, trackBasicSearchExecuted]
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
        setRestroomSearchResults([]);
        setSearchPartialWarning(null);
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

  // 카카오 장소 검색 결과 선택: 해당 좌표로 이동 + 초록 마커 표시 + 주변 화장실 1회 재조회 (전국 지원)
  const handleSelectPlace = useCallback(
    (place: PlaceSearchResult) => {
      searchSeqRef.current += 1;
      const point: LatLng = { lat: place.lat, lng: place.lng };
      setSearchKeyword(place.name);
      setSearchResults([]);
      setRestroomSearchResults([]);
      setSearchPartialWarning(null);
      setSearchStatus("idle");
      setPinnedSearchRestroom(null);
      setSearchAnchor({ name: place.name, point });
      setAnchorMode("search");
      setSelectedRestroomId(null);
      setShowSearchHere(false);
      setProgrammaticZoom(4);
      moveTo(point);
      fetchRestrooms(point, filterType);
    },
    [fetchRestrooms, filterType, moveTo, setProgrammaticZoom]
  );

  // 휴지맵 등록 화장실 검색 결과 선택: 해당 화장실 위치로 이동 + 선택 + 주변 1회 재조회 (전국 지원)
  const handleSelectRestroomResult = useCallback(
    (restroom: PublicRestroomSummary) => {
      searchSeqRef.current += 1;
      const point: LatLng = { lat: restroom.latitude, lng: restroom.longitude };
      const nextFilterType: RestroomFilterType =
        filterType !== "all" && restroom.type !== filterType
          ? "all"
          : filterType;

      setSearchKeyword(restroom.name);
      setSearchResults([]);
      setRestroomSearchResults([]);
      setSearchPartialWarning(null);
      setSearchStatus("idle");
      setSearchAnchor(null);
      setAnchorMode("center");
      if (nextFilterType !== filterType) {
        setFilterType(nextFilterType);
      }
      setPinnedSearchRestroom(restroom);
      setRawRestrooms((prev) =>
        prev.some((r) => r.id === restroom.id) ? prev : [restroom, ...prev]
      );
      selectionSourceRef.current = "direct_query";
      setSelectedRestroomId(restroom.id);
      setIsSheetExpanded(false);
      setShowSearchHere(false);
      setProgrammaticZoom(4);
      moveTo(point);
      fetchRestrooms(point, nextFilterType);
    },
    [fetchRestrooms, filterType, moveTo, setProgrammaticZoom]
  );

  // 필터 타입 변경 시 현재 지도 중심 기준 1회 재조회
  const handleFilterTypeChange = useCallback(
    (newType: RestroomFilterType) => {
      if (newType === filterType) return;
      setFilterType(newType);
      setShowSearchHere(false);
      fetchRestrooms(currentMapCenterRef.current, newType);
    },
    [fetchRestrooms, filterType]
  );

  // 탐색 기준점 (검색 장소 > 내 위치 > 마지막 조회 지도 중심)
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
      point: searchedCenter,
      label: "지도 중심 기준 가까운 순",
    };
  }, [anchorMode, searchAnchor, userLocation, searchedCenter]);

  // 기준점으로부터의 거리순 정렬 (서버 거리순 우선, 공공/제휴 필터 이중 적용)
  const { filteredRestrooms, distancesById } = useMemo(() => {
    let list = rawRestrooms;
    if (filterType === "public") {
      list = list.filter((r) => r.type === "public");
    } else if (filterType === "partner") {
      list = list.filter((r) => r.type === "partner");
    }

    const useServerDistance =
      haversineMeters(reference.point, searchedCenter) < 1;

    const distances: Record<string, number> = {};
    const withDistance = list.map((r) => {
      const d =
        useServerDistance && typeof r.distance_meters === "number"
          ? r.distance_meters
          : haversineMeters(reference.point, {
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
  }, [rawRestrooms, filterType, reference, searchedCenter]);


  // 선택된 화장실 객체
  const selectedRestroom = useMemo(() => {
    if (!selectedRestroomId) return null;
    return (
      rawRestrooms.find((r) => r.id === selectedRestroomId) ??
      (pinnedSearchRestroom?.id === selectedRestroomId
        ? pinnedSearchRestroom
        : null)
    );
  }, [rawRestrooms, selectedRestroomId, pinnedSearchRestroom]);

  // 화장실 카드가 바텀시트에 실제 노출될 때 restroom_card_viewed 기록
  useEffect(() => {
    if (selectedRestroom) {
      trackCardViewed({
        restroom: selectedRestroom,
        source: selectionSourceRef.current,
      });
    }
  }, [selectedRestroom, trackCardViewed]);

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
          trackBasicMarkerClicked();
          trackMarkerClicked({
            restroom: r,
            markerIndex: index,
          });
          selectionSourceRef.current = "marker_selection";
          setSelectedRestroomId(id);
          setIsSheetExpanded(false);
          // 선택된 화장실로 지도 부드럽게 이동
          moveTo({ lat: r.latitude, lng: r.longitude });
        },
      }));

    // 검색 선택한 장소 초록색 전용 마커 추가
    if (searchAnchor) {
      list.push({
        id: "search_place_anchor",
        position: searchAnchor.point,
        title: searchAnchor.name,
        type: "search_place",
        zIndex: 20,
      });
    }

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
  }, [filteredRestrooms, selectedRestroomId, searchAnchor, userLocation, moveTo]);

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
      setShowSearchHere(false);
      moveTo(result.coords);
      fetchRestrooms(result.coords, filterType);
      setLocationNotice("현재 위치로 이동했습니다.");
      setTimeout(() => setLocationNotice(null), 3500);
    } else {
      setLocationNotice(
        result.error?.message ||
          "위치 정보를 가져올 수 없어 기본 위치로 유지합니다."
      );
      setTimeout(() => setLocationNotice(null), 5000);
    }
  }, [fetchRestrooms, filterType, moveTo]);

  // 이 지역에서 재검색 버튼 핸들러
  const handleSearchHereClick = useCallback(() => {
    setAnchorMode("center");
    setShowSearchHere(false);
    fetchRestrooms(currentMapCenterRef.current, filterType);
  }, [fetchRestrooms, filterType]);

  // 줌 제어 핸들러 (자동 재조회 없이 수동 재검색 버튼 표시)
  const handleZoomIn = () => {
    const next = Math.max(1, zoomLevel - 1); // 카카오맵은 레벨이 작을수록 확대
    if (next !== zoomLevel) {
      setZoomLevel(next);
      setShowSearchHere(true);
    }
  };

  const handleZoomOut = () => {
    const next = Math.min(14, zoomLevel + 1);
    if (next !== zoomLevel) {
      setZoomLevel(next);
      setShowSearchHere(true);
    }
  };

  const handleResetCenter = () => {
    const target = userLocation ?? SUWON_DEFAULT_CENTER;
    setSearchAnchor(null);
    setAnchorMode(userLocation ? "user" : "center");
    setShowSearchHere(false);
    moveTo(target);
    fetchRestrooms(target, filterType);
  };

  return (
    <div
      data-testid="map-discovery-container"
      className="relative flex flex-1 h-full w-full flex-col overflow-hidden bg-slate-100 dark:bg-slate-900"
    >
      {/* 상단 검색 및 필터 바 (바텀시트보다 상위 z-index 유지) */}
      <div className="pointer-events-none absolute top-2 left-2 right-2 z-40">
        <div className="pointer-events-auto">
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
        </div>

        {/* 지역/장소 + 휴지맵 화장실 검색 결과 (선택 전에는 지도 이동 없음) */}
        <div className="pointer-events-auto">
          <PlaceSearchResults
            status={searchStatus}
            results={searchResults}
            restroomResults={restroomSearchResults}
            partialWarning={searchPartialWarning}
            query={searchKeyword.trim()}
            onSelect={handleSelectPlace}
            onSelectRestroom={handleSelectRestroomResult}
            onRetry={() => runPlaceSearch(searchKeyword)}
          />
        </div>

        {/* 위치 권한 거부 또는 상태 안내 토스트 */}
        {locationNotice && (
          <div
            data-testid="location-notice-banner"
            className="pointer-events-auto mt-1.5 rounded-xl bg-slate-900/90 px-3 py-2 text-xs font-medium text-white shadow-lg backdrop-blur-sm dark:bg-white/90 dark:text-slate-900 animate-in fade-in duration-150"
          >
            <span>ℹ️ {locationNotice}</span>
          </div>
        )}

        {/* API 오류 안내 배너 */}
        {apiError && (
          <div
            data-testid="api-error-banner"
            className="pointer-events-auto mt-1.5 flex items-center justify-between rounded-xl bg-red-600/90 px-3 py-2 text-xs font-medium text-white shadow-lg backdrop-blur-sm"
          >
            <span>⚠️ {apiError}</span>
            <button
              type="button"
              onClick={() =>
                fetchRestrooms(currentMapCenterRef.current, filterType)
              }
              className="ml-2 rounded bg-white/20 px-2 py-0.5 text-[11px] font-semibold hover:bg-white/30"
            >
              다시 시도
            </button>
          </div>
        )}

        {/* 지도 이동·확대·축소 시 표시되는 수동 재검색 버튼 (상단 중앙) */}
        {showSearchHere && (
          <div className="mt-2 flex justify-center pointer-events-none">
            <button
              type="button"
              onClick={handleSearchHereClick}
              data-testid="search-this-area-btn"
              className="pointer-events-auto inline-flex min-h-[36px] items-center gap-1.5 rounded-full bg-slate-900/95 px-4 py-1.5 text-xs font-semibold text-white shadow-lg backdrop-blur-sm transition hover:bg-slate-800 active:scale-95 dark:bg-white/95 dark:text-slate-900"
            >
              <span aria-hidden="true">🔄</span>
              <span>이 지역에서 재검색</span>
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
          onZoomChanged={handleZoomChanged}
          onMapReady={(provider) => {
            mapProviderRef.current = provider;
            isMapReadyRef.current = true;
            lastMoveRef.current = {
              point: currentMapCenterRef.current,
              at: Date.now(),
            };
            lastZoomRef.current = {
              zoom: zoomLevel,
              at: Date.now(),
            };
            trackBasicMapOpened();
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
          aria-label="중심 위치로 복귀"
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
          selectionSourceRef.current = "list_drawer";
          setSelectedRestroomId(restroom.id);
          setIsSheetExpanded(false);
          moveTo({ lat: restroom.latitude, lng: restroom.longitude });
        }}
        onCloseSelected={() => {
          setSelectedRestroomId(null);
          setPinnedSearchRestroom(null);
        }}
        onDirectionsClick={(restroom) => setDirectionsTarget(restroom)}
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
          trackBasicDirectionsClicked();
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

