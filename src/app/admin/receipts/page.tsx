import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import AppShell from "@/components/layout/AppShell";
import { getServerAuthSession, isE2eMockSessionAllowed } from "@/lib/auth";
import AdminReceiptsClient from "@/components/receipt/AdminReceiptsClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "영수증 수동 심사 - 휴지맵 관리자",
  description:
    "고객 제출 영수증 비공개 원본 이미지 확인, 이용·결제 정보 대조 및 승인/반려/재제출 수동 심사",
};

export default async function AdminReceiptsPage() {
  const session = await getServerAuthSession();
  const cookieStore = await cookies();
  const isMockAdmin = isE2eMockSessionAllowed(
    cookieStore.get("e2e_mock_admin")?.value
  );
  const isMockCustomer = isE2eMockSessionAllowed(
    cookieStore.get("e2e_mock_customer")?.value
  );

  const isAuthenticated = Boolean(
    session.user || isMockAdmin || isMockCustomer
  );
  const isAdmin = Boolean(session.isAdmin || isMockAdmin);

  if (!session.configReady && !isMockAdmin && !isMockCustomer) {
    return (
      <AppShell headerTitle="영수증 수동 심사">
        <div
          role="alert"
          data-testid="admin-receipts-config-required-503"
          className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
        >
          <p className="text-sm font-bold">서버 설정이 필요합니다 (503)</p>
          <p className="mt-1 leading-relaxed">
            Supabase 환경변수가 설정되지 않아 관리자 영수증 심사 대기열을 조회할
            수 없습니다.
          </p>
        </div>
      </AppShell>
    );
  }

  // Unauthenticated guest -> 401 Access Denied UI
  if (!isAuthenticated) {
    return (
      <AppShell headerTitle="영수증 수동 심사">
        <div
          role="alert"
          data-testid="admin-receipts-unauthorized-401"
          className="space-y-3 rounded-2xl border border-rose-300 bg-rose-50 p-5 text-xs text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <h1 className="text-base font-bold">
            로그인이 필요한 관리자 전용 화면입니다 (401)
          </h1>
          <p className="leading-relaxed">
            영수증 수동 심사 및 비공개 원본 이미지는 운영 관리자(admin) 계정으로
            로그인 후 이용하실 수 있습니다.
          </p>
          <div className="flex flex-col gap-2 pt-1">
            <Link
              href="/login?returnTo=%2Fadmin%2Freceipts&reason=login_required"
              data-testid="admin-receipts-login-link"
              className="flex min-h-[44px] items-center justify-center rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-blue-700"
            >
              관리자 계정으로 로그인하기
            </Link>
            <Link
              href="/map"
              data-testid="admin-receipts-back-map-link"
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
      <AppShell headerTitle="영수증 수동 심사">
        <div
          role="alert"
          data-testid="admin-receipts-forbidden-403"
          className="space-y-3 rounded-2xl border border-rose-300 bg-rose-50 p-5 text-xs text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <h1 className="text-base font-bold">
            접근 권한이 없습니다 (403 Forbidden)
          </h1>
          <p className="leading-relaxed">
            현재 계정은 운영 관리자(admin) 권한이 없습니다. 고객이 제출한
            비공개 영수증 이미지 및 수동 심사는 관리자만 열람하고 처리할 수
            있습니다.
          </p>
          <Link
            href="/map"
            data-testid="admin-receipts-forbidden-home-link"
            className="flex min-h-[44px] items-center justify-center rounded-xl bg-slate-800 px-4 py-2.5 text-xs font-semibold text-white hover:bg-slate-900"
          >
            화장실 지도로 이동
          </Link>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell headerTitle="영수증 수동 심사">
      <AdminReceiptsClient />
    </AppShell>
  );
}

