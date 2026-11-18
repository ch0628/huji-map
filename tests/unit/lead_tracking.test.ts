import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Database, UserRoleType } from "@/lib/db/types";
import { clearIdempotencyStoreForTests } from "@/lib/auth";
import {
  computeLeadMetrics,
  createContactAttemptForAdmin,
  createContactAttemptSchema,
  createLeadForAdmin,
  createLeadSchema,
  filterAndEnrichLeads,
  getLeadDetailForAdmin,
  listLeadsForAdmin,
  redactLeadSensitiveText,
  type BusinessLead,
  type LeadContactAttempt,
} from "@/lib/leads";
import {
  GET as leadsGet,
  POST as leadsPost,
} from "@/app/api/v1/admin/leads/route";
import { GET as leadDetailGet } from "@/app/api/v1/admin/leads/[id]/route";
import { POST as leadContactPost } from "@/app/api/v1/admin/leads/[id]/contacts/route";

function createMockLeadsSupabaseClient(options: {
  user?: Partial<User> | null;
  roles?: UserRoleType[];
  leads?: BusinessLead[];
  attempts?: LeadContactAttempt[];
}) {
  const mockUser: User | null = options.user
    ? ({
        id: options.user.id ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        email: options.user.email ?? "admin@example.test",
        app_metadata: {},
        user_metadata: { display_name: "관리자" },
        aud: "authenticated",
        created_at: new Date().toISOString(),
      } as User)
    : null;

  const storedLeads = [...(options.leads ?? [])];
  const storedAttempts = [...(options.attempts ?? [])];

  const client = {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: mockUser },
        error: null,
      }),
    },
    from: vi.fn((table: string) => {
      if (table === "user_roles") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn().mockResolvedValue({
              data: (options.roles ?? []).map((role) => ({ role })),
              error: null,
            }),
          })),
        };
      }
      if (table === "profiles") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn().mockResolvedValue({
                data: mockUser
                  ? { display_name: "관리자", account_status: "active" }
                  : null,
                error: null,
              }),
            })),
          })),
        };
      }
      if (table === "business_leads") {
        return {
          select: vi.fn(() => ({
            order: vi.fn().mockResolvedValue({
              data: storedLeads,
              error: null,
            }),
            eq: vi.fn((_col: string, val: string) => ({
              maybeSingle: vi.fn().mockResolvedValue({
                data: storedLeads.find((l) => l.id === val) ?? null,
                error: null,
              }),
            })),
          })),
          insert: vi.fn((payload: Record<string, unknown>) => ({
            select: vi.fn(() => ({
              single: vi.fn().mockImplementation(async () => {
                const created: BusinessLead = {
                  id: "10000000-0000-4000-8000-000000000099",
                  business_name: String(payload.business_name),
                  category: (payload.category as string | null) ?? null,
                  road_address: (payload.road_address as string | null) ?? null,
                  latitude: (payload.latitude as number | null) ?? null,
                  longitude: (payload.longitude as number | null) ?? null,
                  contact_phone: (payload.contact_phone as string | null) ?? null,
                  lead_source: (payload.lead_source as string | null) ?? null,
                  assigned_user_id:
                    (payload.assigned_user_id as string | null) ?? null,
                  converted_business_id: null,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                };
                storedLeads.unshift(created);
                return { data: created, error: null };
              }),
            })),
          })),
        };
      }
      if (table === "lead_contact_attempts") {
        return {
          select: vi.fn(() => ({
            order: vi.fn().mockResolvedValue({
              data: storedAttempts,
              error: null,
            }),
            eq: vi.fn((_col: string, val: string) => ({
              order: vi.fn().mockResolvedValue({
                data: storedAttempts.filter((a) => a.lead_id === val),
                error: null,
              }),
            })),
          })),
          insert: vi.fn((payload: Record<string, unknown>) => ({
            select: vi.fn(() => ({
              single: vi.fn().mockImplementation(async () => {
                const created: LeadContactAttempt = {
                  id: `20000000-0000-4000-8000-${String(
                    storedAttempts.length + 1
                  ).padStart(12, "0")}`,
                  lead_id: String(payload.lead_id),
                  contacted_by: String(payload.contacted_by),
                  contacted_at: String(payload.contacted_at),
                  channel: payload.channel as LeadContactAttempt["channel"],
                  result: payload.result as LeadContactAttempt["result"],
                  notes: (payload.notes as string | null) ?? null,
                  next_contact_at:
                    (payload.next_contact_at as string | null) ?? null,
                };
                storedAttempts.unshift(created);
                return { data: created, error: null };
              }),
            })),
          })),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    }),
  };

  return client as unknown as SupabaseClient<Database>;
}

