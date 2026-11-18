import Link from "next/link";
import { cookies } from "next/headers";
import AppShell from "@/components/layout/AppShell";
import { getServerAuthSession, isE2eMockSessionAllowed } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let isAuthenticated = false;
  let isAdmin = false;
  let isMerchant = false;
  let displayName: string | null = null;

  try {
    const session = await getServerAuthSession();
    if (session.user) {
      isAuthenticated = true;
      isAdmin = session.isAdmin;
      isMerchant = session.isMerchant;
      displayName = session.displayName;
    } else {
      const cookieStore = await cookies();
      const mockAdmin = isE2eMockSessionAllowed(
        cookieStore.get("e2e_mock_admin")?.value
      );
      const mockMerchant = isE2eMockSessionAllowed(
        cookieStore.get("e2e_mock_merchant")?.value
      );
      const mockCustomer = isE2eMockSessionAllowed(
        cookieStore.get("e2e_mock_customer")?.value
      );
      if (mockAdmin || mockMerchant || mockCustomer) {
        isAuthenticated = true;
        isAdmin = mockAdmin;
        isMerchant = mockMerchant;
        displayName = mockAdmin
          ? "테스트관리자"
          : mockMerchant
            ? "테스트점주"
            : "테스트고객";
      }
    }
  } catch {
    // Non-request context fallback
  }

  return (
    <AppShell headerTitle="휴지맵">
      <div className="flex flex-1 flex-col items-center justify-center py-6 text-center">
        <div className="mb-3 text-5xl" aria-hidden="true">
          🧻
        </div>
        <h1 className="mb-2 text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
          급할 때 찾는 깨끗한 화장실
        </h1>
        <p className="mb-6 text-sm text-slate-600 dark:text-slate-400">
          내 주변 무료 공공 화장실과 안심 제휴 화장실을 빠르게 찾아보세요.
        </p>

        {/* 기본 진입: 비회원/회원 공통 지도 탐색 */}
        <div className="w-full space-y-2.5">
          <Link
            href="/map"
            data-testid="home-map-cta"
            className="flex min-h-[48px] w-full items-center justify-center rounded-xl bg-blue-600 px-4 py-3 text-base font-semibold text-white shadow-md transition hover:bg-blue-700 active:bg-blue-800"
          >
            내 주변 화장실 찾기 (지도)
          </Link>

          {!isAuthenticated ? (
            <div className="grid grid-cols-2 gap-2 pt-1">
              <Link
                href="/login"
                data-testid="home-login-link"
                className="flex min-h-[44px] items-center justify-center rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              >
                로그인
              </Link>
              <Link
                href="/signup"
                data-testid="home-signup-link"
                className="flex min-h-[44px] items-center justify-center rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              >
                회원가입
              </Link>
              <Link
                href="/merchant/businesses"
                data-testid="home-merchant-entry-link"
                className="col-span-2 flex min-h-[44px] items-center justify-center rounded-xl border border-emerald-200 bg-emerald-50/70 px-3 py-2.5 text-xs font-semibold text-emerald-900 hover:bg-emerald-100/70 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200"
              >
                🏪 사장님 입점 안내 · 제휴 가게 등록
              </Link>
            </div>
          ) : (
            <div
              data-testid="home-authenticated-panel"
              className="mt-2 rounded-2xl border border-slate-200 bg-slate-50 p-3.5 text-left dark:border-slate-800 dark:bg-slate-800/50"
            >
              <p className="mb-2.5 text-xs font-bold text-slate-800 dark:text-slate-100">
                {displayName ? `${displayName}님` : "회원"} 바로가기
              </p>

              {isAdmin && (
                <div className="grid grid-cols-2 gap-2">
                  <Link
                    href="/admin"
                    data-testid="home-admin-link"
                    className="col-span-2 flex min-h-[44px] items-center justify-center rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 dark:bg-white dark:text-slate-900"
                  >
                    🛡️ 관리자 대시보드
                  </Link>
                  <Link
                    href="/admin/businesses"
                    className="flex min-h-[44px] items-center justify-center rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                  >
                    가게 심사
                  </Link>
                  <Link
                    href="/admin/receipts"
                    className="flex min-h-[44px] items-center justify-center rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                  >
                    영수증 심사
                  </Link>
                </div>
              )}

              {!isAdmin && isMerchant && (
                <div className="grid grid-cols-2 gap-2">
                  <Link
                    href="/merchant/businesses"
                    data-testid="home-merchant-businesses-link"
                    className="flex min-h-[44px] items-center justify-center rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
                  >
                    🏪 가게 관리
                  </Link>
                  <Link
                    href="/merchant/restrooms"
                    data-testid="home-merchant-restrooms-link"
                    className="flex min-h-[44px] items-center justify-center rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
                  >
                    🚻 화장실 관리
                  </Link>
                  <Link
                    href="/my/access"
                    className="flex min-h-[44px] items-center justify-center rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                  >
                    내 이용권
                  </Link>
                  <Link
                    href="/my/receipts"
                    className="flex min-h-[44px] items-center justify-center rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                  >
                    영수증
                  </Link>
                </div>
              )}

              {!isAdmin && !isMerchant && (
                <div className="grid grid-cols-2 gap-2">
                  <Link
                    href="/my/access"
                    data-testid="home-my-access-link"
                    className="flex min-h-[44px] items-center justify-center rounded-xl bg-purple-600 px-3 py-2 text-xs font-semibold text-white hover:bg-purple-700"
                  >
                    🎫 내 이용권
                  </Link>
                  <Link
                    href="/my/receipts"
                    data-testid="home-my-receipts-link"
                    className="flex min-h-[44px] items-center justify-center rounded-xl bg-purple-600 px-3 py-2 text-xs font-semibold text-white hover:bg-purple-700"
                  >
                    🧾 영수증
                  </Link>
                  <Link
                    href="/merchant/businesses"
                    data-testid="home-merchant-entry-link"
                    className="col-span-2 flex min-h-[44px] items-center justify-center rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                  >
                    🏪 제휴 가게 입점 신청하기
                  </Link>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mt-8 w-full rounded-xl border border-slate-200 bg-slate-50 p-4 text-left text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-950/50 dark:text-slate-400">
          <p className="font-semibold text-slate-800 dark:text-slate-200">
            ℹ️ 휴지맵 이용 안내
          </p>
          <ul className="mt-1.5 list-disc pl-4 space-y-1">
            <li>공공 화장실: 로그인 없이 무료 탐색 및 길찾기 이용</li>
            <li>제휴 화장실: 로그인 후 테스트 보증금 결제 · 이용권 · 영수증 환급 지원</li>
            <li>제휴 가게 입점: 무료 등록 신청 및 관리자 승인 후 화장실 운영</li>
          </ul>
        </div>
      </div>
    </AppShell>
  );
}
