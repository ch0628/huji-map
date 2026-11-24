/**
 * Standalone read-only PoC library for validating MOIS Address DBs
 * (위치정보요약DB & 내비게이션용DB) against HUJIMAP public restroom data.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface ValidatedCoord extends LatLng {
  x: number;
  y: number;
}

export type MatchStatus =
  | "unique_match"
  | "ambiguous_match"
  | "unmatched"
  | "missing_address"
  | "invalid_coordinate";

export interface ParsedRoadAddress {
  sido: string;
  sigungu: string;
  roadName: string;
  underground: "0" | "1";
  mainNo: string;
  subNo: string;
  normalized: boolean;
}

export interface ParsedJibunAddress {
  sido: string;
  sigungu: string;
  dong: string;
  ri: string;
  isSan: "0" | "1";
  mainNo: string;
  subNo: string;
  normalized: boolean;
}

export interface SummaryDbEntry {
  sigunguCode: string;
  entranceSeq: string;
  bjdCode: string;
  sido: string;
  sigungu: string;
  dong: string;
  roadCode: string;
  roadName: string;
  underground: string;
  mainNo: string;
  subNo: string;
  buildingName: string;
  postalCode: string;
  buildingUse: string;
  isComplex: string;
  adminDong: string;
  xRaw: string;
  yRaw: string;
  coord: ValidatedCoord | null;
}

export interface NavBuildEntry {
  bjdCode: string;
  sido: string;
  sigungu: string;
  dong: string;
  roadCode: string;
  roadName: string;
  underground: string;
  mainNo: string;
  subNo: string;
  postalCode: string;
  buildingMgmtNo: string;
  sigunguBuildingName: string;
  buildingUse: string;
  adminDongCode: string;
  adminDongName: string;
  buildingCount: number;
  detailBuildingName: string;
  centroidXRaw: string;
  centroidYRaw: string;
  entranceXRaw: string;
  entranceYRaw: string;
  centroidCoord: ValidatedCoord | null;
  entranceCoord: ValidatedCoord | null;
}

export interface NavJibunEntry {
  bjdCode: string;
  sido: string;
  sigungu: string;
  dong: string;
  ri: string;
  isSan: string;
  lotMain: string;
  lotSub: string;
  roadCode: string;
  underground: string;
  mainNo: string;
  subNo: string;
  jibunSeq: string;
  buildingMgmtNo: string;
  addrEmdCode: string;
}

export interface NavAuxEntranceEntry {
  sigunguCode: string;
  entranceSeq: string;
  roadCode: string;
  underground: string;
  mainNo: string;
  subNo: string;
  bjdCode: string;
  entranceType: string; // '01': 공용, '02': 차량용, '03': 보행자용
  xRaw: string;
  yRaw: string;
  coord: ValidatedCoord | null;
}

export interface RestroomTarget {
  id: string;
  sourceRecordId: string | null;
  name: string;
  roadAddress: string;
  jibunAddress: string;
  officialLat: number | null;
  officialLng: number | null;
  coordinateSource?: string | null;
  coordinateSourceRecordId?: string | null;
  sidoHint?: string;
  sigunguHint?: string;
}

export interface SummaryMatchResult {
  targetId: string;
  sourceRecordId: string | null;
  name: string;
  status: MatchStatus;
  matchBasis: string | null;
  candidateCount: number;
  matchedRoadKey: string | null;
  matchedBuildingName: string | null;
  matchedLat: number | null;
  matchedLng: number | null;
  distanceMeters: number | null;
}

export interface CombinedMatchResult {
  targetId: string;
  sourceRecordId: string | null;
  name: string;
  status: MatchStatus;
  matchBasis: string | null;
  candidateCount: number;
  buildingCount: number;
  auxEntranceCount: number;
  matchedRoadPk: string | null;
  matchedBuildingMgmtNo: string | null;
  matchedBuildingName: string | null;
  // Independent service selection rule A: Main entrance (Summary/Nav) -> Centroid fallback
  serviceLat: number | null;
  serviceLng: number | null;
  serviceCoordType: "main_entrance" | "centroid" | "summary_entrance" | null;
  serviceDistanceMeters: number | null;
  // Independent service selection rule B: Building centroid preferred -> Main entrance fallback
  centroidPrefLat: number | null;
  centroidPrefLng: number | null;
  centroidPrefDistanceMeters: number | null;
  // Reference-only oracle bound: closest among all entrances (main + aux) & centroid
  oracleBestLat: number | null;
  oracleBestLng: number | null;
  oracleBestType: string | null;
  oracleBestDistanceMeters: number | null;
}

export interface DistanceStats {
  count: number;
  min: number | null;
  mean: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  max: number | null;
  within50mCount: number;
  within50mPct: number | null;
  within100mCount: number;
  within100mPct: number | null;
  within200mCount: number;
  within200mPct: number | null;
}

const EARTH_RADIUS_M = 6371008.8;

/**
 * Converts GRS80 UTM-K (EPSG:5179) Easting/Northing (meters) to geographic lat/lng.
 * Official parameters: a=6378137, 1/f=298.257222101, lat0=38N, lon0=127.5E, k0=0.9996, FE=1000000, FN=2000000.
 */
export function epsg5179ToWgs84(x: number, y: number): LatLng {
  const a = 6378137.0;
  const f = 1.0 / 298.257222101;
  const e2 = 2 * f - f * f;
  const ep2 = e2 / (1.0 - e2);
  const k0 = 0.9996;
  const lat0 = (38.0 * Math.PI) / 180.0;
  const lon0 = (127.5 * Math.PI) / 180.0;
  const x0 = 1000000.0;
  const y0 = 2000000.0;

  const meridionalArc = (phi: number): number =>
    a *
    ((1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 * e2 * e2) / 256) * phi -
      ((3 * e2) / 8 + (3 * e2 * e2) / 32 + (45 * e2 * e2 * e2) / 1024) *
        Math.sin(2 * phi) +
      ((15 * e2 * e2) / 256 + (45 * e2 * e2 * e2) / 1024) * Math.sin(4 * phi) -
      ((35 * e2 * e2 * e2) / 3072) * Math.sin(6 * phi));

  const m0 = meridionalArc(lat0);
  const m1 = m0 + (y - y0) / k0;
  const mu =
    m1 / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 * e2 * e2) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));

  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 * e1 * e1) / 32) * Math.sin(2 * mu) +
    ((21 * e1 * e1) / 16 - (55 * e1 * e1 * e1 * e1) / 32) * Math.sin(4 * mu) +
    ((151 * e1 * e1 * e1) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 * e1 * e1 * e1) / 512) * Math.sin(8 * mu);

  const sin1 = Math.sin(phi1);
  const cos1 = Math.cos(phi1);
  const tan1 = Math.tan(phi1);
  const n1 = a / Math.sqrt(1 - e2 * sin1 * sin1);
  const t1 = tan1 * tan1;
  const c1 = ep2 * cos1 * cos1;
  const r1 = (a * (1 - e2)) / Math.pow(1 - e2 * sin1 * sin1, 1.5);
  const d = (x - x0) / (n1 * k0);

  const latRad =
    phi1 -
    ((n1 * tan1) / r1) *
      ((d * d) / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ep2) * Math.pow(d, 4)) /
          24 +
        ((61 +
          90 * t1 +
          298 * c1 +
          45 * t1 * t1 -
          252 * ep2 -
          3 * c1 * c1) *
          Math.pow(d, 6)) /
          720);

  const lonRad =
    lon0 +
    (d -
      ((1 + 2 * t1 + c1) * Math.pow(d, 3)) / 6 +
      ((5 -
        2 * c1 +
        28 * t1 -
        3 * c1 * c1 +
        8 * ep2 +
        24 * t1 * t1) *
        Math.pow(d, 5)) /
        120) /
      cos1;

  return {
    lat: (latRad * 180.0) / Math.PI,
    lng: (lonRad * 180.0) / Math.PI,
  };
}

