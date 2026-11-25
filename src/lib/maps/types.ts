/**
 * 지도 제공자 인터페이스 및 핵심 도메인 모델 정의
 *
 * 설계 원칙:
 * 1. WGS84 위도(lat: -90~90) 및 경도(lng: -180~180) 표준 좌표계를 엄격히 준수한다.
 * 2. 특정 지도 라이브러리(Kakao, Google, Naver)의 내부 객체(kakao.maps.LatLng 등)에 종속되지 않는
 *    순수 TypeScript 인터페이스를 제공하여 향후 제공자 교체를 지원한다.
 * 3. 서버 사이드 렌더링(SSR) 환경에서는 DOM 및 window 객체에 접근하지 않는다.
 */

/** WGS84 위경도 좌표 */
export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

/** 지도 영역(남서쪽, 북동쪽 좌표) */
export interface MapBounds {
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
}

/** 지도 마커 옵션 */
export interface MarkerOptions {
  readonly id: string;
  readonly position: LatLng;
  readonly title?: string;
  /** 화장실 및 장소 유형별 시각적 구분 (public: 공공, partner: 제휴, candidate_reference: 주소 기반 참고 위치, search_place: 검색 장소) */
  readonly type?:
    | "public"
    | "partner"
    | "candidate_reference"
    | "current_location"
    | "search_place"
    | "default";
  readonly zIndex?: number;
  /** 선택된 마커 강조 표시 */
  readonly selected?: boolean;
  readonly onClick?: (markerId: string) => void;
}

/** 지도 생성 옵션 */
export interface MapOptions {
  readonly center: LatLng;
  readonly zoomLevel: number;
  readonly minZoomLevel?: number;
  readonly maxZoomLevel?: number;
  readonly disableDefaultUI?: boolean;
  readonly onCenterChanged?: (center: LatLng) => void;
  readonly onBoundsChanged?: (bounds: MapBounds) => void;
  readonly onZoomChanged?: (zoomLevel: number) => void;
  readonly onClick?: (position: LatLng) => void;
}

/** 지도 SDK 로딩 상태 */
export type MapSdkStatus =
  | "idle"
  | "loading"
  | "ready"
  | "missing_key"
  | "error";

/**
 * 지도 공급자 공통 추상화 인터페이스
 */
export interface MapProvider {
  readonly name: string;
  /** 컨테이너 요소에 지도를 초기화 */
  init(container: HTMLElement, options: MapOptions): Promise<void>;
  /** 지도 중심 좌표 조회 */
  getCenter(): LatLng;
  /** 지도 중심 좌표 설정 (부드러운 이동 지원) */
  setCenter(center: LatLng, smooth?: boolean): void;
  /** 현재 줌 레벨 조회 (제공자별 스케일 정규화) */
  getZoomLevel(): number;
  /** 줌 레벨 설정 */
  setZoomLevel(level: number): void;
  /** 현재 지도 가시 영역(BBox) 조회 */
  getBounds(): MapBounds;
  /** 영역에 맞게 지도 뷰포트 맞춤 */
  fitBounds(bounds: MapBounds): void;
  /** 마커 추가 또는 일괄 교체 */
  setMarkers(markers: readonly MarkerOptions[]): void;
  /** 단일 마커 추가 */
  addMarker(marker: MarkerOptions): void;
  /** 단일 마커 제거 */
  removeMarker(markerId: string): void;
  /** 모든 마커 제거 */
  clearMarkers(): void;
  /** 컨테이너 크기 변경 시 지도 재조정 */
  relayout(): void;
  /** 이벤트 리스너 및 DOM 정리 */
  destroy(): void;
}

/** WGS84 좌표 유효성 검사 */
export function isValidLatLng(coords: unknown): coords is LatLng {
  if (!coords || typeof coords !== "object") return false;
  const { lat, lng } = coords as { lat?: unknown; lng?: unknown };
  if (typeof lat !== "number" || typeof lng !== "number") return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  // 대한민국 영역을 기본 포함하는 전 지구 WGS84 범위
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/** 한국 수원시 기본 중심 좌표 (데모/테스트 기준) */
export const SUWON_DEFAULT_CENTER: LatLng = Object.freeze({
  lat: 37.2635727,
  lng: 127.0286009,
});

/** 기본 줌 레벨 (상세 골목 식별 가능 수준) */
export const DEFAULT_ZOOM_LEVEL = 3;

