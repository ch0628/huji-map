import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCreateServerClientInstance = vi.fn();
const mockCreateAdminClient = vi.fn();
const mockIsServiceRoleConfigured = vi.fn();

vi.mock("@/lib/supabase/server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/supabase/server")>(
    "@/lib/supabase/server"
  );
  return {
    ...actual,
    createServerClientInstance: () => mockCreateServerClientInstance(),
    createAdminClient: () => mockCreateAdminClient(),
    isServiceRoleConfigured: () => mockIsServiceRoleConfigured(),
  };
});

import { POST as usageCountsPost } from "@/app/api/v1/usage-counts/route";
import {
  GET as excludedAccountsGet,
  POST as excludedAccountsPost,
} from "@/app/api/v1/admin/analytics/excluded-accounts/route";
import {
  PATCH as excludedAccountPatch,
  DELETE as excludedAccountDelete,
} from "@/app/api/v1/admin/analytics/excluded-accounts/[userId]/route";
import { BASIC_USAGE_FEATURES } from "@/lib/usage-counts/types";
import { recordDailyUsageCount } from "@/lib/usage-counts/service";
import {
  computeEventBreakdown,
  computeH2Metrics,
  computeH5Metrics,
  computeServiceUsageMetrics,
  getPmfReport,
} from "@/lib/analytics/service";
import { clearIdempotencyStoreForTests } from "@/lib/auth/validation";
import { resetRateLimits } from "@/lib/events";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const CUSTOMER_ID = "22222222-2222-4222-8222-222222222222";
const TEST_USER_1 = "33333333-3333-4333-8333-333333333301";
const TEST_USER_2 = "33333333-3333-4333-8333-333333333302";
const TEST_USER_3 = "33333333-3333-4333-8333-333333333303";
const TEST_USER_4 = "33333333-3333-4333-8333-333333333304";
const NON_EXISTENT_ID = "99999999-9999-4999-8999-999999999999";

function makeAuthClient(
  userId: string | null,
  roles: string[] = [],
  authError: any = null
) {
  return {
    auth: {
      getUser: vi.fn().mockImplementation(async () => {
        if (authError instanceof Error) {
          throw authError;
        }
        if (authError) {
          return { data: { user: null }, error: authError };
        }
        return userId
          ? { data: { user: { id: userId, user_metadata: {} } }, error: null }
          : { data: { user: null }, error: { message: "Auth session missing" } };
      }),
    },
    from: vi.fn((table: string) => {
      if (table === "user_roles") {
        return {
          select: () => ({
            eq: async () => ({
              data: roles.map((role) => ({ role })),
              error: null,
            }),
          }),
        };
      }
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: userId
                  ? { display_name: "테스트사용자", account_status: "active" }
                  : null,
                error: null,
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        }),
      };
    }),
  };
}

interface InMemoryExclusionState {
  excludedRows: Map<
    string,
    {
      id: string;
      user_id: string;
      is_active: boolean;
      note: string | null;
      created_by: string | null;
      updated_by: string | null;
      created_at: string;
      updated_at: string;
    }
  >;
  dailyCounts: Array<{ stat_date: string; feature_key: string; is_test: boolean; total_count: number }>;
  profiles: Array<{ id: string; email: string; display_name: string; account_status: "active"; created_at: string }>;
  roles: Array<{ user_id: string; role: string }>;
  exclusionQueryError?: { message: string } | null;
}