export function isValidKoreaWgs84(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    !(lat === 0 && lng === 0) &&
    lat >= 33.0 &&
    lat <= 39.0 &&
    lng >= 124.0 &&
    lng <= 132.0
  );
}

export function parseValidEpsg5179(
  xRaw: string,
  yRaw: string
): ValidatedCoord | null {
  const xs = (xRaw || "").trim();
  const ys = (yRaw || "").trim();
  if (!xs || !ys) return null;
  const x = Number(xs);
  const y = Number(ys);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) {
    return null;
  }
  const { lat, lng } = epsg5179ToWgs84(x, y);
  if (!isValidKoreaWgs84(lat, lng)) {
    return null;
  }
  return { x, y, lat, lng };
}

export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180.0;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

const SIDO_CANONICAL_MAP: Record<string, string> = {
  서울: "서울특별시",
  서울시: "서울특별시",
  서울특별시: "서울특별시",
  부산: "부산광역시",
  부산시: "부산광역시",
  부산광역시: "부산광역시",
  대구: "대구광역시",
  대구시: "대구광역시",
  대구광역시: "대구광역시",
  인천: "인천광역시",
  인천시: "인천광역시",
  인천광역시: "인천광역시",
  광주: "전남광주통합특별시",
  광주시: "전남광주통합특별시",
  광주광역시: "전남광주통합특별시",
  전남: "전남광주통합특별시",
  전라남도: "전남광주통합특별시",
  전남광주통합특별시: "전남광주통합특별시",
  대전: "대전광역시",
  대전시: "대전광역시",
  대전광역시: "대전광역시",
  울산: "울산광역시",
  울산시: "울산광역시",
  울산광역시: "울산광역시",
  세종: "세종특별자치시",
  세종시: "세종특별자치시",
  세종특별자치시: "세종특별자치시",
  경기: "경기도",
  경기도: "경기도",
  강원: "강원특별자치도",
  강원도: "강원특별자치도",
  강원특별자치도: "강원특별자치도",
  충북: "충청북도",
  충청북도: "충청북도",
  충남: "충청남도",
  충청남도: "충청남도",
  전북: "전북특별자치도",
  전라북도: "전북특별자치도",
  전북특별자치도: "전북특별자치도",
  경북: "경상북도",
  경상북도: "경상북도",
  경남: "경상남도",
  경상남도: "경상남도",
  제주: "제주특별자치도",
  제주도: "제주특별자치도",
  제주특별자치도: "제주특별자치도",
};

export function canonicalizeSido(raw: string): string {
  const t = (raw || "").trim();
  return SIDO_CANONICAL_MAP[t] ?? "";
}

function splitSidoAndRest(text: string): {
  sido: string;
  rest: string;
  normalized: boolean;
} {
  const trimmed = text.trim();
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 0) return { sido: "", rest: "", normalized: false };
  const mapped = canonicalizeSido(tokens[0]);
  if (mapped) {
    return {
      sido: mapped,
      rest: tokens.slice(1).join(" "),
      normalized: mapped !== tokens[0],
    };
  }
  return { sido: "", rest: trimmed, normalized: false };
}

function normalizeSigunguSpacing(s: string): {
  sigungu: string;
  rest: string;
  normalized: boolean;
} {
  // Handle concatenated city+gu like "수원시팔달구" -> "수원시 팔달구" and "수원특례시" -> "수원시"
  let work = s.trim();
  let norm = false;
  work = work.replace(/([가-힣]+)특례시/g, (_, city) => {
    norm = true;
    return `${city}시`;
  });
  work = work.replace(/^([가-힣]+시)([가-힣]+구)(?=\s|$)/, (_, a, b) => {
    norm = true;
    return `${a} ${b}`;
  });
  // Deduplicate repeated prefix tokens (e.g. "수원시 권선구 수원시 권선구 ..." or "장안구 장안구 ...")
  const dedup1 = work.replace(
    /^([가-힣]+시\s+[가-힣]+구)\s+\1(?=\s|$)/,
    "$1"
  );
  if (dedup1 !== work) {
    work = dedup1;
    norm = true;
  }
  const tokens = work.split(/\s+/);
  const sigunguParts: string[] = [];
  let idx = 0;

  if (idx < tokens.length && /[시군구]$/.test(tokens[idx])) {
    sigunguParts.push(tokens[idx]);
    idx += 1;
    // Skip accidental immediate duplicate of same token (e.g. "장안구 장안구")
    while (idx < tokens.length && tokens[idx] === sigunguParts[sigunguParts.length - 1]) {
      idx += 1;
      norm = true;
    }
    // Handle multi-token sigungu like "수원시 장안구", "청주시 상당구"
    if (
      idx < tokens.length &&
      /[구]$/.test(tokens[idx]) &&
      !/[로길동]$/.test(tokens[idx])
    ) {
      sigunguParts.push(tokens[idx]);
      idx += 1;
      while (idx < tokens.length && tokens[idx] === sigunguParts[sigunguParts.length - 1]) {
        idx += 1;
        norm = true;
      }
    }
  }

  return {
    sigungu: sigunguParts.join(" "),
    rest: tokens.slice(idx).join(" "),
    normalized: norm,
  };
}

function precleanAdminTokens(text: string): { text: string; normalized: boolean } {
  let work = text;
  let norm = false;
  // Insert missing space between 도 and 시/군 (e.g. "경기도수원시" -> "경기도 수원시")
  const spaced = work.replace(
    /^(서울특별시|부산광역시|대구광역시|인천광역시|광주광역시|대전광역시|울산광역시|세종특별자치시|전남광주통합특별시|경기도|강원특별자치도|강원도|충청북도|충청남도|전북특별자치도|전라북도|전라남도|경상북도|경상남도|제주특별자치도|제주도)([가-힣]+)/,
    "$1 $2"
  );
  if (spaced !== work) {
    work = spaced;
    norm = true;
  }
  // Remove duplicated "sido sigungu" prefix (e.g. "경기도 수원시 장안구 경기도 수원시 장안구 ...")
  const dupFull = work.replace(
    /^([가-힣]+(?:도|특별시|광역시|특별자치시|특별자치도)\s+[가-힣]+시(?:\s+[가-힣]+구)?)\s+\1(?=\s|$)/,
    "$1"
  );
  if (dupFull !== work) {
    work = dupFull;
    norm = true;
  }
  return { text: work, normalized: norm };
}

