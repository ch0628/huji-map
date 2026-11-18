import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  adminRestroomListFilterSchema,
  adminRestroomDecisionSchema,
  listRestroomsForAdmin,
  getRestroomDetailForAdmin,
  decideRestroomReview,
  AdminRestroomError,
} from "@/lib/restrooms";

describe("TASK 14: Restroom Admin Review & Approval Unit Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("1. Validation Schemas", () => {
    it("adminRestroomListFilterSchema parses default values correctly", () => {
      const parsed = adminRestroomListFilterSchema.parse({});
      expect(parsed.status).toBe("pending");
      expect(parsed.type).toBe("all");
      expect(parsed.limit).toBe(50);
      expect(parsed.offset).toBe(0);
    });

    it("adminRestroomListFilterSchema clamps and validates options", () => {
      const parsed = adminRestroomListFilterSchema.parse({
        status: "published",
        type: "partner",
        limit: "100",
        offset: "10",
        q: "수원역",
      });
      expect(parsed.status).toBe("published");
      expect(parsed.type).toBe("partner");
      expect(parsed.limit).toBe(100);
      expect(parsed.offset).toBe(10);
      expect(parsed.q).toBe("수원역");
    });

    it("adminRestroomDecisionSchema validates 'publish' without reason", () => {
      const validPublish = adminRestroomDecisionSchema.safeParse({
        decision: "publish",
        review_notes: "현장 검수 완료",
      });
      expect(validPublish.success).toBe(true);
      if (validPublish.success) {
        expect(validPublish.data.decision).toBe("publish");
        expect(validPublish.data.review_notes).toBe("현장 검수 완료");
      }
    });

    it("adminRestroomDecisionSchema requires reason for 'reject' (minimum 2 chars)", () => {
      const missingReason = adminRestroomDecisionSchema.safeParse({
        decision: "reject",
      });
      expect(missingReason.success).toBe(false);

      const emptyReason = adminRestroomDecisionSchema.safeParse({
        decision: "reject",
        reason: " ",
      });
      expect(emptyReason.success).toBe(false);

      const singleCharReason = adminRestroomDecisionSchema.safeParse({
        decision: "reject",
        reason: "반",
      });
      expect(singleCharReason.success).toBe(false);

      const singleCharTrimReason = adminRestroomDecisionSchema.safeParse({
        decision: "reject",
        reason: " 반 ",
      });
      expect(singleCharTrimReason.success).toBe(false);

      const exactTwoCharReject = adminRestroomDecisionSchema.safeParse({
        decision: "reject",
        reason: "반려",
      });
      expect(exactTwoCharReject.success).toBe(true);

      const validReject = adminRestroomDecisionSchema.safeParse({
        decision: "reject",
        reason: "위치 좌표가 정확하지 않습니다.",
      });
      expect(validReject.success).toBe(true);
    });

    it("adminRestroomDecisionSchema requires reason for 'suspend' (minimum 2 chars)", () => {
      const missingReason = adminRestroomDecisionSchema.safeParse({
        decision: "suspend",
      });
      expect(missingReason.success).toBe(false);

      const emptyReason = adminRestroomDecisionSchema.safeParse({
        decision: "suspend",
        reason: "   ",
      });
      expect(emptyReason.success).toBe(false);

      const singleCharReason = adminRestroomDecisionSchema.safeParse({
        decision: "suspend",
        reason: "휴",
      });
      expect(singleCharReason.success).toBe(false);

      const exactTwoCharSuspend = adminRestroomDecisionSchema.safeParse({
        decision: "suspend",
        reason: "공사",
      });
      expect(exactTwoCharSuspend.success).toBe(true);

      const validSuspend = adminRestroomDecisionSchema.safeParse({
        decision: "suspend",
        reason: "매장 리모델링 공사로 인한 임시 이용 중단",
      });
      expect(validSuspend.success).toBe(true);
    });

    it("adminRestroomDecisionSchema rejects invalid decision strings", () => {
      const invalid = adminRestroomDecisionSchema.safeParse({
        decision: "delete",
      });
      expect(invalid.success).toBe(false);
    });
  });

  describe("2. Service Logic: listRestroomsForAdmin", () => {
    it("fetches restrooms and batch-joins business, applicant, and active policy", async () => {
      const mockRestroom = {
        id: "11111111-1111-1111-1111-111111111111",
        business_id: "22222222-2222-2222-2222-222222222222",
        source_id: null,
        type: "partner",
        name: "수원역 1층 화장실",
        road_address: "매산로 1",
        address_detail: "101호",
        latitude: 37.2636,
        longitude: 127.0286,
        floor: "1층",
        gender_type: "separate",
        access_method: "ask_staff",
        wheelchair_accessible: true,
        baby_changing_available: false,
        sanitary_products_available: true,
        publication_status: "pending",
        last_verified_at: null,
        created_by: "33333333-3333-3333-3333-333333333333",
        approved_by: null,
        created_at: "2026-11-11T00:00:00Z",
        updated_at: "2026-11-11T00:00:00Z",
      };

      const mockBusiness = {
        id: "22222222-2222-2222-2222-222222222222",
        name: "수원역 카페",
        registration_status: "approved",
      };

      const mockProfile = {
        id: "33333333-3333-3333-3333-333333333333",
        display_name: "점주 홍길동",
      };

      const mockPolicy = {
        restroom_id: "11111111-1111-1111-1111-111111111111",
        access_mode: "test_deposit",
        deposit_amount_krw: 1000,
      };

      const supabaseMock = {
        from: vi.fn((table: string) => {
          if (table === "restrooms") {
            return {
              select: vi.fn().mockReturnThis(),
              order: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              range: vi.fn().mockResolvedValue({
                data: [mockRestroom],
                error: null,
                count: 1,
              }),
            };
          }
          if (table === "businesses") {
            return {
              select: vi.fn().mockReturnThis(),
              in: vi.fn().mockResolvedValue({ data: [mockBusiness], error: null }),
            };
          }
          if (table === "profiles") {
            return {
              select: vi.fn().mockReturnThis(),
              in: vi.fn().mockResolvedValue({ data: [mockProfile], error: null }),
            };
          }
          if (table === "restroom_access_policies") {
            return {
              select: vi.fn().mockReturnThis(),
              in: vi.fn().mockReturnThis(),
              eq: vi.fn().mockResolvedValue({ data: [mockPolicy], error: null }),
            };
          }
          if (table === "restroom_photos") {
            return {
              select: vi.fn().mockReturnThis(),
              in: vi.fn().mockReturnThis(),
              eq: vi.fn().mockResolvedValue({ data: [], error: null }),
            };
          }
          return {};
        }),
      };

      const result = await listRestroomsForAdmin(supabaseMock as any, {
        status: "pending",
        type: "all",
        limit: 50,
        offset: 0,
      });

      expect(result.count).toBe(1);
      expect(result.restrooms[0].name).toBe("수원역 1층 화장실");
      expect(result.restrooms[0].business_name).toBe("수원역 카페");
      expect(result.restrooms[0].applicant_name).toBe("점주 홍길동");
      expect(result.restrooms[0].active_deposit_amount_krw).toBe(1000);
    });
  });

  describe("3. Service Logic: decideRestroomReview", () => {
    const adminId = "admin-uuid-1111";
    const restroomId = "restroom-uuid-2222";

    it("rejects 'publish' if restroom is already published (ALREADY_IN_STATE)", async () => {
      const alreadyPublished = {
        id: restroomId,
        publication_status: "published",
        name: "화장실",
        road_address: "도로명 1",
        latitude: 37.26,
        longitude: 127.02,
      };

      const supabaseMock = {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: alreadyPublished, error: null }),
        })),
      };

      try {
        await decideRestroomReview(supabaseMock as any, adminId, restroomId, { decision: "publish" });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AdminRestroomError);
        expect((err as AdminRestroomError).code).toBe("ALREADY_IN_STATE");
        expect((err as AdminRestroomError).statusCode).toBe(409);
      }
    });

    it("rejects 'publish' from draft status (INVALID_STATUS_TRANSITION 422)", async () => {
      const draftRestroom = {
        id: restroomId,
        publication_status: "draft",
        name: "화장실",
        road_address: "도로명 1",
        latitude: 37.26,
        longitude: 127.02,
      };

      const supabaseMock = {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: draftRestroom, error: null }),
        })),
      };

      try {
        await decideRestroomReview(supabaseMock as any, adminId, restroomId, { decision: "publish" });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AdminRestroomError);
        expect((err as AdminRestroomError).code).toBe("INVALID_STATUS_TRANSITION");
        expect((err as AdminRestroomError).statusCode).toBe(422);
      }
    });

    it("rejects 'publish' from archived status (INVALID_STATUS_TRANSITION 422)", async () => {
      const archivedRestroom = {
        id: restroomId,
        publication_status: "archived",
        name: "폐쇄 화장실",
        road_address: "도로명 1",
        latitude: 37.26,
        longitude: 127.02,
      };

      const supabaseMock = {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: archivedRestroom, error: null }),
        })),
      };

      try {
        await decideRestroomReview(supabaseMock as any, adminId, restroomId, { decision: "publish" });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AdminRestroomError);
        expect((err as AdminRestroomError).code).toBe("INVALID_STATUS_TRANSITION");
        expect((err as AdminRestroomError).statusCode).toBe(422);
      }
    });

    it("rejects 'publish' if coordinates are missing (null)", async () => {
      const missingCoords = {
        id: restroomId,
        publication_status: "pending",
        name: "화장실",
        road_address: "도로명 1",
        latitude: null,
        longitude: null,
      };

      const supabaseMock = {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: missingCoords, error: null }),
        })),
      };

      await expect(
        decideRestroomReview(supabaseMock as any, adminId, restroomId, { decision: "publish" })
      ).rejects.toThrow("좌표가 등록되어야");
    });

    it("rejects 'publish' if partner restroom business is not approved", async () => {
      const partnerRestroom = {
        id: restroomId,
        type: "partner",
        business_id: "biz-uuid-unapproved",
        publication_status: "pending",
        name: "화장실",
        road_address: "도로명 1",
        latitude: 37.26,
        longitude: 127.02,
      };

      const unapprovedBiz = {
        id: "biz-uuid-unapproved",
        registration_status: "draft", // Not approved!
      };

      const supabaseMock = {
        from: vi.fn((table: string) => {
          if (table === "restrooms") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: partnerRestroom, error: null }),
            };
          }
          if (table === "businesses") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: unapprovedBiz, error: null }),
            };
          }
          return {};
        }),
      };

      await expect(
        decideRestroomReview(supabaseMock as any, adminId, restroomId, { decision: "publish" })
      ).rejects.toThrow("소속 가게가 관리자 승인(approved) 상태여야");
    });

    it("rejects 'publish' if no active policy exists", async () => {
      const partnerRestroom = {
        id: restroomId,
        type: "partner",
        business_id: "biz-uuid-approved",
        publication_status: "pending",
        name: "화장실",
        road_address: "도로명 1",
        latitude: 37.26,
        longitude: 127.02,
      };

      const approvedBiz = {
        id: "biz-uuid-approved",
        registration_status: "approved",
      };

      const supabaseMock = {
        from: vi.fn((table: string) => {
          if (table === "restrooms") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: partnerRestroom, error: null }),
            };
          }
          if (table === "businesses") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: approvedBiz, error: null }),
            };
          }
          if (table === "restroom_access_policies") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }), // No active policy!
            };
          }
          return {};
        }),
      };

      await expect(
        decideRestroomReview(supabaseMock as any, adminId, restroomId, { decision: "publish" })
      ).rejects.toThrow("활성화된 화장실 이용 정책이 존재해야");
    });

    it("successfully approves and publishes valid restroom and writes audit log", async () => {
      const validPendingRestroom = {
        id: restroomId,
        type: "partner",
        business_id: "biz-uuid-approved",
        publication_status: "pending",
        name: "검수 완료 화장실",
        road_address: "도로명 1",
        latitude: 37.26,
        longitude: 127.02,
      };

      const approvedBiz = {
        id: "biz-uuid-approved",
        registration_status: "approved",
      };

      const activePolicy = {
        id: "policy-1",
        is_active: true,
      };

      const publishedRestroom = {
        ...validPendingRestroom,
        publication_status: "published",
        approved_by: adminId,
        last_verified_at: "2026-11-11T05:00:00Z",
      };

      let insertedAudit: any = null;

      const supabaseMock = {
        from: vi.fn((table: string) => {
          if (table === "restrooms") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: validPendingRestroom, error: null }),
              update: vi.fn(() => ({
                eq: vi.fn(() => ({
                  select: vi.fn(() => ({
                    single: vi.fn().mockResolvedValue({ data: publishedRestroom, error: null }),
                  })),
                })),
              })),
            };
          }
          if (table === "businesses") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: approvedBiz, error: null }),
            };
          }
          if (table === "restroom_access_policies") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: activePolicy, error: null }),
            };
          }
          if (table === "audit_logs") {
            return {
              insert: vi.fn((row) => {
                insertedAudit = row;
                return Promise.resolve({ error: null });
              }),
            };
          }
          return {};
        }),
      };

      const result = await decideRestroomReview(supabaseMock as any, adminId, restroomId, {
        decision: "publish",
        review_notes: "현장 검수 완료 후 게시 승인",
      });

      expect(result.publication_status).toBe("published");
      expect(result.approved_by).toBe(adminId);
      expect(insertedAudit).toBeDefined();
      expect(insertedAudit.action).toBe("restroom_published");
      expect(insertedAudit.entity_type).toBe("restrooms");
      expect(insertedAudit.entity_id).toBe(restroomId);
      expect(insertedAudit.reason).toBe("현장 검수 완료 후 게시 승인");
    });

    it("successfully rejects restroom and sets status to draft with reason in audit log", async () => {
      const validPendingRestroom = {
        id: restroomId,
        type: "partner",
        publication_status: "pending",
        name: "화장실",
      };

      const rejectedRestroom = {
        ...validPendingRestroom,
        publication_status: "draft",
        approved_by: null,
      };

      let insertedAudit: any = null;

      const supabaseMock = {
        from: vi.fn((table: string) => {
          if (table === "restrooms") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: validPendingRestroom, error: null }),
              update: vi.fn(() => ({
                eq: vi.fn(() => ({
                  select: vi.fn(() => ({
                    single: vi.fn().mockResolvedValue({ data: rejectedRestroom, error: null }),
                  })),
                })),
              })),
            };
          }
          if (table === "audit_logs") {
            return {
              insert: vi.fn((row) => {
                insertedAudit = row;
                return Promise.resolve({ error: null });
              }),
            };
          }
          return {};
        }),
      };

      const result = await decideRestroomReview(supabaseMock as any, adminId, restroomId, {
        decision: "reject",
        reason: "입구 안내 문구가 불명확합니다. 상세 위치 추가 후 재제출 바랍니다.",
      });

      expect(result.publication_status).toBe("draft");
      expect(result.approved_by).toBeNull();
      expect(insertedAudit).toBeDefined();
      expect(insertedAudit.action).toBe("restroom_rejected");
      expect(insertedAudit.reason).toContain("입구 안내 문구가 불명확");
    });

    it("successfully suspends published restroom with reason in audit log", async () => {
      const publishedRestroom = {
        id: restroomId,
        publication_status: "published",
        name: "공개 화장실",
      };

      const suspendedRestroom = {
        ...publishedRestroom,
        publication_status: "suspended",
      };

      let insertedAudit: any = null;

      const supabaseMock = {
        from: vi.fn((table: string) => {
          if (table === "restrooms") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: publishedRestroom, error: null }),
              update: vi.fn(() => ({
                eq: vi.fn(() => ({
                  select: vi.fn(() => ({
                    single: vi.fn().mockResolvedValue({ data: suspendedRestroom, error: null }),
                  })),
                })),
              })),
            };
          }
          if (table === "audit_logs") {
            return {
              insert: vi.fn((row) => {
                insertedAudit = row;
                return Promise.resolve({ error: null });
              }),
            };
          }
          return {};
        }),
      };

      const result = await decideRestroomReview(supabaseMock as any, adminId, restroomId, {
        decision: "suspend",
        reason: "내부 수리 공사로 인한 일시 이용 중단",
      });

      expect(result.publication_status).toBe("suspended");
      expect(insertedAudit.action).toBe("restroom_suspended");
      expect(insertedAudit.reason).toBe("내부 수리 공사로 인한 일시 이용 중단");
    });

    it("rejects 'reject' if restroom is already published (INVALID_STATUS_TRANSITION 422)", async () => {
      const publishedRestroom = {
        id: restroomId,
        publication_status: "published",
        name: "공개 화장실",
      };

      const supabaseMock = {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: publishedRestroom, error: null }),
        })),
      };

      try {
        await decideRestroomReview(supabaseMock as any, adminId, restroomId, {
          decision: "reject",
          reason: "공개 중인 화장실을 반려 시도",
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AdminRestroomError);
        expect((err as AdminRestroomError).code).toBe("INVALID_STATUS_TRANSITION");
        expect((err as AdminRestroomError).statusCode).toBe(422);
      }
    });

    it("rejects 'reject' if restroom is draft or suspended (INVALID_STATUS_TRANSITION 422)", async () => {
      const suspendedRestroom = {
        id: restroomId,
        publication_status: "suspended",
        name: "중단된 화장실",
      };

      const supabaseMock = {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: suspendedRestroom, error: null }),
        })),
      };

      try {
        await decideRestroomReview(supabaseMock as any, adminId, restroomId, {
          decision: "reject",
          reason: "중단된 화장실을 반려 시도",
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AdminRestroomError);
        expect((err as AdminRestroomError).code).toBe("INVALID_STATUS_TRANSITION");
        expect((err as AdminRestroomError).statusCode).toBe(422);
      }
    });

    it("rejects 'suspend' if restroom is already suspended (ALREADY_IN_STATE 409)", async () => {
      const suspendedRestroom = {
        id: restroomId,
        publication_status: "suspended",
        name: "중단된 화장실",
      };

      const supabaseMock = {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: suspendedRestroom, error: null }),
        })),
      };

      try {
        await decideRestroomReview(supabaseMock as any, adminId, restroomId, {
          decision: "suspend",
          reason: "중복 중단 시도",
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AdminRestroomError);
        expect((err as AdminRestroomError).code).toBe("ALREADY_IN_STATE");
        expect((err as AdminRestroomError).statusCode).toBe(409);
      }
    });

    it("rejects 'suspend' if restroom is in pending or draft status (INVALID_STATUS_TRANSITION 422)", async () => {
      const pendingRestroom = {
        id: restroomId,
        publication_status: "pending",
        name: "대기 화장실",
      };

      const supabaseMock = {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: pendingRestroom, error: null }),
        })),
      };

      try {
        await decideRestroomReview(supabaseMock as any, adminId, restroomId, {
          decision: "suspend",
          reason: "대기 상태에서 중단 시도",
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AdminRestroomError);
        expect((err as AdminRestroomError).code).toBe("INVALID_STATUS_TRANSITION");
        expect((err as AdminRestroomError).statusCode).toBe(422);
      }
    });

    it("successfully re-publishes suspended restroom if prerequisites are met", async () => {
      const suspendedRestroom = {
        id: restroomId,
        type: "partner",
        business_id: "biz-uuid-approved",
        publication_status: "suspended",
        name: "재공개 화장실",
        road_address: "도로명 1",
        latitude: 37.26,
        longitude: 127.02,
      };

      const approvedBiz = {
        id: "biz-uuid-approved",
        registration_status: "approved",
      };

      const activePolicy = {
        id: "policy-1",
        is_active: true,
      };

      const publishedRestroom = {
        ...suspendedRestroom,
        publication_status: "published",
        approved_by: adminId,
      };

      let insertedAudit: any = null;

      const supabaseMock = {
        from: vi.fn((table: string) => {
          if (table === "restrooms") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: suspendedRestroom, error: null }),
              update: vi.fn(() => ({
                eq: vi.fn(() => ({
                  select: vi.fn(() => ({
                    single: vi.fn().mockResolvedValue({ data: publishedRestroom, error: null }),
                  })),
                })),
              })),
            };
          }
          if (table === "businesses") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: approvedBiz, error: null }),
            };
          }
          if (table === "restroom_access_policies") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: activePolicy, error: null }),
            };
          }
          if (table === "audit_logs") {
            return {
              insert: vi.fn((row) => {
                insertedAudit = row;
                return Promise.resolve({ error: null });
              }),
            };
          }
          return {};
        }),
      };

      const result = await decideRestroomReview(supabaseMock as any, adminId, restroomId, {
        decision: "publish",
        review_notes: "시설 보수 확인 후 재개시",
      });

      expect(result.publication_status).toBe("published");
      expect(insertedAudit.action).toBe("restroom_published");
    });

    it("correctly maps RPC error codes HM001, HM002, 22023, HM007 to AdminRestroomError", async () => {
      const mockWithRpcError = (code: string, message: string) => ({
        rpc: vi.fn().mockResolvedValue({
          data: null,
          error: { code, message },
        }),
        from: vi.fn(),
      });

      // HM001 -> 422 INVALID_STATUS_TRANSITION
      await expect(
        decideRestroomReview(
          mockWithRpcError("HM001", "INVALID_STATUS_TRANSITION") as any,
          adminId,
          restroomId,
          { decision: "publish" }
        )
      ).rejects.toMatchObject({
        code: "INVALID_STATUS_TRANSITION",
        statusCode: 422,
      });

      // HM002 -> 409 ALREADY_IN_STATE
      await expect(
        decideRestroomReview(
          mockWithRpcError("HM002", "ALREADY_PUBLISHED") as any,
          adminId,
          restroomId,
          { decision: "publish" }
        )
      ).rejects.toMatchObject({
        code: "ALREADY_IN_STATE",
        statusCode: 409,
      });

      // 22023 -> 400 INVALID_INPUT
      await expect(
        decideRestroomReview(
          mockWithRpcError("22023", "INVALID_DECISION") as any,
          adminId,
          restroomId,
          { decision: "publish" }
        )
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        statusCode: 400,
      });

      // HM006 -> 422 REASON_REQUIRED
      await expect(
        decideRestroomReview(
          mockWithRpcError("HM006", "REJECTION_REASON_REQUIRED") as any,
          adminId,
          restroomId,
          { decision: "reject", reason: "반려사유" }
        )
      ).rejects.toMatchObject({
        code: "REASON_REQUIRED",
        statusCode: 422,
      });

      // HM007 -> 422 BUSINESS_NOT_APPROVED
      await expect(
        decideRestroomReview(
          mockWithRpcError("HM007", "BUSINESS_NOT_APPROVED") as any,
          adminId,
          restroomId,
          { decision: "publish" }
        )
      ).rejects.toMatchObject({
        code: "BUSINESS_NOT_APPROVED",
        statusCode: 422,
      });
    });
  });

  describe("4. Detail Query: getRestroomDetailForAdmin", () => {
    it("returns 404 if restroom does not exist", async () => {
      const supabaseMock = {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        })),
      };

      await expect(
        getRestroomDetailForAdmin(supabaseMock as any, "non-existent-uuid")
      ).rejects.toThrow("화장실 정보를 찾을 수 없습니다.");
    });

    it("returns full detail with business, hours, policies, and audit logs", async () => {
      const mockRestroom = {
        id: "restroom-1",
        business_id: "biz-1",
        name: "상세 테스트 화장실",
      };

      const mockBusiness = {
        id: "biz-1",
        name: "테스트 가게",
        category: "음식점",
        road_address: "도로 1",
        registration_status: "approved",
      };

      const mockHours = [{ id: "h-1", weekday: 1, opens_at: "09:00:00", closes_at: "22:00:00" }];
      const mockPolicies = [{ id: "pol-1", version: 1, access_mode: "free", is_active: true }];
      const mockAuditLogs = [{ id: "aud-1", action: "restroom_published", created_at: "2026-11-11" }];

      const supabaseMock = {
        from: vi.fn((table: string) => {
          if (table === "restrooms") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: mockRestroom, error: null }),
            };
          }
          if (table === "businesses") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: mockBusiness, error: null }),
            };
          }
          if (table === "profiles") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            };
          }
          if (table === "restroom_hours") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              order: vi.fn().mockResolvedValue({ data: mockHours, error: null }),
            };
          }
          if (table === "restroom_hour_exceptions") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              order: vi.fn().mockResolvedValue({ data: [], error: null }),
            };
          }
          if (table === "restroom_access_policies") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              order: vi.fn().mockResolvedValue({ data: mockPolicies, error: null }),
            };
          }
          if (table === "restroom_photos") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              order: vi.fn().mockResolvedValue({ data: [], error: null }),
            };
          }
          if (table === "audit_logs") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              order: vi.fn().mockResolvedValue({ data: mockAuditLogs, error: null }),
            };
          }
          return {};
        }),
      };

      const detail = await getRestroomDetailForAdmin(supabaseMock as any, "restroom-1");
      expect(detail.id).toBe("restroom-1");
      expect(detail.business?.name).toBe("테스트 가게");
      expect(detail.hours).toHaveLength(1);
      expect(detail.policies).toHaveLength(1);
      expect(detail.audit_logs).toHaveLength(1);
    });
  });
});

