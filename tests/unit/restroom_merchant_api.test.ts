import { describe, expect, it, vi, beforeEach, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  createMerchantRestroomSchema,
  updateMerchantRestroomSchema,
  createMerchantPolicySchema,
  createMerchantRestroom,
  updateMerchantRestroom,
  submitRestroomForReview,
  createMerchantRestroomPolicy,
  listMerchantRestrooms,
  getMerchantRestroomDetail,
  MerchantRestroomError,
} from "@/lib/restrooms";
import { GET as merchantRestroomsGet, POST as merchantRestroomsPost } from "@/app/api/v1/merchant/restrooms/route";
import { GET as merchantRestroomDetailGet, PATCH as merchantRestroomPatch } from "@/app/api/v1/merchant/restrooms/[id]/route";
import { POST as merchantRestroomSubmitPost } from "@/app/api/v1/merchant/restrooms/[id]/submit/route";
import { POST as merchantRestroomPolicyPost } from "@/app/api/v1/merchant/restrooms/[id]/policies/route";
import * as authLib from "@/lib/auth";
import * as serverSupabase from "@/lib/supabase/server";

describe("TASK 12 — Merchant Restroom Management API", () => {
  const merchantOwnerId = "11111111-1111-4111-8111-111111111111";
  const otherMerchantId = "22222222-2222-4222-8222-222222222222";
  const customerUserId = "33333333-3333-4333-8333-333333333333";
  const revokedUserId = "44444444-4444-4444-8444-444444444444";

  const approvedBizId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const otherBizId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const pendingBizId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const suspendedBizId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  const partnerRestroomId = "99999999-9999-4999-8999-999999999999";
  const publicRestroomId = "88888888-8888-4888-8888-888888888888";

  // In-memory mock database state
  let businesses: any[] = [];
  let businessMembers: any[] = [];
  let restrooms: any[] = [];
  let policies: any[] = [];
  let hours: any[] = [];
  let photos: any[] = [];

  function resetState() {
    businesses = [
      {
        id: approvedBizId,
        name: "행궁동 카페",
        registration_status: "approved",
      },
      {
        id: otherBizId,
        name: "타 가게 카페",
        registration_status: "approved",
      },
      {
        id: pendingBizId,
        name: "심사 대기 가게",
        registration_status: "pending",
      },
      {
        id: suspendedBizId,
        name: "영업정지 가게",
        registration_status: "suspended",
      },
    ];

    businessMembers = [
      {
        business_id: approvedBizId,
        user_id: merchantOwnerId,
        role: "owner",
        membership_status: "active",
      },
      {
        business_id: otherBizId,
        user_id: otherMerchantId,
        role: "owner",
        membership_status: "active",
      },
      {
        business_id: approvedBizId,
        user_id: revokedUserId,
        role: "manager",
        membership_status: "revoked", // Revoked membership
      },
    ];

    restrooms = [
      {
        id: partnerRestroomId,
        business_id: approvedBizId,
        type: "partner",
        source_id: null,
        name: "카페 제휴 화장실",
        description: "1층 고객 전용 화장실",
        road_address: "수원시 팔달구 신풍로 10",
        address_detail: "1층 카운터 옆",
        latitude: 37.284,
        longitude: 127.015,
        floor: "1층",
        entrance_instructions: null,
        gender_type: "unisex",
        wheelchair_accessible: false,
        baby_changing_available: false,
        sanitary_products_available: true,
        access_method: "pin",
        publication_status: "draft",
        approved_by: null,
        last_verified_at: null,
        created_by: merchantOwnerId,
        created_at: "2026-11-10T00:00:00Z",
        updated_at: "2026-11-10T00:00:00Z",
      },
      {
        id: publicRestroomId,
        business_id: null,
        type: "public",
        source_id: "src-01",
        name: "화홍문 공중화장실",
        description: null,
        road_address: "수원시 팔달구 수원천로 374",
        address_detail: null,
        latitude: 37.287,
        longitude: 127.018,
        floor: null,
        entrance_instructions: null,
        gender_type: "separate",
        wheelchair_accessible: true,
        baby_changing_available: true,
        sanitary_products_available: false,
        access_method: "open",
        publication_status: "published",
        approved_by: null,
        last_verified_at: "2026-11-01T00:00:00Z",
        created_by: null,
        created_at: "2026-11-01T00:00:00Z",
        updated_at: "2026-11-01T00:00:00Z",
      },
    ];

    policies = [
      {
        id: "pol-1",
        restroom_id: partnerRestroomId,
        version: 1,
        access_mode: "test_deposit",
        deposit_amount_krw: 1000,
        refund_eligible: true,
        receipt_window_hours: 24,
        min_purchase_krw: 0,
        is_active: true,
        effective_from: "2026-11-10T00:00:00Z",
        created_by: merchantOwnerId,
      },
    ];

    hours = [];
    photos = [];
  }

  function createMockSupabase() {
    return {
      from: vi.fn((table: string) => {
        if (table === "businesses") {
          let fId: string | null = null;
          const chain: any = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn((col: string, val: string) => {
              if (col === "id") fId = val;
              return chain;
            }),
            maybeSingle: vi.fn(() => {
              const b = businesses.find((item) => item.id === fId);
              return Promise.resolve({ data: b ?? null, error: null });
            }),
          };
          return chain;
        }

        if (table === "business_members") {
          let fBizId: string | null = null;
          let fUserId: string | null = null;
          const chain: any = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn((col: string, val: string) => {
              if (col === "business_id") fBizId = val;
              if (col === "user_id") fUserId = val;
              return chain;
            }),
            maybeSingle: vi.fn(() => {
              const m = businessMembers.find(
                (item) => item.business_id === fBizId && item.user_id === fUserId
              );
              return Promise.resolve({ data: m ?? null, error: null });
            }),
          };
          return chain;
        }

        if (table === "restrooms") {
          let fId: string | null = null;
          let fBizId: string | null = null;

          const chain: any = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn((col: string, val: string) => {
              if (col === "id") fId = val;
              if (col === "business_id") fBizId = val;
              return chain;
            }),
            order: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn(() => {
              const r = restrooms.find((item) => item.id === fId);
              return Promise.resolve({ data: r ?? null, error: null });
            }),
            single: vi.fn(() => {
              const r = restrooms.find((item) => item.id === fId);
              return Promise.resolve({ data: r ?? null, error: r ? null : new Error("Not found") });
            }),
            then: (resolve: any) => {
              let res = restrooms;
              if (fBizId) res = res.filter((r) => r.business_id === fBizId);
              return Promise.resolve({ data: res, error: null }).then(resolve);
            },
            insert: vi.fn((row: any) => {
              const newRecord = {
                id: `new-restroom-${restrooms.length + 1}`,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                ...row,
              };
              restrooms.push(newRecord);
              return {
                select: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: newRecord, error: null }),
                }),
              };
            }),
            update: vi.fn((patch: any) => ({
              eq: vi.fn((col: string, val: string) => {
                const target = restrooms.find((r) => r.id === val);
                if (target) Object.assign(target, patch);
                return {
                  select: vi.fn().mockReturnValue({
                    single: vi.fn().mockResolvedValue({ data: target, error: null }),
                  }),
                };
              }),
            })),
          };
          return chain;
        }

        if (table === "restroom_access_policies") {
          let fRestroomId: string | null = null;
          let fIsActive: boolean | null = null;

          const chain: any = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn((col: string, val: any) => {
              if (col === "restroom_id") fRestroomId = val;
              if (col === "is_active") fIsActive = val;
              return chain;
            }),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            then: (resolve: any) => {
              let res = policies.filter((p) => p.restroom_id === fRestroomId);
              if (fIsActive !== null) res = res.filter((p) => p.is_active === fIsActive);
              return Promise.resolve({ data: res, error: null }).then(resolve);
            },
            insert: vi.fn((row: any) => {
              const newPol = { id: `pol-${policies.length + 1}`, ...row };
              policies.push(newPol);
              return {
                select: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: newPol, error: null }),
                }),
              };
            }),
            update: vi.fn((patch: any) => ({
              eq: vi.fn((col: string, val: any) => ({
                eq: vi.fn((col2: string, val2: any) => {
                  policies.forEach((p) => {
                    if (p.restroom_id === val && p.is_active === val2) {
                      Object.assign(p, patch);
                    }
                  });
                  return Promise.resolve({ data: null, error: null });
                }),
              })),
            })),
          };
          return chain;
        }

        if (table === "restroom_hours" || table === "restroom_photos") {
          const chain: any = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            then: (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve),
          };
          return chain;
        }

        return {} as any;
      }),
    } as any;
  }

  beforeEach(() => {
    resetState();
    vi.restoreAllMocks();
    vi.spyOn(authLib, "isSupabaseAuthConfigured").mockReturnValue(true);
    vi.spyOn(serverSupabase, "createServerClientInstance").mockImplementation(() =>
      Promise.resolve(createMockSupabase())
    );
    authLib.clearIdempotencyStoreForTests();
  });

  // ==========================================================================
  // 1. Zod Validation Schemas
  // ==========================================================================
  describe("1. Validation Schemas", () => {
    it("1.1 validates correct partner restroom creation payload", () => {
      const res = createMerchantRestroomSchema.safeParse({
        business_id: approvedBizId,
        name: "테스트 제휴 화장실",
        road_address: "수원시 팔달구 신풍로 12",
        latitude: 37.284,
        longitude: 127.015,
        access_method: "pin",
      });
      expect(res.success).toBe(true);
    });

    it("1.2 rejects extra unauthorized fields in creation payload (strict)", () => {
      const res = createMerchantRestroomSchema.safeParse({
        business_id: approvedBizId,
        name: "화장실",
        road_address: "수원시",
        latitude: 37.28,
        longitude: 127.01,
        publication_status: "published", // Forbidden
        approved_by: "hacker", // Forbidden
      });
      expect(res.success).toBe(false);
    });

    it("1.3 rejects invalid latitude or longitude", () => {
      const res = createMerchantRestroomSchema.safeParse({
        business_id: approvedBizId,
        name: "화장실",
        road_address: "수원시",
        latitude: 95.0, // Out of range
        longitude: 127.01,
      });
      expect(res.success).toBe(false);
    });

    it("1.4 validates policy schema and rejects negative deposit", () => {
      const res = createMerchantPolicySchema.safeParse({
        access_mode: "test_deposit",
        deposit_amount_krw: -500, // Invalid
      });
      expect(res.success).toBe(false);
    });
  });

  // ==========================================================================
  // 2. Merchant Services & Business Membership Guards
  // ==========================================================================
  describe("2. Merchant Services & Permission Guards", () => {
    it("2.1 allows approved business owner to register a draft restroom", async () => {
      const client = createMockSupabase();
      const created = await createMerchantRestroom(client, merchantOwnerId, {
        business_id: approvedBizId,
        name: "신규 제휴 화장실",
        road_address: "수원시 팔달구 신풍로 20",
        latitude: 37.285,
        longitude: 127.016,
        access_method: "pin",
        gender_type: "unisex",
      });

      expect(created).toBeDefined();
      expect(created.type).toBe("partner");
      expect(created.publication_status).toBe("draft"); // Strictly draft!
      expect(created.business_id).toBe(approvedBizId);

      // Verify default policy v1 created
      expect(policies.length).toBeGreaterThan(1);
      const newPol = policies.find((p) => p.restroom_id === created.id);
      expect(newPol).toBeDefined();
      expect(newPol?.version).toBe(1);
    });

    it("2.2 rejects registration for non-member user (403)", async () => {
      const client = createMockSupabase();
      await expect(
        createMerchantRestroom(client, customerUserId, {
          business_id: approvedBizId,
          name: "무단 등록 시도",
          road_address: "수원시",
          latitude: 37.28,
          longitude: 127.01,
          access_method: "open",
          gender_type: "unisex",
        })
      ).rejects.toThrowError(MerchantRestroomError);
    });

    it("2.3 rejects registration for revoked member (403)", async () => {
      const client = createMockSupabase();
      await expect(
        createMerchantRestroom(client, revokedUserId, {
          business_id: approvedBizId,
          name: "탈퇴 멤버 등록 시도",
          road_address: "수원시",
          latitude: 37.28,
          longitude: 127.01,
          access_method: "open",
          gender_type: "unisex",
        })
      ).rejects.toThrowError(MerchantRestroomError);
    });

    it("2.4 rejects registration for pending/unapproved business (403)", async () => {
      const client = createMockSupabase();
      // Add member to pending business
      businessMembers.push({
        business_id: pendingBizId,
        user_id: merchantOwnerId,
        role: "owner",
        membership_status: "active",
      });

      await expect(
        createMerchantRestroom(client, merchantOwnerId, {
          business_id: pendingBizId,
          name: "미승인 가게 화장실",
          road_address: "수원시",
          latitude: 37.28,
          longitude: 127.01,
          access_method: "open",
          gender_type: "unisex",
        })
      ).rejects.toThrow(/승인된 가게만/);
    });

    it("2.5 rejects registration for suspended business (403)", async () => {
      const client = createMockSupabase();
      businessMembers.push({
        business_id: suspendedBizId,
        user_id: merchantOwnerId,
        role: "owner",
        membership_status: "active",
      });

      await expect(
        createMerchantRestroom(client, merchantOwnerId, {
          business_id: suspendedBizId,
          name: "영업정지 가게 화장실",
          road_address: "수원시",
          latitude: 37.28,
          longitude: 127.01,
          access_method: "open",
          gender_type: "unisex",
        })
      ).rejects.toThrow(/승인된 가게만/);
    });

    it("2.6 prevents merchant from modifying public restroom (403)", async () => {
      const client = createMockSupabase();
      await expect(
        updateMerchantRestroom(client, merchantOwnerId, publicRestroomId, {
          name: "공공화장실 변조 시도",
        })
      ).rejects.toThrow(/공공 화장실은 점주 API를 통해 수정하거나 조작할 수 없습니다/);
    });

    it("2.7 prevents merchant from modifying another business's restroom (403)", async () => {
      const client = createMockSupabase();
      // otherMerchant owns otherBiz, trying to update approvedBiz's partnerRestroomId
      await expect(
        updateMerchantRestroom(client, otherMerchantId, partnerRestroomId, {
          name: "타 가게 화장실 수정 시도",
        })
      ).rejects.toThrow(MerchantRestroomError);
    });

    it("2.8 prevents location modification when restroom is already published (422)", async () => {
      const client = createMockSupabase();
      const target = restrooms.find((r) => r.id === partnerRestroomId);
      target.publication_status = "published"; // Already published

      await expect(
        updateMerchantRestroom(client, merchantOwnerId, partnerRestroomId, {
          latitude: 37.299, // Attempt to move location
        })
      ).rejects.toThrow(/위치 및 도로명주소는 임의로 변경할 수 없습니다/);
    });

    it("2.9 allows draft restroom submission for review (draft -> pending)", async () => {
      const client = createMockSupabase();
      const updated = await submitRestroomForReview(client, merchantOwnerId, partnerRestroomId);
      expect(updated.publication_status).toBe("pending");

      // Attempting to submit again fails (422)
      await expect(
        submitRestroomForReview(client, merchantOwnerId, partnerRestroomId)
      ).rejects.toThrow(/임시저장\(draft\) 상태의 화장실만/);
    });

    it("2.10 creates versioned access policy and manages active flag", async () => {
      const client = createMockSupabase();
      const newPol = await createMerchantRestroomPolicy(client, merchantOwnerId, partnerRestroomId, {
        access_mode: "test_deposit",
        deposit_amount_krw: 2000,
        refund_eligible: true,
        receipt_window_hours: 12,
        min_purchase_krw: 500,
        is_active: true,
      });

      expect(newPol.version).toBe(2);
      expect(newPol.deposit_amount_krw).toBe(2000);
      expect(newPol.is_active).toBe(true);

      // Previous policy v1 should be deactivated
      const prevPol = policies.find((p) => p.id === "pol-1");
      expect(prevPol.is_active).toBe(false);
    });
  });

  // ==========================================================================
  // 3. HTTP Route Handlers Integration
  // ==========================================================================
  describe("3. HTTP Route Handlers Integration", () => {
    function mockAuthSession(userId: string) {
      vi.spyOn(authLib, "requireAuth").mockResolvedValue({
        user: { id: userId, email: "merchant@example.com" } as any,
        roles: ["merchant"],
        isAdmin: false,
        isMerchant: true,
        displayName: "Merchant",
        accountStatus: "active",
        profileExists: true,
        sessionExpired: false,
        configReady: true,
      });
    }

    it("3.1 GET /merchant/restrooms returns 401 when unauthenticated", async () => {
      vi.spyOn(authLib, "requireAuth").mockRejectedValue(
        new authLib.AuthGuardError("UNAUTHORIZED", 401, "로그인이 필요합니다.")
      );

      const req = new Request(`http://localhost/api/v1/merchant/restrooms?businessId=${approvedBizId}`);
      const res = await merchantRestroomsGet(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe("UNAUTHORIZED");
    });

    it("3.2 GET /merchant/restrooms returns 400 when businessId query is missing", async () => {
      mockAuthSession(merchantOwnerId);
      const req = new Request("http://localhost/api/v1/merchant/restrooms");
      const res = await merchantRestroomsGet(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe("VALIDATION_ERROR");
    });

    it("3.3 GET /merchant/restrooms returns 200 and list of restrooms for authorized owner", async () => {
      mockAuthSession(merchantOwnerId);
      const client = createMockSupabase();
      vi.spyOn(serverSupabase, "createServerClientInstance").mockResolvedValue(client);

      const req = new Request(`http://localhost/api/v1/merchant/restrooms?businessId=${approvedBizId}`);
      const res = await merchantRestroomsGet(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe(partnerRestroomId);
    });

    it("3.4 POST /merchant/restrooms creates draft and returns 201", async () => {
      mockAuthSession(merchantOwnerId);
      const client = createMockSupabase();
      vi.spyOn(serverSupabase, "createServerClientInstance").mockResolvedValue(client);

      const req = new Request("http://localhost/api/v1/merchant/restrooms", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": "idem-create-001",
        },
        body: JSON.stringify({
          business_id: approvedBizId,
          name: "새 화장실",
          road_address: "수원시 팔달구 신풍로 30",
          latitude: 37.2845,
          longitude: 127.0155,
          access_method: "pin",
        }),
      });

      const res = await merchantRestroomsPost(req);
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.publication_status).toBe("draft");
    });

    it("3.5 PATCH /merchant/restrooms/[id] updates draft restroom", async () => {
      mockAuthSession(merchantOwnerId);
      const client = createMockSupabase();
      vi.spyOn(serverSupabase, "createServerClientInstance").mockResolvedValue(client);

      const req = new Request(`http://localhost/api/v1/merchant/restrooms/${partnerRestroomId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": "idem-patch-001",
        },
        body: JSON.stringify({
          name: "이름 변경 제휴 화장실",
        }),
      });

      const res = await merchantRestroomPatch(req, {
        params: Promise.resolve({ id: partnerRestroomId }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.name).toBe("이름 변경 제휴 화장실");
    });

    it("3.6 POST /merchant/restrooms/[id]/submit triggers review and returns 200", async () => {
      mockAuthSession(merchantOwnerId);
      const client = createMockSupabase();
      vi.spyOn(serverSupabase, "createServerClientInstance").mockResolvedValue(client);

      const req = new Request(`http://localhost/api/v1/merchant/restrooms/${partnerRestroomId}/submit`, {
        method: "POST",
        headers: { "x-idempotency-key": "idem-submit-001" },
      });

      const res = await merchantRestroomSubmitPost(req, {
        params: Promise.resolve({ id: partnerRestroomId }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.publication_status).toBe("pending");
    });

    it("3.7 POST /merchant/restrooms/[id]/policies creates new policy version and returns 201", async () => {
      mockAuthSession(merchantOwnerId);
      const client = createMockSupabase();
      vi.spyOn(serverSupabase, "createServerClientInstance").mockResolvedValue(client);

      const req = new Request(`http://localhost/api/v1/merchant/restrooms/${partnerRestroomId}/policies`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": "idem-policy-001",
        },
        body: JSON.stringify({
          access_mode: "test_deposit",
          deposit_amount_krw: 1500,
          refund_eligible: true,
          receipt_window_hours: 24,
          is_active: true,
        }),
      });

      const res = await merchantRestroomPolicyPost(req, {
        params: Promise.resolve({ id: partnerRestroomId }),
      });
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.version).toBe(2);
      expect(json.data.deposit_amount_krw).toBe(1500);
    });

    it("3.8 replays cached response when retrying with same idempotency key and same payload", async () => {
      mockAuthSession(merchantOwnerId);
      const client = createMockSupabase();
      vi.spyOn(serverSupabase, "createServerClientInstance").mockResolvedValue(client);

      const payload = {
        name: "중복 재전송 화장실",
        business_id: approvedBizId,
        road_address: "수원시 팔달구 1",
        latitude: 37.28,
        longitude: 127.01,
      };

      const req1 = new Request("http://localhost/api/v1/merchant/restrooms", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": "idem-replay-001",
        },
        body: JSON.stringify(payload),
      });

      const res1 = await merchantRestroomsPost(req1);
      expect(res1.status).toBe(201);
      const json1 = await res1.json();

      // Retry with same key & identical body
      const req2 = new Request("http://localhost/api/v1/merchant/restrooms", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": "idem-replay-001",
        },
        body: JSON.stringify(payload),
      });

      const res2 = await merchantRestroomsPost(req2);
      expect(res2.status).toBe(201);
      const json2 = await res2.json();
      expect(json2.data.id).toBe(json1.data.id);
    });

    it("3.9 returns 409 conflict when sending same idempotency key with different payload", async () => {
      mockAuthSession(merchantOwnerId);
      const client = createMockSupabase();
      vi.spyOn(serverSupabase, "createServerClientInstance").mockResolvedValue(client);

      const req1 = new Request("http://localhost/api/v1/merchant/restrooms", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": "idem-conflict-001",
        },
        body: JSON.stringify({
          name: "원래 본문",
          business_id: approvedBizId,
          road_address: "수원시 팔달구 1",
          latitude: 37.28,
          longitude: 127.01,
        }),
      });
      const res1 = await merchantRestroomsPost(req1);
      expect(res1.status).toBe(201);

      // Re-send with same key but DIFFERENT body
      const req2 = new Request("http://localhost/api/v1/merchant/restrooms", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": "idem-conflict-001",
        },
        body: JSON.stringify({
          name: "변조된 다른 본문",
          business_id: approvedBizId,
          road_address: "수원시 팔달구 99",
          latitude: 37.28,
          longitude: 127.01,
        }),
      });

      const res2 = await merchantRestroomsPost(req2);
      expect(res2.status).toBe(409);
      const json2 = await res2.json();
      expect(json2.error.code).toBe("DUPLICATE_REQUEST");
    });

    it("3.10 maps user-facing policy_mode free_with_ad to access_mode free with zero deposit", async () => {
      mockAuthSession(merchantOwnerId);
      const client = createMockSupabase();
      vi.spyOn(serverSupabase, "createServerClientInstance").mockResolvedValue(client);

      const req = new Request(`http://localhost/api/v1/merchant/restrooms/${partnerRestroomId}/policies`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": "idem-policy-free-001",
        },
        body: JSON.stringify({
          policy_mode: "free_with_ad",
          is_active: true,
        }),
      });

      const res = await merchantRestroomPolicyPost(req, {
        params: Promise.resolve({ id: partnerRestroomId }),
      });
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.access_mode).toBe("free");
      expect(json.data.deposit_amount_krw).toBe(0);
      expect(json.data.refund_eligible).toBe(false);
    });

    it("3.11 TASK-04: rejects identical policy re-application on API/fallback with 409 POLICY_UNCHANGED without creating a new version", async () => {
      mockAuthSession(merchantOwnerId);
      const client = createMockSupabase();
      vi.spyOn(serverSupabase, "createServerClientInstance").mockResolvedValue(client);

      const initialPolicyCount = policies.length;

      // Active policy on partnerRestroomId is test_deposit(1000, refund=true, window=24, min=0)
      const dupReq = new Request(
        `http://localhost/api/v1/merchant/restrooms/${partnerRestroomId}/policies`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-idempotency-key": "idem-policy-dup-001",
          },
          body: JSON.stringify({
            policy_mode: "deposit_with_ad",
            deposit_amount_krw: 1000,
            receipt_window_hours: 24,
            min_purchase_krw: 0,
            is_active: true,
          }),
        }
      );
      const dupRes = await merchantRestroomPolicyPost(dupReq, {
        params: Promise.resolve({ id: partnerRestroomId }),
      });
      expect(dupRes.status).toBe(409);
      const dupJson = await dupRes.json();
      expect(dupJson.error.code).toBe("POLICY_UNCHANGED");
      expect(policies).toHaveLength(initialPolicyCount);

      // Changing min_purchase_krw (e.g. 0 -> 3000) creates a new version
      const changedReq = new Request(
        `http://localhost/api/v1/merchant/restrooms/${partnerRestroomId}/policies`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-idempotency-key": "idem-policy-chg-001",
          },
          body: JSON.stringify({
            policy_mode: "deposit_with_ad",
            deposit_amount_krw: 1000,
            receipt_window_hours: 24,
            min_purchase_krw: 3000,
            is_active: true,
          }),
        }
      );
      const changedRes = await merchantRestroomPolicyPost(changedReq, {
        params: Promise.resolve({ id: partnerRestroomId }),
      });
      expect(changedRes.status).toBe(201);
      const changedJson = await changedRes.json();
      expect(changedJson.data.version).toBe(2);
      expect(changedJson.data.min_purchase_krw).toBe(3000);
      expect(policies).toHaveLength(initialPolicyCount + 1);
    });
  });

  // ==========================================================================
  // 4. PGlite DB RLS & Trigger Enforcement Verification
  // ==========================================================================
  describe("4. PGlite DB RLS & Trigger Enforcement Verification", () => {
    let db: PGlite;
    const testMerchantUid = "55555555-5555-4555-8555-555555555555";
    const testOtherUid = "66666666-6666-4666-8666-666666666666";
    const testAdminUid = "00000000-0000-4000-8000-000000000000";
    const testBizId = "77777777-7777-4777-8777-777777777777";
    let insertedRestroomId: string;
    let atomicRestroomId: string;
    let freeRestroomId: string;

    beforeAll(async () => {
      db = new PGlite();

      // Mock auth schema
      await db.exec(`
        CREATE SCHEMA IF NOT EXISTS auth;
        CREATE TABLE IF NOT EXISTS auth.users (
          id uuid PRIMARY KEY,
          email text UNIQUE,
          raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
          created_at timestamptz DEFAULT now(),
          updated_at timestamptz DEFAULT now()
        );
        CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
          SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
        $$;
        CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
          SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), current_setting('role', true), 'anon');
        $$;
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin; END IF;
        END $$;
        GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
        GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;
      `);

      // Apply 6 migrations (including TASK 12 operations & policy immutability)
      const ROOT = process.cwd();
      const m1 = fs.readFileSync(path.join(ROOT, "supabase/migrations/20261106000000_auth_schema.sql"), "utf8");
      await db.exec(m1);
      const m2 = fs.readFileSync(path.join(ROOT, "supabase/migrations/20261107000000_lead_tracking.sql"), "utf8");
      await db.exec(m2);
      const m3 = fs.readFileSync(path.join(ROOT, "supabase/migrations/20261108000000_business_backend.sql"), "utf8");
      await db.exec(m3);
      const m4 = fs.readFileSync(path.join(ROOT, "supabase/migrations/20261109000000_audit_and_approval.sql"), "utf8");
      await db.exec(m4);
      const m5 = fs.readFileSync(path.join(ROOT, "supabase/migrations/20261110000000_restroom_schema.sql"), "utf8");
      await db.exec(m5);
      const m6 = fs.readFileSync(path.join(ROOT, "supabase/migrations/20261111000000_restroom_merchant_operations.sql"), "utf8");
      await db.exec(m6);
      const m7 = fs.readFileSync(path.join(ROOT, "supabase/migrations/20261123010000_prevent_duplicate_restroom_policy.sql"), "utf8");
      await db.exec(m7);

      // Create users & approved business (in superuser context)
      await db.exec(`
        RESET ROLE;
        INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
          ('${testMerchantUid}', 'owner@test.com', '{"name":"Owner"}'::jsonb),
          ('${testOtherUid}', 'other@test.com', '{"name":"Other"}'::jsonb),
          ('${testAdminUid}', 'admin@test.com', '{"name":"Admin"}'::jsonb);
        INSERT INTO public.user_roles (user_id, role) VALUES ('${testAdminUid}', 'admin');
        INSERT INTO public.businesses (id, name, category, registration_status, road_address, latitude, longitude, created_by, approved_by, approved_at)
        VALUES ('${testBizId}', '테스트 카페', '카페', 'approved', '수원시 팔달구 1', 37.28, 127.01, '${testMerchantUid}', '${testMerchantUid}', now());
        INSERT INTO public.business_members (business_id, user_id, role, membership_status)
        VALUES ('${testBizId}', '${testMerchantUid}', 'owner', 'active');
      `);
    }, 30000);

    afterAll(async () => {
      if (db) await db.close();
    });

    it("4.1 allows active merchant owner to insert draft partner restroom via RLS", async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${testMerchantUid}';
        SET request.jwt.claim.role = 'authenticated';
      `);

      const res: any = await db.query(`
        INSERT INTO public.restrooms (
          business_id, type, name, road_address, latitude, longitude, publication_status
        ) VALUES (
          '${testBizId}', 'partner', '정상 등록 화장실', '수원시 팔달구 2', 37.28, 127.01, 'draft'
        ) RETURNING id, publication_status;
      `);

      expect(res.rows[0].id).toBeDefined();
      expect(res.rows[0].publication_status).toBe("draft");
      insertedRestroomId = res.rows[0].id;
    });

    it("4.2 blocks merchant from self-publishing on insert (RLS WITH CHECK violation)", async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${testMerchantUid}';
        SET request.jwt.claim.role = 'authenticated';
      `);

      await expect(
        db.query(`
          INSERT INTO public.restrooms (
            business_id, type, name, road_address, latitude, longitude, publication_status
          ) VALUES (
            '${testBizId}', 'partner', '직접 공개 시도 화장실', '수원시 팔달구 3', 37.28, 127.01, 'published'
          );
        `)
      ).rejects.toThrow();
    });

    it("4.3 blocks non-member from inserting restroom for business (RLS violation)", async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${testOtherUid}';
        SET request.jwt.claim.role = 'authenticated';
      `);

      await expect(
        db.query(`
          INSERT INTO public.restrooms (
            business_id, type, name, road_address, latitude, longitude, publication_status
          ) VALUES (
            '${testBizId}', 'partner', '타인 무단 등록 시도', '수원시 팔달구 4', 37.28, 127.01, 'draft'
          );
        `)
      ).rejects.toThrow();
    });

    it("4.4 blocks merchant from changing restroom type to public (Trigger enforce_restroom_update_rules)", async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${testMerchantUid}';
        SET request.jwt.claim.role = 'authenticated';
      `);

      await expect(
        db.query(`
          UPDATE public.restrooms
          SET type = 'public'
          WHERE id = '${insertedRestroomId}';
        `)
      ).rejects.toThrow();
    });

    it("4.5 blocks merchant from directly setting publication_status = published (Trigger violation)", async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${testMerchantUid}';
        SET request.jwt.claim.role = 'authenticated';
      `);

      await expect(
        db.query(`
          UPDATE public.restrooms
          SET publication_status = 'published'
          WHERE id = '${insertedRestroomId}';
        `)
      ).rejects.toThrow();
    });

    it("4.6 blocks merchant from directly setting publication_status = pending via UPDATE (Trigger 42501)", async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${testMerchantUid}';
        SET request.jwt.claim.role = 'authenticated';
      `);

      await expect(
        db.query(`
          UPDATE public.restrooms
          SET publication_status = 'pending'
          WHERE id = '${insertedRestroomId}';
        `)
      ).rejects.toThrow();
    });

    it("4.7 submit_merchant_restroom_for_review enforces policy prerequisite and transitions draft -> pending", async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${testMerchantUid}';
        SET request.jwt.claim.role = 'authenticated';
      `);

      // 1. Without active policy, submission must fail (HM005)
      await expect(
        db.query(`SELECT public.submit_merchant_restroom_for_review('${insertedRestroomId}');`)
      ).rejects.toThrow();

      // 2. Add active policy via RPC
      const policyRes: any = await db.query(`
        SELECT * FROM public.create_merchant_restroom_policy(
          '${insertedRestroomId}',
          'test_deposit',
          1000,
          true,
          24,
          0
        );
      `);
      expect(policyRes.rows[0].version).toBe(1);
      expect(policyRes.rows[0].is_active).toBe(true);

      // 3. Now review submission succeeds
      const submitRes: any = await db.query(`
        SELECT * FROM public.submit_merchant_restroom_for_review('${insertedRestroomId}');
      `);
      expect(submitRes.rows[0].publication_status).toBe("pending");
      expect(submitRes.rows[0].approved_by).toBeNull();
      expect(submitRes.rows[0].last_verified_at).toBeNull();

      // 4. Submitting again while already pending fails (HM001)
      await expect(
        db.query(`SELECT public.submit_merchant_restroom_for_review('${insertedRestroomId}');`)
      ).rejects.toThrow();
    });

    it("4.8 blocks non-member from submitting restroom for review (RPC 42501)", async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${testOtherUid}';
        SET request.jwt.claim.role = 'authenticated';
      `);

      await expect(
        db.query(`SELECT public.submit_merchant_restroom_for_review('${insertedRestroomId}');`)
      ).rejects.toThrow();
    });

    it("4.9 blocks direct mutation and direct deactivation of active access policies (Trigger 42501)", async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${testMerchantUid}';
        SET request.jwt.claim.role = 'authenticated';
      `);

      // 1. Attempt to directly deactivate policy (is_active = false) -> 42501
      let updateDeactivateErr: any;
      try {
        await db.query(`
          UPDATE public.restroom_access_policies
          SET is_active = false
          WHERE restroom_id = '${insertedRestroomId}';
        `);
      } catch (e) {
        updateDeactivateErr = e;
      }
      expect(updateDeactivateErr).toBeDefined();
      expect(updateDeactivateErr.code).toBe("42501");

      // Verify policy remains active (never leaves restroom without active policy)
      const activeCheck: any = await db.query(`
        SELECT count(*) as count
        FROM public.restroom_access_policies
        WHERE restroom_id = '${insertedRestroomId}' AND is_active = true;
      `);
      expect(Number(activeCheck.rows[0].count)).toBe(1);

      // 2. Attempt to mutate deposit_amount_krw -> 42501
      let updateDepositErr: any;
      try {
        await db.query(`
          UPDATE public.restroom_access_policies
          SET deposit_amount_krw = 99999
          WHERE restroom_id = '${insertedRestroomId}';
        `);
      } catch (e) {
        updateDepositErr = e;
      }
      expect(updateDepositErr).toBeDefined();
      expect(updateDepositErr.code).toBe("42501");

      // 3. Attempt to mutate version -> 42501
      let updateVersionErr: any;
      try {
        await db.query(`
          UPDATE public.restroom_access_policies
          SET version = 99
          WHERE restroom_id = '${insertedRestroomId}';
        `);
      } catch (e) {
        updateVersionErr = e;
      }
      expect(updateVersionErr).toBeDefined();
      expect(updateVersionErr.code).toBe("42501");

      // 4. Attempt to mutate restroom_id -> 42501
      let updateRestroomIdErr: any;
      try {
        await db.query(`
          UPDATE public.restroom_access_policies
          SET restroom_id = '11111111-1111-1111-1111-111111111111'
          WHERE restroom_id = '${insertedRestroomId}';
        `);
      } catch (e) {
        updateRestroomIdErr = e;
      }
      expect(updateRestroomIdErr).toBeDefined();
      expect(updateRestroomIdErr.code).toBe("42501");
    });

    it("4.9.1 blocks direct INSERT attacks on access policies by authenticated merchant (Trigger / RLS 42501)", async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${testMerchantUid}';
        SET request.jwt.claim.role = 'authenticated';
      `);

      // Attack 1: 기존 화장실에 임의의 비활성 정책 직접 INSERT -> 42501
      let attack1Err: any;
      try {
        await db.query(`
          INSERT INTO public.restroom_access_policies (
            restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, is_active
          ) VALUES (
            '${insertedRestroomId}', 9, 'test_deposit', 1000, true, false
          );
        `);
      } catch (e) {
        attack1Err = e;
      }
      expect(attack1Err).toBeDefined();
      expect(attack1Err.code).toBe("42501");

      // Attack 2: 기존 화장실에 허위 created_by/effective_from 정책 직접 INSERT -> 42501
      let attack2Err: any;
      try {
        await db.query(`
          INSERT INTO public.restroom_access_policies (
            restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, is_active, created_by, effective_from
          ) VALUES (
            '${insertedRestroomId}', 2, 'test_deposit', 1000, true, true, '${testOtherUid}', '2020-01-01 00:00:00+00'
          );
        `);
      } catch (e) {
        attack2Err = e;
      }
      expect(attack2Err).toBeDefined();
      expect(attack2Err.code).toBe("42501");

      // Attack 3: 매우 큰 version 값을 가진 정책 직접 INSERT -> 42501
      let attack3Err: any;
      try {
        await db.query(`
          INSERT INTO public.restroom_access_policies (
            restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, is_active
          ) VALUES (
            '${insertedRestroomId}', 999999, 'test_deposit', 1000, true, true
          );
        `);
      } catch (e) {
        attack3Err = e;
      }
      expect(attack3Err).toBeDefined();
      expect(attack3Err.code).toBe("42501");

      // Verify no forged policies were inserted
      const countCheck: any = await db.query(`
        SELECT count(*) as count FROM public.restroom_access_policies WHERE restroom_id = '${insertedRestroomId}';
      `);
      expect(Number(countCheck.rows[0].count)).toBe(1);
    });

    it("4.10 atomic RPC create_merchant_restroom_policy creates next version and preserves history", async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${testMerchantUid}';
        SET request.jwt.claim.role = 'authenticated';
      `);

      const v2Res: any = await db.query(`
        SELECT * FROM public.create_merchant_restroom_policy(
          '${insertedRestroomId}',
          'test_deposit',
          2000,
          true,
          48,
          500
        );
      `);
      expect(v2Res.rows[0].version).toBe(2);
      expect(v2Res.rows[0].deposit_amount_krw).toBe(2000);
      expect(v2Res.rows[0].is_active).toBe(true);

      // Verify v1 is now deactivated but all its history/details are preserved
      const allPolicies: any = await db.query(`
        SELECT version, deposit_amount_krw, is_active
        FROM public.restroom_access_policies
        WHERE restroom_id = '${insertedRestroomId}'
        ORDER BY version ASC;
      `);
      expect(allPolicies.rows).toHaveLength(2);
      expect(allPolicies.rows[0].version).toBe(1);
      expect(allPolicies.rows[0].deposit_amount_krw).toBe(1000);
      expect(allPolicies.rows[0].is_active).toBe(false);
      expect(allPolicies.rows[1].version).toBe(2);
      expect(allPolicies.rows[1].deposit_amount_krw).toBe(2000);
      expect(allPolicies.rows[1].is_active).toBe(true);

      // Verify direct reactivation of v1 is blocked (Trigger 42501)
      await expect(
        db.query(`
          UPDATE public.restroom_access_policies
          SET is_active = true
          WHERE restroom_id = '${insertedRestroomId}' AND version = 1;
        `)
      ).rejects.toThrow();
    });

    it("4.11 create_merchant_restroom atomically inserts draft restroom + initial policy in 1 transaction", async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${testMerchantUid}';
        SET request.jwt.claim.role = 'authenticated';
      `);

      const newToiletRes: any = await db.query(`
        SELECT * FROM public.create_merchant_restroom(
          '${testBizId}',
          '원자적 생성 화장실',
          '원자성 테스트 설명',
          '수원시 팔달구 매산로 10',
          '2층',
          37.28,
          127.01,
          '2층',
          '계단 옆',
          'separate',
          true,
          false,
          true,
          'pin',
          'test_deposit',
          1000,
          true,
          24,
          0
        );
      `);

      const newId = newToiletRes.rows[0].id;
      expect(newId).toBeDefined();
      expect(newToiletRes.rows[0].publication_status).toBe("draft");
      atomicRestroomId = newId;

      // Verify initial policy v1 was inserted atomically
      const policyRes: any = await db.query(`
        SELECT version, access_mode, deposit_amount_krw, refund_eligible, receipt_window_hours, min_purchase_krw, is_active
        FROM public.restroom_access_policies
        WHERE restroom_id = '${newId}';
      `);
      expect(policyRes.rows).toHaveLength(1);
      expect(policyRes.rows[0].version).toBe(1);
      expect(policyRes.rows[0].deposit_amount_krw).toBe(1000);
      expect(policyRes.rows[0].refund_eligible).toBe(true);
      expect(policyRes.rows[0].receipt_window_hours).toBe(24);
      expect(policyRes.rows[0].min_purchase_krw).toBe(0);
      expect(policyRes.rows[0].is_active).toBe(true);
    });

    it("4.11.1 blocks identical test_deposit RPC call with HM002 and applies default values (1000 KRW, refund_eligible=true, receipt_window=24h) when transitioning from free", async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${testMerchantUid}';
        SET request.jwt.claim.role = 'authenticated';
      `);

      // atomicRestroomId already has v1 test_deposit(1000, true, 24, 0) -> identical call must fail with HM002
      let identicalErr: any;
      try {
        await db.query(`
          SELECT * FROM public.create_merchant_restroom_policy(
            '${atomicRestroomId}',
            'test_deposit'
          );
        `);
      } catch (e) {
        identicalErr = e;
      }
      expect(identicalErr).toBeDefined();
      expect(identicalErr.code).toBe("HM002");

      // Create a free restroom first, then transition to test_deposit with omitted optional parameters
      const freeForDefaultRes: any = await db.query(`
        SELECT * FROM public.create_merchant_restroom(
          '${testBizId}',
          '기본값 검증용 무료 화장실',
          null,
          '수원시 팔달구 매산로 11',
          null,
          37.28,
          127.01,
          null,
          null,
          'unknown',
          null,
          null,
          null,
          'ask_staff',
          'free'
        );
      `);
      const freeForDefaultId = freeForDefaultRes.rows[0].id;

      const res: any = await db.query(`
        SELECT * FROM public.create_merchant_restroom_policy(
          '${freeForDefaultId}',
          'test_deposit'
        );
      `);

      expect(res.rows[0].version).toBe(2);
      expect(res.rows[0].access_mode).toBe("test_deposit");
      expect(res.rows[0].deposit_amount_krw).toBe(1000);
      expect(res.rows[0].refund_eligible).toBe(true);
      expect(res.rows[0].receipt_window_hours).toBe(24);
      expect(res.rows[0].min_purchase_krw).toBe(0);
      expect(res.rows[0].is_active).toBe(true);
    });

    it("4.11.2 strictly enforces 0 KRW, refund_eligible=false, and receipt_window=null in free mode", async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${testMerchantUid}';
        SET request.jwt.claim.role = 'authenticated';
      `);

      // Invoke policy change to free mode (even if someone passes 5000 or true, it forces 0 and false)
      const res: any = await db.query(`
        SELECT * FROM public.create_merchant_restroom_policy(
          '${atomicRestroomId}',
          'free',
          5000,
          true,
          72,
          1000
        );
      `);

      expect(res.rows[0].version).toBe(2);
      expect(res.rows[0].access_mode).toBe("free");
      expect(res.rows[0].deposit_amount_krw).toBe(0);
      expect(res.rows[0].refund_eligible).toBe(false);
      expect(res.rows[0].receipt_window_hours).toBeNull();
      expect(res.rows[0].min_purchase_krw).toBe(0);
      expect(res.rows[0].is_active).toBe(true);

      // Re-invoking free mode with different ignored args must still be blocked with HM002
      let dupFreeErr: any;
      try {
        await db.query(`
          SELECT * FROM public.create_merchant_restroom_policy(
            '${atomicRestroomId}',
            'free'
          );
        `);
      } catch (e) {
        dupFreeErr = e;
      }
      expect(dupFreeErr).toBeDefined();
      expect(dupFreeErr.code).toBe("HM002");
    });

    it("4.11.3 creates new version with explicit deposit amount change and preserves single active policy", async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${testMerchantUid}';
        SET request.jwt.claim.role = 'authenticated';
      `);

      const res: any = await db.query(`
        SELECT * FROM public.create_merchant_restroom_policy(
          '${atomicRestroomId}',
          'test_deposit',
          3500,
          true,
          48,
          500
        );
      `);

      expect(res.rows[0].version).toBe(3);
      expect(res.rows[0].access_mode).toBe("test_deposit");
      expect(res.rows[0].deposit_amount_krw).toBe(3500);
      expect(res.rows[0].refund_eligible).toBe(true);
      expect(res.rows[0].receipt_window_hours).toBe(48);
      expect(res.rows[0].min_purchase_krw).toBe(500);
      expect(res.rows[0].is_active).toBe(true);

      // Verify exactly 1 active policy exists for atomicRestroomId
      const activeRes: any = await db.query(`
        SELECT version, deposit_amount_krw, is_active
        FROM public.restroom_access_policies
        WHERE restroom_id = '${atomicRestroomId}' AND is_active = true;
      `);
      expect(activeRes.rows).toHaveLength(1);
      expect(activeRes.rows[0].version).toBe(3);
      expect(activeRes.rows[0].deposit_amount_krw).toBe(3500);

      // Concurrent duplicate calls with identical 3500/true/48/500 must only keep v3
      const results = await Promise.allSettled([
        db.query(`SELECT * FROM public.create_merchant_restroom_policy('${atomicRestroomId}', 'test_deposit', 3500, true, 48, 500);`),
        db.query(`SELECT * FROM public.create_merchant_restroom_policy('${atomicRestroomId}', 'test_deposit', 3500, true, 48, 500);`),
      ]);
      expect(results.every((r) => r.status === "rejected")).toBe(true);
    });

    it("4.11.4 preserves full policy history (v1..v3) and blocks direct INSERT and UPDATE mutations (42501)", async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${testMerchantUid}';
        SET request.jwt.claim.role = 'authenticated';
      `);

      // 1. Check all 3 versions exist in chronological order
      const allRes: any = await db.query(`
        SELECT version, access_mode, deposit_amount_krw, refund_eligible, is_active
        FROM public.restroom_access_policies
        WHERE restroom_id = '${atomicRestroomId}'
        ORDER BY version ASC;
      `);
      expect(allRes.rows).toHaveLength(3);
      expect(allRes.rows[0].version).toBe(1);
      expect(allRes.rows[0].is_active).toBe(false);
      expect(allRes.rows[1].version).toBe(2);
      expect(allRes.rows[1].is_active).toBe(false);
      expect(allRes.rows[2].version).toBe(3);
      expect(allRes.rows[2].is_active).toBe(true);

      // 2. Direct INSERT attack on atomicRestroomId must fail with 42501
      let insertErr: any;
      try {
        await db.query(`
          INSERT INTO public.restroom_access_policies (
            restroom_id, version, access_mode, deposit_amount_krw, is_active
          ) VALUES ('${atomicRestroomId}', 5, 'test_deposit', 1000, true);
        `);
      } catch (e) {
        insertErr = e;
      }
      expect(insertErr).toBeDefined();
      expect(insertErr.code).toBe("42501");

      // 3. Direct UPDATE mutation on active policy must fail with 42501
      let updateErr: any;
      try {
        await db.query(`
          UPDATE public.restroom_access_policies
          SET deposit_amount_krw = 99999
          WHERE restroom_id = '${atomicRestroomId}' AND is_active = true;
        `);
      } catch (e) {
        updateErr = e;
      }
      expect(updateErr).toBeDefined();
      expect(updateErr.code).toBe("42501");
    });

    it("4.11.5 verifies initial registration RPC create_merchant_restroom with free access_mode stores exact free defaults (0 KRW, refund_eligible=false, receipt_window=null, min_purchase=0)", async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${testMerchantUid}';
        SET request.jwt.claim.role = 'authenticated';
      `);

      const freeToiletRes: any = await db.query(`
        SELECT * FROM public.create_merchant_restroom(
          '${testBizId}',
          '무료 등록 화장실',
          '무료 모드 테스트',
          '수원시 팔달구 행궁로 5',
          '1층',
          37.28,
          127.01,
          '1층',
          '카운터 뒷편',
          'unisex',
          true,
          true,
          false,
          'open',
          'free'
        );
      `);

      freeRestroomId = freeToiletRes.rows[0].id;
      expect(freeRestroomId).toBeDefined();

      const policyRes: any = await db.query(`
        SELECT access_mode, deposit_amount_krw, refund_eligible, receipt_window_hours, min_purchase_krw, is_active
        FROM public.restroom_access_policies
        WHERE restroom_id = '${freeRestroomId}';
      `);

      expect(policyRes.rows).toHaveLength(1);
      expect(policyRes.rows[0].access_mode).toBe("free");
      expect(policyRes.rows[0].deposit_amount_krw).toBe(0);
      expect(policyRes.rows[0].refund_eligible).toBe(false);
      expect(policyRes.rows[0].receipt_window_hours).toBeNull();
      expect(policyRes.rows[0].min_purchase_krw).toBe(0);
      expect(policyRes.rows[0].is_active).toBe(true);
    });

    it("4.11.6 verifies policy update RPC create_merchant_restroom_policy with free access_mode matches initial registration columns identically", async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${testMerchantUid}';
        SET request.jwt.claim.role = 'authenticated';
      `);

      // Switch atomicRestroomId (which was deposit) to free mode via RPC
      const updateFreeRes: any = await db.query(`
        SELECT * FROM public.create_merchant_restroom_policy(
          '${atomicRestroomId}',
          'free'
        );
      `);

      expect(updateFreeRes.rows[0].access_mode).toBe("free");
      expect(updateFreeRes.rows[0].deposit_amount_krw).toBe(0);
      expect(updateFreeRes.rows[0].refund_eligible).toBe(false);
      expect(updateFreeRes.rows[0].receipt_window_hours).toBeNull();
      expect(updateFreeRes.rows[0].min_purchase_krw).toBe(0);
      expect(updateFreeRes.rows[0].is_active).toBe(true);

      // Query policy from initial registration (freeRestroomId)
      const initialFreePolicy: any = await db.query(`
        SELECT access_mode, deposit_amount_krw, refund_eligible, receipt_window_hours, min_purchase_krw
        FROM public.restroom_access_policies
        WHERE restroom_id = '${freeRestroomId}' AND is_active = true;
      `);

      // Both RPCs must produce identical policy column values for free mode
      expect(updateFreeRes.rows[0].access_mode).toEqual(initialFreePolicy.rows[0].access_mode);
      expect(updateFreeRes.rows[0].deposit_amount_krw).toEqual(initialFreePolicy.rows[0].deposit_amount_krw);
      expect(updateFreeRes.rows[0].refund_eligible).toEqual(initialFreePolicy.rows[0].refund_eligible);
      expect(updateFreeRes.rows[0].receipt_window_hours).toEqual(initialFreePolicy.rows[0].receipt_window_hours);
      expect(updateFreeRes.rows[0].min_purchase_krw).toEqual(initialFreePolicy.rows[0].min_purchase_krw);
    });

    it("4.11.7 compares and verifies exact 1:1 match of test_deposit default columns across both RPCs", async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${testMerchantUid}';
        SET request.jwt.claim.role = 'authenticated';
      `);

      // Initial registration with default test_deposit
      const initialDepositToilet: any = await db.query(`
        SELECT * FROM public.create_merchant_restroom(
          '${testBizId}',
          '기본 보증금 화장실',
          null,
          '수원시 팔달구 팔달로 1',
          null,
          37.28,
          127.01
        );
      `);
      const initialDepositId = initialDepositToilet.rows[0].id;

      const initialPolicy: any = await db.query(`
        SELECT access_mode, deposit_amount_krw, refund_eligible, receipt_window_hours, min_purchase_krw, is_active
        FROM public.restroom_access_policies
        WHERE restroom_id = '${initialDepositId}' AND is_active = true;
      `);

      // Policy update with default test_deposit (optional params omitted)
      const updatedPolicy: any = await db.query(`
        SELECT access_mode, deposit_amount_krw, refund_eligible, receipt_window_hours, min_purchase_krw, is_active
        FROM public.create_merchant_restroom_policy(
          '${freeRestroomId}',
          'test_deposit'
        );
      `);

      // Compare both results: must be 100% identical
      expect(initialPolicy.rows[0].access_mode).toBe("test_deposit");
      expect(updatedPolicy.rows[0].access_mode).toBe("test_deposit");

      expect(initialPolicy.rows[0].deposit_amount_krw).toBe(1000);
      expect(updatedPolicy.rows[0].deposit_amount_krw).toBe(1000);

      expect(initialPolicy.rows[0].refund_eligible).toBe(true);
      expect(updatedPolicy.rows[0].refund_eligible).toBe(true);

      expect(initialPolicy.rows[0].receipt_window_hours).toBe(24);
      expect(updatedPolicy.rows[0].receipt_window_hours).toBe(24);

      expect(initialPolicy.rows[0].min_purchase_krw).toBe(0);
      expect(updatedPolicy.rows[0].min_purchase_krw).toBe(0);
    });

    it("4.11.8 regression test: direct policy INSERT and UPDATE remain strictly blocked with 42501 across all restrooms", async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${testMerchantUid}';
        SET request.jwt.claim.role = 'authenticated';
      `);

      // 1. Direct INSERT attempt on free restroom -> 42501
      let directInsertFreeErr: any;
      try {
        await db.query(`
          INSERT INTO public.restroom_access_policies (
            restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, is_active
          ) VALUES ('${freeRestroomId}', 99, 'free', 0, false, false);
        `);
      } catch (e) {
        directInsertFreeErr = e;
      }
      expect(directInsertFreeErr).toBeDefined();
      expect(directInsertFreeErr.code).toBe("42501");

      // 2. Direct UPDATE attempt on free restroom -> 42501
      let directUpdateFreeErr: any;
      try {
        await db.query(`
          UPDATE public.restroom_access_policies
          SET deposit_amount_krw = 500
          WHERE restroom_id = '${freeRestroomId}';
        `);
      } catch (e) {
        directUpdateFreeErr = e;
      }
      expect(directUpdateFreeErr).toBeDefined();
      expect(directUpdateFreeErr.code).toBe("42501");

      // 3. Direct INSERT attempt on deposit restroom -> 42501
      let directInsertDepositErr: any;
      try {
        await db.query(`
          INSERT INTO public.restroom_access_policies (
            restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, is_active
          ) VALUES ('${atomicRestroomId}', 99, 'test_deposit', 2000, true, false);
        `);
      } catch (e) {
        directInsertDepositErr = e;
      }
      expect(directInsertDepositErr).toBeDefined();
      expect(directInsertDepositErr.code).toBe("42501");

      // 4. Direct UPDATE attempt on deposit restroom -> 42501
      let directUpdateDepositErr: any;
      try {
        await db.query(`
          UPDATE public.restroom_access_policies
          SET is_active = false
          WHERE restroom_id = '${atomicRestroomId}';
        `);
      } catch (e) {
        directUpdateDepositErr = e;
      }
      expect(directUpdateDepositErr).toBeDefined();
      expect(directUpdateDepositErr.code).toBe("42501");
    });

    it("4.12 blocks RPC execution by unapproved store member or non-member", async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${testOtherUid}';
        SET request.jwt.claim.role = 'authenticated';
      `);

      // Attempt to create restroom for store user does not belong to
      await expect(
        db.query(`
          SELECT * FROM public.create_merchant_restroom(
            '${testBizId}',
            '무단 화장실',
            null,
            '수원시 팔달구 99',
            null,
            37.28,
            127.01
          );
        `)
      ).rejects.toThrow();
    });

    it("4.13 handles sequential/concurrent policy creations safely with row locking and single active constraint", async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${testMerchantUid}';
        SET request.jwt.claim.role = 'authenticated';
      `);

      // Invoke policy creation twice in sequence
      const resA: any = await db.query(`
        SELECT * FROM public.create_merchant_restroom_policy(
          '${insertedRestroomId}',
          'test_deposit',
          3000,
          true,
          24,
          0
        );
      `);
      const resB: any = await db.query(`
        SELECT * FROM public.create_merchant_restroom_policy(
          '${insertedRestroomId}',
          'test_deposit',
          4000,
          true,
          24,
          0
        );
      `);

      expect(resA.rows[0].version).toBe(3);
      expect(resB.rows[0].version).toBe(4);

      // Verify exactly 1 active policy exists
      const activeRes: any = await db.query(`
        SELECT version, deposit_amount_krw
        FROM public.restroom_access_policies
        WHERE restroom_id = '${insertedRestroomId}' AND is_active = true;
      `);
      expect(activeRes.rows).toHaveLength(1);
      expect(activeRes.rows[0].version).toBe(4);
      expect(activeRes.rows[0].deposit_amount_krw).toBe(4000);
    });

    it("4.14 verifies idempotency scope isolation across user, endpoint, and restroom ID", () => {
      authLib.clearIdempotencyStoreForTests();

      const key = "test-shared-key-999";
      const payload = { test: "data" };

      // User 1 on create endpoint
      const r1 = authLib.checkIdempotencyKey(key, `merchant-restrooms-create:user-1`, payload);
      expect(r1.action).toBe("proceed");

      // User 2 on same create endpoint with same key -> isolated, does not collide
      const r2 = authLib.checkIdempotencyKey(key, `merchant-restrooms-create:user-2`, payload);
      expect(r2.action).toBe("proceed");

      // User 1 on different endpoint (policy) with same key -> isolated, does not collide
      const r3 = authLib.checkIdempotencyKey(key, `merchant-restrooms-policy:user-1:toilet-1`, payload);
      expect(r3.action).toBe("proceed");

      // User 1 on same policy endpoint but different toilet ID -> isolated, does not collide
      const r4 = authLib.checkIdempotencyKey(key, `merchant-restrooms-policy:user-1:toilet-2`, payload);
      expect(r4.action).toBe("proceed");

      // User 1 retrying exact same scope + same payload -> duplicate replay/conflict
      const r5 = authLib.checkIdempotencyKey(key, `merchant-restrooms-create:user-1`, payload);
      expect(r5.isDuplicate).toBe(true);
    });

    it("4.15 permits administrator to directly insert and update policies and use RPC", async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${testAdminUid}';
        SET request.jwt.claim.role = 'authenticated';
      `);

      // 1. Admin can directly insert a policy
      const adminInsertRes: any = await db.query(`
        INSERT INTO public.restroom_access_policies (
          restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, is_active
        ) VALUES (
          '${insertedRestroomId}', 99, 'test_deposit', 5000, false, false
        ) RETURNING id, version;
      `);
      expect(adminInsertRes.rows[0].version).toBe(99);

      // 2. Admin can directly update a policy
      const adminUpdateRes: any = await db.query(`
        UPDATE public.restroom_access_policies
        SET deposit_amount_krw = 5500
        WHERE id = '${adminInsertRes.rows[0].id}'
        RETURNING deposit_amount_krw;
      `);
      expect(adminUpdateRes.rows[0].deposit_amount_krw).toBe(5500);

      // 3. Admin can call RPC create_merchant_restroom_policy
      const adminRpcRes: any = await db.query(`
        SELECT * FROM public.create_merchant_restroom_policy(
          '${insertedRestroomId}',
          'test_deposit',
          6000,
          true,
          24,
          0
        );
      `);
      expect(adminRpcRes.rows[0].deposit_amount_krw).toBe(6000);
      expect(adminRpcRes.rows[0].is_active).toBe(true);
    });
  });
});
