/**
 * Type definitions for Businesses, Members, Verifications, and Hours
 * Based on docs/03_DATA_MODEL.md, docs/04_API_CONTRACT.md, and tasks/06_business_backend.md
 */

export type BusinessRegistrationStatus =
  | "draft"
  | "pending"
  | "approved"
  | "rejected"
  | "suspended";

export type BusinessMemberRole = "owner" | "manager";
export type BusinessMembershipStatus = "active" | "revoked";

export type BusinessVerificationMethod = "in_person" | "phone" | "document";
export type BusinessVerificationStatus = "pending" | "approved" | "rejected";

export interface Business {
  id: string; // uuid
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
  registration_status: BusinessRegistrationStatus;
  created_by: string; // uuid referencing profiles(id)
  approved_by: string | null; // uuid referencing profiles(id)
  approved_at: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface BusinessMember {
  business_id: string; // uuid referencing businesses(id)
  user_id: string; // uuid referencing profiles(id)
  role: BusinessMemberRole;
  membership_status: BusinessMembershipStatus;
  status?: BusinessMembershipStatus; // generated column compatibility
  joined_at: string;
}

export interface BusinessVerification {
  id: string; // uuid
  business_id: string; // uuid referencing businesses(id)
  submitted_by: string; // uuid referencing profiles(id)
  method: BusinessVerificationMethod;
  registration_number: string | null; // private (server/admin only, never returned to merchants)
  evidence_storage_path: string | null; // private (server/admin only, never returned to merchants)
  status: BusinessVerificationStatus;
  reviewed_by: string | null; // uuid referencing profiles(id)
  reviewed_at: string | null;
  review_notes: string | null;
  created_at: string;
}

/**
 * Merchant-visible verification summary. Private columns (registration_number,
 * evidence_storage_path, review_notes, reviewed_by) are excluded both by the
 * column-level GRANT in the migration and by the explicit column list in the service.
 */
export type BusinessVerificationSummary = Pick<
  BusinessVerification,
  "id" | "business_id" | "submitted_by" | "method" | "status" | "reviewed_at" | "created_at"
>;


export interface BusinessHours {
  id: string; // uuid
  business_id: string; // uuid referencing businesses(id)
  weekday: number; // 0..6 (0=Sunday)
  opens_at: string | null; // HH:MM:SS
  closes_at: string | null; // HH:MM:SS
  is_closed: boolean;
  crosses_midnight: boolean;
}

export interface BusinessSummaryItem {
  id: string;
  name: string;
  category: string;
  road_address: string;
  registration_status: BusinessRegistrationStatus;
  role: BusinessMemberRole | "admin";
  created_at: string;
  updated_at: string;
}

export interface BusinessDetail extends Business {
  members: BusinessMember[];
  hours: BusinessHours[];
  verifications?: BusinessVerificationSummary[];
  my_role?: BusinessMemberRole | "admin";
}

export type AdminBusinessDecision = "approved" | "rejected";

export interface AdminBusinessSummaryItem extends BusinessSummaryItem {
  created_by: string;
  applicant_name?: string | null;
  applicant_email?: string | null;
  rejection_reason?: string | null;
}

export interface AdminBusinessVerification extends BusinessVerification {
  // Explicitly preserves private fields: registration_number, evidence_storage_path, review_notes, reviewed_by
}

export interface AdminBusinessDetail extends Business {
  members: BusinessMember[];
  hours: BusinessHours[];
  verifications: AdminBusinessVerification[];
  applicant_profile?: {
    id: string;
    display_name: string | null;
    account_status: string;
  } | null;
  audit_logs?: AuditLogItem[];
  my_role?: BusinessMemberRole | "admin";
}

export interface AuditLogItem {
  id: string;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  reason: string | null;
  created_at: string;
}


