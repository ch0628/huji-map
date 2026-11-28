/**
 * 브라우저 Geolocation API 안전 래퍼
 *
 * 원칙:
 * 1. SSR 환경에서는 navigator.geolocation을 직접 참조하지 않는다.
 * 2. 권한 거부(PERMISSION_DENIED) 및 시간 초과(TIMEOUT) 시 예외가 앱 전체를 충돌시키지 않도록
 *    정형화된 결과(Result 패턴)를 반환한다.
 * 3. 위치를 가져오지 못한 경우 안전한 기본 좌표(수원시 중심)로 대체할 수 있는 옵션을 제공한다.
 */

import { LatLng, SUWON_DEFAULT_CENTER, isValidLatLng } from "./types";

export type GeolocationErrorCode =
  | "UNSUPPORTED"
  | "PERMISSION_DENIED"
  | "POSITION_UNAVAILABLE"
  | "TIMEOUT"
  | "INVALID_COORDINATES"
  | "UNKNOWN";

export interface GeolocationResult {
  readonly success: boolean;
  readonly coords: LatLng;
  readonly error?: {
    readonly code: GeolocationErrorCode;
    readonly message: string;
  };
}

const ERROR_MESSAGES: Record<GeolocationErrorCode, string> = {
  UNSUPPORTED: "현재 브라우저에서 위치 서비스를 지원하지 않습니다.",
  PERMISSION_DENIED: "위치 정보 접근 권한이 거부되었습니다.",
  POSITION_UNAVAILABLE: "현재 위치 정보를 확인할 수 없습니다.",
  TIMEOUT: "위치 정보 확인 시간이 초과되었습니다.",
  INVALID_COORDINATES: "유효하지 않은 좌표가 감지되었습니다.",
  UNKNOWN: "위치 정보를 가져오는 중 알 수 없는 오류가 발생했습니다.",
};

export type GeolocationPermissionState =
  | "granted"
  | "denied"
  | "prompt"
  | "unknown";

/**
 * 브라우저 위치 권한 상태 안전 조회 (Permissions API 미지원 시 'unknown')
 */
export async function getGeolocationPermissionState(): Promise<GeolocationPermissionState> {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return "unknown";
  }
  const permissions = (
    navigator as Navigator & {
      permissions?: {
        query?: (desc: { name: PermissionName }) => Promise<{ state: string }>;
      };
    }
  ).permissions;
  if (!permissions || typeof permissions.query !== "function") {
    return "unknown";
  }
  try {
    const status = await permissions.query({
      name: "geolocation" as PermissionName,
    });
    if (
      status.state === "granted" ||
      status.state === "denied" ||
      status.state === "prompt"
    ) {
      return status.state;
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * 브라우저 현재 위치 조회 (권한 검증 및 에러 안전 처리)
 */
export async function getCurrentUserLocation(options?: {
  readonly timeoutMs?: number;
  readonly highAccuracy?: boolean;
  readonly maximumAgeMs?: number;
  readonly fallback?: LatLng;
}): Promise<GeolocationResult> {
  const fallback = options?.fallback ?? SUWON_DEFAULT_CENTER;

  // SSR 환경 방어
  if (typeof window === "undefined" || !("navigator" in window)) {
    return {
      success: false,
      coords: fallback,
      error: {
        code: "UNSUPPORTED",
        message: ERROR_MESSAGES.UNSUPPORTED,
      },
    };
  }

  if (!("geolocation" in navigator) || !navigator.geolocation) {
    return {
      success: false,
      coords: fallback,
      error: {
        code: "UNSUPPORTED",
        message: ERROR_MESSAGES.UNSUPPORTED,
      },
    };
  }

  const geoOptions: PositionOptions = {
    enableHighAccuracy: options?.highAccuracy ?? false,
    timeout: options?.timeoutMs ?? 8000,
    maximumAge: options?.maximumAgeMs ?? 60000,
  };

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const coords: LatLng = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        };

        if (!isValidLatLng(coords)) {
          resolve({
            success: false,
            coords: fallback,
            error: {
              code: "INVALID_COORDINATES",
              message: ERROR_MESSAGES.INVALID_COORDINATES,
            },
          });
          return;
        }

        resolve({
          success: true,
          coords,
        });
      },
      (error: GeolocationPositionError) => {
        let code: GeolocationErrorCode = "UNKNOWN";
        if (error.code === error.PERMISSION_DENIED) {
          code = "PERMISSION_DENIED";
        } else if (error.code === error.POSITION_UNAVAILABLE) {
          code = "POSITION_UNAVAILABLE";
        } else if (error.code === error.TIMEOUT) {
          code = "TIMEOUT";
        }

        resolve({
          success: false,
          coords: fallback,
          error: {
            code,
            message: ERROR_MESSAGES[code] || error.message,
          },
        });
      },
      geoOptions
    );
  });
}

