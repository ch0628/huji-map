import type { Metadata } from "next";
import AppShell from "@/components/layout/AppShell";
import AuthForm from "@/components/auth/AuthForm";
import AuthStatusBanner from "@/components/auth/AuthStatusBanner";
import { getServerAuthSession, sanitizeReturnTo } from "@/lib/auth";

export const metadata: Metadata = {
  title: "회원가입 - 휴지맵",
  description: "제휴 화장실 이용 및 가게 등록을 위한 휴지맵 회원가입 화면",
};

interface SignupPageProps {
  searchParams?: Promise<{
    returnTo?: string | string[];
    reason?: string | string[];
  }>;
}

export default async function SignupPage({ searchParams }: SignupPageProps) {
  const resolvedParams = searchParams ? await searchParams : {};
  const rawReturnTo = Array.isArray(resolvedParams.returnTo)
    ? resolvedParams.returnTo[0]
    : resolvedParams.returnTo;
  const rawReason = Array.isArray(resolvedParams.reason)
    ? resolvedParams.reason[0]
    : resolvedParams.reason;

  const bannerReturnTo = sanitizeReturnTo(rawReturnTo);
  const formReturnTo = rawReturnTo ? sanitizeReturnTo(rawReturnTo) : "/login";
  const session = await getServerAuthSession();

  return (
    <AppShell headerTitle="회원가입">
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-2">
        <div className="mb-4">
          <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100">
            휴지맵 이메일 회원가입
          </h1>
          <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
            신규 가입 시 일반 회원(customer) 권한이 부여됩니다. 제휴 가게 등록은 가입 후 가게 관리 메뉴에서 무료로 신청하실 수 있습니다.
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
          mode="signup"
          configReady={session.configReady}
          returnTo={formReturnTo}
        />
      </div>
    </AppShell>
  );
}
