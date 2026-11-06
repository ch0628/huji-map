import Link from "next/link";
import AppShell from "@/components/layout/AppShell";

export default function MapPage() {
  return (
    <AppShell headerTitle="화장실 지도">
      <div className="flex flex-1 flex-col">
        {/* 상단 필터 및 검색 Placeholder */}
        <div className="mb-3 flex items-center gap-2">
          <button
            type="button"
            className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-left text-sm text-slate-500 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400"
            disabled
          >
            🔍 지역 또는 화장실 검색 (준비 중)
          </button>
          <button
            type="button"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-slate-300 bg-white text-sm font-medium text-slate-700 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
            disabled
            title="현재 위치 (준비 중)"
          >
            📍
          </button>
        </div>

        {/* 필터 칩 */}
        <div className="mb-3 flex gap-2 overflow-x-auto pb-1 text-xs">
          <span className="inline-flex items-center rounded-full bg-blue-100 px-3 py-1 font-medium text-blue-800 dark:bg-blue-900/50 dark:text-blue-300">
            전체
          </span>
          <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-slate-600 dark:bg-slate-800 dark:text-slate-400">
            무료 공공
          </span>
          <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-slate-600 dark:bg-slate-800 dark:text-slate-400">
            제휴 안심
          </span>
        </div>

        {/* 지도 뷰영역 Placeholder */}
        <div className="relative flex flex-1 flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-300 bg-slate-100 p-6 text-center dark:border-slate-700 dark:bg-slate-800/50 min-h-[320px]">
          <div className="mb-3 text-4xl">🗺️</div>
          <h2 className="mb-1 text-base font-semibold text-slate-800 dark:text-slate-200">
            지도 서비스 준비 중
          </h2>
          <p className="mb-4 max-w-xs text-xs text-slate-500 dark:text-slate-400">
            현재 TASK 01 기본 스캐폴딩 단계입니다. 추후 Kakao Maps SDK 및 화장실 카탈로그 연동이 진행될 예정입니다.
          </p>
          <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            ⚠️ 외부 API 키 및 지도 엔진 연동은 다음 단계에서 설정됩니다.
          </div>
        </div>

        {/* 하단 바텀시트 Placeholder */}
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-800">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>주변 화장실 목록</span>
            <span className="text-[11px] text-blue-600 dark:text-blue-400">0개 검색됨</span>
          </div>
          <p className="mt-2 text-center text-xs text-slate-400">
            위치 권한 및 데이터 연동 후 목록이 표시됩니다.
          </p>
        </div>

        {/* 하단 돌아가기 버튼 */}
        <div className="mt-3">
          <Link
            href="/"
            className="flex min-h-[44px] w-full items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-800/80 dark:text-slate-300"
          >
            ← 홈으로 돌아가기
          </Link>
        </div>
      </div>
    </AppShell>
  );
}

