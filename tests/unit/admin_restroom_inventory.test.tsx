/**
 * @vitest-environment jsdom
 */

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  classifyRestroomSource,
  classifyRestroomVerification,
  extractRestroomRegion,
  getAdminRestroomStats,
  isAdminRestroomMapVisible,
  listAdminRestroomInventory,
  sanitizePostgrestIlikeTerm,
} from "@/lib/restrooms/admin-inventory-service";
import { adminRestroomInventoryFilterSchema } from "@/lib/restrooms/admin-validation";

const mockRequireRole = vi.fn();
const mockCreateServerClientInstance = vi.fn();
const mockGetServerAuthSession = vi.fn();
const mockIsE2eMockSessionAllowed = vi.fn();
const mockCookies = vi.fn();

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    requireRole: (...args: any[]) => mockRequireRole(...args),
    getServerAuthSession: () => mockGetServerAuthSession(),
    isE2eMockSessionAllowed: (v: string | undefined) => mockIsE2eMockSessionAllowed(v),
    isSupabaseAuthConfigured: () => true,
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createServerClientInstance: () => mockCreateServerClientInstance(),
}));

vi.mock("next/headers", () => ({
  cookies: () => mockCookies(),
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/layout/AppShell", () => ({
  default: ({ children, headerTitle }: { children: React.ReactNode; headerTitle?: string }) => (
    <div data-testid="app-shell" data-title={headerTitle}>
      {children}
    </div>
  ),
}));

import { GET as getStatsRoute } from "@/app/api/v1/admin/restrooms/stats/route";
import { GET as getInventoryRoute } from "@/app/api/v1/admin/restrooms/inventory/route";
import AdminRestroomInventoryPage from "@/app/admin/restrooms/inventory/page";
import AdminRestroomInventoryClient from "@/app/admin/restrooms/inventory/AdminRestroomInventoryClient";
import { AuthGuardError } from "@/lib/auth";

