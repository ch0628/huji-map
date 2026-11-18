"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { AdminReceiptListItem } from "@/lib/receipts/types";
import ReceiptStatusBadge from "./ReceiptStatusBadge";
import AdminReceiptImageViewer from "./AdminReceiptImageViewer";
import AdminReceiptComparisonCard from "./AdminReceiptComparisonCard";
import AdminReceiptDecisionForm from "./AdminReceiptDecisionForm";
import {
  ADMIN_RECEIPT_FILTER_TABS,
  formatBytes,
  formatKoreanDateTime,
  formatKrwAmount,
  getAdminRefundStatusSummary,
  toBadgeRefundStatus,
  type AdminReceiptFilterTab,
  type AdminReceiptListApiResponse,
} from "./admin-types";

export interface AdminReceiptsClientProps {
  readonly initialStatus?: AdminReceiptFilterTab;
  readonly initialLimit?: number;
}

export function AdminReceiptsClient({
  initialStatus = "pending",
  initialLimit = 20,
}: AdminReceiptsClientProps) {
  const [statusFilter, setStatusFilter] =
    useState<AdminReceiptFilterTab>(initialStatus);
  const [page, setPage] = useState<number>(1);
  const [limit, setLimit] = useState<number>(initialLimit);
  const [items, setItems] = useState<AdminReceiptListItem[]>([]);
  const [pagination, setPagination] = useState<{
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  }>({
    page: 1,
    limit: initialLimit,
    total: 0,
    totalPages: 1,
  });

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorState, setErrorState] = useState<{
    status: number | null;
    code: string | null;
    message: string;
  } | null>(null);

  const [selectedReceipt, setSelectedReceipt] =
    useState<AdminReceiptListItem | null>(null);
  const [draftComparison, setDraftComparison] = useState<{
    confirmedStore: string;
    confirmedPurchaseAt: string;
    confirmedAmount: string;
  }>({
    confirmedStore: "",
    confirmedPurchaseAt: "",
    confirmedAmount: "",
  });

  const fetchReceipts = useCallback(async () => {
    setIsLoading(true);
    setErrorState(null);

    try {
      const params = new URLSearchParams({
        status: statusFilter,
        page: String(page),
        limit: String(limit),
      });

      const res = await fetch(`/api/v1/admin/receipts?${params.toString()}`, {
        method: "GET",
        cache: "no-store",
      });

      let data: AdminReceiptListApiResponse | null = null;
      try {
        data = (await res.json()) as AdminReceiptListApiResponse;
      } catch {
        data = null;
      }

      if (!res.ok || !data?.ok) {
        const msg =
          data?.error?.message ||
          (res.status === 401
            ? "관리자 로그인이 필요합니다 (401)."
            : res.status === 403
              ? "관리자 권한이 필요합니다 (403)."
              : "영수증 심사 대기열을 불러오지 못했습니다.");
        setErrorState({
          status: res.status,
          code: data?.error?.code ?? null,
          message: msg,
        });
        setItems([]);
        return;
      }

      const loadedItems = data.items ?? [];
      setItems(loadedItems);
      setPagination(
        data.pagination ?? {
          page,
          limit,
          total: loadedItems.length,
          totalPages: 1,
        }
      );

      // Keep selectedReceipt synced if it exists in refreshed page
      setSelectedReceipt((prev) => {
        if (!prev) return null;
        const found = loadedItems.find((item) => item.id === prev.id);
        return found ?? prev;
      });
    } catch {
      setErrorState({
        status: null,
        code: "NETWORK_ERROR",
        message: "네트워크 오류로 영수증 목록을 불러오지 못했습니다.",
      });
      setItems([]);
    } finally {
      setIsLoading(false);
    }
  }, [statusFilter, page, limit]);

  useEffect(() => {
    fetchReceipts();
  }, [fetchReceipts]);

  const handleAuthError = useCallback((status: number, message: string) => {
    setErrorState({
      status,
      code: status === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
      message,
    });
  }, []);

  const handleDecisionSuccess = useCallback(
    (updatedReceipt: AdminReceiptListItem) => {
      setSelectedReceipt(updatedReceipt);
      setItems((prev) =>
        prev.map((item) =>
          item.id === updatedReceipt.id ? updatedReceipt : item
        )
      );
    },
    []
  );

  const handleConflictRefresh = useCallback(async () => {
    setSelectedReceipt(null);
    await fetchReceipts();
  }, [fetchReceipts]);

  const handleTabChange = (nextStatus: AdminReceiptFilterTab) => {
    setStatusFilter(nextStatus);
    setPage(1);
    setSelectedReceipt(null);
  };

  return (
    <div
      data-testid="admin-receipts-container"
      className="flex min-w-0 flex-col gap-3.5 text-xs"
    >
      {/* 테스트 모드 안내 배너 */}
      <div
        data-testid="admin-receipts-test-watermark"
        className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-[11px] font-semibold text-indigo-950 dark:border-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-200"
      >
        테스트 결제 환경 · 실제 돈은 청구/환급되지 않으며, 영수증 승인 시 PG
        결제 취소는 별도 단계에서 처리됩니다.
      </div>

      {/* 인증/권한 및 일반 API 오류 배너 */}
      {errorState && (
        <div
          role="alert"
          data-testid="admin-receipts-error"
          className="space-y-2 rounded-2xl border border-rose-300 bg-rose-50 p-4 text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <p className="font-bold">
            요청 처리 오류
            {errorState.status ? ` (HTTP ${errorState.status})` : ""}
          </p>
          <p className="leading-relaxed">{errorState.message}</p>
          <div className="flex flex-wrap gap-2 pt-1">
            {errorState.status === 401 ? (
              <Link
                href="/login?returnTo=%2Fadmin%2Freceipts&reason=login_required"
                className="flex min-h-[44px] items-center justify-center rounded-xl bg-blue-600 px-4 py-2 font-bold text-white hover:bg-blue-700"
              >
                관리자 로그인하기
              </Link>
            ) : errorState.status === 403 ? (
              <Link
                href="/map"
                className="flex min-h-[44px] items-center justify-center rounded-xl bg-slate-800 px-4 py-2 font-bold text-white hover:bg-slate-900"
              >
                지도로 이동
              </Link>
            ) : (
              <button
                type="button"
                data-testid="admin-receipts-retry-button"
                onClick={fetchReceipts}
                className="min-h-[44px] rounded-xl bg-rose-700 px-4 py-2 font-bold text-white hover:bg-rose-800"
              >
                다시 불러오기
              </button>
            )}
          </div>
        </div>
      )}

      {/* 상세 심사 뷰 */}
      {selectedReceipt ? (
        <div
          data-testid="admin-receipt-detail-view"
          className="flex min-w-0 flex-col gap-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              data-testid="back-to-queue-button"
              onClick={() => {
                setSelectedReceipt(null);
                fetchReceipts();
              }}
              className="flex min-h-[44px] items-center rounded-xl border border-slate-300 bg-white px-3.5 py-2 font-bold text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            >
              ← 심사 대기열 목록
            </button>

            <span className="font-mono text-[11px] text-slate-500">
              ID: {selectedReceipt.id.slice(0, 8)}...
            </span>
          </div>

          <AdminReceiptImageViewer
            receiptId={selectedReceipt.id}
            mimeType={selectedReceipt.mimeType}
            fileSizeBytes={selectedReceipt.fileSizeBytes}
            originalFilename={selectedReceipt.originalFilename}
            onAuthError={handleAuthError}
          />

          <AdminReceiptComparisonCard
            receipt={selectedReceipt}
            draftConfirmedStore={draftComparison.confirmedStore}
            draftConfirmedPurchaseAt={draftComparison.confirmedPurchaseAt}
            draftConfirmedAmount={draftComparison.confirmedAmount}
          />

          <AdminReceiptDecisionForm
            receipt={selectedReceipt}
            onDecisionSuccess={handleDecisionSuccess}
            onRefreshRequested={handleConflictRefresh}
            onAuthError={handleAuthError}
            onDraftChange={setDraftComparison}
          />
        </div>
      ) : (
        /* 대기열 목록 뷰 */
        <>
          {/* 상태 필터 탭 */}
          <div
            className="flex flex-wrap gap-1.5"
            role="tablist"
            aria-label="영수증 심사 상태 필터"
          >
            {ADMIN_RECEIPT_FILTER_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={statusFilter === tab.key}
                data-testid={`receipt-filter-tab-${tab.key}`}
                onClick={() => handleTabChange(tab.key)}
                className={`min-h-[44px] rounded-xl px-3 py-2 font-semibold transition ${
                  statusFilter === tab.key
                    ? "bg-slate-900 text-white dark:bg-blue-600 dark:text-white"
                    : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* 페이지 크기 & 새로고침 */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-950/50">
            <div className="flex items-center gap-2">
              <label
                htmlFor="receipt-page-limit"
                className="text-[11px] font-medium text-slate-600 dark:text-slate-400"
              >
                표시 건수
              </label>
              <select
                id="receipt-page-limit"
                data-testid="receipt-page-limit-select"
                value={limit}
                onChange={(e) => {
                  setLimit(Number(e.target.value));
                  setPage(1);
                }}
                className="min-h-[36px] rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
              >
                <option value={10}>10건</option>
                <option value={20}>20건</option>
                <option value={50}>50건</option>
              </select>
            </div>

            <button
              type="button"
              data-testid="admin-receipts-refresh-button"
              onClick={fetchReceipts}
              disabled={isLoading}
              className="min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            >
              새로고침
            </button>
          </div>

          {/* 대기열 목록 본문 */}
          {isLoading ? (
            <div
              data-testid="admin-receipts-loading"
              className="flex flex-col items-center justify-center rounded-2xl border border-slate-200 py-12 text-slate-500 dark:border-slate-800"
            >
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
              <p className="mt-3">영수증 심사 대기열을 불러오는 중...</p>
            </div>
          ) : items.length === 0 ? (
            <div
              data-testid="admin-receipts-empty"
              className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-slate-50/50 px-4 py-12 text-center dark:border-slate-800 dark:bg-slate-900/30"
            >
              <h2 className="text-sm font-bold text-slate-700 dark:text-slate-200">
                해당 조건의 영수증 제출 건이 없습니다.
              </h2>
              <p className="mt-1 text-[11px] text-slate-500">
                다른 심사 상태 탭을 선택하거나 새 제출 건이 도착하면 다시 조회해
                주세요.
              </p>
            </div>
          ) : (
            <div
              data-testid="admin-receipts-list"
              className="flex flex-col gap-2.5"
            >
              {items.map((item) => {
                const itemRefundStatus = item.refundStatus ?? "none";
                const refundSummary = getAdminRefundStatusSummary(
                  item.submissionStatus,
                  itemRefundStatus
                );
                const displayDeposit =
                  item.paymentAmountKrw ?? item.depositAmountKrw;
                return (
                  <article
                    key={item.id}
                    data-testid={`admin-receipt-card-${item.id}`}
                    className="flex min-w-0 flex-col gap-2.5 rounded-2xl border border-slate-200 bg-white p-3.5 dark:border-slate-800 dark:bg-slate-900"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <h3
                          data-testid={`receipt-card-business-${item.id}`}
                          className="truncate text-sm font-bold text-slate-900 dark:text-white"
                        >
                          {item.businessName ?? "가게명 미제공"}
                        </h3>
                        <p className="mt-0.5 truncate text-[11px] text-slate-600 dark:text-slate-400">
                          {item.restroomName ?? "화장실명 미제공"}
                          {item.businessRoadAddress
                            ? ` · ${item.businessRoadAddress}`
                            : ""}
                        </p>
                      </div>
                      <ReceiptStatusBadge
                        status={item.submissionStatus}
                        refundStatus={toBadgeRefundStatus(itemRefundStatus)}
                        testId={`receipt-card-badge-${item.id}`}
                      />
                    </div>

                    <dl className="grid grid-cols-1 gap-1 rounded-xl bg-slate-50 p-2.5 text-[11px] dark:bg-slate-950/60">
                      <div className="flex justify-between gap-2">
                        <dt className="text-slate-500">제출 시각</dt>
                        <dd
                          data-testid={`receipt-card-created-${item.id}`}
                          className="font-medium text-slate-800 dark:text-slate-200"
                        >
                          {formatKoreanDateTime(item.createdAt)}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-slate-500">제출자 · 결제 보증금</dt>
                        <dd className="font-medium text-slate-800 dark:text-slate-200">
                          {item.userDisplayName ?? "표시명 미제공"} ·{" "}
                          {formatKrwAmount(displayDeposit)}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-slate-500">파일</dt>
                        <dd className="truncate font-medium text-slate-700 dark:text-slate-300">
                          {item.mimeType} · {formatBytes(item.fileSizeBytes)}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-slate-500">환급 상태</dt>
                        <dd className="font-semibold text-slate-800 dark:text-slate-200">
                          {refundSummary.label}
                        </dd>
                      </div>
                    </dl>

                    <button
                      type="button"
                      data-testid={`inspect-receipt-${item.id}`}
                      onClick={() => setSelectedReceipt(item)}
                      className="flex min-h-[44px] w-full items-center justify-center rounded-xl bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-700"
                    >
                      원본 이미지 및 상세 심사 열기
                    </button>
                  </article>
                );
              })}
            </div>
          )}

          {/* 페이지네이션 */}
          {!isLoading && pagination.total > 0 && (
            <nav
              aria-label="영수증 목록 페이지네이션"
              data-testid="admin-receipts-pagination"
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 dark:border-slate-800 dark:bg-slate-900"
            >
              <span
                data-testid="pagination-summary"
                className="text-[11px] font-medium text-slate-600 dark:text-slate-400"
              >
                {pagination.page} / {pagination.totalPages} 페이지 (총{" "}
                {pagination.total}건)
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  data-testid="pagination-prev-button"
                  disabled={pagination.page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="min-h-[44px] rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                >
                  이전
                </button>
                <button
                  type="button"
                  data-testid="pagination-next-button"
                  disabled={pagination.page >= pagination.totalPages}
                  onClick={() =>
                    setPage((p) => Math.min(pagination.totalPages, p + 1))
                  }
                  className="min-h-[44px] rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                >
                  다음
                </button>
              </div>
            </nav>
          )}
        </>
      )}
    </div>
  );
}

export default AdminReceiptsClient;

