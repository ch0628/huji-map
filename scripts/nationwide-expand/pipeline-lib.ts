import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { decodeCsvBuffer, parseCsv } from "../../src/lib/imports/parser";
import {
  extractEupMyeonDongName,
  resolveAdminRegionForRecord,
} from "../../src/lib/restrooms/korea-admin-regions";
import type { CoordinateSource, GenderType } from "../../src/lib/restrooms/types";

export interface ExistingOfficialRef {
  id: string;
  source_id: string | null;
  source_record_id: string | null;
  type: "public" | "partner";
  name: string;
  road_address: string;
  latitude: number | null;
  longitude: number | null;
  coordinate_source: string | null;
}

export interface OfficialDataSourceSpec {
  key: string;
  datasetId: string;
  providerName: string;
  datasetName: string;
  sourceUrl: string;
  licenseName: string;
  licenseUrl: string;
  attributionText: string;
  coordinateSource: CoordinateSource;
}

export interface PreparedOfficialRestroom {
  id: string;
  datasetKey: string;
  datasetId: string;
  sourceRecordId: string;
  coordinateSource: CoordinateSource;
  coordinateSourceRecordId: string;
  name: string;
  description: string | null;
  roadAddress: string;
  addressDetail: string | null;
  latitude: number;
  longitude: number;
  floor: string | null;
  entranceInstructions: string | null;
  genderType: GenderType;
  wheelchairAccessible: boolean | null;
  babyChangingAvailable: boolean | null;
  lastVerifiedAt: string;
  verificationBasis: string;
  sourceVersion: string;
  matchedNationalSourceRecordId: string | null;
}

export interface HeldDatasetItem {
  datasetKey: string;
  name: string;
  reason: string;
}

export interface DatasetAuditSummary {
  key: string;
  datasetId: string;
  providerName: string;
  totalRows: number;
  approvedCount: number;
  matchedNationalCount: number;
  dedupRemoteCount: number;
  heldCount: number;
  holdBreakdown: Record<string, number>;
}

export interface PreparedCandidateRow {
  sourceProvider: string;
  sourceDatasetId: string;
  sourceRecordId: string;
  name: string;
  normalizedName: string;
  roadAddress: string | null;
  jibunAddress: string | null;
  normalizedAddress: string;
  sidoCode: string;
  sigunguCode: string;
  eupmyeondongCode: string | null;
  sidoName: string;
  sigunguName: string;
  eupmyeondongName: string | null;
  adminOrgCode: string | null;
  facilityType: string | null;
  openHours: string | null;
  closedDays: string | null;
  genderType: GenderType;
  wheelchairAccessible: boolean | null;
  babyChangingAvailable: boolean | null;
  managingAgency: string | null;
  phone: string | null;
  publicMetadata: Record<string, unknown>;
  coordinateStatus: "unlocated" | "official_matched";
  matchedRestroomId: string | null;
  facilityHash: string;
  sourceBaseDate: string | null;
  licenseName: string;
  licenseUrl: string;
  attributionText: string;
}

