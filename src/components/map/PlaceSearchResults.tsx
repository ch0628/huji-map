"use client";

import React from "react";
import type { PlaceSearchResult } from "@/lib/maps/place-search";

export type PlaceSearchStatus = "idle" | "loading" | "ok" | "empty" | "error";

export interface PlaceSearchResultsProps {
  readonly status: PlaceSearchStatus;
  readonly results: readonly PlaceSearchResult[];
  readonly query: string;
  readonly onSelect: (place: PlaceSearchResult) => void;
  readonly onRetry?: () => void;
}

/** 지역/장소 검색 결과 목록 (선택 전에는 지도를 이동하지 않는다) */
export default function PlaceSearchResults({
  status,
  results,
  query,
  onSelect,
  onRetry,
}: PlaceSearchResultsProps) {
  if (status === "idle") return null;

  return (
    <div
      data-testid="place-search-results"
      className="mt-1.5 max-h-[45vh] overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-lg dark:border-slate-800 dark:bg-slate-900"
    >
      {status === "loading" && (
        <p
          data-testid="place-search-loading"
          role="status"
          className="px-3 py-3 text-xs text-slate-500 dark:text-slate-400"
        >
          장소를 검색하는 중...
        </p>
      )}

      {status === "empty" && (
        <p
          data-testid="place-search-empty"
          role="status"
          className="px-3 py-3 text-xs text-slate-600 dark:text-slate-300"
        >
          &quot;{query}&quot;에 대한 장소 검색 결과가 없습니다. 다른 지역명이나
          장소명으로 검색해 보세요.
        </p>
      )}

      {status === "error" && (
        <div
          data-testid="place-search-error"
          role="alert"
          className="flex items-center justify-between gap-2 px-3 py-3 text-xs text-red-700 dark:text-red-300"
        >
          <span>장소 검색에 실패했습니다. 지도는 그대로 유지됩니다.</span>
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
      )}
    </div>
  );
}
