"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import type { BusinessSummaryItem } from "@/lib/businesses/types";
import BusinessCard from "@/components/business/BusinessCard";

interface BusinessesListClientProps {
  initialBusinesses?: BusinessSummaryItem[];
}

export default function BusinessesListClient({
  initialBusinesses = [],
}: BusinessesListClientProps) {
  const [businesses, setBusinesses] = useState<BusinessSummaryItem[]>(initialBusinesses);
  const [isLoading, setIsLoading] = useState(initialBusinesses.length === 0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fetchBusinesses = async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/v1/merchant/businesses", {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error?.message || "가게 목록을 불러오지 못했습니다.");
      }
      setBusinesses(data.businesses || []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "목록 조회 중 오류가 발생했습니다.";
      setErrorMessage(msg);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    // If not provided from server, load on mount
    if (initialBusinesses.length === 0) {
      fetchBusinesses();
    }
  }, []);

  return (
    <div className="flex flex-col gap-4" data-testid="businesses-list-container">
      {/* 액션 상단 헤더 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-slate-900 dark:text-white">내 가게 목록</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            총 {businesses.length}곳의 가게 등록 및 신청 내역
          </p>
        </div>
        <Link
          href="/merchant/businesses/new"
          data-testid="new-business-button"
          className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-blue-700 active:bg-blue-800"
        >
          + 새 가게 등록
        </Link>
      </div>

      {/* 에러 상태 */}
      {errorMessage && (
        <div
          role="alert"
          data-testid="businesses-list-error"
          className="flex flex-col gap-2 rounded-xl border border-rose-300 bg-rose-50 p-4 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <p className="font-semibold">⚠️ {errorMessage}</p>
          <button
            type="button"
            onClick={fetchBusinesses}
            className="self-start rounded-lg bg-rose-200/80 px-2.5 py-1 text-xs font-medium text-rose-800 hover:bg-rose-300"
          >
            다시 시도
          </button>
        </div>
      )}

      {/* 로딩 상태 */}
      {isLoading ? (
        <div
          data-testid="businesses-list-loading"
          className="flex flex-col items-center justify-center py-12 text-slate-400"
        >
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
          <p className="mt-3 text-xs">가게 목록을 불러오는 중...</p>
        </div>
      ) : businesses.length === 0 ? (
        /* 빈 목록 상태 */
        <div
          data-testid="businesses-list-empty"
          className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-slate-50/50 px-4 py-12 text-center dark:border-slate-800 dark:bg-slate-900/30"
        >
          <div className="mb-2 text-4xl">🏪</div>
          <h2 className="text-sm font-bold text-slate-800 dark:text-slate-200 break-keep">
            등록된 가게가 없습니다
          </h2>
          <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400 max-w-lg sm:max-w-none break-keep leading-relaxed">
            휴지맵에 내 가게를 등록하고, 손님들에게 안심 화장실을 제공해 보세요.
          </p>
          <Link
            href="/merchant/businesses/new"
            className="mt-4 inline-flex min-h-[44px] items-center justify-center rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-semibold text-white shadow-sm hover:bg-blue-700"
          >
            첫 가게 등록하기
          </Link>
        </div>
      ) : (
        /* 가게 카드 목록 */
        <div className="flex flex-col gap-3">
          {businesses.map((biz) => (
            <BusinessCard key={biz.id} business={biz} />
          ))}
        </div>
      )}

      {/* 안내 박스 */}
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-400">
        <p className="font-semibold text-slate-800 dark:text-slate-200">ℹ️ 가게 등록 및 승인 안내</p>
        <ul className="mt-1.5 list-disc pl-4 space-y-1 text-[11px] break-keep leading-relaxed">
          <li>가게 등록 신청은 무료입니다.</li>
          <li>가게 정보를 작성하면 작성 중으로 저장됩니다.</li>
          <li>정보 입력을 마친 뒤 심사 요청을 누르면 관리자 검토가 진행됩니다.</li>
          <li>관리자 승인 완료 후에는 제휴 화장실 등록 및 운영 권한이 활성화됩니다.</li>
        </ul>
      </div>
    </div>
  );
}
