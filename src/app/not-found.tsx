import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-slate-50 p-4 dark:bg-slate-950">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-md dark:bg-slate-900">
        <div className="mb-3 text-4xl">🔍</div>
        <h2 className="mb-2 text-lg font-bold text-slate-900 dark:text-white">
          페이지를 찾을 수 없습니다
        </h2>
        <p className="mb-6 text-xs text-slate-600 dark:text-slate-400">
          요청하신 페이지가 존재하지 않거나 주소가 변경되었습니다.
        </p>
        <Link
          href="/"
          className="flex min-h-[44px] w-full items-center justify-center rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
        >
          휴지맵 홈으로 이동
        </Link>
      </div>
    </div>
  );
}

