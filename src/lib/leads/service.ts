import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";
import { AuthGuardError, requireRole } from "@/lib/auth";
import { createServerClientInstance } from "@/lib/supabase/server";
import type {
  BusinessLead,
  H1LeadMetricsSummary,
  LeadContactAttempt,
  LeadContactResult,
  LeadListFilter,
  LeadSummaryItem,
} from "./types";
import type { CreateContactAttemptInput, CreateLeadInput } from "./validation";

const BUSINESS_LEAD_COLUMNS =
  "id, business_name, category, road_address, latitude, longitude, contact_phone, lead_source, assigned_user_id, converted_business_id, created_at, updated_at";

const LEAD_CONTACT_ATTEMPT_COLUMNS =
  "id, lead_id, contacted_by, contacted_at, channel, result, notes, next_contact_at";

/**
 * Computes H1 denominator and contact attempt metrics.
 * docs/03_DATA_MODEL.md & docs/06_EVENTS_AND_PMF.md & tasks/05_lead_tracking.md:
 * - Initial H1 denominator is the number of DISTINCT leads that have >= 1 contact attempt.
 * - Multiple contact attempts on the same lead are deduplicated into 1 lead for the denominator.
 */
export function computeLeadMetrics(
  leads: BusinessLead[],
  attempts: LeadContactAttempt[]
): H1LeadMetricsSummary {
  const attemptsByLead = new Map<string, LeadContactAttempt[]>();

  for (const attempt of attempts) {
    const list = attemptsByLead.get(attempt.lead_id) ?? [];
    list.push(attempt);
    attemptsByLead.set(attempt.lead_id, list);
  }

  const latestResultCounts: Record<LeadContactResult, number> = {
    no_answer: 0,
    rejected: 0,
    interested: 0,
    agreed: 0,
    follow_up: 0,
  };

  const leadIdsSet = new Set(leads.map((l) => l.id));
  const distinctContactedLeadIds = new Set<string>();

  for (const [leadId, leadAttempts] of attemptsByLead.entries()) {
    if (leadAttempts.length === 0) continue;
    if (leads.length === 0 || leadIdsSet.has(leadId)) {
      distinctContactedLeadIds.add(leadId);
      const sorted = [...leadAttempts].sort(
        (a, b) =>
          new Date(b.contacted_at).getTime() - new Date(a.contacted_at).getTime()
      );
      const latest = sorted[0];
      if (latest && latest.result in latestResultCounts) {
        latestResultCounts[latest.result] += 1;
      }
    }
  }

  const totalLeadsCount = leads.length;
  const distinctContactedLeadCount = distinctContactedLeadIds.size;
  const uncontactedLeadCount = Math.max(
    0,
    totalLeadsCount - distinctContactedLeadCount
  );
  const convertedLeadCount = leads.filter(
    (l) => Boolean(l.converted_business_id)
  ).length;

  return {
    targetDenominator: 50,
    distinctContactedLeadCount,
    totalLeadsCount,
    uncontactedLeadCount,
    totalContactAttemptCount: attempts.length,
    convertedLeadCount,
    latestResultCounts,
  };
}

/**
 * Enriches leads with contact attempt counts/latest attempt and applies admin list filters.
 */
