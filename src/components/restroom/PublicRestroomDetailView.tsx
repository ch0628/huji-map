"use client";

import React, { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import type { PublicRestroomDetail } from "@/lib/restrooms/types";
import MapDirectionsModal from "@/components/map/MapDirectionsModal";
import { PublicRestroomPhotoGallery } from "@/components/restroom/RestroomPhotoManager";
import {
  CompactOperatingHours,
  OperatingStatusBadge,
  PublicRestroomUnifiedSections,
  RestroomFacilitiesCard,
  evaluateOperatingStatus,
} from "@/components/restroom/restroom-detail-shared";
import { normalizePublicRestroomMetadata } from "@/lib/restrooms/public-metadata";
import { useEventTracker } from "@/lib/events/hooks";
import { useBasicUsageTracker } from "@/lib/usage-counts/hooks";

export interface PublicRestroomDetailViewProps {
  readonly restroom: PublicRestroomDetail;
}

export default function PublicRestroomDetailView({
  restroom,
}: PublicRestroomDetailViewProps) {
  const [showDirections, setShowDirections] = useState<boolean>(false);
  const isPartner = restroom.type === "partner";
  const activePolicy = restroom.active_policy ?? null;
  const policyMode = activePolicy?.access_mode ?? null;
  const depositAmountKrw =
    policyMode === "test_deposit" &&
    typeof activePolicy?.deposit_amount_krw === "number" &&
    activePolicy.deposit_amount_krw > 0
      ? activePolicy.deposit_amount_krw
      : null;

  const operatingStatus = useMemo(
    () => evaluateOperatingStatus(restroom.hours, restroom.hour_exceptions),
    [restroom.hours, restroom.hour_exceptions]
  );

  const publicMetadata = useMemo(
    () => (!isPartner ? normalizePublicRestroomMetadata(restroom) : null),
    [isPartner, restroom]
  );

  const { trackDetailOpened, trackDirectionsClicked } = useEventTracker();
  const { trackBasicDetailOpened, trackBasicDirectionsClicked } =
    useBasicUsageTracker();

  useEffect(() => {
    trackBasicDetailOpened(restroom.id);
    trackDetailOpened({
      restroom,
      sourceComponent: "direct_url",
    });
  }, [restroom, trackBasicDetailOpened, trackDetailOpened]);

  return (
    <div
      data-testid="public-restroom-detail-view"
      className="flex flex-col gap-4 pb-10"
    >
      {/* 상단 네비게이션: 지도로 돌아가기 */}
      <div className="flex items-center">
        <Link
          href="/map"
          data-testid="back-to-map-link"
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-slate-100 px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
        >
          <span>←</span>
          <span>지도로 돌아가기</span>
        </Link>
      </div>

      {/* 상단 사진 슬라이더 (공개 승인 사진 0장이면 미표시) */}
      <PublicRestroomPhotoGallery
        restroomName={restroom.name}
        photos={restroom.photos}
      />

      {/* 기본 정보 헤더 */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {isPartner ? (
            <span
              data-testid="detail-partner-badge"
              className="inline-flex items-center rounded-md bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-800 dark:bg-slate-800 dark:text-slate-200"
            >
              🤝 안심 제휴 화장실
            </span>
          ) : (
            <span
              data-testid="detail-public-badge"
              className="inline-flex items-center rounded-md bg-blue-100 px-2.5 py-1 text-xs font-bold text-blue-800 dark:bg-blue-950/80 dark:text-blue-300"
            >
              🏛️ 무료 공공 화장실
            </span>
          )}
          <OperatingStatusBadge status={operatingStatus} />
        </div>

        <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">
          {restroom.name}
        </h1>

        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          📍 {restroom.road_address}
          {restroom.address_detail ? ` ${restroom.address_detail}` : ""}
          {restroom.floor ? ` (${restroom.floor})` : ""}
        </p>

        {isPartner && restroom.business?.phone && (
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
            📞 {restroom.business.phone}
          </p>
        )}

        <CompactOperatingHours
          hours={restroom.hours ?? []}
          todayText={operatingStatus.todayText}
          officialOperating={publicMetadata?.operating}
        />

        {isPartner && restroom.description && (
          <p className="mt-3 rounded-xl bg-slate-50 p-3 text-xs leading-relaxed text-slate-700 dark:bg-slate-800/50 dark:text-slate-300">
            {restroom.description}
          </p>
        )}

        {/* 액션 버튼: 길찾기 (가로 전체 너비) */}
        <div className="mt-4 flex flex-col gap-2.5 border-t border-slate-100 pt-4 dark:border-slate-800">
          <button
            type="button"
            onClick={() => setShowDirections(true)}
            data-testid="detail-directions-btn"
            className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white shadow-md hover:bg-blue-700 active:scale-[0.99] transition"
          >
            <span>🧭</span>
            <span>길찾기 (카카오·네이버·구글)</span>
          </button>
        </div>
      </div>

      {/* 간단한 이용 안내 */}
      {isPartner ? (
        policyMode === "free" ? (
          <div className="rounded-2xl border border-emerald-200/70 bg-emerald-50 p-4 text-xs text-emerald-950 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200">
            <p className="font-bold text-sm">🤝 안심 제휴 무료 이용</p>
            <p className="mt-1 leading-relaxed">
              제휴 매장에서 보증금 없이 무료로 개방하는 화장실이에요.
            </p>
          </div>
        ) : policyMode === "test_deposit" && depositAmountKrw !== null ? (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-900 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-100">
            <p className="font-bold text-sm">
              이용 보증금{" "}
              <span className="text-purple-700 dark:text-purple-400">
                {depositAmountKrw.toLocaleString()}원
              </span>
            </p>
            <p className="mt-1 leading-relaxed text-slate-700 dark:text-slate-300">
              결제 후 이용할 수 있어요. 매장에서 구매한 영수증이 승인되면 보증금을 돌려받을 수 있어요.
            </p>
          </div>
        ) : (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-200">
            <p className="font-bold text-sm">📋 이용 정책 확인 필요</p>
            <p className="mt-1 leading-relaxed">현재 활성화된 이용 정책 정보를 확인해 주세요.</p>
          </div>
        )
      ) : (
        <PublicRestroomUnifiedSections
          restroom={restroom}
          metadata={publicMetadata!}
          showLegacyDisclosure={true}
        />
      )}

      {/* 제휴 기타 시설 정보 */}
      {isPartner && <RestroomFacilitiesCard restroom={restroom} />}

      {/* 길찾기 모달 */}
      <MapDirectionsModal
        isOpen={showDirections}
        onClose={() => setShowDirections(false)}
        onDirectionsClick={(service) => {
          trackBasicDirectionsClicked();
          trackDirectionsClicked({
            restroom,
            service,
            hasOrigin: false,
          });
        }}
        target={{
          id: restroom.id,
          name: restroom.name,
          type: restroom.type,
          businessId: restroom.business_id,
          address: restroom.road_address,
          coords: {
            lat: restroom.latitude ?? 37.2635727,
            lng: restroom.longitude ?? 127.0286009,
          },
        }}
      />
    </div>
  );
}
