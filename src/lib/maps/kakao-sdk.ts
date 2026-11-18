/**
 * 카카오 지도 JavaScript SDK 비동기 로더
 *
 * 원칙:
 * 1. 클라이언트 사이드 전용 (typeof window !== 'undefined')
 * 2. `autoload=false` 파라미터와 `kakao.maps.load()` 콜백을 사용하여 비동기 레이스 컨디션을 방지한다.
 * 3. 중복 주입 방지: 전역 로딩 프로미스를 캐싱하고 동일 script 태그가 중복 삽입되지 않도록 보호한다.
 * 4. API 키가 없거나 비어 있는 경우 `missing_key` 상태를 안전하게 반환하며 브라우저 에러를 발생시키지 않는다.
 * 5. 로드 실패(네트워크 오류, 스크립트 에러) 시 reject 및 스크립트 태그 정리를 수행한다.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

declare global {
  interface Window {
    kakao?: {
      maps?: {
        load: (callback: () => void) => void;
        LatLng: new (lat: number, lng: number) => any;
        LatLngBounds: new (sw?: any, ne?: any) => any;
        Map: new (container: HTMLElement, options: any) => any;
        Marker: new (options: any) => any;
        MarkerImage: new (src: string, size: any, options?: any) => any;
        Size: new (width: number, height: number) => any;
        Point: new (x: number, y: number) => any;
        CustomOverlay: new (options: any) => any;
        event: {
          addListener: (target: any, type: string, handler: (...args: any[]) => void) => void;
          removeListener: (target: any, type: string, handler: (...args: any[]) => void) => void;
        };
      };
    };
  }
}

export const KAKAO_SDK_SCRIPT_ID = "kakao-maps-sdk-script";

let sdkLoadingPromise: Promise<typeof window.kakao> | null = null;

/**
 * 카카오 JavaScript 공개 API 키 조회
 *
 * 주의: REST API 키나 Admin 키가 아닌, 클라이언트 전용 JS App Key(`NEXT_PUBLIC_KAKAO_MAP_JS_KEY`)만 사용한다.
 */
export function getKakaoMapApiKey(): string | null {
  const key = process.env.NEXT_PUBLIC_KAKAO_MAP_JS_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

/**
 * 카카오 SDK 로딩 여부 확인
 */
export function isKakaoSdkLoaded(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.kakao && window.kakao.maps && window.kakao.maps.Map);
}

/**
 * 카카오 지도 SDK 비동기 로드
 */
export function loadKakaoMapSdk(apiKey?: string): Promise<typeof window.kakao> {
  // SSR 방어
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(
      new Error("Kakao Map SDK cannot be loaded in server-side rendering environment.")
    );
  }

  // 이미 로드 완료된 경우
  if (isKakaoSdkLoaded()) {
    return Promise.resolve(window.kakao);
  }

  // 이미 로딩 중인 프로미스가 있는 경우 재사용 (중복 주입 차단)
  if (sdkLoadingPromise) {
    return sdkLoadingPromise;
  }

  const resolvedApiKey = apiKey ?? getKakaoMapApiKey();
  if (!resolvedApiKey) {
    return Promise.reject(
      new Error("NEXT_PUBLIC_KAKAO_MAP_JS_KEY 환경변수가 설정되지 않았습니다.")
    );
  }

  sdkLoadingPromise = new Promise<typeof window.kakao>((resolve, reject) => {
    // 기존에 존재하지만 로드 완료되지 않은 스크립트 태그가 있다면 확인
    let script = document.getElementById(KAKAO_SDK_SCRIPT_ID) as HTMLScriptElement | null;

    const onScriptLoadSuccess = () => {
      if (!window.kakao || !window.kakao.maps) {
        cleanupScript();
        sdkLoadingPromise = null;
        reject(new Error("Kakao maps SDK script loaded, but window.kakao.maps is undefined."));
        return;
      }

      window.kakao.maps.load(() => {
        if (isKakaoSdkLoaded()) {
          resolve(window.kakao);
        } else {
          cleanupScript();
          sdkLoadingPromise = null;
          reject(new Error("Kakao maps load callback executed, but Map constructor is unavailable."));
        }
      });
    };

    const onScriptError = (event: Event | string) => {
      cleanupScript();
      sdkLoadingPromise = null;
      const message = typeof event === "string" ? event : "Failed to load Kakao Maps SDK script.";
      reject(new Error(message));
    };

    const cleanupScript = () => {
      const existing = document.getElementById(KAKAO_SDK_SCRIPT_ID);
      if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing);
      }
    };

    if (script) {
      // 이미 스크립트 태그가 주입되어 대기 중인 경우
      script.addEventListener("load", onScriptLoadSuccess, { once: true });
      script.addEventListener("error", onScriptError, { once: true });
      return;
    }

    script = document.createElement("script");
    script.id = KAKAO_SDK_SCRIPT_ID;
    script.type = "text/javascript";
    script.async = true;
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(
      resolvedApiKey
    )}&autoload=false`;

    script.addEventListener("load", onScriptLoadSuccess, { once: true });
    script.addEventListener("error", onScriptError, { once: true });

    document.head.appendChild(script);
  });

  return sdkLoadingPromise;
}

/**
 * 테스트 및 언마운트용 SDK 상태 리셋
 */
export function resetKakaoSdkStateForTesting(): void {
  sdkLoadingPromise = null;
  if (typeof document !== "undefined") {
    const existing = document.getElementById(KAKAO_SDK_SCRIPT_ID);
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
  }
}

