import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  catalogQuerySchema,
  listPublicRestrooms,
  getPublicRestroomDetail,
  getPublicBusinessDetail,
  type PublicRestroomSummary,
  type PublicRestroomDetail,
} from "@/lib/restrooms";
import { GET as restroomsGet } from "@/app/api/v1/restrooms/route";
import { GET as restroomDetailGet } from "@/app/api/v1/restrooms/[id]/route";
import { GET as publicBusinessGet } from "@/app/api/v1/businesses/[id]/route";
import * as authLib from "@/lib/auth";
import * as serverSupabase from "@/lib/supabase/server";

describe("TASK 10 — Catalog API Validation & Services", () => {
  const sampleBBox = "37.28,127.01,37.30,127.03";

  describe("1. Bounding Box & Query Schema Validation", () => {
    it("1.1 accepts valid bounding box and default query options", () => {
      const res = catalogQuerySchema.safeParse({
        bbox: sampleBBox,
      });
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.type).toBe("all");
        expect(res.data.limit).toBe(50);
        expect(res.data.offset).toBe(0);
      }
    });

    it("1.2 calculates offset correctly when page is provided", () => {
      const res = catalogQuerySchema.safeParse({
        bbox: sampleBBox,
        page: "3",
        limit: "20",
      });
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.limit).toBe(20);
        expect(res.data.offset).toBe(40); // (3 - 1) * 20
      }
    });

    it("1.3 rejects missing bbox parameter", () => {
      const res = catalogQuerySchema.safeParse({});
      expect(res.success).toBe(false);
    });

    it("1.4 rejects malformed bbox string with wrong number of elements", () => {
      const res = catalogQuerySchema.safeParse({
        bbox: "37.28,127.01,37.30",
      });
      expect(res.success).toBe(false);
    });

    it("1.5 rejects non-numeric bbox coordinates", () => {
      const res = catalogQuerySchema.safeParse({
        bbox: "37.28,abc,37.30,127.03",
      });
      expect(res.success).toBe(false);
    });

    it("1.6 rejects inverted coordinates (south > north or west > east)", () => {
      const invertedLat = catalogQuerySchema.safeParse({
        bbox: "37.30,127.01,37.28,127.03",
      });
      expect(invertedLat.success).toBe(false);

      const invertedLng = catalogQuerySchema.safeParse({
        bbox: "37.28,127.03,37.30,127.01",
      });
      expect(invertedLng.success).toBe(false);
    });

    it("1.7 rejects out-of-range latitude or longitude", () => {
      const outOfRange = catalogQuerySchema.safeParse({
        bbox: "-95,127.01,37.30,127.03",
      });
      expect(outOfRange.success).toBe(false);
    });

    it("1.8 rejects bounding box exceeding maximum span (1.0 degree ≈ 111km)", () => {
      const tooWide = catalogQuerySchema.safeParse({
        bbox: "36.00,127.00,37.50,127.50", // 1.5 deg lat span
      });
      expect(tooWide.success).toBe(false);
      if (!tooWide.success) {
        expect(tooWide.error.issues[0].message).toContain("너무 넓습니다");
      }
    });

    it("1.9 rejects limit exceeding 100 or less than 1", () => {
      const overLimit = catalogQuerySchema.safeParse({
        bbox: sampleBBox,
        limit: "150",
      });
      expect(overLimit.success).toBe(false);

      const zeroLimit = catalogQuerySchema.safeParse({
        bbox: sampleBBox,
        limit: "0",
      });
      expect(zeroLimit.success).toBe(false);
    });
  });

  describe("2. Mock Database & Catalog Services", () => {
    const bizApprovedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const bizSuspendedId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const bizDraftId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    const restroomPublicId = "11111111-1111-4111-8111-111111111111";
    const restroomPartnerApprovedId = "22222222-2222-4222-8222-222222222222";
    const restroomPartnerSuspendedId = "33333333-3333-4333-8333-333333333333";
    const restroomUnlocatedId = "44444444-4444-4444-8444-444444444444";
    const restroomDraftId = "55555555-5555-4555-8555-555555555555";

    const mockBusinesses = [
      {
        id: bizApprovedId,
        name: "행궁동 승인 카페",
        category: "카페",
        description: "전통 한옥 카페",
        road_address: "수원시 팔달구 신풍로 10",
        jibun_address: "신풍동 12",
        address_detail: "1층",
        latitude: 37.284,
        longitude: 127.015,
        phone: "031-123-4567",
        website_url: "https://cafe.example.com",
        registration_status: "approved",
      },
      {
        id: bizSuspendedId,
        name: "영업정지된 카페",
        category: "카페",
        description: "영업정지 가게",
        road_address: "수원시 팔달구 정조로 20",
        jibun_address: null,
        address_detail: null,
        latitude: 37.285,
        longitude: 127.016,
        phone: null,
        website_url: null,
        registration_status: "suspended",
      },
      {
        id: bizDraftId,
        name: "미승인 신청 점포",
        category: "음식점",
        description: "임시 점포",
        road_address: "수원시 팔달구 매산로 30",
        jibun_address: null,
        address_detail: null,
        latitude: 37.265,
        longitude: 127.02,
        phone: null,
        website_url: null,
        registration_status: "draft",
      },
    ];

    const mockRestrooms = [
      {
        id: restroomPublicId,
        type: "public",
        name: "수원화성 화홍문 공중화장실",
        description: "수원시 공영 개방 화장실",
        road_address: "수원시 팔달구 수원천로 374",
        address_detail: "화홍문 입구 우측",
        latitude: 37.287,
        longitude: 127.018,
        floor: "1층",
        entrance_instructions: "공원 산책로 연결",
        gender_type: "separate",
        wheelchair_accessible: true,
        baby_changing_available: true,
        sanitary_products_available: false,
        access_method: "open",
        publication_status: "published",
        last_verified_at: "2026-11-01T00:00:00Z",
        business_id: null,
        created_at: "2026-11-01T00:00:00Z",
        updated_at: "2026-11-01T00:00:00Z",
      },
      {
        id: restroomPartnerApprovedId,
        type: "partner",
        name: "행궁동 카페 제휴 화장실",
        description: "카페 이용자 및 제휴 방문객 전용",
        road_address: "수원시 팔달구 신풍로 10",
        address_detail: "카페 내부",
        latitude: 37.284,
        longitude: 127.015,
        floor: "1층",
        entrance_instructions: "카운터 좌측 통로",
        gender_type: "unisex",
        wheelchair_accessible: false,
        baby_changing_available: null,
        sanitary_products_available: true,
        access_method: "pin",
        publication_status: "published",
        last_verified_at: "2026-11-05T00:00:00Z",
        business_id: bizApprovedId,
        created_at: "2026-11-05T00:00:00Z",
        updated_at: "2026-11-05T00:00:00Z",
      },
      {
        id: restroomPartnerSuspendedId,
        type: "partner",
        name: "영업정지 가게 화장실",
        description: "영업정지된 가게의 화장실",
        road_address: "수원시 팔달구 정조로 20",
        address_detail: null,
        latitude: 37.285,
        longitude: 127.016,
        floor: "1층",
        entrance_instructions: null,
        gender_type: "unknown",
        wheelchair_accessible: null,
        baby_changing_available: null,
        sanitary_products_available: null,
        access_method: "pin",
        publication_status: "published", // Published, but business is suspended!
        last_verified_at: null,
        business_id: bizSuspendedId,
        created_at: "2026-11-05T00:00:00Z",
        updated_at: "2026-11-05T00:00:00Z",
      },
      {
        id: restroomUnlocatedId,
        type: "partner",
        name: "좌표 미확인 화장실",
        description: "좌표가 없는 임시 화장실",
        road_address: "수원시 팔달구 주소미정",
        address_detail: null,
        latitude: null, // Null coords
        longitude: null,
        floor: null,
        entrance_instructions: null,
        gender_type: "unknown",
        wheelchair_accessible: null,
        baby_changing_available: null,
        sanitary_products_available: null,
        access_method: "open",
        publication_status: "draft",
        last_verified_at: null,
        business_id: bizApprovedId,
        created_at: "2026-11-05T00:00:00Z",
        updated_at: "2026-11-05T00:00:00Z",
      },
      {
        id: restroomDraftId,
        type: "public",
        name: "등록 대기 공공화장실",
        description: "아직 공개되지 않은 화장실",
        road_address: "수원시 팔달구 대기로 1",
        address_detail: null,
        latitude: 37.286,
        longitude: 127.017,
        floor: null,
        entrance_instructions: null,
        gender_type: "separate",
        wheelchair_accessible: true,
        baby_changing_available: null,
        sanitary_products_available: null,
        access_method: "open",
        publication_status: "draft",
        last_verified_at: null,
        business_id: null,
        created_at: "2026-11-05T00:00:00Z",
        updated_at: "2026-11-05T00:00:00Z",
      },
    ];

    const mockHours = [
      {
        id: "h1",
        restroom_id: restroomPublicId,
        weekday: 1,
        opens_at: "06:00:00",
        closes_at: "23:00:00",
        is_closed: false,
        crosses_midnight: false,
      },
      {
        id: "h2",
        restroom_id: restroomPublicId,
        weekday: 0,
        opens_at: "06:00:00",
        closes_at: "23:00:00",
        is_closed: false,
        crosses_midnight: false,
      },
    ];

    const mockExceptions = [
      {
        id: "e1",
        restroom_id: restroomPublicId,
        exception_date: "2026-12-25",
        is_closed: true,
        opens_at: null,
        closes_at: null,
        reason: "성탄절 시설 정기 점검",
      },
    ];

    const mockPolicies = [
      {
        id: "p1",
        restroom_id: restroomPublicId,
        version: 1,
        access_mode: "free",
        deposit_amount_krw: 0,
        refund_eligible: false,
        receipt_window_hours: null,
        min_purchase_krw: null,
        is_active: true,
        effective_from: "2026-11-01T00:00:00Z",
      },
      {
        id: "p2",
        restroom_id: restroomPartnerApprovedId,
        version: 1,
        access_mode: "test_deposit",
        deposit_amount_krw: 1000,
        refund_eligible: true,
        receipt_window_hours: 24,
        min_purchase_krw: 0,
        is_active: true, // Active policy
        effective_from: "2026-11-05T00:00:00Z",
      },
      {
        id: "p3_inactive",
        restroom_id: restroomPartnerApprovedId,
        version: 2,
        access_mode: "test_deposit",
        deposit_amount_krw: 2000,
        refund_eligible: true,
        receipt_window_hours: 12,
        min_purchase_krw: 500,
        is_active: false, // Inactive policy
        effective_from: "2026-12-01T00:00:00Z",
      },
    ];

    const mockPhotos = [
      {
        id: "ph1_approved_primary",
        restroom_id: restroomPublicId,
        storage_path: "photos/public_exterior.jpg",
        photo_type: "exterior",
        is_primary: true,
        moderation_status: "approved",
      },
      {
        id: "ph2_pending",
        restroom_id: restroomPublicId,
        storage_path: "photos/public_interior_pending.jpg",
        photo_type: "interior",
        is_primary: false,
        moderation_status: "pending", // Unmoderated photo!
      },
      {
        id: "ph3_partner_primary",
        restroom_id: restroomPartnerApprovedId,
        storage_path: "photos/cafe_entrance.jpg",
        photo_type: "entrance",
        is_primary: true,
        moderation_status: "approved",
      },
    ];

    function createMockSupabase(overrides?: {
      restrooms?: typeof mockRestrooms;
      businesses?: typeof mockBusinesses;
    }) {
      const currentRestrooms = overrides?.restrooms ?? mockRestrooms;
      const currentBusinesses = overrides?.businesses ?? mockBusinesses;

      return {
        from: vi.fn((table: string) => {
          if (table === "restrooms") {
            let filterPubStatus: string | null = null;
            let filterGteLat: number | null = null;
            let filterLteLat: number | null = null;
            let filterGteLng: number | null = null;
            let filterLteLng: number | null = null;
            let filterType: string | null = null;
            let filterId: string | null = null;
            let notNullCoords = false;

            const chain: any = {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn((col: string, val: any) => {
                if (col === "publication_status") filterPubStatus = val;
                if (col === "type") filterType = val;
                if (col === "id") filterId = val;
                return chain;
              }),
              gte: vi.fn((col: string, val: number) => {
                if (col === "latitude") filterGteLat = val;
                if (col === "longitude") filterGteLng = val;
                return chain;
              }),
              lte: vi.fn((col: string, val: number) => {
                if (col === "latitude") filterLteLat = val;
                if (col === "longitude") filterLteLng = val;
                return chain;
              }),
              not: vi.fn((col: string, op: string, val: any) => {
                if ((col === "latitude" || col === "longitude") && op === "is" && val === null) {
                  notNullCoords = true;
                }
                return chain;
              }),
              order: vi.fn().mockReturnThis(),
              range: vi.fn((start: number, end: number) => {
                let filtered = currentRestrooms.filter((r) => {
                  if (filterPubStatus && r.publication_status !== filterPubStatus) return false;
                  if (filterType && r.type !== filterType) return false;
                  if (filterId && r.id !== filterId) return false;
                  if (notNullCoords && (r.latitude === null || r.longitude === null)) return false;
                  if (r.latitude !== null && filterGteLat !== null && r.latitude < filterGteLat) return false;
                  if (r.latitude !== null && filterLteLat !== null && r.latitude > filterLteLat) return false;
                  if (r.longitude !== null && filterGteLng !== null && r.longitude < filterGteLng) return false;
                  if (r.longitude !== null && filterLteLng !== null && r.longitude > filterLteLng) return false;
                  return true;
                });
                const sliced = filtered.slice(start, end + 1);
                return Promise.resolve({
                  data: sliced,
                  count: filtered.length,
                  error: null,
                });
              }),
              maybeSingle: vi.fn(() => {
                const found = currentRestrooms.find((r) => {
                  if (filterId && r.id !== filterId) return false;
                  if (filterPubStatus && r.publication_status !== filterPubStatus) return false;
                  return true;
                });
                return Promise.resolve({ data: found ?? null, error: null });
              }),
            };
            return chain;
          }

          if (table === "businesses") {
            let filterId: string | null = null;
            let filterInIds: string[] | null = null;
            let filterStatus: string | null = null;

            const chain: any = {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn((col: string, val: any) => {
                if (col === "id") filterId = val;
                if (col === "registration_status") filterStatus = val;
                return chain;
              }),
              in: vi.fn((col: string, vals: string[]) => {
                if (col === "id") filterInIds = vals;
                return chain;
              }),
              maybeSingle: vi.fn(() => {
                const found = currentBusinesses.find((b) => {
                  if (filterId && b.id !== filterId) return false;
                  if (filterStatus && b.registration_status !== filterStatus) return false;
                  return true;
                });
                return Promise.resolve({ data: found ?? null, error: null });
              }),
              then: (resolve: any) => {
                let filtered = currentBusinesses.filter((b) => {
                  if (filterInIds && !filterInIds.includes(b.id)) return false;
                  if (filterStatus && b.registration_status !== filterStatus) return false;
                  return true;
                });
                return Promise.resolve({ data: filtered, error: null }).then(resolve);
              },
            };
            return chain;
          }

          if (table === "restroom_access_policies") {
            let filterRestroomId: string | null = null;
            let filterInIds: string[] | null = null;
            let filterIsActive: boolean | null = null;

            const chain: any = {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn((col: string, val: any) => {
                if (col === "restroom_id") filterRestroomId = val;
                if (col === "is_active") filterIsActive = val;
                return chain;
              }),
              in: vi.fn((col: string, vals: string[]) => {
                if (col === "restroom_id") filterInIds = vals;
                return chain;
              }),
              maybeSingle: vi.fn(() => {
                const found = mockPolicies.find((p) => {
                  if (filterRestroomId && p.restroom_id !== filterRestroomId) return false;
                  if (filterIsActive !== null && p.is_active !== filterIsActive) return false;
                  return true;
                });
                return Promise.resolve({ data: found ?? null, error: null });
              }),
              then: (resolve: any) => {
                const filtered = mockPolicies.filter((p) => {
                  if (filterInIds && !filterInIds.includes(p.restroom_id)) return false;
                  if (filterIsActive !== null && p.is_active !== filterIsActive) return false;
                  return true;
                });
                return Promise.resolve({ data: filtered, error: null }).then(resolve);
              },
            };
            return chain;
          }

          if (table === "restroom_photos") {
            let filterRestroomId: string | null = null;
            let filterInIds: string[] | null = null;
            let filterStatus: string | null = null;
            let filterIsPrimary: boolean | null = null;

            const chain: any = {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn((col: string, val: any) => {
                if (col === "restroom_id") filterRestroomId = val;
                if (col === "moderation_status") filterStatus = val;
                if (col === "is_primary") filterIsPrimary = val;
                return chain;
              }),
              in: vi.fn((col: string, vals: string[]) => {
                if (col === "restroom_id") filterInIds = vals;
                return chain;
              }),
              order: vi.fn().mockReturnThis(),
              then: (resolve: any) => {
                const filtered = mockPhotos.filter((ph) => {
                  if (filterRestroomId && ph.restroom_id !== filterRestroomId) return false;
                  if (filterInIds && !filterInIds.includes(ph.restroom_id)) return false;
                  if (filterStatus && ph.moderation_status !== filterStatus) return false;
                  if (filterIsPrimary !== null && ph.is_primary !== filterIsPrimary) return false;
                  return true;
                });
                return Promise.resolve({ data: filtered, error: null }).then(resolve);
              },
            };
            return chain;
          }

          if (table === "restroom_hours") {
            let filterRestroomId: string | null = null;
            const chain: any = {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn((col: string, val: any) => {
                if (col === "restroom_id") filterRestroomId = val;
                return chain;
              }),
              order: vi.fn().mockReturnThis(),
              then: (resolve: any) => {
                const filtered = mockHours.filter((h) => {
                  if (filterRestroomId && h.restroom_id !== filterRestroomId) return false;
                  return true;
                });
                return Promise.resolve({ data: filtered, error: null }).then(resolve);
              },
            };
            return chain;
          }

          if (table === "restroom_hour_exceptions") {
            let filterRestroomId: string | null = null;
            const chain: any = {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn((col: string, val: any) => {
                if (col === "restroom_id") filterRestroomId = val;
                return chain;
              }),
              order: vi.fn().mockReturnThis(),
              then: (resolve: any) => {
                const filtered = mockExceptions.filter((e) => {
                  if (filterRestroomId && e.restroom_id !== filterRestroomId) return false;
                  return true;
                });
                return Promise.resolve({ data: filtered, error: null }).then(resolve);
              },
            };
            return chain;
          }

          return {} as any;
        }),
      } as any;
    }

    it("2.1 listPublicRestrooms returns only published, non-suspended partner & public restrooms", async () => {
      const client = createMockSupabase();
      const res = await listPublicRestrooms(client, {
        bbox: sampleBBox,
        type: "all",
        limit: 50,
        offset: 0,
      });

      expect(res.items).toHaveLength(2);
      const ids = res.items.map((i) => i.id);
      expect(ids).toContain(restroomPublicId);
      expect(ids).toContain(restroomPartnerApprovedId);
      // Excluded:
      expect(ids).not.toContain(restroomPartnerSuspendedId); // Suspended business
      expect(ids).not.toContain(restroomUnlocatedId); // Null coords
      expect(ids).not.toContain(restroomDraftId); // Draft
    });

    it("2.2 listPublicRestrooms filters by type (public only vs partner only)", async () => {
      const client = createMockSupabase();
      const publicOnly = await listPublicRestrooms(client, {
        bbox: sampleBBox,
        type: "public",
        limit: 50,
        offset: 0,
      });
      expect(publicOnly.items).toHaveLength(1);
      expect(publicOnly.items[0].id).toBe(restroomPublicId);

      const partnerOnly = await listPublicRestrooms(client, {
        bbox: sampleBBox,
        type: "partner",
        limit: 50,
        offset: 0,
      });
      expect(partnerOnly.items).toHaveLength(1);
      expect(partnerOnly.items[0].id).toBe(restroomPartnerApprovedId);
      expect(partnerOnly.items[0].business_name).toBe("행궁동 승인 카페");
    });

    it("2.3 listPublicRestrooms returns empty array when no restrooms match", async () => {
      const client = createMockSupabase({ restrooms: [] });
      const res = await listPublicRestrooms(client, {
        bbox: sampleBBox,
        type: "all",
        limit: 50,
        offset: 0,
      });
      expect(res.items).toEqual([]);
      expect(res.total).toBe(0);
    });

    it("2.4 getPublicRestroomDetail returns full detail without sensitive fields (NO PIN)", async () => {
      const client = createMockSupabase();
      const detail = await getPublicRestroomDetail(client, restroomPublicId);

      expect(detail).not.toBeNull();
      expect(detail?.id).toBe(restroomPublicId);
      expect(detail?.name).toBe("수원화성 화홍문 공중화장실");
      expect(detail?.hours).toHaveLength(2);
      expect(detail?.hour_exceptions).toHaveLength(1);
      expect(detail?.active_policy?.access_mode).toBe("free");

      // Only approved photos included
      expect(detail?.photos).toHaveLength(1);
      expect(detail?.photos[0].storage_path).toBe("photos/public_exterior.jpg");

      // Verify NO PIN in returned detail object
      expect((detail as any).pin).toBeUndefined();
      expect((detail as any).encrypted_pin).toBeUndefined();
    });

    it("2.5 getPublicRestroomDetail returns approved business info for partner restroom", async () => {
      const client = createMockSupabase();
      const detail = await getPublicRestroomDetail(client, restroomPartnerApprovedId);

      expect(detail).not.toBeNull();
      expect(detail?.business).not.toBeNull();
      expect(detail?.business?.name).toBe("행궁동 승인 카페");
      expect(detail?.business?.phone).toBe("031-123-4567");

      // Active policy returned (p2: 1000 KRW), inactive policy (p3: 2000 KRW) excluded
      expect(detail?.active_policy?.deposit_amount_krw).toBe(1000);
      expect(detail?.active_policy?.version).toBe(1);

      // Verify NO private business registration number or verification notes
      expect((detail?.business as any)?.registration_number).toBeUndefined();
      expect((detail?.business as any)?.review_notes).toBeUndefined();
    });

    it("2.6 getPublicRestroomDetail returns null for partner restroom with suspended business", async () => {
      const client = createMockSupabase();
      const detail = await getPublicRestroomDetail(client, restroomPartnerSuspendedId);
      expect(detail).toBeNull();
    });

    it("2.7 getPublicRestroomDetail returns null for draft/non-existent restroom", async () => {
      const client = createMockSupabase();
      const draftDetail = await getPublicRestroomDetail(client, restroomDraftId);
      expect(draftDetail).toBeNull();

      const nonExistent = await getPublicRestroomDetail(
        client,
        "99999999-9999-4999-8999-999999999999"
      );
      expect(nonExistent).toBeNull();
    });

    it("2.8 getPublicBusinessDetail returns approved business and hides draft/suspended businesses", async () => {
      const client = createMockSupabase();
      const approvedBiz = await getPublicBusinessDetail(client, bizApprovedId);
      expect(approvedBiz).not.toBeNull();
      expect(approvedBiz?.name).toBe("행궁동 승인 카페");
      expect((approvedBiz as any)?.registration_number).toBeUndefined();

      const suspendedBiz = await getPublicBusinessDetail(client, bizSuspendedId);
      expect(suspendedBiz).toBeNull();

      const draftBiz = await getPublicBusinessDetail(client, bizDraftId);
      expect(draftBiz).toBeNull();
    });
  });

  describe("3. HTTP Route Handlers Integration", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
      vi.spyOn(authLib, "isSupabaseAuthConfigured").mockReturnValue(true);
    });

    it("3.1 GET /api/v1/restrooms returns 200 with catalog data on valid bbox", async () => {
      const mockClient = {
        from: vi.fn((table: string) => {
          if (table === "restrooms") {
            const chain: any = {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              gte: vi.fn().mockReturnThis(),
              lte: vi.fn().mockReturnThis(),
              not: vi.fn().mockReturnThis(),
              order: vi.fn().mockReturnThis(),
              range: vi.fn().mockResolvedValue({
                data: [
                  {
                    id: "11111111-1111-4111-8111-111111111111",
                    type: "public",
                    name: "공중 화장실",
                    road_address: "수원천로 1",
                    address_detail: null,
                    latitude: 37.287,
                    longitude: 127.018,
                    access_method: "open",
                    gender_type: "unisex",
                    wheelchair_accessible: true,
                    baby_changing_available: false,
                    sanitary_products_available: false,
                    last_verified_at: "2026-11-01T00:00:00Z",
                    business_id: null,
                  },
                ],
                count: 1,
                error: null,
              }),
            };
            return chain;
          }
          const chain: any = {
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            then: (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve),
          };
          return chain;
        }),
      };
      vi.spyOn(serverSupabase, "createServerClientInstance").mockResolvedValue(
        mockClient as any
      );

      const req = new Request(
        `http://localhost/api/v1/restrooms?bbox=${encodeURIComponent(sampleBBox)}`
      );
      const res = await restroomsGet(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.items).toBeDefined();
      expect(json.data.items.length).toBeGreaterThan(0);
      expect(json.data.total).toBeDefined();
      expect(json.requestId).toBeDefined();
    });

    it("3.2 GET /api/v1/restrooms returns 400 on invalid bbox parameter", async () => {
      const req = new Request("http://localhost/api/v1/restrooms?bbox=invalid");
      const res = await restroomsGet(req);
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe("VALIDATION_ERROR");
    });

    it("3.3 GET /api/v1/restrooms/[id] returns 400 on malformed UUID", async () => {
      const req = new Request("http://localhost/api/v1/restrooms/not-a-uuid");
      const res = await restroomDetailGet(req, {
        params: Promise.resolve({ id: "not-a-uuid" }),
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe("VALIDATION_ERROR");
    });

    it("3.4 GET /api/v1/restrooms/[id] returns 404 when restroom not found", async () => {
      const mockClient = {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        })),
      };
      vi.spyOn(serverSupabase, "createServerClientInstance").mockResolvedValue(
        mockClient as any
      );

      const req = new Request(
        "http://localhost/api/v1/restrooms/11111111-1111-4111-8111-111111111111"
      );
      const res = await restroomDetailGet(req, {
        params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }),
      });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe("RESTROOM_NOT_FOUND");
    });

    it("3.5 GET /api/v1/businesses/[id] returns 200 for approved business and 404 for unapproved", async () => {
      const approvedBizId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const unapprovedBizId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

      const mockClient = {
        from: vi.fn((table: string) => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn((col: string, val: string) => ({
            eq: vi.fn((col2: string, val2: string) => ({
              maybeSingle: vi.fn().mockImplementation(() => {
                if (val === approvedBizId && val2 === "approved") {
                  return Promise.resolve({
                    data: {
                      id: approvedBizId,
                      name: "승인 점포",
                      category: "카페",
                      description: "설명",
                      road_address: "주소",
                      jibun_address: null,
                      address_detail: null,
                      latitude: 37.28,
                      longitude: 127.01,
                      phone: "010-0000-0000",
                      website_url: null,
                    },
                    error: null,
                  });
                }
                return Promise.resolve({ data: null, error: null });
              }),
            })),
          })),
        })),
      };

      vi.spyOn(serverSupabase, "createServerClientInstance").mockResolvedValue(
        mockClient as any
      );

      // 1) Approved business returns 200
      const reqApproved = new Request(
        `http://localhost/api/v1/businesses/${approvedBizId}`
      );
      const resApproved = await publicBusinessGet(reqApproved, {
        params: Promise.resolve({ id: approvedBizId }),
      });
      expect(resApproved.status).toBe(200);
      const jsonApproved = await resApproved.json();
      expect(jsonApproved.ok).toBe(true);
      expect(jsonApproved.data.name).toBe("승인 점포");

      // 2) Unapproved/suspended business returns 404
      const reqUnapproved = new Request(
        `http://localhost/api/v1/businesses/${unapprovedBizId}`
      );
      const resUnapproved = await publicBusinessGet(reqUnapproved, {
        params: Promise.resolve({ id: unapprovedBizId }),
      });
      expect(resUnapproved.status).toBe(404);
      const jsonUnapproved = await resUnapproved.json();
      expect(jsonUnapproved.error.code).toBe("BUSINESS_NOT_FOUND");
    });
  });
});
