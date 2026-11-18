import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import AppShell from "@/components/layout/AppShell";
import { getServerAuthSession, isE2eMockSessionAllowed } from "@/lib/auth";
import BusinessForm from "@/components/business/BusinessForm";

export const metadata: Metadata = {
  title: "가게 등록 신청 - 휴지맵 사장님",
  description: "휴지맵 제휴 화장실 제공을 위한 가게 등록 신청서 작성",
};

export default async function NewBusinessPage() {
  const session = await getServerAuthSession();
  const cookieStore = await cookies();
  const isE2eMock = isE2eMockSessionAllowed(cookieStore.get("e2e_mock_customer")?.value);
  const isAuthenticated = Boolean(session.user || isE2eMock);

  if (!session.configReady && !isE2eMock) {
    return (
      <AppShell headerTitle="가게 등록">
        <div
          role="alert"
          className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
        >
          <p className="text-sm font-bold">인증 서비스 설정이 필요합니다 (503)</p>
          <p className="mt-1 leading-relaxed">
            Supabase 환경 설정이 완료되지 않아 가게를 등록할 수 없습니다.
          </p>
        </div>
      </AppShell>
    );
  }

  if (!isAuthenticated) {
    return (
      <AppShell headerTitle="가게 등록">
        <div
          role="alert"
          data-testid="merchant-unauthorized-401"
          className="space-y-3 rounded-2xl border border-rose-300 bg-rose-50 p-5 text-xs text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <h1 className="text-base font-bold">
            로그인이 필요한 화면입니다 (401)
          </h1>
          <p className="leading-relaxed">
            가게 등록을 시작하려면 먼저 로그인해 주세요. 일반 회원(고객) 계정으로도 가게 등록을 신청할 수 있습니다.
          </p>
          <div className="flex flex-col gap-2 pt-1">
            <Link
              href="/login?returnTo=%2Fmerchant%2Fbusinesses%2Fnew&reason=login_required"
              className="flex min-h-[44px] items-center justify-center rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-blue-700"
            >
              로그인하고 계속하기
            </Link>
            <Link
              href="/merchant/businesses"
              className="flex min-h-[44px] items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            >
              가게 목록으로 돌아가기
            </Link>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell headerTitle="가게 등록 신청">
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="text-lg font-bold text-slate-900 dark:text-white">
            새 가게 등록 신청서
          </h1>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            가게 정보를 입력하여 등록 신청(임시저장)을 진행합니다.
          </p>
        </div>

        <BusinessForm mode="create" />
      </div>
    </AppShell>
  );
}

