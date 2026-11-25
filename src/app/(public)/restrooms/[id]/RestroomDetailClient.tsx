"use client";

import React, { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import type { PublicRestroomDetail } from "@/lib/restrooms/types";
import MapDirectionsModal from "@/components/map/MapDirectionsModal";
import DepositPaymentButton from "@/components/payment/DepositPaymentButton";
import PinRevealPanel from "@/components/access/PinRevealPanel";
import type { CustomerAccessDetail } from "@/components/access/types";
import { PublicRestroomPhotoGallery } from "@/components/restroom/RestroomPhotoManager";
import {
  CompactOperatingHours,
  OperatingStatusBadge,
  PublicRestroomUnifiedSections,
  RestroomFacilitiesCard,
  evaluateOperatingStatus,
} from "@/components/restroom/restroom-detail-shared";
import { normalizePublicRestroomMetadata } from "@/lib/restrooms/public-metadata";
import { useVisitorSession, useEventTracker } from "@/lib/events/hooks";
import { useBasicUsageTracker } from "@/lib/usage-counts/hooks";
import {
  ANALYTICS_CONSENT_CHANGED_EVENT,
  ANALYTICS_SESSION_RESET_EVENT,
  isAnalyticsAllowed,
} from "@/lib/events/client";

export interface RestroomDetailClientProps {
  readonly restroom: PublicRestroomDetail;
  readonly currentUser?: { id: string; email?: string | null; name?: string | null } | null;
  readonly initialActiveAccess?: CustomerAccessDetail | null;
  readonly customPaymentRequester?: (options: any) => Promise<void>;
}

export default function RestroomDetailClient({
  restroom,
  currentUser = null,
  initialActiveAccess = null,
  customPaymentRequester,
}: RestroomDetailClientProps) {
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
  const canPayTestDeposit =
    isPartner && policyMode === "test_deposit" && depositAmountKrw !== null;

  const hasValidActiveAccess = Boolean(
    isPartner &&
      restroom.access_method === "pin" &&
      policyMode === "test_deposit" &&
      initialActiveAccess &&
      initialActiveAccess.session.restroom_id === restroom.id &&
      initialActiveAccess.session.access_method_snapshot === "pin" &&
      initialActiveAccess.order?.status === "approved" &&
      !initialActiveAccess.refund &&
      (initialActiveAccess.effectiveStatus === "authorized" ||
        initialActiveAccess.effectiveStatus === "code_revealed") &&
      new Date(initialActiveAccess.session.expires_at).getTime() > Date.now()
  );

  const operatingStatus = useMemo(
    () => evaluateOperatingStatus(restroom.hours, restroom.hour_exceptions),
    [restroom.hours, restroom.hour_exceptions]
  );

  const publicMetadata = useMemo(
    () => (!isPartner ? normalizePublicRestroomMetadata(restroom) : null),
    [isPartner, restroom]
  );

  useVisitorSession({ isAuthenticated: Boolean(currentUser) });
  const { trackDetailOpened, trackDirectionsClicked } = useEventTracker();
  const { trackBasicDetailOpened, trackBasicDirectionsClicked } =
    useBasicUsageTracker();

  useEffect(() => {
    trackBasicDetailOpened(restroom.id);
    trackDetailOpened({
      restroom,
      sourceComponent: "direct_url",
    });

    const handleAnalyticsSync = () => {
      if (isAnalyticsAllowed()) {
        trackDetailOpened({
          restroom,
          sourceComponent: "direct_url",
        });
      }
    };

    window.addEventListener(ANALYTICS_CONSENT_CHANGED_EVENT, handleAnalyticsSync);
    window.addEventListener(ANALYTICS_SESSION_RESET_EVENT, handleAnalyticsSync);
    return () => {
      window.removeEventListener(ANALYTICS_CONSENT_CHANGED_EVENT, handleAnalyticsSync);
      window.removeEventListener(ANALYTICS_SESSION_RESET_EVENT, handleAnalyticsSync);
    };
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

      {/* 1~4. 기본 정보 + 주소/전화번호 + 운영시간 + 길찾기/결제·PIN */}
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
          <p
            data-testid="detail-partner-phone"
            className="mt-1 text-xs text-slate-600 dark:text-slate-400"
          >
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

        {/* 3~4. 세로 스택 가로 전체 너비 액션 버튼: 길찾기 -> 보증금 결제 또는 비밀번호 확인 */}
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

          {hasValidActiveAccess && initialActiveAccess ? (
            <div data-testid="detail-active-access-box" className="mt-1">
              <PinRevealPanel
                session={initialActiveAccess.session}
                restroom={initialActiveAccess.restroom}
                order={initialActiveAccess.order}
                refund={initialActiveAccess.refund}
                compact={true}
              />
            </div>
          ) : canPayTestDeposit ? (
            <>
              <DepositPaymentButton
                restroom={restroom}
                defaultAmount={depositAmountKrw}
                initialUser={currentUser}
                customPaymentRequester={customPaymentRequester}
              />
              {restroom.access_method === "pin" && (
                <p
                  data-testid="detail-pin-after-payment-note"
                  className="text-center text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  🔐 결제 후 비밀번호 확인 가능
                </p>
              )}
            </>
          ) : null}
        </div>
      </div>

      {/* 5. 간단한 보증금/이용 안내 & 공공 통합 섹션 (3~6) */}
      {isPartner ? (
        policyMode === "free" ? (
          <div
            data-testid="partner-free-policy-box"
            className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-900 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-100"
          >
            <p className="font-bold text-sm">🤝 안심 제휴 무료 이용</p>
            <p className="mt-1 leading-relaxed text-slate-700 dark:text-slate-300">
              제휴 매장에서 보증금 없이 무료로 개방하는 화장실이에요.
            </p>
          </div>
        ) : policyMode === "test_deposit" && depositAmountKrw !== null ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-4 text-xs text-slate-900 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-bold text-sm">
                이용 보증금{" "}
                <span className="text-base font-extrabold text-purple-700 dark:text-purple-400">
                  {depositAmountKrw.toLocaleString()}원
                </span>
              </p>
              <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                테스트 결제 · 실제 청구 없음
              </span>
            </div>
            <p className="mt-1.5 leading-relaxed text-slate-700 dark:text-slate-300">
              결제 후 이용할 수 있어요. 매장에서 구매한 영수증이 승인되면 보증금을 돌려받을 수 있어요.
            </p>
          </div>
        ) : policyMode === "real_deposit" ? (
          <div
            data-testid="partner-real-deposit-policy-box"
            className="rounded-2xl border border-amber-200/70 bg-amber-50 p-4 text-xs text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <p className="font-bold text-sm">⚠️ 실거래 보증금 결제 미지원</p>
            <p className="mt-1 leading-relaxed">
              현재 테스트 환경에서는 실거래 보증금 결제가 비활성화되어 있습니다.
            </p>
          </div>
        ) : (
          <div
            data-testid="partner-missing-policy-box"
            className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-200"
          >
            <p className="font-bold text-sm">📋 이용 정책 확인 필요</p>
            <p className="mt-1 leading-relaxed">
              현재 활성화된 이용 정책 정보가 설정되지 않았습니다. 매장 안내를 확인해 주세요.
            </p>
          </div>
        )
      ) : (
        <PublicRestroomUnifiedSections
          restroom={restroom}
          metadata={publicMetadata!}
          showLegacyDisclosure={false}
        />
      )}

      {/* 6. 이용 조건 및 상세 규정 (필요한 경우 펼쳐보기) */}
      {isPartner && policyMode === "test_deposit" && depositAmountKrw !== null && (
        <details
          data-testid="restroom-policy-section"
          className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
        >
          <summary className="flex min-h-[36px] cursor-pointer list-none items-center justify-between gap-2 text-xs font-bold text-slate-800 dark:text-slate-100">
            <span>이용 조건 및 상세 규정 펼쳐보기</span>
            <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">
              상세 보기 ▾
            </span>
          </summary>

          <div
            data-testid="partner-deposit-policy-box"
            className="mt-3 space-y-2 border-t border-slate-100 pt-3 text-xs text-slate-700 dark:border-slate-800 dark:text-slate-300"
          >
            <ul className="list-disc space-y-1.5 pl-4 leading-relaxed">
              <li>
                <strong>테스트 보증금:</strong> {depositAmountKrw.toLocaleString()}원 (실제 결제 아님 / 테스트 모드)
              </li>
              <li>
                <strong>영수증 환급 조건:</strong>{" "}
                {activePolicy?.refund_eligible
                  ? "제휴 매장 실제 이용(구매) 영수증 사진을 제출한 후, 관리자 수동 심사를 거쳐 승인 완료 시에만 보증금 전액이 환급(테스트 결제 취소)됩니다. (OCR 및 자동 환급 없음, 심사 반려 시 미환급)"
                  : "환급 미대상 정책입니다."}
              </li>
              {activePolicy?.refund_eligible && (
                <li>
                  <strong>환급 신청 기한:</strong> 이용 시작 후{" "}
                  {activePolicy.receipt_window_hours ?? 24}시간 이내
                </li>
              )}
              {typeof activePolicy?.min_purchase_krw === "number" &&
                activePolicy.min_purchase_krw > 0 && (
                  <li>
                    <strong>최소 구매 기준:</strong>{" "}
                    {activePolicy.min_purchase_krw.toLocaleString()}원 이상 매장 이용 영수증
                  </li>
                )}
              <li>
                <strong>도어락 비밀번호:</strong> 결제 승인 완료 후에만 안전하게 공개됩니다.
              </li>
            </ul>
          </div>
        </details>
      )}

      {/* 7. 제휴 화장실 기타 시설 정보 (공공 화장실은 PublicRestroomUnifiedSections 내 통합) */}
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
