"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  LatLng,
  MapBounds,
  MapOptions,
  MapProvider,
  MapSdkStatus,
  MarkerOptions,
  SUWON_DEFAULT_CENTER,
  DEFAULT_ZOOM_LEVEL,
} from "@/lib/maps/types";
import { KakaoMapProvider } from "@/lib/maps/kakao-provider";
import { getKakaoMapApiKey } from "@/lib/maps/kakao-sdk";

export interface MapCanvasProps {
  readonly center?: LatLng;
  readonly zoomLevel?: number;
  readonly minZoomLevel?: number;
  readonly maxZoomLevel?: number;
  readonly markers?: readonly MarkerOptions[];
  readonly className?: string;
  /** 커스텀 지도 제공자 주입 (테스트 및 Google Maps 교체 지원) */
  readonly providerFactory?: () => MapProvider;
  /** 지도 초기화 완료 콜백 */
  readonly onMapReady?: (provider: MapProvider) => void;
  readonly onCenterChanged?: (center: LatLng) => void;
  readonly onBoundsChanged?: (bounds: MapBounds) => void;
  readonly onZoomChanged?: (zoomLevel: number) => void;
  readonly onClick?: (position: LatLng) => void;
  readonly onStatusChange?: (status: MapSdkStatus, error?: string) => void;
}

