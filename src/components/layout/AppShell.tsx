import React from "react";
import { cookies } from "next/headers";
import Header from "./Header";
import type { HeaderAuthState } from "./HeaderNavClient";
import { getServerAuthSession, isE2eMockSessionAllowed } from "@/lib/auth";
import type { UserRoleType } from "@/lib/db/types";

interface AppShellProps {
  children: React.ReactNode;
  headerTitle?: string;
  showNavigation?: boolean;
}

const DEFAULT_AUTH_STATE: HeaderAuthState = {
  authenticated: false,
  displayName: null,
  roles: [],
  isAdmin: false,
  isMerchant: false,
};

async function resolveHeaderAuthState(): Promise<HeaderAuthState> {
  try {
    const session = await getServerAuthSession();
    if (session.user) {
      const roles: UserRoleType[] =
        session.roles.length > 0 ? session.roles : ["customer"];
      return {
        authenticated: true,
        displayName: session.displayName,
        roles,
        isAdmin: session.isAdmin,
        isMerchant: session.isMerchant,
      };
    }

    const cookieStore = await cookies();
    const isMockAdmin = isE2eMockSessionAllowed(
      cookieStore.get("e2e_mock_admin")?.value
    );
    const isMockMerchant = isE2eMockSessionAllowed(
      cookieStore.get("e2e_mock_merchant")?.value
    );
    const isMockCustomer = isE2eMockSessionAllowed(
      cookieStore.get("e2e_mock_customer")?.value
    );

    if (isMockAdmin || isMockMerchant || isMockCustomer) {
      const roles: UserRoleType[] = isMockAdmin
        ? ["customer", "admin"]
        : isMockMerchant
          ? ["customer", "merchant"]
          : ["customer"];
      return {
        authenticated: true,
        displayName: isMockAdmin
          ? "테스트관리자"
          : isMockMerchant
            ? "테스트점주"
            : "테스트고객",
        roles,
        isAdmin: isMockAdmin,
        isMerchant: isMockMerchant,
      };
    }
  } catch {
    // Non-request context fallback (e.g., isolated unit rendering)
  }

  return DEFAULT_AUTH_STATE;
}

export default async function AppShell({
  children,
  headerTitle,
  showNavigation = true,
}: AppShellProps) {
  const auth = showNavigation
    ? await resolveHeaderAuthState()
    : DEFAULT_AUTH_STATE;

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col bg-white shadow-sm dark:bg-slate-900">
      <Header title={headerTitle} auth={auth} showNavigation={showNavigation} />
      <main className="flex flex-1 flex-col p-4">{children}</main>
    </div>
  );
}
