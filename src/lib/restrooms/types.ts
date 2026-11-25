/**
 * Type definitions for Restroom Catalog, Hours, Policies, and Photos
 * Based on docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, and tasks/09_restroom_schema.md
 */

export type RestroomType = "public" | "partner";

export type GenderType = "male" | "female" | "separate" | "unisex" | "unknown";

export type AccessMethod = "open" | "ask_staff" | "pin";

export type PublicationStatus =
  | "draft"
  | "pending"
  | "published"
  | "suspended"
  | "archived";

export type AccessMode = "free" | "test_deposit" | "real_deposit";

export type RestroomPhotoType =
  | "exterior"
  | "entrance"
  | "interior"
  | "signage"
  | "other";

export type PhotoModerationStatus = "pending" | "approved" | "rejected";

export type PublicImportStatus = "running" | "success" | "failed";

export interface PublicDataSource {
  id: string; // uuid
  provider_name: string;
  dataset_name: string;
  source_url: string;
  api_endpoint: string | null;
  license_name: string | null;
  license_url: string | null;
  attribution_text: string | null;
  last_synced_at: string | null;
  created_at: string;
}

export interface PublicImportRun {
  id: string; // uuid
  source_id: string; // uuid referencing public_data_sources(id)
  started_at: string;
  finished_at: string | null;
  status: PublicImportStatus;
  fetched_count: number;
  inserted_count: number;
  updated_count: number;
  error_count: number;
  error_message: string | null;
}

export type CoordinateSource =
  | "gg_publtolt_15011425"
  | "mois_address_nav_db"
  | "mois_address_summary_db"
  | "seoul_public_toilet_info"
  | "seoul_metro_2026"
  | "seoul_park_public_toilet"
  | "incheon_district_public_toilet"
  | "gyeonggi_city_public_toilet"
  | "jeonbuk_public_toilet"
  | "gwangju_public_toilet"
  | "busan_district_public_toilet"
  | "jeju_public_toilet"
  | "daejeon_public_toilet"
  | "ulsan_public_toilet"
  | "chungbuk_public_toilet"
  | "knps_national_park_toilet"
  | "mois_bike_trail_toilet"
  | "mof_beach_toilet"
  | "kex_highway_rest_area_toilet"
  | "kakao_geocode"
  | "partner_kakao_js"
  | "admin_manual"
  | "public_csv_original"
  | "other";

export type CoordinateType =
  | "facility_official"
  | "building_centroid"
  | "main_entrance"
  | "complex_centroid_mean"
  | "geocoded"
  | "manual";

export type CoordinateVerificationStatus =
  | "VERIFIED"
  | "CANDIDATE"
  | "REVIEW_REQUIRED"
  | "UNMATCHED";

export interface Restroom {
  id: string; // uuid
  business_id: string | null; // uuid referencing businesses(id), required for partner
  source_id: string | null; // uuid referencing public_data_sources(id), required for public
  source_record_id: string | null;
  coordinate_source?: CoordinateSource | null;
  coordinate_source_id?: string | null;
  coordinate_source_record_id?: string | null;
  coordinate_type?: CoordinateType | null;
  coordinate_verification_status?: CoordinateVerificationStatus | null;
  coordinate_verification_basis?: string | null;
  coordinate_source_version?: string | null;
  type: RestroomType;
  name: string;
  description: string | null;
  road_address: string;
  address_detail: string | null;
  latitude: number | null;
  longitude: number | null;
  floor: string | null;
  entrance_instructions: string | null;
  gender_type: GenderType;
  wheelchair_accessible: boolean | null; // null = unverified / unknown
  baby_changing_available: boolean | null; // null = unverified / unknown
  sanitary_products_available: boolean | null; // null = unverified / unknown
  access_method: AccessMethod;
  publication_status: PublicationStatus;
  last_verified_at: string | null;
  created_by: string | null; // uuid referencing profiles(id)
  approved_by: string | null; // uuid referencing profiles(id)
  created_at: string;
  updated_at: string;
}

export interface RestroomHour {
  id: string; // uuid
  restroom_id: string; // uuid referencing restrooms(id)
  weekday: number; // 0..6 (0=Sunday)
  opens_at: string | null; // "HH:MM:SS" or "HH:MM"
  closes_at: string | null;
  is_closed: boolean;
  crosses_midnight: boolean;
}

export interface RestroomHourException {
  id: string; // uuid
  restroom_id: string; // uuid referencing restrooms(id)
  exception_date: string; // YYYY-MM-DD
  is_closed: boolean;
  opens_at: string | null;
  closes_at: string | null;
  reason: string | null;
  created_by: string | null; // uuid referencing profiles(id)
  created_at: string;
}

export interface RestroomAccessPolicy {
  id: string; // uuid
  restroom_id: string; // uuid referencing restrooms(id)
  version: number;
  access_mode: AccessMode;
  deposit_amount_krw: number | null;
  refund_eligible: boolean;
  receipt_window_hours: number | null;
  min_purchase_krw: number | null;
  is_active: boolean;
  effective_from: string;
  created_by: string | null; // uuid referencing profiles(id)
  created_at: string;
}

export interface RestroomPhoto {
  id: string; // uuid
  restroom_id: string; // uuid referencing restrooms(id)
  storage_path: string;
  photo_type: RestroomPhotoType;
  is_primary: boolean;
  moderation_status: PhotoModerationStatus;
  uploaded_by: string | null; // uuid referencing profiles(id)
  replaces_photo_id?: string | null;
  image_url?: string | null;
  created_at: string;
}