const SAMPLE_LEADS: BusinessLead[] = [
  {
    id: "10000000-0000-4000-8000-000000000001",
    business_name: "TEST 행궁 1호 카페",
    category: "카페",
    road_address: "경기도 수원시 팔달구 정조로 1",
    latitude: 37.28,
    longitude: 127.01,
    contact_phone: "031-111-2222",
    lead_source: "현장 답사",
    assigned_user_id: null,
    converted_business_id: null,
    created_at: "2026-11-07T01:00:00.000Z",
    updated_at: "2026-11-07T01:00:00.000Z",
  },
  {
    id: "10000000-0000-4000-8000-000000000002",
    business_name: "TEST 화성 공방",
    category: "공방",
    road_address: "경기도 수원시 팔달구 행궁로 2",
    latitude: 37.281,
    longitude: 127.012,
    contact_phone: "031-333-4444",
    lead_source: "지도 검색",
    assigned_user_id: null,
    converted_business_id: null,
    created_at: "2026-11-07T02:00:00.000Z",
    updated_at: "2026-11-07T02:00:00.000Z",
  },
  {
    id: "10000000-0000-4000-8000-000000000003",
    business_name: "TEST 미접촉 베이커리",
    category: "베이커리",
    road_address: "경기도 수원시 팔달구 신풍로 3",
    latitude: null,
    longitude: null,
    contact_phone: null,
    lead_source: "지인 추천",
    assigned_user_id: null,
    converted_business_id: null,
    created_at: "2026-11-07T03:00:00.000Z",
    updated_at: "2026-11-07T03:00:00.000Z",
  },
];

const SAMPLE_ATTEMPTS: LeadContactAttempt[] = [
  // Lead 1 contacted 3 times -> must count as 1 unique lead in H1 denominator!
  {
    id: "20000000-0000-4000-8000-000000000001",
    lead_id: "10000000-0000-4000-8000-000000000001",
    contacted_by: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    contacted_at: "2026-11-07T04:00:00.000Z",
    channel: "phone",
    result: "no_answer",
    notes: "부재중",
    next_contact_at: null,
  },
  {
    id: "20000000-0000-4000-8000-000000000002",
    lead_id: "10000000-0000-4000-8000-000000000001",
    contacted_by: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    contacted_at: "2026-11-07T05:00:00.000Z",
    channel: "visit",
    result: "interested",
    notes: "매니저 면담",
    next_contact_at: null,
  },
  {
    id: "20000000-0000-4000-8000-000000000003",
    lead_id: "10000000-0000-4000-8000-000000000001",
    contacted_by: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    contacted_at: "2026-11-07T06:00:00.000Z",
    channel: "visit",
    result: "agreed",
    notes: "사장님 제휴 동의",
    next_contact_at: null,
  },
  // Lead 2 contacted 1 time
  {
    id: "20000000-0000-4000-8000-000000000004",
    lead_id: "10000000-0000-4000-8000-000000000002",
    contacted_by: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    contacted_at: "2026-11-07T05:30:00.000Z",
    channel: "message",
    result: "rejected",
    notes: "화장실 내부 수리 중",
    next_contact_at: null,
  },
];

