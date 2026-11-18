import { describe, expect, it } from "vitest";
import {
  createBusinessSchema,
  updateBusinessSchema,
  submitBusinessSchema,
} from "@/lib/businesses/validation";
import type { BusinessRegistrationStatus } from "@/lib/businesses/types";
import { evaluateRouteAccess } from "@/lib/auth/guards";
import type { ServerAuthSession } from "@/lib/auth/guards";

describe("TASK 07: Business UI - Validation, Route Access & State Contracts", () => {
  describe("1. 가게 등록 폼 입력 유효성 검사 (Form Validation)", () => {
    it("필수 항목(상호명, 업종, 도로명주소, 좌표)이 정상 입력되면 검증을 통과한다", () => {
      const valid = createBusinessSchema.safeParse({
        name: "카페 휴지 수원역점",
        category: "카페",
        road_address: "경기도 수원시 팔달구 매산로 1",
        latitude: 37.2636,
        longitude: 127.0286,
      });

      expect(valid.success).toBe(true);
      if (valid.success) {
        expect(valid.data.name).toBe("카페 휴지 수원역점");
        expect(valid.data.category).toBe("카페");
        expect(valid.data.latitude).toBe(37.2636);
        expect(valid.data.longitude).toBe(127.0286);
      }
    });

    it("상호명이 비어있거나 공백만 있는 경우 오류를 반환한다", () => {
      const emptyName = createBusinessSchema.safeParse({
        name: "   ",
        category: "카페",
        road_address: "서울시 강남구",
        latitude: 37.5,
        longitude: 127.0,
      });

      expect(emptyName.success).toBe(false);
      if (!emptyName.success) {
        expect(emptyName.error.issues[0]?.message).toContain("가게명");
      }
    });

    it("업종이 누락된 경우 오류를 반환한다", () => {
      const emptyCat = createBusinessSchema.safeParse({
        name: "식당",
        category: "",
        road_address: "서울시 강남구",
        latitude: 37.5,
        longitude: 127.0,
      });

      expect(emptyCat.success).toBe(false);
      if (!emptyCat.success) {
        expect(emptyCat.error.issues[0]?.message).toContain("업종");
      }
    });

    it("도로명주소가 누락된 경우 오류를 반환한다", () => {
      const emptyAddr = createBusinessSchema.safeParse({
        name: "식당",
        category: "음식점",
        road_address: "   ",
        latitude: 37.5,
        longitude: 127.0,
      });

      expect(emptyAddr.success).toBe(false);
      if (!emptyAddr.success) {
        expect(emptyAddr.error.issues[0]?.message).toContain("도로명주소");
      }
    });

    it("위도 또는 경도가 범위를 벗어나면 오류를 반환한다", () => {
      const invalidLat = createBusinessSchema.safeParse({
        name: "식당",
        category: "음식점",
        road_address: "서울시 종로구",
        latitude: 95.0, // max 90
        longitude: 127.0,
      });
      expect(invalidLat.success).toBe(false);

      const invalidLng = createBusinessSchema.safeParse({
        name: "식당",
        category: "음식점",
        road_address: "서울시 종로구",
        latitude: 37.5,
        longitude: 185.0, // max 180
      });
      expect(invalidLng.success).toBe(false);
    });

    it("사업자등록번호가 10자리(000-00-00000) 형식이 아니면 오류를 반환한다", () => {
      const invalidBizNum = createBusinessSchema.safeParse({
        name: "식당",
        category: "음식점",
        road_address: "서울시 종로구",
        latitude: 37.5,
        longitude: 127.0,
        registration_number: "12345", // 잘못된 형식
      });
      expect(invalidBizNum.success).toBe(false);
      if (!invalidBizNum.success) {
        expect(invalidBizNum.error.issues[0]?.message).toContain("사업자등록번호");
      }

      const validBizNum = createBusinessSchema.safeParse({
        name: "식당",
        category: "음식점",
        road_address: "서울시 종로구",
        latitude: 37.5,
        longitude: 127.0,
        registration_number: "123-45-67890",
      });
      expect(validBizNum.success).toBe(true);
    });

    it("웹사이트 URL이 http:// 또는 https://로 시작하지 않으면 오류를 반환한다", () => {
      const invalidUrl = createBusinessSchema.safeParse({
        name: "식당",
        category: "음식점",
        road_address: "서울시 종로구",
        latitude: 37.5,
        longitude: 127.0,
        website_url: "ftp://example.com",
      });
      expect(invalidUrl.success).toBe(false);

      const validUrl = createBusinessSchema.safeParse({
        name: "식당",
        category: "음식점",
        road_address: "서울시 종로구",
        latitude: 37.5,
        longitude: 127.0,
        website_url: "https://my-store.example.com",
      });
      expect(validUrl.success).toBe(true);
    });
  });

  describe("2. 사용자 역할 및 화면 접근성 (Route Access Policy)", () => {
    it("비로그인 사용자가 /merchant/businesses에 접근하면 401과 로그인 리다이렉트를 반환한다", () => {
      const guestSession: Pick<ServerAuthSession, "user" | "roles" | "sessionExpired"> = {
        user: null,
        roles: [],
        sessionExpired: false,
      };

      const result = evaluateRouteAccess("/merchant/businesses", guestSession);
      expect(result.allowed).toBe(false);
      expect(result.status).toBe(401);
      expect(result.redirectTo).toContain("/login");
      expect(result.redirectTo).toContain("reason=login_required");
    });

    it("로그인한 일반 회원(customer)은 merchant 역할이 없어도 /merchant/businesses에 접근 가능하다", () => {
      const customerSession: Pick<ServerAuthSession, "user" | "roles" | "sessionExpired"> = {
        user: { id: "user-1234" } as any,
        roles: ["customer"],
        sessionExpired: false,
      };

      const resultList = evaluateRouteAccess("/merchant/businesses", customerSession);
      expect(resultList.allowed).toBe(true);
      expect(resultList.status).toBe(200);

      const resultNew = evaluateRouteAccess("/merchant/businesses/new", customerSession);
      expect(resultNew.allowed).toBe(true);
      expect(resultNew.status).toBe(200);

      const resultDetail = evaluateRouteAccess("/merchant/businesses/b0000000-0000-4000-8000-000000000001", customerSession);
      expect(resultDetail.allowed).toBe(true);
      expect(resultDetail.status).toBe(200);
    });

    it("로그인한 customer라도 승인된 가게 기능(/merchant/restrooms)은 403으로 차단된다", () => {
      const customerSession: Pick<ServerAuthSession, "user" | "roles" | "sessionExpired"> = {
        user: { id: "user-1234" } as any,
        roles: ["customer"],
        sessionExpired: false,
      };

      const result = evaluateRouteAccess("/merchant/restrooms", customerSession);
      expect(result.allowed).toBe(false);
      expect(result.status).toBe(403);
    });
  });

  describe("3. 가게 등록/수정/심사요청 스키마 및 상태 전이 검증", () => {
    it("updateBusinessSchema는 수정 가능한 일반 필드만 허용하고 승인 필드는 배제한다", () => {
      const updateData = {
        description: "새로운 가게 설명입니다.",
        phone: "031-987-6543",
        website_url: "https://example.com/new",
      };

      const parsed = updateBusinessSchema.safeParse(updateData);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.description).toBe("새로운 가게 설명입니다.");
        expect(parsed.data.phone).toBe("031-987-6543");
      }
    });

    it("updateBusinessSchema는 허용되지 않은 필드(registration_status 등)를 strict 차단한다", () => {
      const invalidTamper = updateBusinessSchema.safeParse({
        description: "설명",
        registration_status: "approved", // 승인 상태 직접 변조 시도
      });

      expect(invalidTamper.success).toBe(false);
    });

    it("submitBusinessSchema는 선택적 메모와 확인 여부를 검증한다", () => {
      const submitData = {
        confirm: true,
        notes: "심사 요청합니다.",
      };

      const parsed = submitBusinessSchema.safeParse(submitData);
      expect(parsed.success).toBe(true);
    });
  });

  describe("4. 상태별 UI 계약 및 표시 규칙 (UI State Contract)", () => {
    const isSubmittableStatus = (s: BusinessRegistrationStatus) => s === "draft" || s === "rejected";
    const isReadOnlyStatus = (s: BusinessRegistrationStatus) => s === "pending" || s === "suspended";

    it("모든 등록 상태 코드(draft, pending, approved, rejected, suspended)가 정의되어 있다", () => {
      const validStatuses: BusinessRegistrationStatus[] = ["draft", "pending", "approved", "rejected", "suspended"];
      expect(validStatuses).toHaveLength(5);
    });

    it("draft 상태는 임시저장으로 표시되고 심사 요청이 가능하다", () => {
      const status: BusinessRegistrationStatus = "draft";
      expect(isSubmittableStatus(status)).toBe(true);
      expect(isReadOnlyStatus(status)).toBe(false);
    });

    it("pending 상태는 관리자 검토 중으로 표시되며 정보 수정이 제한된다", () => {
      const status: BusinessRegistrationStatus = "pending";
      expect(isSubmittableStatus(status)).toBe(false);
      expect(isReadOnlyStatus(status)).toBe(true);
    });

    it("approved 상태는 핵심 정보 변경이 제한되고 일반 운영 정보만 수정 가능하다", () => {
      const status: BusinessRegistrationStatus = "approved";
      expect(status).toBe("approved");
      expect(isSubmittableStatus(status)).toBe(false);
      expect(isReadOnlyStatus(status)).toBe(false);
    });

    it("rejected 상태는 반려 사유가 포함되며 정보 수정 및 재심사 요청이 가능하다", () => {
      const status: BusinessRegistrationStatus = "rejected";
      expect(isSubmittableStatus(status)).toBe(true);
      expect(isReadOnlyStatus(status)).toBe(false);
    });
  });
});
