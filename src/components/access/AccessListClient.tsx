"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import AccessSessionCard from "./AccessSessionCard";
import type { CustomerAccessListItem } from "./types";

export interface AccessListClientProps {
  readonly initialItems?: CustomerAccessListItem[] | null;
  readonly autoFetchOnMount?: boolean;
}

type FilterTab = "all" | "active" | "inactive";

export default function AccessListClient({
  initialItems = null,
  autoFetchOnMount = false,
}: AccessListClientProps) {
  const [items, setItems] = useState<CustomerAccessListItem[]>(
    initialItems || []
  );
  const [isLoading, setIsLoading] = useState<boolean>(
    autoFetchOnMount && initialItems === null
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [filterTab, setFilterTab] = useState<FilterTab>("all");

  const fetchList = useCallback(async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/my/access/data", {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-store",
        },
        cache: "no-store",
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok && Array.isArray(body.data?.items)) {
        setItems(body.data.items);
      } else {
        setErrorMsg(
          body?.error?.message || "이용권 목록을 불러오지 못했습니다."
        );
      }
    } catch {
      setErrorMsg("네트워크 오류로 이용권 목록을 불러오지 못했습니다.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (autoFetchOnMount) {
      fetchList();
    }
  }, [autoFetchOnMount, fetchList]);

  const filteredItems = items.filter((item) => {
    const isActive =
      item.effectiveStatus === "authorized" ||
      item.effectiveStatus === "code_revealed";
    if (filterTab === "active") return isActive;
    if (filterTab === "inactive") return !isActive;
    return true;
  });

  return (
    <div
      data-testid="access-list-client"
      className="flex flex-col gap-4 pb-10 w-full max-w-md mx-auto"
    >
      {/* 상단 테스트 결제 워터마크 배너 (docs/05_SCREEN_SPEC.md 필수) */}
      <div
        data-testid="access-test-mode-watermark"
        className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200"
      >
        <span className="font-bold">⚠️ 테스트 결제 · 실제 돈은 청구되지 않음:</span>{" "}
        모든 보증금 이용권은 테스트 모드(1,000원)로만 동작합니다.
      </div>

      {/* 헤더 및 새로고침 */}
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-slate-900 dark:text-white">
            내 화장실 이용권
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            결제 승인된 제휴 화장실 이용권 및 도어락 PIN을 확인합니다.
          </p>
        </div>

        <button
          type="button"
          onClick={fetchList}
          disabled={isLoading}
          data-testid="refresh-access-list-btn"
          className="inline-flex min-h-[44px] shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
        >
          {isLoading ? "갱신 중..." : "↻ 새로고침"}
        </button>
      </div>

      {/* 필터 탭 */}
      <div
        role="tablist"
        aria-label="이용권 상태 필터"
        className="grid grid-cols-3 gap-1.5 rounded-xl bg-slate-100 p-1 dark:bg-slate-800"
      >
        <button
          type="button"
          role="tab"
          aria-selected={filterTab === "all"}
          onClick={() => setFilterTab("all")}
          data-testid="filter-tab-all"
          className={`min-h-[44px] rounded-lg px-2 py-1.5 text-xs font-bold transition ${
            filterTab === "all"
              ? "bg-white text-slate-900 shadow-xs dark:bg-slate-900 dark:text-white"
              : "text-slate-600 hover:text-slate-900 dark:text-slate-400"
          }`}
        >
          전체 ({items.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={filterTab === "active"}
          onClick={() => setFilterTab("active")}
          data-testid="filter-tab-active"
          className={`min-h-[44px] rounded-lg px-2 py-1.5 text-xs font-bold transition ${
            filterTab === "active"
              ? "bg-white text-purple-700 shadow-xs dark:bg-slate-900 dark:text-purple-300"
              : "text-slate-600 hover:text-slate-900 dark:text-slate-400"
          }`}
        >
          이용 가능
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={filterTab === "inactive"}
          onClick={() => setFilterTab("inactive")}
          data-testid="filter-tab-inactive"
          className={`min-h-[44px] rounded-lg px-2 py-1.5 text-xs font-bold transition ${
            filterTab === "inactive"
              ? "bg-white text-slate-900 shadow-xs dark:bg-slate-900 dark:text-white"
              : "text-slate-600 hover:text-slate-900 dark:text-slate-400"
          }`}
        >
          만료·종료
        </button>
      </div>

      {/* 오류 상태 */}
      {errorMsg && (
        <div
          role="alert"
          data-testid="access-list-error"
          className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <p className="font-bold">목록 조회 오류</p>
          <p className="mt-1">{errorMsg}</p>
        </div>
      )}

      {/* 로딩 상태 */}
      {isLoading && items.length === 0 ? (
        <div
          data-testid="access-list-loading"
          className="rounded-2xl border border-slate-200 bg-white p-8 text-center dark:border-slate-800 dark:bg-slate-900"
        >
          <div className="mx-auto mb-3 h-7 w-7 animate-spin rounded-full border-3 border-purple-600 border-t-transparent" />
          <p className="text-xs text-slate-500">
            이용권 목록을 불러오는 중입니다...
          </p>
        </div>
      ) : filteredItems.length === 0 ? (
        /* 빈 목록 상태 */
        <div
          data-testid="access-list-empty"
          className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-xs dark:border-slate-800 dark:bg-slate-900"
        >
          <p className="text-sm font-bold text-slate-800 dark:text-slate-200">
            조회된 화장실 이용권이 없습니다
          </p>
          <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            지도에서 안심 제휴 화장실을 선택하고 테스트 보증금을 결제하면 이곳에서
            이용권과 도어락 PIN을 확인할 수 있습니다.
          </p>
          <div className="mt-4">
            <Link
              href="/map"
              data-testid="empty-go-map-link"
              className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-blue-700"
            >
              화장실 지도로 이동하기
            </Link>
          </div>
        </div>
      ) : (
        /* 이용권 카드 목록 */
        <div
          data-testid="access-session-list"
          className="flex flex-col gap-3"
        >
          {filteredItems.map((item) => (
            <AccessSessionCard key={item.session.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

