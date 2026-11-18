"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import type {
  PublicRestroomDetail,
  GenderType,
  AccessMethod,
} from "@/lib/restrooms/types";
import MapDirectionsModal from "@/components/map/MapDirectionsModal";
import DepositPaymentButton from "@/components/payment/DepositPaymentButton";
import { useEventTracker } from "@/lib/events/hooks";

export interface RestroomDetailClientProps {
  readonly restroom: PublicRestroomDetail;
  readonly currentUser?: { id: string; email?: string | null; name?: string | null } | null;
  readonly customPaymentRequester?: (options: any) => Promise<void>;
}

const GENDER_LABELS: Record<GenderType, string> = {
  separate: "남녀 분리 화장실",
  unisex: "남녀 공용 화장실",
  male: "남성 전용 화장실",
  female: "여성 전용 화장실",
  unknown: "성별 구분 미확인",
};

const ACCESS_METHOD_LABELS: Record<AccessMethod, string> = {
  open: "상시 개방 (자유 출입)",
  ask_staff: "직원 문의 후 출입",
  pin: "도어락 비밀번호 잠금",
};

const WEEKDAY_NAMES = [
  "일요일",
  "월요일",
  "화요일",
  "수요일",
  "목요일",
  "금요일",
  "토요일",
];

export default function RestroomDetailClient({
  restroom,
  currentUser = null,
  customPaymentRequester,
}: RestroomDetailClientProps) {
  const [showDirections, setShowDirections] = useState<boolean>(false);
  const isPartner = restroom.type === "partner";
  const { trackDetailOpened, trackDirectionsClicked } = useEventTracker();

  useEffect(() => {
    trackDetailOpened({
      restroom,
      sourceComponent: "direct_url",
    });
  }, [restroom, trackDetailOpened]);

  return (
    <div
      data-testid="public-restroom-detail-view"
      className="flex flex-col gap-5 pb-10"
    >
      {/* 상단 네비게이션: 지도로 돌아가기 */}
      <div className="flex items-center justify-between">
        <Link
          href={`/map`}
          data-testid="back-to-map-link"
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-slate-100 px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
        >
          <span>←</span>
          <span>지도로 돌아가기</span>
        </Link>

        {restroom.last_verified_at && (
          <span className="text-[11px] text-slate-400">
            정보 검증일:{" "}
            {new Date(restroom.last_verified_at).toLocaleDateString("ko-KR")}
          </span>
        )}
      </div>

      {/* 기본 정보 헤더 */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-2 mb-2">
          {isPartner ? (
            <span
              data-testid="detail-partner-badge"
              className="inline-flex items-center rounded-md bg-purple-100 px-2.5 py-1 text-xs font-bold text-purple-800 dark:bg-purple-950/80 dark:text-purple-300"
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
        </div>

        <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">
          {restroom.name}
        </h1>

        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          📍 {restroom.road_address}
          {restroom.address_detail ? ` ${restroom.address_detail}` : ""}
          {restroom.floor ? ` (${restroom.floor})` : ""}
        </p>

        {restroom.description && (
          <p className="mt-3 text-xs leading-relaxed text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/50 p-3 rounded-xl">
            {restroom.description}
          </p>
        )}

        {/* 액션 버튼: 길찾기 & 제휴 결제 (공공은 결제 버튼 없음) */}
        <div className="mt-5 flex flex-col sm:flex-row items-center gap-2.5 pt-4 border-t border-slate-100 dark:border-slate-800">
          <button
            type="button"
            onClick={() => setShowDirections(true)}
            data-testid="detail-directions-btn"
            className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white shadow-md hover:bg-blue-700 active:scale-[0.99] transition"
          >
            <span>🧭</span>
            <span>길찾기 (카카오·네이버·구글)</span>
          </button>

          {/* 제휴 화장실에만 결제 버튼 제공 (공공 화장실은 렌더링되지 않음) */}
          {isPartner && (
            <DepositPaymentButton
              restroom={restroom}
              defaultAmount={1000}
              initialUser={currentUser}
              customPaymentRequester={customPaymentRequester}
            />
          )}
        </div>
      </div>

      {/* 이용 조건 및 정책 안내 */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-sm font-bold text-slate-900 dark:text-white mb-3">
          📋 이용 조건 및 규정
        </h2>

        {isPartner ? (
          <div className="space-y-3">
            <div className="rounded-xl bg-purple-50 p-3.5 text-xs text-purple-900 dark:bg-purple-950/40 dark:text-purple-200 border border-purple-200/50 dark:border-purple-900/50">
              <p className="font-bold text-sm mb-1">
                ⚠️ 제휴 화장실 안심 보증금 제도
              </p>
              <ul className="list-disc pl-4 space-y-1 text-xs">
                <li>
                  <strong>테스트 보증금:</strong> 1,000원 (실제 결제 아님 / 테스트 모드)
                </li>
                <li>
                  <strong>영수증 환급 조건:</strong> 제휴 매장 실제 이용(구매) 영수증
                  사진을 제출한 후, 관리자 수동 심사를 거쳐 승인 완료 시에만
                  보증금 전액이 환급(테스트 결제 취소)됩니다. (OCR 및 자동 환급 없음, 심사 반려 시 미환급)
                </li>
                <li>
                  <strong>환급 신청 기한:</strong> 이용 시작 후 24시간 이내 (테스트 기본값)
                </li>
                <li>
                  <strong>도어락 비밀번호:</strong> 결제 승인 완료 후에만 안전하게
                  공개됩니다. (현재 화면에 노출되지 않음)
                </li>
              </ul>
            </div>
          </div>
        ) : (
          <div className="rounded-xl bg-blue-50 p-3.5 text-xs text-blue-900 dark:bg-blue-950/40 dark:text-blue-200 border border-blue-200/50 dark:border-blue-900/50">
            <p className="font-bold text-sm mb-1">✨ 무료 공공 화장실</p>
            <p>
              누구나 자유롭게 이용할 수 있는 개방 화장실입니다. 별도의
              보증금이나 회원가입 없이 이용하실 수 있습니다.
            </p>
          </div>
        )}

        {/* 출입 방식 및 안내 */}
        <div className="mt-4 space-y-2 text-xs">
          <div className="flex items-center justify-between py-1.5 border-b border-slate-100 dark:border-slate-800">
            <span className="text-slate-500 dark:text-slate-400">출입 방식</span>
            <span className="font-semibold text-slate-800 dark:text-slate-200">
              {ACCESS_METHOD_LABELS[restroom.access_method] || "출입 안내"}
            </span>
          </div>

          {restroom.entrance_instructions && (
            <div className="py-1.5 border-b border-slate-100 dark:border-slate-800">
              <span className="text-slate-500 dark:text-slate-400 block mb-1">
                출입구 위치 및 안내
              </span>
              <p className="font-medium text-slate-800 dark:text-slate-200 bg-slate-50 dark:bg-slate-800 p-2 rounded-lg">
                {restroom.entrance_instructions}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* 시설 및 편의 기능 (휠체어 미확인 마커 포함) */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-sm font-bold text-slate-900 dark:text-white mb-3">
          ♿ 편의 시설 및 시설 구분
        </h2>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="flex items-center justify-between rounded-xl bg-slate-50 p-2.5 dark:bg-slate-800/60">
            <span className="text-slate-500 dark:text-slate-400">성별 구분</span>
            <span className="font-semibold text-slate-800 dark:text-slate-200">
              {GENDER_LABELS[restroom.gender_type] || "미확인"}
            </span>
          </div>

          <div className="flex items-center justify-between rounded-xl bg-slate-50 p-2.5 dark:bg-slate-800/60">
            <span className="text-slate-500 dark:text-slate-400">휠체어 접근</span>
            {restroom.wheelchair_accessible === true ? (
              <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                ♿ 이용 가능
              </span>
            ) : restroom.wheelchair_accessible === false ? (
              <span className="font-semibold text-slate-400">이용 불가</span>
            ) : (
              <span className="font-semibold text-amber-600 dark:text-amber-400">
                ❓ 정보 미확인
              </span>
            )}
          </div>

          <div className="flex items-center justify-between rounded-xl bg-slate-50 p-2.5 dark:bg-slate-800/60">
            <span className="text-slate-500 dark:text-slate-400">기저귀 교환대</span>
            <span className="font-semibold text-slate-800 dark:text-slate-200">
              {restroom.baby_changing_available ? "👶 설치됨" : "미설치"}
            </span>
          </div>

          <div className="flex items-center justify-between rounded-xl bg-slate-50 p-2.5 dark:bg-slate-800/60">
            <span className="text-slate-500 dark:text-slate-400">여성위생용품</span>
            <span className="font-semibold text-slate-800 dark:text-slate-200">
              {restroom.sanitary_products_available ? "🧴 비치됨" : "미비치"}
            </span>
          </div>
        </div>
      </div>

      {/* 운영 시간 정보 */}
      {restroom.hours && restroom.hours.length > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white mb-3">
            🕒 운영 시간
          </h2>

          <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
            {restroom.hours.map((h) => (
              <div
                key={h.id || h.weekday}
                className="flex items-center justify-between py-2"
              >
                <span className="font-medium text-slate-600 dark:text-slate-400">
                  {WEEKDAY_NAMES[h.weekday] || `${h.weekday}요일`}
                </span>
                <span className="font-semibold text-slate-900 dark:text-slate-200">
                  {h.is_closed
                    ? "휴무"
                    : h.opens_at && h.closes_at
                    ? `${h.opens_at.slice(0, 5)} ~ ${h.closes_at.slice(0, 5)}`
                    : "24시간 운영"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 제휴 가게 정보 (제휴 화장실인 경우에만 노출) */}
      {isPartner && restroom.business && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white mb-3">
            🏬 제휴 매장 안내
          </h2>
          <div className="space-y-1.5 text-xs text-slate-700 dark:text-slate-300">
            <p className="font-bold text-sm text-slate-900 dark:text-white">
              {restroom.business.name}
            </p>
            <p className="text-slate-500">
              업종: {restroom.business.category}
            </p>
            <p>위치: {restroom.business.road_address}</p>
            {restroom.business.phone && (
              <p>연락처: {restroom.business.phone}</p>
            )}
          </div>
        </div>
      )}

      {/* 사진 갤러리 */}
      {restroom.photos && restroom.photos.length > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white mb-3">
            📸 현장 사진
          </h2>
          <div className="grid grid-cols-2 gap-2">
            {restroom.photos.map((photo) => (
              <div
                key={photo.id}
                className="relative aspect-video rounded-xl overflow-hidden bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-xs text-slate-400"
              >
                <span>화장실 사진 ({photo.photo_type})</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 길찾기 모달 */}
      <MapDirectionsModal
        isOpen={showDirections}
        onClose={() => setShowDirections(false)}
        onDirectionsClick={(service) => {
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

