import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Database, UserRoleType } from "@/lib/db/types";
import { AuthGuardError, clearIdempotencyStoreForTests } from "@/lib/auth";
import {
  BUSINESS_VERIFICATION_PUBLIC_COLUMNS,
  createBusinessForMerchant,
  createBusinessSchema,
  getBusinessDetailForMerchant,
  listBusinessesForMerchant,
  requireApprovedBusinessMembership,
  submitBusinessForMerchant,
  updateBusinessForMerchant,
  updateBusinessSchema,
  type Business,
  type BusinessHours,
  type BusinessMember,
  type BusinessVerification,
} from "@/lib/businesses";
import {
  GET as businessesGet,
  POST as businessesPost,
} from "@/app/api/v1/merchant/businesses/route";
import {
  GET as businessDetailGet,
  PATCH as businessDetailPatch,
} from "@/app/api/v1/merchant/businesses/[id]/route";
import { POST as businessSubmitPost } from "@/app/api/v1/merchant/businesses/[id]/submit/route";

interface MockDbOptions {
  user?: Partial<User> | null;
  roles?: UserRoleType[];
  businesses?: Business[];
  members?: BusinessMember[];
  verifications?: BusinessVerification[];
  hours?: BusinessHours[];
  rpcResults?: Record<string, { data?: unknown; error?: { code?: string; message?: string } | null }>;
}

function createMockBusinessSupabaseClient(options: MockDbOptions) {
  const mockUser: User | null = options.user
    ? ({
        id: options.user.id ?? "11111111-1111-4111-8111-111111111111",
        email: options.user.email ?? "merchant@example.test",
        app_metadata: {},
        user_metadata: { display_name: "사업자" },
        aud: "authenticated",
        created_at: new Date().toISOString(),
      } as User)
    : null;

  const storedRoles: Array<{ user_id: string; role: UserRoleType }> = (
    options.roles ?? ["customer"]
  ).map((role) => ({
    user_id: mockUser?.id ?? "11111111-1111-4111-8111-111111111111",
    role,
  }));

  const storedBusinesses = [...(options.businesses ?? [])];
  const storedMembers = [...(options.members ?? [])];
  const storedVerifications = [...(options.verifications ?? [])];
  const storedHours = [...(options.hours ?? [])];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const updateCalls: Array<Record<string, unknown>> = [];
  const touchedTables: string[] = [];

  const client = {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: mockUser },
        error: null,
      }),
    },
    rpc: vi.fn((fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      const result = options.rpcResults?.[fn] ?? { data: null, error: { code: "XX000" } };
      return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
    }),
    from: vi.fn((table: string) => {
      touchedTables.push(table);
      if (table === "user_roles") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn((col1: string, val1: string) => ({
              in: vi.fn((col2: string, vals: string[]) => ({
                maybeSingle: vi.fn().mockImplementation(() => {
                  const found = storedRoles.find(
                    (r) => (r as any)[col1] === val1 && vals.includes((r as any)[col2])
                  );
                  return Promise.resolve({ data: found ?? null, error: null });
                }),
              })),
            })),
          })),
        };
      }

      if (table === "profiles") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn().mockResolvedValue({
                data: mockUser
                  ? {
                      display_name: "테스트 사용자",
                      account_status: "active",
                    }
                  : null,
                error: null,
              }),
            })),
          })),
        };
      }

      if (table === "businesses") {
        return {
          select: vi.fn(() => ({
            order: vi.fn(() => Promise.resolve({ data: storedBusinesses, error: null })),
            in: vi.fn((_col: string, ids: string[]) => ({
              order: vi.fn(() =>
                Promise.resolve({
                  data: storedBusinesses.filter((b) => ids.includes(b.id)),
                  error: null,
                })
              ),
            })),
            eq: vi.fn((col: string, val: string) => ({
              maybeSingle: vi.fn().mockImplementation(() => {
                const found = storedBusinesses.find((b) => (b as any)[col] === val);
                return Promise.resolve({ data: found ?? null, error: null });
              }),
            })),
          })),
          update: vi.fn().mockImplementation((updates: any) => {
            updateCalls.push(updates);
            return {
              eq: vi.fn((col: string, val: string) => {
                const idx = storedBusinesses.findIndex((b) => (b as any)[col] === val);
                if (idx >= 0) {
                  storedBusinesses[idx] = {
                    ...storedBusinesses[idx],
                    ...updates,
                  };
                }
                const updated = idx >= 0 ? storedBusinesses[idx] : null;
                return {
                  select: vi.fn(() => ({
                    single: vi.fn().mockResolvedValue({ data: updated, error: null }),
                  })),
                };
              }),
            };
          }),
        };
      }

      if (table === "business_members") {
        const createMemberBuilder = () => {
          const filters: Array<{ col: string; val: any }> = [];
          const builder: any = {
            eq: vi.fn((col: string, val: any) => {
              filters.push({ col, val });
              return builder;
            }),
            maybeSingle: vi.fn().mockImplementation(() => {
              const matches = storedMembers.filter((m) =>
                filters.every((f) => (m as any)[f.col] === f.val)
              );
              return Promise.resolve({ data: matches[0] ?? null, error: null });
            }),
            then: (resolve: any, reject: any) => {
              const matches = storedMembers.filter((m) =>
                filters.every((f) => (m as any)[f.col] === f.val)
              );
              return Promise.resolve({ data: matches, error: null }).then(resolve, reject);
            },
          };
          return builder;
        };

        return {
          select: vi.fn(() => createMemberBuilder()),
        };
      }

      if (table === "business_verifications") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn((col: string, val: string) => ({
              order: vi.fn().mockImplementation(() => {
                const list = storedVerifications.filter(
                  (v) => (v as any)[col] === val
                );
                return Promise.resolve({ data: list, error: null });
              }),
            })),
          })),
        };
      }

      if (table === "business_hours") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn((col: string, val: string) => ({
              order: vi.fn().mockImplementation(() => {
                const list = storedHours.filter(
                  (h) => (h as any)[col] === val
                );
                return Promise.resolve({ data: list, error: null });
              }),
            })),
          })),
        };
      }

      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          })),
        })),
      };
    }),
  } as unknown as SupabaseClient<Database>;

  return {
    client,
    storedRoles,
    storedBusinesses,
    storedMembers,
    storedVerifications,
    storedHours,
    rpcCalls,
    updateCalls,
    touchedTables,
  };
}