/**
 * Parses a Korean road-name address into canonical structured parts.
 * Returns null if the address is actually a jibun address or lacks road name + number.
 */
export function parseRoadAddress(
  raw: string,
  hints?: { sidoHint?: string; sigunguHint?: string }
): ParsedRoadAddress | null {
  const orig = (raw || "").replace(/\uFEFF/g, "").trim();
  if (!orig || /^\(지번\)/.test(orig)) return null;

  let normalized = false;
  // Remove trailing comma details and parenthetical dong/building hints
  let cleaned = orig.replace(/\([^)]*\)/g, (m) => {
    normalized = true;
    return " ";
  });
  cleaned = cleaned.replace(/,.*$/, () => {
    normalized = true;
    return "";
  });
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  const pre = precleanAdminTokens(cleaned);
  cleaned = pre.text;
  if (pre.normalized) normalized = true;
  if (cleaned !== orig) normalized = true;

  const sidoSplit = splitSidoAndRest(cleaned);
  let sido = sidoSplit.sido;
  let rest = sidoSplit.rest;
  if (sidoSplit.normalized) normalized = true;

  if (!sido && hints?.sidoHint) {
    sido = canonicalizeSido(hints.sidoHint);
    if (sido) normalized = true;
  }

  // Sejong has empty sigungu in MOIS DB (sido="세종특별자치시", sigungu="")
  let sigungu = "";
  if (sido !== "세종특별자치시") {
    const sg = normalizeSigunguSpacing(rest);
    sigungu = sg.sigungu;
    rest = sg.rest;
    if (sg.normalized) normalized = true;
    if (!sigungu && hints?.sigunguHint) {
      sigungu = normalizeSigunguSpacing(hints.sigunguHint).sigungu;
      if (sigungu) normalized = true;
    }
  } else {
    // Strip accidental "세종시" or similar token if present
    rest = rest.replace(/^조치원읍\s+/, "");
  }

  // Normalize accidental space before N번길 / 가길 (e.g. "탑동로 57번길 35" -> "탑동로57번길 35")
  const roadSpaced = rest.replace(
    /^([가-힣0-9]+로)\s+(\d+번길)(?=\s|\d|$)/,
    "$1$2"
  );
  if (roadSpaced !== rest) {
    rest = roadSpaced;
    normalized = true;
  }

  // In case an optional eup/myeon precedes road name (e.g., "경기도 용인시 처인구 모현읍 백옥대로 123")
  // Strip leading eup/myeon only if followed by a road token ending in 로/길
  const emMatch = rest.match(
    /^([가-힣0-9]+[읍면])\s+(.+?(?:로(?:\d+가)?|길)\s*(?:지하\s*)?\d+(?:-\d+)?(?:\s+.*)?)$/
  );
  if (emMatch) {
    rest = emMatch[2];
    normalized = true;
  }

  // Match road name (must end in 로, 로N가, or 길) + optional 지하 + mainNo(-subNo)
  // Also allow missing space before 지하 or number (e.g., "광교로145")
  const m = rest.match(
    /^(.+?(?:로(?:\d+가)?|길))\s*(지하)?\s*(\d+)(?:-(\d+))?(?:\s+.*)?$/
  );
  if (!m) return null;

  const roadName = m[1].replace(/\s+/g, "");
  const underground: "0" | "1" = m[2] ? "1" : "0";
  const mainNo = String(Number.parseInt(m[3], 10));
  const subNo = m[4] ? String(Number.parseInt(m[4], 10)) : "0";

  if (!roadName || !Number.isFinite(Number(mainNo))) return null;

  // Detect if spacing between roadName and number was missing in rest
  const escapedRoad = roadName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`${escapedRoad}\\s+`).test(rest)) {
    normalized = true;
  }

  return {
    sido,
    sigungu,
    roadName,
    underground,
    mainNo,
    subNo,
    normalized,
  };
}

/**
 * Parses a Korean jibun address into canonical structured parts.
 * Returns null if no lot number is found.
 */
export function parseJibunAddress(
  raw: string,
  hints?: { sidoHint?: string; sigunguHint?: string }
): ParsedJibunAddress | null {
  const orig = (raw || "").replace(/\uFEFF/g, "").trim();
  if (!orig) return null;

  let normalized = false;
  let cleaned = orig.replace(/^\(지번\)\s*/, () => {
    normalized = true;
    return "";
  });
  cleaned = cleaned.replace(/\([^)]*\)/g, () => {
    normalized = true;
    return " ";
  });
  cleaned = cleaned.replace(/,.*$/, () => {
    normalized = true;
    return "";
  });
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  const pre = precleanAdminTokens(cleaned);
  cleaned = pre.text;
  if (pre.normalized) normalized = true;

  const sidoSplit = splitSidoAndRest(cleaned);
  let sido = sidoSplit.sido;
  let rest = sidoSplit.rest;
  if (sidoSplit.normalized) normalized = true;

  if (!sido && hints?.sidoHint) {
    sido = canonicalizeSido(hints.sidoHint);
    if (sido) normalized = true;
  }

  let sigungu = "";
  if (sido !== "세종특별자치시") {
    const sg = normalizeSigunguSpacing(rest);
    sigungu = sg.sigungu;
    rest = sg.rest;
    if (sg.normalized) normalized = true;
    if (!sigungu && hints?.sigunguHint) {
      sigungu = normalizeSigunguSpacing(hints.sigunguHint).sigungu;
      if (sigungu) normalized = true;
    }
  }

  // Match dong/eup/myeon/(roNga/ga) + optional ri + optional 산 + lotMain(-lotSub | 번지 N호) + optional 번지
  const m = rest.match(
    /^([가-힣0-9]+?(?:[동읍면]|로\d+가|가))(?:\s+([가-힣0-9]+리))?\s*(산)?\s*(\d+)(?:-(\d+)|번지\s*(\d+)\s*호)?(?:번지)?(?:\s+.*)?$/
  );
  if (!m) return null;

  const dong = m[1].trim();
  const ri = (m[2] || "").trim();
  const isSan: "0" | "1" = m[3] ? "1" : "0";
  const mainNo = String(Number.parseInt(m[4], 10));
  const subRaw = m[5] || m[6];
  const subNo = subRaw ? String(Number.parseInt(subRaw, 10)) : "0";

  if (!dong || !Number.isFinite(Number(mainNo))) return null;

  return {
    sido,
    sigungu,
    dong,
    ri,
    isSan,
    mainNo,
    subNo,
    normalized,
  };
}

export function stripDistrictGu(sigungu: string): string {
  const parts = sigungu.trim().split(/\s+/);
  if (parts.length === 2 && /시$/.test(parts[0]) && /구$/.test(parts[1])) {
    return parts[0];
  }
  return sigungu.trim();
}

export function stripAdminDongNumber(dong: string): string | null {
  const m = dong.match(/^(.+?)\d+동$/);
  if (!m) return null;
  const candidate = `${m[1]}동`;
  return candidate !== dong ? candidate : null;
}

