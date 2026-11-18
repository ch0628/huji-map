import type { Metadata } from "next";
import AppShell from "@/components/layout/AppShell";
import AuthForm from "@/components/auth/AuthForm";
import AuthStatusBanner from "@/components/auth/AuthStatusBanner";
import {
  getServerAuthSession,
  recordQaAuthEvent,
  sanitizeReturnTo,
} from "@/lib/auth";

export const metadata: Metadata = {
  title: "로그인 - 휴지맵",
  description: "제휴 화장실 보증금 테스트 결제 및 가게 관리를 위한 로그인 화면",
};

interface LoginPageProps {
  searchParams?: Promise<{
    returnTo?: string | string[];
    reason?: string | string[];
  }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const resolvedParams = searchParams ? await searchParams : {};
  const rawReturnTo = Array.isArray(resolvedParams.returnTo)
    ? resolvedParams.returnTo[0]
    : resolvedParams.returnTo;
  const rawReason = Array.isArray(resolvedParams.reason)
    ? resolvedParams.reason[0]
    : resolvedParams.reason;

  const bannerReturnTo = sanitizeReturnTo(rawReturnTo);
  // If user opened /login directly without a specific returnTo, stay on /login after sign-in
  // so authenticated status banner, refresh verification, and logout action are immediately accessible.
  const formReturnTo = rawReturnTo ? sanitizeReturnTo(rawReturnTo) : "/login";
  const session = await getServerAuthSession();

  if (session.user) {
    recordQaAuthEvent({
      type: "session_verified",
      userId: session.user.id,
      profileExists: session.profileExists,
      accountStatus: session.accountStatus,
      roles: session.roles,
      isAdmin: session.isAdmin,
      isMerchant: session.isMerchant,
    });
  }

  return (
    <AppShell headerTitle="로그인">
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-2">
        <div className="mb-4">
          <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100">
            휴지맵 로그인
          </h1>
          <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
            공공 화장실 찾기와 길찾기는 로그인 없이 무료로 이용하실 수 있습니다. 제휴 화장실 보증금 테스트 결제 또는 가게 관리 시에만 로그인해 주세요.
          </p>
        </div>

        <AuthStatusBanner
          configReady={session.configReady}
          authenticated={Boolean(session.user)}
          displayName={session.displayName}
          roles={session.roles}
          profileExists={session.profileExists}
          reason={rawReason ?? null}
          sessionExpired={session.sessionExpired}
          returnTo={bannerReturnTo}
        />

        <AuthForm
          mode="login"
          configReady={session.configReady}
          returnTo={formReturnTo}
        />
      </div>
    </AppShell>
  );
}