describe("TASK 05: Lead Tracking Schema, H1 Denominator Deduplication, Filters & Admin Guards", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    clearIdempotencyStoreForTests();
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_key_only",
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe("1. SQL Migration structure & RLS verification", () => {
    const migrationPath = path.resolve(
      process.cwd(),
      "supabase/migrations/20261107000000_lead_tracking.sql"
    );
    const sql = fs.readFileSync(migrationPath, "utf8");

    it("defines business_leads and lead_contact_attempts with RLS and without fake seed data", () => {
      expect(sql).toContain("create table if not exists public.business_leads");
      expect(sql).toContain("converted_business_id uuid null");
      expect(sql).not.toMatch(/references\s+public\.businesses/i);
      expect(sql).toContain("execute function public.handle_updated_at();");
      expect(sql).not.toContain("set_updated_at()");
      expect(sql).toContain("chk_business_leads_coords_pair");
      expect(sql).toContain(
        "create unique index if not exists idx_business_leads_converted_business_id"
      );

      expect(sql).toContain(
        "create table if not exists public.lead_contact_attempts"
      );
      expect(sql).toContain(
        "channel in ('visit', 'phone', 'message', 'email')"
      );
      expect(sql).toContain(
        "result in ('no_answer', 'rejected', 'interested', 'agreed', 'follow_up')"
      );

      expect(sql).toContain(
        "alter table public.business_leads enable row level security;"
      );
      expect(sql).toContain(
        "alter table public.lead_contact_attempts enable row level security;"
      );
      expect(sql).toContain(
        "grant select, insert, update on public.business_leads to authenticated, service_role;"
      );
      expect(sql).toContain(
        "grant select, insert on public.lead_contact_attempts to authenticated, service_role;"
      );
      expect(sql).toContain("public.is_admin(auth.uid())");
      expect(sql).not.toMatch(/insert\s+into\s+public\.business_leads/i);
    });

    it("includes a self-rolling-back PostgreSQL verification script (verify_lead_rls_rollback.sql)", () => {
      const verifySqlPath = path.resolve(
        process.cwd(),
        "tests/integration/sql/verify_lead_rls_rollback.sql"
      );
      const verifySql = fs.readFileSync(verifySqlPath, "utf8");

      expect(verifySql).toContain("DO $verify$");
      expect(verifySql).toContain("version = '20261107000000'");
      expect(verifySql).toContain("v_expected_pass_count CONSTANT int := 12;");

      // Verify exact match between v_expected_pass_count (12) and v_pass_count increments (12)
      const incrementMatches = verifySql.match(
        /v_pass_count\s*:=\s*v_pass_count\s*\+\s*1\s*;/g
      );
      expect(incrementMatches).toHaveLength(12);

      // 1 & 2. Verify no comma-separated privileges in has_table_privilege()
      const privCalls = [
        ...verifySql.matchAll(
          /has_table_privilege\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g
        ),
      ];
      expect(privCalls.length).toBeGreaterThanOrEqual(16);
      for (const match of privCalls) {
        expect(match[3]).not.toContain(",");
      }
      expect(verifySql).toContain(
        "has_table_privilege('anon', 'public.business_leads', 'SELECT')"
      );
      expect(verifySql).toContain(
        "has_table_privilege('anon', 'public.business_leads', 'INSERT')"
      );
      expect(verifySql).toContain(
        "has_table_privilege('anon', 'public.lead_contact_attempts', 'SELECT')"
      );
      expect(verifySql).toContain(
        "has_table_privilege('anon', 'public.lead_contact_attempts', 'INSERT')"
      );

      // 3. Pre-check & Post-check include public.profiles and public.user_roles (5 tables total)
      expect(verifySql).toContain("PRECHECK_ABORT: synthetic test profile already exists in public.profiles");
      expect(verifySql).toContain("PRECHECK_ABORT: synthetic test role already exists in public.user_roles");
      expect(verifySql).toContain("POSTCHECK_LEAK: synthetic profile remained in public.profiles");
      expect(verifySql).toContain("POSTCHECK_LEAK: synthetic role remained in public.user_roles");

      // 4 & 5. Explicit ROLE / JWT claim verification and Admin INSERT + SELECT on both tables
      expect(verifySql).toContain("FAIL [ADMIN_JWT_CONTEXT]");
      expect(verifySql).toContain("FAIL [CUSTOMER_JWT_CONTEXT]");
      expect(verifySql).toContain("FAIL [ANON_CONTEXT]");
      expect(verifySql).toContain("SELECT business_name, category INTO v_name, v_category");
      expect(verifySql).toContain("SELECT channel, result, notes INTO v_channel, v_result, v_notes");

      // 7. Unconditional P0099 rollback
      expect(verifySql).toContain("USING ERRCODE = 'P0099'");
      expect(verifySql).toContain("WHEN SQLSTATE 'P0099' THEN");
    });
  });

  describe("2. H1 Denominator deduplication & filter logic", () => {
    it("counts multiple contact attempts on the same lead as a single unique lead in H1 denominator", () => {
      const metrics = computeLeadMetrics(SAMPLE_LEADS, SAMPLE_ATTEMPTS);

      expect(metrics.targetDenominator).toBe(50);
      expect(metrics.totalLeadsCount).toBe(3);
      expect(metrics.totalContactAttemptCount).toBe(4);
      // Lead 1 (3 attempts) + Lead 2 (1 attempt) = 2 distinct contacted leads; Lead 3 has 0 attempts
      expect(metrics.distinctContactedLeadCount).toBe(2);
      expect(metrics.uncontactedLeadCount).toBe(1);
      expect(metrics.latestResultCounts).toEqual({
        no_answer: 0,
        rejected: 1,
        interested: 0,
        agreed: 1,
        follow_up: 0,
      });
    });

    it("supports registering and listing more than 50 leads (50 is H1 target, not a DB or list hard cap)", () => {
      const sixtyLeads: BusinessLead[] = Array.from({ length: 60 }, (_, idx) => ({
        id: `10000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
        business_name: `TEST 리드 ${idx + 1}`,
        category: "카페",
        road_address: null,
        latitude: null,
        longitude: null,
        contact_phone: null,
        lead_source: null,
        assigned_user_id: null,
        converted_business_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }));

      const metrics = computeLeadMetrics(sixtyLeads, []);
      expect(metrics.targetDenominator).toBe(50);
      expect(metrics.totalLeadsCount).toBe(60);

      const listed = filterAndEnrichLeads(sixtyLeads, []);
      expect(listed).toHaveLength(60);
    });

    it("filters leads by uncontacted, latest result, channel, and search query", () => {
      const uncontacted = filterAndEnrichLeads(SAMPLE_LEADS, SAMPLE_ATTEMPTS, {
        result: "uncontacted",
      });
      expect(uncontacted).toHaveLength(1);
      expect(uncontacted[0]?.business_name).toBe("TEST 미접촉 베이커리");

      const agreedOnly = filterAndEnrichLeads(SAMPLE_LEADS, SAMPLE_ATTEMPTS, {
        result: "agreed",
      });
      expect(agreedOnly).toHaveLength(1);
      expect(agreedOnly[0]?.business_name).toBe("TEST 행궁 1호 카페");
      expect(agreedOnly[0]?.attempt_count).toBe(3);

      const phoneChannel = filterAndEnrichLeads(SAMPLE_LEADS, SAMPLE_ATTEMPTS, {
        channel: "phone",
      });
      expect(phoneChannel).toHaveLength(1);
      expect(phoneChannel[0]?.id).toBe("10000000-0000-4000-8000-000000000001");

      const queryMatch = filterAndEnrichLeads(SAMPLE_LEADS, SAMPLE_ATTEMPTS, {
        q: "공방",
      });
      expect(queryMatch).toHaveLength(1);
      expect(queryMatch[0]?.business_name).toBe("TEST 화성 공방");
    });
  });

  describe("3. Access control (Guest 401, Customer/Merchant 403, Admin 200/201)", () => {
    it("blocks Guest with 401 and Customer/Merchant with 403 on all lead service functions", async () => {
      const guestClient = createMockLeadsSupabaseClient({
        user: null,
        roles: [],
      });
      await expect(listLeadsForAdmin({}, guestClient)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
        status: 401,
      });

      const customerClient = createMockLeadsSupabaseClient({
        user: { id: "u-cust" },
        roles: ["customer"],
      });
      await expect(listLeadsForAdmin({}, customerClient)).rejects.toMatchObject({
        code: "FORBIDDEN",
        status: 403,
      });
      await expect(
        createLeadForAdmin({ businessName: "차단가게" }, customerClient)
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        status: 403,
      });

      const merchantClient = createMockLeadsSupabaseClient({
        user: { id: "u-merch" },
        roles: ["customer", "merchant"],
      });
      await expect(
        getLeadDetailForAdmin(
          "10000000-0000-4000-8000-000000000001",
          merchantClient
        )
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        status: 403,
      });
      await expect(
        createContactAttemptForAdmin(
          "10000000-0000-4000-8000-000000000001",
          { channel: "visit", result: "interested" },
          merchantClient
        )
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        status: 403,
      });
    });

    it("allows Admin to create lead, record multiple contacts, and deduplicate H1 denominator", async () => {
      const adminClient = createMockLeadsSupabaseClient({
        user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        roles: ["admin"],
        leads: [...SAMPLE_LEADS],
        attempts: [...SAMPLE_ATTEMPTS],
      });

      const newLead = await createLeadForAdmin(
        {
          businessName: "TEST 신규 접촉 가게",
          category: "음식점",
          roadAddress: "경기도 수원시 팔달구 정조로 99",
          contactPhone: "031-999-8888",
          leadSource: "현장 방문",
        },
        adminClient
      );
      expect(newLead.business_name).toBe("TEST 신규 접촉 가게");

      // First contact on newLead increases distinctContactedLeadCount from 2 -> 3
      const firstContact = await createContactAttemptForAdmin(
        newLead.id,
        { channel: "visit", result: "interested", notes: "1차 방문" },
        adminClient
      );
      expect(firstContact.metrics.distinctContactedLeadCount).toBe(3);
      expect(firstContact.metrics.totalContactAttemptCount).toBe(5);

      // Second contact on the SAME newLead keeps distinctContactedLeadCount at 3!
      const secondContact = await createContactAttemptForAdmin(
        newLead.id,
        { channel: "phone", result: "agreed", notes: "2차 전화 동의" },
        adminClient
      );
      expect(secondContact.metrics.distinctContactedLeadCount).toBe(3);
      expect(secondContact.metrics.totalContactAttemptCount).toBe(6);

      const detail = await getLeadDetailForAdmin(newLead.id, adminClient);
      expect(detail?.attempts).toHaveLength(2);
    });
  });

  describe("4. Validation, Idempotency, Missing Config & PII Redaction on API Routes", () => {
    it("validates createLeadSchema and createContactAttemptSchema", () => {
      expect(createLeadSchema.safeParse({ businessName: "   " }).success).toBe(
        false
      );
      expect(
        createContactAttemptSchema.safeParse({
          channel: "invalid_channel",
          result: "agreed",
        }).success
      ).toBe(false);
    });

    it("redacts phone numbers and private notes from text", () => {
      const raw =
        "Lead error for 010-1234-5678 and 031-222-3333 notes=사장님직통번호";
      const redacted = redactLeadSensitiveText(raw);
      expect(redacted).not.toContain("010-1234-5678");
      expect(redacted).not.toContain("031-222-3333");
      expect(redacted).not.toContain("사장님직통번호");
      expect(redacted).toContain("[REDACTED_PHONE]");
    });

    it("returns 503 CONFIG_REQUIRED on API routes when Supabase env vars are missing", async () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

      const listRes = await leadsGet(
        new Request("http://localhost/api/v1/admin/leads")
      );
      expect(listRes.status).toBe(503);

      const createRes = await leadsPost(
        new Request("http://localhost/api/v1/admin/leads", {
          method: "POST",
          body: JSON.stringify({ businessName: "TEST" }),
        })
      );
      expect(createRes.status).toBe(503);

      const detailRes = await leadDetailGet(
        new Request(
          "http://localhost/api/v1/admin/leads/10000000-0000-4000-8000-000000000001"
        ),
        {
          params: Promise.resolve({
            id: "10000000-0000-4000-8000-000000000001",
          }),
        }
      );
      expect(detailRes.status).toBe(503);

      const contactRes = await leadContactPost(
        new Request(
          "http://localhost/api/v1/admin/leads/10000000-0000-4000-8000-000000000001/contacts",
          {
            method: "POST",
            body: JSON.stringify({ channel: "visit", result: "agreed" }),
          }
        ),
        {
          params: Promise.resolve({
            id: "10000000-0000-4000-8000-000000000001",
          }),
        }
      );
      expect(contactRes.status).toBe(503);
    });
  });
});

