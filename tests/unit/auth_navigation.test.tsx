/**
 * @vitest-environment jsdom
 */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockPush = vi.fn();
const mockRefresh = vi.fn();
let mockPathname = "/";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    refresh: mockRefresh,
  }),
  usePathname: () => mockPathname,
}));

const mockGetServerAuthSession = vi.fn();
const mockCookies = vi.fn();
const mockIsE2eMockSessionAllowed = vi.fn();

vi.mock("next/headers", () => ({
  cookies: () => mockCookies(),
}));

const mockSignInWithPassword = vi.fn();
const mockSignUp = vi.fn();
const mockCreateServerClientInstance = vi.fn();
const mockGetUserRoles = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createServerClientInstance: () => mockCreateServerClientInstance(),
}));

vi.mock("@/lib/supabase/auth", () => ({
  getUserRoles: (...args: unknown[]) => mockGetUserRoles(...args),
}));

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    getServerAuthSession: () => mockGetServerAuthSession(),
    isE2eMockSessionAllowed: (v: string | undefined) =>
      mockIsE2eMockSessionAllowed(v),
  };
});

vi.mock("@/components/layout/AppShell", () => ({
  default: ({
    children,
    headerTitle,
  }: {
    children: React.ReactNode;
    headerTitle?: string;
  }) => (
    <div data-testid="app-shell" data-title={headerTitle}>
      {children}
    </div>
  ),
}));

import Header from "@/components/layout/Header";
import HomePage from "@/app/page";
import AdminDashboardPage from "@/app/admin/page";
import { getDefaultRouteForRoles } from "@/lib/auth/validation";
import { POST as loginPost } from "@/app/api/v1/auth/login/route";
import { POST as signupPost } from "@/app/api/v1/auth/signup/route";
import { clearIdempotencyStoreForTests } from "@/lib/auth/validation";

