import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import AppShell from "@/components/layout/AppShell";
import { getServerAuthSession, isE2eMockSessionAllowed } from "@/lib/auth";
import BusinessesListClient from "./BusinessesListClient";

export const metadata: Metadata = {
  title: "내 가게 목록 - 휴지맵 사장님",
  description: "내가 등록한 제휴 가게 및 신청 상태 관리",
};

export default async function MerchantBusinessesPage() {
  const session = await getServerAuthSession();
  const cookieStore = await cookies();
  const isE2eMock = isE2eMockSessionAllowed(cookieStore.get("e2e_mock_customer")?.value);
  const isAuthenticated = Boolean(session.user || isE2eMock);

  if (!session.configReady && !isE2eMock) {
    return (
      <AppShell headerTitle="가게 관리">
        <div
          role="alert"
          className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
        >
          <p className="text-sm font-bold">인증 서비스 설정이 필요합니다 (503)</p>
          <p className="mt-1 leading-relaxed">
            Supabase 환경 설정이 완료되지 않아 가게 목록을 조회할 수 없습니다.
          </p>
        </div>
      </AppShell>
    );
  }

  // Guest (unauthenticated) -> 401 Access Denied UI
  if (!isAuthenticated) {
    return (
      <AppShell headerTitle="가게 관리">
        <div
          role="alert"
          data-testid="merchant-unauthorized-401"
          className="space-y-3 rounded-2xl border border-rose-300 bg-rose-50 p-5 text-xs text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <h1 className="text-base font-bold">
            로그인이 필요한 화면입니다 (401)
          </h1>
          <p className="leading-relaxed">
            가게 등록 및 관리 기능은 회원 로그인 후 이용하실 수 있습니다. 일반 회원(고객)도 자유롭게 가게를 등록하고 심사를 요청할 수 있습니다.
          </p>
          <div className="flex flex-col gap-2 pt-1">
            <Link
              href="/login?returnTo=%2Fmerchant%2Fbusinesses&reason=login_required"
              className="flex min-h-[44px] items-center justify-center rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-blue-700"
            >
              로그인하고 가게 등록하기
            </Link>
            <Link
              href="/map"
              className="flex min-h-[44px] items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            >
              화장실 지도로 돌아가기
            </Link>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell headerTitle="가게 관리">
      <BusinessesListClient />
    </AppShell>
  );
}

