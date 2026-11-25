"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import RestroomStatusBadge from "@/components/restroom/RestroomStatusBadge";
import type {
  AdminRestroomDetail,
  AdminRestroomInventoryItem,
  AdminRestroomInventoryResult,
  AdminRestroomStats,
} from "@/lib/restrooms";

const STATUS_OPTIONS = [
  { value: "all", label: "상태 전체" },
  { value: "published", label: "공개 중 (published)" },
  { value: "draft", label: "초안 (draft)" },
  { value: "pending", label: "승인 대기 (pending)" },
  { value: "suspended", label: "공개 중단 (suspended)" },
  { value: "archived", label: "보관됨 (archived)" },
] as const;

const TYPE_OPTIONS = [
  { value: "all", label: "유형 전체" },
  { value: "public", label: "공공 화장실" },
  { value: "partner", label: "제휴 화장실" },
] as const;

const SOURCE_OPTIONS = [
  { value: "all", label: "출처 전체" },
  { value: "seoul_oa22586", label: "서울 OA-22586" },
  { value: "suwon_15011425", label: "수원/경기도 15011425" },
  { value: "partner", label: "제휴 매장 등록" },
  { value: "other", label: "기타 출처" },
] as const;

const VERIFICATION_OPTIONS = [
  { value: "all", label: "좌표 검증 전체" },
  { value: "official_validated", label: "공식자료 검증" },
  { value: "field_verified", label: "현장 검증 완료" },
  { value: "review_required", label: "검토 필요" },
  { value: "legacy_unset", label: "기존 공식 기준(미기록)" },
  { value: "partner_direct", label: "제휴 매장 등록" },
] as const;

const SORT_OPTIONS = [
  { value: "created_desc", label: "등록 최신순" },
  { value: "created_asc", label: "등록 오래된순" },
  { value: "name_asc", label: "이름 가나다순" },
  { value: "name_desc", label: "이름 역순" },
] as const;

const DEFAULT_PAGE_LIMIT = 50;