function createDatasetMockSupabase(rows: any[], options?: { queriedTables?: string[] }) {
  const queriedTables = options?.queriedTables ?? [];
  return {
    from(table: string) {
      queriedTables.push(table);
      const state: any = {
        table,
        eqs: [] as Array<[string, any]>,
        ins: [] as Array<[string, any[]]>,
        isNulls: [] as string[],
        ilikes: [] as Array<[string, string]>,
        nots: [] as Array<[string, string, string]>,
        ors: [] as string[],
        orders: [] as Array<[string, boolean]>,
        rangeBounds: [0, 999] as [number, number],
      };

      const builder: any = {
        select: () => builder,
        eq: (col: string, val: any) => {
          state.eqs.push([col, val]);
          return builder;
        },
        in: (col: string, vals: any[]) => {
          state.ins.push([col, vals]);
          return builder;
        },
        is: (col: string, val: any) => {
          if (val === null) state.isNulls.push(col);
          return builder;
        },
        ilike: (col: string, pat: string) => {
          state.ilikes.push([col, pat]);
          return builder;
        },
        not: (col: string, op: string, pat: string) => {
          state.nots.push([col, op, pat]);
          return builder;
        },
        or: (expr: string) => {
          state.ors.push(expr);
          return builder;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          state.orders.push([col, opts?.ascending ?? true]);
          return builder;
        },
        range: async (from: number, to: number) => {
          state.rangeBounds = [from, to];
          return execute();
        },
        maybeSingle: async () => {
          if (table === "feature_flags") {
            return { data: { enabled: true }, error: null };
          }
          return { data: null, error: null };
        },
        then: (resolve: any, reject: any) => Promise.resolve(execute()).then(resolve, reject),
      };

      function matchesIlike(val: string | null | undefined, pat: string): boolean {
        const s = (val ?? "").toLowerCase();
        const escaped = pat
          .toLowerCase()
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          .replace(/%/g, ".*");
        return new RegExp(`^${escaped}$`).test(s);
      }

      function execute() {
        if (table === "businesses") {
          return {
            data: [{ id: "biz-approved", name: "제휴카페", registration_status: "approved" }],
            error: null,
          };
        }
        if (table === "public_data_sources") {
          return {
            data: [
              { id: "src-seoul", provider_name: "서울특별시", dataset_name: "서울시 공중화장실 위치정보 (OA-22586)" },
              { id: "src-suwon", provider_name: "경기도 수원시", dataset_name: "공중화장실 현황" },
            ],
            error: null,
          };
        }
        if (table === "feature_flags") {
          return { data: { enabled: true }, error: null };
        }
        if (table === "restrooms") {
          let list = [...rows];
          for (const [col, val] of state.eqs) {
            list = list.filter((r) => r[col] === val);
          }
          for (const [col, vals] of state.ins) {
            list = list.filter((r) => vals.includes(r[col]));
          }
          for (const col of state.isNulls) {
            list = list.filter((r) => r[col] == null);
          }
          for (const [col, pat] of state.ilikes) {
            list = list.filter((r) => matchesIlike(r[col], pat));
          }
          for (const [col, op, pat] of state.nots) {
            if (op === "ilike") {
              list = list.filter((r) => !matchesIlike(r[col], pat));
            }
          }
          for (const expr of state.ors) {
            if (expr.includes("name.ilike")) {
              const m = expr.match(/name\.ilike\.%([^%,]+)%/);
              const q = (m?.[1] ?? "").toLowerCase();
              list = list.filter(
                (r) =>
                  r.name.toLowerCase().includes(q) ||
                  (r.road_address ?? "").toLowerCase().includes(q) ||
                  (r.address_detail ?? "").toLowerCase().includes(q)
              );
            } else if (expr.includes("FIELD_VERIFIED=true") && expr.includes("not.ilike")) {
              list = list.filter(
                (r) =>
                  r.coordinate_verification_basis == null ||
                  !String(r.coordinate_verification_basis).includes("FIELD_VERIFIED=true")
              );
            } else if (expr.includes("address_detail.is.null,and(")) {
              list = list.filter(
                (r) =>
                  r.address_detail == null ||
                  (!matchesIlike(r.address_detail, "서울%") &&
                    !matchesIlike(r.address_detail, "%수원시%") &&
                    !matchesIlike(r.address_detail, "%수원특례시%"))
              );
            } else if (expr.includes("road_address.ilike.")) {
              const clauses: Array<[string, string]> = expr.split(",").map((c: string) => {
                const idx = c.indexOf(".ilike.");
                return [c.slice(0, idx), c.slice(idx + ".ilike.".length)];
              });
              list = list.filter((r) => clauses.some(([col, pat]) => matchesIlike(r[col], pat)));
            }
          }
          for (let i = state.orders.length - 1; i >= 0; i--) {
            const [col, asc] = state.orders[i];
            list.sort((a, b) => {
              const av = String(a[col] ?? "");
              const bv = String(b[col] ?? "");
              return asc ? av.localeCompare(bv) : bv.localeCompare(av);
            });
          }
          const total = list.length;
          const [from, to] = state.rangeBounds;
          const sliced = list.slice(from, to + 1);
          return { data: sliced, error: null, count: total };
        }
        return { data: [], error: null };
      }

      return builder;
    },
  } as any;
}

