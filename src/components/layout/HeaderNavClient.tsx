"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { UserRoleType } from "@/lib/db/types";

export interface HeaderAuthState {
  readonly authenticated: boolean;
  readonly displayName: string | null;
  readonly roles: readonly UserRoleType[];
  readonly isAdmin: boolean;
  readonly isMerchant: boolean;
}

interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: string;
  readonly testId: string;
}

interface HeaderNavClientProps {
  readonly auth: HeaderAuthState;
}

function getRoleSummaryLabel(auth: HeaderAuthState): string {
  if (auth.isAdmin) return "운영 관리자";
  if (auth.isMerchant) return "제휴 가게 점주";
  return "일반 회원";
}

function getPrimaryNavItems(auth: HeaderAuthState): NavItem[] {
  if (!auth.authenticated) {
    return [
      { href: "/map", label: "화장실 지도", icon: "🗺️", testId: "nav-link-map" },
      { href: "/login", label: "로그인", icon: "🔑", testId: "nav-link-login" },
      { href: "/signup", label: "회원가입", icon: "✨", testId: "nav-link-signup" },
      {
        href: "/merchant/businesses",
        label: "사장님 입점",
        icon: "🏪",
        testId: "nav-link-merchant-onboarding",
      },
    ];
  }

  if (auth.isAdmin) {
    return [
      { href: "/map", label: "화장실 지도", icon: "🗺️", testId: "nav-link-map" },
      { href: "/admin", label: "관리자 대시보드", icon: "🛡️", testId: "nav-link-admin-home" },
      {
        href: "/admin/businesses",
        label: "가게 심사",
        icon: "🏪",
        testId: "nav-link-admin-businesses",
      },
      {
        href: "/admin/restrooms",
        label: "화장실 심사",
        icon: "🚻",
        testId: "nav-link-admin-restrooms",
      },
      {
        href: "/admin/receipts",
        label: "영수증 심사",
        icon: "🧾",
        testId: "nav-link-admin-receipts",
      },
      {
        href: "/admin/leads",
        label: "리드 관리",
        icon: "📋",
        testId: "nav-link-admin-leads",
      },
      {
        href: "/admin/analytics/pmf",
        label: "PMF 분석",
        icon: "📊",
        testId: "nav-link-admin-pmf",
      },
    ];
  }

  if (auth.isMerchant) {
    return [
      { href: "/map", label: "화장실 지도", icon: "🗺️", testId: "nav-link-map" },
      {
        href: "/merchant/businesses",
        label: "가게 관리",
        icon: "🏪",
        testId: "nav-link-merchant-businesses",
      },
      {
        href: "/merchant/restrooms",
        label: "화장실 관리",
        icon: "🚻",
        testId: "nav-link-merchant-restrooms",
      },
    ];
  }

  return [
    { href: "/map", label: "화장실 지도", icon: "🗺️", testId: "nav-link-map" },
    { href: "/my/access", label: "내 이용권", icon: "🎫", testId: "nav-link-my-access" },
    { href: "/my/receipts", label: "영수증", icon: "🧾", testId: "nav-link-my-receipts" },
  ];
}

function getSecondaryNavItems(auth: HeaderAuthState): NavItem[] {
  if (!auth.authenticated || auth.isAdmin) return [];
  if (auth.isMerchant) {
    return [
      { href: "/my/access", label: "내 이용권", icon: "🎫", testId: "nav-link-my-access" },
      { href: "/my/receipts", label: "영수증", icon: "🧾", testId: "nav-link-my-receipts" },
    ];
  }
  return [
    {
      href: "/merchant/businesses",
      label: "사장님 입점 신청",
      icon: "🏪",
      testId: "nav-link-merchant-onboarding",
    },
  ];
}