export default function AdminRestroomInventoryClient() {
  const [stats, setStats] = useState<AdminRestroomStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [showAllSeoulGus, setShowAllSeoulGus] = useState(false);

  // Inventory filter/sort/pagination state
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [regionFilter, setRegionFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [verificationFilter, setVerificationFilter] = useState("all");
  const [sortOrder, setSortOrder] = useState("created_desc");
  const [page, setPage] = useState(1);

  const [inventory, setInventory] = useState<AdminRestroomInventoryResult | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  // Read-only detail modal state
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminRestroomDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsError(null);
    try {
      const res = await fetch("/api/v1/admin/restrooms/stats");
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json.error?.message || "통계 정보를 불러오지 못했습니다.");
      }
      setStats(json.data);
    } catch (err: unknown) {
      setStatsError(err instanceof Error ? err.message : "통계 조회 오류");
    } finally {
      setStatsLoading(false);
    }
  }, []);

  const loadInventory = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const params = new URLSearchParams({
        region: regionFilter,
        type: typeFilter,
        status: statusFilter,
        source: sourceFilter,
        verification: verificationFilter,
        sort: sortOrder,
        page: String(page),
        limit: String(DEFAULT_PAGE_LIMIT),
      });
      if (searchQuery) params.set("q", searchQuery);

      const res = await fetch(`/api/v1/admin/restrooms/inventory?${params.toString()}`);
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json.error?.message || "화장실 목록을 불러오지 못했습니다.");
      }
      setInventory(json.data);
    } catch (err: unknown) {
      setListError(err instanceof Error ? err.message : "목록 조회 오류");
    } finally {
      setListLoading(false);
    }
  }, [
    regionFilter,
    typeFilter,
    statusFilter,
    sourceFilter,
    verificationFilter,
    sortOrder,
    page,
    searchQuery,
  ]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  useEffect(() => {
    loadInventory();
  }, [loadInventory]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    setSearchQuery(searchInput.trim());
  };

  const resetFilters = () => {
    setSearchInput("");
    setSearchQuery("");
    setRegionFilter("all");
    setTypeFilter("all");
    setStatusFilter("all");
    setSourceFilter("all");
    setVerificationFilter("all");
    setSortOrder("created_desc");
    setPage(1);
  };

  const openDetail = async (item: AdminRestroomInventoryItem) => {
    setSelectedId(item.id);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/v1/admin/restrooms/${item.id}`);
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json.error?.message || "화장실 상세 정보를 불러오지 못했습니다.");
      }
      setDetail(json.data);
    } catch (err: unknown) {
      setDetailError(err instanceof Error ? err.message : "상세 조회 오류");
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => {
    setSelectedId(null);
    setDetail(null);
    setDetailError(null);
  };

  const seoulGus = stats?.bySeoulGu ?? [];
  const startRow =
    inventory && inventory.total > 0 ? (inventory.page - 1) * inventory.limit + 1 : 0;
  const endRow =
    inventory && inventory.total > 0
      ? Math.min(inventory.page * inventory.limit, inventory.total)
      : 0;

  return (
    <div
      data-testid="admin-inventory-container"
      className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-4 p-4"
    >
      {/* 상단 헤더 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-lg font-bold text-slate-900 dark:text-white">
            전체 화장실 현황 및 목록
          </h1>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            DB에 등록된 전체 화장실(`restrooms`) 기준 집계와 서버 페이지네이션 목록입니다.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/admin/restrooms"
            className="inline-flex min-h-[38px] items-center rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
          >
            심사 관리로 이동
          </Link>
        </div>
      </div>

      {/* TASK 1 — 통계 집계 영역 */}
      {statsError && (
        <div
          role="alert"
          className="rounded-2xl border border-rose-300 bg-rose-50 p-4 text-xs text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          {statsError}
        </div>
      )}

      {statsLoading && !stats ? (
        <div
          data-testid="admin-stats-loading"
          className="grid grid-cols-2 gap-2.5 sm:grid-cols-4"
        >
          {Array.from({ length: 4 }).map((_, idx) => (
            <div
              key={idx}
              className="h-20 animate-pulse rounded-2xl border border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-800"
            />
          ))}
        </div>
      ) : stats ? (
        <section aria-label="관리자 화장실 통계" className="flex flex-col gap-3">
          {/* 핵심 지표 4종 */}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <div
              data-testid="stat-total-count"
              className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm dark:border-slate-800 dark:bg-slate-900"
            >
              <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                전체 등록 DB
              </p>
              <p className="mt-1 text-xl font-extrabold text-slate-900 dark:text-white">
                {stats.totalCount.toLocaleString()}건
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                공공 {stats.byType.public.toLocaleString()} · 제휴 {stats.byType.partner.toLocaleString()}
              </p>
            </div>

            <div
              data-testid="stat-map-visible-count"
              className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-3.5 shadow-sm dark:border-emerald-900/60 dark:bg-emerald-950/30"
            >
              <p className="text-[11px] font-medium text-emerald-800 dark:text-emerald-300">
                실제 지도 공개
              </p>
              <p className="mt-1 text-xl font-extrabold text-emerald-900 dark:text-emerald-200">
                {stats.mapVisibleCount.toLocaleString()}건
              </p>
              <p className="mt-0.5 text-[11px] text-emerald-700 dark:text-emerald-400">
                비공개/미노출 {stats.hiddenCount.toLocaleString()}건
              </p>
            </div>

            <div
              data-testid="stat-region-summary"
              className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm dark:border-slate-800 dark:bg-slate-900"
            >
              <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                주요 지역별
              </p>
              <p className="mt-1 text-sm font-bold text-slate-900 dark:text-white">
                서울 {stats.regionSummary.seoulTotal.toLocaleString()} · 수원{" "}
                {stats.regionSummary.suwonTotal.toLocaleString()}
              </p>
              <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                기타 {stats.regionSummary.otherTotal.toLocaleString()}건
              </p>
            </div>

            <div
              data-testid="stat-status-summary"
              className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm dark:border-slate-800 dark:bg-slate-900"
            >
              <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                공개 상태별
              </p>
              <p className="mt-1 text-xs font-semibold text-slate-900 dark:text-white">
                공개 {stats.byPublicationStatus.published.toLocaleString()} · 대기{" "}
                {stats.byPublicationStatus.pending.toLocaleString()}
              </p>
              <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                초안 {stats.byPublicationStatus.draft.toLocaleString()} · 중단{" "}
                {stats.byPublicationStatus.suspended.toLocaleString()} · 보관{" "}
                {stats.byPublicationStatus.archived.toLocaleString()}
              </p>
            </div>
          </div>

          {/* 출처별 / 좌표 검증별 / 서울 자치구별 상세 집계 */}
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
            <div
              data-testid="stat-by-source"
              className="rounded-2xl border border-slate-200 bg-white p-3.5 text-xs shadow-sm dark:border-slate-800 dark:bg-slate-900"
            >
              <h2 className="font-bold text-slate-900 dark:text-white">데이터 출처별 건수</h2>
              <ul className="mt-2 space-y-1.5">
                {stats.byDataSource.map((src) => (
                  <li
                    key={src.key}
                    className="flex items-center justify-between gap-2 text-slate-700 dark:text-slate-300"
                  >
                    <span className="truncate">{src.label}</span>
                    <span className="shrink-0 font-bold text-slate-900 dark:text-white">
                      {src.total.toLocaleString()}건
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div
              data-testid="stat-by-verification"
              className="rounded-2xl border border-slate-200 bg-white p-3.5 text-xs shadow-sm dark:border-slate-800 dark:bg-slate-900"
            >
              <h2 className="font-bold text-slate-900 dark:text-white">좌표 검증 상태별 건수</h2>
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-slate-700 dark:text-slate-300">
                <div className="flex justify-between">
                  <span>공식자료 검증</span>
                  <strong className="text-slate-900 dark:text-white">
                    {stats.byVerificationStatus.officialValidated.toLocaleString()}
                  </strong>
                </div>
                <div className="flex justify-between">
                  <span>현장 검증</span>
                  <strong className="text-slate-900 dark:text-white">
                    {stats.byVerificationStatus.fieldVerified.toLocaleString()}
                  </strong>
                </div>
                <div className="flex justify-between">
                  <span>검토 필요</span>
                  <strong className="text-slate-900 dark:text-white">
                    {stats.byVerificationStatus.reviewRequired.toLocaleString()}
                  </strong>
                </div>
                <div className="flex justify-between">
                  <span>기존 공식(미기록)</span>
                  <strong className="text-slate-900 dark:text-white">
                    {stats.byVerificationStatus.legacyUnset.toLocaleString()}
                  </strong>
                </div>
              </div>
              <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
                * DB 등록 레코드(`restrooms`)만 집계하며 미적재 후보·보류 데이터는 제외됩니다.
              </p>
            </div>
          </div>

          {/* 지역별 세부 (수원 + 서울 자치구) */}
          {seoulGus.length > 0 && (
            <div
              data-testid="stat-by-seoul-gu"
              className="rounded-2xl border border-slate-200 bg-white p-3.5 text-xs shadow-sm dark:border-slate-800 dark:bg-slate-900"
            >
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-bold text-slate-900 dark:text-white">
                  서울 자치구별 분포 ({seoulGus.length}개 구)
                </h2>
                <button
                  type="button"
                  onClick={() => setShowAllSeoulGus((v) => !v)}
                  data-testid="toggle-seoul-gus-btn"
                  className="text-[11px] font-semibold text-blue-600 hover:underline dark:text-blue-400"
                >
                  {showAllSeoulGus ? "접기 ▲" : "전체 자치구 보기 ▼"}
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(showAllSeoulGus ? seoulGus : seoulGus.slice(0, 8)).map((gu) => (
                  <button
                    key={gu.key}
                    type="button"
                    onClick={() => {
                      setRegionFilter(gu.key);
                      setPage(1);
                    }}
                    className={`rounded-lg border px-2.5 py-1 text-[11px] transition ${
                      regionFilter === gu.key
                        ? "border-blue-600 bg-blue-600 font-semibold text-white"
                        : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                    }`}
                  >
                    {gu.label.replace(/^서울\s*/, "")} {gu.total.toLocaleString()}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      ) : null}

      {/* TASK 2 — 검색 / 필터 / 정렬 컨트롤 */}
      <section
        aria-label="화장실 검색 및 필터"
        className="flex flex-col gap-2.5 rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm dark:border-slate-800 dark:bg-slate-900"
      >
        <form onSubmit={handleSearchSubmit} className="flex gap-2">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="시설명 또는 주소 검색 (예: 일원본동, 수원시청)"
            aria-label="시설명 또는 주소 검색"
            data-testid="inventory-search-input"
            className="min-w-0 flex-1 rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-900 focus:border-blue-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
          />
          <button
            type="submit"
            data-testid="inventory-search-submit"
            className="min-h-[38px] shrink-0 rounded-xl bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-700"
          >
            검색
          </button>
          <button
            type="button"
            onClick={resetFilters}
            data-testid="inventory-reset-filters"
            className="min-h-[38px] shrink-0 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
          >
            초기화
          </button>
        </form>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <select
            aria-label="지역 필터"
            data-testid="filter-region"
            value={regionFilter}
            onChange={(e) => {
              setRegionFilter(e.target.value);
              setPage(1);
            }}
            className="min-h-[38px] rounded-xl border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="all">지역 전체</option>
            <option value="seoul">서울 전체</option>
            <option value="suwon">경기도 수원시</option>
            <option value="other">기타 지역</option>
            {seoulGus.map((gu) => (
              <option key={gu.key} value={gu.key}>
                {gu.label} ({gu.total})
              </option>
            ))}
          </select>

          <select
            aria-label="공공 제휴 필터"
            data-testid="filter-type"
            value={typeFilter}
            onChange={(e) => {
              setTypeFilter(e.target.value);
              setPage(1);
            }}
            className="min-h-[38px] rounded-xl border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            {TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          <select
            aria-label="공개 상태 필터"
            data-testid="filter-status"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            className="min-h-[38px] rounded-xl border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          <select
            aria-label="데이터 출처 필터"
            data-testid="filter-source"
            value={sourceFilter}
            onChange={(e) => {
              setSourceFilter(e.target.value);
              setPage(1);
            }}
            className="min-h-[38px] rounded-xl border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            {SOURCE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          <select
            aria-label="좌표 검증 상태 필터"
            data-testid="filter-verification"
            value={verificationFilter}
            onChange={(e) => {
              setVerificationFilter(e.target.value);
              setPage(1);
            }}
            className="min-h-[38px] rounded-xl border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            {VERIFICATION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          <select
            aria-label="정렬 기준"
            data-testid="filter-sort"
            value={sortOrder}
            onChange={(e) => {
              setSortOrder(e.target.value);
              setPage(1);
            }}
            className="min-h-[38px] rounded-xl border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* 필터 결과 건수 및 페이지네이션 상단 바 */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-300">
        <p data-testid="inventory-filtered-count">
          검색 결과 총{" "}
          <strong className="text-slate-900 dark:text-white">
            {(inventory?.total ?? 0).toLocaleString()}건
          </strong>
          {inventory && inventory.total > 0 ? ` (${startRow}~${endRow}건 표시)` : ""}
        </p>

        {inventory && inventory.totalPages > 1 && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={page <= 1 || listLoading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              data-testid="pagination-prev-top"
              className="min-h-[34px] rounded-lg border border-slate-300 bg-white px-2.5 py-1 font-semibold disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900"
            >
              이전
            </button>
            <span data-testid="pagination-page-label" className="px-1.5 font-medium">
              {inventory.page} / {inventory.totalPages}
            </span>
            <button
              type="button"
              disabled={page >= inventory.totalPages || listLoading}
              onClick={() => setPage((p) => p + 1)}
              data-testid="pagination-next-top"
              className="min-h-[34px] rounded-lg border border-slate-300 bg-white px-2.5 py-1 font-semibold disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900"
            >
              다음
            </button>
          </div>
        )}
      </div>

      {/* 목록 */}
      {listError && (
        <div
          role="alert"
          className="rounded-2xl border border-rose-300 bg-rose-50 p-4 text-xs text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          {listError}
        </div>
      )}

      {listLoading ? (
        <div className="space-y-2.5" data-testid="inventory-list-loading">
          {Array.from({ length: 5 }).map((_, idx) => (
            <div
              key={idx}
              className="h-24 animate-pulse rounded-2xl border border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-800"
            />
          ))}
        </div>
      ) : inventory && inventory.items.length === 0 ? (
        <div
          data-testid="inventory-empty"
          className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400"
        >
          조건에 일치하는 화장실이 없습니다.
        </div>
      ) : (
        <div className="space-y-2.5" data-testid="inventory-list">
          {inventory?.items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => openDetail(item)}
              data-testid={`inventory-item-${item.id}`}
              className="flex w-full flex-col gap-1.5 rounded-2xl border border-slate-200 bg-white p-3.5 text-left shadow-sm transition hover:border-blue-400 hover:bg-slate-50/70 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-blue-700"
            >
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span
                    className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${
                      item.type === "partner"
                        ? "bg-purple-100 text-purple-800 dark:bg-purple-950/50 dark:text-purple-200"
                        : "bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-200"
                    }`}
                  >
                    {item.type === "partner" ? "제휴" : "공공"}
                  </span>
                  <RestroomStatusBadge status={item.publication_status} />
                  <span
                    className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${
                      item.is_map_visible
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200"
                        : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                    }`}
                  >
                    {item.is_map_visible ? "지도 공개" : "지도 비노출"}
                  </span>
                </div>
                <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                  {item.region_label}
                </span>
              </div>

              <p className="truncate text-sm font-bold text-slate-900 dark:text-white">
                {item.name}
              </p>
              <p className="truncate text-xs text-slate-600 dark:text-slate-300">
                {item.road_address || item.address_detail || "주소 미등록"}
              </p>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
                <span>출처: {item.source_label}</span>
                <span>검증: {item.verification_label}</span>
                {item.business_name && <span>가게: {item.business_name}</span>}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* 하단 페이지네이션 */}
      {inventory && inventory.totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2 text-xs">
          <button
            type="button"
            disabled={page <= 1 || listLoading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            data-testid="pagination-prev-bottom"
            className="min-h-[40px] rounded-xl border border-slate-300 bg-white px-4 py-2 font-semibold disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900"
          >
            이전 페이지
          </button>
          <span className="font-semibold text-slate-700 dark:text-slate-200">
            {inventory.page} / {inventory.totalPages}
          </span>
          <button
            type="button"
            disabled={page >= inventory.totalPages || listLoading}
            onClick={() => setPage((p) => p + 1)}
            data-testid="pagination-next-bottom"
            className="min-h-[40px] rounded-xl border border-slate-300 bg-white px-4 py-2 font-semibold disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900"
          >
            다음 페이지
          </button>
        </div>
      )}

      {/* 읽기 전용 관리자 상세 모달 (수정/삭제/일괄 공개 없음) */}
      {selectedId && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="화장실 상세 정보"
          data-testid="inventory-detail-modal"
          className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/60 p-0 sm:items-center sm:p-4"
        >
          <div className="max-h-[88vh] w-full max-w-xl overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl dark:bg-slate-900 sm:rounded-3xl">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 pb-3 dark:border-slate-800">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold text-blue-600 dark:text-blue-400">
                  관리자 상세 열람 (읽기 전용)
                </p>
                <h2 className="mt-0.5 truncate text-base font-bold text-slate-900 dark:text-white">
                  {detail?.name ?? "상세 정보 불러오는 중..."}
                </h2>
              </div>
              <button
                type="button"
                onClick={closeDetail}
                data-testid="inventory-detail-close"
                aria-label="상세 창 닫기"
                className="min-h-[36px] shrink-0 rounded-xl border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300"
              >
                닫기
              </button>
            </div>

            {detailLoading && (
              <p className="py-8 text-center text-xs text-slate-500">불러오는 중...</p>
            )}

            {detailError && (
              <p role="alert" className="py-6 text-center text-xs text-rose-600">
                {detailError}
              </p>
            )}

            {detail && !detailLoading && (
              <div className="mt-4 space-y-3 text-xs text-slate-700 dark:text-slate-300">
                <div className="flex flex-wrap gap-1.5">
                  <span className="rounded-md bg-slate-100 px-2 py-0.5 font-semibold dark:bg-slate-800">
                    {detail.type === "partner" ? "제휴" : "공공"}
                  </span>
                  <RestroomStatusBadge status={detail.publication_status} />
                  {detail.coordinate_verification_status && (
                    <span className="rounded-md bg-blue-50 px-2 py-0.5 font-medium text-blue-800 dark:bg-blue-950/50 dark:text-blue-200">
                      좌표 검증: {detail.coordinate_verification_status}
                    </span>
                  )}
                </div>

                <div className="space-y-1.5 rounded-2xl border border-slate-200 p-3 dark:border-slate-800">
                  <p>
                    <strong className="text-slate-900 dark:text-white">도로명주소:</strong>{" "}
                    {detail.road_address || "-"}
                  </p>
                  {detail.address_detail && (
                    <p>
                      <strong className="text-slate-900 dark:text-white">상세/지번:</strong>{" "}
                      {detail.address_detail}
                    </p>
                  )}
                  <p>
                    <strong className="text-slate-900 dark:text-white">좌표:</strong>{" "}
                    {detail.latitude ?? "-"}, {detail.longitude ?? "-"} (출처:{" "}
                    {detail.coordinate_source ?? "없음"} / 타입:{" "}
                    {detail.coordinate_type ?? "없음"})
                  </p>
                  {detail.description && (
                    <p className="leading-relaxed">
                      <strong className="text-slate-900 dark:text-white">설명/원본 메타:</strong>{" "}
                      {detail.description}
                    </p>
                  )}
                  <p>
                    <strong className="text-slate-900 dark:text-white">등록일:</strong>{" "}
                    {new Date(detail.created_at).toLocaleString("ko-KR")}
                  </p>
                </div>

                {detail.business && (
                  <div className="rounded-2xl border border-purple-200 bg-purple-50/40 p-3 dark:border-purple-900 dark:bg-purple-950/20">
                    <p className="font-bold text-slate-900 dark:text-white">
                      소속 제휴 가게: {detail.business.name}
                    </p>
                    <p className="mt-1">
                      승인 상태: {detail.business.registration_status} · 업종:{" "}
                      {detail.business.category}
                    </p>
                  </div>
                )}

                <div className="flex flex-wrap gap-2 pt-1">
                  <Link
                    href={`/restrooms/${detail.id}`}
                    className="inline-flex min-h-[38px] items-center rounded-xl border border-slate-300 px-3.5 py-2 font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200"
                  >
                    공개 상세 페이지 열기
                  </Link>
                  <Link
                    href="/admin/restrooms"
                    className="inline-flex min-h-[38px] items-center rounded-xl bg-slate-900 px-3.5 py-2 font-semibold text-white hover:bg-slate-800 dark:bg-slate-700"
                  >
                    심사 화면에서 보기
                  </Link>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
