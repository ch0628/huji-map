import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import AppShell from "@/components/layout/AppShell";
import { getServerAuthSession, isE2eMockSessionAllowed } from "@/lib/auth";
import NewRestroomClient from "./NewRestroomClient";

export const metadata: Metadata = {
  title: "새 화장실 등록 - 휴지맵 사장님",
  description: "내 가게 화장실 정보 등록 및 이용 정책 설정",
};

export default async function NewRestroomPage({
  searchParams,
}: {
  searchParams?: Promise<{ businessId?: string }>;
}) {
  const session = await getServerAuthSession();
  const cookieStore = await cookies();
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const businessIdParam = resolvedSearchParams.businessId;

  const isMockMerchant = isE2eMockSessionAllowed(cookieStore.get("e2e_mock_merchant")?.value);
  const isMockCustomer = isE2eMockSessionAllowed(cookieStore.get("e2e_mock_customer")?.value);
  const isAuthenticated = Boolean(session.user || isMockMerchant || isMockCustomer);
  const hasMerchantAccess = Boolean(
    session.isAdmin || session.isMerchant || isMockMerchant
  );

  // 1. Supabase Config Check
  if (!session.configReady && !isMockMerchant && !isMockCustomer) {
    return (
      <AppShell headerTitle="화장실 등록">
        <div
          role="alert"
          className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
        >
          <p className="text-sm font-bold">인증 서비스 설정이 필요합니다 (503)</p>
          <p className="mt-1 leading-relaxed">
            Supabase 환경 설정이 완료되지 않아 화장실을 등록할 수 없습니다.
          </p>
        </div>
      </AppShell>
    );
  }

  // 2. Guest -> 401 Unauthorized
  if (!isAuthenticated) {
    return (
      <AppShell headerTitle="화장실 등록">
        <div
          role="alert"
          data-testid="merchant-unauthorized-401"
          className="space-y-3 rounded-2xl border border-rose-300 bg-rose-50 p-5 text-xs text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <h1 className="text-base font-bold">로그인이 필요한 화면입니다 (401)</h1>
          <p className="leading-relaxed">
            화장실 등록 기능은 회원 로그인 후 이용하실 수 있습니다.
          </p>
          <div className="flex flex-col gap-2 pt-1">
            <Link
              href="/login?returnTo=%2Fmerchant%2Frestrooms%2Fnew&reason=login_required"
              className="flex min-h-[44px] items-center justify-center rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-blue-700"
            >
              로그인하기
            </Link>
          </div>
        </div>
      </AppShell>
    );
  }

  // 3. Customer without merchant role -> 403 Forbidden
  if (!hasMerchantAccess) {
    return (
      <AppShell headerTitle="화장실 등록">
        <div
          role="alert"
          data-testid="merchant-restroom-forbidden-403"
          className="space-y-3 rounded-2xl border border-amber-300 bg-amber-50 p-5 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <h1 className="text-base font-bold">가게 점주 권한이 필요합니다 (403)</h1>
          <p className="leading-relaxed">
            화장실 등록은 승인된 가게의 점주에게만 허용됩니다. 먼저 가게 등록 신청을 진행해 주세요.
          </p>
          <div className="flex flex-col gap-2 pt-1">
            <Link
              href="/merchant/businesses"
              className="flex min-h-[44px] items-center justify-center rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-blue-700"
            >
              내 가게 등록 및 관리로 이동
            </Link>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell headerTitle="새 화장실 등록">
      <NewRestroomClient initialBusinessId={businessIdParam} />
    </AppShell>
  );
}

