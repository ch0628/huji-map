import crypto from "node:crypto";
import type { PublicSourceConfig } from "./types";

export const GG_PUBL_SOURCE_CONFIG: PublicSourceConfig = {
  providerName: "경기도",
  datasetName: "경기도 공중화장실 현황 (Publtolt / 15011425)",
  sourceUrl: "https://www.data.go.kr/data/15011425/openapi.do",
  apiEndpoint: "https://openapi.gg.go.kr/Publtolt",
  licenseName: "공공누리 / 경기데이터드림 이용약관 (상용 전 사전확인 필요)",
  licenseUrl: "https://data.gg.go.kr/portal/terms/termsPolicyPage.do",
  attributionText:
    "출처: 경기도 / 경기데이터드림(data.gg.go.kr) 공중화장실 현황(15011425)",
};

export interface GgPublicRestroomRow {
  rowNumber: number; // 1-based data row number in CSV (excluding header)
  name: string;
  roadAddress: string;
  jibunAddress: string;
  agency: string;
  latitude: number | null;
  longitude: number | null;
  dataStdDate: string;
  raw: Record<string, string | undefined>;
}

export interface SuwonDbRestroomCandidate {
  id: string;
  name: string;
  roadAddress: string;
  addressDetail: string | null;
  sourceId: string | null;
  sourceRecordId: string | null;
  publicationStatus: string;
  lastVerifiedAt: string | null;
  coordinateSource?: string | null;
}

export type SuwonCoordMatchStatus =
  | "matched"
  | "missing_coords"
  | "ambiguous"
  | "unmatched";

export interface SuwonCoordMatchItem {
  restroomId: string;
  sourceRecordId: string | null;
  restroomName: string;
  previousStatus: string;
  status: SuwonCoordMatchStatus;
  matchBasis: string | null;
  candidateCount: number;
  candidateRowNumbers: number[];
  matchedRowNumber: number | null;
  coordinateSource: "gg_publtolt_15011425" | null;
  coordinateSourceRecordId: string | null;
  latitude: number | null;
  longitude: number | null;
  dataStdDate: string | null;
}

export interface SuwonCoordMatchReport {
  totalTargets: number;
  matchedCount: number;
  missingCoordsCount: number;
  ambiguousCount: number;
  unmatchedCount: number;
  eligibleForRemoteCount: number;
  matchedPublishedCount: number;
  matchedDraftCount: number;
  items: SuwonCoordMatchItem[];
}

export function isValidKoreaWgs84(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    !(lat === 0 && lng === 0) &&
    lat >= 33 &&
    lat <= 39 &&
    lng >= 124 &&
    lng <= 132
  );
}

export function normalizeRestroomNameKey(name: string): string {
  return (name || "").replace(/\uFEFF/g, "").replace(/\s+/g, "").toLowerCase();
}

export function normalizeStrictAddressKey(addr: string): string {
  return (addr || "")
    .replace(/^\(지번\)\s*/, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/,.*$/, "")
    .replace(/^경기도\s*/, "경기")
    .replace(/^경기\s*/, "경기")
    .replace(/\s+/g, "")
    .toLowerCase();
}

