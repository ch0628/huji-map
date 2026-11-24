/**
 * Public Data Import Types and DTOs
 * Based on docs/03_DATA_MODEL.md, docs/08_SECURITY_OPERATIONS.md, and tasks/11_public_import.md
 */

export interface RawPublicRestroomRecord {
  개방자치단체코드?: string;
  화장실관리번호?: string;
  관리번호?: string;
  연번?: string;
  화장실명?: string;
  구분?: string;
  구분명?: string;
  소재지도로명주소?: string;
  소재지지번주소?: string;
  남녀공용화장실여부?: string;
  "남성용-대변기수"?: string;
  "남성용-소변기수"?: string;
  "남성용-장애인용대변기수"?: string;
  "남성용-장애인용소변기수"?: string;
  "남성용-어린이용대변기수"?: string;
  "남성용-어린이용소변기수"?: string;
  "여성용-대변기수"?: string;
  "여성용-장애인용대변기수"?: string;
  "여성용-어린이용대변기수"?: string;
  관리기관명?: string;
  전화번호?: string;
  개방시간?: string;
  개방시간상세?: string;
  설치연월?: string;
  WGS84위도?: string;
  위도?: string;
  WGS84경도?: string;
  경도?: string;
  화장실소유구분?: string;
  화장실소유구분명?: string;
  오물처리방식?: string;
  비상벨설치여부?: string;
  비상벨설치장소?: string;
  화장실입구CCTV설치유무?: string;
  기저귀교환대유무?: string;
  기저귀교환대장소?: string;
  데이터기준일자?: string;
  데이터갱신구분?: string;
  [key: string]: string | undefined;
}

export interface ParsedPublicRestroom {
  sourceRecordId: string;
  name: string;
  description: string | null;
  roadAddress: string;
  addressDetail: string | null;
  latitude: number | null;
  longitude: number | null;
  genderType: "male" | "female" | "separate" | "unisex" | "unknown";
  wheelchairAccessible: boolean | null;
  babyChangingAvailable: boolean | null;
  sanitaryProductsAvailable: boolean | null;
  accessMethod: "open";
  publicationStatus: "published" | "draft";
  lastVerifiedAt: string;
  rawMetadata: Record<string, any>;
}

export interface PublicSourceConfig {
  providerName: string;
  datasetName: string;
  sourceUrl: string;
  apiEndpoint?: string | null;
  licenseName?: string | null;
  licenseUrl?: string | null;
  attributionText?: string | null;
}

export type GeocodeFatalStopReason =
  | "quota_exceeded"
  | "rate_limited"
  | "auth_error";

export interface GeocodeResult {
  status: "success" | "not_found" | "uncertain" | "error";
  latitude: number | null;
  longitude: number | null;
  matchedAddress?: string | null;
  addressType?: string | null;
  queryUsed?: string | null;
  reason?: string;
  fatalStopReason?: GeocodeFatalStopReason;
}

export interface GeocoderStats {
  date: string;
  dailyLimit: number;
  maxCallsPerRun: number | null;
  todayHttpCalls: number;
  runHttpCalls: number;
  remainingDailyQuota: number;
  cacheHits: number;
  successCount: number;
  notFoundCount: number;
  uncertainCount: number;
  errorCount: number;
  rateLimitedCount: number;
  fatalStopReason: GeocodeFatalStopReason | null;
}

export type AddressGeocoder = ((params: {
  roadAddress: string;
  jibunAddress: string;
  agency?: string | null;
  cityFilter?: string | null;
}) => Promise<GeocodeResult>) & {
  flushCache?: () => void;
  flushUsage?: () => void;
  getStats?: () => GeocoderStats;
};

export interface ImportCheckpoint {
  version: 1;
  fileSha256: string;
  cityFilter: string | null;
  batchSize: number;
  totalValidRecords: number;
  nextIndex: number;
  status: "in_progress" | "paused" | "interrupted" | "completed";
  stoppedReason: string | null;
  stats: {
    insertedCount: number;
    updatedCount: number;
    skippedCount: number;
    skippedUnlocatedNewCount: number;
    preservedExistingCount: number;
    geocodeSuccessCount: number;
    geocodeFailedCount: number;
    errorCount: number;
  };
  updatedAt: string;
}

export interface BatchProgress {
  batchIndex: number;
  totalBatches: number;
  processedRecords: number;
  totalValidRecords: number;
  insertedCount: number;
  updatedCount: number;
  skippedCount: number;
  skippedUnlocatedNewCount: number;
  geocodeSuccessCount: number;
  geocodeFailedCount: number;
  runHttpCalls: number;
  todayHttpCalls: number;
}

export interface ImportOptions {
  sourceConfig?: Partial<PublicSourceConfig>;
  dryRun?: boolean;
  batchSize?: number;
  cityFilter?: string | null;
  preserveAdminStatus?: boolean;
  skipUnlocatedNew?: boolean;
  regeocodeExisting?: boolean;
  checkpointPath?: string | null;
  resume?: boolean;
  signal?: AbortSignal;
  onBatchProgress?: (progress: BatchProgress) => void;
  geocoder?: AddressGeocoder;
  geocodeConcurrency?: number;
}

export interface ImportErrorDetail {
  recordId?: string;
  line?: number;
  reason: string;
}

export interface ImportRunResult {
  runId: string;
  sourceId: string;
  status: "success" | "failed" | "paused";
  fetchedCount: number;
  cityMatchedCount?: number;
  duplicateCount?: number;
  geocodeSuccessCount?: number;
  geocodeFailedCount?: number;
  skippedUnlocatedNewCount?: number;
  preservedExistingCount?: number;
  publishedCount?: number;
  draftCount?: number;
  insertedCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  errors: ImportErrorDetail[];
  startedAt: string;
  finishedAt: string;
  errorMessage?: string | null;
  stoppedReason?: string | null;
  resumedFromIndex?: number;
  nextIndex?: number;
  totalValidRecords?: number;
  geocodeStats?: GeocoderStats | null;
}

/**
 * Default source configuration for Suwon City Public Restrooms
 */
export const DEFAULT_SUWON_SOURCE_CONFIG: PublicSourceConfig = {
  providerName: "경기도 수원시",
  datasetName: "공중화장실 현황",
  sourceUrl: "https://www.data.go.kr/data/15012892/fileData.do",
  apiEndpoint: null,
  licenseName: "이용허락범위 제한 없음",
  licenseUrl: "https://www.data.go.kr/ugs/selectPortalPolicyView.do",
  attributionText: "출처: 공공데이터포털(data.go.kr) / 경기도 수원시",
};

