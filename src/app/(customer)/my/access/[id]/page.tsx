import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import AppShell from "@/components/layout/AppShell";
import { getServerAuthSession, isE2eMockSessionAllowed } from "@/lib/auth";
import AccessDetailClient from "@/components/access/AccessDetailClient";
import {
  CustomerAccessError,
  getCustomerAccessSessionDetail,
} from "@/components/access/access-server";
import type { CustomerAccessDetail } from "@/components/access/types";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "이용권 상세 · PIN 확인 | 휴지맵",
  description: "제휴 화장실 이용권 상세 및 도어락 PIN 보안 열람",
};

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function MyAccessDetailPage(context: PageProps) {
  const { id } = await context.params;
  const session = await getServerAuthSession();
  const cookieStore = await cookies();
  const isE2eMock = isE2eMockSessionAllowed(
    cookieStore.get("e2e_mock_customer")?.value
  );
  const isAuthenticated = Boolean(session.user || isE2eMock);

  if (!session.configReady && !isE2eMock) {
    return (
      <AppShell headerTitle="이용권 상세">
        <div
          role="alert"
          data-testid="access-detail-config-required-503"
          className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
        >
          <p className="text-sm font-bold">
            인증 서비스 설정이 필요합니다 (503)
          </p>
          <p className="mt-1 leading-relaxed">
            Supabase 환경 설정이 완료되지 않아 이용권 상세 정보를 조회할 수 없습니다.
          </p>
        </div>
      </AppShell>
    );
  }

  // Unauthenticated guest -> 401 Access Denied UI (no PIN, no session data)
  if (!isAuthenticated) {
    return (
      <AppShell headerTitle="이용권 상세">
        <div
          role="alert"
          data-testid="access-detail-unauthorized-401"
          className="space-y-3 rounded-2xl border border-rose-300 bg-rose-50 p-5 text-xs text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <h1 className="text-base font-bold">
            로그인이 필요한 화면입니다 (401)
          </h1>
          <p className="leading-relaxed">
            제휴 화장실 이용권 및 도어락 PIN은 결제한 본인 계정으로 로그인한 후에만
            확인할 수 있습니다.
          </p>
          <div className="flex flex-col gap-2 pt-1">
            <Link
              href={`/login?returnTo=${encodeURIComponent(
                `/my/access/${id}`
              )}&reason=login_required`}
              data-testid="access-detail-login-link"
              className="flex min-h-[44px] items-center justify-center rounded-xl bg-purple-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-purple-700"
            >
              로그인하고 이용권 확인하기
            </Link>
            <Link
              href="/map"
              data-testid="access-detail-back-map-link"
              className="flex min-h-[44px] items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            >
              화장실 지도로 돌아가기
            </Link>
          </div>
        </div>
      </AppShell>
    );
  }

  let initialDetail: CustomerAccessDetail | null = null;
  let initialError: { status: number; code: string; message: string } | null =
    null;

  if (session.user && !isE2eMock) {
    try {
      initialDetail = await getCustomerAccessSessionDetail({
        userId: session.user.id,
        accessSessionId: id,
      });
    } catch (err) {
      if (err instanceof CustomerAccessError) {
        initialError = {
          status: err.statusCode,
          code: err.code,
          message: err.message,
        };
      } else {
        initialError = {
          status: 500,
          code: "INTERNAL_ERROR",
          message: "이용권 상세 정보를 조회하는 중 오류가 발생했습니다.",
        };
      }
    }
  }

  return (
    <AppShell headerTitle="이용권 상세">
      <AccessDetailClient
        accessSessionId={id}
        initialDetail={initialDetail}
        initialError={initialError}
        autoFetchOnMount={!initialDetail && !initialError}
      />
    </AppShell>
  );
}

