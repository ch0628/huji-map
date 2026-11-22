"use client";

import React from "react";
import Link from "next/link";
import { formatDistance } from "@/lib/maps/geo";
import type {
  PublicRestroomSummary,
  AccessMethod,
  GenderType,
} from "@/lib/restrooms/types";

export interface PublicRestroomCardProps {
  readonly restroom: PublicRestroomSummary;
  readonly isSelected?: boolean;
  readonly compact?: boolean;
  readonly onDirectionsClick?: (restroom: PublicRestroomSummary) => void;
  readonly onCardClick?: (restroom: PublicRestroomSummary) => void;
  readonly onPaymentClick?: (restroom: PublicRestroomSummary) => void;
  readonly onDetailClick?: (restroom: PublicRestroomSummary) => void;
  readonly showDetailLink?: boolean;
  readonly reserveTopRightClose?: boolean;
  /** 탐색 기준점으로부터의 거리(m) */
  readonly distanceMeters?: number;
}

const GENDER_LABELS: Record<GenderType, string> = {
  separate: "남녀 분리",
  unisex: "남녀 공용",
  male: "남성 전용",
  female: "여성 전용",
  unknown: "성별 구분 미확인",
};

const ACCESS_METHOD_LABELS: Record<AccessMethod, string> = {
  open: "상시 개방",
  ask_staff: "직원 문의",
  pin: "도어락 비밀번호",
};

