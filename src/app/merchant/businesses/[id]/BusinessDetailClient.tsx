"use client";

import React, { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import type { BusinessDetail } from "@/lib/businesses/types";
import BusinessStatusBadge from "@/components/business/BusinessStatusBadge";
import BusinessForm from "@/components/business/BusinessForm";

interface BusinessDetailClientProps {
  businessId: string;
}

export default function BusinessDetailClient({ businessId }: BusinessDetailClientProps) {
  const [business, setBusiness] = useState<BusinessDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fetchDetail = useCallback(async () => {
    setIsLoading(true);
    setErrorCode(null);
    setErrorMessage(null);

    try {
      const res = await fetch(`/api/v1/merchant/businesses/${businessId}`, {
        cache: "no-store",
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        setErrorCode(data.error?.code || String(res.status));
        setErrorMessage(data.error?.message || "가게 정보를 불러올 수 없습니다.");
        return;
      }

      setBusiness(data.business);
    } catch (err: unknown) {
      setErrorCode("NETWORK_ERROR");
      setErrorMessage(err instanceof Error ? err.message : "네트워크 오류가 발생했습니다.");
    } finally {
      setIsLoading(false);
    }
  }, [businessId]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  if (isLoading) {
    return (
      <div
        data-testid="business-detail-loading"
        className="flex flex-col items-center justify-center py-16 text-slate-400"
      >
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
        <p className="mt-3 text-xs">가게 정보를 불러오는 중...</p>
      </div>
    );
  }

  // 403 Forbidden
  if (errorCode === "FORBIDDEN") {
    return (
      <div
        role="alert"
        data-testid="business-detail-forbidden-403"
        className="space-y-3 rounded-2xl border border-rose-300 bg-rose-50 p-5 text-xs text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
      >
        <h1 className="text-base font-bold">접근 권한이 없습니다 (403)</h1>
        <p className="leading-relaxed">
          {errorMessage || "본인이 소유하거나 소속된 가게의 정보만 조회 및 수정할 수 있습니다."}
        </p>
        <div className="pt-2">
          <Link
            href="/merchant/businesses"
            className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700"
          >
            내 가게 목록으로 이동
          </Link>
        </div>
      </div>
    );
  }

  // 404 Not Found
  if (errorCode === "NOT_FOUND") {
    return (
      <div
        role="alert"
        data-testid="business-detail-notfound-404"
        className="space-y-3 rounded-2xl border border-slate-300 bg-slate-50 p-5 text-xs text-slate-800 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-200"
      >
        <h1 className="text-base font-bold">가게를 찾을 수 없습니다 (404)</h1>
        <p className="leading-relaxed">
          존재하지 않거나 삭제된 가게 식별자입니다.
        </p>
        <div className="pt-2">
          <Link
            href="/merchant/businesses"
            className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700"
          >
            내 가게 목록으로 이동
          </Link>
        </div>
      </div>
    );
  }

  // Other error
  if (errorMessage || !business) {
    return (
      <div
        role="alert"
        data-testid="business-detail-error"
        className="space-y-3 rounded-2xl border border-rose-300 bg-rose-50 p-5 text-xs text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
      >
        <h1 className="text-base font-bold">오류가 발생했습니다</h1>
        <p className="leading-relaxed">{errorMessage}</p>
        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={fetchDetail}
            className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700"
          >
            다시 시도
          </button>
          <Link
            href="/merchant/businesses"
            className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
          >
            목록으로 이동
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="business-detail-container">
      {/* 가게 상단 요약 헤더 */}
      <div className="flex flex-col gap-2 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h1 className="text-lg font-bold text-slate-900 dark:text-white">
              {business.name}
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {business.category} · 등록일: {new Date(business.created_at).toLocaleDateString("ko-KR")}
            </p>
          </div>
          <span className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            내 권한: {business.my_role === "owner" ? "소유자(대표)" : business.my_role || "회원"}
          </span>
        </div>

        {/* 상태 뱃지 및 상태별 상세 설명 */}
        <BusinessStatusBadge
          status={business.registration_status}
          rejectionReason={business.rejection_reason}
          showDescription={true}
          className="mt-1"
        />
      </div>

      {/* 승인된 가게의 화장실 관리 안내 배너 */}
      {business.registration_status === "approved" && (
        <div
          data-testid="business-restroom-management-banner"
          className="flex items-center justify-between gap-3 rounded-2xl border border-emerald-200 bg-emerald-50/80 p-4 dark:border-emerald-800 dark:bg-emerald-950/40"
        >
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-bold text-emerald-950 dark:text-emerald-100 flex items-center gap-1.5">
              <span>🚻</span> 가게 화장실 관리
            </h2>
            <p className="mt-0.5 text-xs text-emerald-800 dark:text-emerald-300 leading-relaxed">
              가게 화장실을 등록하고 무료 또는 테스트 보증금 정책을 설정하세요.
            </p>
          </div>
          <Link
            href={`/merchant/restrooms?businessId=${business.id}`}
            className="shrink-0 inline-flex min-h-[44px] items-center justify-center rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700"
          >
            화장실 관리 →
          </Link>
        </div>
      )}

      {/* 정보 수정 / 상세 폼 */}
      <BusinessForm
        initialData={business}
        mode="edit"
        onSuccess={(updated) => {
          setBusiness((prev) => (prev ? { ...prev, ...updated } : (updated as BusinessDetail)));
        }}
      />
    </div>
  );
}