function makeInMemoryAdminDb(state: InMemoryExclusionState) {
  return {
    auth: {
      admin: {
        listUsers: vi.fn().mockImplementation(async () => ({
          data: {
            users: state.profiles.map((p) => ({
              id: p.id,
              email: p.email,
              user_metadata: { display_name: p.display_name },
              created_at: p.created_at,
            })),
          },
          error: null,
        })),
      },
    },
    rpc: vi.fn().mockImplementation(async (fnName: string, args: any) => {
      if (fnName === "increment_daily_usage_count") {
        const key = args.p_feature_key;
        const isTest = Boolean(args.p_is_test);
        const existing = state.dailyCounts.find(
          (r) => r.feature_key === key && r.is_test === isTest
        );
        if (existing) {
          existing.total_count += 1;
          return {
            data: { stat_date: existing.stat_date, feature_key: key, is_test: isTest, total_count: existing.total_count },
            error: null,
          };
        }
        const row = {
          stat_date: "2026-11-25",
          feature_key: key,
          is_test: isTest,
          total_count: 1,
        };
        state.dailyCounts.push(row);
        return {
          data: { stat_date: row.stat_date, feature_key: key, is_test: isTest, total_count: 1 },
          error: null,
        };
      }
      return { data: null, error: null };
    }),
    from: vi.fn((table: string) => {
      if (table === "analytics_excluded_accounts") {
        return {
          select: () => {
            const filters: Record<string, any> = {};
            const chain: any = {
              eq: (col: string, val: any) => {
                filters[col] = val;
                return chain;
              },
              in: (_col: string, vals: string[]) => {
                if (state.exclusionQueryError) {
                  return Promise.resolve({ data: null, error: state.exclusionQueryError });
                }
                const list = Array.from(state.excludedRows.values()).filter((r) =>
                  vals.includes(r.user_id)
                );
                return Promise.resolve({ data: list, error: null });
              },
              order: () => {
                if (state.exclusionQueryError) {
                  return Promise.resolve({ data: null, error: state.exclusionQueryError });
                }
                return Promise.resolve({
                  data: Array.from(state.excludedRows.values()),
                  error: null,
                });
              },
              maybeSingle: async () => {
                if (state.exclusionQueryError) {
                  return { data: null, error: state.exclusionQueryError };
                }
                const found = Array.from(state.excludedRows.values()).find((r) => {
                  if (filters.user_id && r.user_id !== filters.user_id) return false;
                  if (filters.is_active !== undefined && r.is_active !== filters.is_active) return false;
                  return true;
                });
                return { data: found ?? null, error: null };
              },
            };
            return chain;
          },
          upsert: (payloads: any[]) => ({
            select: async () => {
              const saved: any[] = [];
              for (const p of payloads) {
                const prev = state.excludedRows.get(p.user_id);
                const row = {
                  id: prev?.id ?? `ex-${p.user_id.slice(-4)}`,
                  user_id: p.user_id,
                  is_active: p.is_active,
                  note: p.note ?? null,
                  created_by: p.created_by ?? null,
                  updated_by: p.updated_by ?? null,
                  created_at: prev?.created_at ?? "2026-11-25T10:00:00Z",
                  updated_at: p.updated_at ?? "2026-11-25T10:00:00Z",
                };
                state.excludedRows.set(p.user_id, row);
                saved.push(row);
              }
              return { data: saved, error: null };
            },
          }),
          update: (patch: any) => ({
            eq: (_col: string, uid: string) => ({
              select: () => ({
                single: async () => {
                  const prev = state.excludedRows.get(uid);
                  if (!prev) return { data: null, error: { message: "Not found" } };
                  const next = { ...prev, ...patch };
                  state.excludedRows.set(uid, next);
                  return { data: next, error: null };
                },
              }),
            }),
          }),
        };
      }

      if (table === "profiles") {
        return {
          select: () => ({
            in: async (_col: string, vals: string[]) => ({
              data: state.profiles.filter((p) => vals.includes(p.id)),
              error: null,
            }),
            order: () => ({
              limit: async () => ({
                data: state.profiles,
                error: null,
              }),
            }),
          }),
        };
      }

      if (table === "user_roles") {
        return {
          select: () => ({
            limit: async () => ({
              data: state.roles,
              error: null,
            }),
          }),
        };
      }

      if (table === "audit_logs") {
        return {
          insert: async () => ({ data: null, error: null }),
        };
      }

      return {
        select: () => ({ data: [], error: null }),
      };
    }),
  };
}

