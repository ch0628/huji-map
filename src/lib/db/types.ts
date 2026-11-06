/**
 * Database type definitions for Auth, Roles, Visitor Sessions, Consents, and Feature Flags
 * Based on docs/03_DATA_MODEL.md and supabase/migrations/20261106000000_auth_schema.sql
 */

export type AccountStatus = "active" | "suspended" | "deleted";
export type UserRoleType = "customer" | "merchant" | "admin";
export type DeviceType = "mobile" | "tablet" | "desktop" | "unknown";
export type ConsentType = "terms" | "privacy" | "analytics" | "marketing";

export interface Profile {
  id: string; // uuid referencing auth.users(id)
  display_name: string | null;
  preferred_language: string;
  account_status: AccountStatus;
  created_at: string;
  updated_at: string;
}

export interface UserRole {
  user_id: string; // uuid referencing profiles(id)
  role: UserRoleType;
  granted_by: string | null; // uuid referencing profiles(id)
  created_at: string;
}

export interface VisitorSession {
  id: string; // uuid
  browser_id: string; // uuid
  user_id: string | null; // uuid referencing profiles(id)
  started_at: string;
  last_seen_at: string;
  landing_path: string;
  referrer: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  device_type: DeviceType;
  language: string | null;
  is_test: boolean;
}

export interface ConsentRecord {
  id: string; // uuid
  user_id: string | null; // uuid referencing profiles(id)
  browser_id: string | null; // uuid
  consent_type: ConsentType;
  policy_version: string;
  accepted: boolean;
  recorded_at: string;
  withdrawn_at: string | null;
}

export interface FeatureFlag<T = Record<string, unknown>> {
  key: string;
  enabled: boolean;
  config: T;
  updated_by: string | null; // uuid referencing profiles(id)
  updated_at: string;
}

/**
 * Supabase Database interface structure
 */
export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: Profile;
        Insert: {
          id: string;
          display_name?: string | null;
          preferred_language?: string;
          account_status?: AccountStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          display_name?: string | null;
          preferred_language?: string;
          account_status?: AccountStatus;
          updated_at?: string;
        };
      };
      user_roles: {
        Row: UserRole;
        Insert: {
          user_id: string;
          role: UserRoleType;
          granted_by?: string | null;
          created_at?: string;
        };
        Update: {
          user_id?: string;
          role?: UserRoleType;
          granted_by?: string | null;
        };
      };
      visitor_sessions: {
        Row: VisitorSession;
        Insert: {
          id?: string;
          browser_id: string;
          user_id?: string | null;
          started_at?: string;
          last_seen_at?: string;
          landing_path: string;
          referrer?: string | null;
          utm_source?: string | null;
          utm_medium?: string | null;
          utm_campaign?: string | null;
          utm_content?: string | null;
          utm_term?: string | null;
          device_type?: DeviceType;
          language?: string | null;
          is_test?: boolean;
        };
        Update: {
          id?: string;
          browser_id?: string;
          user_id?: string | null;
          last_seen_at?: string;
          landing_path?: string;
          referrer?: string | null;
          utm_source?: string | null;
          utm_medium?: string | null;
          utm_campaign?: string | null;
          utm_content?: string | null;
          utm_term?: string | null;
          device_type?: DeviceType;
          language?: string | null;
          is_test?: boolean;
        };
      };
      consent_records: {
        Row: ConsentRecord;
        Insert: {
          id?: string;
          user_id?: string | null;
          browser_id?: string | null;
          consent_type: ConsentType;
          policy_version: string;
          accepted: boolean;
          recorded_at?: string;
          withdrawn_at?: string | null;
        };
        Update: {
          withdrawn_at?: string | null;
        };
      };
      feature_flags: {
        Row: FeatureFlag;
        Insert: {
          key: string;
          enabled?: boolean;
          config?: Record<string, unknown>;
          updated_by?: string | null;
          updated_at?: string;
        };
        Update: {
          enabled?: boolean;
          config?: Record<string, unknown>;
          updated_by?: string | null;
          updated_at?: string;
        };
      };
    };
  };
}

