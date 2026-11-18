import type { Metadata } from "next";
import Link from "next/link";
import AppShell from "@/components/layout/AppShell";
import { getServerAuthSession } from "@/lib/auth";
import { computeLeadMetrics, listLeadsForAdmin } from "@/lib/leads";
import LeadsAdminClient from "./LeadsAdminClient";

export const metadata: Metadata = {
  title: "가게 리드 50곳 관리 - 휴지맵 관리자",
  description: "H1 실험 모수(50곳) 및 가게 접촉 시도 이력 관리",
};

export default async function AdminLeadsPage() {
  const session = await getServerAuthSession();

  if (!session.configReady) {
    return (
      <AppShell headerTitle="가게 리드 관리">
        <div
          role="alert"
          className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
        >
          <p className="text-sm font-bold">서버 설정이 필요합니다 (503)</p>
          <p className="mt-1 leading-relaxed">
            Supabase 환경변수가 설정되지 않아 관리자 리드 데이터를 조회할 수 없습니다.
          </p>
        </div>
      </AppShell>
    );
  }

  // Guest (unauthenticated) -> 401 Access Denied UI
  if (!session.user) {
    return (
      <AppShell headerTitle="가게 리드 관리">
        <div
          role="alert"
          data-testid="admin-leads-unauthorized-401"
          className="space-y-3 rounded-2xl border border-rose-300 bg-rose-50 p-5 text-xs text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <h1 className="text-base font-bold">
            로그인이 필요한 관리자 전용 화면입니다 (401)
          </h1>
          <p className="leading-relaxed">
            가게 접촉 리드 및 연락 기록은 운영 관리자(admin)만 열람할 수 있습니다.
          </p>
          <div className="flex flex-col gap-2 pt-1">
            <Link
              href="/login?returnTo=%2Fadmin%2Fleads&reason=login_required"
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
  if (!session.isAdmin) {
    return (
      <AppShell headerTitle="가게 리드 관리">
        <div
          role="alert"
          data-testid="admin-leads-forbidden-403"
          className="space-y-3 rounded-2xl border border-rose-300 bg-rose-50 p-5 text-xs text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <h1 className="text-base font-bold">
            접근 권한이 없습니다 (403 Forbidden)
          </h1>
          <p className="leading-relaxed">
            현재 로그인된 계정은 운영 관리자(admin) 권한이 없습니다. 가게 접촉 리드, 비공개 전화번호 및 상담 메모는 관리자만 조회할 수 있습니다.
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

  let initialItems: Awaited<ReturnType<typeof listLeadsForAdmin>>["items"] = [];
  let initialMetrics = computeLeadMetrics([], []);
  let initialError: string | null = null;

  try {
    const result = await listLeadsForAdmin({ limit: 200 });
    initialItems = result.items;
    initialMetrics = result.metrics;
  } catch {
    initialError =
      "가게 리드 테이블(business_leads)을 조회하지 못했습니다. DB 마이그레이션 적용 상태를 확인해 주세요.";
  }

  return (
    <AppShell headerTitle="가게 리드 50곳 관리">
      <LeadsAdminClient
        initialItems={initialItems}
        initialMetrics={initialMetrics}
        initialError={initialError}
      />
    </AppShell>
  );
}

