/**
 * 카카오 주소 검색 및 지오코딩 어댑터
 *
 * - 도로명주소·지번주소를 검색하고 WGS84 위도/경도를 자동 변환한다.
 * - 좌표 변환에 실패하거나 유효하지 않은 좌표가 반환되면 임의 좌표를 생성하지 않고 제외/오류 처리한다.
 */
import { isKakaoSdkLoaded, loadKakaoMapSdk } from "./kakao-sdk";

export interface AddressSearchResult {
  readonly id: string;
  readonly roadAddress: string;
  readonly jibunAddress: string | null;
  readonly displayAddress: string;
  readonly buildingName: string | null;
  readonly lat: number;
  readonly lng: number;
  readonly source: "road" | "jibun" | "place";
}

export type AddressSearchFn = (keyword: string) => Promise<AddressSearchResult[]>;

function isValidGeocodedCoords(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  if (lat === 0 && lng === 0) return false;
  return true;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function mapKakaoAddressResults(data: any[]): AddressSearchResult[] {
  const out: AddressSearchResult[] = [];
  for (let i = 0; i < (data?.length ?? 0); i++) {
    const d = data[i];
    const lat = Number(d?.y);
    const lng = Number(d?.x);
    if (!isValidGeocodedCoords(lat, lng)) continue;

    const rawRoad =
      typeof d?.road_address?.address_name === "string"
        ? d.road_address.address_name.trim()
        : "";
    const rawJibun =
      typeof d?.address?.address_name === "string"
        ? d.address.address_name.trim()
        : "";
    const fallback =
      typeof d?.address_name === "string" ? d.address_name.trim() : "";

    const roadAddress = rawRoad || rawJibun || fallback;
    if (!roadAddress) continue;

    const jibunAddress = rawJibun || (!rawRoad && fallback ? fallback : null);
    const buildingName =
      typeof d?.road_address?.building_name === "string" &&
      d.road_address.building_name.trim().length > 0
        ? d.road_address.building_name.trim()
        : null;

    out.push({
      id: `addr-${i}-${lat}-${lng}`,
      roadAddress,
      jibunAddress,
      displayAddress: roadAddress,
      buildingName,
      lat,
      lng,
      source: rawRoad ? "road" : "jibun",
    });
  }
  return out;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function mapKakaoPlaceToAddressResults(data: any[]): AddressSearchResult[] {
  const out: AddressSearchResult[] = [];
  for (let i = 0; i < (data?.length ?? 0); i++) {
    const d = data[i];
    const lat = Number(d?.y);
    const lng = Number(d?.x);
    if (!isValidGeocodedCoords(lat, lng)) continue;

    const rawRoad =
      typeof d?.road_address_name === "string" ? d.road_address_name.trim() : "";
    const rawJibun =
      typeof d?.address_name === "string" ? d.address_name.trim() : "";

    const roadAddress = rawRoad || rawJibun;
    if (!roadAddress) continue;

    const buildingName =
      typeof d?.place_name === "string" && d.place_name.trim().length > 0
        ? d.place_name.trim()
        : null;

    out.push({
      id: String(d?.id ?? `place-${i}-${lat}-${lng}`),
      roadAddress,
      jibunAddress: rawJibun || null,
      displayAddress: roadAddress,
      buildingName,
      lat,
      lng,
      source: "place",
    });
  }
  return out;
}

export const searchKakaoAddresses: AddressSearchFn = async (keyword) => {
  const q = keyword.trim();
  if (!q) return [];

  if (!isKakaoSdkLoaded()) {
    await loadKakaoMapSdk();
  }

  const services = window.kakao?.maps?.services;
  if (!services || (!services.Geocoder && !services.Places)) {
    throw new Error("카카오 주소 검색 라이브러리를 불러오지 못했습니다.");
  }

  // 1. 도로명/지번 주소 정밀 지오코딩 우선
  if (services.Geocoder) {
    const geocoded = await new Promise<AddressSearchResult[]>((resolve, reject) => {
      const geocoder = new services.Geocoder();
      geocoder.addressSearch(
        q,
        (data: any[], status: string) => {
          if (status === services.Status.OK) {
            resolve(mapKakaoAddressResults(data));
          } else if (status === services.Status.ZERO_RESULT) {
            resolve([]);
          } else {
            reject(
              new Error(
                "주소 검색 및 좌표 변환에 실패했습니다. 잠시 후 다시 시도해 주세요."
              )
            );
          }
        },
        { size: 10 }
      );
    });

    if (geocoded.length > 0) {
      return geocoded;
    }
  }

  // 2. 건물명/상호명 등 지오코더 결과 없을 때 장소 주소 fallback (유효 주소·좌표만 허용)
  if (services.Places) {
    return new Promise<AddressSearchResult[]>((resolve, reject) => {
      const places = new services.Places();
      places.keywordSearch(
        q,
        (data: any[], status: string) => {
          if (status === services.Status.OK) {
            resolve(mapKakaoPlaceToAddressResults(data));
          } else if (status === services.Status.ZERO_RESULT) {
            resolve([]);
          } else {
            reject(
              new Error(
                "주소 검색 및 좌표 변환에 실패했습니다. 잠시 후 다시 시도해 주세요."
              )
            );
          }
        },
        { size: 10 }
      );
    });
  }

  return [];
};
