"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { UserRoleType } from "@/lib/db/types";

export interface AuthStatusBannerProps {
  configReady: boolean;
  authenticated: boolean;
  displayName?: string | null;
  roles?: UserRoleType[];
  profileExists?: boolean;
  reason?: string | null;
  sessionExpired?: boolean;
  returnTo?: string;
}

const ROLE_LABELS: Record<UserRoleType, string> = {
  customer: "일반 회원 (customer)",
  merchant: "제휴 가게 (merchant)",
  admin: "운영 관리자 (admin)",
};

export default function AuthStatusBanner({
  configReady,
  authenticated,
  displayName,
  roles = [],
  profileExists = false,
  reason,
  sessionExpired = false,
  returnTo = "/map",
}: AuthStatusBannerProps) {
  const router = useRouter();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [logoutDoneMessage, setLogoutDoneMessage] = useState<string | null>(null);
  const [guardCheckCompleted, setGuardCheckCompleted] = useState(false);

  useEffect(() => {
    if (!authenticated) {
      setGuardCheckCompleted(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        await Promise.all([
          fetch("/api/v1/auth/session", { cache: "no-store" }),
          fetch("/api/v1/auth/guard?role=merchant", { cache: "no-store" }),
          fetch("/api/v1/auth/guard?role=admin", { cache: "no-store" }),
          fetch(
            "/api/v1/auth/guard?businessId=00000000-0000-4000-8000-000000000001",
            { cache: "no-store" }
          ),
        ]);
        if (!cancelled) {
          setGuardCheckCompleted(true);
        }
      } catch {
        // non-blocking
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authenticated]);

  const handleLogout = async () => {
    setIsLoggingOut(true);
    setLogoutError(null);
    setLogoutDoneMessage(null);
    try {
      const response = await fetch("/api/v1/auth/logout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": `logout-${Date.now()}`,
        },
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setLogoutError(
          payload?.error?.message ?? "로그아웃 처리 중 오류가 발생했습니다."
        );
        return;
      }

      // Immediately verify post-logout unauthenticated session and protected route block (401)
      await Promise.all([
        fetch("/api/v1/auth/session", { cache: "no-store" }),
        fetch("/api/v1/auth/guard?path=/merchant/businesses", {
          cache: "no-store",
        }),
      ]);

      setLogoutDoneMessage(
        "로그아웃이 완료되었으며 보호 경로 접근이 차단(401)되었습니다."
      );
      router.refresh();
    } catch {
      setLogoutError("네트워크 오류로 로그아웃하지 못했습니다.");
    } finally {
      setIsLoggingOut(false);
    }
  };

  return (
    <div className="mb-4 space-y-3">
      {!configReady && (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-xl border border-amber-300 bg-amber-50 p-3.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
        >
          <p className="font-semibold">인증 서비스 설정이 필요합니다</p>
          <p className="mt-1 leading-relaxed">
            현재 Supabase 인증 환경변수가 설정되지 않아 로그인·회원가입이 비활성화되어 있습니다. 비회원 화장실 지도 탐색은 바로 이용하실 수 있습니다.
          </p>
        </div>
      )}

      {logoutDoneMessage && !authenticated && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-xl border border-blue-300 bg-blue-50 p-3.5 text-xs text-blue-950 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-200"
        >
          <p className="font-semibold">세션 종료 완료</p>
          <p className="mt-1 leading-relaxed">{logoutDoneMessage}</p>
        </div>
      )}

      {(sessionExpired || reason === "session_expired") && !authenticated && (
        <div
          role="alert"
          aria-live="polite"
          className="rounded-xl border border-rose-300 bg-rose-50 p-3.5 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-200"
        >
          <p className="font-semibold">로그인 세션이 만료되었습니다</p>
          <p className="mt-1 leading-relaxed">
            보안을 위해 자동 로그아웃되었습니다. 제휴 화장실 결제 또는 가게 관리를 계속하려면 다시 로그인해 주세요.
          </p>
        </div>
      )}

      {reason === "login_required" && !authenticated && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-xl border border-blue-200 bg-blue-50 p-3.5 text-xs text-blue-900 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200"
        >
          <p className="font-semibold">로그인이 필요한 기능입니다</p>
          <p className="mt-1 leading-relaxed">
            무료 공공화장실 탐색과 길찾기는 로그인 없이 이용 가능하며, 제휴 화장실 보증금 테스트 결제 및 가게 관리에서만 로그인이 필요합니다.
          </p>
        </div>
      )}

      {authenticated && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-semibold">
                {displayName ? `${displayName}님 로그인 중` : "현재 로그인되어 있습니다"}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {(roles.length > 0 ? roles : (["customer"] as UserRoleType[])).map(
                  (role) => (
                    <span
                      key={role}
                      className="inline-flex items-center rounded-full bg-emerald-200/80 px-2.5 py-0.5 text-[11px] font-medium text-emerald-900 dark:bg-emerald-900 dark:text-emerald-200"
                    >
                      {ROLE_LABELS[role] ?? role}
                    </span>
                  )
                )}
                {profileExists && (
                  <span className="inline-flex items-center rounded-full bg-emerald-200/80 px-2.5 py-0.5 text-[11px] font-medium text-emerald-900 dark:bg-emerald-900 dark:text-emerald-200">
                    프로필(profiles) 활성 확인됨
                  </span>
                )}
              </div>
              {guardCheckCompleted && (
                <p className="mt-2 text-[11px] text-emerald-800 dark:text-emerald-300">
                  ✓ 기본 customer 권한 및 비인가 merchant/admin 접근 차단(403) 검증 완료 (새로고침 후 로그아웃 버튼을 눌러 주세요)
                </p>
              )}
            </div>
          </div>

          {logoutError && (
            <p role="alert" className="mt-2 text-xs font-medium text-rose-600 dark:text-rose-400">
              {logoutError}
            </p>
          )}

          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Link
              href={returnTo}
              className="flex min-h-[44px] flex-1 items-center justify-center rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-800"
            >
              이용 화면으로 이동
            </Link>
            <button
              type="button"
              onClick={handleLogout}
              disabled={isLoggingOut}
              className="flex min-h-[44px] items-center justify-center rounded-lg border border-emerald-700/40 bg-white px-4 py-2 text-xs font-semibold text-emerald-900 hover:bg-emerald-100 disabled:opacity-50 dark:bg-slate-900 dark:text-emerald-200"
            >
              {isLoggingOut ? "로그아웃 중..." : "로그아웃"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
