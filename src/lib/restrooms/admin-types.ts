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