export function buildRoadKey(
  parts: {
    sido: string;
    sigungu: string;
    roadName: string;
    underground: string;
    mainNo: string;
    subNo: string;
  },
  omitGu = false
): string {
  const sido = canonicalizeSido(parts.sido) || parts.sido.trim();
  const sgRaw = parts.sigungu.trim();
  const sigungu = omitGu ? stripDistrictGu(sgRaw) : sgRaw;
  const roadName = parts.roadName.replace(/\s+/g, "");
  const under = parts.underground === "1" ? "1" : "0";
  const mainNo = String(Number.parseInt(parts.mainNo || "0", 10));
  const subNo = String(Number.parseInt(parts.subNo || "0", 10));
  return `${sido}|${sigungu}|${roadName}|${under}|${mainNo}|${subNo}`;
}

export function buildJibunKey(
  parts: {
    sido: string;
    sigungu: string;
    dong: string;
    ri?: string;
    isSan: string;
    mainNo: string;
    subNo: string;
  },
  omitGu = false
): string {
  const sido = canonicalizeSido(parts.sido) || parts.sido.trim();
  const sgRaw = parts.sigungu.trim();
  const sigungu = omitGu ? stripDistrictGu(sgRaw) : sgRaw;
  const dong = parts.dong.replace(/\s+/g, "");
  const ri = (parts.ri || "").replace(/\s+/g, "");
  const san = parts.isSan === "1" ? "1" : "0";
  const mainNo = String(Number.parseInt(parts.mainNo || "0", 10));
  const subNo = String(Number.parseInt(parts.subNo || "0", 10));
  return `${sido}|${sigungu}|${dong}|${ri}|${san}|${mainNo}|${subNo}`;
}