describe("TASK 06 — Business Backend Unit & Integration Tests", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    clearIdempotencyStoreForTests();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://wddnbycimcixskemssct.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("1. Zod Input Validation", () => {
    it("validates createBusinessSchema correctly", () => {
      const valid = {
        name: " 수원 행궁 카페 ",
        category: " 카페 ",
        road_address: " 경기도 수원시 팔달구 정조로 123 ",
        latitude: 37.2831,
        longitude: 127.0145,
        phone: "031-123-4567",
      };

      const parsed = createBusinessSchema.safeParse(valid);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.name).toBe("수원 행궁 카페");
        expect(parsed.data.category).toBe("카페");
        expect(parsed.data.road_address).toBe("경기도 수원시 팔달구 정조로 123");
        expect(parsed.data.latitude).toBe(37.2831);
        expect(parsed.data.longitude).toBe(127.0145);
      }
    });

    it("rejects invalid coordinates and missing required fields", () => {
      const invalidLat = {
        name: "테스트 가게",
        category: "카페",
        road_address: "주소",
        latitude: 95.0, // > 90
        longitude: 127.0,
      };
      expect(createBusinessSchema.safeParse(invalidLat).success).toBe(false);

      const invalidLng = {
        name: "테스트 가게",
        category: "카페",
        road_address: "주소",
        latitude: 37.0,
        longitude: 190.0, // > 180
      };
      expect(createBusinessSchema.safeParse(invalidLng).success).toBe(false);

      const missingName = {
        category: "카페",
        road_address: "주소",
        latitude: 37.0,
        longitude: 127.0,
      };
      expect(createBusinessSchema.safeParse(missingName).success).toBe(false);
    });

    it("prevents client from tampering with approval/status fields in updateBusinessSchema", () => {
      const validUpdate = {
        name: "수정된 상호명",
        description: "새로운 설명",
      };
      expect(updateBusinessSchema.safeParse(validUpdate).success).toBe(true);

      const illegalStatusUpdate = {
        registration_status: "approved",
      };
      expect(updateBusinessSchema.safeParse(illegalStatusUpdate).success).toBe(false);

      const illegalApprovedByUpdate = {
        approved_by: "00000000-0000-4000-8000-000000000001",
      };
      expect(updateBusinessSchema.safeParse(illegalApprovedByUpdate).success).toBe(false);
    });
  });

  describe("2. Service Layer: Atomic Registration, No Auto Merchant Grant", () => {
    const userAId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const baseInput = {
      name: "행궁 베이커리",
      category: "베이커리",
      road_address: "수원시 팔달구 화서문로 45",
      latitude: 37.2845,
      longitude: 127.0162,
    };

    it("creates the business through ONE atomic RPC and never touches user_roles", async () => {
      const createdBiz = {
        id: "10000000-0000-4000-8000-0000000000a1",
        ...baseInput,
        registration_status: "draft",
        created_by: userAId,
        approved_by: null,
        approved_at: null,
      };
      const { client, rpcCalls, touchedTables } = createMockBusinessSupabaseClient({
        user: { id: userAId },
        roles: ["customer"],
        rpcResults: { create_business_with_owner: { data: createdBiz } },
      });

      const biz = await createBusinessForMerchant(client, {
        ...baseInput,
        registration_number: "123-45-67890",
      });

      expect(biz.registration_status).toBe("draft");
      expect(rpcCalls).toHaveLength(1);
      expect(rpcCalls[0]?.fn).toBe("create_business_with_owner");
      // Business, first owner and verification are created inside the DB function (single transaction):
      // the service performs no separate table writes that could leave partial data.
      expect(touchedTables).toEqual([]);
      expect(rpcCalls[0]?.args.p_registration_number).toBe("123-45-67890");
    });

    it("sends no creator id, status, approval or merchant-role fields to the database", async () => {
      const { client, rpcCalls } = createMockBusinessSupabaseClient({
        user: { id: userAId },
        rpcResults: { create_business_with_owner: { data: { id: "x" } } },
      });

      await createBusinessForMerchant(client, baseInput);

      const argKeys = Object.keys(rpcCalls[0]?.args ?? {});
      for (const forbidden of [
        "p_created_by",
        "p_user_id",
        "p_registration_status",
        "p_approved_by",
        "p_approved_at",
        "p_role",
        "p_lead_id",
      ]) {
        expect(argKeys).not.toContain(forbidden);
      }
    });

    it("strips client-supplied status/approval/lead/creator fields during zod parsing", () => {
      const parsed = createBusinessSchema.safeParse({
        ...baseInput,
        registration_status: "approved",
        approved_by: "00000000-0000-4000-8000-000000000001",
        created_by: "00000000-0000-4000-8000-000000000002",
        lead_id: "55555555-5555-4555-8555-555555555555",
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).not.toHaveProperty("registration_status");
        expect(parsed.data).not.toHaveProperty("approved_by");
        expect(parsed.data).not.toHaveProperty("created_by");
        expect(parsed.data).not.toHaveProperty("lead_id");
      }
    });

    it("rejects malformed registration numbers and non-http(s) website URLs", () => {
      expect(
        createBusinessSchema.safeParse({ ...baseInput, registration_number: "abc" }).success
      ).toBe(false);
      expect(
        createBusinessSchema.safeParse({ ...baseInput, registration_number: "123-45-67890" })
          .success
      ).toBe(true);
      expect(
        createBusinessSchema.safeParse({ ...baseInput, website_url: "javascript:alert(1)" })
          .success
      ).toBe(false);
      expect(
        createBusinessSchema.safeParse({ ...baseInput, website_url: "https://example.com" })
          .success
      ).toBe(true);
      expect(
        updateBusinessSchema.safeParse({ website_url: "javascript:alert(1)" }).success
      ).toBe(false);
    });

    it("maps database errors to safe messages without leaking raw DB text", async () => {
      const leakyMessage = "duplicate key value violates unique constraint secret_idx (phone=010-1234-5678)";
      const cases: Array<{ code: string; status: number }> = [
        { code: "28000", status: 401 },
        { code: "42501", status: 403 },
        { code: "23514", status: 400 },
        { code: "23502", status: 400 },
        { code: "XX000", status: 500 },
      ];

      for (const { code, status } of cases) {
        const { client } = createMockBusinessSupabaseClient({
          user: { id: userAId },
          rpcResults: {
            create_business_with_owner: { error: { code, message: leakyMessage } },
          },
        });
        const err = await createBusinessForMerchant(client, baseInput).catch((e) => e);
        expect(err).toBeInstanceOf(AuthGuardError);
        expect((err as AuthGuardError).status).toBe(status);
        expect((err as AuthGuardError).userMessage).not.toContain("secret_idx");
        expect((err as AuthGuardError).userMessage).not.toContain("010-1234-5678");
      }
    });
  });

  describe("3. Isolation & Authorization: Member vs Non-Member vs Admin", () => {
    const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const adminUser = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    const bizA: Business = {
      id: "biz-a-100",
      name: "가게 A",
      category: "음식점",
      description: null,
      road_address: "수원시 장안구 1번지",
      jibun_address: null,
      address_detail: null,
      latitude: 37.29,
      longitude: 127.02,
      phone: null,
      website_url: null,
      registration_status: "draft",
      created_by: userA,
      approved_by: null,
      approved_at: null,
      rejection_reason: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const memberA: BusinessMember = {
      business_id: bizA.id,
      user_id: userA,
      role: "owner",
      membership_status: "active",
      joined_at: new Date().toISOString(),
    };

    it("allows owner A to view and update business A", async () => {
      const { client } = createMockBusinessSupabaseClient({
        user: { id: userA },
        roles: ["customer", "merchant"],
        businesses: [bizA],
        members: [memberA],
      });

      const detail = await getBusinessDetailForMerchant(client, bizA.id, userA, false);
      expect(detail.id).toBe(bizA.id);
      expect(detail.my_role).toBe("owner");

      const updated = await updateBusinessForMerchant(
        client,
        bizA.id,
        userA,
        false,
        { name: "가게 A 상호변경" }
      );
      expect(updated.name).toBe("가게 A 상호변경");
    });

    it("strictly blocks user B from viewing or modifying user A's business (403)", async () => {
      const { client, updateCalls } = createMockBusinessSupabaseClient({
        user: { id: userB },
        roles: ["customer", "merchant"],
        businesses: [bizA],
        members: [memberA], // userB is NOT a member
        rpcResults: {
          // The database function rejects non-owners with 42501 (auth.uid() is not an owner).
          submit_business_for_review: { error: { code: "42501", message: "FORBIDDEN" } },
        },
      });

      await expect(
        getBusinessDetailForMerchant(client, bizA.id, userB, false)
      ).rejects.toThrow("해당 가게에 접근할 권한이 없습니다.");

      await expect(
        updateBusinessForMerchant(client, bizA.id, userB, false, {
          name: "무단 상호변경 시도",
        })
      ).rejects.toThrow("해당 가게를 수정할 권한이 없습니다.");
      expect(updateCalls).toHaveLength(0);

      const submitErr = await submitBusinessForMerchant(client, bizA.id).catch((e) => e);
      expect(submitErr).toBeInstanceOf(AuthGuardError);
      expect((submitErr as AuthGuardError).status).toBe(403);
    });

    it("allows member to update non-core fields (description, phone) on approved business without altering approval status", async () => {
      const approvedBiz: Business = {
        ...bizA,
        id: "biz-approved-edit",
        registration_status: "approved",
        approved_by: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        approved_at: new Date().toISOString(),
      };
      const { client, updateCalls } = createMockBusinessSupabaseClient({
        user: { id: userA },
        businesses: [approvedBiz],
        members: [{ ...memberA, business_id: approvedBiz.id }],
      });

      await updateBusinessForMerchant(client, approvedBiz.id, userA, false, {
        description: "승인 가게 새로운 설명",
        phone: "031-999-8888",
        // Smuggled fields must not reach the DB write even if they bypass the type system.
        ...({ registration_status: "approved", approved_by: userA, created_by: userA } as object),
      } as never);

      expect(updateCalls).toHaveLength(1);
      const written = updateCalls[0] ?? {};
      expect(Object.keys(written).sort()).toEqual(["description", "phone"].sort());
      for (const forbidden of [
        "registration_status",
        "approved_by",
        "approved_at",
        "rejection_reason",
        "created_by",
        "updated_at",
      ]) {
        expect(written).not.toHaveProperty(forbidden);
      }
    });

    it("blocks member from altering core approval fields (name, address, coords) on an approved business", async () => {
      const approvedBiz: Business = {
        ...bizA,
        id: "biz-approved-core-blocked",
        registration_status: "approved",
        approved_by: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        approved_at: new Date().toISOString(),
      };
      const { client, updateCalls } = createMockBusinessSupabaseClient({
        user: { id: userA },
        businesses: [approvedBiz],
        members: [{ ...memberA, business_id: approvedBiz.id }],
      });

      // Name change blocked on approved business
      await expect(
        updateBusinessForMerchant(client, approvedBiz.id, userA, false, {
          name: "무단 상호명 변경",
        })
      ).rejects.toThrow("승인 완료된 가게의 핵심 정보");

      // Address change blocked on approved business
      await expect(
        updateBusinessForMerchant(client, approvedBiz.id, userA, false, {
          road_address: "수원시 팔달구 다른주소 99",
        })
      ).rejects.toThrow("승인 완료된 가게의 핵심 정보");

      // Coordinate change blocked on approved business
      await expect(
        updateBusinessForMerchant(client, approvedBiz.id, userA, false, {
          latitude: 37.5,
        })
      ).rejects.toThrow("승인 완료된 가게의 핵심 정보");

      expect(updateCalls).toHaveLength(0);
    });

    it("allows admin to update core fields on an approved business for operational correction", async () => {
      const approvedBiz: Business = {
        ...bizA,
        id: "biz-approved-admin-edit",
        registration_status: "approved",
        approved_by: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        approved_at: new Date().toISOString(),
      };
      const { client, updateCalls } = createMockBusinessSupabaseClient({
        user: { id: adminUser },
        businesses: [approvedBiz],
        members: [{ ...memberA, business_id: approvedBiz.id }],
      });

      const updated = await updateBusinessForMerchant(
        client,
        approvedBiz.id,
        adminUser,
        true, // isAdmin
        { name: "관리자 직권 상호 수정" }
      );

      expect(updated.name).toBe("관리자 직권 상호 수정");
      expect(updateCalls).toHaveLength(1);
    });

    it("allows member to update core fields freely on a draft business before submission", async () => {
      const draftBiz: Business = {
        ...bizA,
        id: "biz-draft-edit",
        registration_status: "draft",
      };
      const { client, updateCalls } = createMockBusinessSupabaseClient({
        user: { id: userA },
        businesses: [draftBiz],
        members: [{ ...memberA, business_id: draftBiz.id }],
      });

      const updated = await updateBusinessForMerchant(
        client,
        draftBiz.id,
        userA,
        false,
        {
          name: "드래프트 상호 자유 수정",
          road_address: "새로운 도로명주소 123",
          latitude: 37.3,
          longitude: 127.1,
        }
      );

      expect(updated.name).toBe("드래프트 상호 자유 수정");
      expect(updateCalls).toHaveLength(1);
    });

    it("skips the write entirely for a no-op edit so approval state is untouched", async () => {
      const approvedBiz: Business = {
        ...bizA,
        id: "biz-approved-noop",
        registration_status: "approved",
        approved_at: new Date().toISOString(),
      };
      const { client, updateCalls } = createMockBusinessSupabaseClient({
        user: { id: userA },
        businesses: [approvedBiz],
        members: [{ ...memberA, business_id: approvedBiz.id }],
      });

      const result = await updateBusinessForMerchant(client, approvedBiz.id, userA, false, {
        name: approvedBiz.name,
      });
      expect(updateCalls).toHaveLength(0);
      expect(result.registration_status).toBe("approved");
    });

    it("blocks members from editing a suspended business", async () => {
      const suspendedBiz: Business = { ...bizA, id: "biz-suspended", registration_status: "suspended" };
      const { client, updateCalls } = createMockBusinessSupabaseClient({
        user: { id: userA },
        businesses: [suspendedBiz],
        members: [{ ...memberA, business_id: suspendedBiz.id }],
      });

      await expect(
        updateBusinessForMerchant(client, suspendedBiz.id, userA, false, { name: "정지 가게 수정" })
      ).rejects.toThrow("이용 정지 상태의 가게는 수정할 수 없습니다.");
      expect(updateCalls).toHaveLength(0);
    });

    it("does not expose private verification columns to merchants", async () => {
      const verification: BusinessVerification = {
        id: "verif-1",
        business_id: bizA.id,
        submitted_by: userA,
        method: "document",
        registration_number: "123-45-67890",
        evidence_storage_path: "private/evidence.png",
        status: "pending",
        reviewed_by: null,
        reviewed_at: null,
        review_notes: "내부 메모",
        created_at: new Date().toISOString(),
      };
      expect(BUSINESS_VERIFICATION_PUBLIC_COLUMNS).toBe(
        "id, business_id, submitted_by, method, status, reviewed_at, created_at"
      );
      for (const privateColumn of [
        "registration_number",
        "evidence_storage_path",
        "review_notes",
        "reviewed_by",
      ]) {
        expect(BUSINESS_VERIFICATION_PUBLIC_COLUMNS).not.toContain(privateColumn);
      }
      // sanity: fixture really contains private values that the explicit column list excludes
      expect(verification.registration_number).toBeTruthy();
    });


    it("allows admin to view and override any business", async () => {
      const { client } = createMockBusinessSupabaseClient({
        user: { id: adminUser },
        roles: ["admin"],
        businesses: [bizA],
        members: [memberA],
      });

      const detail = await getBusinessDetailForMerchant(
        client,
        bizA.id,
        adminUser,
        true
      );
      expect(detail.id).toBe(bizA.id);
      expect(detail.my_role).toBe("admin");

      const list = await listBusinessesForMerchant(client, adminUser, true);
      expect(list.length).toBe(1);
    });
  });

  describe("4. Submit RPC mapping & approved-only gate", () => {
    const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const baseBiz: Business = {
      id: "biz-gate-1",
      name: "게이트 가게",
      category: "카페",
      description: null,
      road_address: "수원시 팔달구 행궁동 10",
      jibun_address: null,
      address_detail: null,
      latitude: 37.28,
      longitude: 127.01,
      phone: null,
      website_url: null,
      registration_status: "draft",
      created_by: userA,
      approved_by: null,
      approved_at: null,
      rejection_reason: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const ownerOf = (businessId: string): BusinessMember => ({
      business_id: businessId,
      user_id: userA,
      role: "owner",
      membership_status: "active",
      joined_at: new Date().toISOString(),
    });

    it("submits via the submit_business_for_review RPC with only the business id", async () => {
      const { client, rpcCalls, touchedTables } = createMockBusinessSupabaseClient({
        user: { id: userA },
        rpcResults: {
          submit_business_for_review: {
            data: { ...baseBiz, registration_status: "pending" },
          },
        },
      });

      const submitted = await submitBusinessForMerchant(client, baseBiz.id);
      expect(submitted.registration_status).toBe("pending");
      expect(rpcCalls).toEqual([
        { fn: "submit_business_for_review", args: { p_business_id: baseBiz.id } },
      ]);
      // Status transition is a single DB call; no client-side status write exists.
      expect(touchedTables).toEqual([]);
    });

    it("maps submit state errors (already pending/approved, suspended, invalid, not found)", async () => {
      const cases: Array<{ code: string; status: number; message: string }> = [
        { code: "HM001", status: 409, message: "이미 관리자 심사 대기 중인 가게입니다." },
        { code: "HM002", status: 409, message: "이미 승인 완료된 가게입니다." },
        { code: "HM003", status: 403, message: "이용 정지 상태의 가게는 심사를 요청할 수 없습니다." },
        { code: "HM005", status: 422, message: "현재 상태에서는 심사를 요청할 수 없습니다." },
        { code: "P0002", status: 404, message: "가게를 찾을 수 없습니다." },
      ];
      for (const { code, status, message } of cases) {
        const { client } = createMockBusinessSupabaseClient({
          user: { id: userA },
          rpcResults: { submit_business_for_review: { error: { code, message: "raw" } } },
        });
        const err = await submitBusinessForMerchant(client, baseBiz.id).catch((e) => e);
        expect(err).toBeInstanceOf(AuthGuardError);
        expect((err as AuthGuardError).status).toBe(status);
        expect((err as AuthGuardError).userMessage).toBe(message);
      }
    });

    it("denies approved-only features to members of draft/pending/rejected/suspended businesses", async () => {
      for (const status of ["draft", "pending", "rejected", "suspended"] as const) {
        const biz: Business = { ...baseBiz, id: `biz-${status}`, registration_status: status };
        const { client } = createMockBusinessSupabaseClient({
          user: { id: userA },
          roles: ["customer", "merchant"],
          businesses: [biz],
          members: [ownerOf(biz.id)],
        });
        await expect(
          requireApprovedBusinessMembership(client, biz.id, userA)
        ).rejects.toThrow("관리자 승인이 완료된 가게만 이용할 수 있는 기능입니다.");
      }
    });

    it("denies approved-only features if the user lacks the merchant role even if registered as member", async () => {
      const approved: Business = {
        ...baseBiz,
        id: "biz-approved-no-merchant-role",
        registration_status: "approved",
        approved_at: new Date().toISOString(),
      };
      const { client } = createMockBusinessSupabaseClient({
        user: { id: userA },
        roles: ["customer"], // lacks 'merchant' role
        businesses: [approved],
        members: [ownerOf(approved.id)],
      });

      await expect(
        requireApprovedBusinessMembership(client, approved.id, userA)
      ).rejects.toThrow("제휴 사업자 권한이 없습니다.");
    });

    it("allows approved-only features for active members with merchant role on an approved business only", async () => {
      const approved: Business = {
        ...baseBiz,
        id: "biz-approved-gate",
        registration_status: "approved",
        approved_at: new Date().toISOString(),
      };
      const { client } = createMockBusinessSupabaseClient({
        user: { id: userA },
        roles: ["customer", "merchant"],
        businesses: [approved],
        members: [ownerOf(approved.id)],
      });

      await expect(requireApprovedBusinessMembership(client, approved.id, userA)).resolves.toEqual({
        role: "owner",
      });

      // A different user is not a member of the approved business.
      await expect(
        requireApprovedBusinessMembership(
          client,
          approved.id,
          "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        )
      ).rejects.toThrow("제휴 사업자 권한이 없습니다.");
    });

    it("requires an owner when ownerOnly is requested", async () => {
      const approved: Business = {
        ...baseBiz,
        id: "biz-approved-manager",
        registration_status: "approved",
        approved_at: new Date().toISOString(),
      };
      const { client } = createMockBusinessSupabaseClient({
        user: { id: userA },
        roles: ["merchant"],
        businesses: [approved],
        members: [{ ...ownerOf(approved.id), role: "manager" }],
      });

      await expect(
        requireApprovedBusinessMembership(client, approved.id, userA, { ownerOnly: true })
      ).rejects.toThrow("해당 작업은 가게 소유자만 수행할 수 있습니다.");
    });
  });

  describe("5. Route Handlers: Missing Config, Invalid UUID & PII Safety", () => {
    it("returns 503 CONFIG_REQUIRED on all merchant routes when Supabase keys are missing", async () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

      const listRes = await businessesGet(
        new Request("http://localhost/api/v1/merchant/businesses")
      );
      expect(listRes.status).toBe(503);
      const listJson = await listRes.json();
      expect(listJson.error.code).toBe("CONFIG_REQUIRED");

      const createRes = await businessesPost(
        new Request("http://localhost/api/v1/merchant/businesses", {
          method: "POST",
          body: JSON.stringify({ name: "가게" }),
        })
      );
      expect(createRes.status).toBe(503);

      const detailRes = await businessDetailGet(
        new Request("http://localhost/api/v1/merchant/businesses/10000000-0000-4000-8000-000000000001"),
        { params: Promise.resolve({ id: "10000000-0000-4000-8000-000000000001" }) }
      );
      expect(detailRes.status).toBe(503);

      const patchRes = await businessDetailPatch(
        new Request("http://localhost/api/v1/merchant/businesses/10000000-0000-4000-8000-000000000001", {
          method: "PATCH",
          body: JSON.stringify({ name: "수정" }),
        }),
        { params: Promise.resolve({ id: "10000000-0000-4000-8000-000000000001" }) }
      );
      expect(patchRes.status).toBe(503);

      const submitRes = await businessSubmitPost(
        new Request("http://localhost/api/v1/merchant/businesses/10000000-0000-4000-8000-000000000001/submit", {
          method: "POST",
        }),
        { params: Promise.resolve({ id: "10000000-0000-4000-8000-000000000001" }) }
      );
      expect(submitRes.status).toBe(503);
    });

    it("returns 400 VALIDATION_ERROR on malformed UUID parameter", async () => {
      const detailRes = await businessDetailGet(
        new Request("http://localhost/api/v1/merchant/businesses/not-a-uuid"),
        { params: Promise.resolve({ id: "not-a-uuid" }) }
      );
      expect(detailRes.status).toBe(400);
      const json = await detailRes.json();
      expect(json.error.code).toBe("VALIDATION_ERROR");

      const submitRes = await businessSubmitPost(
        new Request("http://localhost/api/v1/merchant/businesses/invalid-id/submit", {
          method: "POST",
        }),
        { params: Promise.resolve({ id: "invalid-id" }) }
      );
      expect(submitRes.status).toBe(400);
    });
  });
});
