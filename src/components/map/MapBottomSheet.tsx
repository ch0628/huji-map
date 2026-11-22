"use client";

import React from "react";
import type { PublicRestroomSummary } from "@/lib/restrooms/types";
import PublicRestroomCard from "@/components/restroom/PublicRestroomCard";

export interface MapBottomSheetProps {
  readonly selectedRestroom: PublicRestroomSummary | null;
  readonly restrooms: readonly PublicRestroomSummary[];
  readonly onSelectRestroom: (restroom: PublicRestroomSummary) => void;
  readonly onCloseSelected: () => void;
  readonly onDirectionsClick: (restroom: PublicRestroomSummary) => void;
  readonly onPaymentClick?: (restroom: PublicRestroomSummary) => void;
  readonly onDetailClick?: (restroom: PublicRestroomSummary) => void;
  readonly isExpanded: boolean;
  readonly onToggleExpand: () => void;
  readonly isLoading?: boolean;
  readonly searchKeyword?: string;
  /** 화장실 id → 기준점으로부터의 거리(m) */
  readonly distancesById?: Readonly<Record<string, number>>;
  /** 정렬 기준 설명 (예: "수원역 기준 가까운 순") */
  readonly sortBasisLabel?: string;
}

export default function MapBottomSheet({
  selectedRestroom,
  restrooms,
  onSelectRestroom,
  onCloseSelected,
  onDirectionsClick,
  onPaymentClick,
  onDetailClick,
  isExpanded,
  onToggleExpand,
  isLoading = false,
  distancesById,
  sortBasisLabel,
}: MapBottomSheetProps) {
  // 1. 단일 화장실이 선택된 경우 -> 외부 흰색 컨테이너 없이 하늘색 정보 카드 1개만 표시
  if (selectedRestroom) {
    return (
      <div
        data-testid="map-bottom-sheet-selected"
        className="absolute bottom-3 left-3 right-3 z-30 flex max-h-[62vh] flex-col rounded-2xl shadow-xl animate-in slide-in-from-bottom duration-200"
      >
        <button
          type="button"
          onClick={onCloseSelected}
          data-testid="bottom-sheet-close-btn"
          className="absolute right-1.5 top-1.5 z-20 flex h-10 w-10 items-center justify-center rounded-lg text-slate-900 hover:bg-slate-900/5 active:scale-95 dark:text-slate-100 dark:hover:bg-white/10"
          aria-label="선택 해제 및 닫기"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          >
            <path d="M3.5 3.5L12.5 12.5M12.5 3.5L3.5 12.5" />
          </svg>
        </button>

        <div className="flex-1 overflow-y-auto rounded-2xl">
          <PublicRestroomCard
            restroom={selectedRestroom}
            isSelected={true}
            reserveTopRightClose={true}
            distanceMeters={distancesById?.[selectedRestroom.id]}
            onDirectionsClick={onDirectionsClick}
            onPaymentClick={onPaymentClick}
            onDetailClick={onDetailClick}
          />
        </div>
      </div>
    );
  }

  // 2. 화장실 미선택 시 -> 하단 피크 바 또는 확장된 목록 모드
  return (
    <div
      data-testid="map-bottom-sheet-drawer"
      className="absolute bottom-2 left-2 right-2 z-30 transition-all duration-300 ease-in-out"
    >
      <div className="rounded-2xl border border-slate-200/90 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900 overflow-hidden">
        {/* 핸들 바 및 피크 헤더 */}
        <button
          type="button"
          onClick={onToggleExpand}
          data-testid="bottom-sheet-toggle-btn"
          className="flex min-h-[44px] w-full items-center justify-between px-4 py-2.5 text-left text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition"
        >
          <div className="flex items-center gap-2">
            <span className="text-sm">🧻</span>
            <span>
              {isLoading
                ? "화장실 정보 불러오는 중..."
                : restrooms.length > 0
                ? `이 지역 화장실 ${restrooms.length}곳`
                : "이 지역에 등록된 화장실 없음"}
            </span>
          </div>

          <div className="flex items-center gap-1.5 text-slate-400">
            <span className="text-[11px] font-normal">
              {isExpanded ? "접기" : "목록 보기"}
            </span>
            <span className="text-xs transition-transform">
              {isExpanded ? "▼" : "▲"}
            </span>
          </div>
        </button>

        {/* 확장된 상태: 화장실 목록 또는 빈 상태 안내 */}
        {isExpanded && (
          <div
            data-testid="bottom-sheet-expanded-content"
            className="max-h-[50vh] overflow-y-auto p-3 border-t border-slate-100 dark:border-slate-800 space-y-2.5"
          >
            {sortBasisLabel && restrooms.length > 0 && (
              <p
                data-testid="bottom-sheet-sort-basis"
                className="text-[11px] font-medium text-slate-500 dark:text-slate-400"
              >
                {sortBasisLabel}
              </p>
            )}
            {restrooms.length === 0 ? (
              <div
                data-testid="bottom-sheet-empty-state"
                className="py-6 text-center text-xs text-slate-500 dark:text-slate-400"
              >
                <div className="text-3xl mb-2">🔍</div>
                <p className="font-semibold text-slate-700 dark:text-slate-300">
                  표시할 화장실이 없습니다
                </p>
                <p className="mt-1 text-[11px]">
                  지도를 이동하거나 검색 조건을 변경해 보세요.
                </p>
              </div>
            ) : (
              restrooms.map((restroom) => (
                <PublicRestroomCard
                  key={restroom.id}
                  restroom={restroom}
                  compact={true}
                  distanceMeters={distancesById?.[restroom.id]}
                  onCardClick={onSelectRestroom}
                  onDirectionsClick={onDirectionsClick}
                  onPaymentClick={onPaymentClick}
                  onDetailClick={onDetailClick}
                />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

