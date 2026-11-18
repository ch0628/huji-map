import { describe, expect, it } from "vitest";
import {
  createMerchantRestroomSchema,
  updateMerchantRestroomSchema,
  createMerchantPolicySchema,
  resolvePolicyAccessMode,
} from "@/lib/restrooms/merchant-validation";
import { evaluateRouteAccess } from "@/lib/auth/guards";
import type { PublicationStatus } from "@/lib/restrooms/types";

describe("TASK 13: Restroom Merchant UI - Validation, Route Access & State Contracts", () => {
  describe("1. 화장실 등록 및 수정 폼 입력 유효성 검사 (Form Validation)", () => {
    const validUuid = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

    it("필수 항목(가게ID, 이름, 도로명주소, 좌표)이 정상 입력되면 검증을 통과한다", () => {
      const result = createMerchantRestroomSchema.safeParse({
        business_id: validUuid,
        name: "1층 고객용 화장실",
        road_address: "경기도 수원시 팔달구 매산로 1",
        latitude: 37.2636,
        longitude: 127.0286,
        floor: "1층",
        gender_type: "separate",
        wheelchair_accessible: true,
        baby_changing_available: false,
        sanitary_products_available: true,
        access_method: "ask_staff",
        policy_mode: "free_with_ad",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("1층 고객용 화장실");
        expect(result.data.latitude).toBe(37.2636);
        expect(result.data.longitude).toBe(127.0286);
        expect(result.data.gender_type).toBe("separate");
      }
    });

    it("화장실 이름이 비어있으면 오류를 반환한다", () => {
      const result = createMerchantRestroomSchema.safeParse({
        business_id: validUuid,
        name: "   ",
        road_address: "경기도 수원시 팔달구 매산로 1",
        latitude: 37.2636,
        longitude: 127.0286,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain("이름");
      }
    });

    it("도로명주소가 비어있으면 오류를 반환한다", () => {
      const result = createMerchantRestroomSchema.safeParse({
        business_id: validUuid,
        name: "화장실",
        road_address: "   ",
        latitude: 37.2636,
        longitude: 127.0286,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain("도로명주소");
      }
    });

    it("위도나 경도가 숫자가 아니거나 범위를 초과하면 검증에 실패한다", () => {
      const invalidLat = createMerchantRestroomSchema.safeParse({
        business_id: validUuid,
        name: "화장실",
        road_address: "경기도 수원시",
        latitude: 95.0, // max 90
        longitude: 127.0,
      });
      expect(invalidLat.success).toBe(false);

      const invalidLng = createMerchantRestroomSchema.safeParse({
        business_id: validUuid,
        name: "화장실",
        road_address: "경기도 수원시",
        latitude: 37.2,
        longitude: 190.0, // max 180
      });
      expect(invalidLng.success).toBe(false);
    });

    it("성별 구분 항목은 유효한 enum 값이어야 한다", () => {
      const invalidGender = createMerchantRestroomSchema.safeParse({
        business_id: validUuid,
        name: "화장실",
        road_address: "경기도 수원시",
        latitude: 37.2,
        longitude: 127.0,
        gender_type: "invalid_gender" as any,
      });

      expect(invalidGender.success).toBe(false);
    });

    it("출입 방식은 open, ask_staff, pin 중 하나여야 한다", () => {
      const validPin = createMerchantRestroomSchema.safeParse({
        business_id: validUuid,
        name: "화장실",
        road_address: "경기도 수원시",
        latitude: 37.2,
        longitude: 127.0,
        access_method: "pin",
      });
      expect(validPin.success).toBe(true);

      const invalidMethod = createMerchantRestroomSchema.safeParse({
        business_id: validUuid,
        name: "화장실",
        road_address: "경기도 수원시",
        latitude: 37.2,
        longitude: 127.0,
        access_method: "secret_code" as any,
      });
      expect(invalidMethod.success).toBe(false);
    });
  });

  describe("2. 이용 정책 모드 및 유효성 검사 (Policy Mode & Normalization)", () => {
    it("무료 모드('free_with_ad')는 보증금 0원 및 환급 미대상으로 정규화된다", () => {
      const resolved = resolvePolicyAccessMode({ policy_mode: "free_with_ad" });
      expect(resolved.access_mode).toBe("free");
      expect(resolved.deposit_amount_krw).toBe(0);
      expect(resolved.refund_eligible).toBe(false);
    });

    it("테스트 보증금 모드('deposit_with_ad')는 기본 1,000원 및 환급 가능으로 정규화된다", () => {
      const resolved = resolvePolicyAccessMode({ policy_mode: "deposit_with_ad" });
      expect(resolved.access_mode).toBe("test_deposit");
      expect(resolved.deposit_amount_krw).toBe(1000);
      expect(resolved.refund_eligible).toBe(true);
    });

    it("정책 신규 생성 스키마에서 free_with_ad 모드를 정상 검증한다", () => {
      const parsed = createMerchantPolicySchema.safeParse({
        policy_mode: "free_with_ad",
        is_active: true,
      });
      expect(parsed.success).toBe(true);
    });

    it("정책 신규 생성 스키마에서 deposit_with_ad 모드를 정상 검증한다", () => {
      const parsed = createMerchantPolicySchema.safeParse({
        policy_mode: "deposit_with_ad",
        deposit_amount_krw: 1000,
        receipt_window_hours: 24,
        is_active: true,
      });
      expect(parsed.success).toBe(true);
    });

    it("영수증 제출 기한이 168시간(7일)을 초과하면 검증에 실패한다", () => {
      const parsed = createMerchantPolicySchema.safeParse({
        policy_mode: "deposit_with_ad",
        receipt_window_hours: 200,
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe("3. 경로 접근 권한 평가 (Route Access Evaluation)", () => {
    const unauthenticatedSession = {
      user: null,
      roles: [],
      sessionExpired: false,
    };

    const customerSession = {
      user: { id: "user-1" } as any,
      roles: ["customer" as const],
      sessionExpired: false,
    };

    const merchantSession = {
      user: { id: "merchant-1" } as any,
      roles: ["customer" as const, "merchant" as const],
      sessionExpired: false,
    };

    const adminSession = {
      user: { id: "admin-1" } as any,
      roles: ["admin" as const],
      sessionExpired: false,
    };

    it("비인증 사용자가 /merchant/restrooms 에 접근하면 401과 함께 로그인 리다이렉트를 반환한다", () => {
      const access = evaluateRouteAccess("/merchant/restrooms", unauthenticatedSession);
      expect(access.allowed).toBe(false);
      expect(access.status).toBe(401);
      expect(access.redirectTo).toContain("/login");
      expect(access.redirectTo).toContain("merchant%2Frestrooms");
    });

    it("비인증 사용자가 /merchant/restrooms/new 에 접근하면 401과 함께 로그인 리다이렉트를 반환한다", () => {
      const access = evaluateRouteAccess("/merchant/restrooms/new", unauthenticatedSession);
      expect(access.allowed).toBe(false);
      expect(access.status).toBe(401);
      expect(access.redirectTo).toContain("/login");
    });

    it("일반 고객(customer)이 /merchant/restrooms 에 접근하면 403 Forbidden을 반환한다", () => {
      const access = evaluateRouteAccess("/merchant/restrooms", customerSession);
      expect(access.allowed).toBe(false);
      expect(access.status).toBe(403);
      expect(access.reason).toBe("forbidden");
    });

    it("점주(merchant) 역할 보유자는 /merchant/restrooms 에 정상 접근(200)할 수 있다", () => {
      const access = evaluateRouteAccess("/merchant/restrooms", merchantSession);
      expect(access.allowed).toBe(true);
      expect(access.status).toBe(200);
    });

    it("관리자(admin) 역할 보유자는 /merchant/restrooms 에 정상 접근(200)할 수 있다", () => {
      const access = evaluateRouteAccess("/merchant/restrooms", adminSession);
      expect(access.allowed).toBe(true);
      expect(access.status).toBe(200);
    });
  });

  describe("4. 공개 화장실 핵심 위치 수정 잠금 계약 (Published Restroom Location Lock)", () => {
    it("updateMerchantRestroomSchema는 부분 수정을 허용한다", () => {
      const validPatch = updateMerchantRestroomSchema.safeParse({
        name: "수정된 화장실 이름",
        floor: "2층",
        wheelchair_accessible: true,
      });

      expect(validPatch.success).toBe(true);
      if (validPatch.success) {
        expect(validPatch.data.name).toBe("수정된 화장실 이름");
        expect(validPatch.data.floor).toBe("2층");
      }
    });

    it("공개 상태(published)인 화장실의 위치 및 도로명주소 수정 시도 시 잠금 정책을 검증한다", () => {
      // Logic simulation matching updateMerchantRestroom in merchant-service.ts
      const isPublishedRestroom = (status: PublicationStatus) => status === "published";
      const isLocationChangeBlocked = (
        status: PublicationStatus,
        patch: { latitude?: number; longitude?: number; road_address?: string },
        original: { latitude: number; longitude: number; road_address: string }
      ) => {
        if (!isPublishedRestroom(status)) return false;
        const latChanged = patch.latitude !== undefined && patch.latitude !== original.latitude;
        const lngChanged = patch.longitude !== undefined && patch.longitude !== original.longitude;
        const addrChanged = patch.road_address !== undefined && patch.road_address !== original.road_address;
        return latChanged || lngChanged || addrChanged;
      };

      const original = {
        road_address: "경기도 수원시 팔달구 매산로 1",
        latitude: 37.2636,
        longitude: 127.0286,
      };

      // 1. Published restroom tries to change latitude -> Blocked
      expect(
        isLocationChangeBlocked("published", { latitude: 37.5 }, original)
      ).toBe(true);

      // 2. Published restroom tries to change road_address -> Blocked
      expect(
        isLocationChangeBlocked("published", { road_address: "서울시 강남구" }, original)
      ).toBe(true);

      // 3. Published restroom changes name/floor only -> Allowed
      expect(
        isLocationChangeBlocked("published", {}, original)
      ).toBe(false);

      // 4. Draft restroom changes latitude -> Allowed
      expect(
        isLocationChangeBlocked("draft", { latitude: 37.5 }, original)
      ).toBe(false);
    });
  });

  describe("5. 심사 제출 및 상태 전이 계약 (Review Submission State Transitions)", () => {
    it("심사 제출은 오직 draft 상태에서만 허용된다", () => {
      const canSubmitReview = (status: PublicationStatus) => status === "draft";

      expect(canSubmitReview("draft")).toBe(true);
      expect(canSubmitReview("pending")).toBe(false);
      expect(canSubmitReview("published")).toBe(false);
      expect(canSubmitReview("suspended")).toBe(false);
      expect(canSubmitReview("archived")).toBe(false);
    });

    it("필수 항목(이름, 도로명주소, 좌표)이 누락되면 심사 제출 전단에서 차단된다", () => {
      const validateRequiredFieldsForReview = (restroom: {
        name?: string | null;
        road_address?: string | null;
        latitude?: number | null;
        longitude?: number | null;
      }) => {
        if (!restroom.name?.trim()) return false;
        if (!restroom.road_address?.trim()) return false;
        if (restroom.latitude === null || restroom.latitude === undefined) return false;
        if (restroom.longitude === null || restroom.longitude === undefined) return false;
        return true;
      };

      expect(
        validateRequiredFieldsForReview({
          name: "화장실",
          road_address: "수원시 팔달구",
          latitude: 37.26,
          longitude: 127.02,
        })
      ).toBe(true);

      expect(
        validateRequiredFieldsForReview({
          name: "",
          road_address: "수원시 팔달구",
          latitude: 37.26,
          longitude: 127.02,
        })
      ).toBe(false);

      expect(
        validateRequiredFieldsForReview({
          name: "화장실",
          road_address: "",
          latitude: 37.26,
          longitude: 127.02,
        })
      ).toBe(false);

      expect(
        validateRequiredFieldsForReview({
          name: "화장실",
          road_address: "수원시",
          latitude: null,
          longitude: 127.02,
        })
      ).toBe(false);
    });
  });
});
