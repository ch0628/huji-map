/**
 * 카카오 장소 검색 (kakao.maps.services.Places) 어댑터
 *
 * - 화장실 이름이 아닌 실제 지역/장소(역, 건물, 관광지 등)를 검색한다.
 * - 지도 SDK와 동일한 JS 키를 사용하며 `libraries=services`가 로드되어야 한다.
 */
import { isKakaoSdkLoaded, loadKakaoMapSdk } from "./kakao-sdk";

export interface PlaceSearchResult {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly category: string;
  readonly lat: number;
  readonly lng: number;
}

export type PlaceSearchFn = (keyword: string) => Promise<PlaceSearchResult[]>;

/* eslint-disable @typescript-eslint/no-explicit-any */
export function mapKakaoPlaces(data: any[]): PlaceSearchResult[] {
  const out: PlaceSearchResult[] = [];
  for (const d of data ?? []) {
    const lat = Number(d?.y);
    const lng = Number(d?.x);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    out.push({
      id: String(d.id ?? `${lat},${lng}`),
      name: String(d.place_name ?? ""),
      address: String(d.road_address_name || d.address_name || ""),
      category: String(d.category_group_name || d.category_name || ""),
      lat,
      lng,
    });
  }
  return out;
}

export const searchKakaoPlaces: PlaceSearchFn = async (keyword) => {
  const q = keyword.trim();
  if (!q) return [];
  if (!isKakaoSdkLoaded()) {
    await loadKakaoMapSdk();
  }
  const services = window.kakao?.maps?.services;
  if (!services) {
    throw new Error("카카오 장소 검색 라이브러리를 불러오지 못했습니다.");
  }
  return new Promise<PlaceSearchResult[]>((resolve, reject) => {
    const places = new services.Places();
    places.keywordSearch(
      q,
      (data: any[], status: string) => {
        if (status === services.Status.OK) {
          resolve(mapKakaoPlaces(data));
        } else if (status === services.Status.ZERO_RESULT) {
          resolve([]);
        } else {
          reject(new Error("장소 검색에 실패했습니다."));
        }
      },
      { size: 10 }
    );
  });
};