describe("작업 B: 인증·역할별 진입 흐름 및 내비게이션", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    clearIdempotencyStoreForTests();
    mockPathname = "/";
    mockCookies.mockResolvedValue({ get: () => undefined });
    mockIsE2eMockSessionAllowed.mockReturnValue(false);
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

  describe("1. 역할별 기본 리다이렉트 (getDefaultRouteForRoles & POST /api/v1/auth/login)", () => {
    it("역할 우선순위에 따라 기본 이동 경로를 반환한다", () => {
      expect(getDefaultRouteForRoles([])).toBe("/map");
      expect(getDefaultRouteForRoles(["customer"])).toBe("/map");
      expect(getDefaultRouteForRoles(["customer", "merchant"])).toBe(
        "/merchant/businesses"
      );
      expect(getDefaultRouteForRoles(["customer", "admin"])).toBe("/admin");
      expect(getDefaultRouteForRoles(["customer", "merchant", "admin"])).toBe(
        "/admin"
      );
    });

    it("로그인 API는 returnTo가 없으면 역할별 경로로, 있으면 안전한 내부 경로로 redirectTo를 반환한다", async () => {
      mockCreateServerClientInstance.mockResolvedValue({
        auth: {
          signInWithPassword: mockSignInWithPassword,
        },
      });
      mockSignInWithPassword.mockResolvedValue({
        data: { user: { id: "u-1", user_metadata: {} } },
        error: null,
      });

      // admin (returnTo 미지정) -> /admin
      mockGetUserRoles.mockResolvedValueOnce(["customer", "admin"]);
      const adminRes = await loginPost(
        new Request("http://localhost/api/v1/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "admin@test.com", password: "password123" }),
        })
      );
      expect(adminRes.status).toBe(200);
      expect((await adminRes.json()).redirectTo).toBe("/admin");

      // merchant (returnTo 미지정) -> /merchant/businesses
      mockGetUserRoles.mockResolvedValueOnce(["customer", "merchant"]);
      const merchRes = await loginPost(
        new Request("http://localhost/api/v1/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "merch@test.com", password: "password123" }),
        })
      );
      expect(merchRes.status).toBe(200);
      expect((await merchRes.json()).redirectTo).toBe("/merchant/businesses");

      // customer with explicit returnTo -> /restrooms/123
      mockGetUserRoles.mockResolvedValueOnce(["customer"]);
      const custRes = await loginPost(
        new Request("http://localhost/api/v1/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: "cust@test.com",
            password: "password123",
            returnTo: "/restrooms/123",
          }),
        })
      );
      expect(custRes.status).toBe(200);
      expect((await custRes.json()).redirectTo).toBe("/restrooms/123");

      // external open redirect blocked -> /map
      mockGetUserRoles.mockResolvedValueOnce(["customer", "admin"]);
      const unsafeRes = await loginPost(
        new Request("http://localhost/api/v1/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: "admin@test.com",
            password: "password123",
            returnTo: "https://evil.example.com",
          }),
        })
      );
      expect(unsafeRes.status).toBe(200);
      expect((await unsafeRes.json()).redirectTo).toBe("/map");
    });

    it("연속된 정상 회원가입이 전역 1회 제한 없이 허용되고 기본 customer 역할을 반환한다", async () => {
      mockCreateServerClientInstance.mockResolvedValue({
        auth: {
          signUp: mockSignUp,
        },
      });
      mockSignUp
        .mockResolvedValueOnce({
          data: { user: { id: "u-new-1" }, session: {} },
          error: null,
        })
        .mockResolvedValueOnce({
          data: { user: { id: "u-new-2" }, session: {} },
          error: null,
        });

      const res1 = await signupPost(
        new Request("http://localhost/api/v1/auth/signup", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-idempotency-key": "signup-1",
          },
          body: JSON.stringify({
            email: "first.qa@hujimap.test",
            password: "Password1234!",
            termsAccepted: true,
          }),
        })
      );
      expect(res1.status).toBe(201);
      const body1 = await res1.json();
      expect(body1.ok).toBe(true);
      expect(body1.user.roles).toEqual(["customer"]);

      const res2 = await signupPost(
        new Request("http://localhost/api/v1/auth/signup", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-idempotency-key": "signup-2",
          },
          body: JSON.stringify({
            email: "second.qa@hujimap.test",
            password: "Password1234!",
            termsAccepted: true,
          }),
        })
      );
      expect(res2.status).toBe(201);
      const body2 = await res2.json();
      expect(body2.ok).toBe(true);
      expect(body2.user.roles).toEqual(["customer"]);
    });
  });

  describe("2. Header 역할별 메뉴 및 로그아웃", () => {
    it("비회원: 지도, 로그인, 회원가입, 사장님 입점 메뉴를 표시하고 로그아웃은 숨긴다", () => {
      render(
        <Header
          auth={{
            authenticated: false,
            displayName: null,
            roles: [],
            isAdmin: false,
            isMerchant: false,
          }}
        />
      );

      expect(screen.getByTestId("header-login-link").getAttribute("href")).toBe(
        "/login"
      );

      fireEvent.click(screen.getByTestId("header-menu-toggle"));
      expect(screen.getByTestId("nav-link-map").getAttribute("href")).toBe("/map");
      expect(screen.getByTestId("nav-link-login").getAttribute("href")).toBe("/login");
      expect(screen.getByTestId("nav-link-signup").getAttribute("href")).toBe(
        "/signup"
      );
      expect(
        screen.getByTestId("nav-link-merchant-onboarding").getAttribute("href")
      ).toBe("/merchant/businesses");
      expect(screen.queryByTestId("header-logout-btn")).toBeNull();
      expect(screen.queryByTestId("nav-link-admin-home")).toBeNull();
    });

    it("일반 회원(customer): 내 이용권·영수증·로그아웃을 표시하고 관리자/점주 화장실 관리 메뉴는 숨긴다", () => {
      render(
        <Header
          auth={{
            authenticated: true,
            displayName: "김고객",
            roles: ["customer"],
            isAdmin: false,
            isMerchant: false,
          }}
        />
      );

      expect(screen.queryByTestId("header-login-link")).toBeNull();
      fireEvent.click(screen.getByTestId("header-menu-toggle"));

      expect(screen.getByTestId("header-role-badge").textContent).toBe("일반 회원");
      expect(screen.getByTestId("nav-link-my-access").getAttribute("href")).toBe(
        "/my/access"
      );
      expect(screen.getByTestId("nav-link-my-receipts").getAttribute("href")).toBe(
        "/my/receipts"
      );
      expect(screen.getByTestId("header-logout-btn")).toBeDefined();
      expect(screen.queryByTestId("nav-link-merchant-restrooms")).toBeNull();
      expect(screen.queryByTestId("nav-link-admin-home")).toBeNull();
    });

    it("점주(merchant): 가게 관리·화장실 관리 메뉴를 표시하고 관리자 메뉴는 숨긴다", () => {
      render(
        <Header
          auth={{
            authenticated: true,
            displayName: "박사장",
            roles: ["customer", "merchant"],
            isAdmin: false,
            isMerchant: true,
          }}
        />
      );

      fireEvent.click(screen.getByTestId("header-menu-toggle"));
      expect(screen.getByTestId("header-role-badge").textContent).toBe(
        "제휴 가게 점주"
      );
      expect(
        screen.getByTestId("nav-link-merchant-businesses").getAttribute("href")
      ).toBe("/merchant/businesses");
      expect(
        screen.getByTestId("nav-link-merchant-restrooms").getAttribute("href")
      ).toBe("/merchant/restrooms");
      expect(screen.queryByTestId("nav-link-admin-home")).toBeNull();
    });

    it("관리자(admin): 구현된 관리자 메뉴를 모두 연결하되 미구현 환급 UI 링크는 노출하지 않는다", () => {
      render(
        <Header
          auth={{
            authenticated: true,
            displayName: "운영자",
            roles: ["customer", "admin"],
            isAdmin: true,
            isMerchant: false,
          }}
        />
      );

      fireEvent.click(screen.getByTestId("header-menu-toggle"));
      expect(screen.getByTestId("header-role-badge").textContent).toBe(
        "운영 관리자"
      );
      expect(screen.getByTestId("nav-link-admin-home").getAttribute("href")).toBe(
        "/admin"
      );
      expect(
        screen.getByTestId("nav-link-admin-businesses").getAttribute("href")
      ).toBe("/admin/businesses");
      expect(
        screen.getByTestId("nav-link-admin-restrooms").getAttribute("href")
      ).toBe("/admin/restrooms");
      expect(
        screen.getByTestId("nav-link-admin-receipts").getAttribute("href")
      ).toBe("/admin/receipts");
      expect(screen.getByTestId("nav-link-admin-leads").getAttribute("href")).toBe(
        "/admin/leads"
      );
      expect(screen.getByTestId("nav-link-admin-pmf").getAttribute("href")).toBe(
        "/admin/analytics/pmf"
      );
      expect(screen.queryByText(/환급 관리/)).toBeNull();
    });

    it("헤더 로그아웃 클릭 시 /api/v1/auth/logout 호출 후 /map으로 이동하고 새로고침한다", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, redirectTo: "/map" }),
      }) as unknown as typeof fetch;

      render(
        <Header
          auth={{
            authenticated: true,
            displayName: "김고객",
            roles: ["customer"],
            isAdmin: false,
            isMerchant: false,
          }}
        />
      );

      fireEvent.click(screen.getByTestId("header-menu-toggle"));
      fireEvent.click(screen.getByTestId("header-logout-btn"));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          "/api/v1/auth/logout",
          expect.objectContaining({ method: "POST" })
        );
        expect(mockPush).toHaveBeenCalledWith("/map");
        expect(mockRefresh).toHaveBeenCalled();
      });
    });
  });

  describe("3. 홈(/) 진입 흐름 및 관리자 허브(/admin) 가드", () => {
    it("비회원 홈 화면에 지도, 로그인, 회원가입, 사장님 입점 진입 경로를 제공한다", async () => {
      mockGetServerAuthSession.mockResolvedValue({
        user: null,
        roles: [],
        isAdmin: false,
        isMerchant: false,
        displayName: null,
        configReady: true,
      });

      const el = await HomePage();
      render(el);

      expect(screen.getByTestId("home-map-cta").getAttribute("href")).toBe("/map");
      expect(screen.getByTestId("home-login-link").getAttribute("href")).toBe(
        "/login"
      );
      expect(screen.getByTestId("home-signup-link").getAttribute("href")).toBe(
        "/signup"
      );
      expect(
        screen.getByTestId("home-merchant-entry-link").getAttribute("href")
      ).toBe("/merchant/businesses");
    });

    it("/admin 대시보드는 비로그인 401, 일반회원 403을 차단하고 관리자만 6개 운영 메뉴를 렌더링한다", async () => {
      // Guest -> 401
      mockGetServerAuthSession.mockResolvedValueOnce({
        user: null,
        roles: [],
        isAdmin: false,
        configReady: true,
      });
      const guestEl = await AdminDashboardPage();
      const { unmount: unmountGuest } = render(guestEl);
      expect(
        screen.getByTestId("admin-dashboard-unauthorized-401")
      ).toBeDefined();
      expect(
        screen.getByTestId("admin-dashboard-login-link").getAttribute("href")
      ).toBe("/login?returnTo=%2Fadmin&reason=login_required");
      unmountGuest();

      // Customer -> 403
      mockGetServerAuthSession.mockResolvedValueOnce({
        user: { id: "u-cust" },
        roles: ["customer"],
        isAdmin: false,
        configReady: true,
      });
      const custEl = await AdminDashboardPage();
      const { unmount: unmountCust } = render(custEl);
      expect(screen.getByTestId("admin-dashboard-forbidden-403")).toBeDefined();
      unmountCust();

      // Admin -> 200
      mockGetServerAuthSession.mockResolvedValueOnce({
        user: { id: "u-admin" },
        roles: ["customer", "admin"],
        isAdmin: true,
        configReady: true,
      });
      const adminEl = await AdminDashboardPage();
      render(adminEl);
      expect(screen.getByTestId("admin-dashboard-page")).toBeDefined();
      expect(screen.getByTestId("admin-card-businesses")).toBeDefined();
      expect(screen.getByTestId("admin-card-restrooms")).toBeDefined();
      expect(screen.getByTestId("admin-card-receipts")).toBeDefined();
      expect(screen.getByTestId("admin-card-refunds").getAttribute("href")).toBe(
        "/admin/refunds"
      );
      expect(screen.getByTestId("admin-card-leads")).toBeDefined();
      expect(screen.getByTestId("admin-card-pmf")).toBeDefined();
    });
  });
});
