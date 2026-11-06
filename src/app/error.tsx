"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // 보안상 에러 스택/민감정보가 브라우저 콘솔 외부에 누출되지 않도록 처리
    console.error("화면 오류 발생:", error.message);
  }, [error]);

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-slate-50 p-4 dark:bg-slate-950">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-md dark:bg-slate-900">
        <div className="mb-3 text-4xl">⚠️</div>
        <h2 className="mb-2 text-lg font-bold text-slate-900 dark:text-white">
          일시적인 오류가 발생했습니다
        </h2>
        <p className="mb-6 text-xs text-slate-600 dark:text-slate-400">
          페이지를 불러오는 도중 문제가 생겼습니다. 다시 시도하거나 홈 화면으로 이동해 주세요.
        </p>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => reset()}
            className="flex min-h-[44px] w-full items-center justify-center rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            다시 시도하기
          </button>
          <Link
            href="/"
            className="flex min-h-[44px] w-full items-center justify-center rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-800 dark:text-slate-200"
          >
            홈으로 이동
          </Link>
        </div>
      </div>
    </div>
  );
}