describe("Admin Restroom Inventory & Stats (TASK 1~4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCookies.mockResolvedValue({ get: () => undefined });
    mockIsE2eMockSessionAllowed.mockReturnValue(false);
  });

  it("extracts regions, sources, verification states, and map exposure parity accurately", () => {
    expect(extractRestroomRegion("서울특별시 강남구 광평로 126")).toEqual({
      group: "seoul",
      key: "seoul:강남구",
      label: "서울 강남구",
      seoulGu: "강남구",
    });
    expect(extractRestroomRegion("경기도 수원시 팔달구 효원로 241")).toEqual({
      group: "suwon",
      key: "suwon",
      label: "경기도 수원시",
      seoulGu: null,
    });
    expect(
      extractRestroomRegion(
        "경기도 영통구 센트럴타운로 103(이의동)",
        "(지번) 경기도 수원시 영통구 이의동 1330-1"
      )
    ).toEqual({
      group: "suwon",
      key: "suwon",
      label: "경기도 수원시",
      seoulGu: null,
    });
    expect(extractRestroomRegion("경기도 수원특례시 권선구 금곡로73번길 33")).toEqual({
      group: "suwon",
      key: "suwon",
      label: "경기도 수원시",
      seoulGu: null,
    });

    expect(
      classifyRestroomVerification({
        type: "public",
        coordinate_verification_status: "VERIFIED",
        coordinate_verification_basis: "POLICY=OFFICIAL_SOURCE_VALIDATED|FIELD_VERIFIED=false",
      }).category
    ).toBe("official_validated");
    expect(
      classifyRestroomVerification({
        type: "public",
        coordinate_verification_status: "VERIFIED",
        coordinate_verification_basis: "POLICY=FIELD_VERIFIED|FIELD_VERIFIED=true",
      }).category
    ).toBe("field_verified");
    expect(
      classifyRestroomVerification({
        type: "public",
        coordinate_verification_status: null,
        coordinate_verification_basis: null,
      }).category
    ).toBe("legacy_unset");

    const dsMap = new Map();
    expect(
      classifyRestroomSource(
        { type: "public", coordinate_source: "seoul_public_toilet_info", source_id: null, coordinate_source_id: null },
        dsMap
      ).key
    ).toBe("seoul_oa22586");

    const approvedBiz = new Set(["biz-approved"]);
    expect(
      isAdminRestroomMapVisible(
        {
          type: "public",
          publication_status: "published",
          latitude: 37.5,
          longitude: 127.0,
          business_id: null,
          coordinate_source: "seoul_public_toilet_info",
          coordinate_type: "facility_official",
          coordinate_verification_status: "VERIFIED",
        },
        approvedBiz,
        true
      )
    ).toBe(true);
    expect(
      isAdminRestroomMapVisible(
        {
          type: "public",
          publication_status: "published",
          latitude: 37.5,
          longitude: 127.0,
          business_id: null,
          coordinate_source: "mois_address_nav_db",
          coordinate_type: "building_centroid",
          coordinate_verification_status: "CANDIDATE",
        },
        approvedBiz,
        true
      )
    ).toBe(false);
    expect(
      isAdminRestroomMapVisible(
        {
          type: "partner",
          publication_status: "draft",
          latitude: 37.26,
          longitude: 127.02,
          business_id: "biz-approved",
          coordinate_source: null,
          coordinate_type: null,
          coordinate_verification_status: null,
        },
        approvedBiz,
        true
      )
    ).toBe(false);
    expect(sanitizePostgrestIlikeTerm("일원%(test),_1")).toBe("일원 test 1");
  });

  it("aggregates 2,480 rows across 1,000-row chunks into exact counts without querying PIN/payment tables", async () => {
    const rows: any[] = [];
    for (let i = 0; i < 1974; i++) {
      rows.push({
        id: `seoul-${String(i).padStart(4, "0")}`,
        name: `서울화장실 ${i}`,
        type: "public",
        publication_status: "published",
        road_address: i % 2 === 0 ? `서울특별시 강남구 테헤란로 ${i}` : `서울특별시 강북구 도봉로 ${i}`,
        address_detail: null,
        latitude: 37.5,
        longitude: 127.0,
        source_id: "src-seoul",
        coordinate_source_id: "src-seoul",
        coordinate_source: "seoul_public_toilet_info",
        coordinate_type: "facility_official",
        coordinate_verification_status: "VERIFIED",
        coordinate_verification_basis: "POLICY=OFFICIAL_SOURCE_VALIDATED|FIELD_VERIFIED=false",
        business_id: null,
        created_at: "2026-11-25T00:00:00Z",
        updated_at: "2026-11-25T00:00:00Z",
      });
    }
    for (let i = 0; i < 502; i++) {
      rows.push({
        id: `suwon-${String(i).padStart(4, "0")}`,
        name: `수원화장실 ${i}`,
        type: "public",
        publication_status: "published",
        road_address: `경기도 수원시 팔달구 효원로 ${i}`,
        address_detail: null,
        latitude: 37.26,
        longitude: 127.02,
        source_id: "src-suwon",
        coordinate_source_id: "src-suwon",
        coordinate_source: "gg_publtolt_15011425",
        coordinate_type: null,
        coordinate_verification_status: null,
        coordinate_verification_basis: null,
        business_id: null,
        created_at: "2026-11-20T00:00:00Z",
        updated_at: "2026-11-20T00:00:00Z",
      });
    }
    rows.push(
      {
        id: "partner-pub",
        name: "제휴 공개 화장실",
        type: "partner",
        publication_status: "published",
        road_address: "경기도 수원시 팔달구 효원로 10",
        address_detail: null,
        latitude: 37.26,
        longitude: 127.02,
        source_id: null,
        coordinate_source_id: null,
        coordinate_source: null,
        coordinate_type: null,
        coordinate_verification_status: null,
        coordinate_verification_basis: null,
        business_id: "biz-approved",
        created_at: "2026-11-21T00:00:00Z",
        updated_at: "2026-11-21T00:00:00Z",
      },
      {
        id: "partner-draft-1",
        name: "제휴 초안 1",
        type: "partner",
        publication_status: "draft",
        road_address: "경기도 수원시 팔달구 효원로 11",
        address_detail: null,
        latitude: 37.26,
        longitude: 127.02,
        source_id: null,
        coordinate_source_id: null,
        coordinate_source: null,
        coordinate_type: null,
        coordinate_verification_status: null,
        coordinate_verification_basis: null,
        business_id: "biz-approved",
        created_at: "2026-11-21T00:00:00Z",
        updated_at: "2026-11-21T00:00:00Z",
      },
      {
        id: "partner-draft-2",
        name: "제휴 초안 2",
        type: "partner",
        publication_status: "draft",
        road_address: "경기도 수원시 팔달구 효원로 12",
        address_detail: null,
        latitude: 37.26,
        longitude: 127.02,
        source_id: null,
        coordinate_source_id: null,
        coordinate_source: null,
        coordinate_type: null,
        coordinate_verification_status: null,
        coordinate_verification_basis: null,
        business_id: "biz-approved",
        created_at: "2026-11-21T00:00:00Z",
        updated_at: "2026-11-21T00:00:00Z",
      },
      {
        id: "partner-pending",
        name: "제휴 대기",
        type: "partner",
        publication_status: "pending",
        road_address: "경기도 수원시 팔달구 효원로 13",
        address_detail: null,
        latitude: 37.26,
        longitude: 127.02,
        source_id: null,
        coordinate_source_id: null,
        coordinate_source: null,
        coordinate_type: null,
        coordinate_verification_status: null,
        coordinate_verification_basis: null,
        business_id: "biz-approved",
        created_at: "2026-11-21T00:00:00Z",
        updated_at: "2026-11-21T00:00:00Z",
      }
    );

    const queriedTables: string[] = [];
    const mockDb = createDatasetMockSupabase(rows, { queriedTables });
    const stats = await getAdminRestroomStats(mockDb);

    expect(stats.totalCount).toBe(2480);
    expect(stats.mapVisibleCount).toBe(2477);
    expect(stats.hiddenCount).toBe(3);
    expect(stats.byType).toEqual({ public: 2476, partner: 4 });
    expect(stats.byPublicationStatus).toEqual({
      published: 2477,
      draft: 2,
      pending: 1,
      suspended: 0,
      archived: 0,
    });
    expect(stats.regionSummary).toEqual({ seoulTotal: 1974, suwonTotal: 506, otherTotal: 0 });
    expect(stats.byVerificationStatus).toEqual({
      fieldVerified: 0,
      officialValidated: 1974,
      reviewRequired: 0,
      legacyUnset: 502,
      partnerDirect: 4,
    });
    expect(queriedTables).not.toContain("restroom_lock_secrets");
    expect(queriedTables).not.toContain("payment_orders");
    expect(queriedTables).not.toContain("receipt_submissions");

    // Verify server pagination across pages 1 and 2 (50 items each, zero overlap)
    const p1 = await listAdminRestroomInventory(
      mockDb,
      adminRestroomInventoryFilterSchema.parse({ region: "seoul:강남구", page: "1", limit: "50" })
    );
    const p2 = await listAdminRestroomInventory(
      mockDb,
      adminRestroomInventoryFilterSchema.parse({ region: "seoul:강남구", page: "2", limit: "50" })
    );
    expect(p1.total).toBe(987);
    expect(p1.items).toHaveLength(50);
    expect(p2.items).toHaveLength(50);
    const overlap = p1.items.filter((x) => p2.items.some((y) => y.id === x.id));
    expect(overlap).toHaveLength(0);

    // Verify suwon filter matches address_detail fallback rows consistently with stats
    const suwonList = await listAdminRestroomInventory(
      mockDb,
      adminRestroomInventoryFilterSchema.parse({ region: "suwon", page: "1", limit: "50" })
    );
    expect(suwonList.total).toBe(506);
  });

  it("enforces admin role on /stats, /inventory APIs and SSR page (401/403/400/200)", async () => {
    mockCreateServerClientInstance.mockResolvedValue(createDatasetMockSupabase([]));

    // 401 unauthenticated
    mockRequireRole.mockRejectedValueOnce(new AuthGuardError("UNAUTHORIZED", 401, "로그인이 필요합니다."));
    expect((await getStatsRoute()).status).toBe(401);

    // 403 non-admin
    mockRequireRole.mockRejectedValueOnce(new AuthGuardError("FORBIDDEN", 403, "권한이 없습니다."));
    expect((await getInventoryRoute(new Request("http://localhost/api/v1/admin/restrooms/inventory"))).status).toBe(403);

    // 400 invalid query param
    expect(
      (await getInventoryRoute(new Request("http://localhost/api/v1/admin/restrooms/inventory?limit=999"))).status
    ).toBe(400);

    // 200 admin
    mockRequireRole.mockResolvedValue({ user: { id: "admin-1" }, role: "admin" });
    expect((await getStatsRoute()).status).toBe(200);
    expect((await getInventoryRoute(new Request("http://localhost/api/v1/admin/restrooms/inventory?page=1"))).status).toBe(200);

    // SSR guest -> 401 UI
    mockGetServerAuthSession.mockResolvedValueOnce({ user: null, isAdmin: false, configReady: true });
    const guestEl = await AdminRestroomInventoryPage();
    const { unmount } = render(guestEl);
    expect(screen.getByTestId("admin-inventory-unauthorized-401")).toBeDefined();
    unmount();

    // SSR customer -> 403 UI
    mockGetServerAuthSession.mockResolvedValueOnce({ user: { id: "u1" }, isAdmin: false, configReady: true });
    const custEl = await AdminRestroomInventoryPage();
    const { unmount: unmountCust } = render(custEl);
    expect(screen.getByTestId("admin-inventory-forbidden-403")).toBeDefined();
    unmountCust();
  });

  it("renders AdminRestroomInventoryClient stats, filters, pagination, and read-only detail modal", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/admin/restrooms/stats")) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            data: {
              totalCount: 2480,
              mapVisibleCount: 2477,
              hiddenCount: 3,
              partnerDiscoveryEnabled: true,
              byType: { public: 2476, partner: 4 },
              byPublicationStatus: { published: 2477, draft: 2, pending: 1, suspended: 0, archived: 0 },
              regionSummary: { seoulTotal: 1974, suwonTotal: 506, otherTotal: 0 },
              byRegion: [],
              bySeoulGu: [{ key: "seoul:강남구", label: "서울 강남구", total: 95, mapVisible: 95, publicCount: 95, partnerCount: 0 }],
              byDataSource: [
                { key: "seoul_oa22586", label: "서울시 공중화장실 위치정보 (OA-22586)", total: 1974 },
                { key: "suwon_15011425", label: "수원시 공중화장실 현황 (경기도 15011425 좌표)", total: 502 },
                { key: "partner", label: "제휴 매장 직접 등록", total: 4 },
              ],
              byVerificationStatus: {
                fieldVerified: 0,
                officialValidated: 1974,
                reviewRequired: 0,
                legacyUnset: 502,
                partnerDirect: 4,
              },
              generatedAt: "2026-11-25T00:00:00Z",
            },
          }),
        } as any;
      }
      if (url.includes("/api/v1/admin/restrooms/inventory")) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            data: {
              items: [
                {
                  id: "r-seoul-1",
                  name: "일원본동주민센터",
                  type: "public",
                  publication_status: "published",
                  road_address: "서울특별시 강남구 광평로 126",
                  address_detail: null,
                  region_key: "seoul:강남구",
                  region_label: "서울 강남구",
                  source_key: "seoul_oa22586",
                  source_label: "서울시 공중화장실 위치정보 (OA-22586)",
                  coordinate_source: "seoul_public_toilet_info",
                  coordinate_type: "facility_official",
                  coordinate_verification_status: "VERIFIED",
                  verification_category: "official_validated",
                  verification_label: "공식자료 검증",
                  is_map_visible: true,
                  business_id: null,
                  business_name: null,
                  last_verified_at: "2026-11-20T00:00:00Z",
                  created_at: "2026-11-25T00:00:00Z",
                  updated_at: "2026-11-25T00:00:00Z",
                },
              ],
              total: 120,
              page: 1,
              limit: 50,
              totalPages: 3,
            },
          }),
        } as any;
      }
      if (url.includes("/api/v1/admin/restrooms/r-seoul-1")) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            data: {
              id: "r-seoul-1",
              name: "일원본동주민센터",
              type: "public",
              publication_status: "published",
              road_address: "서울특별시 강남구 광평로 126",
              address_detail: "(지번) 서울특별시 강남구 일원동 735-3",
              latitude: 37.4833,
              longitude: 127.0864,
              description: "개방시간: 정시(09:00~18:00,평일)",
              coordinate_source: "seoul_public_toilet_info",
              coordinate_type: "facility_official",
              coordinate_verification_status: "VERIFIED",
              created_at: "2026-11-25T00:00:00Z",
              business: null,
            },
          }),
        } as any;
      }
      return { ok: false, json: async () => ({ ok: false }) } as any;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminRestroomInventoryClient />);

    await waitFor(() => {
      expect(screen.getByTestId("stat-total-count").textContent).toContain("2,480건");
      expect(screen.getByTestId("stat-map-visible-count").textContent).toContain("2,477건");
      expect(screen.getByTestId("inventory-item-r-seoul-1")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("inventory-item-r-seoul-1"));
    await waitFor(() => {
      expect(screen.getByTestId("inventory-detail-modal").textContent).toContain("관리자 상세 열람 (읽기 전용)");
      expect(screen.getByTestId("inventory-detail-modal").textContent).toContain("일원본동주민센터");
    });

    vi.unstubAllGlobals();
  });
});