export function extractRoadBaseKey(addr: string): string {
  let t = (addr || "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/,.*$/, " ")
    .trim();
  t = t.replace(/^경기도\s*/, "경기 ").replace(/^경기\s*/, "경기 ");
  const m = t.match(/^(.*?(?:로(?:\d+가)?|길)\s*\d+(?:-\d+)?)(?:\s+.*)?$/);
  return m ? m[1].replace(/\s+/g, "").toLowerCase() : "";
}

export function extractJibunLotKey(addr: string): string {
  let t = (addr || "")
    .replace(/^\(지번\)\s*/, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/,.*$/, " ")
    .trim();
  t = t.replace(/^경기도\s*/, "경기 ").replace(/^경기\s*/, "경기 ");
  const m = t.match(
    /^(.*?[동리가]\s*(?:산\s*)?\d+(?:-\d+)?)(?:\s*번지)?(?:\s+.*)?$/
  );
  return m ? m[1].replace(/\s+/g, "").replace(/번지$/, "").toLowerCase() : "";
}

export function buildGgSourceRecordId(row: {
  rowNumber: number;
  name: string;
  roadAddress: string;
  jibunAddress: string;
  latitude: number | null;
  longitude: number | null;
}): string {
  const payload = [
    row.name.trim(),
    row.roadAddress.trim(),
    row.jibunAddress.trim(),
    row.latitude !== null ? String(row.latitude) : "",
    row.longitude !== null ? String(row.longitude) : "",
  ].join("|");
  const hash = crypto
    .createHash("sha256")
    .update(payload)
    .digest("hex")
    .slice(0, 12);
  return `GG-15011425-R${row.rowNumber}-${hash}`;
}

export function parseGgCsvRecords(
  records: Array<Record<string, string | undefined>>
): GgPublicRestroomRow[] {
  return records.map((raw, idx) => {
    const latRaw = (raw["위도"] || raw["REFINE_WGS84_LAT"] || "").trim();
    const lngRaw = (raw["경도"] || raw["REFINE_WGS84_LOGT"] || "").trim();
    const latNum = latRaw ? Number.parseFloat(latRaw) : Number.NaN;
    const lngNum = lngRaw ? Number.parseFloat(lngRaw) : Number.NaN;
    const valid = isValidKoreaWgs84(latNum, lngNum);

    return {
      rowNumber: idx + 1,
      name: (raw["화장실명"] || raw["PBCTLT_PLC_NM"] || "").trim(),
      roadAddress: (
        raw["소재지도로명주소"] ||
        raw["REFINE_ROADNM_ADDR"] ||
        ""
      ).trim(),
      jibunAddress: (
        raw["소재지지번주소"] ||
        raw["REFINE_LOTNO_ADDR"] ||
        ""
      ).trim(),
      agency: (raw["관리기관명"] || raw["MANAGE_INST_NM"] || "").trim(),
      latitude: valid ? latNum : null,
      longitude: valid ? lngNum : null,
      dataStdDate: (raw["데이터기준일자"] || raw["DATA_STD_DE"] || "").trim(),
      raw,
    };
  });
}

function getMatchBasis(
  db: SuwonDbRestroomCandidate,
  gg: GgPublicRestroomRow
): string | null {
  const dbName = normalizeRestroomNameKey(db.name);
  const ggName = normalizeRestroomNameKey(gg.name);
  if (!dbName || dbName !== ggName) {
    return null;
  }

  const dbRoad = db.roadAddress || "";
  const dbJibun =
    (db.addressDetail || "").replace(/^\(지번\)\s*/, "").trim() || dbRoad;
  const ggRoad = gg.roadAddress || "";
  const ggJibun = gg.jibunAddress || "";

  const strictRoadMatch =
    Boolean(normalizeStrictAddressKey(dbRoad)) &&
    normalizeStrictAddressKey(dbRoad) === normalizeStrictAddressKey(ggRoad);
  if (strictRoadMatch) return "name+road_strict";

  const strictJibunMatch =
    Boolean(normalizeStrictAddressKey(dbJibun)) &&
    normalizeStrictAddressKey(dbJibun) === normalizeStrictAddressKey(ggJibun);
  if (strictJibunMatch) return "name+jibun_strict";

  const roadBaseMatch =
    Boolean(extractRoadBaseKey(dbRoad)) &&
    extractRoadBaseKey(dbRoad) === extractRoadBaseKey(ggRoad);
  if (roadBaseMatch) return "name+road_base";

  const jibunLotMatch =
    Boolean(extractJibunLotKey(dbJibun)) &&
    extractJibunLotKey(dbJibun) === extractJibunLotKey(ggJibun);
  if (jibunLotMatch) return "name+jibun_lot";

  return null;
}

/**
 * Matches existing Suwon DB public restrooms against Gyeonggi Publtolt (15011425) rows.
 * - Never references Kakao coordinates.
 * - Requires exact normalized name + exact normalized road/jibun match.
 * - Holds back ambiguous (>1 candidate) or missing-coord matches without auto-selecting.
 */
export function matchSuwonRestroomsWithGgData(
  dbTargets: SuwonDbRestroomCandidate[],
  ggRows: GgPublicRestroomRow[]
): SuwonCoordMatchReport {
  const byName = new Map<string, GgPublicRestroomRow[]>();
  for (const row of ggRows) {
    const key = normalizeRestroomNameKey(row.name);
    if (!key) continue;
    const bucket = byName.get(key);
    if (bucket) bucket.push(row);
    else byName.set(key, [row]);
  }

  const items: SuwonCoordMatchItem[] = [];
  let matchedCount = 0;
  let missingCoordsCount = 0;
  let ambiguousCount = 0;
  let unmatchedCount = 0;
  let matchedPublishedCount = 0;
  let matchedDraftCount = 0;

  for (const db of dbTargets) {
    const nameKey = normalizeRestroomNameKey(db.name);
    const sameNameRows = byName.get(nameKey) ?? [];
    const matchedCandidates: Array<{
      row: GgPublicRestroomRow;
      basis: string;
    }> = [];

    for (const candidate of sameNameRows) {
      const basis = getMatchBasis(db, candidate);
      if (basis) {
        matchedCandidates.push({ row: candidate, basis });
      }
    }

    if (matchedCandidates.length === 0) {
      unmatchedCount += 1;
      items.push({
        restroomId: db.id,
        sourceRecordId: db.sourceRecordId,
        restroomName: db.name,
        previousStatus: db.publicationStatus,
        status: "unmatched",
        matchBasis: null,
        candidateCount: 0,
        candidateRowNumbers: [],
        matchedRowNumber: null,
        coordinateSource: null,
        coordinateSourceRecordId: null,
        latitude: null,
        longitude: null,
        dataStdDate: null,
      });
      continue;
    }

    if (matchedCandidates.length > 1) {
      ambiguousCount += 1;
      items.push({
        restroomId: db.id,
        sourceRecordId: db.sourceRecordId,
        restroomName: db.name,
        previousStatus: db.publicationStatus,
        status: "ambiguous",
        matchBasis: null,
        candidateCount: matchedCandidates.length,
        candidateRowNumbers: matchedCandidates.map((c) => c.row.rowNumber),
        matchedRowNumber: null,
        coordinateSource: null,
        coordinateSourceRecordId: null,
        latitude: null,
        longitude: null,
        dataStdDate: null,
      });
      continue;
    }

    const { row: winner, basis } = matchedCandidates[0];
    if (winner.latitude === null || winner.longitude === null) {
      missingCoordsCount += 1;
      items.push({
        restroomId: db.id,
        sourceRecordId: db.sourceRecordId,
        restroomName: db.name,
        previousStatus: db.publicationStatus,
        status: "missing_coords",
        matchBasis: basis,
        candidateCount: 1,
        candidateRowNumbers: [winner.rowNumber],
        matchedRowNumber: winner.rowNumber,
        coordinateSource: null,
        coordinateSourceRecordId: buildGgSourceRecordId(winner),
        latitude: null,
        longitude: null,
        dataStdDate: winner.dataStdDate || null,
      });
      continue;
    }

    matchedCount += 1;
    if (db.publicationStatus === "draft") matchedDraftCount += 1;
    else matchedPublishedCount += 1;

    items.push({
      restroomId: db.id,
      sourceRecordId: db.sourceRecordId,
      restroomName: db.name,
      previousStatus: db.publicationStatus,
      status: "matched",
      matchBasis: basis,
      candidateCount: 1,
      candidateRowNumbers: [winner.rowNumber],
      matchedRowNumber: winner.rowNumber,
      coordinateSource: "gg_publtolt_15011425",
      coordinateSourceRecordId: buildGgSourceRecordId(winner),
      latitude: winner.latitude,
      longitude: winner.longitude,
      dataStdDate: winner.dataStdDate || null,
    });
  }

  return {
    totalTargets: dbTargets.length,
    matchedCount,
    missingCoordsCount,
    ambiguousCount,
    unmatchedCount,
    eligibleForRemoteCount: matchedCount,
    matchedPublishedCount,
    matchedDraftCount,
    items,
  };
}
