"use client";

import React, { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import type { Restroom, RestroomAccessPolicy } from "@/lib/restrooms/types";
import RestroomStatusBadge from "@/components/restroom/RestroomStatusBadge";
import RestroomForm from "@/components/restroom/RestroomForm";
import RestroomPolicyManager from "@/components/restroom/RestroomPolicyManager";
import RestroomReviewSubmit from "@/components/restroom/RestroomReviewSubmit";

interface RestroomDetailData extends Restroom {
  businessId: string;
  policies: RestroomAccessPolicy[];
  hours: any[];
  photos: any[];
}

interface RestroomDetailClientProps {
  restroomId: string;
}

export default function RestroomDetailClient({ restroomId }: RestroomDetailClientProps) {
  const [restroom, setRestroom] = useState<RestroomDetailData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fetchDetail = useCallback(async () => {
    setIsLoading(true);
    setErrorCode(null);
    setErrorMessage(null);

    try {
      const res = await fetch(`/api/v1/merchant/restrooms/${restroomId}`, {
        cache: "no-store",
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        setErrorCode(data.error?.code || String(res.status));
        setErrorMessage(data.error?.message || "화장실 정보를 불러오지 못했습니다.");
        return;
      }

      setRestroom(data.data);
    } catch (err: unknown) {
      setErrorCode("NETWORK_ERROR");
      setErrorMessage(err instanceof Error ? err.message : "네트워크 오류가 발생했습니다.");
    } finally {
      setIsLoading(false);
    }
  }, [restroomId]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  if (isLoading) {
    return (
      <div
        data-testid="restroom-detail-loading"
        className="flex flex-col items-center justify-center py-16 text-slate-400"
      >
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
        <p className="mt-3 text-xs">화장실 상세 정보를 불러오는 중...</p>
      </div>
    );
  }

  // 403 Forbidden
  if (errorCode === "FORBIDDEN" || errorCode === "MEMBERSHIP_REQUIRED" || errorCode === "403") {
    return (
      <div
        role="alert"
        data-testid="restroom-detail-forbidden-403"
        className="space-y-3 rounded-2xl border border-rose-300 bg-rose-50 p-5 text-xs text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
      >
        <h1 className="text-base font-bold">접근 권한이 없습니다 (403)</h1>
        <p className="leading-relaxed">
          {errorMessage || "본인이 소속된 제휴 가게의 화장실만 조회 및 수정할 수 있습니다."}
        </p>
        <div className="pt-2">
          <Link
            href="/merchant/restrooms"
            className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700"
          >
            내 화장실 목록으로 이동
          </Link>
        </div>
      </div>
    );
  }

  // 404 Not Found
  if (errorCode === "RESTROOM_NOT_FOUND" || errorCode === "404") {
    return (
      <div
        role="alert"
        data-testid="restroom-detail-notfound-404"
        className="space-y-3 rounded-2xl border border-slate-300 bg-slate-50 p-5 text-xs text-slate-800 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-200"
      >
        <h1 className="text-base font-bold">화장실을 찾을 수 없습니다 (404)</h1>
        <p className="leading-relaxed">
          존재하지 않거나 삭제된 화장실 식별자입니다.
        </p>
        <div className="pt-2">
          <Link
            href="/merchant/restrooms"
            className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700"
          >
            내 화장실 목록으로 이동
          </Link>
        </div>
      </div>
    );
  }

  // General error
  if (!restroom) {
    return (
      <div
        role="alert"
        data-testid="restroom-detail-error"
        className="space-y-3 rounded-2xl border border-rose-300 bg-rose-50 p-5 text-xs text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
      >
        <h1 className="text-base font-bold">화장실 정보 로드 실패</h1>
        <p className="leading-relaxed">{errorMessage || "정보를 불러올 수 없습니다."}</p>
        <button
          type="button"
          onClick={fetchDetail}
          className="rounded-xl bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-700"
        >
          다시 시도
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="restroom-detail-container">
      {/* 1. 상단 요약 헤더 */}
      <div className="flex flex-col gap-2 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-bold text-slate-900 dark:text-white">
              {restroom.name}
            </h1>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {restroom.road_address}
              {restroom.address_detail ? ` ${restroom.address_detail}` : ""}
              {restroom.floor ? ` (${restroom.floor})` : ""}
            </p>
          </div>
          <RestroomStatusBadge status={restroom.publication_status} />
        </div>

        <div className="flex items-center justify-between border-t border-slate-100 pt-2 text-[11px] text-slate-400 dark:border-slate-800">
          <span>등록일: {new Date(restroom.created_at).toLocaleDateString("ko-KR")}</span>
          {restroom.last_verified_at && (
            <span>
              최종 검증일: {new Date(restroom.last_verified_at).toLocaleDateString("ko-KR")}
            </span>
          )}
        </div>
      </div>

      {/* 2. 심사 제출 섹션 */}
      <RestroomReviewSubmit
        restroom={restroom}
        onSubmitted={(updated) => {
          setRestroom((prev) => (prev ? { ...prev, ...updated } : prev));
        }}
      />

      {/* 3. 이용 정책 관리 섹션 */}
      <RestroomPolicyManager
        restroomId={restroom.id}
        policies={restroom.policies || []}
        onPolicyCreated={(newPolicy) => {
          setRestroom((prev) =>
            prev
              ? {
                  ...prev,
                  policies: [
                    newPolicy,
                    ...(prev.policies || []).map((p) => ({ ...p, is_active: false })),
                  ],
                }
              : prev
          );
        }}
      />

      {/* 4. 화장실 정보 수정 폼 */}
      <div className="space-y-2">
        <h2 className="text-sm font-bold text-slate-900 dark:text-white px-1">
          화장실 정보 수정
        </h2>
        <RestroomForm
          businessId={restroom.business_id || restroom.businessId}
          initialData={restroom}
          mode="edit"
          publicationStatus={restroom.publication_status}
          onSuccess={(updated) => {
            setRestroom((prev) => (prev ? { ...prev, ...updated } : prev));
          }}
        />
      </div>

      {/* 목록으로 돌아가기 버튼 */}
      <div className="pt-2 text-center">
        <Link
          href={`/merchant/restrooms?businessId=${restroom.business_id || restroom.businessId}`}
          className="text-xs font-semibold text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
        >
          ← 내 화장실 목록으로 돌아가기
        </Link>
      </div>
    </div>
  );
}

