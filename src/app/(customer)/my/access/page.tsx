import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import AppShell from "@/components/layout/AppShell";
import { getServerAuthSession, isE2eMockSessionAllowed } from "@/lib/auth";
import AccessListClient from "@/components/access/AccessListClient";
import { listCustomerAccessSessions } from "@/components/access/access-server";
import type { CustomerAccessListItem } from "@/components/access/types";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "내 화장실 이용권 | 휴지맵",
  description: "결제 승인된 제휴 화장실 이용권 및 도어락 PIN 확인",
};

export default async function MyAccessListPage() {
  const session = await getServerAuthSession();
  const cookieStore = await cookies();
  const isE2eMock = isE2eMockSessionAllowed(
    cookieStore.get("e2e_mock_customer")?.value
  );
  const isAuthenticated = Boolean(session.user || isE2eMock);

  if (!session.configReady && !isE2eMock) {
    return (
      <AppShell headerTitle="내 이용권">
        <div
          role="alert"
          data-testid="access-config-required-503"
          className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
        >
          <p className="text-sm font-bold">
            인증 서비스 설정이 필요합니다 (503)
          </p>
          <p className="mt-1 leading-relaxed">
            Supabase 환경 설정이 완료되지 않아 이용권 목록을 조회할 수 없습니다.
          </p>
        </div>
      </AppShell>
    );
  }

  // Unauthenticated guest -> 401 Access Denied UI (no PIN, no session data)
  if (!isAuthenticated) {
    return (
      <AppShell headerTitle="내 이용권">
        <div
          role="alert"
          data-testid="access-unauthorized-401"
          className="space-y-3 rounded-2xl border border-rose-300 bg-rose-50 p-5 text-xs text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <h1 className="text-base font-bold">
            로그인이 필요한 화면입니다 (401)
          </h1>
          <p className="leading-relaxed">
            제휴 화장실 이용권 확인 및 도어락 PIN 조회는 로그인한 본인만 이용할 수
            있습니다. 공공 화장실 탐색은 로그인 없이 지도에서 바로 가능합니다.
          </p>
          <div className="flex flex-col gap-2 pt-1">
            <Link
              href="/login?returnTo=%2Fmy%2Faccess&reason=login_required"
              data-testid="access-login-link"
              className="flex min-h-[44px] items-center justify-center rounded-xl bg-purple-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-purple-700"
            >
              로그인하고 내 이용권 보기
            </Link>
            <Link
              href="/map"
              data-testid="access-back-map-link"
              className="flex min-h-[44px] items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            >
              화장실 지도로 돌아가기
            </Link>
          </div>
        </div>
      </AppShell>
    );
  }

  let initialItems: CustomerAccessListItem[] | null = null;
  if (session.user && !isE2eMock) {
    try {
      initialItems = await listCustomerAccessSessions({
        userId: session.user.id,
      });
    } catch {
      initialItems = null;
    }
  }

  return (
    <AppShell headerTitle="내 이용권">
      <AccessListClient
        initialItems={initialItems}
        autoFetchOnMount={initialItems === null}
      />
    </AppShell>
  );
}

