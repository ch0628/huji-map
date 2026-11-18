"use client";

import React, { useRef, useState } from "react";
import {
  searchKakaoAddresses,
  type AddressSearchFn,
  type AddressSearchResult,
} from "@/lib/maps/address-search";

export interface AddressSearchFieldProps {
  readonly roadAddress: string;
  readonly jibunAddress?: string;
  readonly hasCoordinates: boolean;
  readonly disabled?: boolean;
  readonly showJibunAddress?: boolean;
  readonly roadAddressInputId: string;
  readonly jibunAddressInputId?: string;
  readonly roadAddressError?: string;
  readonly coordinatesError?: string;
  readonly onSelectAddress: (result: AddressSearchResult) => void;
  readonly addressSearchFn?: AddressSearchFn;
}

export default function AddressSearchField({
  roadAddress,
  jibunAddress = "",
  hasCoordinates,
  disabled = false,
  showJibunAddress = false,
  roadAddressInputId,
  jibunAddressInputId = "jibun-address",
  roadAddressError,
  coordinatesError,
  onSelectAddress,
  addressSearchFn = searchKakaoAddresses,
}: AddressSearchFieldProps) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "empty" | "error">("idle");
  const [results, setResults] = useState<AddressSearchResult[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const searchSeqRef = useRef(0);

  const handleSearch = async () => {
    if (disabled) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setStatus("error");
      setResults([]);
      setErrorMessage("검색할 도로명주소 또는 지번주소를 입력해 주세요.");
      return;
    }

    const seq = ++searchSeqRef.current;
    setStatus("loading");
    setErrorMessage(null);

    try {
      const items = await addressSearchFn(trimmed);
      if (seq !== searchSeqRef.current) return;
      setResults(items);
      setStatus(items.length > 0 ? "ok" : "empty");
    } catch (err: unknown) {
      if (seq !== searchSeqRef.current) return;
      setResults([]);
      setStatus("error");
      setErrorMessage(
        err instanceof Error
          ? err.message
          : "주소 검색 및 좌표 변환에 실패했습니다. 임의 좌표는 저장되지 않습니다."
      );
    }
  };

  const handleSelect = (item: AddressSearchResult) => {
    searchSeqRef.current += 1;
    setResults([]);
    setStatus("idle");
    setErrorMessage(null);
    onSelectAddress(item);
  };

  return (
    <div className="space-y-2.5" data-testid="address-search-field">
      {/* 주소 검색창 */}
      {!disabled && (
        <div>
          <label
            htmlFor={`${roadAddressInputId}-search`}
            className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
          >
            주소 검색 (도로명 또는 지번주소) <span className="text-rose-500">*</span>
          </label>
          <div className="mt-1 flex gap-2">
            <input
              id={`${roadAddressInputId}-search`}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void handleSearch();
                }
              }}
              placeholder="예: 경기도 수원시 팔달구 매산로 1 또는 매산로1가 18"
              data-testid="address-search-input"
              className="flex min-h-[44px] min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            />
            <button
              type="button"
              onClick={() => void handleSearch()}
              disabled={status === "loading"}
              data-testid="address-search-button"
              className="shrink-0 min-h-[44px] rounded-xl bg-slate-800 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-700 active:bg-slate-900 disabled:opacity-50 dark:bg-blue-600 dark:hover:bg-blue-700"
            >
              {status === "loading" ? "검색 중..." : "주소 검색"}
            </button>
          </div>
          <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
            도로명주소 또는 지번주소를 검색해 선택하면 위치 좌표가 자동으로 변환됩니다.
          </p>
        </div>
      )}

      {/* 검색 상태 및 결과 목록 */}
      {status === "empty" && (
        <div
          role="status"
          data-testid="address-search-empty"
          className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300"
        >
          일치하는 주소를 찾지 못했습니다. 도로명주소 또는 지번주소를 정확히 입력해 다시 검색해 주세요.
        </div>
      )}

      {status === "error" && errorMessage && (
        <div
          role="alert"
          data-testid="address-search-error"
          className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          ⚠️ {errorMessage}
        </div>
      )}

      {status === "ok" && results.length > 0 && (
        <ul
          role="listbox"
          aria-label="주소 검색 결과"
          data-testid="address-search-results"
          className="max-h-56 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-md dark:border-slate-700 dark:bg-slate-900 divide-y divide-slate-100 dark:divide-slate-800"
        >
          {results.map((item, idx) => (
            <li key={item.id} role="option" aria-selected="false">
              <button
                type="button"
                data-testid={`address-search-result-${idx}`}
                onClick={() => handleSelect(item)}
                className="flex min-h-[44px] w-full flex-col items-start gap-0.5 px-3 py-2.5 text-left hover:bg-blue-50/70 dark:hover:bg-slate-800"
              >
                <div className="flex w-full items-center gap-1.5">
                  <span className="shrink-0 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-800 dark:bg-blue-950 dark:text-blue-200">
                    {item.source === "jibun" ? "지번" : "도로명"}
                  </span>
                  <span className="truncate text-xs font-semibold text-slate-900 dark:text-white">
                    {item.roadAddress}
                  </span>
                  {item.buildingName && (
                    <span className="shrink-0 truncate max-w-[120px] text-[11px] text-slate-500 dark:text-slate-400">
                      ({item.buildingName})
                    </span>
                  )}
                </div>
                {item.jibunAddress && item.jibunAddress !== item.roadAddress && (
                  <span className="w-full truncate text-[11px] text-slate-500 dark:text-slate-400">
                    [지번] {item.jibunAddress}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* 선택된 도로명주소 (읽기 전용 - 주소 검색으로만 확정) */}
      <div>
        <label
          htmlFor={roadAddressInputId}
          className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
        >
          도로명주소 <span className="text-rose-500">*</span>
        </label>
        <input
          id={roadAddressInputId}
          name="road_address"
          type="text"
          readOnly
          required
          disabled={disabled}
          value={roadAddress}
          placeholder="위 주소 검색에서 주소를 선택하면 자동으로 입력됩니다."
          className={`mt-1 flex min-h-[44px] w-full rounded-xl border px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none ${
            disabled
              ? "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-500 dark:border-slate-700 dark:bg-slate-800/40"
              : "border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/70 dark:text-white"
          } ${roadAddressError ? "border-rose-400" : ""}`}
        />
        {roadAddressError && (
          <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">
            {roadAddressError}
          </p>
        )}
      </div>

      {/* 선택된 지번주소 (가게 등록 등 필요한 경우 표시) */}
      {showJibunAddress && (
        <div>
          <label
            htmlFor={jibunAddressInputId}
            className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
          >
            지번주소 (자동 입력)
          </label>
          <input
            id={jibunAddressInputId}
            name="jibun_address"
            type="text"
            readOnly
            disabled={disabled}
            value={jibunAddress}
            placeholder="주소 검색 선택 시 지번주소가 함께 입력됩니다."
            className="mt-1 flex min-h-[44px] w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 placeholder:text-slate-400 focus:outline-none disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-300"
          />
        </div>
      )}

      {/* 자동 좌표 변환 상태 배지 (수동 위도·경도 입력란 없음) */}
      {hasCoordinates && roadAddress.trim().length > 0 ? (
        <div
          data-testid="address-coords-confirmed"
          className="rounded-xl border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-[11px] font-medium text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200"
        >
          ✓ 선택한 주소에서 위치 좌표가 자동으로 확인되었습니다.
        </div>
      ) : (
        <div
          data-testid="address-coords-missing"
          className={`rounded-xl border px-3 py-2 text-[11px] ${
            coordinatesError
              ? "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-200"
              : "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400"
          }`}
        >
          {coordinatesError ||
            "위치 좌표는 주소 검색에서 도로명주소 또는 지번주소를 선택하면 자동으로 생성됩니다."}
        </div>
      )}
    </div>
  );
}