describe("HUJIMAP TASK 1 — 관리자 테스트 계정 이용 통계 제외 기능 전체 검증", () => {
  const originalEnv = { ...process.env };
  let dbState: InMemoryExclusionState;

  beforeEach(() => {
    vi.clearAllMocks();
    clearIdempotencyStoreForTests();
    resetRateLimits();
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
      SUPABASE_SECRET_KEY: "sb_secret_test",
    };
    delete process.env.ALLOW_E2E_MOCK;

    mockIsServiceRoleConfigured.mockReturnValue(true);

    dbState = {
      excludedRows: new Map([
        [
          TEST_USER_1,
          {
            id: "ex-1",
            user_id: TEST_USER_1,
            is_active: true,
            note: "테스트1",
            created_by: ADMIN_ID,
            updated_by: ADMIN_ID,
            created_at: "2026-11-25T09:00:00Z",
            updated_at: "2026-11-25T09:00:00Z",
          },
        ],
        [
          TEST_USER_2,
          {
            id: "ex-2",
            user_id: TEST_USER_2,
            is_active: true,
            note: "테스트2",
            created_by: ADMIN_ID,
            updated_by: ADMIN_ID,
            created_at: "2026-11-25T09:00:00Z",
            updated_at: "2026-11-25T09:00:00Z",
          },
        ],
        [
          TEST_USER_3,
          {
            id: "ex-3",
            user_id: TEST_USER_3,
            is_active: true,
            note: "테스트3",
            created_by: ADMIN_ID,
            updated_by: ADMIN_ID,
            created_at: "2026-11-25T09:00:00Z",
            updated_at: "2026-11-25T09:00:00Z",
          },
        ],
      ]),
      dailyCounts: [],
      profiles: [
        { id: ADMIN_ID, email: "admin@hujimap.test", display_name: "운영관리자", account_status: "active", created_at: "2026-11-01T00:00:00Z" },
        { id: CUSTOMER_ID, email: "user@hujimap.test", display_name: "일반회원", account_status: "active", created_at: "2026-11-02T00:00:00Z" },
        { id: TEST_USER_1, email: "qa1@hujimap.test", display_name: "테스트1", account_status: "active", created_at: "2026-11-03T00:00:00Z" },
        { id: TEST_USER_2, email: "qa2@hujimap.test", display_name: "테스트2", account_status: "active", created_at: "2026-11-04T00:00:00Z" },
        { id: TEST_USER_3, email: "qa3@hujimap.test", display_name: "테스트3", account_status: "active", created_at: "2026-11-05T00:00:00Z" },
        { id: TEST_USER_4, email: "qa4@hujimap.test", display_name: "테스트4", account_status: "active", created_at: "2026-11-06T00:00:00Z" },
      ],
      roles: [
        { user_id: ADMIN_ID, role: "admin" },
        { user_id: CUSTOMER_ID, role: "customer" },
        { user_id: TEST_USER_1, role: "customer" },
        { user_id: TEST_USER_2, role: "customer" },
        { user_id: TEST_USER_3, role: "merchant" },
        { user_id: TEST_USER_4, role: "customer" },
      ],
      exclusionQueryError: null,
    };

    mockCreateAdminClient.mockImplementation(() => makeInMemoryAdminDb(dbState));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe("1. 기본 이용 통계 6종 계정 기반 제외 (POST /api/v1/usage-counts)", () => {
    it("비회원, 일반회원, 제외되지 않은 관리자의 6종 요청은 모두 정상 집계된다", async () => {
      // 1) Guest (no sb-* cookie): 0 auth calls, 0 exclusion lookups
      for (const feature of BASIC_USAGE_FEATURES) {
        const res = await usageCountsPost(
          new Request("http://localhost:3000/api/v1/usage-counts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ feature }),
          })
        );
        expect(res.status).toBe(200);
      }
      expect(mockCreateServerClientInstance).not.toHaveBeenCalled();

      // 2) Regular customer (with sb-* cookie)
      mockCreateServerClientInstance.mockResolvedValue(
        makeAuthClient(CUSTOMER_ID, ["customer"])
      );
      for (const feature of BASIC_USAGE_FEATURES) {
        const res = await usageCountsPost(
          new Request("http://localhost:3000/api/v1/usage-counts", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              cookie: "sb-proj-auth-token=valid-customer",
            },
            body: JSON.stringify({ feature }),
          })
        );
        expect(res.status).toBe(200);
      }

      // 3) Non-excluded admin
      mockCreateServerClientInstance.mockResolvedValue(
        makeAuthClient(ADMIN_ID, ["customer", "admin"])
      );
      for (const feature of BASIC_USAGE_FEATURES) {
        const res = await usageCountsPost(
          new Request("http://localhost:3000/api/v1/usage-counts", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              cookie: "sb-proj-auth-token=valid-admin",
            },
            body: JSON.stringify({ feature }),
          })
        );
        expect(res.status).toBe(200);
      }

      for (const feature of BASIC_USAGE_FEATURES) {
        const row = dbState.dailyCounts.find((r) => r.feature_key === feature);
        expect(row?.total_count).toBe(3);
      }
    });

    it("제외 설정된 테스트 계정 3개 각각의 로그인 상태 6종 요청은 집계 전 제외되며 식별정보를 남기지 않는다", async () => {
      for (const testUid of [TEST_USER_1, TEST_USER_2, TEST_USER_3]) {
        mockCreateServerClientInstance.mockResolvedValue(
          makeAuthClient(testUid, ["customer"])
        );

        for (const feature of BASIC_USAGE_FEATURES) {
          const res = await usageCountsPost(
            new Request("http://localhost:3000/api/v1/usage-counts", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                cookie: `sb-proj-auth-token=session-${testUid}`,
              },
              body: JSON.stringify({ feature }),
            })
          );
          expect(res.status).toBe(200);
          expect(res.headers.get("set-cookie")).toBeNull();
          const body = await res.json();
          expect(body.ok).toBe(true);
          expect(body.data.feature).toBe(feature);
          expect(JSON.stringify(body)).not.toContain(testUid);
          expect(JSON.stringify(body)).not.toContain("excluded");
        }
      }

      expect(dbState.dailyCounts).toHaveLength(0);
    });

    it("제외 계정이 로그아웃하면 비회원으로 정상 집계되고, 제외 해제 후 로그인 요청도 다시 집계되며, 재등록 시 다시 제외된다", async () => {
      // Logged out (no auth cookie) -> counted as guest
      const guestRes = await usageCountsPost(
        new Request("http://localhost:3000/api/v1/usage-counts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ feature: "map_opened" }),
        })
      );
      expect(guestRes.status).toBe(200);
      expect(dbState.dailyCounts.find((r) => r.feature_key === "map_opened")?.total_count).toBe(1);

      // Deactivate TEST_USER_1 exclusion
      mockCreateServerClientInstance.mockResolvedValue(
        makeAuthClient(ADMIN_ID, ["customer", "admin"])
      );
      const patchRes = await excludedAccountPatch(
        new Request(`http://localhost:3000/api/v1/admin/analytics/excluded-accounts/${TEST_USER_1}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive: false }),
        }),
        { params: Promise.resolve({ userId: TEST_USER_1 }) }
      );
      expect(patchRes.status).toBe(200);

      // Now TEST_USER_1 logged-in request IS counted
      mockCreateServerClientInstance.mockResolvedValue(
        makeAuthClient(TEST_USER_1, ["customer"])
      );
      const afterRemoveRes = await usageCountsPost(
        new Request("http://localhost:3000/api/v1/usage-counts", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            cookie: "sb-proj-auth-token=session-t1",
          },
          body: JSON.stringify({ feature: "map_opened" }),
        })
      );
      expect(afterRemoveRes.status).toBe(200);
      expect(dbState.dailyCounts.find((r) => r.feature_key === "map_opened")?.total_count).toBe(2);

      // Re-register TEST_USER_1
      mockCreateServerClientInstance.mockResolvedValue(
        makeAuthClient(ADMIN_ID, ["customer", "admin"])
      );
      const reAddRes = await excludedAccountsPost(
        new Request("http://localhost:3000/api/v1/admin/analytics/excluded-accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userIds: [TEST_USER_1] }),
        })
      );
      expect(reAddRes.status).toBe(200);

      // Now TEST_USER_1 is excluded again
      mockCreateServerClientInstance.mockResolvedValue(
        makeAuthClient(TEST_USER_1, ["customer"])
      );
      await usageCountsPost(
        new Request("http://localhost:3000/api/v1/usage-counts", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            cookie: "sb-proj-auth-token=session-t1",
          },
          body: JSON.stringify({ feature: "map_opened" }),
        })
      );
      expect(dbState.dailyCounts.find((r) => r.feature_key === "map_opened")?.total_count).toBe(2);
    });

    it("클라이언트의 isTest, isExcluded, userId 위조 및 헤더/쿼리 조작을 절대 신뢰하지 않는다", async () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      delete process.env.NEXT_PUBLIC_APP_ENV;

      // 1) Body spoofing rejected (400)
      for (const badBody of [
        { feature: "map_opened", isExcluded: true },
        { feature: "map_opened", userId: TEST_USER_1 },
        { feature: "map_opened", email: "qa1@hujimap.test" },
        { feature: "map_opened", role: "admin" },
      ]) {
        const res = await usageCountsPost(
          new Request("http://localhost:3000/api/v1/usage-counts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(badBody),
          })
        );
        expect(res.status).toBe(400);
      }

      // 2) Normal customer sending spoofed headers, query params, and isTest=true in production
      mockCreateServerClientInstance.mockResolvedValue(
        makeAuthClient(CUSTOMER_ID, ["customer"])
      );
      const res = await usageCountsPost(
        new Request(
          `http://localhost:3000/api/v1/usage-counts?userId=${TEST_USER_1}&isExcluded=true`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              cookie: "sb-proj-auth-token=valid-customer",
              "x-user-id": TEST_USER_1,
              "x-is-excluded": "true",
              "x-is-test": "true",
            },
            body: JSON.stringify({ feature: "search_executed", isTest: true }),
          }
        )
      );
      expect(res.status).toBe(200);
      // Production keeps is_test=false and counts normal user regardless of spoofed TEST_USER_1 headers
      const row = dbState.dailyCounts.find(
        (r) => r.feature_key === "search_executed" && r.is_test === false
      );
      expect(row?.total_count).toBe(1);
    });

    it("인증 장애 또는 제외 설정 조회 장애 시 테스트 계정 활동을 오집계하지 않고 안전하게 미집계 처리한다", async () => {
      // 1) Auth service outage (503 / RetryableFetchError) when sb-* cookie is present
      mockCreateServerClientInstance.mockResolvedValueOnce(
        makeAuthClient(null, [], {
          name: "AuthRetryableFetchError",
          status: 503,
          message: "503 Service Unavailable",
        })
      );
      const authOutageRes = await usageCountsPost(
        new Request("http://localhost:3000/api/v1/usage-counts", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            cookie: "sb-proj-auth-token=maybe-test-user",
          },
          body: JSON.stringify({ feature: "directions_clicked" }),
        })
      );
      expect(authOutageRes.status).toBe(200);
      expect(dbState.dailyCounts).toHaveLength(0);

      // 2) Auth getUser throws network error
      mockCreateServerClientInstance.mockResolvedValueOnce(
        makeAuthClient(null, [], new Error("fetch failed"))
      );
      const authThrowRes = await usageCountsPost(
        new Request("http://localhost:3000/api/v1/usage-counts", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            cookie: "sb-proj-auth-token=maybe-test-user",
          },
          body: JSON.stringify({ feature: "directions_clicked" }),
        })
      );
      expect(authThrowRes.status).toBe(200);
      expect(dbState.dailyCounts).toHaveLength(0);

      // 3) Exclusion DB lookup failure when authenticated user verified
      mockCreateServerClientInstance.mockResolvedValueOnce(
        makeAuthClient(TEST_USER_1, ["customer"])
      );
      dbState.exclusionQueryError = { message: "DB connection timeout" };
      const dbOutageRes = await usageCountsPost(
        new Request("http://localhost:3000/api/v1/usage-counts", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            cookie: "sb-proj-auth-token=session-t1",
          },
          body: JSON.stringify({ feature: "directions_clicked" }),
        })
      );
      expect(dbOutageRes.status).toBe(200);
      expect(dbState.dailyCounts).toHaveLength(0);
    });

    it("일반 사용자와 제외 계정의 동시 요청에서 일반 사용자 요청만 정확히 증가한다", async () => {
      const adminDb = makeInMemoryAdminDb(dbState);
      const normalAuth = makeAuthClient(CUSTOMER_ID, ["customer"]);
      const testAuth1 = makeAuthClient(TEST_USER_1, ["customer"]);
      const testAuth2 = makeAuthClient(TEST_USER_2, ["customer"]);

      await Promise.all([
        recordDailyUsageCount(adminDb as any, { feature: "restroom_marker_clicked" }, { authClient: normalAuth as any, hasAuthCookie: true }),
        recordDailyUsageCount(adminDb as any, { feature: "restroom_marker_clicked" }, { authClient: testAuth1 as any, hasAuthCookie: true }),
        recordDailyUsageCount(adminDb as any, { feature: "restroom_marker_clicked" }, { authClient: testAuth2 as any, hasAuthCookie: true }),
        recordDailyUsageCount(adminDb as any, { feature: "restroom_marker_clicked" }), // guest
      ]);

      expect(
        dbState.dailyCounts.find((r) => r.feature_key === "restroom_marker_clicked")?.total_count
      ).toBe(2);
    });
  });

  describe("2. 상세 행동 분석 및 A / B-1~B-4 지표 제외 검증", () => {
    it("실제 연결된 테스트 계정 기록만 제외하고, 로그인 전 익명 기록·원본 데이터·동의 경계는 보존하며 B-1~B-4 및 전환율을 일관 계산한다", async () => {
      const WINDOW = {
        startsAt: "2026-11-20T00:00:00.000Z",
        endsAt: "2026-11-26T23:59:59.999Z",
      };
      const PARTNER_ID = "aaaa1111-1111-4111-8111-111111111111";
      const PUBLIC_ID = "bbbb2222-2222-4222-8222-222222222222";
      const SAME_BROWSER_PRE_LOGIN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const NORMAL_BROWSER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      const TEST_BROWSER_2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

      const mockDb: any = {
        from: vi.fn((table: string) => {
          if (table === "analytics_excluded_accounts") {
            return {
              select: () => ({
                eq: async () => ({
                  data: [{ user_id: TEST_USER_1 }, { user_id: TEST_USER_2 }],
                  error: null,
                }),
              }),
            };
          }
          if (table === "experiments") {
            return {
              select: () => ({
                eq: () => ({ maybeSingle: async () => ({ data: null }) }),
              }),
            };
          }
          if (table === "visitor_sessions") {
            return {
              select: async () => ({
                data: [
                  // 1. Pre-login anonymous session on SAME browser as TEST_USER_1 (MUST KEEP!)
                  { id: "s-anon-pre", browser_id: SAME_BROWSER_PRE_LOGIN, user_id: null, started_at: "2026-11-24T01:00:00Z", utm_source: "kakao_ad", traveling_now: true, is_test: false },
                  // 2. Normal user session
                  { id: "s-normal", browser_id: NORMAL_BROWSER, user_id: CUSTOMER_ID, started_at: "2026-11-24T02:00:00Z", utm_source: "kakao_ad", traveling_now: true, is_test: false },
                  // 3. Excluded test user 1 session (MUST EXCLUDE)
                  { id: "s-test-1", browser_id: SAME_BROWSER_PRE_LOGIN, user_id: TEST_USER_1, started_at: "2026-11-24T03:00:00Z", utm_source: "kakao_ad", traveling_now: true, is_test: false },
                  // 4. Excluded test user 2 session (MUST EXCLUDE)
                  { id: "s-test-2", browser_id: TEST_BROWSER_2, user_id: TEST_USER_2, started_at: "2026-11-24T04:00:00Z", utm_source: null, traveling_now: false, is_test: false },
                ],
              }),
            };
          }
          if (table === "event_logs") {
            return {
              select: async () => ({
                data: [
                  // Anonymous pre-login event on same browser (MUST KEEP!)
                  { id: "e1", session_id: "s-anon-pre", browser_id: SAME_BROWSER_PRE_LOGIN, user_id: null, restroom_id: PUBLIC_ID, event_name: "map_loaded", properties: {}, occurred_at: "2026-11-24T01:01:00Z", is_test: false },
                  { id: "e2", session_id: "s-anon-pre", browser_id: SAME_BROWSER_PRE_LOGIN, user_id: null, restroom_id: PARTNER_ID, event_name: "restroom_card_viewed", properties: { card_type: "partner" }, occurred_at: "2026-11-24T01:02:00Z", is_test: false },
                  // Normal user events (MUST KEEP -> card_viewed -> directions_clicked, detail -> payment_button)
                  { id: "e3", session_id: "s-normal", browser_id: NORMAL_BROWSER, user_id: CUSTOMER_ID, restroom_id: null, event_name: "map_loaded", properties: {}, occurred_at: "2026-11-24T02:01:00Z", is_test: false },
                  { id: "e4", session_id: "s-normal", browser_id: NORMAL_BROWSER, user_id: CUSTOMER_ID, restroom_id: PARTNER_ID, event_name: "restroom_marker_clicked", properties: { type: "partner" }, occurred_at: "2026-11-24T02:02:00Z", is_test: false },
                  { id: "e5", session_id: "s-normal", browser_id: NORMAL_BROWSER, user_id: CUSTOMER_ID, restroom_id: PARTNER_ID, event_name: "restroom_card_viewed", properties: { card_type: "partner" }, occurred_at: "2026-11-24T02:03:00Z", is_test: false },
                  { id: "e6", session_id: "s-normal", browser_id: NORMAL_BROWSER, user_id: CUSTOMER_ID, restroom_id: PARTNER_ID, event_name: "restroom_detail_opened", properties: { type: "partner" }, occurred_at: "2026-11-24T02:04:00Z", is_test: false },
                  { id: "e7", session_id: "s-normal", browser_id: NORMAL_BROWSER, user_id: CUSTOMER_ID, restroom_id: PARTNER_ID, event_name: "directions_clicked", properties: { type: "partner" }, occurred_at: "2026-11-24T02:05:00Z", is_test: false },
                  { id: "e8", session_id: "s-normal", browser_id: NORMAL_BROWSER, user_id: CUSTOMER_ID, restroom_id: PARTNER_ID, event_name: "payment_button_clicked", properties: {}, occurred_at: "2026-11-24T02:06:00Z", is_test: false },
                  // Excluded test user 1 & 2 events (MUST EXCLUDE)
                  { id: "e9", session_id: "s-test-1", browser_id: SAME_BROWSER_PRE_LOGIN, user_id: TEST_USER_1, restroom_id: PARTNER_ID, event_name: "directions_clicked", properties: { type: "partner" }, occurred_at: "2026-11-24T03:05:00Z", is_test: false },
                  { id: "e10", session_id: "s-test-2", browser_id: TEST_BROWSER_2, user_id: TEST_USER_2, restroom_id: PARTNER_ID, event_name: "restroom_detail_opened", properties: { type: "partner" }, occurred_at: "2026-11-24T04:02:00Z", is_test: false },
                  { id: "e11", session_id: "s-test-2", browser_id: TEST_BROWSER_2, user_id: TEST_USER_2, restroom_id: PARTNER_ID, event_name: "payment_button_clicked", properties: {}, occurred_at: "2026-11-24T04:03:00Z", is_test: false },
                ],
              }),
            };
          }
          if (table === "restrooms") {
            return {
              select: () => ({
                eq: async () => ({
                  data: [{ id: PARTNER_ID, name: "제휴화장실A", type: "partner", publication_status: "published" }],
                }),
                in: async () => ({
                  data: [
                    { id: PARTNER_ID, name: "제휴화장실A", type: "partner", publication_status: "published" },
                    { id: PUBLIC_ID, name: "공공화장실B", type: "public", publication_status: "published" },
                  ],
                }),
              }),
            };
          }
          if (table === "payment_orders") {
            return {
              select: async () => ({
                data: [
                  { id: "ord-normal", user_id: CUSTOMER_ID, status: "approved", payment_mode: "test", approved_at: "2026-11-24T02:10:00Z", created_at: "2026-11-24T02:09:00Z" },
                  { id: "ord-test1", user_id: TEST_USER_1, status: "approved", payment_mode: "test", approved_at: "2026-11-24T03:10:00Z", created_at: "2026-11-24T03:09:00Z" },
                ],
              }),
            };
          }
          if (table === "access_sessions") {
            return {
              select: async () => ({
                data: [
                  { id: "acc-normal", user_id: CUSTOMER_ID, status: "authorized", authorized_at: "2026-11-24T02:10:00Z", created_at: "2026-11-24T02:09:00Z" },
                  { id: "acc-test1", user_id: TEST_USER_1, status: "authorized", authorized_at: "2026-11-24T03:10:00Z", created_at: "2026-11-24T03:09:00Z" },
                ],
              }),
            };
          }
          if (table === "receipt_submissions") {
            return {
              select: async () => ({
                data: [
                  { id: "rec-normal", user_id: CUSTOMER_ID, submission_status: "approved", created_at: "2026-11-24T02:20:00Z" },
                  { id: "rec-test1", user_id: TEST_USER_1, submission_status: "approved", created_at: "2026-11-24T03:20:00Z" },
                ],
              }),
            };
          }
          if (table === "payment_refunds") {
            return {
              select: async () => ({
                data: [
                  { id: "ref-normal", payment_order_id: "ord-normal", status: "succeeded", completed_at: "2026-11-24T02:30:00Z", requested_at: "2026-11-24T02:25:00Z" },
                  // Refund requested by admin, but belongs to TEST_USER_1's order -> MUST EXCLUDE!
                  { id: "ref-test1", payment_order_id: "ord-test1", status: "succeeded", completed_at: "2026-11-24T03:30:00Z", requested_at: "2026-11-24T03:25:00Z" },
                ],
              }),
            };
          }
          if (table === "daily_usage_counts") {
            return {
              select: () => ({
                gte: () => ({
                  lte: async () => ({
                    data: [
                      { stat_date: "2026-11-24", feature_key: "map_opened", is_test: false, total_count: 15 },
                    ],
                  }),
                }),
              }),
            };
          }
          return { select: async () => ({ data: [] }) };
        }),
      };

      const report = await getPmfReport(mockDb, {
        experimentKey: "pmf_r1",
        startsAt: WINDOW.startsAt,
        endsAt: WINDOW.endsAt,
        includeTest: false,
        authFilter: "all",
      });

      // Summary & Account Exclusions
      expect(report.summary.totalEvents).toBe(8); // e1..e8 kept, e9..e11 excluded
      expect(report.summary.distinctSessions).toBe(2); // s-anon-pre + s-normal kept
      expect(report.accountExclusions?.activeExcludedAccountsCount).toBe(2);
      expect(report.accountExclusions?.excludedEventCount).toBe(3);
      expect(report.accountExclusions?.excludedSessionCount).toBe(2);
      expect(report.accountExclusions?.excludedOrderCount).toBe(1);
      expect(report.accountExclusions?.excludedTicketCount).toBe(1);
      expect(report.accountExclusions?.excludedReceiptCount).toBe(1);
      expect(report.accountExclusions?.excludedRefundCount).toBe(1);

      // A. Basic Usage (preserved historical total)
      expect(report.basicUsageMetrics?.totals.mapOpened).toBe(15);

      // B-1. Scale: pre-login anonymous browser (SAME_BROWSER_PRE_LOGIN) + NORMAL_BROWSER = 2 visiting browsers!
      expect(report.serviceMetrics?.overview.visitingBrowsers).toBe(2);
      expect(report.serviceMetrics?.overview.mapViews).toBe(2);
      expect(report.serviceMetrics?.overview.cardClicks).toBe(2);

      // B-2. Interest: only normal user's marker/detail, both card views (anon + normal)
      expect(report.serviceMetrics?.overview.markerClicks).toBe(1);
      expect(report.serviceMetrics?.overview.detailViews).toBe(1);

      // B-3. Intent:
      // Note! Because e9 (logged-in TEST_USER_1 directions_clicked) was excluded, SAME_BROWSER_PRE_LOGIN's anonymous card view (e2) does NOT falsely convert!
      // Exposed browsers = 2 (SAME_BROWSER_PRE_LOGIN + NORMAL_BROWSER), converted = 1 (NORMAL_BROWSER) -> 50.0%
      expect(report.serviceMetrics?.overview.directionsClicks).toBe(1);
      expect(report.serviceMetrics?.overview.cardToDirectionsExposedBrowsers).toBe(2);
      expect(report.serviceMetrics?.overview.cardToDirectionsConvertedBrowsers).toBe(1);
      expect(report.serviceMetrics?.overview.cardToDirectionsRatePercent).toBe(50.0);
      // Partner detail -> payment button: TEST_USER_2's detail & payment excluded -> 1/1 = 100.0%
      expect(report.serviceMetrics?.overview.partnerDetailExposedBrowsers).toBe(1);
      expect(report.serviceMetrics?.overview.partnerDetailToPaymentBrowsers).toBe(1);
      expect(report.serviceMetrics?.overview.partnerDetailToPaymentRatePercent).toBe(100.0);

      // B-4. Server Records: TEST_USER_1's order, ticket, receipt, refund excluded -> 1 each
      expect(report.serviceMetrics?.overview.testModePayments).toBe(1);
      expect(report.serviceMetrics?.overview.issuedTickets).toBe(1);
      expect(report.serviceMetrics?.overview.submittedReceipts).toBe(1);
      expect(report.serviceMetrics?.overview.approvedReceipts).toBe(1);
      expect(report.serviceMetrics?.overview.refundsSucceeded).toBe(1);

      // H2 & H5 consistency
      expect(report.hypotheses.h2.denominatorCount).toBe(2);
      expect(report.hypotheses.h2.numeratorCount).toBe(1);
      expect(report.hypotheses.h5.denominatorCount).toBe(2);
      expect(report.hypotheses.h5.numeratorCount).toBe(1);

      // No excluded user PII / emails in PMF report
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain("qa1@hujimap.test");
      expect(serialized).not.toContain(TEST_USER_1);
    });

    it("기본 이용 통계 API의 DB 호출 수(비회원 1회, 제외회원 단건조회 1회+RPC 0회) 및 응답시간을 검증한다", async () => {
      const adminDb = makeInMemoryAdminDb(dbState);

      const t0 = performance.now();
      await recordDailyUsageCount(adminDb as any, { feature: "map_opened" });
      const guestMs = performance.now() - t0;

      // Guest: 0 table lookups, 1 RPC
      expect(adminDb.from).toHaveBeenCalledTimes(0);
      expect(adminDb.rpc).toHaveBeenCalledTimes(1);

      adminDb.from.mockClear();
      adminDb.rpc.mockClear();

      const t1 = performance.now();
      await recordDailyUsageCount(
        adminDb as any,
        { feature: "map_opened" },
        { authClient: makeAuthClient(TEST_USER_1, ["customer"]) as any, hasAuthCookie: true }
      );
      const excludedMs = performance.now() - t1;

      // Excluded user: 1 indexed point lookup on analytics_excluded_accounts, 0 RPC
      expect(adminDb.from).toHaveBeenCalledTimes(1);
      expect(adminDb.from).toHaveBeenCalledWith("analytics_excluded_accounts");
      expect(adminDb.rpc).toHaveBeenCalledTimes(0);
      expect(guestMs).toBeLessThan(100);
      expect(excludedMs).toBeLessThan(100);
    });
  });

  describe("3. 관리자 제외 설정 API 권한 및 유효성 검증", () => {
    it("비회원은 401, 일반회원은 403으로 조회·등록·해제 API 접근을 차단한다", async () => {
      // Guest -> 401
      mockCreateServerClientInstance.mockResolvedValue(makeAuthClient(null, []));
      expect(
        (await excludedAccountsGet(new Request("http://localhost:3000/api/v1/admin/analytics/excluded-accounts"))).status
      ).toBe(401);
      expect(
        (
          await excludedAccountsPost(
            new Request("http://localhost:3000/api/v1/admin/analytics/excluded-accounts", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ userIds: [CUSTOMER_ID] }),
            })
          )
        ).status
      ).toBe(401);
      expect(
        (
          await excludedAccountPatch(
            new Request(`http://localhost:3000/api/v1/admin/analytics/excluded-accounts/${TEST_USER_1}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ isActive: false }),
            }),
            { params: Promise.resolve({ userId: TEST_USER_1 }) }
          )
        ).status
      ).toBe(401);

      // Customer -> 403 (even if trying to self-register or spoof headers)
      mockCreateServerClientInstance.mockResolvedValue(makeAuthClient(CUSTOMER_ID, ["customer"]));
      expect(
        (
          await excludedAccountsGet(
            new Request("http://localhost:3000/api/v1/admin/analytics/excluded-accounts", {
              headers: { "x-user-role": "admin" },
            })
          )
        ).status
      ).toBe(403);
      expect(
        (
          await excludedAccountsPost(
            new Request("http://localhost:3000/api/v1/admin/analytics/excluded-accounts", {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-user-role": "admin" },
              body: JSON.stringify({ userIds: [CUSTOMER_ID] }),
            })
          )
        ).status
      ).toBe(403);
      expect(
        (
          await excludedAccountDelete(
            new Request(`http://localhost:3000/api/v1/admin/analytics/excluded-accounts/${TEST_USER_1}`, {
              method: "DELETE",
            }),
            { params: Promise.resolve({ userId: TEST_USER_1 }) }
          )
        ).status
      ).toBe(403);
    });

    it("관리자는 회원 검색, 4개 이상 다중 등록(3개 상한 없음), 중복 방지, 미존재 계정 차단을 정상 수행한다", async () => {
      mockCreateServerClientInstance.mockResolvedValue(makeAuthClient(ADMIN_ID, ["customer", "admin"]));

      // Search candidates by query
      const getRes = await excludedAccountsGet(
        new Request("http://localhost:3000/api/v1/admin/analytics/excluded-accounts?q=qa4")
      );
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json();
      expect(getBody.data.activeCount).toBe(3);
      expect(getBody.data.candidates.map((c: any) => c.userId)).toEqual([TEST_USER_4]);

      // Register 4th account (no 3-account cap) + duplicate TEST_USER_1 in same payload
      const postRes = await excludedAccountsPost(
        new Request("http://localhost:3000/api/v1/admin/analytics/excluded-accounts", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-idempotency-key": "idem-add-4",
          },
          body: JSON.stringify({
            userIds: [TEST_USER_1, TEST_USER_4, TEST_USER_4],
            note: "추가 테스트 계정",
          }),
        })
      );
      expect(postRes.status).toBe(200);
      expect(dbState.excludedRows.size).toBe(4);
      expect(dbState.excludedRows.get(TEST_USER_4)?.is_active).toBe(true);

      // Replay with same idempotency key
      const replayRes = await excludedAccountsPost(
        new Request("http://localhost:3000/api/v1/admin/analytics/excluded-accounts", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-idempotency-key": "idem-add-4",
          },
          body: JSON.stringify({
            userIds: [TEST_USER_1, TEST_USER_4, TEST_USER_4],
            note: "추가 테스트 계정",
          }),
        })
      );
      expect(replayRes.status).toBe(200);

      // Reject non-existent account UUID with 404
      const missingRes = await excludedAccountsPost(
        new Request("http://localhost:3000/api/v1/admin/analytics/excluded-accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userIds: [NON_EXISTENT_ID] }),
        })
      );
      expect(missingRes.status).toBe(404);
      expect((await missingRes.json()).error.code).toBe("USER_NOT_FOUND");
    });
  });
});