export function normalizeNameToken(s: string): string {
  return (s || "")
    .replace(/\uFEFF/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/공중화장실|화장실/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

export function parseSummaryRow(cols: string[]): SummaryDbEntry | null {
  if (cols.length < 18) return null;
  return {
    sigunguCode: cols[0].trim(),
    entranceSeq: cols[1].trim(),
    bjdCode: cols[2].trim(),
    sido: canonicalizeSido(cols[3]) || cols[3].trim(),
    sigungu: cols[4].trim(),
    dong: cols[5].trim(),
    roadCode: cols[6].trim(),
    roadName: cols[7].trim(),
    underground: cols[8].trim() || "0",
    mainNo: String(Number.parseInt(cols[9].trim() || "0", 10)),
    subNo: String(Number.parseInt(cols[10].trim() || "0", 10)),
    buildingName: cols[11].trim(),
    postalCode: cols[12].trim(),
    buildingUse: cols[13].trim(),
    isComplex: cols[14].trim(),
    adminDong: cols[15].trim(),
    xRaw: cols[16].trim(),
    yRaw: cols[17].trim(),
    coord: parseValidEpsg5179(cols[16], cols[17]),
  };
}

export function parseNavBuildRow(cols: string[]): NavBuildEntry | null {
  if (cols.length < 27) return null;
  const bCount = Number.parseInt(cols[18]?.trim() || "1", 10);
  return {
    bjdCode: cols[0].trim(),
    sido: canonicalizeSido(cols[1]) || cols[1].trim(),
    sigungu: cols[2].trim(),
    dong: cols[3].trim(),
    roadCode: cols[4].trim(),
    roadName: cols[5].trim(),
    underground: cols[6].trim() || "0",
    mainNo: String(Number.parseInt(cols[7].trim() || "0", 10)),
    subNo: String(Number.parseInt(cols[8].trim() || "0", 10)),
    postalCode: cols[9].trim(),
    buildingMgmtNo: cols[10].trim(),
    sigunguBuildingName: cols[11].trim(),
    buildingUse: cols[12].trim(),
    adminDongCode: cols[13].trim(),
    adminDongName: cols[14].trim(),
    buildingCount: Number.isFinite(bCount) ? bCount : 1,
    detailBuildingName: cols[19]?.trim() || "",
    centroidXRaw: cols[23]?.trim() || "",
    centroidYRaw: cols[24]?.trim() || "",
    entranceXRaw: cols[25]?.trim() || "",
    entranceYRaw: cols[26]?.trim() || "",
    centroidCoord: parseValidEpsg5179(cols[23] || "", cols[24] || ""),
    entranceCoord: parseValidEpsg5179(cols[25] || "", cols[26] || ""),
  };
}

export function parseNavJibunRow(cols: string[]): NavJibunEntry | null {
  if (cols.length < 20) return null;
  return {
    bjdCode: cols[0].trim(),
    sido: canonicalizeSido(cols[1]) || cols[1].trim(),
    sigungu: cols[2].trim(),
    dong: cols[3].trim(),
    ri: cols[4].trim(),
    isSan: cols[5].trim() || "0",
    lotMain: String(Number.parseInt(cols[6].trim() || "0", 10)),
    lotSub: String(Number.parseInt(cols[7].trim() || "0", 10)),
    roadCode: cols[8].trim(),
    underground: cols[9].trim() || "0",
    mainNo: String(Number.parseInt(cols[10].trim() || "0", 10)),
    subNo: String(Number.parseInt(cols[11].trim() || "0", 10)),
    jibunSeq: cols[12].trim(),
    buildingMgmtNo: cols[18].trim(),
    addrEmdCode: cols[19].trim(),
  };
}

export function parseNavAuxEntranceRow(
  cols: string[]
): NavAuxEntranceEntry | null {
  if (cols.length < 10) return null;
  return {
    sigunguCode: cols[0].trim(),
    entranceSeq: cols[1].trim(),
    roadCode: cols[2].trim(),
    underground: cols[3].trim() || "0",
    mainNo: String(Number.parseInt(cols[4].trim() || "0", 10)),
    subNo: String(Number.parseInt(cols[5].trim() || "0", 10)),
    bjdCode: cols[6].trim(),
    entranceType: cols[7].trim(),
    xRaw: cols[8].trim(),
    yRaw: cols[9].trim(),
    coord: parseValidEpsg5179(cols[8], cols[9]),
  };
}

export class SummaryAddressIndex {
  private byExactKey = new Map<string, SummaryDbEntry[]>();
  private byCityKey = new Map<string, SummaryDbEntry[]>();

  add(entry: SummaryDbEntry): void {
    const kExact = buildRoadKey(entry, false);
    const b1 = this.byExactKey.get(kExact);
    if (b1) b1.push(entry);
    else this.byExactKey.set(kExact, [entry]);

    const kCity = buildRoadKey(entry, true);
    if (kCity !== kExact) {
      const b2 = this.byCityKey.get(kCity);
      if (b2) b2.push(entry);
      else this.byCityKey.set(kCity, [entry]);
    }
  }

  lookup(
    road: ParsedRoadAddress
  ): { candidates: SummaryDbEntry[]; basis: string } | null {
    const kExact = buildRoadKey(road, false);
    const exactHits = this.byExactKey.get(kExact);
    if (exactHits && exactHits.length > 0) {
      return {
        candidates: exactHits,
        basis: road.normalized ? "road_normalized" : "road_exact",
      };
    }

    const kCity = buildRoadKey(road, true);
    const cityHits = this.byCityKey.get(kCity);
    if (cityHits && cityHits.length > 0) {
      return {
        candidates: cityHits,
        basis: "road_city_normalized",
      };
    }

    return null;
  }
}

export function isPlaceholderAddress(raw: string): boolean {
  const t = (raw || "").trim();
  return !t || /^(?:없음|미기재|해당없음|-|\.+)$/i.test(t);
}

export function extractAddressHints(raw: string): {
  sidoHint?: string;
  sigunguHint?: string;
} {
  const cleaned = (raw || "").replace(/^\(지번\)\s*/, "").trim();
  if (!cleaned || isPlaceholderAddress(cleaned)) return {};
  const sp = splitSidoAndRest(cleaned);
  const sg = normalizeSigunguSpacing(sp.rest);
  return {
    sidoHint: sp.sido || undefined,
    sigunguHint: sg.sigungu || undefined,
  };
}

export function matchRestroomSummaryOnly(
  target: RestroomTarget,
  index: SummaryAddressIndex
): SummaryMatchResult {
  const roadEmpty = isPlaceholderAddress(target.roadAddress);
  const jibunEmpty = isPlaceholderAddress(target.jibunAddress);
  if (roadEmpty && jibunEmpty) {
    return {
      targetId: target.id,
      sourceRecordId: target.sourceRecordId,
      name: target.name,
      status: "missing_address",
      matchBasis: null,
      candidateCount: 0,
      matchedRoadKey: null,
      matchedBuildingName: null,
      matchedLat: null,
      matchedLng: null,
      distanceMeters: null,
    };
  }

  const jibunHints = !jibunEmpty ? extractAddressHints(target.jibunAddress) : {};
  const hints = {
    sidoHint: target.sidoHint || jibunHints.sidoHint,
    sigunguHint: target.sigunguHint || jibunHints.sigunguHint,
  };

  const parsedRoad = parseRoadAddress(target.roadAddress, hints);
  if (!parsedRoad) {
    return {
      targetId: target.id,
      sourceRecordId: target.sourceRecordId,
      name: target.name,
      status: "unmatched",
      matchBasis: "no_parseable_road_address",
      candidateCount: 0,
      matchedRoadKey: null,
      matchedBuildingName: null,
      matchedLat: null,
      matchedLng: null,
      distanceMeters: null,
    };
  }

  const hit = index.lookup(parsedRoad);
  if (!hit || hit.candidates.length === 0) {
    return {
      targetId: target.id,
      sourceRecordId: target.sourceRecordId,
      name: target.name,
      status: "unmatched",
      matchBasis: null,
      candidateCount: 0,
      matchedRoadKey: null,
      matchedBuildingName: null,
      matchedLat: null,
      matchedLng: null,
      distanceMeters: null,
    };
  }

  if (hit.candidates.length > 1) {
    // Never arbitrarily pick the first candidate on 1:N ambiguity
    return {
      targetId: target.id,
      sourceRecordId: target.sourceRecordId,
      name: target.name,
      status: "ambiguous_match",
      matchBasis: hit.basis,
      candidateCount: hit.candidates.length,
      matchedRoadKey: buildRoadKey(parsedRoad, false),
      matchedBuildingName: null,
      matchedLat: null,
      matchedLng: null,
      distanceMeters: null,
    };
  }

  const winner = hit.candidates[0];
  if (!winner.coord) {
    return {
      targetId: target.id,
      sourceRecordId: target.sourceRecordId,
      name: target.name,
      status: "invalid_coordinate",
      matchBasis: hit.basis,
      candidateCount: 1,
      matchedRoadKey: `${winner.roadCode}|${winner.underground}|${winner.mainNo}|${winner.subNo}|${winner.bjdCode}`,
      matchedBuildingName: winner.buildingName || null,
      matchedLat: null,
      matchedLng: null,
      distanceMeters: null,
    };
  }

  const dist =
    target.officialLat !== null && target.officialLng !== null
      ? haversineMeters(
          target.officialLat,
          target.officialLng,
          winner.coord.lat,
          winner.coord.lng
        )
      : null;

  return {
    targetId: target.id,
    sourceRecordId: target.sourceRecordId,
    name: target.name,
    status: "unique_match",
    matchBasis: hit.basis,
    candidateCount: 1,
    matchedRoadKey: `${winner.roadCode}|${winner.underground}|${winner.mainNo}|${winner.subNo}|${winner.bjdCode}`,
    matchedBuildingName: winner.buildingName || null,
    matchedLat: winner.coord.lat,
    matchedLng: winner.coord.lng,
    distanceMeters: dist,
  };
}

export class NavigationAddressIndex {
  // Road PK: roadCode|underground|mainNo|subNo|bjdCode
  private buildsByRoadPk = new Map<string, NavBuildEntry[]>();
  private roadPksByRoadKey = new Map<string, Set<string>>();
  private roadPksByCityRoadKey = new Map<string, Set<string>>();
  private mgmtToRoadPk = new Map<string, string>();
  private mgmtToBuild = new Map<string, NavBuildEntry>();

  private jibunByExactKey = new Map<string, NavJibunEntry[]>();
  private jibunByCityKey = new Map<string, NavJibunEntry[]>();
  private auxByRoadPk = new Map<string, NavAuxEntranceEntry[]>();

  addBuild(entry: NavBuildEntry): void {
    const pk = `${entry.roadCode}|${entry.underground}|${entry.mainNo}|${entry.subNo}|${entry.bjdCode}`;
    const bList = this.buildsByRoadPk.get(pk);
    if (bList) bList.push(entry);
    else this.buildsByRoadPk.set(pk, [entry]);

    if (entry.buildingMgmtNo) {
      this.mgmtToRoadPk.set(entry.buildingMgmtNo, pk);
      this.mgmtToBuild.set(entry.buildingMgmtNo, entry);
    }

    const rk = buildRoadKey(entry, false);
    let pkSet = this.roadPksByRoadKey.get(rk);
    if (!pkSet) {
      pkSet = new Set();
      this.roadPksByRoadKey.set(rk, pkSet);
    }
    pkSet.add(pk);

    const crk = buildRoadKey(entry, true);
    if (crk !== rk) {
      let cPkSet = this.roadPksByCityRoadKey.get(crk);
      if (!cPkSet) {
        cPkSet = new Set();
        this.roadPksByCityRoadKey.set(crk, cPkSet);
      }
      cPkSet.add(pk);
    }
  }

  addJibun(entry: NavJibunEntry): void {
    const jk = buildJibunKey(
      {
        sido: entry.sido,
        sigungu: entry.sigungu,
        dong: entry.dong,
        ri: entry.ri,
        isSan: entry.isSan,
        mainNo: entry.lotMain,
        subNo: entry.lotSub,
      },
      false
    );
    const j1 = this.jibunByExactKey.get(jk);
    if (j1) j1.push(entry);
    else this.jibunByExactKey.set(jk, [entry]);

    const cjk = buildJibunKey(
      {
        sido: entry.sido,
        sigungu: entry.sigungu,
        dong: entry.dong,
        ri: entry.ri,
        isSan: entry.isSan,
        mainNo: entry.lotMain,
        subNo: entry.lotSub,
      },
      true
    );
    if (cjk !== jk) {
      const j2 = this.jibunByCityKey.get(cjk);
      if (j2) j2.push(entry);
      else this.jibunByCityKey.set(cjk, [entry]);
    }
  }

  addAuxEntrance(entry: NavAuxEntranceEntry): void {
    const pk = `${entry.roadCode}|${entry.underground}|${entry.mainNo}|${entry.subNo}|${entry.bjdCode}`;
    const list = this.auxByRoadPk.get(pk);
    if (list) list.push(entry);
    else this.auxByRoadPk.set(pk, [entry]);
  }

  getBuildsForRoadPk(pk: string): NavBuildEntry[] {
    return this.buildsByRoadPk.get(pk) ?? [];
  }

  getAuxForRoadPk(pk: string): NavAuxEntranceEntry[] {
    return this.auxByRoadPk.get(pk) ?? [];
  }

  lookupRoadPks(
    road: ParsedRoadAddress
  ): { pks: string[]; basis: string } | null {
    const rk = buildRoadKey(road, false);
    const s1 = this.roadPksByRoadKey.get(rk);
    if (s1 && s1.size > 0) {
      return {
        pks: Array.from(s1),
        basis: road.normalized ? "road_normalized" : "road_exact",
      };
    }

    const crk = buildRoadKey(road, true);
    const s2 = this.roadPksByCityRoadKey.get(crk);
    if (s2 && s2.size > 0) {
      return { pks: Array.from(s2), basis: "road_city_normalized" };
    }
    return null;
  }

  lookupByJibun(jibun: ParsedJibunAddress): {
    pks: string[];
    mgmtNos: string[];
    basis: string;
  } | null {
    const jk = buildJibunKey(jibun, false);
    let hits = this.jibunByExactKey.get(jk);
    let basis = jibun.normalized ? "jibun_normalized" : "jibun_exact";

    if (!hits || hits.length === 0) {
      const cjk = buildJibunKey(jibun, true);
      hits = this.jibunByCityKey.get(cjk);
      basis = "jibun_city_normalized";
    }

    if ((!hits || hits.length === 0) && !jibun.ri) {
      const legalDong = stripAdminDongNumber(jibun.dong);
      if (legalDong) {
        const altKey = buildJibunKey({ ...jibun, dong: legalDong }, false);
        const altHits = this.jibunByExactKey.get(altKey);
        if (altHits && altHits.length > 0) {
          // Verify adminDong matches on linked building if available, or mark admin_dong_norm
          hits = altHits;
          basis = "jibun_admin_dong_normalized";
        }
      }
    }

    if (!hits || hits.length === 0) return null;

    // Prefer 대표지번 (jibunSeq === '0') if there are both representative and related lots
    const repHits = hits.filter((h) => h.jibunSeq === "0");
    const chosen = repHits.length > 0 ? repHits : hits;

    const pks = Array.from(
      new Set(
        chosen.map(
          (h) =>
            `${h.roadCode}|${h.underground}|${h.mainNo}|${h.subNo}|${h.addrEmdCode}`
        )
      )
    );
    const mgmtNos = Array.from(
      new Set(chosen.map((h) => h.buildingMgmtNo).filter(Boolean))
    );
    return { pks, mgmtNos, basis };
  }

  getBuildByMgmtNo(mgmtNo: string): NavBuildEntry | undefined {
    return this.mgmtToBuild.get(mgmtNo);
  }
}

export function matchRestroomCombined(
  target: RestroomTarget,
  summaryIndex: SummaryAddressIndex,
  navIndex: NavigationAddressIndex
): CombinedMatchResult {
  const roadEmpty = isPlaceholderAddress(target.roadAddress);
  const jibunEmpty = isPlaceholderAddress(target.jibunAddress);
  if (roadEmpty && jibunEmpty) {
    return {
      targetId: target.id,
      sourceRecordId: target.sourceRecordId,
      name: target.name,
      status: "missing_address",
      matchBasis: null,
      candidateCount: 0,
      buildingCount: 0,
      auxEntranceCount: 0,
      matchedRoadPk: null,
      matchedBuildingMgmtNo: null,
      matchedBuildingName: null,
      serviceLat: null,
      serviceLng: null,
      serviceCoordType: null,
      serviceDistanceMeters: null,
      centroidPrefLat: null,
      centroidPrefLng: null,
      centroidPrefDistanceMeters: null,
      oracleBestLat: null,
      oracleBestLng: null,
      oracleBestType: null,
      oracleBestDistanceMeters: null,
    };
  }

  const roadHints = !roadEmpty ? extractAddressHints(target.roadAddress) : {};
  const jibunHints = !jibunEmpty ? extractAddressHints(target.jibunAddress) : {};
  const hints = {
    sidoHint: target.sidoHint || roadHints.sidoHint || jibunHints.sidoHint,
    sigunguHint:
      target.sigunguHint || roadHints.sigunguHint || jibunHints.sigunguHint,
  };

  const parsedRoad = parseRoadAddress(target.roadAddress, hints);
  const parsedJibun =
    parseJibunAddress(target.jibunAddress, hints) ??
    parseJibunAddress(target.roadAddress, hints);

  // Step 1: Resolve road PK via road address first, then fallback to Navigation jibun lookup
  let matchedPks: string[] = [];
  let matchBasis: string | null = null;
  let jibunMgmtNos: string[] = [];

  if (parsedRoad) {
    const roadRes = navIndex.lookupRoadPks(parsedRoad);
    if (roadRes && roadRes.pks.length > 0) {
      matchedPks = roadRes.pks;
      matchBasis = roadRes.basis;
    }
  }

  if (matchedPks.length === 0 && parsedJibun) {
    const jibunRes = navIndex.lookupByJibun(parsedJibun);
    if (jibunRes && jibunRes.pks.length > 0) {
      matchedPks = jibunRes.pks;
      matchBasis = `nav_${jibunRes.basis}`;
      jibunMgmtNos = jibunRes.mgmtNos;
    }
  }

  // Fallback to Summary DB if Navigation DB had no entry for the road key
  if (matchedPks.length === 0 && parsedRoad) {
    const sumRes = summaryIndex.lookup(parsedRoad);
    if (sumRes && sumRes.candidates.length > 0) {
      if (sumRes.candidates.length > 1) {
        return {
          targetId: target.id,
          sourceRecordId: target.sourceRecordId,
          name: target.name,
          status: "ambiguous_match",
          matchBasis: `summary_${sumRes.basis}`,
          candidateCount: sumRes.candidates.length,
          buildingCount: 0,
          auxEntranceCount: 0,
          matchedRoadPk: null,
          matchedBuildingMgmtNo: null,
          matchedBuildingName: null,
          serviceLat: null,
          serviceLng: null,
          serviceCoordType: null,
          serviceDistanceMeters: null,
          centroidPrefLat: null,
          centroidPrefLng: null,
          centroidPrefDistanceMeters: null,
          oracleBestLat: null,
          oracleBestLng: null,
          oracleBestType: null,
          oracleBestDistanceMeters: null,
        };
      }
      const sumEntry = sumRes.candidates[0];
      if (!sumEntry.coord) {
        return {
          targetId: target.id,
          sourceRecordId: target.sourceRecordId,
          name: target.name,
          status: "invalid_coordinate",
          matchBasis: `summary_${sumRes.basis}`,
          candidateCount: 1,
          buildingCount: 0,
          auxEntranceCount: 0,
          matchedRoadPk: `${sumEntry.roadCode}|${sumEntry.underground}|${sumEntry.mainNo}|${sumEntry.subNo}|${sumEntry.bjdCode}`,
          matchedBuildingMgmtNo: null,
          matchedBuildingName: sumEntry.buildingName || null,
          serviceLat: null,
          serviceLng: null,
          serviceCoordType: null,
          serviceDistanceMeters: null,
          centroidPrefLat: null,
          centroidPrefLng: null,
          centroidPrefDistanceMeters: null,
          oracleBestLat: null,
          oracleBestLng: null,
          oracleBestType: null,
          oracleBestDistanceMeters: null,
        };
      }
      const dist =
        target.officialLat !== null && target.officialLng !== null
          ? haversineMeters(
              target.officialLat,
              target.officialLng,
              sumEntry.coord.lat,
              sumEntry.coord.lng
            )
          : null;
      return {
        targetId: target.id,
        sourceRecordId: target.sourceRecordId,
        name: target.name,
        status: "unique_match",
        matchBasis: `summary_${sumRes.basis}`,
        candidateCount: 1,
        buildingCount: 0,
        auxEntranceCount: 0,
        matchedRoadPk: `${sumEntry.roadCode}|${sumEntry.underground}|${sumEntry.mainNo}|${sumEntry.subNo}|${sumEntry.bjdCode}`,
        matchedBuildingMgmtNo: null,
        matchedBuildingName: sumEntry.buildingName || null,
        serviceLat: sumEntry.coord.lat,
        serviceLng: sumEntry.coord.lng,
        serviceCoordType: "summary_entrance",
        serviceDistanceMeters: dist,
        centroidPrefLat: sumEntry.coord.lat,
        centroidPrefLng: sumEntry.coord.lng,
        centroidPrefDistanceMeters: dist,
        oracleBestLat: sumEntry.coord.lat,
        oracleBestLng: sumEntry.coord.lng,
        oracleBestType: "summary_entrance",
        oracleBestDistanceMeters: dist,
      };
    }
  }

  if (matchedPks.length === 0) {
    return {
      targetId: target.id,
      sourceRecordId: target.sourceRecordId,
      name: target.name,
      status: "unmatched",
      matchBasis: null,
      candidateCount: 0,
      buildingCount: 0,
      auxEntranceCount: 0,
      matchedRoadPk: null,
      matchedBuildingMgmtNo: null,
      matchedBuildingName: null,
      serviceLat: null,
      serviceLng: null,
      serviceCoordType: null,
      serviceDistanceMeters: null,
      centroidPrefLat: null,
      centroidPrefLng: null,
      centroidPrefDistanceMeters: null,
      oracleBestLat: null,
      oracleBestLng: null,
      oracleBestType: null,
      oracleBestDistanceMeters: null,
    };
  }

  if (matchedPks.length > 1) {
    // Try disambiguating multiple road PKs via jibun buildingMgmtNo or exact building name
    if (jibunMgmtNos.length === 1) {
      const b = navIndex.getBuildByMgmtNo(jibunMgmtNos[0]);
      if (b) {
        matchedPks = [
          `${b.roadCode}|${b.underground}|${b.mainNo}|${b.subNo}|${b.bjdCode}`,
        ];
        matchBasis = `${matchBasis}+mgmt_disambiguated`;
      }
    }
  }

  if (matchedPks.length > 1) {
    const targetNameNorm = normalizeNameToken(target.name);
    if (targetNameNorm) {
      const matchingPks: string[] = [];
      for (const pk of matchedPks) {
        const builds = navIndex.getBuildsForRoadPk(pk);
        if (
          builds.some((b) => {
            const bn = normalizeNameToken(b.sigunguBuildingName);
            const dn = normalizeNameToken(b.detailBuildingName);
            return (
              (bn && (bn === targetNameNorm || bn.includes(targetNameNorm))) ||
              (dn && (dn === targetNameNorm || dn.includes(targetNameNorm)))
            );
          })
        ) {
          matchingPks.push(pk);
        }
      }
      if (matchingPks.length === 1) {
        matchedPks = matchingPks;
        matchBasis = `${matchBasis}+name_disambiguated`;
      }
    }
  }

  if (matchedPks.length > 1) {
    return {
      targetId: target.id,
      sourceRecordId: target.sourceRecordId,
      name: target.name,
      status: "ambiguous_match",
      matchBasis,
      candidateCount: matchedPks.length,
      buildingCount: 0,
      auxEntranceCount: 0,
      matchedRoadPk: null,
      matchedBuildingMgmtNo: null,
      matchedBuildingName: null,
      serviceLat: null,
      serviceLng: null,
      serviceCoordType: null,
      serviceDistanceMeters: null,
      centroidPrefLat: null,
      centroidPrefLng: null,
      centroidPrefDistanceMeters: null,
      oracleBestLat: null,
      oracleBestLng: null,
      oracleBestType: null,
      oracleBestDistanceMeters: null,
    };
  }

  const pk = matchedPks[0];
  let builds = navIndex.getBuildsForRoadPk(pk);
  const auxList = navIndex.getAuxForRoadPk(pk);

  // If jibun specifically identified 1 building inside a multi-building road PK, narrow to it
  if (builds.length > 1 && jibunMgmtNos.length === 1) {
    const exactB = builds.filter((b) => b.buildingMgmtNo === jibunMgmtNos[0]);
    if (exactB.length === 1) {
      builds = exactB;
    }
  }

  // If multiple buildings share this road PK, try building name match (without using official coords!)
  if (builds.length > 1) {
    const targetNameNorm = normalizeNameToken(target.name);
    if (targetNameNorm) {
      const nameMatched = builds.filter((b) => {
        const bn = normalizeNameToken(b.sigunguBuildingName);
        const dn = normalizeNameToken(b.detailBuildingName);
        return (
          (bn && (bn === targetNameNorm || bn.includes(targetNameNorm))) ||
          (dn && (dn === targetNameNorm || dn.includes(targetNameNorm)))
        );
      });
      if (nameMatched.length === 1) {
        builds = nameMatched;
        matchBasis = `${matchBasis}+bldg_name`;
      }
    }
  }

  // Note: Within a single road address (1 PK), MOIS Navigation DB assigns the SAME road-address entrance coordinate
  // to buildings of that address, while each building has its own centroid coordinate.
  // Check whether valid coordinates exist across the resolved building(s) / Summary DB.
  const summaryHit = parsedRoad ? summaryIndex.lookup(parsedRoad) : null;
  const summaryCoord =
    summaryHit && summaryHit.candidates.length === 1
      ? summaryHit.candidates[0].coord
      : null;

  // Determine independent service coordinate without ever looking at officialLat/officialLng:
  // Rule A (service): if unique building (or all buildings share 1 main entrance coord) -> main entrance -> centroid -> summary
  // Rule B (centroidPref): if 1 building -> centroid -> main entrance -> summary
  // If >1 building in the same road PK and building name did NOT disambiguate:
  // Check if all buildings share the same entrance coordinate (common in MOIS DB for complexes!).
  const validEntrances = builds
    .map((b) => b.entranceCoord)
    .filter((c): c is ValidatedCoord => c !== null);
  const validCentroids = builds
    .map((b) => b.centroidCoord)
    .filter((c): c is ValidatedCoord => c !== null);

  if (
    validEntrances.length === 0 &&
    validCentroids.length === 0 &&
    !summaryCoord
  ) {
    return {
      targetId: target.id,
      sourceRecordId: target.sourceRecordId,
      name: target.name,
      status: "invalid_coordinate",
      matchBasis,
      candidateCount: 1,
      buildingCount: builds.length,
      auxEntranceCount: auxList.length,
      matchedRoadPk: pk,
      matchedBuildingMgmtNo:
        builds.length === 1 ? builds[0].buildingMgmtNo : null,
      matchedBuildingName:
        builds.length === 1 ? builds[0].sigunguBuildingName || null : null,
      serviceLat: null,
      serviceLng: null,
      serviceCoordType: null,
      serviceDistanceMeters: null,
      centroidPrefLat: null,
      centroidPrefLng: null,
      centroidPrefDistanceMeters: null,
      oracleBestLat: null,
      oracleBestLng: null,
      oracleBestType: null,
      oracleBestDistanceMeters: null,
    };
  }

  // For Rule A (main entrance preferred):
  // If multiple buildings exist at the same PK, check if distinct entrance coords exist (>5m apart)
  let serviceCoord: ValidatedCoord | null = null;
  let serviceType: "main_entrance" | "centroid" | "summary_entrance" | null =
    null;

  if (validEntrances.length > 0) {
    serviceCoord = validEntrances[0];
    serviceType = "main_entrance";
  } else if (summaryCoord) {
    serviceCoord = summaryCoord;
    serviceType = "summary_entrance";
  } else if (validCentroids.length > 0) {
    serviceCoord = validCentroids[0];
    serviceType = "centroid";
  }

  // For Rule B (centroid preferred when single building, otherwise mean/first centroid or entrance):
  let centroidPrefCoord: ValidatedCoord | null = null;
  if (validCentroids.length === 1) {
    centroidPrefCoord = validCentroids[0];
  } else if (validCentroids.length > 1) {
    // Independent deterministic aggregate: geometric mean of building centroids on the same address
    const avgLat =
      validCentroids.reduce((acc, c) => acc + c.lat, 0) / validCentroids.length;
    const avgLng =
      validCentroids.reduce((acc, c) => acc + c.lng, 0) / validCentroids.length;
    centroidPrefCoord = { x: 0, y: 0, lat: avgLat, lng: avgLng };
  } else {
    centroidPrefCoord = serviceCoord;
  }

  // Reference-only oracle bound (explicitly separated from independent service rule):
  let oracleBestLat: number | null = null;
  let oracleBestLng: number | null = null;
  let oracleBestType: string | null = null;
  let oracleBestDist: number | null = null;

  if (target.officialLat !== null && target.officialLng !== null) {
    const pool: Array<{ lat: number; lng: number; label: string }> = [];
    for (const c of validEntrances) {
      pool.push({ lat: c.lat, lng: c.lng, label: "nav_main_entrance" });
    }
    for (const c of validCentroids) {
      pool.push({ lat: c.lat, lng: c.lng, label: "nav_centroid" });
    }
    for (const a of auxList) {
      if (a.coord) {
        pool.push({
          lat: a.coord.lat,
          lng: a.coord.lng,
          label: `aux_${a.entranceType}`,
        });
      }
    }
    if (summaryCoord) {
      pool.push({
        lat: summaryCoord.lat,
        lng: summaryCoord.lng,
        label: "summary_entrance",
      });
    }
    for (const cand of pool) {
      const d = haversineMeters(
        target.officialLat,
        target.officialLng,
        cand.lat,
        cand.lng
      );
      if (oracleBestDist === null || d < oracleBestDist) {
        oracleBestDist = d;
        oracleBestLat = cand.lat;
        oracleBestLng = cand.lng;
        oracleBestType = cand.label;
      }
    }
  }

  const serviceDist =
    serviceCoord && target.officialLat !== null && target.officialLng !== null
      ? haversineMeters(
          target.officialLat,
          target.officialLng,
          serviceCoord.lat,
          serviceCoord.lng
        )
      : null;

  const centroidPrefDist =
    centroidPrefCoord &&
    target.officialLat !== null &&
    target.officialLng !== null
      ? haversineMeters(
          target.officialLat,
          target.officialLng,
          centroidPrefCoord.lat,
          centroidPrefCoord.lng
        )
      : null;

  return {
    targetId: target.id,
    sourceRecordId: target.sourceRecordId,
    name: target.name,
    status: "unique_match",
    matchBasis,
    candidateCount: 1,
    buildingCount: builds.length,
    auxEntranceCount: auxList.length,
    matchedRoadPk: pk,
    matchedBuildingMgmtNo:
      builds.length === 1 ? builds[0].buildingMgmtNo : null,
    matchedBuildingName:
      builds.length === 1
        ? builds[0].sigunguBuildingName || builds[0].detailBuildingName || null
        : builds[0]?.sigunguBuildingName || null,
    serviceLat: serviceCoord ? serviceCoord.lat : null,
    serviceLng: serviceCoord ? serviceCoord.lng : null,
    serviceCoordType: serviceType,
    serviceDistanceMeters: serviceDist,
    centroidPrefLat: centroidPrefCoord ? centroidPrefCoord.lat : null,
    centroidPrefLng: centroidPrefCoord ? centroidPrefCoord.lng : null,
    centroidPrefDistanceMeters: centroidPrefDist,
    oracleBestLat,
    oracleBestLng,
    oracleBestType,
    oracleBestDistanceMeters: oracleBestDist,
  };
}

function percentileSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function computeDistanceMetrics(distances: number[]): DistanceStats {
  const valid = distances.filter((d) => Number.isFinite(d) && d >= 0);
  const n = valid.length;
  if (n === 0) {
    return {
      count: 0,
      min: null,
      mean: null,
      p50: null,
      p90: null,
      p95: null,
      max: null,
      within50mCount: 0,
      within50mPct: null,
      within100mCount: 0,
      within100mPct: null,
      within200mCount: 0,
      within200mPct: null,
    };
  }
  const sorted = [...valid].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const w50 = sorted.filter((d) => d <= 50).length;
  const w100 = sorted.filter((d) => d <= 100).length;
  const w200 = sorted.filter((d) => d <= 200).length;

  return {
    count: n,
    min: sorted[0],
    mean: sum / n,
    p50: percentileSorted(sorted, 0.5),
    p90: percentileSorted(sorted, 0.9),
    p95: percentileSorted(sorted, 0.95),
    max: sorted[n - 1],
    within50mCount: w50,
    within50mPct: (w50 / n) * 100,
    within100mCount: w100,
    within100mPct: (w100 / n) * 100,
    within200mCount: w200,
    within200mPct: (w200 / n) * 100,
  };
}
