"use client";

import React from "react";

export type RestroomFilterType = "all" | "public" | "partner";

export interface MapFilterBarProps {
  readonly searchKeyword: string;
  readonly onSearchChange: (keyword: string) => void;
  /** Enter 입력 시 즉시 장소 검색 */
  readonly onSearchSubmit?: (keyword: string) => void;
  readonly filterType: RestroomFilterType;
  readonly onFilterTypeChange: (type: RestroomFilterType) => void;
  readonly onCurrentLocationClick: () => void;
  readonly isLocating?: boolean;
  readonly totalCount?: number;
  readonly isLoading?: boolean;
}

export default function MapFilterBar({
  searchKeyword,
  onSearchChange,
  onSearchSubmit,
  filterType,
  onFilterTypeChange,
  onCurrentLocationClick,
  isLocating = false,
  totalCount,
  isLoading = false,
}: MapFilterBarProps) {
  return (
    <div
      data-testid="map-filter-bar"
      className="flex flex-col gap-2 p-2.5 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md rounded-2xl shadow-md border border-slate-200/80 dark:border-slate-800"
    >
      {/* 1행: 검색창 및 내 위치 버튼 */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400">
            <span>🔍</span>
          </div>
          <input
            type="text"
            value={searchKeyword}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="지역 또는 장소 검색 (예: 수원역, 행궁동)"
            aria-label="지역 또는 장소 검색"
            enterKeyHint="search"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                onSearchSubmit?.(searchKeyword);
              }
            }}
            data-testid="map-search-input"
            className="w-full rounded-xl border border-slate-300 bg-slate-50/70 py-2.5 pl-9 pr-8 text-xs text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-slate-700 dark:bg-slate-800 dark:text-white dark:placeholder-slate-500 dark:focus:bg-slate-850"
          />
          {searchKeyword && (
            <button
              type="button"
              onClick={() => onSearchChange("")}
              data-testid="map-search-clear-btn"
              className="absolute inset-y-0 right-0 flex items-center pr-2.5 text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
              aria-label="검색어 지우기"
            >
              ✕
            </button>
          )}
        </div>

        {/* 내 위치 버튼 */}
        <button
          type="button"
          onClick={onCurrentLocationClick}
          disabled={isLocating}
          data-testid="current-location-btn"
          title="현재 위치로 이동"
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-300 bg-white shadow-sm hover:bg-slate-50 active:scale-95 transition dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-750 disabled:opacity-50"
        >
          {isLocating ? (
            <span className="animate-spin text-base">⏳</span>
          ) : (
            <span className="text-base">📍</span>
          )}
        </button>
      </div>

      {/* 2행: 필터 칩 및 건수 표시 */}
      <div className="flex items-center justify-between gap-1">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 text-xs">
          <button
            type="button"
            data-testid="filter-chip-all"
            onClick={() => onFilterTypeChange("all")}
            className={`min-h-[36px] rounded-full px-3 py-1 font-medium transition ${
              filterType === "all"
                ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900 shadow-sm"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700"
            }`}
          >
            전체
          </button>

          <button
            type="button"
            data-testid="filter-chip-public"
            onClick={() => onFilterTypeChange("public")}
            className={`min-h-[36px] rounded-full px-3 py-1 font-medium transition ${
              filterType === "public"
                ? "bg-blue-600 text-white shadow-sm"
                : "bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-950/60 dark:text-blue-300 dark:hover:bg-blue-900/60"
            }`}
          >
            무료 공공
          </button>

          <button
            type="button"
            data-testid="filter-chip-partner"
            onClick={() => onFilterTypeChange("partner")}
            className={`min-h-[36px] rounded-full px-3 py-1 font-medium transition ${
              filterType === "partner"
                ? "bg-purple-600 text-white shadow-sm"
                : "bg-purple-50 text-purple-700 hover:bg-purple-100 dark:bg-purple-950/60 dark:text-purple-300 dark:hover:bg-purple-900/60"
            }`}
          >
            안심 제휴
          </button>
        </div>

        {/* 결과 건수 또는 로딩 */}
        <div className="shrink-0 text-[11px] text-slate-500 dark:text-slate-400 pl-1">
          {isLoading ? (
            <span className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
              조회 중
            </span>
          ) : totalCount !== undefined ? (
            <span>{totalCount}곳</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

