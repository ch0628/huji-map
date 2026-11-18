"use client";

import React, { useCallback, useEffect, useState } from "react";
import type {
  AdminBusinessDetail,
  AdminBusinessSummaryItem,
  BusinessRegistrationStatus,
} from "@/lib/businesses/types";
import BusinessStatusBadge from "@/components/business/BusinessStatusBadge";

export default function AdminBusinessesClient() {
  const [statusFilter, setStatusFilter] = useState<string>("pending");
  const [searchQuery, setSearchQuery] = useState("");
  const [businesses, setBusinesses] = useState<AdminBusinessSummaryItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);

  // Selected detail modal/expansion
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<AdminBusinessDetail | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);

  // Decision action states
  const [decisionAction, setDecisionAction] = useState<"approved" | "rejected" | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const [reviewNotes, setReviewNotes] = useState("");
  const [isSubmittingDecision, setIsSubmittingDecision] = useState(false);

  // Fetch list
  const fetchBusinesses = useCallback(async () => {
    setIsLoading(true);
    setErrorBanner(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (searchQuery.trim()) params.set("q", searchQuery.trim());
      params.set("limit", "100");

      const res = await fetch(`/api/v1/admin/businesses?${params.toString()}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error?.message || "가게 심사 목록을 불러오지 못했습니다.");
      }
      setBusinesses(data.businesses || []);
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : "목록 조회 중 오류가 발생했습니다.");
    } finally {
      setIsLoading(false);
    }
  }, [statusFilter, searchQuery]);

  useEffect(() => {
    fetchBusinesses();
  }, [fetchBusinesses]);

  // Fetch single detail
  const handleSelectBusiness = async (id: string) => {
    setSelectedId(id);
    setSelectedDetail(null);
    setDecisionAction(null);
    setRejectionReason("");
    setReviewNotes("");
    setIsLoadingDetail(true);
    setErrorBanner(null);

    try {
      const res = await fetch(`/api/v1/admin/businesses/${id}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error?.message || "가게 상세 정보를 불러오지 못했습니다.");
      }
      setSelectedDetail(data.business);
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : "상세 조회 중 오류가 발생했습니다.");
    } finally {
      setIsLoadingDetail(false);
    }
  };

  // Submit decision
  const handleDecisionSubmit = async (decision: "approved" | "rejected") => {
    if (!selectedId) return;

    if (decision === "rejected" && !rejectionReason.trim()) {
      setErrorBanner("반려 사유를 입력해 주세요.");
      return;
    }

    const confirmMsg =
      decision === "approved"
        ? "해당 가게 등록을 승인하시겠습니까?\n신청자에게 제휴 사업자(merchant) 권한이 즉시 부여됩니다."
        : "해당 가게 등록을 반려하시겠습니까?\n신청자에게 반려 사유가 전달됩니다.";

    if (!confirm(confirmMsg)) {
      return;
    }

    setIsSubmittingDecision(true);
    setErrorBanner(null);
    setSuccessBanner(null);

    try {
      const idempotencyKey = crypto.randomUUID();
      const res = await fetch(`/api/v1/admin/businesses/${selectedId}/decision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          decision,
          rejection_reason: decision === "rejected" ? rejectionReason.trim() : null,
          review_notes: reviewNotes.trim() || null,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error?.message || "심사 처리 중 오류가 발생했습니다.");
      }

      setSuccessBanner(
        decision === "approved"
          ? "가게 승인이 완료되었습니다. 신청자에게 merchant 권한이 부여되었습니다."
          : "가게 등록이 반려되었습니다."
      );

      // Refresh both detail and list
      await handleSelectBusiness(selectedId);
      await fetchBusinesses();
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : "심사 처리 실패");
    } finally {
      setIsSubmittingDecision(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 text-xs" data-testid="admin-businesses-container">
      {/* 알림 배너 */}
      {errorBanner && (
        <div
          role="alert"
          data-testid="admin-businesses-error"
          className="rounded-xl border border-rose-300 bg-rose-50 p-3 text-rose-900 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-200"
        >
          {errorBanner}
        </div>
      )}
      {successBanner && (
        <div
          role="status"
          data-testid="admin-businesses-success"
          className="rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200"
        >
          {successBanner}
        </div>
      )}

      {/* 상단 탭 필터 */}
      <div className="flex gap-1.5 overflow-x-auto pb-1" role="tablist">
        {[
          { key: "pending", label: "심사 대기" },
          { key: "approved", label: "승인 완료" },
          { key: "rejected", label: "반려됨" },
          { key: "all", label: "전체" },
        ].map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={statusFilter === tab.key}
            data-testid={`filter-tab-${tab.key}`}
            onClick={() => {
              setStatusFilter(tab.key);
              setSelectedId(null);
              setSelectedDetail(null);
            }}
            className={`min-h-[40px] rounded-xl px-3 py-2 font-semibold transition ${
              statusFilter === tab.key
                ? "bg-slate-900 text-white dark:bg-blue-600 dark:text-white"
                : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 검색 바 */}
      <div className="flex gap-2">
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="가게명, 업종, 주소 검색"
          aria-label="가게 검색"
          className="min-h-[44px] min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
        />
        <button
          type="button"
          onClick={fetchBusinesses}
          className="min-h-[44px] rounded-xl border border-slate-300 bg-slate-100 px-3 py-2 font-medium text-slate-700 hover:bg-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
        >
          조회
        </button>
      </div>

      {/* 목록 본문 */}
      {isLoading ? (
        <div
          data-testid="admin-businesses-loading"
          className="flex flex-col items-center justify-center py-12 text-slate-400"
        >
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
          <p className="mt-3">가게 심사 목록을 불러오는 중...</p>
        </div>
      ) : businesses.length === 0 ? (
        <div
          data-testid="admin-businesses-empty"
          className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-slate-50/50 px-4 py-12 text-center dark:border-slate-800 dark:bg-slate-900/30"
        >
          <p className="text-2xl">📋</p>
          <h2 className="mt-2 text-sm font-bold text-slate-700 dark:text-slate-300">
            해당 조건의 가게가 없습니다.
          </h2>
          <p className="mt-1 text-slate-500">새로운 심사 요청이 도착하면 여기에 표시됩니다.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5" data-testid="admin-businesses-list">
          {businesses.map((biz) => {
            const isSelected = selectedId === biz.id;
            return (
              <div
                key={biz.id}
                data-testid={`admin-business-card-${biz.id}`}
                className={`flex flex-col rounded-2xl border p-4 transition ${
                  isSelected
                    ? "border-blue-500 bg-blue-50/20 dark:border-blue-500 dark:bg-blue-950/20"
                    : "border-slate-200 bg-white hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-bold text-slate-900 dark:text-white">
                      {biz.name}
                    </h3>
                    <p className="mt-0.5 text-slate-500 dark:text-slate-400">
                      {biz.category} · 신청일: {new Date(biz.created_at).toLocaleDateString("ko-KR")}
                    </p>
                    <p className="mt-0.5 truncate text-slate-600 dark:text-slate-400">
                      📍 {biz.road_address}
                    </p>
                    {biz.applicant_name && (
                      <p className="mt-0.5 text-slate-500">
                        신청자: <span className="font-medium text-slate-700 dark:text-slate-300">{biz.applicant_name}</span>
                      </p>
                    )}
                  </div>
                  <BusinessStatusBadge status={biz.registration_status} />
                </div>

                <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2.5 dark:border-slate-800">
                  <span className="text-[11px] text-slate-400">
                    ID: {biz.id.slice(0, 8)}...
                  </span>
                  <button
                    type="button"
                    data-testid={`inspect-business-${biz.id}`}
                    onClick={() => handleSelectBusiness(biz.id)}
                    className="rounded-lg bg-blue-50 px-2.5 py-1.5 font-semibold text-blue-700 hover:bg-blue-100 dark:bg-blue-950/50 dark:text-blue-300"
                  >
                    {isSelected ? "상세 닫기/새로고침" : "검증 내역 확인"}
                  </button>
                </div>

                {/* 선택된 가게 인라인 상세 검증 패널 */}
                {isSelected && (
                  <div
                    data-testid="admin-inspection-panel"
                    className="mt-3 flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 dark:border-slate-800 dark:bg-slate-950/50"
                  >
                    {isLoadingDetail ? (
                      <p className="py-4 text-center text-slate-500">검증 상세 정보를 불러오는 중...</p>
                    ) : selectedDetail ? (
                      <>
                        <h4 className="font-bold text-slate-900 dark:text-white">
                          🔎 사업자 검증 근거 및 신청 상세
                        </h4>

                        {/* 사업자 검증 내역 (Private) */}
                        <div className="flex flex-col gap-1.5 rounded-lg border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900 dark:bg-amber-950/30">
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-amber-900 dark:text-amber-200">
                              사업자 등록 검증 정보
                            </span>
                            <span className="rounded bg-amber-200/80 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900 dark:bg-amber-900 dark:text-amber-200">
                              🔒 관리자 전용 비공개
                            </span>
                          </div>

                          {selectedDetail.verifications && selectedDetail.verifications.length > 0 ? (
                            selectedDetail.verifications.map((v) => (
                              <div key={v.id} className="mt-1 space-y-0.5 text-[11px] text-slate-700 dark:text-slate-300">
                                <p>
                                  <span className="text-slate-500">사업자등록번호:</span>{" "}
                                  <span className="font-mono font-bold text-blue-600 dark:text-blue-400">
                                    {v.registration_number || "미입력"}
                                  </span>
                                </p>
                                <p>
                                  <span className="text-slate-500">검증 방식:</span> {v.method} (상태: {v.status})
                                </p>
                                {v.review_notes && (
                                  <p className="text-slate-500">
                                    검토 메모: {v.review_notes}
                                  </p>
                                )}
                              </div>
                            ))
                          ) : (
                            <p className="mt-1 text-[11px] text-slate-500">
                              제출된 사업자등록번호 또는 증빙 파일이 없습니다.
                            </p>
                          )}
                        </div>

                        {/* 가게 기본 정보 확인 */}
                        <div className="space-y-1 text-[11px] text-slate-600 dark:text-slate-400">
                          <p>
                            <span className="font-semibold text-slate-700 dark:text-slate-300">도로명주소:</span>{" "}
                            {selectedDetail.road_address} {selectedDetail.address_detail || ""}
                          </p>
                          {selectedDetail.phone && (
                            <p>
                              <span className="font-semibold text-slate-700 dark:text-slate-300">연락처:</span>{" "}
                              {selectedDetail.phone}
                            </p>
                          )}
                          <p>
                            <span className="font-semibold text-slate-700 dark:text-slate-300">좌표 (WGS84):</span>{" "}
                            {selectedDetail.latitude}, {selectedDetail.longitude}
                          </p>
                          {selectedDetail.rejection_reason && (
                            <p className="rounded bg-rose-50 p-2 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
                              <span className="font-bold">기존 반려 사유:</span> {selectedDetail.rejection_reason}
                            </p>
                          )}
                        </div>

                        {/* 관리자 승인 / 반려 액션 버튼 */}
                        {selectedDetail.registration_status === "pending" && (
                          <div className="mt-2 flex flex-col gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                            <div className="flex gap-2">
                              <button
                                type="button"
                                data-testid="admin-approve-button"
                                disabled={isSubmittingDecision}
                                onClick={() => handleDecisionSubmit("approved")}
                                className="flex min-h-[44px] flex-1 items-center justify-center rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
                              >
                                {isSubmittingDecision ? "처리 중..." : "✅ 가게 승인 및 merchant 권한 부여"}
                              </button>
                              <button
                                type="button"
                                data-testid="admin-reject-toggle-button"
                                disabled={isSubmittingDecision}
                                onClick={() =>
                                  setDecisionAction(decisionAction === "rejected" ? null : "rejected")
                                }
                                className="flex min-h-[44px] items-center justify-center rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
                              >
                                ❌ 반려하기
                              </button>
                            </div>

                            {/* 반려 사유 입력 폼 */}
                            {decisionAction === "rejected" && (
                              <div
                                data-testid="admin-reject-panel"
                                className="flex flex-col gap-2 rounded-xl border border-rose-200 bg-rose-50/50 p-3 dark:border-rose-900 dark:bg-rose-950/30"
                              >
                                <label
                                  htmlFor="admin-rejection-reason"
                                  className="font-bold text-rose-900 dark:text-rose-200"
                                >
                                  반려 사유 입력 <span className="text-rose-500">*</span>
                                </label>
                                <textarea
                                  id="admin-rejection-reason"
                                  data-testid="admin-rejection-reason-input"
                                  rows={2}
                                  value={rejectionReason}
                                  onChange={(e) => setRejectionReason(e.target.value)}
                                  placeholder="예: 상호와 사업자등록증 정보 불일치, 폐업 점포 확인 등 신청자가 확인할 사유 입력"
                                  className="w-full rounded-lg border border-rose-300 bg-white p-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-rose-500 dark:border-rose-800 dark:bg-slate-900 dark:text-white"
                                />
                                <div className="flex gap-2 justify-end">
                                  <button
                                    type="button"
                                    onClick={() => setDecisionAction(null)}
                                    className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-100"
                                  >
                                    취소
                                  </button>
                                  <button
                                    type="button"
                                    data-testid="admin-confirm-reject-button"
                                    disabled={isSubmittingDecision || !rejectionReason.trim()}
                                    onClick={() => handleDecisionSubmit("rejected")}
                                    className="rounded-lg bg-rose-600 px-3 py-1.5 font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
                                  >
                                    반려 확정
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {selectedDetail.registration_status === "approved" && (
                          <div className="rounded-lg bg-emerald-50 p-2 text-[11px] text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
                            ✓ 승인 완료된 가게입니다. (승인 시각:{" "}
                            {selectedDetail.approved_at
                              ? new Date(selectedDetail.approved_at).toLocaleString("ko-KR")
                              : "기록됨"}
                            )
                          </div>
                        )}
                      </>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

