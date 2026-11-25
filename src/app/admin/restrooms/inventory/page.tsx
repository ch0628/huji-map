import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import AppShell from "@/components/layout/AppShell";
import { getServerAuthSession, isE2eMockSessionAllowed } from "@/lib/auth";
import AdminRestroomInventoryClient from "./AdminRestroomInventoryClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "전체 화장실 현황 및 목록 - 휴지맵 관리자",
  description: "전체 등록 화장실 집계 통계, 지역·출처·검증 필터 및 페이지네이션 목록 조회",
};

export default async function AdminRestroomInventoryPage() {
  const session = await getServerAuthSession();
  const cookieStore = await cookies();
  const isMockAdmin = isE2eMockSessionAllowed(cookieStore.get("e2e_mock_admin")?.value);
  const isMockCustomer = isE2eMockSessionAllowed(
    cookieStore.get("e2e_mock_customer")?.value
  );

  const isAuthenticated = Boolean(session.user || isMockAdmin || isMockCustomer);
  const isAdmin = Boolean(session.isAdmin || isMockAdmin);

  if (!session.configReady && !isMockAdmin && !isMockCustomer) {
    return (
      <AppShell headerTitle="전체 화장실 현황 및 목록">
        <div
          role="alert"
          className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
        >
          <p className="text-sm font-bold">서버 설정이 필요합니다 (503)</p>
          <p className="mt-1 leading-relaxed">
            Supabase 환경변수가 설정되지 않아 관리자 데이터를 조회할 수 없습니다.
          </p>
        </div>
      </AppShell>
    );
  }

  if (!isAuthenticated) {
    return (
      <AppShell headerTitle="전체 화장실 현황 및 목록">
        <div
          role="alert"
          data-testid="admin-inventory-unauthorized-401"
          className="space-y-3 rounded-2xl border border-rose-300 bg-rose-50 p-5 text-xs text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <h1 className="text-base font-bold">
            로그인이 필요한 관리자 전용 화면입니다 (401)
          </h1>
          <p className="leading-relaxed">
            전체 화장실 통계 및 목록 관리는 운영 관리자(admin) 계정으로 로그인 후 이용하실 수 있습니다.
          </p>
          <div className="flex flex-col gap-2 pt-1">
            <Link
              href="/login?returnTo=%2Fadmin%2Frestrooms%2Finventory&reason=login_required"
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

  if (!isAdmin) {
    return (
      <AppShell headerTitle="전체 화장실 현황 및 목록">
        <div
          role="alert"
          data-testid="admin-inventory-forbidden-403"
          className="space-y-3 rounded-2xl border border-rose-300 bg-rose-50 p-5 text-xs text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <h1 className="text-base font-bold">접근 권한이 없습니다 (403 Forbidden)</h1>
          <p className="leading-relaxed">
            현재 계정은 운영 관리자(admin) 권한이 없습니다. 비공개·전체 화장실 데이터는 관리자만 열람할 수 있습니다.
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
    <AppShell headerTitle="전체 화장실 현황 및 목록">
      <AdminRestroomInventoryClient />
    </AppShell>
  );
}
