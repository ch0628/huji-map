/**
 * 외부 지도 앱/웹 길찾기 및 위치 바로보기 URL 생성 헬퍼
 *
 * 공식 명세 및 검증:
 * 1. 카카오맵 길찾기: https://map.kakao.com/link/to/{name},{lat},{lng}
 *    - name은 URI 인코딩 적용
 *    - lat, lng는 WGS84 소수점 좌표
 * 2. 네이버 지도 길찾기: https://map.naver.com/index.nhn?elng={lng}&elat={lat}&etext={name}&menu=route
 *    - 네이버는 경도(elng)가 먼저 오는 파라미터 구조 지원
 * 3. 구글 지도 길찾기: https://www.google.com/maps/dir/?api=1&destination={lat},{lng}
 */

import { LatLng, isValidLatLng } from "./types";

export interface DirectionsTarget {
  readonly name: string;
  readonly coords: LatLng;
}

export interface DirectionsOrigin {
  readonly name?: string;
  readonly coords: LatLng;
}

export interface DirectionLinks {
  readonly kakao: string;
  readonly naver: string;
  readonly google: string;
}

/**
 * 카카오맵 목적지 길찾기 URL 생성
 */
export function buildKakaoMapDirectionsUrl(
  target: DirectionsTarget,
  origin?: DirectionsOrigin
): string {
  if (!isValidLatLng(target.coords)) {
    throw new Error("Invalid target coordinates for Kakao directions URL");
  }

  const encodedTargetName = encodeURIComponent(target.name.trim() || "목적지");
  const targetPath = `${encodedTargetName},${target.coords.lat},${target.coords.lng}`;

  if (origin && isValidLatLng(origin.coords)) {
    const encodedOriginName = encodeURIComponent(
      origin.name?.trim() || "현재위치"
    );
    const originPath = `${encodedOriginName},${origin.coords.lat},${origin.coords.lng}`;
    // 카카오맵 공식 다중 경로 링크: /link/to/{to}/from/{from}
    return `https://map.kakao.com/link/to/${targetPath}/from/${originPath}`;
  }

  // 기본 목적지 길찾기 링크: /link/to/{to}
  return `https://map.kakao.com/link/to/${targetPath}`;
}

/**
 * 네이버 지도 목적지 길찾기 URL 생성
 */
export function buildNaverMapDirectionsUrl(
  target: DirectionsTarget,
  origin?: DirectionsOrigin
): string {
  if (!isValidLatLng(target.coords)) {
    throw new Error("Invalid target coordinates for Naver directions URL");
  }

  const targetName = target.name.trim() || "목적지";
  const params = new URLSearchParams({
    elng: target.coords.lng.toString(),
    elat: target.coords.lat.toString(),
    etext: targetName,
    menu: "route",
  });

  if (origin && isValidLatLng(origin.coords)) {
    params.set("slng", origin.coords.lng.toString());
    params.set("slat", origin.coords.lat.toString());
    params.set("stext", origin.name?.trim() || "현재위치");
  }

  return `https://map.naver.com/index.nhn?${params.toString()}`;
}

/**
 * 구글 지도 목적지 길찾기 URL 생성
 */
export function buildGoogleMapsDirectionsUrl(
  target: DirectionsTarget,
  origin?: DirectionsOrigin
): string {
  if (!isValidLatLng(target.coords)) {
    throw new Error("Invalid target coordinates for Google directions URL");
  }

  const params = new URLSearchParams({
    api: "1",
    destination: `${target.coords.lat},${target.coords.lng}`,
  });

  if (origin && isValidLatLng(origin.coords)) {
    params.set("origin", `${origin.coords.lat},${origin.coords.lng}`);
  }

  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/**
 * 제공자 3사 길찾기 URL 일괄 생성
 */
export function buildAllDirectionUrls(
  target: DirectionsTarget,
  origin?: DirectionsOrigin
): DirectionLinks {
  return {
    kakao: buildKakaoMapDirectionsUrl(target, origin),
    naver: buildNaverMapDirectionsUrl(target, origin),
    google: buildGoogleMapsDirectionsUrl(target, origin),
  };
}