export default function PublicRestroomCard({
  restroom,
  isSelected = false,
  compact = false,
  onDirectionsClick,
  onCardClick,
  onPaymentClick,
  onDetailClick,
  showDetailLink = true,
  reserveTopRightClose = false,
  distanceMeters,
}: PublicRestroomCardProps) {
  const isPartner = restroom.type === "partner";

  const handleCardClick = (e: React.MouseEvent) => {
    // 버튼이나 링크 클릭 시 카드 클릭 이벤트 전파 방지
    const target = e.target as HTMLElement;
    if (target.closest("button") || target.closest("a")) {
      return;
    }
    onCardClick?.(restroom);
  };

  return (
    <article
      data-testid={`public-restroom-card-${restroom.id}`}
      data-restroom-type={restroom.type}
      onClick={handleCardClick}
      className={`rounded-2xl border transition-all ${
        isSelected
          ? "border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-slate-900"
          : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 shadow-sm hover:border-slate-300 dark:hover:border-slate-700"
      } ${compact ? "p-3.5" : "p-4"}`}
    >
      {/* 상단: 구분 뱃지 및 이름 (+ 승인된 대표 사진 썸네일) */}
      <div className={`flex items-start justify-between gap-2.5 ${reserveTopRightClose ? "pr-9" : ""}`}>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {/* 공공 vs 제휴 구분 뱃지 */}
            {isPartner ? (
              <span
                data-testid="restroom-type-partner-badge"
                className="inline-flex shrink-0 whitespace-nowrap items-center rounded-md bg-purple-100 px-2 py-0.5 text-xs font-bold text-purple-800 dark:bg-purple-950/80 dark:text-purple-300"
              >
                🤝 안심 제휴
              </span>
            ) : (
              <span
                data-testid="restroom-type-public-badge"
                className="inline-flex shrink-0 whitespace-nowrap items-center rounded-md bg-blue-100 px-2 py-0.5 text-xs font-bold text-blue-800 dark:bg-blue-950/80 dark:text-blue-300"
              >
                🏛️ 무료 공공
              </span>
            )}

            <h3 className="min-w-0 break-keep truncate text-base font-bold text-slate-900 dark:text-white">
              {restroom.name}
            </h3>
          </div>

          <p className="mt-1 truncate text-xs text-slate-600 dark:text-slate-400">
            {restroom.road_address}
            {restroom.address_detail ? ` ${restroom.address_detail}` : ""}
          </p>
          {distanceMeters !== undefined && (<p data-testid={`restroom-distance-${restroom.id}`} className="mt-0.5 text-xs font-semibold text-blue-700 dark:text-blue-300">📍 {formatDistance(distanceMeters)}</p>)}
        </div>

        {restroom.primary_photo_url && (
          <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-800">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={restroom.primary_photo_url}
              alt={`${restroom.name} 대표 사진`}
              data-testid={`public-restroom-thumb-${restroom.id}`}
              className="h-full w-full object-cover"
            />
          </div>
        )}
      </div>

      {/* 이용 조건 안내 배너 */}
      <div className="mt-2.5 rounded-lg bg-slate-50 p-2 text-xs text-slate-700 dark:bg-slate-800/70 dark:text-slate-300">
        {isPartner ? (
          restroom.access_mode === "free" ? (
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center justify-between font-medium">
                <span className="text-emerald-700 dark:text-emerald-300">
                  🤝 안심 제휴 무료 이용
                </span>
                <span className="font-bold text-emerald-900 dark:text-emerald-200">
                  무료
                </span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                제휴 매장에서 보증금 없이 무료로 개방하는 화장실입니다.
              </p>
            </div>
          ) : restroom.access_mode === "test_deposit" ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2 font-bold">
                <span className="text-slate-900 dark:text-white">
                  이용 보증금{" "}
                  <span
                    data-testid={`partner-deposit-amount-${restroom.id}`}
                    className="text-purple-700 dark:text-purple-400"
                  >
                    {typeof restroom.deposit_amount_krw === "number" &&
                    restroom.deposit_amount_krw > 0
                      ? `${restroom.deposit_amount_krw.toLocaleString()}원`
                      : "금액 확인 필요"}
                  </span>
                </span>
                <span className="shrink-0 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
                  테스트 · 실제 청구 없음
                </span>
              </div>
              <p className="text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">
                결제 후 이용할 수 있어요. 매장에서 구매한 영수증이 승인되면 보증금을 돌려받을 수 있어요.
              </p>
            </div>
          ) : restroom.access_mode === "real_deposit" ? (
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center justify-between font-medium">
                <span className="text-amber-700 dark:text-amber-300">
                  ⚠️ 실거래 보증금 정책
                </span>
                <span className="font-bold text-amber-900 dark:text-amber-200">
                  결제 미지원
                </span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                현재 실거래 보증금 결제는 지원되지 않습니다.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center justify-between font-medium">
                <span className="text-slate-700 dark:text-slate-300">
                  📋 제휴 이용 조건
                </span>
                <span className="font-bold text-slate-900 dark:text-slate-200">
                  정책 확인 필요
                </span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                상세 페이지에서 최신 이용 조건을 확인해 주세요.
              </p>
            </div>
          )
        ) : (
          <div className="flex items-center justify-between font-medium">
            <span className="text-blue-700 dark:text-blue-300">
              ✨ 누구나 무료 이용
            </span>
            <span className="font-bold text-blue-900 dark:text-blue-200">
              무료
            </span>
          </div>
        )}
      </div>

      {/* 속성 배지 목록 */}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[11px]">
        {/* 출입 방식 */}
        <span className="rounded bg-slate-100 px-2 py-0.5 font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">
          🔑 {ACCESS_METHOD_LABELS[restroom.access_method] || "출입 안내"}
        </span>

        {/* 성별 구분 */}
        <span className="rounded bg-slate-100 px-2 py-0.5 font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">
          🚻 {GENDER_LABELS[restroom.gender_type] || "성별 미확인"}
        </span>

        {/* 편의 시설 */}
        {restroom.wheelchair_accessible === true && (
          <span className="rounded bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
            ♿ 휠체어 이용 가능
          </span>
        )}
        {restroom.wheelchair_accessible === false && (
          <span className="rounded bg-slate-50 px-2 py-0.5 text-slate-400 dark:bg-slate-800/40 dark:text-slate-500">
            휠체어 진입 어려움
          </span>
        )}
        {restroom.wheelchair_accessible === null && (
          <span className="rounded bg-slate-50 px-2 py-0.5 text-slate-400 dark:bg-slate-800/40 dark:text-slate-500">
            휠체어 정보 미확인
          </span>
        )}

        {restroom.baby_changing_available && (
          <span className="rounded bg-amber-50 px-2 py-0.5 font-medium text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
            👶 기저귀대
          </span>
        )}

        {restroom.sanitary_products_available && (
          <span className="rounded bg-pink-50 px-2 py-0.5 font-medium text-pink-700 dark:bg-pink-950/60 dark:text-pink-300">
            🧴 위생용품
          </span>
        )}
      </div>

      {/* 액션 버튼 영역 */}
      <div className="mt-3.5 flex flex-wrap items-center gap-2 pt-3 border-t border-slate-100 dark:border-slate-800/80">
        {/* 길찾기 버튼: 공공/제휴 공통 지원 */}
        <button
          type="button"
          onClick={() => onDirectionsClick?.(restroom)}
          data-testid={`directions-btn-${restroom.id}`}
          className="flex min-h-[44px] flex-1 basis-[110px] items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-blue-600 px-3 py-2 text-xs font-semibold text-white shadow-sm hover:bg-blue-700 active:scale-[0.98] transition"
        >
          <span>🧭</span>
          <span>길찾기</span>
        </button>

        {/* 상세 페이지 링크 (test_deposit 제휴 화장실은 상세 페이지에서 보증금 결제 진행) */}
        {showDetailLink && (
          <Link
            href={`/restrooms/${restroom.id}`}
            onClick={() => {
              if (isPartner && restroom.access_mode === "test_deposit") {
                onPaymentClick?.(restroom);
              }
              onDetailClick?.(restroom);
            }}
            data-testid={`detail-link-${restroom.id}`}
            className={`flex min-h-[44px] flex-1 basis-[130px] items-center justify-center whitespace-nowrap rounded-xl px-3 py-2 text-xs font-semibold transition ${
              isPartner && restroom.access_mode === "test_deposit"
                ? "bg-purple-600 text-white shadow-sm hover:bg-purple-700"
                : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-750"
            }`}
          >
            {isPartner && restroom.access_mode === "test_deposit"
              ? "보증금 결제 · 상세 →"
              : "상세보기 →"}
          </Link>
        )}
      </div>
    </article>
  );
}