export default function HeaderNavClient({ auth }: HeaderNavClientProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 경로 변경 시 모바일 메뉴 자동 닫기
  useEffect(() => {
    setIsOpen(false);
  }, [pathname]);

  // ESC 및 외부 클릭 시 닫기
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
      }
    };
    const handlePointerDown = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [isOpen]);

  const handleLogout = async () => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    setLogoutError(null);
    try {
      const response = await fetch("/api/v1/auth/logout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": `header-logout-${Date.now()}`,
        },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        setLogoutError(
          payload?.error?.message ?? "로그아웃 처리 중 오류가 발생했습니다."
        );
        return;
      }
      setIsOpen(false);
      router.push(payload.redirectTo || "/map");
      router.refresh();
    } catch {
      setLogoutError("네트워크 오류로 로그아웃하지 못했습니다.");
    } finally {
      setIsLoggingOut(false);
    }
  };

  const primaryItems = getPrimaryNavItems(auth);
  const secondaryItems = getSecondaryNavItems(auth);

  const isActive = (href: string) =>
    pathname === href || (href !== "/" && href !== "/admin" && pathname?.startsWith(`${href}/`));

  return (
    <div ref={containerRef} className="flex items-center gap-1.5 shrink-0">
      <Link
        href="/map"
        className="inline-flex min-h-[40px] shrink-0 items-center justify-center whitespace-nowrap rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-blue-700 active:bg-blue-800"
      >
        화장실 지도
      </Link>

      {!auth.authenticated && (
        <Link
          href="/login"
          data-testid="header-login-link"
          className="inline-flex min-h-[40px] shrink-0 items-center justify-center whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
        >
          로그인
        </Link>
      )}

      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        aria-controls="header-mobile-menu"
        aria-label={isOpen ? "메뉴 닫기" : "전체 메뉴 열기"}
        data-testid="header-menu-toggle"
        className="relative inline-flex min-h-[40px] min-w-[40px] shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
      >
        {auth.authenticated && (
          <span
            aria-hidden="true"
            className="h-2 w-2 rounded-full bg-emerald-500"
          />
        )}
        <span>{isOpen ? "닫기" : "메뉴"}</span>
      </button>

      {isOpen && (
        <div
          id="header-mobile-menu"
          data-testid="header-nav-menu"
          role="region"
          aria-label="서비스 메뉴"
          className="absolute left-0 right-0 top-14 z-50 border-b border-slate-200 bg-white p-3 shadow-xl dark:border-slate-800 dark:bg-slate-900"
        >
          {/* 사용자 상태 요약 */}
          <div className="mb-2.5 rounded-xl bg-slate-50 px-3 py-2.5 dark:bg-slate-800/70">
            {auth.authenticated ? (
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-bold text-slate-900 dark:text-white">
                  {auth.displayName ? `${auth.displayName}님` : "로그인 중"}
                </span>
                <span
                  data-testid="header-role-badge"
                  className="shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-800 dark:bg-blue-950 dark:text-blue-200"
                >
                  {getRoleSummaryLabel(auth)}
                </span>
              </div>
            ) : (
              <div>
                <p className="text-xs font-bold text-slate-800 dark:text-slate-100">
                  비회원 이용 중
                </p>
                <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                  공공 화장실 탐색과 길찾기는 로그인 없이 무료입니다.
                </p>
              </div>
            )}
          </div>

          {/* 주요 메뉴 */}
          <ul className="space-y-1">
            {primaryItems.map((item) => {
              const active = isActive(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    data-testid={item.testId}
                    onClick={() => setIsOpen(false)}
                    className={`flex min-h-[44px] items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-semibold transition ${
                      active
                        ? "bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300"
                        : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                    }`}
                  >
                    <span aria-hidden="true">{item.icon}</span>
                    <span>{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>

          {/* 보조 메뉴 */}
          {secondaryItems.length > 0 && (
            <div className="mt-2 border-t border-slate-100 pt-2 dark:border-slate-800">
              <ul className="space-y-1">
                {secondaryItems.map((item) => {
                  const active = isActive(item.href);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        data-testid={item.testId}
                        onClick={() => setIsOpen(false)}
                        className={`flex min-h-[44px] items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium transition ${
                          active
                            ? "bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300"
                            : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                        }`}
                      >
                        <span aria-hidden="true">{item.icon}</span>
                        <span>{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* 로그아웃 */}
          {auth.authenticated && (
            <div className="mt-2 border-t border-slate-100 pt-2 dark:border-slate-800">
              {logoutError && (
                <p
                  role="alert"
                  className="mb-1.5 px-1 text-[11px] font-medium text-rose-600 dark:text-rose-400"
                >
                  {logoutError}
                </p>
              )}
              <button
                type="button"
                onClick={handleLogout}
                disabled={isLoggingOut}
                data-testid="header-logout-btn"
                className="flex min-h-[44px] w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
              >
                <span aria-hidden="true">🚪</span>
                <span>{isLoggingOut ? "로그아웃 중..." : "로그아웃"}</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