export const OFFICIAL_SOURCE_SPECS: Record<string, OfficialDataSourceSpec> = {
  seoul_metro_15044453: {
    key: "seoul_metro_15044453",
    datasetId: "15044453",
    providerName: "서울교통공사",
    datasetName: "서울교통공사_역사공중화장실정보",
    sourceUrl: "https://www.data.go.kr/data/15044453/fileData.do",
    licenseName: "이용허락범위 제한 없음",
    licenseUrl: "https://www.data.go.kr/ugs/selectPortalPolicyView.do",
    attributionText: "출처: 서울교통공사 / 공공데이터포털(15044453)",
    coordinateSource: "seoul_metro_2026",
  },
  seoul_metro9_15120811: {
    key: "seoul_metro9_15120811",
    datasetId: "15120811",
    providerName: "서울교통공사",
    datasetName: "서울교통공사_9호선2_3단계 역사공중화장실정보",
    sourceUrl: "https://www.data.go.kr/data/15120811/fileData.do",
    licenseName: "이용허락범위 제한 없음",
    licenseUrl: "https://www.data.go.kr/ugs/selectPortalPolicyView.do",
    attributionText: "출처: 서울교통공사 / 공공데이터포털(15120811)",
    coordinateSource: "seoul_metro_2026",
  },
  incheon_michuhol_15071405: {
    key: "incheon_michuhol_15071405",
    datasetId: "15071405",
    providerName: "인천광역시 미추홀구",
    datasetName: "인천광역시 미추홀구_공중및개방화장실현황",
    sourceUrl: "https://www.data.go.kr/data/15071405/fileData.do",
    licenseName: "이용허락범위 제한 없음",
    licenseUrl: "https://www.data.go.kr/ugs/selectPortalPolicyView.do",
    attributionText: "출처: 인천광역시 미추홀구 / 공공데이터포털(15071405)",
    coordinateSource: "incheon_district_public_toilet",
  },
  incheon_yeonsu_15087382: {
    key: "incheon_yeonsu_15087382",
    datasetId: "15087382",
    providerName: "인천광역시 연수구",
    datasetName: "인천광역시 연수구_공중 및 개방화장실",
    sourceUrl: "https://www.data.go.kr/data/15087382/fileData.do",
    licenseName: "이용허락범위 제한 없음",
    licenseUrl: "https://www.data.go.kr/ugs/selectPortalPolicyView.do",
    attributionText: "출처: 인천광역시 연수구 / 공공데이터포털(15087382)",
    coordinateSource: "incheon_district_public_toilet",
  },
  incheon_seo_15090817: {
    key: "incheon_seo_15090817",
    datasetId: "15090817",
    providerName: "인천광역시 서해구",
    datasetName: "인천광역시 서해구_공중 및 개방화장실",
    sourceUrl: "https://www.data.go.kr/data/15090817/fileData.do",
    licenseName: "이용허락범위 제한 없음",
    licenseUrl: "https://www.data.go.kr/ugs/selectPortalPolicyView.do",
    attributionText: "출처: 인천광역시 서해구 / 공공데이터포털(15090817)",
    coordinateSource: "incheon_district_public_toilet",
  },
  jeonbuk_15134318: {
    key: "jeonbuk_15134318",
    datasetId: "15134318",
    providerName: "전북특별자치도",
    datasetName: "전북특별자치도_공중화장실현황",
    sourceUrl: "https://www.data.go.kr/data/15134318/fileData.do",
    licenseName: "이용허락범위 제한 없음",
    licenseUrl: "https://www.data.go.kr/ugs/selectPortalPolicyView.do",
    attributionText: "출처: 전북특별자치도 / 공공데이터포털(15134318)",
    coordinateSource: "jeonbuk_public_toilet",
  },
  gg_namyangju_15156747: {
    key: "gg_namyangju_15156747",
    datasetId: "15156747",
    providerName: "경기도 남양주시",
    datasetName: "경기도 남양주시_공중화장실 현황",
    sourceUrl: "https://www.data.go.kr/data/15156747/fileData.do",
    licenseName: "이용허락범위 제한 없음",
    licenseUrl: "https://www.data.go.kr/ugs/selectPortalPolicyView.do",
    attributionText: "출처: 경기도 남양주시 / 공공데이터포털(15156747)",
    coordinateSource: "gyeonggi_city_public_toilet",
  },
  gg_hwaseong_corp_15126950: {
    key: "gg_hwaseong_corp_15126950",
    datasetId: "15126950",
    providerName: "화성도시공사",
    datasetName: "화성도시공사_공중화장실 설치현황",
    sourceUrl: "https://www.data.go.kr/data/15126950/fileData.do",
    licenseName: "이용허락범위 제한 없음",
    licenseUrl: "https://www.data.go.kr/ugs/selectPortalPolicyView.do",
    attributionText: "출처: 화성도시공사 / 공공데이터포털(15126950)",
    coordinateSource: "gyeonggi_city_public_toilet",
  },
  gg_yangpyeong_15128752: {
    key: "gg_yangpyeong_15128752",
    datasetId: "15128752",
    providerName: "경기도 양평군",
    datasetName: "경기도 양평군_공중화장실 현황",
    sourceUrl: "https://www.data.go.kr/data/15128752/fileData.do",
    licenseName: "이용허락범위 제한 없음",
    licenseUrl: "https://www.data.go.kr/ugs/selectPortalPolicyView.do",
    attributionText: "출처: 경기도 양평군 / 공공데이터포털(15128752)",
    coordinateSource: "gyeonggi_city_public_toilet",
  },
  gg_yeoju_15105029: {
    key: "gg_yeoju_15105029",
    datasetId: "15105029",
    providerName: "경기도 여주시",
    datasetName: "경기도 여주시_개방및공중화장실현황",
    sourceUrl: "https://www.data.go.kr/data/15105029/fileData.do",
    licenseName: "이용허락범위 제한 없음",
    licenseUrl: "https://www.data.go.kr/ugs/selectPortalPolicyView.do",
    attributionText: "출처: 경기도 여주시 / 공공데이터포털(15105029)",
    coordinateSource: "gyeonggi_city_public_toilet",
  },
  gg_yangju_15160129: {
    key: "gg_yangju_15160129",
    datasetId: "15160129",
    providerName: "경기도 양주시",
    datasetName: "경기도 양주시_공중화장실 현황",
    sourceUrl: "https://www.data.go.kr/data/15160129/fileData.do",
    licenseName: "이용허락범위 제한 없음",
    licenseUrl: "https://www.data.go.kr/ugs/selectPortalPolicyView.do",
    attributionText: "출처: 경기도 양주시 / 공공데이터포털(15160129)",
    coordinateSource: "gyeonggi_city_public_toilet",
  },
  gwangju_cheon_15077275: {
    key: "gwangju_cheon_15077275",
    datasetId: "15077275",
    providerName: "광주환경공단",
    datasetName: "광주환경공단_광주천_공중화장실 운영현황",
    sourceUrl: "https://www.data.go.kr/data/15077275/fileData.do",
    licenseName: "이용허락범위 제한 없음",
    licenseUrl: "https://www.data.go.kr/ugs/selectPortalPolicyView.do",
    attributionText: "출처: 광주환경공단 / 공공데이터포털(15077275)",
    coordinateSource: "gwangju_public_toilet",
  },
  gwangju_yeongsan_15077274: {
    key: "gwangju_yeongsan_15077274",
    datasetId: "15077274",
    providerName: "광주환경공단",
    datasetName: "광주환경공단_영산강_공중화장실 운영현황",
    sourceUrl: "https://www.data.go.kr/data/15077274/fileData.do",
    licenseName: "이용허락범위 제한 없음",
    licenseUrl: "https://www.data.go.kr/ugs/selectPortalPolicyView.do",
    attributionText: "출처: 광주환경공단 / 공공데이터포털(15077274)",
    coordinateSource: "gwangju_public_toilet",
  },
  busan_dongnae_3079086: {
    key: "busan_dongnae_3079086",
    datasetId: "3079086",
    providerName: "부산광역시 동래구",
    datasetName: "부산광역시_동래구_개방화장실 현황",
    sourceUrl: "https://www.data.go.kr/data/3079086/fileData.do",
    licenseName: "이용허락범위 제한 없음",
    licenseUrl: "https://www.data.go.kr/ugs/selectPortalPolicyView.do",
    attributionText: "출처: 부산광역시 동래구 / 공공데이터포털(3079086)",
    coordinateSource: "busan_district_public_toilet",
  },
};

