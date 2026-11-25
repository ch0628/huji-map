"use client";

import React, { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import RestroomStatusBadge from "@/components/restroom/RestroomStatusBadge";
import { PHOTO_TYPE_LABELS } from "@/components/restroom/RestroomPhotoManager";
import type {
  AdminRestroomSummaryItem,
  AdminRestroomDetail,
  AdminRestroomDecision,
  RestroomPhoto,
} from "@/lib/restrooms";

type TabStatus = "pending" | "pending_photos" | "published" | "suspended" | "all";

export default function AdminRestroomsClient() {
  const [activeTab, setActiveTab] = useState<TabStatus>("pending");
  const [searchQuery, setSearchQuery] = useState("");
  const [restrooms, setRestrooms] = useState<AdminRestroomSummaryItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Selected detail modal
  const [selectedRestroomId, setSelectedRestroomId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminRestroomDetail | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Decision state
  const [decisionAction, setDecisionAction] = useState<AdminRestroomDecision | null>(null);
  const [reasonInput, setReasonInput] = useState("");
  const [reviewNotesInput, setReviewNotesInput] = useState("");
  const [isSubmittingDecision, setIsSubmittingDecision] = useState(false);
  const [decisionSuccessMessage, setDecisionSuccessMessage] = useState<string | null>(null);
  const [decisionErrorMessage, setDecisionErrorMessage] = useState<string | null>(null);

  // Post-approval photo replacement review state
  const [rejectingPhotoId, setRejectingPhotoId] = useState<string | null>(null);
  const [photoRejectReason, setPhotoRejectReason] = useState("");
  const [isSubmittingPhotoDecision, setIsSubmittingPhotoDecision] = useState(false);

  const fetchRestrooms = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (activeTab !== "all") params.set("status", activeTab);
      if (searchQuery.trim()) params.set("q", searchQuery.trim());

      const res = await fetch(`/api/v1/admin/restrooms?${params.toString()}`);
      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.error?.message || "화장실 목록을 불러오지 못했습니다.");
      }

      setRestrooms(data.data || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "목록 조회 중 오류가 발생했습니다.");
    } finally {
      setIsLoading(false);
    }
  }, [activeTab, searchQuery]);

  useEffect(() => {
    fetchRestrooms();
  }, [fetchRestrooms]);

  const openDetail = async (id: string, options?: { preserveSuccessMessage?: boolean }) => {
    setSelectedRestroomId(id);
    setDetail(null);
    setDetailError(null);
    if (!options?.preserveSuccessMessage) {
      setDecisionSuccessMessage(null);
    }
    setDecisionErrorMessage(null);
    setDecisionAction(null);
    setReasonInput("");
    setReviewNotesInput("");
    setIsDetailLoading(true);

    try {
      const res = await fetch(`/api/v1/admin/restrooms/${id}`);
      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.error?.message || "화장실 상세 정보를 불러오지 못했습니다.");
      }

      setDetail(data.data);
    } catch (err: unknown) {
      setDetailError(err instanceof Error ? err.message : "상세 정보 조회 실패");
    } finally {
      setIsDetailLoading(false);
    }
  };

  const closeDetail = () => {
    setSelectedRestroomId(null);
    setDetail(null);
    setDecisionAction(null);
  };

  const handleDecisionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail || !decisionAction || isSubmittingDecision) return;

    if ((decisionAction === "reject" || decisionAction === "suspend") && reasonInput.trim().length < 2) {
      setDecisionErrorMessage("사유를 2자 이상 구체적으로 입력해 주세요.");
      return;
    }

    setIsSubmittingDecision(true);
    setDecisionErrorMessage(null);
    setDecisionSuccessMessage(null);

    const idempotencyKey = crypto.randomUUID();

    try {
      const payload: { decision: AdminRestroomDecision; reason?: string; review_notes?: string } = {
        decision: decisionAction,
      };
      if (reasonInput.trim()) payload.reason = reasonInput.trim();
      if (reviewNotesInput.trim()) payload.review_notes = reviewNotesInput.trim();

      const res = await fetch(`/api/v1/admin/restrooms/${detail.id}/decision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error?.message || "심사 처리 중 오류가 발생했습니다.");
      }

      const actionText =
        decisionAction === "publish"
          ? "공개 승인"
          : decisionAction === "reject"
          ? "반려(임시저장 복귀)"
          : "공개 중단";

      setDecisionSuccessMessage(`화장실이 성공적으로 ${actionText} 처리되었습니다.`);
      setDecisionAction(null);
      setReasonInput("");
      setReviewNotesInput("");

      // Refresh detail and list
      await openDetail(detail.id, { preserveSuccessMessage: true });
      fetchRestrooms();
    } catch (err: unknown) {
      setDecisionErrorMessage(
        err instanceof Error ? err.message : "심사 처리 중 오류가 발생했습니다."
      );
    } finally {
      setIsSubmittingDecision(false);
    }
  };

  const handlePhotoReplacementDecision = async (
    photo: RestroomPhoto,
    decision: "approve" | "reject"
  ) => {
    if (!detail || isSubmittingPhotoDecision) return;

    if (decision === "reject" && photoRejectReason.trim().length < 2) {
      setDecisionErrorMessage("사진 반려 사유를 2자 이상 구체적으로 입력해 주세요.");
      return;
    }

    setIsSubmittingPhotoDecision(true);
    setDecisionErrorMessage(null);
    setDecisionSuccessMessage(null);

    try {
      const payload: { decision: "approve" | "reject"; reason?: string } = { decision };
      if (decision === "reject") {
        payload.reason = photoRejectReason.trim();
      }

      const res = await fetch(
        `/api/v1/admin/restrooms/${detail.id}/photos/${photo.id}/decision`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-idempotency-key": crypto.randomUUID(),
          },
          body: JSON.stringify(payload),
        }
      );

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error?.message || "사진 심사 처리 중 오류가 발생했습니다.");
      }

      setRejectingPhotoId(null);
      setPhotoRejectReason("");
      setDecisionSuccessMessage(
        decision === "approve"
          ? photo.replaces_photo_id
            ? "새 사진이 승인되어 기존 사진을 교체했습니다."
            : "새 사진이 승인되어 공개되었습니다."
          : "새 사진이 반려되었으며 기존 승인 사진이 유지됩니다."
      );

      await openDetail(detail.id, { preserveSuccessMessage: true });
      fetchRestrooms();
    } catch (err: unknown) {
      setDecisionErrorMessage(
        err instanceof Error ? err.message : "사진 심사 처리 중 오류가 발생했습니다."
      );
    } finally {
      setIsSubmittingPhotoDecision(false);
    }
  };

  // Eligibility check for publishing
  const canPublish = (item: AdminRestroomSummaryItem | AdminRestroomDetail) => {
    const hasName = Boolean(item.name?.trim());
    const hasAddress = Boolean(item.road_address?.trim());
    const hasCoords = item.latitude !== null && item.longitude !== null;
    const isPartner = item.type === "partner";
    const partnerApproved =
      !isPartner ||
      ("business" in item
        ? item.business?.registration_status === "approved"
        : item.business_registration_status === "approved");

    return hasName && hasAddress && hasCoords && partnerApproved;
  };

  const getMissingPublishReasons = (item: AdminRestroomSummaryItem | AdminRestroomDetail) => {
    const reasons: string[] = [];
    if (!item.name?.trim()) reasons.push("화장실 이름 누락");
    if (!item.road_address?.trim()) reasons.push("도로명주소 누락");
    if (item.latitude === null || item.longitude === null) reasons.push("위치 좌표(위/경도) 미등록");
    if (item.type === "partner") {
      const status =
        "business" in item
          ? item.business?.registration_status
          : item.business_registration_status;
      if (status !== "approved") {
        reasons.push(`소속 가게 미승인 (현재: ${status || "확인 불가"})`);
      }
    }
    return reasons;
  };

  return (
    <div
      data-testid="admin-restrooms-container"
      className="flex flex-col gap-4 p-4 max-w-4xl mx-auto w-full min-w-0"
    >
      {/* 상단 타이틀 및 안내 */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">
            화장실 심사 및 공개 관리
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            제휴 및 공공 화장실의 좌표, 시설 정보, 이용 정책을 검수하고 지도의 공개 상태를 관리합니다.
          </p>
        </div>
        <Link
          href="/admin/restrooms/inventory"
          data-testid="link-admin-restroom-inventory"
          className="inline-flex min-h-[36px] shrink-0 items-center rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
        >
          전체 화장실 통계·목록 →
        </Link>
      </div>

      {/* 상태 필터 탭 */}
      <div
        role="tablist"
        aria-label="화장실 상태 필터"
        className="flex gap-1.5 overflow-x-auto pb-1 text-xs font-medium"
      >
        {(
          [
            { id: "pending", label: "심사 대기 (pending)" },
            { id: "pending_photos", label: "사진 교체 대기" },
            { id: "published", label: "공개 중 (published)" },
            { id: "suspended", label: "공개 중단 (suspended)" },
            { id: "all", label: "전체 (all)" },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            data-testid={`tab-${tab.id}`}
            onClick={() => setActiveTab(tab.id)}
            className={`min-h-[38px] whitespace-nowrap rounded-xl px-3.5 py-2 transition-colors ${
              activeTab === tab.id
                ? "bg-blue-600 font-semibold text-white shadow-sm"
                : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 검색 입력창 */}
      <div className="flex gap-2 min-w-0">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="화장실명, 도로명주소, 가게명 검색"
          data-testid="restroom-search-input"
          className="flex-1 min-w-0 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
        />
        <button
          type="button"
          onClick={() => fetchRestrooms()}
          data-testid="search-refresh-button"
          className="min-h-[40px] shrink-0 rounded-xl bg-slate-800 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-900 dark:bg-slate-700"
        >
          검색
        </button>
      </div>

      {/* 에러 및 로딩 상태 */}
      {error && (
        <div
          role="alert"
          data-testid="admin-restrooms-error"
          className="rounded-xl border border-rose-300 bg-rose-50 p-3.5 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <p className="font-semibold">⚠️ {error}</p>
        </div>
      )}

      {isLoading ? (
        <div className="flex flex-col items-center justify-center p-8 text-xs text-slate-500">
          <span className="animate-spin text-xl mb-2">⏳</span>
          화장실 목록을 불러오는 중입니다...
        </div>
      ) : restrooms.length === 0 ? (
        <div
          data-testid="empty-restrooms-notice"
          className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-xs text-slate-500 dark:border-slate-700"
        >
          해당 상태의 화장실이 없습니다.
        </div>
      ) : (
        <div className="flex flex-col gap-3 min-w-0" data-testid="restrooms-list">
          {restrooms.map((item) => {
            const missing = getMissingPublishReasons(item);
            const publishAllowed = canPublish(item);

            return (
              <div
                key={item.id}
                data-testid={`admin-restroom-card-${item.id}`}
                className="flex flex-col gap-2.5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 min-w-0"
              >
                <div className="flex items-start justify-between gap-2 min-w-0">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          item.type === "partner"
                            ? "bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300"
                            : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                        }`}
                      >
                        {item.type === "partner" ? "제휴 화장실" : "공공 화장실"}
                      </span>
                      <RestroomStatusBadge status={item.publication_status} />
                      {(item.pending_photo_count ?? 0) > 0 && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                          📸 대기 사진 {item.pending_photo_count}건
                        </span>
                      )}
                    </div>
                    <h2 className="mt-1 text-sm font-bold text-slate-900 dark:text-white truncate">
                      {item.name}
                    </h2>
                  </div>
                  <button
                    type="button"
                    onClick={() => openDetail(item.id)}
                    data-testid={`inspect-restroom-btn-${item.id}`}
                    className="min-h-[36px] shrink-0 rounded-xl bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100 dark:bg-blue-950/60 dark:text-blue-300"
                  >
                    검수 및 심사
                  </button>
                </div>

                <div className="text-xs text-slate-600 dark:text-slate-400 space-y-0.5 break-all">
                  <p>
                    <span className="font-semibold text-slate-700 dark:text-slate-300">주소:</span>{" "}
                    {item.road_address}
                    {item.address_detail ? ` (${item.address_detail})` : ""}
                    {item.floor ? ` · ${item.floor}` : ""}
                  </p>
                  {item.business_name && (
                    <p>
                      <span className="font-semibold text-slate-700 dark:text-slate-300">소속 가게:</span>{" "}
                      {item.business_name}{" "}
                      <span
                        className={`text-[11px] font-medium ${
                          item.business_registration_status === "approved"
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-amber-600 dark:text-amber-400"
                        }`}
                      >
                        ({item.business_registration_status === "approved" ? "승인완료" : `가게상태: ${item.business_registration_status}`})
                      </span>
                    </p>
                  )}
                  {item.active_policy_mode && (
                    <p>
                      <span className="font-semibold text-slate-700 dark:text-slate-300">이용 정책:</span>{" "}
                      {item.active_policy_mode === "free"
                        ? "무료 모드 (Free)"
                        : `테스트 보증금 (${item.active_deposit_amount_krw?.toLocaleString("ko-KR")}원)`}
                    </p>
                  )}
                </div>

                {/* 필수 승인 정보 누락 경고 */}
                {!publishAllowed && (
                  <div
                    data-testid="missing-info-warning"
                    className="rounded-xl border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-200"
                  >
                    <span className="font-semibold">⚠️ 공개 승인 불가 사유:</span>
                    <ul className="list-disc list-inside mt-0.5 space-y-0.5">
                      {missing.map((m, idx) => (
                        <li key={idx}>{m}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 화장실 상세 검수 및 심사 모달 */}
      {selectedRestroomId && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-title"
          data-testid="admin-restroom-detail-modal"
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-4 backdrop-blur-sm"
        >
          <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-t-3xl sm:rounded-3xl border border-slate-200 bg-white p-4 sm:p-6 shadow-2xl dark:border-slate-800 dark:bg-slate-900 overflow-y-auto min-w-0">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
              <h2 id="modal-title" className="text-base font-bold text-slate-900 dark:text-white">
                화장실 상세 검수 및 공개 심사
              </h2>
              <button
                type="button"
                onClick={closeDetail}
                data-testid="close-detail-modal-btn"
                className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
              >
                ✕
              </button>
            </div>

            {/* 처리 성공 및 에러 알림 */}
            {decisionSuccessMessage && (
              <div
                role="status"
                data-testid="decision-success-alert"
                className="mt-3 rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200 font-semibold"
              >
                ✓ {decisionSuccessMessage}
              </div>
            )}
            {decisionErrorMessage && (
              <div
                role="alert"
                data-testid="decision-error-alert"
                className="mt-3 rounded-xl border border-rose-300 bg-rose-50 p-3 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200 font-semibold"
              >
                ⚠️ {decisionErrorMessage}
              </div>
            )}
            {detailError && (
              <div
                role="alert"
                className="mt-3 rounded-xl border border-rose-300 bg-rose-50 p-3 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
              >
                ⚠️ {detailError}
              </div>
            )}

            {isDetailLoading ? (
              <div className="p-8 text-center text-xs text-slate-500">
                상세 정보를 불러오는 중입니다...
              </div>
            ) : detail ? (
              <div className="mt-4 flex flex-col gap-4 text-xs text-slate-700 dark:text-slate-300 min-w-0">
                {/* 1. 기본 정보 */}
                <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-800/40 space-y-2 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-900 dark:text-white text-sm">
                      {detail.name}
                    </span>
                    <RestroomStatusBadge status={detail.publication_status} />
                  </div>
                  <p className="break-all">
                    <strong className="text-slate-900 dark:text-white">도로명주소:</strong>{" "}
                    {detail.road_address}
                    {detail.address_detail ? ` (${detail.address_detail})` : ""}
                  </p>
                  <p>
                    <strong className="text-slate-900 dark:text-white">좌표(WGS84):</strong>{" "}
                    {detail.latitude !== null && detail.longitude !== null ? (
                      <span className="font-mono text-blue-600 dark:text-blue-400">
                        위도 {detail.latitude}, 경도 {detail.longitude}
                      </span>
                    ) : (
                      <span className="font-bold text-rose-600 dark:text-rose-400">
                        미등록 (승인 불가)
                      </span>
                    )}
                  </p>
                  <p>
                    <strong className="text-slate-900 dark:text-white">성별/출입:</strong>{" "}
                    {detail.gender_type} / 출입방식: {detail.access_method}
                  </p>
                  <p>
                    <strong className="text-slate-900 dark:text-white">편의시설:</strong>{" "}
                    휠체어: {detail.wheelchair_accessible ? "가능" : "미지원/미확인"} · 기저귀:{" "}
                    {detail.baby_changing_available ? "있음" : "없음"} · 생리대:{" "}
                    {detail.sanitary_products_available ? "비치" : "없음"}
                  </p>
                  {detail.description && (
                    <p className="break-words">
                      <strong className="text-slate-900 dark:text-white">소개:</strong>{" "}
                      {detail.description}
                    </p>
                  )}
                </div>

                {/* 2. 소속 제휴 가게 정보 */}
                {detail.business && (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-800/40 space-y-1.5 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-slate-900 dark:text-white">
                        소속 가게: {detail.business.name}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          detail.business.registration_status === "approved"
                            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                            : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                        }`}
                      >
                        가게상태: {detail.business.registration_status}
                      </span>
                    </div>
                    <p>
                      업종: {detail.business.category} · 주소: {detail.business.road_address}
                    </p>
                    {detail.business.registration_status !== "approved" && (
                      <p className="font-semibold text-rose-600 dark:text-rose-400 text-[11px]">
                        ⚠️ 소속 가게가 승인(approved)되지 않은 상태이므로 화장실을 공개 승인할 수 없습니다.
                      </p>
                    )}
                  </div>
                )}

                {/* 3. 활성 이용 정책 */}
                <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-800/40 space-y-1.5 min-w-0">
                  <span className="font-bold text-slate-900 dark:text-white">
                    이용 정책 목록 ({detail.policies?.length ?? 0}건)
                  </span>
                  {detail.policies && detail.policies.length > 0 ? (
                    <div className="space-y-1 pt-1">
                      {detail.policies.map((p) => (
                        <div
                          key={p.id}
                          className={`flex items-center justify-between p-2 rounded-xl border text-[11px] ${
                            p.is_active
                              ? "border-blue-300 bg-blue-50/50 dark:border-blue-900 dark:bg-blue-950/30 font-semibold"
                              : "border-slate-200 dark:border-slate-800 opacity-60"
                          }`}
                        >
                          <span>
                            버전 {p.version} · {p.access_mode === "free" ? "무료 모드" : `보증금 ${p.deposit_amount_krw?.toLocaleString("ko-KR")}원`}
                            {p.refund_eligible ? " (환급 가능)" : ""}
                          </span>
                          <span>{p.is_active ? "활성 (Active)" : "과거 정책"}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-rose-500 font-semibold">⚠️ 활성화된 이용 정책이 없습니다.</p>
                  )}
                </div>

                {/* 4. 화장실 사진 미리보기 및 교체 검수 */}
                <div
                  data-testid="admin-restroom-photos-section"
                  className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-800/40 space-y-2.5 min-w-0"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-slate-900 dark:text-white">
                      첨부 사진 ({detail.photos?.length ?? 0}건)
                    </span>
                    {detail.publication_status !== "published" &&
                      (detail.photos || []).some((p) => p.moderation_status === "pending") && (
                        <span className="text-[11px] font-semibold text-blue-700 dark:text-blue-300">
                          공개 승인 시 대기 사진 함께 승인됨
                        </span>
                      )}
                  </div>

                  {!detail.photos || detail.photos.length === 0 ? (
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      첨부된 화장실 사진이 없습니다.
                    </p>
                  ) : (
                    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                      {detail.photos.map((photo) => {
                        const targetOld = photo.replaces_photo_id
                          ? detail.photos.find((old) => old.id === photo.replaces_photo_id)
                          : null;

                        return (
                          <div
                            key={photo.id}
                            data-testid={`admin-photo-card-${photo.id}`}
                            className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-2.5 dark:border-slate-700 dark:bg-slate-900"
                          >
                            <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-slate-200 dark:bg-slate-800">
                              {photo.image_url ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={photo.image_url}
                                  alt={PHOTO_TYPE_LABELS[photo.photo_type] || "화장실 사진"}
                                  className="h-full w-full object-cover"
                                />
                              ) : (
                                <div className="flex h-full items-center justify-center text-[11px] text-slate-500">
                                  미리보기 URL 없음 ({PHOTO_TYPE_LABELS[photo.photo_type] || photo.photo_type})
                                </div>
                              )}
                              {photo.is_primary && (
                                <span className="absolute left-1.5 top-1.5 rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                                  대표
                                </span>
                              )}
                            </div>

                            <div className="flex items-center justify-between gap-1 text-[11px]">
                              <span className="font-semibold text-slate-800 dark:text-slate-200">
                                {PHOTO_TYPE_LABELS[photo.photo_type] || photo.photo_type}
                              </span>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                  photo.moderation_status === "approved"
                                    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                                    : photo.moderation_status === "pending"
                                    ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                                    : "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                                }`}
                              >
                                {photo.moderation_status === "approved"
                                  ? "승인됨"
                                  : photo.moderation_status === "pending"
                                  ? photo.replaces_photo_id
                                    ? "교체 대기"
                                    : "승인 대기"
                                  : "반려/교체됨"}
                              </span>
                            </div>

                            {photo.replaces_photo_id && (
                              <p className="text-[11px] text-blue-700 dark:text-blue-300">
                                ↻ 기존 승인 사진({targetOld ? PHOTO_TYPE_LABELS[targetOld.photo_type] : photo.replaces_photo_id.slice(0, 8)}) 교체 요청
                              </p>
                            )}

                            {/* 이미 공개된 화장실의 대기 사진 개별 승인/반려 */}
                            {detail.publication_status === "published" &&
                              photo.moderation_status === "pending" && (
                                <div className="space-y-2 border-t border-slate-100 pt-2 dark:border-slate-800">
                                  {rejectingPhotoId === photo.id ? (
                                    <div className="space-y-1.5">
                                      <textarea
                                        rows={2}
                                        value={photoRejectReason}
                                        onChange={(e) => setPhotoRejectReason(e.target.value)}
                                        placeholder="사진 반려 사유 입력 (2자 이상)"
                                        data-testid={`photo-reject-reason-${photo.id}`}
                                        className="w-full rounded-lg border border-slate-300 bg-white p-2 text-[11px] text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                                      />
                                      <div className="flex gap-1.5">
                                        <button
                                          type="button"
                                          disabled={isSubmittingPhotoDecision}
                                          onClick={() =>
                                            void handlePhotoReplacementDecision(photo, "reject")
                                          }
                                          data-testid={`confirm-reject-photo-btn-${photo.id}`}
                                          className="min-h-[36px] flex-1 rounded-lg bg-rose-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
                                        >
                                          반려 확정
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setRejectingPhotoId(null);
                                            setPhotoRejectReason("");
                                          }}
                                          className="min-h-[36px] rounded-lg border border-slate-300 px-2.5 py-1 text-[11px] font-semibold text-slate-700 dark:border-slate-700 dark:text-slate-300"
                                        >
                                          취소
                                        </button>
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="flex gap-1.5">
                                      <button
                                        type="button"
                                        disabled={isSubmittingPhotoDecision}
                                        onClick={() =>
                                          void handlePhotoReplacementDecision(photo, "approve")
                                        }
                                        data-testid={`approve-photo-btn-${photo.id}`}
                                        className="min-h-[36px] flex-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                                      >
                                        {photo.replaces_photo_id ? "승인 (교체)" : "사진 승인"}
                                      </button>
                                      <button
                                        type="button"
                                        disabled={isSubmittingPhotoDecision}
                                        onClick={() => {
                                          setRejectingPhotoId(photo.id);
                                          setPhotoRejectReason("");
                                        }}
                                        data-testid={`reject-photo-btn-${photo.id}`}
                                        className="min-h-[36px] rounded-lg bg-rose-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
                                      >
                                        반려
                                      </button>
                                    </div>
                                  )}
                                </div>
                              )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* 5. 감사 로그 (Audit Logs) */}
                {detail.audit_logs && detail.audit_logs.length > 0 && (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-800/40 space-y-2 min-w-0">
                    <span className="font-bold text-slate-900 dark:text-white">
                      심사 및 상태 변경 이력 (Audit Logs)
                    </span>
                    <div className="space-y-1.5">
                      {detail.audit_logs.map((log) => (
                        <div
                          key={log.id}
                          className="p-2 rounded-xl border border-slate-200 dark:border-slate-800 text-[11px] space-y-0.5"
                        >
                          <div className="flex items-center justify-between font-semibold">
                            <span>{log.action}</span>
                            <span className="text-slate-400">
                              {new Date(log.created_at).toLocaleString("ko-KR")}
                            </span>
                          </div>
                          {log.reason && (
                            <p className="text-slate-600 dark:text-slate-400">
                              사유: {log.reason}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 5. 심사 결정 액션 패널 */}
                <div className="rounded-2xl border border-blue-200 bg-blue-50/40 p-4 dark:border-blue-900/60 dark:bg-blue-950/20 space-y-3 min-w-0">
                  <span className="font-bold text-slate-900 dark:text-white text-sm">
                    심사 결정 액션
                  </span>

                  {!decisionAction ? (
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={!canPublish(detail) || detail.publication_status === "published"}
                        onClick={() => {
                          setDecisionAction("publish");
                          setDecisionErrorMessage(null);
                        }}
                        data-testid="decision-btn-publish"
                        className="min-h-[44px] flex-1 min-w-[120px] rounded-xl bg-emerald-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        공개 승인 (Publish)
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setDecisionAction("reject");
                          setDecisionErrorMessage(null);
                        }}
                        data-testid="decision-btn-reject"
                        className="min-h-[44px] flex-1 min-w-[120px] rounded-xl bg-rose-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-rose-700"
                      >
                        반려 (Reject)
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setDecisionAction("suspend");
                          setDecisionErrorMessage(null);
                        }}
                        data-testid="decision-btn-suspend"
                        className="min-h-[44px] flex-1 min-w-[120px] rounded-xl bg-slate-800 px-4 py-2.5 text-xs font-semibold text-white hover:bg-slate-900"
                      >
                        공개 중단 (Suspend)
                      </button>
                    </div>
                  ) : (
                    <form onSubmit={handleDecisionSubmit} className="space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-slate-900 dark:text-white">
                          선택한 액션:{" "}
                          <span
                            className={
                              decisionAction === "publish"
                                ? "text-emerald-600"
                                : decisionAction === "reject"
                                ? "text-rose-600"
                                : "text-amber-600"
                            }
                          >
                            {decisionAction === "publish"
                              ? "공개 승인"
                              : decisionAction === "reject"
                              ? "반려 (draft 복귀)"
                              : "공개 중단 (suspended)"}
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={() => setDecisionAction(null)}
                          className="text-xs text-slate-500 hover:text-slate-800"
                        >
                          취소
                        </button>
                      </div>

                      {(decisionAction === "reject" || decisionAction === "suspend") && (
                        <div>
                          <label
                            htmlFor="decision-reason-input"
                            className="block font-semibold text-slate-800 dark:text-slate-200 mb-1"
                          >
                            {decisionAction === "reject" ? "반려 사유 (필수)" : "공개 중단 사유 (필수)"}
                          </label>
                          <textarea
                            id="decision-reason-input"
                            required
                            rows={3}
                            value={reasonInput}
                            onChange={(e) => setReasonInput(e.target.value)}
                            data-testid="decision-reason-textarea"
                            placeholder="점주 또는 운영팀이 확인할 구체적인 사유를 입력하세요 (2자 이상)"
                            className="w-full rounded-xl border border-slate-300 bg-white p-3 text-xs text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                          />
                        </div>
                      )}

                      {decisionAction === "publish" && (
                        <div>
                          <label
                            htmlFor="decision-notes-input"
                            className="block font-semibold text-slate-800 dark:text-slate-200 mb-1"
                          >
                            검수 메모 (선택)
                          </label>
                          <input
                            id="decision-notes-input"
                            type="text"
                            value={reviewNotesInput}
                            onChange={(e) => setReviewNotesInput(e.target.value)}
                            data-testid="decision-notes-input"
                            placeholder="승인 시 감사 로그에 남길 메모를 입력할 수 있습니다"
                            className="w-full rounded-xl border border-slate-300 bg-white p-2.5 text-xs text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                          />
                        </div>
                      )}

                      <div className="flex gap-2">
                        <button
                          type="submit"
                          disabled={isSubmittingDecision}
                          data-testid="confirm-decision-submit-btn"
                          className="min-h-[44px] flex-1 rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                        >
                          {isSubmittingDecision ? "처리 중..." : "확인 및 결정 적용"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setDecisionAction(null)}
                          className="min-h-[44px] rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                        >
                          돌아가기
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

