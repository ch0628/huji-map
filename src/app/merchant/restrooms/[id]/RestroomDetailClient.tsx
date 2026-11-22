"use client";

import React, { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import type { Restroom, RestroomAccessPolicy, RestroomHour } from "@/lib/restrooms/types";
import type { MerchantRestroomPinStatus } from "@/lib/restrooms/merchant-service";
import RestroomStatusBadge from "@/components/restroom/RestroomStatusBadge";
import RestroomForm from "@/components/restroom/RestroomForm";
import RestroomPolicyManager from "@/components/restroom/RestroomPolicyManager";
import RestroomPinManager from "@/components/restroom/RestroomPinManager";
import RestroomPhotoManager from "@/components/restroom/RestroomPhotoManager";
import RestroomReviewSubmit from "@/components/restroom/RestroomReviewSubmit";

interface RestroomDetailData extends Restroom {
  businessId: string;
  policies: RestroomAccessPolicy[];
  hours: RestroomHour[];
  photos: any[];
  pinStatus?: MerchantRestroomPinStatus;
}

interface RestroomDetailClientProps {
  restroomId: string;
}

type ManageSection = "none" | "edit" | "policy" | "pin" | "photos";

const ACCESS_METHOD_SUMMARY: Record<string, string> = {
  open: "상시 개방",
  ask_staff: "직원 문의",
  pin: "도어락 비밀번호",
};

export default function RestroomDetailClient({ restroomId }: RestroomDetailClientProps) {
  const [restroom, setRestroom] = useState<RestroomDetailData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<ManageSection>("none");

  const fetchDetail = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!options?.silent) {
        setIsLoading(true);
      }
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
    },
    [restroomId]
  );

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

  if (errorCode === "RESTROOM_NOT_FOUND" || errorCode === "404") {
    return (
      <div
        role="alert"
        data-testid="restroom-detail-notfound-404"
        className="space-y-3 rounded-2xl border border-slate-300 bg-slate-50 p-5 text-xs text-slate-800 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-200"
      >
        <h1 className="text-base font-bold">화장실을 찾을 수 없습니다 (404)</h1>
        <p className="leading-relaxed">존재하지 않거나 삭제된 화장실 식별자입니다.</p>
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
          onClick={() => void fetchDetail()}
          className="rounded-xl bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-700"
        >
          다시 시도
        </button>
      </div>
    );
  }

  const activePolicy =
    restroom.policies?.find((p) => p.is_active) ?? restroom.policies?.[0] ?? null;
  const policyLabel = !activePolicy
    ? "미설정"
    : activePolicy.access_mode === "free"
    ? "무료 이용 (0원)"
    : `테스트 보증금 ${(activePolicy.deposit_amount_krw ?? 1000).toLocaleString()}원`;
  const pinSummaryLabel =
    restroom.access_method !== "pin"
      ? `${ACCESS_METHOD_SUMMARY[restroom.access_method] || restroom.access_method} (PIN 미사용)`
      : restroom.pinStatus?.hasActivePin
      ? `등록됨 (v${restroom.pinStatus.codeVersion ?? 1})`
      : "미등록 · PIN 설정 필요";

  const photoCount = restroom.photos?.length ?? 0;

  const toggleSection = (target: ManageSection) => {
    setActiveSection((prev) => (prev === target ? "none" : target));
  };

  return (
    <div className="flex flex-col gap-4 pb-8" data-testid="restroom-detail-container">
      {/* 1. 기본 상태 요약 카드 */}
      <section
        data-testid="restroom-summary-overview"
        className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-bold text-slate-900 dark:text-white break-keep">
              {restroom.name}
            </h1>
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 break-keep">
              📍 {restroom.road_address}
              {restroom.address_detail ? ` ${restroom.address_detail}` : ""}
              {restroom.floor ? ` (${restroom.floor})` : ""}
            </p>
          </div>
          <RestroomStatusBadge status={restroom.publication_status} />
        </div>

        {/* 요약 메타 테이블 */}
        <dl className="grid grid-cols-1 gap-1.5 rounded-xl bg-slate-50 p-3 text-xs dark:bg-slate-800/50">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-slate-500 dark:text-slate-400">출입 방식 · PIN</dt>
            <dd className="font-semibold text-slate-900 dark:text-slate-100 text-right">
              {pinSummaryLabel}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-slate-500 dark:text-slate-400">현재 이용 정책</dt>
            <dd className="font-semibold text-slate-900 dark:text-slate-100 text-right">
              {policyLabel}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-slate-500 dark:text-slate-400">등록된 사진</dt>
            <dd className="font-semibold text-slate-900 dark:text-slate-100 text-right">
              {photoCount}장
            </dd>
          </div>
        </dl>

        {/* 등록된 사진 썸네일 미리보기 (있을 때) */}
        {photoCount > 0 && (
          <div className="flex flex-wrap gap-2">
            {restroom.photos.slice(0, 3).map((photo: any, idx: number) => (
              <div
                key={photo.id || idx}
                className="relative h-14 w-14 overflow-hidden rounded-lg border border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-800"
              >
                {photo.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={photo.image_url}
                    alt={`화장실 사진 ${idx + 1}`}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-[10px] text-slate-400">
                    사진
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 2. 관리자 심사 상태 / 제출 (임시저장 상태만 제출 버튼 표시, 심사 대기 중은 상태 안내만) */}
      <RestroomReviewSubmit
        restroom={restroom}
        onSubmitted={(updated) => {
          setRestroom((prev) => (prev ? { ...prev, ...updated } : prev));
        }}
      />

      {/* 3. 관리 기능 선택 버튼 (클릭 시에만 입력 폼 펼침) */}
      <section
        aria-label="화장실 관리 기능"
        className="grid grid-cols-2 gap-2"
      >
        <button
          type="button"
          data-testid="toggle-manage-edit-btn"
          aria-expanded={activeSection === "edit"}
          onClick={() => toggleSection("edit")}
          className={`flex min-h-[44px] items-center justify-center rounded-xl border px-3 py-2 text-xs font-bold transition break-keep ${
            activeSection === "edit"
              ? "border-blue-600 bg-blue-600 text-white"
              : "border-slate-200 bg-white text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          }`}
        >
          화장실 정보 수정
        </button>

        <button
          type="button"
          data-testid="toggle-manage-policy-btn"
          aria-expanded={activeSection === "policy"}
          onClick={() => toggleSection("policy")}
          className={`flex min-h-[44px] items-center justify-center rounded-xl border px-3 py-2 text-xs font-bold transition break-keep ${
            activeSection === "policy"
              ? "border-blue-600 bg-blue-600 text-white"
              : "border-slate-200 bg-white text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          }`}
        >
          이용 정책 변경
        </button>

        <button
          type="button"
          data-testid="toggle-manage-pin-btn"
          aria-expanded={activeSection === "pin"}
          onClick={() => toggleSection("pin")}
          className={`flex min-h-[44px] items-center justify-center rounded-xl border px-3 py-2 text-xs font-bold transition break-keep ${
            activeSection === "pin"
              ? "border-blue-600 bg-blue-600 text-white"
              : "border-slate-200 bg-white text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          }`}
        >
          PIN 변경
        </button>

        <button
          type="button"
          data-testid="toggle-manage-photos-btn"
          aria-expanded={activeSection === "photos"}
          onClick={() => toggleSection("photos")}
          className={`flex min-h-[44px] items-center justify-center rounded-xl border px-3 py-2 text-xs font-bold transition break-keep ${
            activeSection === "photos"
              ? "border-blue-600 bg-blue-600 text-white"
              : "border-slate-200 bg-white text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          }`}
        >
          사진 관리
        </button>
      </section>

      {/* 4. 선택된 관리 기능 패널 */}
      {activeSection === "edit" && (
        <div data-testid="manage-panel-edit" className="space-y-2">
          <RestroomForm
            businessId={restroom.business_id || restroom.businessId}
            initialData={restroom}
            initialHours={restroom.hours}
            mode="edit"
            publicationStatus={restroom.publication_status}
            onSuccess={(updated) => {
              setRestroom((prev) =>
                prev
                  ? {
                      ...prev,
                      ...updated,
                      hours: updated.hours ?? prev.hours,
                    }
                  : prev
              );
            }}
            onCancel={() => setActiveSection("none")}
          />
        </div>
      )}

      {activeSection === "policy" && (
        <div data-testid="manage-panel-policy">
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
        </div>
      )}

      {activeSection === "pin" && (
        <div data-testid="manage-panel-pin">
          <RestroomPinManager
            restroomId={restroom.id}
            accessMethod={restroom.access_method}
            pinStatus={restroom.pinStatus}
            onPinUpdated={(nextPinStatus) => {
              setRestroom((prev) =>
                prev ? { ...prev, pinStatus: nextPinStatus } : prev
              );
            }}
          />
        </div>
      )}

      {activeSection === "photos" && (
        <div data-testid="manage-panel-photos">
          <RestroomPhotoManager
            mode="manage"
            restroomId={restroom.id}
            photos={restroom.photos || []}
            onPhotosChanged={() => fetchDetail({ silent: true })}
          />
        </div>
      )}

      {/* 목록으로 돌아가기 */}
      <div className="pt-2 text-center">
        <Link
          href={`/merchant/restrooms?businessId=${restroom.business_id || restroom.businessId}`}
          className="inline-flex min-h-[44px] items-center text-xs font-semibold text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
        >
          ← 내 화장실 목록으로 돌아가기
        </Link>
      </div>
    </div>
  );
}