export function normalizeTextForMatch(input: string | null | undefined): string {
  return (input || "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[\s\-_.,/·()[\]]+/g, "")
    .toLowerCase();
}

export function normalizeAddressForMatch(input: string | null | undefined): string {
  return (input || "")
    .replace(/^\(지번\)\s*/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, "")
    .replace(/^서울시/, "서울특별시")
    .replace(/^서울(?=[가-힣]+구)/, "서울특별시")
    .replace(/^부산시/, "부산광역시")
    .replace(/^대구시/, "대구광역시")
    .replace(/^인천시/, "인천광역시")
    .replace(/^광주시/, "광주광역시")
    .replace(/^대전시/, "대전광역시")
    .replace(/^울산시/, "울산광역시")
    .replace(/^경기(?=[가-힣]+시|[가-힣]+군)/, "경기도")
    .replace(/^충북/, "충청북도")
    .replace(/^충남/, "충청남도")
    .replace(/^전라북도/, "전북특별자치도")
    .replace(/^전북/, "전북특별자치도")
    .replace(/^전남(?=[가-힣]+시|[가-힣]+군)/, "전라남도")
    .replace(/^경북/, "경상북도")
    .replace(/^경남/, "경상남도")
    .replace(/^강원도/, "강원특별자치도")
    .replace(/^강원(?=[가-힣]+시|[가-힣]+군)/, "강원특별자치도")
    .replace(/^제주도/, "제주특별자치도")
    .toLowerCase();
}

export function computeFacilityHash(name: string, address: string): string {
  const key = `${normalizeTextForMatch(name)}::${normalizeAddressForMatch(address)}`;
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
}

export function deterministicUuid(seed: string): string {
  const hex = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

const SIDO_BBOX: Record<string, { minLat: number; maxLat: number; minLng: number; maxLng: number }> = {
  서울권: { minLat: 37.35, maxLat: 37.75, minLng: 126.7, maxLng: 127.3 },
  인천: { minLat: 36.9, maxLat: 37.85, minLng: 124.6, maxLng: 126.85 },
  경기: { minLat: 36.85, maxLat: 38.3, minLng: 126.35, maxLng: 127.9 },
  전북: { minLat: 35.25, maxLat: 36.2, minLng: 126.3, maxLng: 127.95 },
  광주: { minLat: 35.02, maxLat: 35.28, minLng: 126.62, maxLng: 127.05 },
  부산: { minLat: 34.85, maxLat: 35.4, minLng: 128.75, maxLng: 129.35 },
};

const RESTRICTED_OR_PRIVATE_NAME_RE =
  /(아파트|단지|연립|빌라|초등학교|중학교|고등학교|대학교|유치원|어린이집|성당|교회|사찰|주유소|충전소|모텔|호텔|빌딩|프라자|상가|은행|농협|수협|신협|새마을금고|병원|의원|약국|치과|한의원|마트|식당|카페|골프|경비실|관리동|공군|부대|군청사내)/;

const TEMP_OR_CLOSED_RE =
  /(임시|이동식|이동화장실|공사중|철거|폐쇄|미개방|사용불가|출입제한|거주자)/;

const PUBLIC_FACILITY_HINT_RE =
  /(공원|역|터미널|시장|주차장|주민센터|행정복지센터|보건소|도서관|체육|운동장|박물관|미술관|공중화장실|면사무소|읍사무소|동사무소|청사|쉼터|광장|문화|복지관|휴게소|해수욕장|산책로|하천)/;

function parseDateIso(raw: string | null | undefined, fallbackIso: string): string {
  const s = (raw || "").trim();
  if (!s) return fallbackIso;
  // Handle YYYYMMDD
  const ymd = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  const normalized = ymd ? `${ymd[1]}-${ymd[2]}-${ymd[3]}` : s;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return fallbackIso;
  const now = new Date();
  return d > now ? now.toISOString() : d.toISOString();
}

function parseDateYmd(raw: string | null | undefined): string | null {
  const s = (raw || "").trim();
  if (!s) return null;
  const ymd = s.match(/^(\d{4})[-.]?(\d{2})[-.]?(\d{2})/);
  if (!ymd) return null;
  const dt = new Date(`${ymd[1]}-${ymd[2]}-${ymd[3]}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return null;
  if (dt > new Date()) return new Date().toISOString().slice(0, 10);
  return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
}

function inferGender(unisexRaw: string): GenderType {
  const v = (unisexRaw || "").trim().toUpperCase();
  if (v === "Y" || v === "여" || v === "공용") return "unisex";
  if (v === "N" || v === "부" || v === "분리") return "separate";
  return "unknown";
}

function inferWheelchair(raw: Record<string, string | undefined>): boolean | null {
  const fields = [
    raw["남성용-장애인용대변기수"],
    raw["여성용-장애인용대변기수"],
    raw["남성용-장애인용소변기수"],
    raw["남성용장애인용대변기수"],
    raw["여성용장애인용대변기수"],
    raw["남성용장애인용소변기수"],
    raw["남성용 장애인용대변기수"],
    raw["여성용 장애인용 대변기수"],
    raw["공용(장애인)-대변기수"],
  ];
  const nums = fields
    .filter((f): f is string => typeof f === "string" && f.trim() !== "")
    .map((f) => Number.parseInt(f.trim(), 10))
    .filter((n) => Number.isFinite(n));
  if (nums.length === 0) return null;
  return nums.some((n) => n > 0);
}

function inferBabyChanging(raw: Record<string, string | undefined>): boolean | null {
  const candidates = [
    raw["기저귀교환대유무"],
    raw["기저귀 교환대유무"],
    raw["기저귀교환대설치유무-남자화장실"],
    raw["기저귀교환대설치유무-여자화장실"],
    raw["기저귀교환대설치유무-남자장애인화장실"],
    raw["기저귀교환대설치유무-여자장애인화장실"],
  ]
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .map((v) => v.trim().toUpperCase());
  if (candidates.length === 0) return null;
  if (candidates.some((v) => v === "Y")) return true;
  if (candidates.every((v) => v === "N")) return false;
  return null;
}

interface RawMappedItem {
  sourceRecordId: string;
  name: string;
  roadAddress: string;
  jibunAddress: string;
  latStr: string;
  lngStr: string;
  gubun: string;
  ownership: string;
  openHours: string;
  agency: string;
  phone: string;
  floor: string;
  entrance: string;
  baseDate: string;
  genderRaw: string;
  extraHold?: string;
}

export function buildTask2AndTask3Packages(params: {
  rootDir?: string;
  existingRemoteRows: ExistingOfficialRef[];
}) {
  const rootDir = params.rootDir ?? process.cwd();
  const readCsv = (rel: string) =>
    parseCsv(decodeCsvBuffer(fs.readFileSync(path.join(rootDir, rel)), "auto"));

  // 1. Load 51,260 baseline + raw metadata from public_restroom_raw.csv
  const p25Rows = readCsv("local-data/address-db-poc/phase25/phase25_classification.csv");
  const raw53kRows = readCsv("local-data/public_restroom_raw.csv");
  const rawById = new Map<string, Record<string, string | undefined>>();
  for (const r of raw53kRows) {
    const id = (r["관리번호"] || "").trim();
    if (id && !rawById.has(id)) rawById.set(id, r);
  }

  // Lookup indices into 51,260 baseline
  const p25ByNameAddr = new Map<string, string>();
  for (const r of p25Rows) {
    const recId = (r.source_record_id || "").trim();
    if (!recId) continue;
    const kRoad = `${normalizeTextForMatch(r.name)}::${normalizeAddressForMatch(r.road_address)}`;
    if (r.road_address && !p25ByNameAddr.has(kRoad)) {
      p25ByNameAddr.set(kRoad, recId);
    }
    if (r.jibun_address) {
      const kJibun = `${normalizeTextForMatch(r.name)}::${normalizeAddressForMatch(r.jibun_address)}`;
      if (!p25ByNameAddr.has(kJibun)) {
        p25ByNameAddr.set(kJibun, recId);
      }
    }
  }

  // Existing remote lookup indices (Seoul 1974 + Suwon 502 + Partner 4)
  const existingByNameAddr = new Map<string, ExistingOfficialRef>();
  const existingBySourceRecordId = new Map<string, ExistingOfficialRef>();
  const existingLocated: Array<ExistingOfficialRef & { latitude: number; longitude: number }> = [];

  for (const r of params.existingRemoteRows) {
    if (r.source_record_id) existingBySourceRecordId.set(r.source_record_id, r);
    const k = `${normalizeTextForMatch(r.name)}::${normalizeAddressForMatch(r.road_address)}`;
    if (!existingByNameAddr.has(k)) existingByNameAddr.set(k, r);
    if (typeof r.latitude === "number" && typeof r.longitude === "number") {
      existingLocated.push(r as ExistingOfficialRef & { latitude: number; longitude: number });
    }
  }

  // Cross-dataset dedup state (includes remote + newly approved)
  const acceptedNameAddrSet = new Set<string>(existingByNameAddr.keys());
  const acceptedLocated: Array<{ id: string; name: string; lat: number; lng: number }> =
    existingLocated.map((r) => ({
      id: r.id,
      name: r.name,
      lat: r.latitude,
      lng: r.longitude,
    }));

  const approvedRestrooms: PreparedOfficialRestroom[] = [];
  const datasetAudits: DatasetAuditSummary[] = [];

  const runDataset = (opts: {
    key: string;
    relPath: string;
    bboxKey: string;
    requirePublicType: boolean;
    requirePublicNameHintWhenNoGubun?: boolean;
    defaultSourceVersion: string;
    mapRow: (r: Record<string, string | undefined>, idx: number) => RawMappedItem;
  }) => {
    const spec = OFFICIAL_SOURCE_SPECS[opts.key];
    const rows = readCsv(opts.relPath);
    const bbox = SIDO_BBOX[opts.bboxKey];
    const holds: Record<string, number> = {};
    const hold = (reason: string, n = 1) => {
      holds[reason] = (holds[reason] || 0) + n;
    };

    interface PoolEntry {
      mapped: RawMappedItem;
      raw: Record<string, string | undefined>;
      lat: number;
      lng: number;
    }
    const validPool: PoolEntry[] = [];

    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i];
      const m = opts.mapRow(raw, i);
      const lat = Number.parseFloat((m.latStr || "").trim());
      const lng = Number.parseFloat((m.lngStr || "").trim());

      if (!m.name || (!m.roadAddress && !m.jibunAddress)) {
        hold("missing_name_or_address");
        continue;
      }
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 33 || lat > 39 || lng < 124 || lng > 132) {
        hold("invalid_or_missing_coords");
        continue;
      }
      if (bbox && (lat < bbox.minLat || lat > bbox.maxLat || lng < bbox.minLng || lng > bbox.maxLng)) {
        hold("coord_outside_region_bbox");
        continue;
      }
      if (m.extraHold) {
        hold(m.extraHold);
        continue;
      }
      if (TEMP_OR_CLOSED_RE.test(`${m.name} ${m.gubun} ${m.openHours}`)) {
        hold("temporary_mobile_or_closed");
        continue;
      }
      if (m.ownership && /민간|개인|법인/.test(m.ownership)) {
        hold("private_ownership_unclear_access");
        continue;
      }
      if (opts.requirePublicType && /개방/.test(m.gubun) && !/공중/.test(m.gubun)) {
        if (RESTRICTED_OR_PRIVATE_NAME_RE.test(m.name) || !m.openHours || m.openHours === ":~:") {
          hold("open_private_unclear_access");
          continue;
        }
      }
      if (opts.requirePublicNameHintWhenNoGubun && !PUBLIC_FACILITY_HINT_RE.test(m.name)) {
        hold("unclassified_non_public_name");
        continue;
      }
      if (RESTRICTED_OR_PRIVATE_NAME_RE.test(m.name) && !PUBLIC_FACILITY_HINT_RE.test(m.name)) {
        hold("non_public_facility_name_risk");
        continue;
      }

      validPool.push({ mapped: m, raw, lat, lng });
    }

    // Group by 5-decimal coordinate (~1.1m) to block complex office copies & collapse multi-floor same building
    const coordGroups = new Map<string, PoolEntry[]>();
    for (const entry of validPool) {
      const ck = `${entry.lat.toFixed(5)},${entry.lng.toFixed(5)}`;
      const arr = coordGroups.get(ck) || [];
      arr.push(entry);
      coordGroups.set(ck, arr);
    }

    let approvedCount = 0;
    let matchedNationalCount = 0;
    let dedupRemoteCount = 0;

    const tryAccept = (entry: PoolEntry) => {
      const m = entry.mapped;
      const addr = m.roadAddress || m.jibunAddress;
      const kRoad = `${normalizeTextForMatch(m.name)}::${normalizeAddressForMatch(addr)}`;
      const kJibun = m.jibunAddress
        ? `${normalizeTextForMatch(m.name)}::${normalizeAddressForMatch(m.jibunAddress)}`
        : "";

      if (acceptedNameAddrSet.has(kRoad) || (kJibun && acceptedNameAddrSet.has(kJibun))) {
        if (existingByNameAddr.has(kRoad) || (kJibun && existingByNameAddr.has(kJibun))) {
          dedupRemoteCount++;
        }
        hold("duplicate_name_addr");
        return;
      }

      // Spatial proximity check against already accepted/remote rows (< 30m with overlapping name token)
      const normMName = normalizeTextForMatch(m.name);
      const nearDup = acceptedLocated.find((other) => {
        if (Math.abs(other.lat - entry.lat) > 0.0004 || Math.abs(other.lng - entry.lng) > 0.0004) {
          return false;
        }
        const d = haversineM(other.lat, other.lng, entry.lat, entry.lng);
        if (d > 30) return false;
        const normOther = normalizeTextForMatch(other.name);
        return (
          normOther === normMName ||
          (normMName.length >= 3 && normOther.includes(normMName)) ||
          (normOther.length >= 3 && normMName.includes(normOther))
        );
      });
      if (nearDup) {
        hold("duplicate_proximity_with_existing");
        return;
      }

      acceptedNameAddrSet.add(kRoad);
      if (kJibun) acceptedNameAddrSet.add(kJibun);

      const matchedNatId =
        p25ByNameAddr.get(kRoad) ||
        (kJibun ? p25ByNameAddr.get(kJibun) : undefined) ||
        null;
      if (matchedNatId) matchedNationalCount++;

      const descParts: string[] = [];
      if (m.openHours && m.openHours !== ":~:") descParts.push(`개방시간: ${m.openHours}`);
      if (m.agency) descParts.push(`관리: ${m.agency}`);
      if (m.phone) descParts.push(`전화: ${m.phone}`);
      const baseDateYmd = parseDateYmd(m.baseDate) || opts.defaultSourceVersion;
      descParts.push(`출처: ${spec.attributionText}`);
      descParts.push(`기준일: ${baseDateYmd}`);
      const description = descParts.join(" / ").slice(0, 2000);

      const id = deterministicUuid(`official:${spec.datasetId}:${m.sourceRecordId}`);
      const coordSourceRecordId = `${spec.datasetId}-${m.sourceRecordId}`.slice(0, 200);

      approvedRestrooms.push({
        id,
        datasetKey: spec.key,
        datasetId: spec.datasetId,
        sourceRecordId: m.sourceRecordId.slice(0, 100),
        coordinateSource: spec.coordinateSource,
        coordinateSourceRecordId: coordSourceRecordId,
        name: m.name.slice(0, 200),
        description,
        roadAddress: addr.slice(0, 300),
        addressDetail:
          m.jibunAddress && m.roadAddress && m.jibunAddress !== m.roadAddress
            ? `(지번) ${m.jibunAddress}`.slice(0, 200)
            : null,
        latitude: entry.lat,
        longitude: entry.lng,
        floor: m.floor ? m.floor.slice(0, 50) : null,
        entranceInstructions: m.entrance ? m.entrance.slice(0, 1000) : null,
        genderType: inferGender(m.genderRaw),
        wheelchairAccessible: inferWheelchair(entry.raw),
        babyChangingAvailable: inferBabyChanging(entry.raw),
        lastVerifiedAt: parseDateIso(m.baseDate, `${opts.defaultSourceVersion}T00:00:00.000Z`),
        verificationBasis: `POLICY=OFFICIAL_SOURCE_VALIDATED|FIELD_VERIFIED=false|source=${spec.coordinateSource}(${coordSourceRecordId})`,
        sourceVersion: baseDateYmd,
        matchedNationalSourceRecordId: matchedNatId,
      });

      acceptedLocated.push({ id, name: m.name, lat: entry.lat, lng: entry.lng });
      approvedCount++;
    };

    for (const [, grp] of coordGroups) {
      if (grp.length >= 3) {
        const bases = new Set(
          grp.map((x) =>
            x.mapped.name.replace(/\s*(지하|지상)?\s*\d+층.*$/, "").trim()
          )
        );
        if (bases.size === 1) {
          const rep = grp.find((x) => /1층/.test(x.mapped.name)) || grp[0];
          tryAccept(rep);
          hold("collapsed_same_building_floors", grp.length - 1);
        } else {
          hold("shared_coord_complex_copy", grp.length);
        }
        continue;
      }
      for (const entry of grp) {
        tryAccept(entry);
      }
    }

    datasetAudits.push({
      key: spec.key,
      datasetId: spec.datasetId,
      providerName: spec.providerName,
      totalRows: rows.length,
      approvedCount,
      matchedNationalCount,
      dedupRemoteCount,
      heldCount: rows.length - approvedCount,
      holdBreakdown: holds,
    });
  };

  // Run datasets in deterministic priority order
  runDataset({
    key: "seoul_metro_15044453",
    relPath: "local-data/서울교통공사_역사공중화장실정보_20260212.csv",
    bboxKey: "서울권",
    requirePublicType: false,
    defaultSourceVersion: "2026-02-12",
    mapRow: (r, i) => ({
      sourceRecordId: `METRO18-SEQ-${(r["연번"] || String(i + 1)).trim()}`,
      name: `${(r["역명"] || "").trim()}역 ${(r["운영노선명"] || "").trim()} 화장실`.trim(),
      roadAddress: (r["소재지도로명주소"] || "").trim(),
      jibunAddress: (r["소재지지번주소"] || "").trim(),
      latStr: r["위도"] || "",
      lngStr: r["경도"] || "",
      gubun: r["구분"] || "공중화장실",
      ownership: "서울교통공사",
      openHours: (r["개방시간"] || "").trim(),
      agency: (r["관리기관명"] || "서울교통공사").trim(),
      phone: (r["전화번호"] || "").trim(),
      floor: (r["역층"] || "").trim() ? `${(r["지상 또는 지하 구분"] || "").trim()} ${(r["역층"] || "").trim()}층`.trim() : "",
      entrance: (r["상세위치"] || "").trim(),
      baseDate: (r["데이터기준일자"] || "").trim(),
      genderRaw: r["남녀공용화장실여부"] || "",
      extraHold: (r["게이트 내외 구분"] || "").includes("내부") ? "inside_subway_fare_gate" : undefined,
    }),
  });

  runDataset({
    key: "seoul_metro9_15120811",
    relPath: "local-data/official-datasets/15120811.csv",
    bboxKey: "서울권",
    requirePublicType: false,
    defaultSourceVersion: "2026-01-31",
    mapRow: (r, i) => ({
      sourceRecordId: `METRO9-SEQ-${(r["연번"] || String(i + 1)).trim()}`,
      name: `${(r["화장실명(역명)"] || "").trim()}역 ${(r["호선"] || "").trim()}호선 화장실`.trim(),
      roadAddress: (r["소재지도로명주소"] || "").trim(),
      jibunAddress: (r["소재지지번주소"] || "").trim(),
      latStr: r["위도"] || "",
      lngStr: r["경도"] || "",
      gubun: r["구분"] || "공중화장실",
      ownership: "서울교통공사",
      openHours: (r["개방시간"] || "").trim(),
      agency: (r["관리기관명"] || "서울교통공사").trim(),
      phone: (r["전화번호"] || "").trim(),
      floor: (r["역층"] || "").trim() ? `${(r["지상-지하 구분"] || "").trim()} ${(r["역층"] || "").trim()}층`.trim() : "",
      entrance: (r["화장실 상세위치"] || "").trim(),
      baseDate: (r["데이터기준일자"] || "").trim(),
      genderRaw: r["남녀공용화장실여부"] || "",
      extraHold: (r["화장실 상세위치(게이트 내외부)"] || "").includes("내부") ? "inside_subway_fare_gate" : undefined,
    }),
  });

  runDataset({
    key: "incheon_michuhol_15071405",
    relPath: "local-data/인천광역시 미추홀구_공중및개방화장실현황_20260731.csv",
    bboxKey: "인천",
    requirePublicType: true,
    defaultSourceVersion: "2026-07-31",
    mapRow: (r, i) => ({
      sourceRecordId: `MIC-SEQ-${(r["연번"] || String(i + 1)).trim()}`,
      name: (r["명칭"] || "").trim(),
      roadAddress: (r["도로명주소"] || "").trim(),
      jibunAddress: (r["지번주소"] || "").trim(),
      latStr: r["위도"] || "",
      lngStr: r["경도"] || "",
      gubun: (r["구분"] || "").trim(),
      ownership: "",
      openHours: "",
      agency: (r["관리부서명"] || "미추홀구").trim(),
      phone: "",
      floor: "",
      entrance: "",
      baseDate: (r["데이터기준일자"] || "").trim(),
      genderRaw: "",
    }),
  });

  runDataset({
    key: "incheon_yeonsu_15087382",
    relPath: "local-data/인천광역시 연수구_공중 및 개방화장실_20250630.csv",
    bboxKey: "인천",
    requirePublicType: true,
    defaultSourceVersion: "2025-06-30",
    mapRow: (r, i) => ({
      sourceRecordId: `YSU-ROW-${i + 1}`,
      name: (r["화장실명"] || "").trim(),
      roadAddress: "",
      jibunAddress: (r["지번주소"] || "").trim(),
      latStr: r["위도"] || "",
      lngStr: r["경도"] || "",
      gubun: (r["구분"] || "").trim(),
      ownership: "",
      openHours: "",
      agency: "인천광역시 연수구",
      phone: "",
      floor: "",
      entrance: "",
      baseDate: "2025-06-30",
      genderRaw: "",
    }),
  });

  runDataset({
    key: "incheon_seo_15090817",
    relPath: "local-data/official-datasets/15090817.csv",
    bboxKey: "인천",
    requirePublicType: true,
    defaultSourceVersion: "2026-01-03",
    mapRow: (r, i) => ({
      sourceRecordId: `ISEO-ROW-${i + 1}`,
      name: (r["화장실명"] || "").trim(),
      roadAddress: (r["소재지도로명주소"] || "").trim(),
      jibunAddress: (r["소재지지번주소"] || "").trim(),
      latStr: r["위도"] || "",
      lngStr: r["경도"] || "",
      gubun: (r["구분"] || "").trim(),
      ownership: "",
      openHours: (r["개방시간"] || "").trim(),
      agency: (r["관리기관명"] || "인천광역시 서구").trim(),
      phone: (r["전화번호"] || "").trim(),
      floor: "",
      entrance: "",
      baseDate: (r["데이터기준일자"] || "").trim(),
      genderRaw: r["남녀공용화장실여부"] || "",
    }),
  });

  runDataset({
    key: "jeonbuk_15134318",
    relPath: "local-data/official-datasets/15134318.csv",
    bboxKey: "전북",
    requirePublicType: true,
    defaultSourceVersion: "2024-07-29",
    mapRow: (r, i) => ({
      sourceRecordId: `JB-ROW-${i + 1}`,
      name: (r["화장실명"] || "").trim(),
      roadAddress: (r["소재지주소"] || "").trim(),
      jibunAddress: (r["소재지주소"] || "").trim(),
      latStr: r["위도"] || "",
      lngStr: r["경도"] || "",
      gubun: (r["구분"] || "").trim(),
      ownership: "",
      openHours: (r["개방시간"] || "").trim(),
      agency: (r["관리기관명"] || "전북특별자치도").trim(),
      phone: "",
      floor: "",
      entrance: "",
      baseDate: "2024-07-29",
      genderRaw: "",
    }),
  });

  runDataset({
    key: "gg_namyangju_15156747",
    relPath: "local-data/official-datasets/15156747.csv",
    bboxKey: "경기",
    requirePublicType: true,
    defaultSourceVersion: "2026-01-26",
    mapRow: (r, i) => ({
      sourceRecordId: `NYJ-NO-${(r["번호"] || String(i + 1)).trim()}`,
      name: (r["화장실명"] || "").trim(),
      roadAddress: (r["소재지도로명주소"] || "").trim(),
      jibunAddress: (r["소재지지번주소"] || "").trim(),
      latStr: r["위도"] || "",
      lngStr: r["경도"] || "",
      gubun: (r["구분"] || "").trim(),
      ownership: (r["화장실소유구분"] || "").trim(),
      openHours: (r["개방시간상세"] || r["개방시간"] || "").trim(),
      agency: (r["관리기관명"] || "남양주시").trim(),
      phone: (r["전화번호"] || "").trim(),
      floor: "",
      entrance: "",
      baseDate: (r["데이터기준일자"] || "").trim(),
      genderRaw: "",
    }),
  });

  runDataset({
    key: "gg_hwaseong_corp_15126950",
    relPath: "local-data/official-datasets/15126950.csv",
    bboxKey: "경기",
    requirePublicType: false,
    defaultSourceVersion: "2025-12-31",
    mapRow: (r, i) => {
      const rawRoad = (r["소재지도로명주소"] || "").trim();
      const rawJibun = (r["소재지지번주소"] || "").trim();
      const prefix = (a: string) =>
        !a ? "" : a.includes("화성시") ? a : `경기도 화성시 ${a}`;
      return {
        sourceRecordId: `HSC-ROW-${i + 1}`,
        name: (r["화장실명"] || "").trim(),
        roadAddress: prefix(rawRoad),
        jibunAddress: prefix(rawJibun),
        latStr: r["위도"] || "",
        lngStr: r["경도"] || "",
        gubun: (r["구분"] || "").trim(),
        ownership: (r["화장실소유구분"] || "").trim(),
        openHours: (r["개방시간"] || "").trim(),
        agency: (r["관리기관명"] || "화성도시공사").trim(),
        phone: (r["전화번호"] || "").trim(),
        floor: "",
        entrance: "",
        baseDate: (r["데이터기준일자"] || "").trim(),
        genderRaw: r["남녀공용화장실여부"] || "",
      };
    },
  });

  runDataset({
    key: "gg_yangpyeong_15128752",
    relPath: "local-data/official-datasets/15128752.csv",
    bboxKey: "경기",
    requirePublicType: true,
    defaultSourceVersion: "2025-12-09",
    mapRow: (r, i) => ({
      sourceRecordId: `YP-SEQ-${(r["연번"] || String(i + 1)).trim()}`,
      name: (r["화장실명"] || "").trim(),
      roadAddress: (r["도로명주소"] || "").trim(),
      jibunAddress: "",
      latStr: r["위도"] || "",
      lngStr: r["경도"] || "",
      gubun: (r["공중화장실 등의 구분"] || "").trim(),
      ownership: "",
      openHours: (r["개방시간상세"] || r["개방시간"] || "").trim(),
      agency: (r["관리기관명"] || "양평군").trim(),
      phone: (r["관리기관 전화번호"] || "").trim(),
      floor: "",
      entrance: "",
      baseDate: (r["데이터기준일자"] || "").trim(),
      genderRaw: r["남녀공용화장실여부"] || "",
    }),
  });

  runDataset({
    key: "gg_yeoju_15105029",
    relPath: "local-data/official-datasets/15105029.csv",
    bboxKey: "경기",
    requirePublicType: true,
    defaultSourceVersion: "2026-06-16",
    mapRow: (r, i) => ({
      sourceRecordId: `YJ-ROW-${i + 1}`,
      name: (r["화장실명"] || "").trim(),
      roadAddress: (r["소재지도로명주소"] || "").trim(),
      jibunAddress: (r["소재지지번주소"] || "").trim(),
      latStr: r["위도"] || "",
      lngStr: r["경도"] || "",
      gubun: (r["화장실구분"] || "").trim(),
      ownership: (r["화장실소유구분"] || "").trim(),
      openHours: (r["개방시간"] || "").trim(),
      agency: (r["관리기관명"] || "여주시").trim(),
      phone: (r["관리기관전화번호"] || "").trim(),
      floor: "",
      entrance: "",
      baseDate: (r["데이터기준일자"] || "").trim(),
      genderRaw: r["남녀공용화장실여부"] || "",
    }),
  });

  runDataset({
    key: "gg_yangju_15160129",
    relPath: "local-data/official-datasets/15160129.csv",
    bboxKey: "경기",
    requirePublicType: false,
    requirePublicNameHintWhenNoGubun: true,
    defaultSourceVersion: "2026-06-30",
    mapRow: (r, i) => ({
      sourceRecordId: `YJU-ROW-${i + 1}`,
      name: (r["공중화장실명(건물명)"] || "").trim(),
      roadAddress: (r["소재지 도로명주소"] || "").trim(),
      jibunAddress: (r["소재지주소"] || "").trim(),
      latStr: r["위도"] || "",
      lngStr: r["경도"] || "",
      gubun: "공중화장실",
      ownership: "",
      openHours: "",
      agency: "양주시",
      phone: "",
      floor: "",
      entrance: "",
      baseDate: "2026-06-30",
      genderRaw: "",
    }),
  });

  runDataset({
    key: "gwangju_cheon_15077275",
    relPath: "local-data/official-datasets/15077275.csv",
    bboxKey: "광주",
    requirePublicType: false,
    defaultSourceVersion: "2026-02-23",
    mapRow: (r, i) => ({
      sourceRecordId: `GJC-ROW-${i + 1}`,
      name: (r["화장실명"] || "").trim(),
      roadAddress: (r["소재지도로명주소"] || "").trim(),
      jibunAddress: (r["소재지지번주소"] || "").trim(),
      latStr: r["위도"] || "",
      lngStr: r["경도"] || "",
      gubun: (r["구분"] || "공중화장실").trim(),
      ownership: "광주환경공단",
      openHours: (r["개방시간"] || "").trim(),
      agency: (r["관리기관명"] || "광주환경공단").trim(),
      phone: (r["전화번호"] || "").trim(),
      floor: "",
      entrance: "",
      baseDate: (r["데이터기준일자"] || "").trim(),
      genderRaw: r["남녀공용화장실여부"] || "",
    }),
  });

  runDataset({
    key: "gwangju_yeongsan_15077274",
    relPath: "local-data/official-datasets/15077274.csv",
    bboxKey: "광주",
    requirePublicType: false,
    defaultSourceVersion: "2026-02-20",
    mapRow: (r, i) => ({
      sourceRecordId: `GJY-ROW-${i + 1}`,
      name: (r["화장실명"] || "").trim(),
      roadAddress: "",
      jibunAddress: (r["소재지지번주소"] || "").trim(),
      latStr: r["위도"] || "",
      lngStr: r["경도"] || "",
      gubun: (r["구분"] || "공중화장실").trim(),
      ownership: "광주환경공단",
      openHours: (r["개방시간"] || "").trim(),
      agency: (r["관리기관명"] || "광주환경공단").trim(),
      phone: (r["전화번호"] || "").trim(),
      floor: "",
      entrance: "",
      baseDate: (r["데이터기준일자"] || "").trim(),
      genderRaw: r["남녀공용화장실여부"] || "",
    }),
  });

  runDataset({
    key: "busan_dongnae_3079086",
    relPath: "local-data/official-datasets/3079086.csv",
    bboxKey: "부산",
    requirePublicType: true,
    defaultSourceVersion: "2026-06-01",
    mapRow: (r, i) => {
      const rawRoad = (r["도로명주소"] || "").trim();
      const roadAddress =
        rawRoad === "미집계데이터" || rawRoad === "미입력" || rawRoad === "-"
          ? ""
          : rawRoad;
      return {
        sourceRecordId: `BDN-SEQ-${(r["연번"] || String(i + 1)).trim()}`,
        name: (r["화장실명"] || "").trim(),
        roadAddress,
        jibunAddress: (r["지번주소"] || "").trim(),
      latStr: r["위도"] || "",
      lngStr: r["경도"] || "",
      gubun: (r["공중화장실 구분"] || "").trim(),
      ownership: (r["소유자유형"] || "").trim(),
      openHours: (r["개방시간"] || "").trim(),
      agency: (r["관리기관명"] || "부산광역시 동래구").trim(),
      phone: (r["관리기관 전화번호"] || "").trim(),
      floor: "",
      entrance: "",
      baseDate: (r["데이터기준일자"] || "").trim(),
      genderRaw: r["남녀공용 화장실여부"] || "",
      extraHold: r["자료공개 여부"] === "N" ? "not_publicly_disclosed" : undefined,
      };
    },
  });

  // Build fast lookup from official restrooms (remote + newly approved) for TASK 3 candidate matching
  const officialBySrcId = new Map<string, string>();
  const officialByNameAddr = new Map<string, string>();
  for (const r of params.existingRemoteRows) {
    if (r.source_record_id) officialBySrcId.set(r.source_record_id, r.id);
    const k = `${normalizeTextForMatch(r.name)}::${normalizeAddressForMatch(r.road_address)}`;
    if (!officialByNameAddr.has(k)) officialByNameAddr.set(k, r.id);
  }
  for (const r of approvedRestrooms) {
    if (r.matchedNationalSourceRecordId) {
      officialBySrcId.set(r.matchedNationalSourceRecordId, r.id);
    }
    const k = `${normalizeTextForMatch(r.name)}::${normalizeAddressForMatch(r.roadAddress)}`;
    if (!officialByNameAddr.has(k)) officialByNameAddr.set(k, r.id);
  }

  // 2. Build TASK 3 candidate rows from the 51,260 national baseline
  const candidates: PreparedCandidateRow[] = [];
  let candidateUnlocatedCount = 0;
  let candidateOfficialMatchedCount = 0;
  let candidateRegionFallbackCount = 0;
  const hashGroupCounts = new Map<string, number>();

  for (const p of p25Rows) {
    const recId = (p.source_record_id || "").trim();
    if (!recId) continue;
    const raw = rawById.get(recId) || {};
    const name = (raw["화장실명"] || p.name || "").trim();
    const roadAddress = (raw["소재지도로명주소"] || p.road_address || "").trim() || null;
    const rawJibun = (raw["소재지지번주소"] || p.jibun_address || "")
      .replace(/^\(지번\)\s*/, "")
      .trim() || null;
    const primaryAddr = roadAddress || rawJibun || "";
    const orgCode = (raw["개방자치단체코드"] || "").trim() || null;

    const region = resolveAdminRegionForRecord({
      adminOrgCode: orgCode,
      roadAddress,
      jibunAddress: rawJibun,
    });

    const sidoCode = region?.sidoCode || "99";
    const sigunguCode = region?.sigunguCode || "99999";
    const sidoName = region?.sidoName || "(미분류)";
    const sigunguName = region?.sigunguName || "(미분류)";
    if (!region) candidateRegionFallbackCount++;

    const eupName = extractEupMyeonDongName(roadAddress, rawJibun);
    const normName = normalizeTextForMatch(name) || name.toLowerCase();
    const normAddr = normalizeAddressForMatch(primaryAddr) || primaryAddr.toLowerCase();
    const facilityHash = computeFacilityHash(name, primaryAddr);
    hashGroupCounts.set(facilityHash, (hashGroupCounts.get(facilityHash) || 0) + 1);

    const kRoad = roadAddress ? `${normName}::${normalizeAddressForMatch(roadAddress)}` : "";
    const kJibun = rawJibun ? `${normName}::${normalizeAddressForMatch(rawJibun)}` : "";

    const matchedId =
      officialBySrcId.get(recId) ||
      (kRoad ? officialByNameAddr.get(kRoad) : undefined) ||
      (kJibun ? officialByNameAddr.get(kJibun) : undefined) ||
      null;

    const status: "unlocated" | "official_matched" = matchedId
      ? "official_matched"
      : "unlocated";
    if (status === "official_matched") candidateOfficialMatchedCount++;
    else candidateUnlocatedCount++;

    const openHoursParts = [
      (raw["개방시간"] || "").trim(),
      (raw["개방시간상세"] || "").trim(),
    ].filter(Boolean);

    candidates.push({
      sourceProvider: "행정안전부 / 전국 지자체",
      sourceDatasetId: "15012892",
      sourceRecordId: recId,
      name: name.slice(0, 200),
      normalizedName: normName.slice(0, 200),
      roadAddress: roadAddress ? roadAddress.slice(0, 300) : null,
      jibunAddress: rawJibun ? rawJibun.slice(0, 300) : null,
      normalizedAddress: normAddr.slice(0, 300),
      sidoCode,
      sigunguCode,
      eupmyeondongCode: null,
      sidoName: sidoName.slice(0, 60),
      sigunguName: sigunguName.slice(0, 60),
      eupmyeondongName: eupName ? eupName.slice(0, 60) : null,
      adminOrgCode: orgCode,
      facilityType: (raw["구분명"] || "").trim().slice(0, 60) || null,
      openHours: openHoursParts.join(" ").slice(0, 500) || null,
      closedDays: null,
      genderType: inferGender(raw["남녀공용화장실여부"] || ""),
      wheelchairAccessible: inferWheelchair(raw),
      babyChangingAvailable: inferBabyChanging(raw),
      managingAgency: (raw["관리기관명"] || "").trim().slice(0, 150) || null,
      phone: (raw["전화번호"] || "").trim().slice(0, 60) || null,
      publicMetadata: {
        ownership: (raw["화장실소유구분명"] || "").trim() || null,
        lawBasis: (raw["근거법령명"] || "").trim() || null,
        cctv: (raw["화장실입구CCTV설치유무"] || "").trim() || null,
        emergencyBell: (raw["비상벨설치여부"] || "").trim() || null,
      },
      coordinateStatus: status,
      matchedRestroomId: matchedId,
      facilityHash,
      sourceBaseDate: parseDateYmd(raw["데이터기준일자"]),
      licenseName: "이용허락범위 제한 없음",
      licenseUrl: "https://www.data.go.kr/data/15012892/standard.do",
      attributionText: "출처: 공공데이터포털(data.go.kr) / 행정안전부 및 전국 지자체",
    });
  }

  const heldDatasets: HeldDatasetItem[] = [
    {
      datasetKey: "gg_publtolt_15011425_non_suwon",
      name: "경기도 공중화장실 현황 (15011425, 수원 제외 3,839건 FACILITY_PIN 포함 11,217건)",
      reason: "경기데이터드림 약관(termsPolicyPage.do) 제12조⑥항(사전 승인 없는 상업적 사용 제한)·제14조②항 9호(영리행위 금지)와 data.go.kr 문구 충돌 미해소로 보류 (기존 수원 502건만 보존)",
    },
    {
      datasetKey: "mois_address_db_building_pin",
      name: "행정안전부 위치정보요약DB / 내비게이션용DB (BUILDING_PIN 22,658건)",
      reason: "행안부 주소정보 DB 좌표를 인터넷 지도에 게시하거나 운영 DB에 영구 적재 금지 지침 준수",
    },
    {
      datasetKey: "seoul_oa22586_excluded_subset",
      name: "서울시 OA-22586 기제외 2,573건 (민간개방 1,443, 지하철 351, 보류 공공개방 779)",
      reason: "기존 서울 1,974건 카나리 안전 기준(민간개방·불명확 출입조건·주소누락·인접중복) 유지 및 지하철은 서울교통공사 공식 데이터로 분리 처리",
    },
    {
      datasetKey: "ulsan_corp_15109751",
      name: "울산광역시도시공사_공중화장실 (12건)",
      reason: "공동주택 관리동·주민공동시설·경비실(폐쇄 포함)로 일반 대중 출입 조건 불분명하여 전량 보류",
    },
    {
      datasetKey: "pyeongtaek_bell_15101206",
      name: "경기도 평택시_공중화장실비상벨현황 (304건)",
      reason: "비상벨 설치 위치 목록(남/여 중복)이며 화장실 개방여부·운영시간 검증 정보 부재로 보류",
    },
    {
      datasetKey: "ulsan_bell_15171098",
      name: "울산시설공단_공원 화장실 비상벨 현황 (26건)",
      reason: "비상벨 설치 현황 데이터로 화장실 운영·개방 조건 정보 부재로 보류",
    },
  ];

  const duplicateHashGroups = Array.from(hashGroupCounts.values()).filter((c) => c > 1).length;

  return {
    approvedRestrooms,
    datasetAudits,
    heldDatasets,
    candidates,
    stats: {
      officialNewCount: approvedRestrooms.length,
      officialMatchedNationalCount: approvedRestrooms.filter((r) => r.matchedNationalSourceRecordId !== null).length,
      candidateTotalCount: candidates.length,
      candidateUnlocatedCount,
      candidateOfficialMatchedCount,
      candidateRegionFallbackCount,
      duplicateHashGroups,
    },
  };
}
