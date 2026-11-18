export type LeadChannel = "visit" | "phone" | "message" | "email";

export type LeadContactResult =
  | "no_answer"
  | "rejected"
  | "interested"
  | "agreed"
  | "follow_up";

export type LeadFilterResult = "all" | "uncontacted" | LeadContactResult;
export type LeadFilterChannel = "all" | LeadChannel;

export interface BusinessLead {
  id: string;
  business_name: string;
  category: string | null;
  road_address: string | null;
  latitude: number | null;
  longitude: number | null;
  contact_phone: string | null; // private (admin only)
  lead_source: string | null;
  assigned_user_id: string | null;
  converted_business_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface LeadContactAttempt {
  id: string;
  lead_id: string;
  contacted_by: string;
  contacted_at: string;
  channel: LeadChannel;
  result: LeadContactResult;
  notes: string | null; // private (admin only)
  next_contact_at: string | null;
}

export interface LeadSummaryItem extends BusinessLead {
  attempt_count: number;
  has_contact_attempt: boolean;
  latest_attempt: LeadContactAttempt | null;
}

export interface H1LeadMetricsSummary {
  targetDenominator: number;
  distinctContactedLeadCount: number;
  totalLeadsCount: number;
  uncontactedLeadCount: number;
  totalContactAttemptCount: number;
  convertedLeadCount: number;
  latestResultCounts: Record<LeadContactResult, number>;
}

export interface LeadListFilter {
  result?: LeadFilterResult;
  channel?: LeadFilterChannel;
  q?: string;
  limit?: number;
}

