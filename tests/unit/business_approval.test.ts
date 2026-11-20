import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";
import {
  adminBusinessDecisionSchema,
  adminBusinessListFilterSchema,
  decideBusinessApproval,
  getBusinessDetailForAdmin,
  listBusinessesForAdmin,
} from "@/lib/businesses";
import { AuthGuardError } from "@/lib/auth/guards";

describe("TASK 08: Business Approval Validation & Admin Services", () => {
  describe("1. adminBusinessDecisionSchema Validation", () => {
    it("accepts valid approval decision with optional review notes", () => {
      const result = adminBusinessDecisionSchema.safeParse({
        decision: "approved",
        review_notes: "서류 및 사업자등록번호 일치 확인 완료",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.decision).toBe("approved");
        expect(result.data.review_notes).toBe("서류 및 사업자등록번호 일치 확인 완료");
        expect(result.data.rejection_reason).toBeUndefined();
      }
    });

    it("accepts valid approval decision without any notes", () => {
      const result = adminBusinessDecisionSchema.safeParse({
        decision: "approved",
      });
      expect(result.success).toBe(true);
    });

    it("accepts valid rejection decision when rejection_reason is provided", () => {
      const result = adminBusinessDecisionSchema.safeParse({
        decision: "rejected",
        rejection_reason: "제출된 사업자등록번호가 국세청 조회 결과 폐업 상태입니다.",
        review_notes: "전화 통화 후 최종 반려 처리",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.decision).toBe("rejected");
        expect(result.data.rejection_reason).toBe(
          "제출된 사업자등록번호가 국세청 조회 결과 폐업 상태입니다."
        );
      }
    });

    it("strictly rejects rejection decision when rejection_reason is missing", () => {
      const result = adminBusinessDecisionSchema.safeParse({
        decision: "rejected",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("반려 사유(rejection_reason)는 필수");
      }
    });

    it("strictly rejects rejection decision when rejection_reason is empty or whitespace", () => {
      const result = adminBusinessDecisionSchema.safeParse({
        decision: "rejected",
        rejection_reason: "   ",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("반려 사유(rejection_reason)는 필수");
      }
    });

    it("strictly rejects invalid decision verbs", () => {
      const result = adminBusinessDecisionSchema.safeParse({
        decision: "pending",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("approved' 또는 'rejected'");
      }
    });

    it("strictly rejects null, empty or missing decision values", () => {
      expect(adminBusinessDecisionSchema.safeParse({ decision: null }).success).toBe(false);
      expect(adminBusinessDecisionSchema.safeParse({ decision: "" }).success).toBe(false);
      expect(adminBusinessDecisionSchema.safeParse({ decision: "   " }).success).toBe(false);
      expect(adminBusinessDecisionSchema.safeParse({}).success).toBe(false);
    });
  });

  describe("2. adminBusinessListFilterSchema Validation", () => {
    it("defaults to status='pending' and limit=50", () => {
      const result = adminBusinessListFilterSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe("pending");
        expect(result.data.limit).toBe(50);
      }
    });

    it("accepts valid status filters and search keyword", () => {
      const result = adminBusinessListFilterSchema.safeParse({
        status: "approved",
        q: "수원 베이커리",
        limit: "100",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe("approved");
        expect(result.data.q).toBe("수원 베이커리");
        expect(result.data.limit).toBe(100);
      }
    });

    it("caps limit to maximum 200", () => {
      const result = adminBusinessListFilterSchema.safeParse({
        limit: "500",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("3. listBusinessesForAdmin Service", () => {
    it("queries businesses and enriches applicant display_name", async () => {
      const mockBusinesses = [
        {
          id: "biz-1",
          name: "스타카페",
          category: "카페",
          road_address: "서울시 종로구 1",
          registration_status: "pending",
          created_by: "user-uuid-1",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];

      const mockProfiles = [
        {
          id: "user-uuid-1",
          display_name: "홍길동",
        },
      ];

      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === "businesses") {
            return {
              select: vi.fn().mockReturnThis(),
              order: vi.fn().mockReturnThis(),
              limit: vi.fn().mockReturnThis(),
              eq: vi.fn().mockResolvedValue({ data: mockBusinesses, error: null }),
            };
          }
          if (table === "profiles") {
            return {
              select: vi.fn().mockReturnThis(),
              in: vi.fn().mockResolvedValue({ data: mockProfiles, error: null }),
            };
          }
          return {};
        }),
      } as unknown as SupabaseClient<Database>;

      const result = await listBusinessesForAdmin(mockSupabase, { status: "pending" });
      expect(result.count).toBe(1);
      expect(result.businesses[0].id).toBe("biz-1");
      expect(result.businesses[0].applicant_name).toBe("홍길동");
      expect(result.businesses[0].role).toBe("admin");
    });

    it("filters businesses in-memory by query keyword q", async () => {
      const mockBusinesses = [
        {
          id: "biz-1",
          name: "휴지카페",
          category: "카페",
          road_address: "수원시 팔달구 매산로 1",
          registration_status: "pending",
          created_by: "user-1",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          id: "biz-2",
          name: "맛있는 베이커리",
          category: "베이커리",
          road_address: "서울시 강남구 테헤란로 1",
          registration_status: "pending",
          created_by: "user-2",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];

      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === "businesses") {
            return {
              select: vi.fn().mockReturnThis(),
              order: vi.fn().mockReturnThis(),
              limit: vi.fn().mockReturnThis(),
              eq: vi.fn().mockResolvedValue({ data: mockBusinesses, error: null }),
            };
          }
          if (table === "profiles") {
            return {
              select: vi.fn().mockReturnThis(),
              in: vi.fn().mockResolvedValue({ data: [], error: null }),
            };
          }
          return {};
        }),
      } as unknown as SupabaseClient<Database>;

      const result = await listBusinessesForAdmin(mockSupabase, { status: "pending", q: "수원" });
      expect(result.count).toBe(1);
      expect(result.businesses[0].id).toBe("biz-1");
    });
  });

  describe("4. getBusinessDetailForAdmin Service (Private Data Isolation)", () => {
    it("includes private registration_number, verifications, and audit logs for admin review", async () => {
      const mockBiz = {
        id: "biz-1",
        name: "테스트 가게",
        category: "카페",
        registration_status: "pending",
        created_by: "user-1",
        road_address: "서울시 중구 세종대로 1",
        latitude: 37.5665,
        longitude: 126.978,
      };

      const mockVerifications = [
        {
          id: "verif-1",
          business_id: "biz-1",
          submitted_by: "user-1",
          method: "document",
          registration_number: "123-45-67890", // PRIVATE field preserved
          evidence_storage_path: "evidence/biz-1.pdf", // PRIVATE field preserved
          status: "pending",
          reviewed_by: null,
          reviewed_at: null,
          review_notes: null,
          created_at: new Date().toISOString(),
        },
      ];

      const mockAuditLogs = [
        {
          id: "audit-1",
          actor_user_id: "admin-1",
          action: "business.review_view",
          entity_type: "businesses",
          entity_id: "biz-1",
          before_data: null,
          after_data: null,
          reason: null,
          created_at: new Date().toISOString(),
        },
      ];

      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === "businesses") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: mockBiz, error: null }),
            };
          }
          if (table === "business_members") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockResolvedValue({ data: [], error: null }),
            };
          }
          if (table === "business_hours") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              order: vi.fn().mockResolvedValue({ data: [], error: null }),
            };
          }
          if (table === "business_verifications") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              order: vi.fn().mockResolvedValue({ data: mockVerifications, error: null }),
            };
          }
          if (table === "profiles") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: { id: "user-1", display_name: "신청자", account_status: "active" },
                error: null,
              }),
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
      } as unknown as SupabaseClient<Database>;

      const detail = await getBusinessDetailForAdmin(mockSupabase, "biz-1");
      expect(detail.id).toBe("biz-1");
      expect(detail.verifications).toHaveLength(1);
      expect(detail.verifications[0].registration_number).toBe("123-45-67890");
      expect(detail.applicant_profile?.display_name).toBe("신청자");
      expect(detail.audit_logs).toHaveLength(1);
      expect(detail.my_role).toBe("admin");
    });

    it("throws 404 NOT_FOUND when the target business does not exist", async () => {
      const mockSupabase = {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        })),
      } as unknown as SupabaseClient<Database>;

      await expect(
        getBusinessDetailForAdmin(mockSupabase, "07829533-f843-41d9-b6dd-0c2a9d2dcc17")
      ).rejects.toThrowError(
        expect.objectContaining({
          code: "NOT_FOUND",
          status: 404,
          userMessage: "가게 정보를 찾을 수 없습니다.",
        })
      );
    });

    it("throws 500 INTERNAL_ERROR (not 404) when Supabase returns Invalid API key", async () => {
      const mockSupabase = {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: null,
            error: { message: "Invalid API key" },
          }),
        })),
      } as unknown as SupabaseClient<Database>;

      await expect(
        getBusinessDetailForAdmin(mockSupabase, "07829533-f843-41d9-b6dd-0c2a9d2dcc17")
      ).rejects.toThrowError(
        expect.objectContaining({
          code: "INTERNAL_ERROR",
          status: 500,
          safeReasonCode: "SUPABASE_AUTH_ERROR",
        })
      );
    });
  });

  describe("5. decideBusinessApproval Service (Atomic RPC Invocation)", () => {
    it("calls atomic RPC decide_business_approval with 'approved'", async () => {
      const mockApprovedBiz = {
        id: "biz-1",
        name: "승인된 가게",
        registration_status: "approved",
        approved_by: "admin-uuid",
        approved_at: new Date().toISOString(),
        rejection_reason: null,
      };

      const rpcSpy = vi.fn().mockResolvedValue({ data: mockApprovedBiz, error: null });
      const mockSupabase = {
        rpc: rpcSpy,
      } as unknown as SupabaseClient<Database>;

      const result = await decideBusinessApproval(mockSupabase, "biz-1", {
        decision: "approved",
        review_notes: "현장 확인 완료",
      });

      expect(rpcSpy).toHaveBeenCalledWith("decide_business_approval", {
        p_business_id: "biz-1",
        p_decision: "approved",
        p_rejection_reason: null,
        p_review_notes: "현장 확인 완료",
      });
      expect(result.registration_status).toBe("approved");
    });

    it("calls atomic RPC decide_business_approval with 'rejected' and rejection_reason", async () => {
      const mockRejectedBiz = {
        id: "biz-1",
        name: "반려된 가게",
        registration_status: "rejected",
        approved_by: null,
        approved_at: null,
        rejection_reason: "서류 미비",
      };

      const rpcSpy = vi.fn().mockResolvedValue({ data: mockRejectedBiz, error: null });
      const mockSupabase = {
        rpc: rpcSpy,
      } as unknown as SupabaseClient<Database>;

      const result = await decideBusinessApproval(mockSupabase, "biz-1", {
        decision: "rejected",
        rejection_reason: "서류 미비",
      });

      expect(rpcSpy).toHaveBeenCalledWith("decide_business_approval", {
        p_business_id: "biz-1",
        p_decision: "rejected",
        p_rejection_reason: "서류 미비",
        p_review_notes: null,
      });
      expect(result.registration_status).toBe("rejected");
    });

    it("maps HM002 to 409 conflict when business is already approved", async () => {
      const mockSupabase = {
        rpc: vi.fn().mockResolvedValue({
          data: null,
          error: { code: "HM002", message: "already approved" },
        }),
      } as unknown as SupabaseClient<Database>;

      await expect(
        decideBusinessApproval(mockSupabase, "biz-1", { decision: "approved" })
      ).rejects.toThrowError(
        expect.objectContaining({
          status: 409,
          userMessage: expect.stringContaining("이미 승인 완료된 가게"),
        })
      );
    });

    it("maps HM006 to 409 conflict when business is already rejected", async () => {
      const mockSupabase = {
        rpc: vi.fn().mockResolvedValue({
          data: null,
          error: { code: "HM006", message: "already rejected" },
        }),
      } as unknown as SupabaseClient<Database>;

      await expect(
        decideBusinessApproval(mockSupabase, "biz-1", {
          decision: "rejected",
          rejection_reason: "재반려",
        })
      ).rejects.toThrowError(
        expect.objectContaining({
          status: 409,
          userMessage: expect.stringContaining("이미 반려 처리된 가게"),
        })
      );
    });

    it("maps HM005 to 422 when business is not in pending state", async () => {
      const mockSupabase = {
        rpc: vi.fn().mockResolvedValue({
          data: null,
          error: { code: "HM005", message: "not pending" },
        }),
      } as unknown as SupabaseClient<Database>;

      await expect(
        decideBusinessApproval(mockSupabase, "biz-1", { decision: "approved" })
      ).rejects.toThrowError(
        expect.objectContaining({
          status: 422,
          userMessage: expect.stringContaining("심사 대기 중(pending)인 가게만"),
        })
      );
    });

    it("maps 42501 to 403 when non-admin attempts decision RPC", async () => {
      const mockSupabase = {
        rpc: vi.fn().mockResolvedValue({
          data: null,
          error: { code: "42501", message: "forbidden" },
        }),
      } as unknown as SupabaseClient<Database>;

      await expect(
        decideBusinessApproval(mockSupabase, "biz-1", { decision: "approved" })
      ).rejects.toThrowError(
        expect.objectContaining({
          status: 403,
          userMessage: expect.stringContaining("해당 가게에 대한 권한이 없거나"),
        })
      );
    });
  });
});

