"use client";

import React from "react";
import type { PlaceSearchResult } from "@/lib/maps/place-search";
import type { PublicRestroomSummary } from "@/lib/restrooms/types";

export type PlaceSearchStatus = "idle" | "loading" | "ok" | "empty" | "error";

export interface PlaceSearchResultsProps {
  readonly status: PlaceSearchStatus;
  readonly results: readonly PlaceSearchResult[];
  readonly restroomResults?: readonly PublicRestroomSummary[];
  readonly query: string;
  readonly partialWarning?: string | null;
  readonly onSelect: (place: PlaceSearchResult) => void;
  readonly onSelectRestroom?: (restroom: PublicRestroomSummary) => void;
  readonly onRetry?: () => void;
}

/**
 * 지역/장소(카카오맵) + 휴지맵 등록 공개 화장실 이름 검색 결과 목록
 * - 선택 전에는 지도를 이동하지 않는다.
 * - 카카오 장소 결과와 휴지맵 화장실 결과를 명확히 구분해 표시한다.
 */
export default function PlaceSearchResults({
  status,
  results,
  restroomResults = [],
  query,
  partialWarning,
  onSelect,
  onSelectRestroom,
  onRetry,
}: PlaceSearchResultsProps) {
  if (status === "idle") return null;

  return (
    <div
      data-testid="place-search-results"
      className="mt-1.5 max-h-[50vh] overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-lg dark:border-slate-800 dark:bg-slate-900"
    >
      {status === "loading" && (
        <p
          data-testid="place-search-loading"
          role="status"
          className="px-3 py-3 text-xs text-slate-500 dark:text-slate-400"
        >
          장소와 등록 화장실을 검색하는 중...
        </p>
      )}

      {status === "empty" && (
        <p
          data-testid="place-search-empty"
          role="status"
          className="px-3 py-3 text-xs text-slate-600 dark:text-slate-300"
        >
          &quot;{query}&quot;에 대한 장소 및 화장실 검색 결과가 없습니다. 다른
          지역명이나 화장실 이름으로 검색해 보세요.
        </p>
      )}

      {status === "error" && (
        <div
          data-testid="place-search-error"
          role="alert"
          className="flex items-center justify-between gap-2 px-3 py-3 text-xs text-red-700 dark:text-red-300"
        >
          <span>검색에 실패했습니다. 지도는 그대로 유지됩니다.</span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="shrink-0 rounded bg-red-100 px-2 py-1 font-semibold text-red-700 hover:bg-red-200 dark:bg-red-950 dark:text-red-300"
            >
              다시 시도
            </button>
          )}
        </div>
      )}

      {status === "ok" && (
        <div className="divide-y divide-slate-200 dark:divide-slate-800">
          {partialWarning && (
            <p
              data-testid="search-partial-warning"
              className="bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
            >
              {partialWarning}
            </p>
          )}

          {/* 1. 휴지맵 DB 등록 공개 화장실 결과 */}
          {restroomResults.length > 0 && (
            <section
              aria-label="휴지맵 화장실 검색 결과"
              data-testid="search-section-restrooms"
            >
              <div className="bg-slate-50 px-3 py-1.5 text-[11px] font-bold text-slate-600 dark:bg-slate-800/70 dark:text-slate-300">
                🚻 휴지맵 등록 화장실 ({restroomResults.length})
              </div>
              <ul role="listbox" aria-label="휴지맵 등록 화장실 목록">
                {restroomResults.map((restroom) => {
                  const isPartner = restroom.type === "partner";
                  return (
                    <li key={restroom.id} role="option" aria-selected="false">
                      <button
                        type="button"
                        data-testid={`restroom-search-result-${restroom.id}`}
                        onClick={() => onSelectRestroom?.(restroom)}
                        className="flex min-h-[44px] w-full flex-col items-start gap-0.5 border-b border-slate-100 px-3 py-2 text-left last:border-b-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800"
                      >
                        <span className="flex w-full items-center gap-1.5">
                          <span
                            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                              isPartner
                                ? "bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-200"
                                : "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200"
                            }`}
                          >
                            {isPartner ? "휴지맵 제휴" : "휴지맵 공공"}
                          </span>
                          <span className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                            {restroom.name}
                          </span>
                        </span>
                        <span className="w-full truncate text-[11px] text-slate-500 dark:text-slate-400">
                          {isPartner && restroom.business_name
                            ? `${restroom.business_name} · ${restroom.road_address}`
                            : restroom.road_address}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* 2. 카카오 장소 검색 결과 */}
          {results.length > 0 && (
            <section
              aria-label="카카오 장소 검색 결과"
              data-testid="search-section-places"
            >
              <div className="bg-emerald-50/70 px-3 py-1.5 text-[11px] font-bold text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200">
                📍 지역·장소 (카카오맵 {results.length})
              </div>
              <ul role="listbox" aria-label="장소 검색 결과">
                {results.map((place) => (
                  <li key={place.id} role="option" aria-selected="false">
                    <button
                      type="button"
                      data-testid={`place-result-${place.id}`}
                      onClick={() => onSelect(place)}
                      className="flex min-h-[44px] w-full flex-col items-start gap-0.5 border-b border-slate-100 px-3 py-2 text-left last:border-b-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800"
                    >
                      <span className="flex w-full items-center gap-1.5">
                        <span className="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                          카카오 장소
                        </span>
                        <span className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                          {place.name}
                        </span>
                        {place.category && (
                          <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                            {place.category}
                          </span>
                        )}
                      </span>
                      <span className="w-full truncate text-[11px] text-slate-500 dark:text-slate-400">
                        {place.address}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
