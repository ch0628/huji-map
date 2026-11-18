/**
 * @vitest-environment jsdom
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const mockGetServerAuthSession = vi.fn();
const mockIsE2eMockSessionAllowed = vi.fn();
const mockCookies = vi.fn();

vi.mock("next/headers", () => ({
  cookies: () => mockCookies(),
}));

vi.mock("@/lib/auth", () => ({
  getServerAuthSession: () => mockGetServerAuthSession(),
  isE2eMockSessionAllowed: (v: string | undefined) =>
    mockIsE2eMockSessionAllowed(v),
}));

vi.mock("@/components/receipt/AdminReceiptsClient", () => ({
  default: () => <div data-testid="mock-admin-receipts-client">CLIENT</div>,
}));

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

import AdminReceiptsPage from "@/app/admin/receipts/page";

describe("TASK 29: /admin/receipts SSR 접근 제어", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCookies.mockResolvedValue({
      get: () => undefined,
    });
    mockIsE2eMockSessionAllowed.mockReturnValue(false);
  });

  it("인증 설정 미완료 시 503 안내 화면을 반환한다", async () => {
    mockGetServerAuthSession.mockResolvedValue({
      user: null,
      isAdmin: false,
      configReady: false,
    });

    const element = await AdminReceiptsPage();
    render(element);

    expect(
      screen.getByTestId("admin-receipts-config-required-503")
    ).toBeTruthy();
  });

  it("비로그인 사용자 접근 시 401 차단 화면과 로그인 링크를 반환한다", async () => {
    mockGetServerAuthSession.mockResolvedValue({
      user: null,
      isAdmin: false,
      configReady: true,
    });

    const element = await AdminReceiptsPage();
    render(element);

    const box = screen.getByTestId("admin-receipts-unauthorized-401");
    expect(box).toBeTruthy();
    const loginLink = screen.getByTestId(
      "admin-receipts-login-link"
    ) as HTMLAnchorElement;
    expect(loginLink.getAttribute("href")).toContain("/login?returnTo=%2Fadmin%2Freceipts");
  });

  it("일반 사용자(비관리자) 접근 시 403 차단 화면을 반환한다", async () => {
    mockGetServerAuthSession.mockResolvedValue({
      user: { id: "user-customer-1" },
      isAdmin: false,
      configReady: true,
    });

    const element = await AdminReceiptsPage();
    render(element);

    expect(screen.getByTestId("admin-receipts-forbidden-403")).toBeTruthy();
    expect(screen.queryByTestId("mock-admin-receipts-client")).toBeNull();
  });

  it("관리자 계정 접근 시 AdminReceiptsClient를 렌더링한다", async () => {
    mockGetServerAuthSession.mockResolvedValue({
      user: { id: "user-admin-1" },
      isAdmin: true,
      configReady: true,
    });

    const element = await AdminReceiptsPage();
    render(element);

    expect(screen.getByTestId("mock-admin-receipts-client")).toBeTruthy();
  });
});

