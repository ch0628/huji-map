"use client";

import React, { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import type { BusinessSummaryItem } from "@/lib/businesses/types";
import type { Restroom } from "@/lib/restrooms/types";
import RestroomCard from "@/components/restroom/RestroomCard";

interface RestroomsListClientProps {
  initialBusinessId?: string;
}

export default function RestroomsListClient({
  initialBusinessId,
}: RestroomsListClientProps) {
  const [businesses, setBusinesses] = useState<BusinessSummaryItem[]>([]);
  const [selectedBusinessId, setSelectedBusinessId] = useState<string>(initialBusinessId || "");
  const [restrooms, setRestrooms] = useState<Restroom[]>([]);
  const [isLoadingBusinesses, setIsLoadingBusinesses] = useState(true);
  const [isLoadingRestrooms, setIsLoadingRestrooms] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // 1. Fetch businesses
  const loadBusinesses = useCallback(async () => {
    setIsLoadingBusinesses(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/v1/merchant/businesses", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error?.message || "가게 목록을 불러오지 못했습니다.");
      }
      const allBiz: BusinessSummaryItem[] = data.businesses || [];
      const approvedBiz = allBiz.filter((b) => b.registration_status === "approved");
      setBusinesses(approvedBiz);

      if (approvedBiz.length > 0) {
        const matched = approvedBiz.find((b) => b.id === initialBusinessId);
        setSelectedBusinessId(matched ? matched.id : approvedBiz[0]?.id || "");
      }
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "가게 목록을 조회할 수 없습니다.");
    } finally {
      setIsLoadingBusinesses(false);
    }
  }, [initialBusinessId]);

  // 2. Fetch restrooms for selected business
  const loadRestrooms = useCallback(async (bizId: string) => {
    if (!bizId) return;
    setIsLoadingRestrooms(true);
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/v1/merchant/restrooms?businessId=${bizId}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error?.message || "화장실 목록을 불러오지 못했습니다.");
      }
      setRestrooms(data.data || []);
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "화장실 목록을 조회할 수 없습니다.");
    } finally {
      setIsLoadingRestrooms(false);
    }
  }, []);

  useEffect(() => {
    loadBusinesses();
  }, [loadBusinesses]);

  useEffect(() => {
    if (selectedBusinessId) {
      loadRestrooms(selectedBusinessId);
    }
  }, [selectedBusinessId, loadRestrooms]);

  const selectedBusiness = businesses.find((b) => b.id === selectedBusinessId);

  if (isLoadingBusinesses) {
    return (
      <div
        data-testid="restrooms-list-loading"
        className="flex flex-col items-center justify-center py-16 text-slate-400"
      >
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
        <p className="mt-3 text-xs">승인된 가게 목록을 확인하는 중...</p>
      </div>
    );
  }

  // 승인된 가게가 없을 때
  if (businesses.length === 0) {
    return (
      <div
        data-testid="restrooms-no-approved-business"
        className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-slate-50/50 px-4 py-12 text-center dark:border-slate-800 dark:bg-slate-900/30"
      >
        <div className="mb-2 text-4xl">🏪</div>
        <h2 className="text-sm font-bold text-slate-800 dark:text-slate-200">
          승인된 제휴 가게가 없습니다
        </h2>
        <p className="mt-1 max-w-xs text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
          화장실을 등록하고 관리하려면 먼저 가게 등록 신청 후 관리자 승인이 완료되어야 합니다.
        </p>
        <div className="mt-4 flex gap-2">
          <Link
            href="/merchant/businesses"
            className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-blue-700"
          >
            내 가게 신청 현황 확인하기
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="restrooms-list-container">
      {/* 가게 선택기 (2곳 이상일 경우 노출) */}
      {businesses.length > 1 && (
        <div className="flex items-center gap-2 rounded-xl bg-white p-3 shadow-sm border border-slate-200 dark:border-slate-800 dark:bg-slate-900">
          <label htmlFor="business-selector" className="text-xs font-semibold text-slate-700 dark:text-slate-300 shrink-0">
            대상 가게:
          </label>
          <select
            id="business-selector"
            value={selectedBusinessId}
            onChange={(e) => setSelectedBusinessId(e.target.value)}
            className="flex-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white min-h-[36px]"
          >
            {businesses.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} ({b.road_address})
              </option>
            ))}
          </select>
        </div>
      )}

      {/* 헤더 및 등록 버튼 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-slate-900 dark:text-white">
            {selectedBusiness?.name ? `${selectedBusiness.name} 화장실` : "화장실 목록"}
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            총 {restrooms.length}곳 등록됨
          </p>
        </div>

        <Link
          href={`/merchant/restrooms/new?businessId=${selectedBusinessId}`}
          data-testid="new-restroom-button"
          className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-blue-700 active:bg-blue-800"
        >
          + 새 화장실 등록
        </Link>
      </div>

      {/* 에러 상태 */}
      {errorMessage && (
        <div
          role="alert"
          data-testid="restrooms-list-error"
          className="flex flex-col gap-2 rounded-xl border border-rose-300 bg-rose-50 p-4 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <p className="font-semibold">⚠️ {errorMessage}</p>
          <button
            type="button"
            onClick={() => loadRestrooms(selectedBusinessId)}
            className="self-start rounded-lg bg-rose-200/80 px-2.5 py-1 text-xs font-medium text-rose-800 hover:bg-rose-300"
          >
            다시 시도
          </button>
        </div>
      )}

      {/* 화장실 목록 로딩 */}
      {isLoadingRestrooms ? (
        <div
          data-testid="restrooms-items-loading"
          className="flex flex-col items-center justify-center py-12 text-slate-400"
        >
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
          <p className="mt-3 text-xs">화장실 목록을 불러오는 중...</p>
        </div>
      ) : restrooms.length === 0 ? (
        /* 빈 목록 상태 */
        <div
          data-testid="restrooms-list-empty"
          className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-slate-50/50 px-4 py-12 text-center dark:border-slate-800 dark:bg-slate-900/30"
        >
          <div className="mb-2 text-4xl">🚻</div>
          <h2 className="text-sm font-bold text-slate-800 dark:text-slate-200">
            등록된 화장실이 없습니다
          </h2>
          <p className="mt-1 max-w-xs text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            고객과 이용자를 위해 우리 가게의 화장실을 등록하고 이용 정책을 설정해 보세요.
          </p>
          <Link
            href={`/merchant/restrooms/new?businessId=${selectedBusinessId}`}
            className="mt-4 inline-flex min-h-[44px] items-center justify-center rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-blue-700"
          >
            + 첫 번째 화장실 등록하기
          </Link>
        </div>
      ) : (
        /* 목록 카드 표시 */
        <div className="flex flex-col gap-3">
          {restrooms.map((restroom) => (
            <RestroomCard key={restroom.id} restroom={restroom} />
          ))}
        </div>
      )}
    </div>
  );
}

