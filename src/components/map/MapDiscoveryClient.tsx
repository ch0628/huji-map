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
import type {
  CandidateViewportResponse,
  PublicRestroomCandidateSummary,
  PublicRestroomSummary,
} from "@/lib/restrooms/types";
import {
  MAX_CANDIDATE_VIEWPORT_LAT_SPAN,
  MAX_CANDIDATE_VIEWPORT_LNG_SPAN,
} from "@/lib/restrooms/korea-admin-regions";
import {
  clearCandidateResolverSessionState,
  createCandidateResolverSessionState,
  isCoordinateWithinBounds,
  isResolvedCandidateDuplicateOfOfficial,
  resolveViewportCandidatesWithKakao,
  type CandidateResolverSessionState,
  type ResolveCandidatesOptions,
  type ResolveCandidatesResult,
} from "@/lib/maps/candidate-resolver";
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
  /** 지도 영역 좌표 미확보 후보 조회 함수 주입 (기본: /api/v1/restrooms/candidates) */
  readonly candidateFetchFn?: (
    bounds: MapBounds,
    signal?: AbortSignal,
    options?: {
      cursor?: string | null;
      excludeIds?: string[];
    }
  ) => Promise<CandidateViewportResponse>;
  /** 후보 실시간 카카오 위치 보완 함수 주입 */
  readonly candidateResolveFn?: (
    candidates: readonly PublicRestroomCandidateSummary[],
    options: ResolveCandidatesOptions
  ) => Promise<ResolveCandidatesResult>;
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

async function defaultCandidateFetch(
  bounds: MapBounds,
  signal?: AbortSignal,
  options?: {
    cursor?: string | null;
    excludeIds?: string[];
  }
): Promise<CandidateViewportResponse> {
  const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
  const params = new URLSearchParams({
    bbox,
    limit: "15",
  });
  if (options?.cursor) {
    params.set("cursor", options.cursor);
  }
  if (options?.excludeIds && options.excludeIds.length > 0) {
    params.set("excludeIds", options.excludeIds.slice(-220).join(","));
  }
  const res = await fetch(`/api/v1/restrooms/candidates?${params.toString()}`, {
    signal,
  });
  if (!res.ok) {
    throw new Error(`후보 화장실 조회 API 오류: ${res.status}`);
  }
  const json = await res.json();
  if (!json.ok || !json.data) {
    throw new Error(json.error?.message || "후보 화장실 조회 실패");
  }
  return json.data as CandidateViewportResponse;
}

function approximateBoundsFromCenter(center: LatLng, zoomLevel: number): MapBounds {
  const halfLat = 0.004 * Math.pow(2, Math.max(1, zoomLevel) - 3);
  const halfLng = halfLat * 1.4;
  return {
    south: Math.max(-90, center.lat - halfLat),
    north: Math.min(90, center.lat + halfLat),
    west: Math.max(-180, center.lng - halfLng),
    east: Math.min(180, center.lng + halfLng),
  };
}

function isBoundsTooWideForCandidates(bounds: MapBounds): boolean {
  return (
    bounds.north - bounds.south > MAX_CANDIDATE_VIEWPORT_LAT_SPAN ||
    bounds.east - bounds.west > MAX_CANDIDATE_VIEWPORT_LNG_SPAN
  );
}

