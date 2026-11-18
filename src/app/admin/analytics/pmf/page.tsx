import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import AppShell from "@/components/layout/AppShell";
import { getServerAuthSession, isE2eMockSessionAllowed } from "@/lib/auth";
import PmfDashboardClient from "./PmfDashboardClient";

export const metadata: Metadata = {
  title: "PMF 가설 검증 대시보드 - 휴지맵 관리자",
  description: "H1/H2/H5 핵심 PMF 가설 실험 지표 및 사용자 행동 분석 잠정 리포트",
};

export default async function AdminPmfAnalyticsPage() {
  const session = await getServerAuthSession();
  const cookieStore = await cookies();
  const isMockAdmin = isE2eMockSessionAllowed(
    cookieStore.get("e2e_mock_admin")?.value
  );
  const isMockCustomer = isE2eMockSessionAllowed(
    cookieStore.get("e2e_mock_customer")?.value
  );

  const isAuthenticated = Boolean(session.user || isMockAdmin || isMockCustomer);
  const isAdmin = Boolean(session.isAdmin || isMockAdmin);

  if (!session.configReady && !isMockAdmin && !isMockCustomer) {
    return (
      <AppShell headerTitle="PMF 가설 검증">
        <div
          role="alert"
          className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
        >
          <p className="text-sm font-bold">서버 설정이 필요합니다 (503)</p>
          <p className="mt-1 leading-relaxed">
            Supabase 환경변수가 설정되지 않아 관리자 PMF 데이터를 조회할 수 없습니다.
          </p>
        </div>
      </AppShell>
    );
  }

  // Guest (unauthenticated) -> 401 Access Denied UI
  if (!isAuthenticated) {
    return (
      <AppShell headerTitle="PMF 가설 검증">
        <div
          role="alert"
          data-testid="admin-pmf-unauthorized-401"
          className="space-y-3 rounded-2xl border border-rose-300 bg-rose-50 p-5 text-xs text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <h1 className="text-base font-bold">
            로그인이 필요한 관리자 전용 화면입니다 (401)
          </h1>
          <p className="leading-relaxed">
            PMF 실험 데이터 및 가설 검증 지표는 운영 관리자(admin) 계정으로 로그인 후 열람하실 수 있습니다.
          </p>
          <div className="flex flex-col gap-2 pt-1">
            <Link
              href="/login?returnTo=%2Fadmin%2Fanalytics%2Fpmf&reason=login_required"
              className="flex min-h-[44px] items-center justify-center rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-blue-700"
            >
              관리자 계정으로 로그인하기
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

  // Non-admin authenticated user (customer / merchant) -> 403 Forbidden UI
  if (!isAdmin) {
    return (
      <AppShell headerTitle="PMF 가설 검증">
        <div
          role="alert"
          data-testid="admin-pmf-forbidden-403"
          className="space-y-3 rounded-2xl border border-rose-300 bg-rose-50 p-5 text-xs text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <h1 className="text-base font-bold">
            접근 권한이 없습니다 (403 Forbidden)
          </h1>
          <p className="leading-relaxed">
            현재 계정은 운영 관리자(admin) 권한이 없습니다. 실험 통계 및 PMF 분석 데이터는 관리자만 열람할 수 있습니다.
          </p>
          <Link
            href="/map"
            className="flex min-h-[44px] items-center justify-center rounded-xl bg-slate-800 px-4 py-2.5 text-xs font-semibold text-white hover:bg-slate-900"
          >
            화장실 지도로 돌아가기
          </Link>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell headerTitle="PMF 가설 검증 대시보드">
      <PmfDashboardClient />
    </AppShell>
  );
}

