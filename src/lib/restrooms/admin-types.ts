import type {
  Restroom,
  RestroomHour,
  RestroomHourException,
  RestroomAccessPolicy,
  RestroomPhoto,
  RestroomType,
  PublicationStatus,
  AccessMethod,
  GenderType,
  AccessMode,
} from "./types";

export type AdminRestroomDecision = "publish" | "reject" | "suspend";

export interface AdminRestroomSummaryItem {
  id: string;
  name: string;
  type: RestroomType;
  publication_status: PublicationStatus;
  road_address: string;
  address_detail: string | null;
  latitude: number | null;
  longitude: number | null;
  floor: string | null;
  gender_type: GenderType;
  access_method: AccessMethod;
  wheelchair_accessible: boolean | null;
  baby_changing_available: boolean | null;
  sanitary_products_available: boolean | null;
  business_id: string | null;
  business_name?: string | null;
  business_registration_status?: string | null;
  active_policy_mode?: AccessMode | null;
  active_deposit_amount_krw?: number | null;
  applicant_name?: string | null;
  created_by: string | null;
  approved_by: string | null;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
  primary_photo_storage_path?: string | null;
  pending_photo_count?: number;
}

export interface AdminRestroomBusinessSummary {
  id: string;
  name: string;
  category: string;
  road_address: string;
  registration_status: string;
  phone: string | null;
}

export interface AdminRestroomApplicantSummary {
  id: string;
  display_name: string | null;
  account_status: string;
}

export interface AdminRestroomAuditLog {
  id: string;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  before_data: any;
  after_data: any;
  reason: string | null;
  created_at: string;
}

export interface AdminRestroomDetail extends Restroom {
  business: AdminRestroomBusinessSummary | null;
  applicant: AdminRestroomApplicantSummary | null;
  hours: RestroomHour[];
  hour_exceptions: RestroomHourException[];
  policies: RestroomAccessPolicy[];
  photos: RestroomPhoto[];
  audit_logs: AdminRestroomAuditLog[];
}

export type AdminRestroomVerificationCategory =
  | "field_verified"
  | "official_validated"
  | "review_required"
  | "legacy_unset"
  | "partner_direct";

export type AdminRestroomSourceCategory =
  | "seoul_oa22586"
  | "suwon_15011425"
  | "partner"
  | "other";

export interface AdminRestroomRegionStat {
  key: string;
  label: string;
  total: number;
  mapVisible: number;
  publicCount: number;
  partnerCount: number;
}

export interface AdminRestroomStats {
  totalCount: number;
  mapVisibleCount: number;
  hiddenCount: number;
  partnerDiscoveryEnabled: boolean;
  byType: {
    public: number;
    partner: number;
  };
  byPublicationStatus: {
    published: number;
    draft: number;
    pending: number;
    suspended: number;
    archived: number;
  };
  regionSummary: {
    seoulTotal: number;
    suwonTotal: number;
    otherTotal: number;
  };
  byRegion: AdminRestroomRegionStat[];
  bySeoulGu: AdminRestroomRegionStat[];
  byDataSource: Array<{
    key: AdminRestroomSourceCategory;
    label: string;
    total: number;
  }>;
  byVerificationStatus: {
    fieldVerified: number;
    officialValidated: number;
    reviewRequired: number;
    legacyUnset: number;
    partnerDirect: number;
  };
  generatedAt: string;
}

export interface AdminRestroomInventoryItem {
  id: string;
  name: string;
  type: RestroomType;
  publication_status: PublicationStatus;
  road_address: string;
  address_detail: string | null;
  region_key: string;
  region_label: string;
  source_key: AdminRestroomSourceCategory;
  source_label: string;
  coordinate_source: string | null;
  coordinate_type: string | null;
  coordinate_verification_status: string | null;
  verification_category: AdminRestroomVerificationCategory;
  verification_label: string;
  is_map_visible: boolean;
  business_id: string | null;
  business_name: string | null;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdminRestroomInventoryResult {
  items: AdminRestroomInventoryItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}