export default function MapCanvas({
  center = SUWON_DEFAULT_CENTER,
  zoomLevel = DEFAULT_ZOOM_LEVEL,
  minZoomLevel,
  maxZoomLevel,
  markers = [],
  className = "w-full h-full min-h-[360px]",
  providerFactory,
  onMapReady,
  onCenterChanged,
  onBoundsChanged,
  onZoomChanged,
  onClick,
  onStatusChange,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const providerRef = useRef<MapProvider | null>(null);
  const isMountedRef = useRef<boolean>(false);
  const [status, setStatus] = useState<MapSdkStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const updateStatus = useCallback(
    (newStatus: MapSdkStatus, error?: string) => {
      setStatus(newStatus);
      setErrorMessage(error ?? null);
      onStatusChange?.(newStatus, error);
    },
    [onStatusChange]
  );

  const initMap = useCallback(async () => {
    if (!containerRef.current) return;

    // 커스텀 providerFactory가 없는 경우 카카오 API 키 검증
    if (!providerFactory) {
      const apiKey = getKakaoMapApiKey();
      if (!apiKey) {
        updateStatus(
          "missing_key",
          "NEXT_PUBLIC_KAKAO_MAP_JS_KEY 환경변수가 설정되지 않았습니다."
        );
        return;
      }
    }

    updateStatus("loading");

    try {
      const provider = providerFactory
        ? providerFactory()
        : new KakaoMapProvider();

      const options: MapOptions = {
        center,
        zoomLevel,
        minZoomLevel,
        maxZoomLevel,
        onCenterChanged,
        onBoundsChanged,
        onZoomChanged,
        onClick,
      };

      await provider.init(containerRef.current, options);

      if (!isMountedRef.current) {
        provider.destroy();
        return;
      }

      if (markers.length > 0) {
        provider.setMarkers(markers);
      }

      providerRef.current = provider;
      updateStatus("ready");
      onMapReady?.(provider);
    } catch (err) {
      if (!isMountedRef.current) return;
      const message =
        err instanceof Error
          ? err.message
          : "지도 엔진을 초기화하는 중 오류가 발생했습니다.";
      updateStatus("error", message);
    }
  }, [
    center,
    zoomLevel,
    minZoomLevel,
    maxZoomLevel,
    markers,
    providerFactory,
    onCenterChanged,
    onBoundsChanged,
    onZoomChanged,
    onClick,
    onMapReady,
    updateStatus,
  ]);

  useEffect(() => {
    isMountedRef.current = true;

    // Next.js 클라이언트 사이드 마운트 후 초기화
    if (typeof window !== "undefined") {
      initMap();
    }

    return () => {
      isMountedRef.current = false;
      if (providerRef.current) {
        providerRef.current.destroy();
        providerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 중심 좌표 외부 변경 동기화
  useEffect(() => {
    if (status === "ready" && providerRef.current) {
      try {
        const currentCenter = providerRef.current.getCenter();
        if (
          Math.abs(currentCenter.lat - center.lat) > 0.000001 ||
          Math.abs(currentCenter.lng - center.lng) > 0.000001
        ) {
          providerRef.current.setCenter(center, true);
        }
      } catch {
        // 이미 파괴되었거나 상태 불일치 시 무시
      }
    }
  }, [center, status]);

  // 줌 레벨 외부 변경 동기화
  useEffect(() => {
    if (status === "ready" && providerRef.current) {
      try {
        if (providerRef.current.getZoomLevel() !== zoomLevel) {
          providerRef.current.setZoomLevel(zoomLevel);
        }
      } catch {
        // 무시
      }
    }
  }, [zoomLevel, status]);

  // 마커 외부 변경 동기화
  useEffect(() => {
    if (status === "ready" && providerRef.current) {
      try {
        providerRef.current.setMarkers(markers);
      } catch {
        // 무시
      }
    }
  }, [markers, status]);

  const hasPositionClass = /\b(absolute|fixed|sticky|relative)\b/.test(className);

  return (
    <div
      className={`${hasPositionClass ? "" : "relative "}overflow-hidden bg-slate-100 dark:bg-slate-900 ${className}`}
      data-testid="map-canvas-container"
      data-sdk-status={status}
    >
      {/* 실제 지도 렌더링 컨테이너 */}
      <div
        ref={containerRef}
        className="w-full h-full min-h-[360px]"
        style={{ minHeight: "inherit" }}
        data-testid="map-canvas-viewport"
      />

      {/* 설정 부족 안내 (API 키 부재 시) */}
      {status === "missing_key" && (
        <div
          className="absolute inset-0 z-10 flex flex-col items-center justify-center p-6 text-center bg-slate-50/95 dark:bg-slate-900/95 backdrop-blur-sm"
          data-testid="map-missing-key-banner"
        >
          <div className="mb-3 text-4xl">🗺️</div>
          <h3 className="mb-2 text-base font-semibold text-slate-800 dark:text-slate-100">
            지도 연동 설정 필요
          </h3>
          <p className="mb-3 max-w-sm text-xs leading-relaxed text-slate-600 dark:text-slate-300">
            카카오 지도 JavaScript API 키가 설정되지 않았습니다.
            <br />
            실제 지도를 표시하려면 외부 서비스 키 발급 및 설정이 필요합니다.
          </p>
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-left text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
            <p className="font-medium">📌 설정 안내</p>
            <ol className="mt-1 list-decimal pl-4 space-y-1">
              <li>
                Kakao Developers 콘솔에서 앱 생성 및 플랫폼 웹 도메인(
                <code className="rounded bg-amber-100 px-1 dark:bg-amber-900">
                  http://localhost:3000
                </code>
                ) 등록
              </li>
              <li>
                <code className="rounded bg-amber-100 px-1 dark:bg-amber-900">
                  .env.local
                </code>
                에 <code className="font-mono">NEXT_PUBLIC_KAKAO_MAP_JS_KEY</code>{" "}
                입력
              </li>
              <li>개발 서버 재시작</li>
            </ol>
          </div>
          <span className="rounded-full bg-slate-200 px-3 py-1 text-[11px] font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">
            안전 모드 (가짜 지도 생성 방지됨)
          </span>
        </div>
      )}

      {/* 로딩 인디케이터 */}
      {status === "loading" && (
        <div
          className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-slate-100/80 dark:bg-slate-900/80 backdrop-blur-xs"
          data-testid="map-loading-indicator"
        >
          <div className="h-8 w-8 animate-spin rounded-full border-3 border-blue-600 border-t-transparent" />
          <p className="mt-3 text-xs text-slate-600 dark:text-slate-400">
            지도를 불러오는 중...
          </p>
        </div>
      )}

      {/* 에러 상태 안내 */}
      {status === "error" && (
        <div
          className="absolute inset-0 z-10 flex flex-col items-center justify-center p-6 text-center bg-red-50/95 dark:bg-red-950/90"
          data-testid="map-error-banner"
        >
          <div className="mb-2 text-3xl">⚠️</div>
          <h3 className="mb-1 text-sm font-semibold text-red-800 dark:text-red-200">
            지도를 불러오지 못했습니다
          </h3>
          <p className="mb-4 max-w-xs text-xs text-red-600 dark:text-red-300">
            {errorMessage || "네트워크 상태나 도메인 등록 설정을 확인해 주세요."}
          </p>
          <button
            type="button"
            onClick={initMap}
            className="rounded-lg bg-red-600 px-4 py-2 text-xs font-medium text-white shadow-sm hover:bg-red-700 focus:outline-none"
          >
            다시 시도
          </button>
        </div>
      )}
    </div>
  );
}

