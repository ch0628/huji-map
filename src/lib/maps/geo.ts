/**
 * 지도 거리 계산 및 서비스 지역 판별 유틸 (순수 함수, SSR 안전)
 */
import type { LatLng, MapBounds } from "./types";

/** 현재 화장실 데이터가 제공되는 수원시 대략 범위 (여유 마진 포함) */
export const SUWON_SERVICE_BOUNDS: MapBounds = Object.freeze({
  south: 37.2,
  west: 126.92,
  north: 37.35,
  east: 127.12,
});

export const OUT_OF_SERVICE_MESSAGE =
  "현재 휴지맵은 수원시의 화장실 정보를 제공하고 있어요.";

/** 두 WGS84 좌표 간 거리(m) - Haversine */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 거리 표시 문자열: 1km 미만은 m, 이상은 km(소수 1자리) */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "";
  if (meters < 1000) return `${Math.round(meters / 10) * 10 || Math.round(meters)}m`;
  return `${(meters / 1000).toFixed(1)}km`;
}

export function isInServiceArea(point: LatLng): boolean {
  const b = SUWON_SERVICE_BOUNDS;
  return (
    point.lat >= b.south &&
    point.lat <= b.north &&
    point.lng >= b.west &&
    point.lng <= b.east
  );
}

export function boundsCenter(bounds: MapBounds): LatLng {
  return {
    lat: (bounds.south + bounds.north) / 2,
    lng: (bounds.west + bounds.east) / 2,
  };
}

/** 지정 좌표 주변 약 radiusDeg 도 범위의 BBox */
export function bboxAround(point: LatLng, radiusLat = 0.012, radiusLng = 0.015): MapBounds {
  return {
    south: point.lat - radiusLat,
    north: point.lat + radiusLat,
    west: point.lng - radiusLng,
    east: point.lng + radiusLng,
  };
}