export type RestroomLocationKind = "official" | "candidate_reference";
export type RestroomLocationPrecision =
  | "facility_official"
  | "kakao_place"
  | "kakao_address";

export interface CandidateReferenceMeta {
  sido_name: string;
  sigungu_name: string;
  eupmyeondong_name: string | null;
  open_hours: string | null;
  closed_days: string | null;
  source_provider: string;
  source_dataset_id: string;
  source_base_date: string | null;
  attribution_text: string | null;
  facility_hash: string;
  coordinate_status: "unlocated";
}

/**
 * Publicly visible restroom summary for map and catalog list (GET /api/v1/restrooms)
 */
export interface PublicRestroomSummary {
  id: string;
  type: RestroomType;
  name: string;
  road_address: string;
  address_detail: string | null;
  latitude: number;
  longitude: number;
  access_method: AccessMethod;
  gender_type: GenderType;
  wheelchair_accessible: boolean | null;
  baby_changing_available: boolean | null;
  sanitary_products_available: boolean | null;
  last_verified_at: string | null;
  business_id: string | null;
  business_name?: string | null;
  deposit_amount_krw?: number | null;
  access_mode?: AccessMode | null;
  primary_photo_storage_path?: string | null;
  primary_photo_url?: string | null;
  distance_meters?: number;
  /** UI 구분용: 공식 DB 핀 vs 실시간 주소 기반 참고 위치 (메모리 전용) */
  location_kind?: RestroomLocationKind;
  location_precision?: RestroomLocationPrecision;
  candidate_meta?: CandidateReferenceMeta | null;
}

/**
 * Nationwide unlocated standard restroom candidate summary (ZERO coordinates/geohash)
 */
export interface PublicRestroomCandidateSummary {
  id: string;
  source_provider: string;
  source_dataset_id: string;
  source_record_id: string;
  name: string;
  normalized_name: string;
  road_address: string | null;
  jibun_address: string | null;
  normalized_address: string;
  sido_code: string;
  sigungu_code: string;
  eupmyeondong_code: string | null;
  sido_name: string;
  sigungu_name: string;
  eupmyeondong_name: string | null;
  facility_type: string | null;
  open_hours: string | null;
  closed_days: string | null;
  gender_type: GenderType;
  wheelchair_accessible: boolean | null;
  baby_changing_available: boolean | null;
  coordinate_status: "unlocated";
  facility_hash: string;
  source_base_date: string | null;
  attribution_text: string | null;
}

export interface CandidateViewportResponse {
  items: PublicRestroomCandidateSummary[];
  regionCodes: string[];
  regionNames: string[];
  tooWide: boolean;
  totalReturned: number;
}

/**
 * Public business information returned in catalog/restroom detail (GET /api/v1/businesses/:id)
 */
export interface PublicBusinessInfo {
  id: string;
  name: string;
  category: string;
  description: string | null;
  road_address: string;
  jibun_address: string | null;
  address_detail: string | null;
  latitude: number;
  longitude: number;
  phone: string | null;
  website_url: string | null;
}

/**
 * Publicly visible restroom hour item
 */
export interface PublicRestroomHour {
  id: string;
  weekday: number;
  opens_at: string | null;
  closes_at: string | null;
  is_closed: boolean;
  crosses_midnight: boolean;
}

/**
 * Publicly visible restroom exception item
 */
export interface PublicRestroomHourException {
  id: string;
  exception_date: string;
  is_closed: boolean;
  opens_at: string | null;
  closes_at: string | null;
  reason: string | null;
}

/**
 * Publicly visible access policy (active version only, no PIN/payment keys)
 */
export interface PublicRestroomAccessPolicy {
  id: string;
  version: number;
  access_mode: AccessMode;
  deposit_amount_krw: number | null;
  refund_eligible: boolean;
  receipt_window_hours: number | null;
  min_purchase_krw: number | null;
  effective_from: string;
}

/**
 * Publicly visible photo (moderated & approved only)
 */
export interface PublicRestroomPhoto {
  id: string;
  storage_path: string;
  photo_type: RestroomPhotoType;
  is_primary: boolean;
  image_url?: string | null;
}

export interface PublicDataSourceSummary {
  id: string;
  provider_name: string;
  dataset_name: string;
  source_url: string;
  license_name: string | null;
  license_url: string | null;
  attribution_text: string | null;
  last_synced_at: string | null;
}

/**
 * Publicly visible restroom detail (GET /api/v1/restrooms/:id)
 */
export interface PublicRestroomDetail {
  id: string;
  type: RestroomType;
  name: string;
  description: string | null;
  road_address: string;
  address_detail: string | null;
  latitude: number | null;
  longitude: number | null;
  floor: string | null;
  entrance_instructions: string | null;
  gender_type: GenderType;
  wheelchair_accessible: boolean | null;
  baby_changing_available: boolean | null;
  sanitary_products_available: boolean | null;
  access_method: AccessMethod;
  last_verified_at: string | null;
  source_id?: string | null;
  coordinate_source?: CoordinateSource | null;
  data_source?: PublicDataSourceSummary | null;
  business_id: string | null;
  business: PublicBusinessInfo | null;
  hours: PublicRestroomHour[];
  hour_exceptions: PublicRestroomHourException[];
  active_policy: PublicRestroomAccessPolicy | null;
  photos: PublicRestroomPhoto[];
  created_at: string;
  updated_at: string;
}

