import Link from "next/link";

interface HeaderProps {
  title?: string;
}

export default function Header({ title = "휴지맵" }: HeaderProps) {
  return (
    <header className="sticky top-0 z-50 flex h-14 w-full items-center justify-between border-b border-slate-200 bg-white/95 px-4 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
      <div className="flex items-center gap-2">
        <Link
          href="/"
          className="flex min-h-[44px] min-w-[44px] items-center text-lg font-bold tracking-tight text-blue-600 dark:text-blue-400"
          aria-label="휴지맵 홈으로 이동"
        >
          🧻 {title}
        </Link>
      </div>
      <nav className="flex items-center gap-2">
        <Link
          href="/map"
          className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 active:bg-blue-800"
        >
          화장실 지도
        </Link>
      </nav>
    </header>
  );
}

