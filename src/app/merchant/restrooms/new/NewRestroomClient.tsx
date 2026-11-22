"use client";

import React, { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { BusinessDetail, BusinessSummaryItem } from "@/lib/businesses/types";
import RestroomForm from "@/components/restroom/RestroomForm";

interface NewRestroomClientProps {
  initialBusinessId?: string;
}

export default function NewRestroomClient({
  initialBusinessId,
}: NewRestroomClientProps) {
  const router = useRouter();
  const [businesses, setBusinesses] = useState<BusinessSummaryItem[]>([]);
  const [selectedBusinessId, setSelectedBusinessId] = useState<string>(initialBusinessId || "");
  const [selectedBusinessDetail, setSelectedBusinessDetail] = useState<BusinessDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fetchApprovedBusinesses = useCallback(async () => {
    setIsLoading(true);
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
      setErrorMessage(err instanceof Error ? err.message : "가게 목록 조회 실패");
    } finally {
      setIsLoading(false);
    }
  }, [initialBusinessId]);

  useEffect(() => {
    fetchApprovedBusinesses();
  }, [fetchApprovedBusinesses]);

  useEffect(() => {
    if (!selectedBusinessId) {
      setSelectedBusinessDetail(null);
      return;
    }

    let cancelled = false;
    setIsLoadingDetail(true);

    fetch(`/api/v1/merchant/businesses/${encodeURIComponent(selectedBusinessId)}`, {
      cache: "no-store",
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        const biz = data?.business || data?.data || null;
        setSelectedBusinessDetail(biz);
      })
      .catch(() => {
        if (!cancelled) setSelectedBusinessDetail(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingDetail(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedBusinessId]);

  if (isLoading) {
    return (
      <div
        data-testid="new-restroom-loading"
        className="flex flex-col items-center justify-center py-16 text-slate-400"
      >
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
        <p className="mt-3 text-xs">등록 가능한 가게를 확인하는 중...</p>
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div
        role="alert"
        data-testid="new-restroom-error"
        className="rounded-2xl border border-rose-300 bg-rose-50 p-5 text-xs text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200 space-y-3"
      >
        <h1 className="text-base font-bold">오류가 발생했습니다</h1>
        <p className="leading-relaxed">{errorMessage}</p>
        <button
          type="button"
          onClick={fetchApprovedBusinesses}
          className="rounded-xl bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-700"
        >
          다시 시도
        </button>
      </div>
    );
  }

  if (businesses.length === 0) {
    return (
      <div
        data-testid="new-restroom-no-business"
        className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/50 p-8 text-center dark:border-slate-800 dark:bg-slate-900/30 space-y-3"
      >
        <div className="text-4xl">🏪</div>
        <h2 className="text-base font-bold text-slate-900 dark:text-white">
          승인된 가게가 없습니다
        </h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mx-auto leading-relaxed break-keep">
          화장실을 등록하기 위해서는 먼저 제휴 가게를 등록하고 관리자 승인을 받아야 합니다.
        </p>
        <div className="pt-2">
          <Link
            href="/merchant/businesses"
            className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-blue-700"
          >
            내 가게 등록하러 가기
          </Link>
        </div>
      </div>
    );
  }

  const selectedBusiness = businesses.find((b) => b.id === selectedBusinessId) || businesses[0];
  const detailMatches =
    selectedBusinessDetail && selectedBusinessDetail.id === selectedBusiness?.id
      ? selectedBusinessDetail
      : null;

  const businessDefaults = selectedBusiness
    ? {
        name: detailMatches?.name || selectedBusiness.name,
        roadAddress: detailMatches?.road_address || selectedBusiness.road_address,
        addressDetail: detailMatches?.address_detail || "",
        latitude:
          detailMatches &&
          Number.isFinite(detailMatches.latitude) &&
          !(detailMatches.latitude === 0 && detailMatches.longitude === 0)
            ? detailMatches.latitude
            : null,
        longitude:
          detailMatches &&
          Number.isFinite(detailMatches.longitude) &&
          !(detailMatches.latitude === 0 && detailMatches.longitude === 0)
            ? detailMatches.longitude
            : null,
      }
    : undefined;

  return (
    <div className="flex flex-col gap-4" data-testid="new-restroom-container">
      {businesses.length > 1 && (
        <div className="rounded-xl bg-white p-3 shadow-sm border border-slate-200 dark:border-slate-800 dark:bg-slate-900 flex items-center gap-2">
          <label
            htmlFor="new-restroom-business-select"
            className="text-xs font-semibold text-slate-700 dark:text-slate-300 shrink-0"
          >
            등록 대상 가게:
          </label>
          <select
            id="new-restroom-business-select"
            value={selectedBusinessId}
            onChange={(e) => setSelectedBusinessId(e.target.value)}
            className="min-w-0 w-full flex-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white min-h-[36px]"
          >
            {businesses.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} ({b.road_address})
              </option>
            ))}
          </select>
        </div>
      )}

      {selectedBusiness && isLoadingDetail && !detailMatches ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-slate-200 bg-white py-12 text-slate-400 dark:border-slate-800 dark:bg-slate-900">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
          <p className="mt-2.5 text-xs">가게 위치 정보를 불러오는 중...</p>
        </div>
      ) : (
        selectedBusiness && (
          <RestroomForm
            key={`${selectedBusiness.id}-${detailMatches ? "loaded" : "summary"}`}
            businessId={selectedBusiness.id}
            businessName={selectedBusiness.name}
            businessDefaults={businessDefaults}
            mode="create"
            onSuccess={(saved) => {
              router.push(`/merchant/restrooms/${saved.id}`);
            }}
            onCancel={() => {
              router.push(`/merchant/restrooms?businessId=${selectedBusiness.id}`);
            }}
          />
        )
      )}
    </div>
  );
}
