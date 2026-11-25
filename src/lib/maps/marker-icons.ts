/**
 * 마커 아이콘 SVG (data URI) 생성기
 * - 현재 위치: 파란 원형 점 + 흰색 테두리 (핀 모양 아님)
 * - 검색 장소: 초록색 전용 핀 (WC 문구 없음)
 * - 공공: 파란 화장실 핀 / 제휴: 보라 화장실 핀
 * - 선택: 크기 확대 + 주황 테두리 강조
 */

export type MarkerKind =
  | "public"
  | "partner"
  | "candidate_reference"
  | "current_location"
  | "search_place"
  | "default";

export interface MarkerIconSpec {
  readonly src: string;
  readonly width: number;
  readonly height: number;
  /** 이미지 내 좌표 기준점(앵커) */
  readonly anchorX: number;
  readonly anchorY: number;
}

const toDataUri = (svg: string) =>
  `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;

function currentLocationSvg(): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">` +
    `<circle cx="14" cy="14" r="13" fill="#2563eb" fill-opacity="0.18"/>` +
    `<circle cx="14" cy="14" r="8" fill="#2563eb" stroke="#ffffff" stroke-width="3"/>` +
    `</svg>`
  );
}

function pinSvg(fill: string, selected: boolean): string {
  const w = selected ? 44 : 32;
  const h = selected ? 56 : 42;
  const stroke = selected ? "#f59e0b" : "#ffffff";
  const sw = selected ? 3 : 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 32 42">` +
    `<path d="M16 1C8 1 2 7 2 15c0 10 14 26 14 26s14-16 14-26C30 7 24 1 16 1z" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>` +
    `<circle cx="16" cy="15" r="9" fill="#ffffff"/>` +
    `<text x="16" y="19" text-anchor="middle" font-family="Arial,sans-serif" font-size="9" font-weight="700" fill="${fill}">WC</text>` +
    `</svg>`
  );
}

function searchPlacePinSvg(): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="44" viewBox="0 0 34 44">` +
    `<path d="M17 1C8.7 1 2 7.7 2 16c0 10.5 15 27 15 27s15-16.5 15-27C32 7.7 25.3 1 17 1z" fill="#16a34a" stroke="#ffffff" stroke-width="2.5"/>` +
    `<circle cx="17" cy="16" r="7" fill="#ffffff"/>` +
    `<circle cx="17" cy="16" r="3.5" fill="#15803d"/>` +
    `</svg>`
  );
}

function candidateReferencePinSvg(selected: boolean): string {
  const w = selected ? 42 : 30;
  const h = selected ? 54 : 40;
  const stroke = selected ? "#0f172a" : "#ffffff";
  const sw = selected ? 3 : 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 32 42">` +
    `<path d="M16 1C8 1 2 7 2 15c0 10 14 26 14 26s14-16 14-26C30 7 24 1 16 1z" fill="#d97706" stroke="${stroke}" stroke-width="${sw}" stroke-dasharray="4 1.5"/>` +
    `<circle cx="16" cy="15" r="9" fill="#fffbeb"/>` +
    `<text x="16" y="18.5" text-anchor="middle" font-family="Arial,sans-serif" font-size="8" font-weight="700" fill="#b45309">참고</text>` +
    `</svg>`
  );
}

export function getMarkerIcon(
  kind: MarkerKind | undefined,
  selected = false
): MarkerIconSpec | null {
  if (kind === "current_location") {
    return {
      src: toDataUri(currentLocationSvg()),
      width: 28,
      height: 28,
      anchorX: 14,
      anchorY: 14,
    };
  }
  if (kind === "search_place") {
    return {
      src: toDataUri(searchPlacePinSvg()),
      width: 34,
      height: 44,
      anchorX: 17,
      anchorY: 44,
    };
  }
  if (kind === "candidate_reference") {
    const w = selected ? 42 : 30;
    const h = selected ? 54 : 40;
    return {
      src: toDataUri(candidateReferencePinSvg(selected)),
      width: w,
      height: h,
      anchorX: w / 2,
      anchorY: h,
    };
  }
  if (kind === "public" || kind === "partner") {
    const fill = kind === "partner" ? "#7e22ce" : "#2563eb";
    const w = selected ? 44 : 32;
    const h = selected ? 56 : 42;
    return {
      src: toDataUri(pinSvg(fill, selected)),
      width: w,
      height: h,
      anchorX: w / 2,
      anchorY: h,
    };
  }
  return null;
}