export function filterAndEnrichLeads(
  leads: BusinessLead[],
  attempts: LeadContactAttempt[],
  filter: LeadListFilter = {}
): LeadSummaryItem[] {
  const attemptsByLead = new Map<string, LeadContactAttempt[]>();
  for (const attempt of attempts) {
    const list = attemptsByLead.get(attempt.lead_id) ?? [];
    list.push(attempt);
    attemptsByLead.set(attempt.lead_id, list);
  }

  const enriched: LeadSummaryItem[] = leads.map((lead) => {
    const rawAttempts = attemptsByLead.get(lead.id) ?? [];
    const sortedAttempts = [...rawAttempts].sort(
      (a, b) =>
        new Date(b.contacted_at).getTime() - new Date(a.contacted_at).getTime()
    );
    return {
      ...lead,
      attempt_count: sortedAttempts.length,
      has_contact_attempt: sortedAttempts.length > 0,
      latest_attempt: sortedAttempts[0] ?? null,
    };
  });

  const resultFilter = filter.result ?? "all";
  const channelFilter = filter.channel ?? "all";
  const query = (filter.q ?? "").trim().toLowerCase();
  const limit = filter.limit ?? 200;

  return enriched
    .filter((item) => {
      if (resultFilter === "uncontacted") {
        if (item.has_contact_attempt) return false;
      } else if (resultFilter !== "all") {
        if (item.latest_attempt?.result !== resultFilter) return false;
      }

      if (channelFilter !== "all") {
        const leadAttempts = attemptsByLead.get(item.id) ?? [];
        const hasChannelMatch = leadAttempts.some(
          (a) => a.channel === channelFilter
        );
        if (!hasChannelMatch) return false;
      }

      if (query.length > 0) {
        const haystack = [
          item.business_name,
          item.category ?? "",
          item.road_address ?? "",
          item.lead_source ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }

      return true;
    })
    .slice(0, limit);
}

interface UntypedLeadsClient {
  from: (table: "business_leads" | "lead_contact_attempts") => {
    select: (columns: string) => {
      order: (
        col: string,
        opts: { ascending: boolean }
      ) => Promise<{ data: unknown[] | null; error: { message?: string } | null }>;
      eq: (
        col: string,
        val: string
      ) => {
        maybeSingle: () => Promise<{
          data: unknown | null;
          error: { message?: string } | null;
        }>;
        order: (
          orderCol: string,
          opts: { ascending: boolean }
        ) => Promise<{
          data: unknown[] | null;
          error: { message?: string } | null;
        }>;
      };
      single: () => Promise<{
        data: unknown | null;
        error: { message?: string } | null;
      }>;
    };
    insert: (payload: Record<string, unknown>) => {
      select: (columns: string) => {
        single: () => Promise<{
          data: unknown | null;
          error: { message?: string } | null;
        }>;
      };
    };
  };
}

/**
 * Lists leads and H1 contact metrics for an authenticated admin user.
 * Enforces server-side `requireRole("admin")`.
 */
export async function listLeadsForAdmin(
  filter: LeadListFilter = {},
  injectedClient?: SupabaseClient<Database>
): Promise<{
  items: LeadSummaryItem[];
  metrics: H1LeadMetricsSummary;
}> {
  await requireRole("admin", injectedClient);
  const supabase = (injectedClient ??
    (await createServerClientInstance())) as unknown as UntypedLeadsClient;

  const [leadsRes, attemptsRes] = await Promise.all([
    supabase
      .from("business_leads")
      .select(BUSINESS_LEAD_COLUMNS)
      .order("created_at", { ascending: false }),
    supabase
      .from("lead_contact_attempts")
      .select(LEAD_CONTACT_ATTEMPT_COLUMNS)
      .order("contacted_at", { ascending: false }),
  ]);

  if (leadsRes.error) {
    throw new Error("리드 목록을 불러오지 못했습니다.");
  }
  if (attemptsRes.error) {
    throw new Error("연락 시도 기록을 불러오지 못했습니다.");
  }

  const leads = (leadsRes.data ?? []) as BusinessLead[];
  const attempts = (attemptsRes.data ?? []) as LeadContactAttempt[];

  const metrics = computeLeadMetrics(leads, attempts);
  const items = filterAndEnrichLeads(leads, attempts, filter);

  return { items, metrics };
}

/**
 * Creates a new business lead (Admin only).
 */
export async function createLeadForAdmin(
  input: CreateLeadInput,
  injectedClient?: SupabaseClient<Database>
): Promise<BusinessLead> {
  await requireRole("admin", injectedClient);
  const supabase = (injectedClient ??
    (await createServerClientInstance())) as unknown as UntypedLeadsClient;

  const insertPayload: Record<string, unknown> = {
    business_name: input.businessName.trim(),
    category: input.category?.trim() || null,
    road_address: input.roadAddress?.trim() || null,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    contact_phone: input.contactPhone?.trim() || null,
    lead_source: input.leadSource?.trim() || null,
    assigned_user_id: input.assignedUserId ?? null,
  };

  const { data, error } = await supabase
    .from("business_leads")
    .insert(insertPayload)
    .select(BUSINESS_LEAD_COLUMNS)
    .single();

  if (error || !data) {
    throw new Error("리드 등록 중 오류가 발생했습니다.");
  }

  return data as BusinessLead;
}

/**
 * Retrieves a single business lead and its contact attempts (Admin only).
 */
export async function getLeadDetailForAdmin(
  leadId: string,
  injectedClient?: SupabaseClient<Database>
): Promise<{
  lead: BusinessLead;
  attempts: LeadContactAttempt[];
} | null> {
  await requireRole("admin", injectedClient);
  const supabase = (injectedClient ??
    (await createServerClientInstance())) as unknown as UntypedLeadsClient;

  const { data: leadData, error: leadError } = await supabase
    .from("business_leads")
    .select(BUSINESS_LEAD_COLUMNS)
    .eq("id", leadId)
    .maybeSingle();

  if (leadError) {
    throw new Error("리드 상세 정보를 조회하지 못했습니다.");
  }

  if (!leadData) {
    return null;
  }

  const { data: attemptData, error: attemptError } = await supabase
    .from("lead_contact_attempts")
    .select(LEAD_CONTACT_ATTEMPT_COLUMNS)
    .eq("lead_id", leadId)
    .order("contacted_at", { ascending: false });

  if (attemptError) {
    throw new Error("연락 시도 내역을 조회하지 못했습니다.");
  }

  return {
    lead: leadData as BusinessLead,
    attempts: (attemptData ?? []) as LeadContactAttempt[],
  };
}

/**
 * Records a contact attempt for a business lead (Admin only).
 * Sets `contacted_by` from the server-verified admin session.
 */
export async function createContactAttemptForAdmin(
  leadId: string,
  input: CreateContactAttemptInput,
  injectedClient?: SupabaseClient<Database>
): Promise<{
  attempt: LeadContactAttempt;
  metrics: H1LeadMetricsSummary;
}> {
  const adminSession = await requireRole("admin", injectedClient);
  const supabase = (injectedClient ??
    (await createServerClientInstance())) as unknown as UntypedLeadsClient;

  // Verify target lead exists first
  const { data: existingLead, error: leadCheckError } = await supabase
    .from("business_leads")
    .select("id")
    .eq("id", leadId)
    .maybeSingle();

  if (leadCheckError) {
    throw new Error("대상 리드를 확인하는 중 오류가 발생했습니다.");
  }

  if (!existingLead) {
    throw new AuthGuardError(
      "INVALID_INPUT",
      404,
      "존재하지 않는 가게 리드입니다."
    );
  }

  const insertPayload: Record<string, unknown> = {
    lead_id: leadId,
    contacted_by: adminSession.user.id,
    contacted_at: input.contactedAt ?? new Date().toISOString(),
    channel: input.channel,
    result: input.result,
    notes: input.notes?.trim() || null,
    next_contact_at: input.nextContactAt ?? null,
  };

  const { data: createdAttempt, error: insertError } = await supabase
    .from("lead_contact_attempts")
    .insert(insertPayload)
    .select(LEAD_CONTACT_ATTEMPT_COLUMNS)
    .single();

  if (insertError || !createdAttempt) {
    throw new Error("연락 시도 기록을 저장하지 못했습니다.");
  }

  const { metrics } = await listLeadsForAdmin({}, injectedClient);

  return {
    attempt: createdAttempt as LeadContactAttempt,
    metrics,
  };
}

