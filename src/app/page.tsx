import Link from "next/link";
import AppShell from "@/components/layout/AppShell";

export default function HomePage() {
  return (
    <AppShell headerTitle="휴지맵">
      <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
        <div className="mb-4 text-6xl">🧻</div>
        <h1 className="mb-2 text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
          급할 때 찾는 깨끗한 화장실
        </h1>
        <p className="mb-8 text-sm text-slate-600 dark:text-slate-400">
          내 주변 무료 공공 화장실과 안심 제휴 화장실을 빠르게 찾아보세요.
        </p>

        <div className="w-full space-y-3">
          <Link
            href="/map"
            className="flex min-h-[48px] w-full items-center justify-center rounded-xl bg-blue-600 px-4 py-3 text-base font-semibold text-white shadow-md transition hover:bg-blue-700 active:bg-blue-800"
          >
            내 주변 화장실 찾기 (지도)
          </Link>
        </div>

        <div className="mt-12 rounded-xl border border-slate-200 bg-slate-50 p-4 text-left text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-950/50 dark:text-slate-400">
          <p className="font-semibold text-slate-800 dark:text-slate-200">
            ℹ️ 휴지맵 안내 (TASK 01 개발 버전)
          </p>
          <ul className="mt-1.5 list-disc pl-4 space-y-1">
            <li>공공 화장실: 무료 및 길찾기 지원 예정</li>
            <li>제휴 화장실: 보증금 결제 후 안심 이용 (테스트 모드)</li>
            <li>현재 지도 엔진 및 API 연동 준비 단계입니다.</li>
          </ul>
        </div>
      </div>
    </AppShell>
  );
}

