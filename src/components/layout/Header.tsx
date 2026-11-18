import Link from "next/link";
import HeaderNavClient, { type HeaderAuthState } from "./HeaderNavClient";

interface HeaderProps {
  title?: string;
  auth?: HeaderAuthState;
  showNavigation?: boolean;
}

const GUEST_AUTH_STATE: HeaderAuthState = {
  authenticated: false,
  displayName: null,
  roles: [],
  isAdmin: false,
  isMerchant: false,
};

export default function Header({
  title = "휴지맵",
  auth = GUEST_AUTH_STATE,
  showNavigation = true,
}: HeaderProps) {
  return (
    <header className="sticky top-0 z-50 flex h-14 w-full items-center justify-between gap-2 border-b border-slate-200 bg-white/95 px-3 sm:px-4 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
      <div className="flex min-w-0 items-center">
        <Link
          href="/"
          className="flex min-h-[44px] min-w-0 items-center gap-1 text-base sm:text-lg font-bold tracking-tight text-blue-600 dark:text-blue-400"
          aria-label="휴지맵 홈으로 이동"
        >
          <span aria-hidden="true" className="shrink-0">
            🧻
          </span>
          <span className="truncate">{title}</span>
        </Link>
      </div>
      {showNavigation && (
        <nav aria-label="주요 내비게이션" className="flex items-center shrink-0">
          <HeaderNavClient auth={auth} />
        </nav>
      )}
    </header>
  );
}