export default function MapDiscoveryClient({
  initialRestroomId,
  initialFilterType = "all",
  providerFactory,
  onRestroomsLoaded,
  placeSearchFn = searchKakaoPlaces,
  restroomSearchFn = defaultRestroomSearch,
  candidateFetchFn = defaultCandidateFetch,
  candidateResolveFn = resolveViewportCandidatesWithKakao,
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

  // 전국 좌표 미확보 후보 실시간 위치 보완 (세션 메모리 전용, DB/스토리지 비저장)
  const [candidateRestrooms, setCandidateRestrooms] = useState<
    PublicRestroomSummary[]
  >([]);
  const [candidateStatusNote, setCandidateStatusNote] = useState<string | null>(
    null
  );
  const [isCandidateSearching, setIsCandidateSearching] =
    useState<boolean>(false);
  const [candidateExhausted, setCandidateExhausted] = useState<boolean>(false);
  const [candidateLimitReason, setCandidateLimitReason] = useState<
    "quota" | "rate_limit" | null
  >(null);
  const [viewportBounds, setViewportBounds] = useState<MapBounds | null>(null);

  const searchSeqRef = useRef(0);
  const fetchSeqRef = useRef(0);
  const candidateSeqRef = useRef(0);
  const isCandidateSearchingRef = useRef(false);
  const searchTimerRef = useRef<NodeJS.Timeout | null>(null);
  const currentMapCenterRef = useRef<LatLng>(SUWON_DEFAULT_CENTER);
  const latestBoundsRef = useRef<MapBounds | null>(null);
  const rawRestroomsRef = useRef<PublicRestroomSummary[]>([]);
  const lastFetchedFilterTypeRef = useRef<RestroomFilterType>(initialFilterType);
  const candidateRestroomsRef = useRef<PublicRestroomSummary[]>([]);
  const candidateViewportStateRef = useRef<{
    bounds: MapBounds | null;
    nextCursor: string | null;
  }>({
    bounds: null,
    nextCursor: null,
  });

  const commitCandidateRestrooms = useCallback(
    (
      updater: (prev: PublicRestroomSummary[]) => PublicRestroomSummary[]
    ): PublicRestroomSummary[] => {
      const next = updater(candidateRestroomsRef.current);
      candidateRestroomsRef.current = next;
      setCandidateRestrooms(next);
      return next;
    },
    []
  );
  const candidateSessionRef = useRef<CandidateResolverSessionState | null>(
    null
  );
  if (!candidateSessionRef.current) {
    candidateSessionRef.current = createCandidateResolverSessionState();
  }
  const lastMoveRef = useRef<{ point: LatLng; at: number }>({
    point: SUWON_DEFAULT_CENTER,
    at: Date.now(),
  });
  const lastZoomRef = useRef<{ zoom: number; at: number }>({
    zoom: DEFAULT_ZOOM_LEVEL,
    at: Date.now(),
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  const candidateAbortRef = useRef<AbortController | null>(null);
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
    async (
      targetCenter: LatLng,
      targetType: RestroomFilterType,
      options?: { preserveInBounds?: boolean; activeBounds?: MapBounds }
    ) => {
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
        const freshItems = rawItems.filter((r) =>
          seen.has(r.id) ? false : (seen.add(r.id), true)
        );

        let finalItems = freshItems;
        if (
          options?.preserveInBounds &&
          options.activeBounds &&
          lastFetchedFilterTypeRef.current === targetType
        ) {
          const retainedInBounds = rawRestroomsRef.current.filter((r) =>
            isCoordinateWithinBounds(r.latitude, r.longitude, options.activeBounds!)
          );
          const mergedMap = new Map<string, PublicRestroomSummary>();
          for (const prevItem of retainedInBounds) {
            mergedMap.set(prevItem.id, prevItem);
          }
          for (const nextItem of freshItems) {
            mergedMap.set(nextItem.id, nextItem);
          }
          finalItems = Array.from(mergedMap.values());
        }

        lastFetchedFilterTypeRef.current = targetType;
        setSearchedCenter(targetCenter);
        rawRestroomsRef.current = finalItems;
        setRawRestrooms(finalItems);
        onRestroomsLoaded?.(finalItems);
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

  // 현재 화면 영역의 미확보 후보 조회 + 카카오 실시간 참고 위치 보완 ('이 지역에서 재검색'·동일 영역 반복 검색 시 호출)
  const fetchAndResolveCandidates = useCallback(
    async (
      targetBounds: MapBounds,
      opts?: { allowCancelSameViewport?: boolean }
    ) => {
      const prevBounds = candidateViewportStateRef.current.bounds;
      const isSameViewport = Boolean(
        prevBounds &&
          Math.abs(prevBounds.south - targetBounds.south) < 0.0005 &&
          Math.abs(prevBounds.west - targetBounds.west) < 0.0005 &&
          Math.abs(prevBounds.north - targetBounds.north) < 0.0005 &&
          Math.abs(prevBounds.east - targetBounds.east) < 0.0005
      );

      // 동일 영역 반복 버튼 연타 등 이미 검색이 진행 중이면 중복 요청 방지
      if (
        isSameViewport &&
        isCandidateSearchingRef.current &&
        !opts?.allowCancelSameViewport
      ) {
        return;
      }

      if (candidateAbortRef.current) {
        candidateAbortRef.current.abort();
      }
      const controller = new AbortController();
      candidateAbortRef.current = controller;
      const seq = ++candidateSeqRef.current;

      if (isBoundsTooWideForCandidates(targetBounds)) {
        isCandidateSearchingRef.current = false;
        setIsCandidateSearching(false);
        commitCandidateRestrooms(() => []);
        setCandidateStatusNote(
          "지도를 더 확대하면 주소 기반 참고 화장실도 함께 조회할 수 있습니다."
        );
        return;
      }

      isCandidateSearchingRef.current = true;
      setIsCandidateSearching(true);

      // 동일 영역 재검색 시 기존 유효 핀은 모두 유지하고, 영역 이동 시에만 범위 밖 핀만 정리
      if (!isSameViewport) {
        setCandidateExhausted(false);
        candidateViewportStateRef.current = { bounds: targetBounds, nextCursor: null };
        commitCandidateRestrooms((prev) =>
          prev.filter((item) =>
            isCoordinateWithinBounds(item.latitude, item.longitude, targetBounds)
          )
        );
      }

      setCandidateStatusNote("주소 기반 후보 화장실 위치를 확인하는 중...");

      const sessionState = candidateSessionRef.current!;
      const completedSet = sessionState.completedIds ?? new Set<string>();
      const excludeIds = Array.from(completedSet).slice(-220);
      const deferredIds = Array.from(sessionState.transientFailedIds ?? [])
        .filter((id) => !completedSet.has(id))
        .slice(-50);
      const cursorToSend =
        deferredIds.length > 0
          ? `d:${deferredIds.join(",")}`
          : isSameViewport
            ? candidateViewportStateRef.current.nextCursor
            : null;

      try {
        const candidateResp = await candidateFetchFn(
          targetBounds,
          controller.signal,
          {
            cursor: cursorToSend,
            excludeIds,
          }
        );
        if (controller.signal.aborted || seq !== candidateSeqRef.current) {
          return;
        }

        if (candidateResp.tooWide) {
          commitCandidateRestrooms(() => []);
          setCandidateStatusNote(
            "지도 영역이 넓어 공식 DB 화장실만 표시합니다. 확대 후 다시 검색해 주세요."
          );
          return;
        }

        candidateViewportStateRef.current = {
          bounds: targetBounds,
          nextCursor: candidateResp.nextCursor ?? null,
        };

        if (!candidateResp.items || candidateResp.items.length === 0) {
          const retained = isSameViewport
            ? candidateRestroomsRef.current
            : commitCandidateRestrooms((prev) =>
                prev.filter((item) =>
                  isCoordinateWithinBounds(item.latitude, item.longitude, targetBounds)
                )
              );
          setCandidateExhausted(true);
          setCandidateStatusNote(
            retained.length > 0
              ? `현재 영역 추가 후보 탐색을 완료했습니다. (참고 위치 ${retained.length}곳 포함)`
              : "현재 영역에서 추가로 확인할 주소 기반 후보가 없습니다."
          );
          return;
        }

        const resolved = await candidateResolveFn(candidateResp.items, {
          bounds: targetBounds,
          officialRestrooms: rawRestroomsRef.current,
          sessionState,
          signal: controller.signal,
          onResolvedItem: (item) => {
            if (controller.signal.aborted || seq !== candidateSeqRef.current) {
              return;
            }
            const activeBounds = latestBoundsRef.current ?? targetBounds;
            if (
              !isSameViewport &&
              !isCoordinateWithinBounds(item.latitude, item.longitude, activeBounds)
            ) {
              return;
            }
            commitCandidateRestrooms((prev) => {
              if (prev.some((p) => p.id === item.id)) return prev;
              return [...prev, item];
            });
          },
        });

        if (
          controller.signal.aborted ||
          resolved.aborted ||
          seq !== candidateSeqRef.current
        ) {
          return;
        }

        const activeBounds = latestBoundsRef.current ?? targetBounds;
        const inBoundsNewItems = resolved.items.filter(
          (item) =>
            isSameViewport ||
            isCoordinateWithinBounds(item.latitude, item.longitude, activeBounds)
        );

        const merged = commitCandidateRestrooms((prev) => {
          const retained = isSameViewport
            ? prev
            : prev.filter((item) =>
                isCoordinateWithinBounds(item.latitude, item.longitude, activeBounds)
              );
          const mergedMap = new Map<string, PublicRestroomSummary>();
          for (const item of retained) {
            mergedMap.set(item.id, item);
          }
          for (const item of inBoundsNewItems) {
            mergedMap.set(item.id, item);
          }
          return Array.from(mergedMap.values());
        });
        const totalMergedCount = merged.length;
        const hasPendingRetries = (resolved.transientFailedIds?.length ?? 0) > 0;
        const exhaustedNow =
          candidateResp.hasMore === false &&
          !hasPendingRetries &&
          !resolved.rateLimited &&
          !resolved.quotaExceeded;

        if (resolved.rateLimited) {
          setCandidateLimitReason("rate_limit");
          setCandidateStatusNote(
            totalMergedCount > 0
              ? `요청 한도 초과로 추가 조회가 제한되었습니다. (참고 위치 ${totalMergedCount}곳 유지)`
              : "요청 한도 초과로 실시간 추가 조회가 제한되어 공식 DB 화장실만 표시합니다."
          );
        } else if (resolved.quotaExceeded) {
          setCandidateLimitReason("quota");
          setCandidateStatusNote(
            totalMergedCount > 0
              ? `참고 위치 ${totalMergedCount}곳 표시 중 (실시간 조회 한도 도달로 일부 제한)`
              : "실시간 위치 조회 한도에 도달해 공식 DB 화장실만 표시합니다."
          );
        } else if (exhaustedNow) {
          setCandidateExhausted(true);
          setCandidateStatusNote(
            totalMergedCount > 0
              ? `현재 영역 추가 후보 탐색을 완료했습니다. (참고 위치 ${totalMergedCount}곳 포함)`
              : "현재 영역에서 추가로 확인할 주소 기반 후보가 없습니다."
          );
        } else if (totalMergedCount > 0) {
          setCandidateStatusNote(
            `공식 위치 외 주소 기반 참고 위치 ${totalMergedCount}곳이 포함되었습니다.`
          );
        } else if (resolved.failedCount > 0) {
          setCandidateStatusNote(
            "실시간 위치 확인에 일시 오류가 있어 공식 DB 화장실만 표시합니다."
          );
        } else {
          setCandidateStatusNote(null);
        }
      } catch (err: unknown) {
        if (
          controller.signal.aborted ||
          seq !== candidateSeqRef.current ||
          (err instanceof DOMException && err.name === "AbortError")
        ) {
          return;
        }
        const retained = isSameViewport
          ? candidateRestroomsRef.current
          : commitCandidateRestrooms((prev) =>
              prev.filter((item) =>
                isCoordinateWithinBounds(item.latitude, item.longitude, targetBounds)
              )
            );
        if (retained.length > 0) {
          setCandidateStatusNote(
            `공식 위치 외 주소 기반 참고 위치 ${retained.length}곳이 포함되었습니다.`
          );
        } else {
          setCandidateStatusNote(
            "주소 기반 참고 위치를 불러오지 못해 공식 DB 화장실만 표시합니다."
          );
        }
      } finally {
        if (seq === candidateSeqRef.current) {
          isCandidateSearchingRef.current = false;
          setIsCandidateSearching(false);
        }
      }
    },
    [candidateFetchFn, candidateResolveFn, commitCandidateRestrooms]
  );

  // 최초 마운트 시 현재 지도 중심 기준으로 1회만 조회 (공식 DB 핀 즉시 표시)
  useEffect(() => {
    fetchRestrooms(SUWON_DEFAULT_CENTER, filterType);
    const sessionState = candidateSessionRef.current;

    const handleSessionExit = () => {
      if (sessionState) {
        clearCandidateResolverSessionState(sessionState);
      }
    };
    window.addEventListener("pagehide", handleSessionExit);

    return () => {
      window.removeEventListener("pagehide", handleSessionExit);
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (candidateAbortRef.current) {
        candidateAbortRef.current.abort();
      }
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
      if (sessionState) {
        clearCandidateResolverSessionState(sessionState);
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

  // 지도 bounds 변경 시: 진행 중 후보 요청 무효화 + 자동 재조회 없이 수동 재검색 버튼만 표시
  const handleBoundsChanged = useCallback((newBounds: MapBounds) => {
    latestBoundsRef.current = newBounds;
    setViewportBounds(newBounds);
    const vc = boundsCenter(newBounds);
    currentMapCenterRef.current = vc;

    const last = lastMoveRef.current;
    const isProgrammaticMove =
      Date.now() - last.at <= PROGRAMMATIC_MOVE_GRACE_MS &&
      haversineMeters(vc, last.point) <= PROGRAMMATIC_MOVE_TOLERANCE_M;

    if (!isProgrammaticMove) {
      if (candidateAbortRef.current) {
        candidateAbortRef.current.abort();
      }
      isCandidateSearchingRef.current = false;
      setIsCandidateSearching(false);
      setCandidateExhausted(false);
      candidateSeqRef.current += 1;
      setShowSearchHere(true);
      if (haversineMeters(vc, last.point) > MANUAL_PAN_THRESHOLD_M) {
        setAnchorMode("center");
      }
    }
  }, []);

  // 지도 줌 변경 시: 진행 중 후보 요청 무효화 + 수동 재검색 버튼 표시 + 현재 화면 영역 갱신
  const handleZoomChanged = useCallback((newZoom: number) => {
    setZoomLevel(newZoom);
    try {
      const b = mapProviderRef.current?.getBounds();
      if (b) {
        latestBoundsRef.current = b;
        setViewportBounds(b);
      }
    } catch {
      // mock 또는 초기화 전 무시
    }
    const last = lastZoomRef.current;
    const isProgrammaticZoom =
      Date.now() - last.at <= PROGRAMMATIC_MOVE_GRACE_MS &&
      last.zoom === newZoom;
    if (!isProgrammaticZoom) {
      if (candidateAbortRef.current) {
        candidateAbortRef.current.abort();
      }
      isCandidateSearchingRef.current = false;
      setIsCandidateSearching(false);
      setCandidateExhausted(false);
      candidateSeqRef.current += 1;
      setShowSearchHere(true);
    }
  }, []);

  // zoomLevel 상태 변경 후 맵 엔진의 실제 bounds와 화면 표시 개수 동기화
  useEffect(() => {
    if (!isMapReadyRef.current || !mapProviderRef.current) return;
    try {
      const b = mapProviderRef.current.getBounds();
      if (b) {
        latestBoundsRef.current = b;
        setViewportBounds(b);
      }
    } catch {
      // 무시
    }
  }, [zoomLevel]);

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
      setCandidateExhausted(false);
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
      setCandidateExhausted(false);
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
      setCandidateExhausted(false);
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

  // 기준점으로부터의 거리순 정렬 (현재 지도 영역 내 실제 표시 대상만 집계·중복 제거)
  const { filteredRestrooms, distancesById } = useMemo(() => {
    const seenCandidateHashes = new Set<string>();
    const dedupedCandidates =
      filterType === "partner"
        ? []
        : candidateRestrooms.filter((cand) => {
            const fHash = cand.candidate_meta?.facility_hash;
            if (fHash) {
              const dedupeKey = `${fHash}:${cand.name}`;
              if (seenCandidateHashes.has(dedupeKey)) return false;
              seenCandidateHashes.add(dedupeKey);
            }
            if (!cand.candidate_meta) return true;
            return !isResolvedCandidateDuplicateOfOfficial(
              {
                id: cand.id.replace(/^candidate:/, ""),
                source_provider: cand.candidate_meta.source_provider,
                source_dataset_id: cand.candidate_meta.source_dataset_id,
                source_record_id: cand.id,
                name: cand.name,
                normalized_name: cand.name,
                road_address: cand.road_address,
                jibun_address: null,
                normalized_address: cand.road_address,
                sido_code: "",
                sigungu_code: "",
                eupmyeondong_code: null,
                sido_name: cand.candidate_meta.sido_name,
                sigungu_name: cand.candidate_meta.sigungu_name,
                eupmyeondong_name: cand.candidate_meta.eupmyeondong_name,
                facility_type: null,
                open_hours: cand.candidate_meta.open_hours,
                closed_days: cand.candidate_meta.closed_days,
                gender_type: cand.gender_type,
                wheelchair_accessible: cand.wheelchair_accessible,
                baby_changing_available: cand.baby_changing_available,
                coordinate_status: "unlocated",
                facility_hash: cand.candidate_meta.facility_hash,
                source_base_date: cand.candidate_meta.source_base_date,
                attribution_text: cand.candidate_meta.attribution_text,
              },
              cand.latitude,
              cand.longitude,
              rawRestrooms
            );
          });

    const uniqueById = new Map<string, PublicRestroomSummary>();
    for (const r of [...rawRestrooms, ...dedupedCandidates]) {
      if (!uniqueById.has(r.id)) {
        uniqueById.set(r.id, r);
      }
    }
    let list: PublicRestroomSummary[] = Array.from(uniqueById.values());
    if (filterType === "public") {
      list = list.filter((r) => r.type === "public");
    } else if (filterType === "partner") {
      list = list.filter((r) => r.type === "partner");
    }

    // 현재 지도 영역(bounds) 밖 핀은 표시 목록과 개수 집계에서 제외 (직접 선택한 고정 핀은 이동 애니메이션 중 유지)
    if (viewportBounds) {
      list = list.filter(
        (r) =>
          isCoordinateWithinBounds(r.latitude, r.longitude, viewportBounds) ||
          r.id === pinnedSearchRestroom?.id
      );
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
    // 동일 거리 또는 근접 시 공식 DB 핀을 참고 위치보다 우선 표시
    withDistance.sort((a, b) => {
      const distDiff = a.d - b.d;
      if (Math.abs(distDiff) > 0.5) return distDiff;
      const aRank = a.r.location_kind === "candidate_reference" ? 1 : 0;
      const bRank = b.r.location_kind === "candidate_reference" ? 1 : 0;
      if (aRank !== bRank) return aRank - bRank;
      return a.r.id.localeCompare(b.r.id);
    });

    return {
      filteredRestrooms: withDistance.map((x) => x.r),
      distancesById: distances,
    };
  }, [rawRestrooms, candidateRestrooms, filterType, reference, searchedCenter, viewportBounds, pinnedSearchRestroom]);


  // 선택된 화장실 객체
  const selectedRestroom = useMemo(() => {
    if (!selectedRestroomId) return null;
    return (
      rawRestrooms.find((r) => r.id === selectedRestroomId) ??
      candidateRestrooms.find((r) => r.id === selectedRestroomId) ??
      (pinnedSearchRestroom?.id === selectedRestroomId
        ? pinnedSearchRestroom
        : null)
    );
  }, [rawRestrooms, candidateRestrooms, selectedRestroomId, pinnedSearchRestroom]);

  // 화장실 카드가 바텀시트에 실제 노출될 때 restroom_card_viewed 기록
  useEffect(() => {
    if (selectedRestroom) {
      trackCardViewed({
        restroom: selectedRestroom,
        source: selectionSourceRef.current,
      });
    }
  }, [selectedRestroom, trackCardViewed]);

  // 마커 목록 생성 (동일·초근접 좌표 마커 겹침 시 표시 위치만 미세 분산해 모든 핀이 보이도록 유지)
  const markers: MarkerOptions[] = useMemo(() => {
    const validItems = filteredRestrooms.filter(
      (r) => r.latitude !== null && r.longitude !== null
    );
    const coordGroups = new Map<string, number[]>();
    validItems.forEach((r, idx) => {
      const bucketKey = `${Math.round(r.latitude / 0.00004)}:${Math.round(r.longitude / 0.00005)}`;
      const arr = coordGroups.get(bucketKey) ?? [];
      arr.push(idx);
      coordGroups.set(bucketKey, arr);
    });
    const positionOverrides = new Map<number, LatLng>();
    for (const indices of coordGroups.values()) {
      if (indices.length <= 1) continue;
      const count = indices.length;
      indices.forEach((itemIdx, posIdx) => {
        const base = validItems[itemIdx];
        const angle = (2 * Math.PI * posIdx) / count;
        const radiusDeg = 0.000065;
        positionOverrides.set(itemIdx, {
          lat: base.latitude + Math.sin(angle) * radiusDeg,
          lng: base.longitude + Math.cos(angle) * (radiusDeg * 1.15),
        });
      });
    }

    const list: MarkerOptions[] = validItems.map((r, index) => {
      const isCandRef = r.location_kind === "candidate_reference";
      const displayPos = positionOverrides.get(index) ?? {
        lat: r.latitude,
        lng: r.longitude,
      };
      return {
        id: r.id,
        position: displayPos,
        title: isCandRef
          ? `[참고위치] ${r.name}`
          : `[${r.type === "partner" ? "제휴" : "공공"}] ${r.name}`,
        type: isCandRef ? "candidate_reference" : r.type,
        selected: r.id === selectedRestroomId,
        zIndex: r.id === selectedRestroomId ? 15 : isCandRef ? 1 : 2,
        onClick: (id: string) => {
          trackBasicMarkerClicked();
          if (!isCandRef) {
            trackMarkerClicked({
              restroom: r,
              markerIndex: index,
            });
          }
          selectionSourceRef.current = "marker_selection";
          setSelectedRestroomId(id);
          setIsSheetExpanded(false);
          // 선택된 화장실로 지도 부드럽게 이동
          moveTo({ lat: r.latitude, lng: r.longitude });
        },
      };
    });

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

  // 이 지역에서 재검색 버튼 핸들러 (공식 DB 우선 조회 + 참고 위치 실시간 통합)
  const handleSearchHereClick = useCallback(() => {
    setAnchorMode("center");
    setShowSearchHere(false);
    const targetCenter = currentMapCenterRef.current;
    let providerBounds: MapBounds | null = null;
    try {
      providerBounds = mapProviderRef.current?.getBounds() ?? null;
    } catch {
      providerBounds = null;
    }
    const activeBounds =
      providerBounds ??
      latestBoundsRef.current ??
      approximateBoundsFromCenter(targetCenter, zoomLevel);
    latestBoundsRef.current = activeBounds;
    setViewportBounds(activeBounds);

    fetchRestrooms(targetCenter, filterType, {
      preserveInBounds: true,
      activeBounds,
    });
    if (filterType !== "partner") {
      fetchAndResolveCandidates(activeBounds, { allowCancelSameViewport: true });
    } else {
      commitCandidateRestrooms(() => []);
      setCandidateStatusNote(null);
    }
  }, [commitCandidateRestrooms, fetchAndResolveCandidates, fetchRestrooms, filterType, zoomLevel]);

  // 지도 이동 없이 동일 영역 반복 재검색 핸들러 (미검색 후보 순환 + 중복 호출 방지)
  const handleRepeatSearchSameArea = useCallback(() => {
    if (
      isCandidateSearchingRef.current ||
      isLoading ||
      filterType === "partner" ||
      candidateExhausted ||
      candidateLimitReason !== null
    ) {
      return;
    }
    const targetCenter = currentMapCenterRef.current;
    let providerBounds: MapBounds | null = null;
    try {
      providerBounds = mapProviderRef.current?.getBounds() ?? null;
    } catch {
      providerBounds = null;
    }
    const activeBounds =
      providerBounds ??
      latestBoundsRef.current ??
      approximateBoundsFromCenter(targetCenter, zoomLevel);
    latestBoundsRef.current = activeBounds;
    setViewportBounds(activeBounds);
    fetchAndResolveCandidates(activeBounds);
  }, [
    candidateExhausted,
    candidateLimitReason,
    fetchAndResolveCandidates,
    filterType,
    isLoading,
    zoomLevel,
  ]);

  // 줌 제어 핸들러 (진행 중 후보 요청 무효화 + 자동 재조회 없이 수동 재검색 버튼 표시)
  const handleZoomIn = () => {
    const next = Math.max(1, zoomLevel - 1); // 카카오맵은 레벨이 작을수록 확대
    if (next !== zoomLevel) {
      if (candidateAbortRef.current) {
        candidateAbortRef.current.abort();
      }
      isCandidateSearchingRef.current = false;
      setIsCandidateSearching(false);
      setCandidateExhausted(false);
      candidateSeqRef.current += 1;
      lastZoomRef.current = { zoom: next, at: Date.now() };
      setZoomLevel(next);
      setShowSearchHere(true);
    }
  };

  const handleZoomOut = () => {
    const next = Math.min(14, zoomLevel + 1);
    if (next !== zoomLevel) {
      if (candidateAbortRef.current) {
        candidateAbortRef.current.abort();
      }
      isCandidateSearchingRef.current = false;
      setIsCandidateSearching(false);
      setCandidateExhausted(false);
      candidateSeqRef.current += 1;
      lastZoomRef.current = { zoom: next, at: Date.now() };
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

        {/* 지도 이동·확대·축소 시 또는 동일 영역 반복 탐색 버튼 (상단 중앙) */}
        {showSearchHere ? (
          <div className="mt-2 flex justify-center pointer-events-none">
            <button
              type="button"
              onClick={handleSearchHereClick}
              data-testid="search-this-area-btn"
              className="pointer-events-auto inline-flex min-h-[36px] max-w-[calc(100vw-24px)] items-center gap-1.5 rounded-full bg-slate-900/95 px-4 py-1.5 text-xs font-semibold text-white shadow-lg backdrop-blur-sm transition hover:bg-slate-800 active:scale-95 dark:bg-white/95 dark:text-slate-900"
            >
              <span aria-hidden="true">🔄</span>
              <span className="truncate">이 지역에서 재검색</span>
            </button>
          </div>
        ) : filterType !== "partner" && (
          <div className="mt-2 flex justify-center pointer-events-none">
            {isCandidateSearching ? (
              <button
                type="button"
                disabled
                data-testid="search-more-candidates-btn"
                className="pointer-events-auto inline-flex min-h-[34px] max-w-[calc(100vw-24px)] items-center gap-1.5 rounded-full bg-slate-800/90 px-3.5 py-1 text-xs font-medium text-white shadow-md backdrop-blur-sm opacity-80 dark:bg-slate-200/90 dark:text-slate-900"
              >
                <span aria-hidden="true">⏳</span>
                <span className="truncate">주변 화장실 찾는 중...</span>
              </button>
            ) : candidateLimitReason === "rate_limit" ? (
              <div
                data-testid="candidate-search-status-pill"
                role="status"
                className="pointer-events-auto inline-flex min-h-[32px] max-w-[calc(100vw-24px)] items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50/95 px-3.5 py-1 text-[11px] font-semibold text-amber-900 shadow-sm backdrop-blur-sm dark:border-amber-800 dark:bg-amber-950/90 dark:text-amber-200"
              >
                <span className="truncate">⚠️ 요청 한도 초과로 추가 조회 제한</span>
              </div>
            ) : candidateLimitReason === "quota" ? (
              <div
                data-testid="candidate-search-status-pill"
                role="status"
                className="pointer-events-auto inline-flex min-h-[32px] max-w-[calc(100vw-24px)] items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50/95 px-3.5 py-1 text-[11px] font-semibold text-amber-900 shadow-sm backdrop-blur-sm dark:border-amber-800 dark:bg-amber-950/90 dark:text-amber-200"
              >
                <span className="truncate">ℹ️ 실시간 조회 한도(60회) 도달</span>
              </div>
            ) : candidateExhausted ? (
              <div
                data-testid="candidate-search-status-pill"
                role="status"
                className="pointer-events-auto inline-flex min-h-[32px] max-w-[calc(100vw-24px)] items-center gap-1.5 rounded-full border border-slate-300 bg-white/95 px-3.5 py-1 text-[11px] font-medium text-slate-700 shadow-sm backdrop-blur-sm dark:border-slate-700 dark:bg-slate-800/95 dark:text-slate-200"
              >
                <span className="truncate">✓ 현재 영역 추가 후보 탐색 완료</span>
              </div>
            ) : !(viewportBounds && isBoundsTooWideForCandidates(viewportBounds)) ? (
              <button
                type="button"
                onClick={handleRepeatSearchSameArea}
                disabled={isLoading}
                data-testid="search-more-candidates-btn"
                className="pointer-events-auto inline-flex min-h-[34px] max-w-[calc(100vw-24px)] items-center gap-1.5 rounded-full border border-slate-200 bg-white/95 px-3.5 py-1 text-xs font-semibold text-slate-800 shadow-md backdrop-blur-sm transition hover:bg-slate-50 active:scale-95 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800/95 dark:text-slate-100"
              >
                <span aria-hidden="true">🔄</span>
                <span className="truncate">같은 지역 더 찾아보기</span>
              </button>
            ) : null}
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
            try {
              const initialBounds = provider.getBounds();
              if (initialBounds) {
                latestBoundsRef.current = initialBounds;
                setViewportBounds(initialBounds);
              }
            } catch {
              // mock 또는 미지원 환경 무시
            }
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
        candidateStatusNote={candidateStatusNote}
      />

      {/* 길찾기 3사 연결 모달 */}
      <MapDirectionsModal
        isOpen={Boolean(directionsTarget)}
        onClose={() => setDirectionsTarget(null)}
        onDirectionsClick={(service) => {
          trackBasicDirectionsClicked();
          if (directionsTarget && directionsTarget.location_kind !== "candidate_reference") {
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
                locationKind: directionsTarget.location_kind,
                locationPrecision: directionsTarget.location_precision,
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

