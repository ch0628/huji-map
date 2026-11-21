import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import AppShell from "@/components/layout/AppShell";
import { getServerAuthSession, isE2eMockSessionAllowed } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "관리자 대시보드 - 휴지맵",
  description: "가게·화장실·영수증 심사 및 리드·PMF 분석 운영 메뉴",
};

const ADMIN_TOOLS = [
  {
    href: "/admin/businesses",
    title: "가게 심사 및 승인",
    description: "제휴 가게 등록 신청 검토, 사업자 검증 확인 및 승인/반려",
    icon: "🏪",
    testId: "admin-card-businesses",
  },
  {
    href: "/admin/restrooms",
    title: "화장실 심사 및 공개 관리",
    description: "제휴·공공 화장실 검수, 공개 승인, 반려 및 중단 처리",
    icon: "🚻",
    testId: "admin-card-restrooms",
  },
  {
    href: "/admin/receipts",
    title: "영수증 수동 심사",
    description: "고객 제출 비공개 영수증 이미지 대조 및 승인/반려/재제출 요청",
    icon: "🧾",
    testId: "admin-card-receipts",
  },
  {
    href: "/admin/refunds",
    title: "테스트 환급 관리",
    description: "영수증 승인 완료 주문 확인, Toss 테스트 전액 취소 요청 및 상태 재조회",
    icon: "💸",
    testId: "admin-card-refunds",
  },
  {
    href: "/admin/leads",
    title: "가게 리드 50곳 관리",
    description: "H1 실험 모수 가게 목록 및 접촉 시도 이력 관리",
    icon: "📋",
    testId: "admin-card-leads",
  },
  {
    href: "/admin/analytics/pmf",
    title: "PMF 가설 검증 대시보드",
    description: "H1/H2/H5 핵심 실험 지표 및 행동 이벤트 집계 확인",
    icon: "📊",
    testId: "admin-card-pmf",
  },
] as const;

export default async function AdminDashboardPage() {
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
      <AppShell headerTitle="관리자 대시보드">
        <div
          role="alert"
          className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
        >
          <p className="text-sm font-bold">서버 설정이 필요합니다 (503)</p>
          <p className="mt-1 leading-relaxed">
            Supabase 환경변수가 설정되지 않아 관리자 화면을 열 수 없습니다.
          </p>
        </div>
      </AppShell>
    );
  }

  if (!isAuthenticated) {
    return (
      <AppShell headerTitle="관리자 대시보드">
        <div
          role="alert"
          data-testid="admin-dashboard-unauthorized-401"
          className="space-y-3 rounded-2xl border border-rose-300 bg-rose-50 p-5 text-xs text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <h1 className="text-base font-bold">
            로그인이 필요한 관리자 전용 화면입니다 (401)
          </h1>
          <p className="leading-relaxed">
            관리자 운영 기능은 운영 관리자(admin) 계정으로 로그인한 후 이용할 수 있습니다.
          </p>
          <div className="flex flex-col gap-2 pt-1">
            <Link
              href="/login?returnTo=%2Fadmin&reason=login_required"
              data-testid="admin-dashboard-login-link"
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
      <AppShell headerTitle="관리자 대시보드">
        <div
          role="alert"
          data-testid="admin-dashboard-forbidden-403"
          className="space-y-3 rounded-2xl border border-rose-300 bg-rose-50 p-5 text-xs text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <h1 className="text-base font-bold">
            접근 권한이 없습니다 (403 Forbidden)
          </h1>
          <p className="leading-relaxed">
            현재 계정은 운영 관리자(admin) 권한이 없습니다. 관리자 화면은 서버에서 admin 권한이 부여된 계정만 접근할 수 있습니다.
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
    <AppShell headerTitle="관리자 대시보드">
      <div className="flex flex-col gap-4" data-testid="admin-dashboard-page">
        <div>
          <h1 className="text-lg font-bold text-slate-900 dark:text-white">
            운영 관리자 메뉴
          </h1>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            심사 및 실험 지표 관리 화면으로 이동합니다.
          </p>
        </div>

        <div className="flex flex-col gap-2.5">
          {ADMIN_TOOLS.map((tool) => (
            <Link
              key={tool.href}
              href={tool.href}
              data-testid={tool.testId}
              className="flex min-h-[56px] items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-blue-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700"
            >
              <span className="mt-0.5 text-xl" aria-hidden="true">
                {tool.icon}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-slate-900 dark:text-white">
                  {tool.title}
                </p>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  {tool.description}
                </p>
              </div>
              <span className="self-center text-xs text-slate-400" aria-hidden="true">
                →
              </span>
            </Link>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
