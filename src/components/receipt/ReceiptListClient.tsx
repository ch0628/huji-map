"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import {
  ReceiptItemCard,
  ReceiptSignedImageBox,
  getReceiptStatusHeadline,
} from "./ReceiptItemCard";
import { ReceiptStatusBadge } from "./ReceiptStatusBadge";
import { ReceiptUploadForm, type ReceiptUploadFormProps } from "./ReceiptUploadForm";
import type {
  CustomerReceiptItem,
  EligibleAccessSessionItem,
  CustomerReceiptsData,
} from "./types";
import type { PublicReceiptSubmission } from "@/lib/receipts/types";

export interface ReceiptListClientProps {
  readonly initialData?: CustomerReceiptsData | null;
  readonly initialSelectedSessionId?: string | null;
  readonly autoFetchOnMount?: boolean;
  readonly injectedUploadIntentRequester?: ReceiptUploadFormProps["injectedUploadIntentRequester"];
  readonly injectedStorageUploader?: ReceiptUploadFormProps["injectedStorageUploader"];
  readonly injectedSubmitRequester?: ReceiptUploadFormProps["injectedSubmitRequester"];
}

type TabType = "submitted" | "eligible";

interface GroupedSessionReceipts {
  accessSessionId: string;
  latest: CustomerReceiptItem;
  previous: CustomerReceiptItem[];
}

function sortReceiptsNewestFirst(
  items: readonly CustomerReceiptItem[]
): CustomerReceiptItem[] {
  return [...items].sort((a, b) => {
    const timeDiff =
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    if (timeDiff !== 0) return timeDiff;
    return b.id.localeCompare(a.id);
  });
}

function getSessionDisableReason(
  session: EligibleAccessSessionItem
): string | null {
  if (session.hasApprovedReceipt || session.latestSubmissionStatus === "approved") {
    return "이미 영수증이 승인되었습니다.";
  }
  if (session.isRefunded) {
    return "이미 환급 처리가 완료된 이용권입니다.";
  }
  if (
    session.hasPendingReceipt ||
    session.latestSubmissionStatus === "submitted" ||
    session.latestSubmissionStatus === "review_required"
  ) {
    return "영수증을 확인하고 있습니다.";
  }
  if (
    session.hasRejectedReceipt ||
    session.latestSubmissionStatus === "rejected"
  ) {
    return "반려된 영수증은 다시 제출할 수 없습니다.";
  }
  if (session.isWindowExpired) {
    return "영수증 제출 기한이 만료되었습니다.";
  }
  return null;
}

export function ReceiptListClient({
  initialData = null,
  initialSelectedSessionId = null,
  autoFetchOnMount = false,
  injectedUploadIntentRequester,
  injectedStorageUploader,
  injectedSubmitRequester,
}: ReceiptListClientProps) {
  const isDirectSessionMode = Boolean(initialSelectedSessionId);

  const [data, setData] = useState<CustomerReceiptsData | null>(initialData);
  const [activeTab, setActiveTab] = useState<TabType>("submitted");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    initialSelectedSessionId
  );
  const [isLoading, setIsLoading] = useState<boolean>(
    autoFetchOnMount && !initialData
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (initialData) {
      setData(initialData);
    }
  }, [initialData]);

  const fetchData = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!options?.silent) {
        setIsLoading(true);
      }
      setErrorMessage(null);
      try {
        const query = initialSelectedSessionId
          ? `?accessSessionId=${encodeURIComponent(initialSelectedSessionId)}`
          : "";
        const res = await fetch(`/my/receipts/data${query}`, {
          method: "GET",
          headers: {
            Accept: "application/json",
            "Cache-Control": "no-store",
          },
          cache: "no-store",
        });
        const body = await res.json().catch(() => null);
        if (res.ok && body?.ok && body.data) {
          setData(body.data);
        } else if (!options?.silent) {
          setErrorMessage(
            body?.error?.message || "영수증 정보를 불러오지 못했습니다."
          );
        }
      } catch {
        if (!options?.silent) {
          setErrorMessage("네트워크 오류로 영수증 정보를 불러오지 못했습니다.");
        }
      } finally {
        if (!options?.silent) {
          setIsLoading(false);
        }
      }
    },
    [initialSelectedSessionId]
  );

  useEffect(() => {
    if (autoFetchOnMount) {
      fetchData();
    }
  }, [autoFetchOnMount, fetchData]);

  const receipts = useMemo(() => data?.receipts || [], [data]);
  const eligibleSessions = useMemo(() => data?.eligibleSessions || [], [data]);

  const sessionMap = useMemo(() => {
    const map = new Map<string, EligibleAccessSessionItem>();
    for (const s of eligibleSessions) {
      map.set(s.accessSessionId, s);
    }
    return map;
  }, [eligibleSessions]);

  // Group receipts per accessSessionId (latest submission first, past submissions collapsed)
  const groupedReceipts = useMemo<GroupedSessionReceipts[]>(() => {
    const bySession = new Map<string, CustomerReceiptItem[]>();
    for (const r of sortReceiptsNewestFirst(receipts)) {
      const list = bySession.get(r.accessSessionId);
      if (list) {
        list.push(r);
      } else {
        bySession.set(r.accessSessionId, [r]);
      }
    }

    return Array.from(bySession.entries()).map(([sid, list]) => ({
      accessSessionId: sid,
      latest: list[0],
      previous: list.slice(1),
    }));
  }, [receipts]);

  // Direct session mode state
  const directSessionReceipts = useMemo(() => {
    if (!initialSelectedSessionId) return [];
    return sortReceiptsNewestFirst(
      receipts.filter((r) => r.accessSessionId === initialSelectedSessionId)
    );
  }, [initialSelectedSessionId, receipts]);

  const latestDirectReceipt = directSessionReceipts[0] ?? null;
  const directSession = initialSelectedSessionId
    ? sessionMap.get(initialSelectedSessionId) ?? null
    : null;

  const activeSessionForUpload = useMemo(() => {
    if (!selectedSessionId) return null;
    return sessionMap.get(selectedSessionId) ?? null;
  }, [selectedSessionId, sessionMap]);

  const handleUploadSuccess = (newReceipt: PublicReceiptSubmission) => {
    const targetSession =
      sessionMap.get(newReceipt.accessSessionId) ?? directSession ?? null;

    const mappedItem: CustomerReceiptItem = {
      id: newReceipt.id,
      accessSessionId: newReceipt.accessSessionId,
      userId: newReceipt.userId,
      storagePath: newReceipt.storagePath,
      mimeType: newReceipt.mimeType,
      fileSizeBytes: newReceipt.fileSizeBytes,
      originalFilename: newReceipt.originalFilename,
      submissionStatus: newReceipt.submissionStatus || "submitted",
      storeNameConfirmed: newReceipt.storeNameConfirmed ?? null,
      purchaseAtConfirmed: newReceipt.purchaseAtConfirmed ?? null,
      purchaseAmountKrw: newReceipt.purchaseAmountKrw ?? null,
      reviewReason: newReceipt.reviewReason ?? null,
      reviewedAt: newReceipt.reviewedAt ?? null,
      createdAt: newReceipt.createdAt || new Date().toISOString(),
      restroomName: targetSession?.restroomName || "제휴 화장실",
      partnerName: targetSession?.partnerName || "제휴 매장",
      roadAddress: targetSession?.roadAddress || "",
      depositAmountKrw: targetSession?.depositAmountKrw ?? 1000,
      refundStatus: "none",
      refundAmountKrw: null,
      refundCompletedAt: null,
    };

    setData((prev) => {
      const prevReceipts = prev?.receipts || [];
      const prevSessions = prev?.eligibleSessions || [];
      const deduped = prevReceipts.filter((r) => r.id !== mappedItem.id);
      return {
        receipts: [mappedItem, ...deduped],
        eligibleSessions: prevSessions.map((s) =>
          s.accessSessionId === mappedItem.accessSessionId
            ? {
                ...s,
                hasPendingReceipt: true,
                latestSubmissionStatus: mappedItem.submissionStatus,
              }
            : s
        ),
      };
    });

    if (isDirectSessionMode) {
      // Stay strictly in direct session mode; show latest status and silently refresh
      void fetchData({ silent: true });
      return;
    }

    setSelectedSessionId(null);
    setActiveTab("submitted");
    void fetchData();
  };

  const pendingCount = groupedReceipts.filter(
    (g) =>
      g.latest.submissionStatus === "submitted" ||
      g.latest.submissionStatus === "review_required"
  ).length;

  return (
    <div
      data-testid="receipt-list-client"
      className="flex flex-col gap-4 pb-12 w-full max-w-md mx-auto"
    >
      {/* 상단 네비게이션 */}
      <div className="flex items-center justify-between gap-2">
        <Link
          href={
            initialSelectedSessionId
              ? `/my/access/${encodeURIComponent(initialSelectedSessionId)}`
              : "/my/access"
          }
          data-testid="back-to-access-link"
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-slate-100 px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300"
        >
          <span>←</span>
          <span>{initialSelectedSessionId ? "이용권으로 돌아가기" : "내 이용권 목록"}</span>
        </Link>
        <Link
          href="/map"
          data-testid="go-to-map-link"
          className="inline-flex min-h-[44px] items-center rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
        >
          화장실 지도
        </Link>
      </div>

      {/* 테스트 모드 안내 배너 */}
      <div
        data-testid="receipt-test-mode-watermark"
        className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200 break-keep"
      >
        <span className="font-bold">⚠️ 테스트 결제 · 실제 돈은 청구되지 않음:</span>{" "}
        테스트 환경으로 실제 금액이 청구되거나 인출되지 않습니다.
      </div>

      {/* 에러 알림 */}
      {errorMessage && (
        <div
          role="alert"
          data-testid="receipt-error-alert"
          className="rounded-xl border border-rose-300 bg-rose-50 p-3.5 text-xs text-rose-950 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <p className="font-bold">⚠️ 오류가 발생했습니다</p>
          <p className="mt-1 leading-relaxed">{errorMessage}</p>
          <button
            type="button"
            onClick={() => fetchData()}
            className="mt-2 text-xs font-bold text-rose-700 underline dark:text-rose-400"
          >
            다시 시도
          </button>
        </div>
      )}

      {/* 로딩 표시 */}
      {isLoading && (
        <div
          data-testid="receipts-loading"
          className="rounded-2xl border border-slate-200 bg-white p-8 text-center dark:border-slate-800 dark:bg-slate-900"
        >
          <div className="mx-auto mb-2 h-6 w-6 animate-spin rounded-full border-2 border-purple-600 border-t-transparent" />
          <p className="text-xs text-slate-500">영수증 정보를 불러오는 중입니다...</p>
        </div>
      )}

      {/* A. 이용권에서 직접 진입한 경우: 해당 이용권의 제출 또는 최신 상태만 표시 */}
      {isDirectSessionMode && !isLoading && !errorMessage && initialSelectedSessionId && (
        <section data-testid="direct-session-receipt-section" className="space-y-3">
          {latestDirectReceipt ? (
            latestDirectReceipt.submissionStatus === "resubmission_requested" ? (
              directSession && (directSession.isRefunded || directSession.isWindowExpired) ? (
                <div
                  data-testid="direct-receipt-status-card"
                  className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-3 dark:border-slate-800 dark:bg-slate-900"
                >
                  <ReceiptStatusBadge
                    status={latestDirectReceipt.submissionStatus}
                    refundStatus={latestDirectReceipt.refundStatus}
                    testId="direct-receipt-status-badge"
                  />
                  <p className="text-sm font-bold text-slate-900 dark:text-white">
                    {directSession.isRefunded
                      ? "이미 환급 처리가 완료된 이용권입니다."
                      : "영수증 제출 기한이 만료되었습니다."}
                  </p>
                  {latestDirectReceipt.reviewReason && (
                    <div
                      data-testid="direct-receipt-reason"
                      className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200"
                    >
                      <span className="font-bold">요청 사유: </span>
                      {latestDirectReceipt.reviewReason}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <div
                    data-testid="direct-receipt-status-card"
                    className="rounded-2xl border border-orange-200 bg-orange-50 p-4 text-xs text-orange-950 dark:border-orange-900 dark:bg-orange-950/40 dark:text-orange-200 space-y-1.5"
                  >
                    <p className="font-bold text-sm">
                      {getReceiptStatusHeadline("resubmission_requested")}
                    </p>
                    {latestDirectReceipt.reviewReason && (
                      <p data-testid="direct-receipt-reason" className="leading-relaxed">
                        <span className="font-semibold">요청 사유: </span>
                        {latestDirectReceipt.reviewReason}
                      </p>
                    )}
                  </div>
                  <section data-testid="active-upload-section" className="scroll-mt-4">
                    <ReceiptUploadForm
                      accessSessionId={initialSelectedSessionId}
                      hideContextSummary={true}
                      onSuccess={handleUploadSuccess}
                      injectedUploadIntentRequester={injectedUploadIntentRequester}
                      injectedStorageUploader={injectedStorageUploader}
                      injectedSubmitRequester={injectedSubmitRequester}
                    />
                  </section>
                </div>
              )
            ) : (
              <div
                data-testid="direct-receipt-status-card"
                className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-3 dark:border-slate-800 dark:bg-slate-900"
              >
                <div className="flex items-center justify-between gap-2">
                  <ReceiptStatusBadge
                    status={latestDirectReceipt.submissionStatus}
                    refundStatus={latestDirectReceipt.refundStatus}
                    testId="direct-receipt-status-badge"
                  />
                  <time
                    dateTime={latestDirectReceipt.createdAt}
                    className="text-[11px] text-slate-500"
                  >
                    {new Date(latestDirectReceipt.createdAt).toLocaleDateString("ko-KR", {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </div>

                <p
                  data-testid="direct-receipt-status-message"
                  className="text-sm font-bold text-slate-900 dark:text-white"
                >
                  {getReceiptStatusHeadline(latestDirectReceipt.submissionStatus)}
                </p>

                {latestDirectReceipt.submissionStatus === "approved" && (
                  <p
                    data-testid="direct-receipt-refund-status"
                    className="rounded-xl bg-blue-50 p-3 text-xs font-semibold text-blue-900 dark:bg-blue-950/30 dark:text-blue-200"
                  >
                    {latestDirectReceipt.refundStatus === "completed"
                      ? `보증금 ${latestDirectReceipt.depositAmountKrw.toLocaleString()}원 환급이 완료되었습니다.`
                      : "보증금 환급 절차가 진행 중입니다."}
                  </p>
                )}

                {latestDirectReceipt.submissionStatus === "rejected" &&
                  latestDirectReceipt.reviewReason && (
                    <div
                      data-testid="direct-receipt-reason"
                      className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-950 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200"
                    >
                      <span className="font-bold">반려 사유: </span>
                      {latestDirectReceipt.reviewReason}
                    </div>
                  )}

                {(latestDirectReceipt.submissionStatus === "submitted" ||
                  latestDirectReceipt.submissionStatus === "review_required") && (
                  <ReceiptSignedImageBox receiptId={latestDirectReceipt.id} />
                )}
              </div>
            )
          ) : !directSession ? (
            <div
              data-testid="direct-session-unavailable"
              className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 space-y-3"
            >
              <p className="font-bold text-sm text-slate-900 dark:text-white">
                영수증을 제출할 수 있는 이용권을 찾을 수 없습니다.
              </p>
              <Link
                href="/my/access"
                className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-slate-900 px-4 py-2 text-xs font-bold text-white hover:bg-slate-800 dark:bg-blue-600"
              >
                내 이용권 목록으로 돌아가기
              </Link>
            </div>
          ) : getSessionDisableReason(directSession) ? (
            <div
              data-testid="direct-receipt-status-card"
              className="rounded-2xl border border-slate-200 bg-white p-5 text-center text-xs text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 space-y-2"
            >
              <p
                data-testid="direct-receipt-status-message"
                className="text-sm font-bold text-slate-900 dark:text-white"
              >
                {getSessionDisableReason(directSession)}
              </p>
            </div>
          ) : (
            <section data-testid="active-upload-section" className="scroll-mt-4">
              <ReceiptUploadForm
                accessSessionId={initialSelectedSessionId}
                hideContextSummary={true}
                onSuccess={handleUploadSuccess}
                injectedUploadIntentRequester={injectedUploadIntentRequester}
                injectedStorageUploader={injectedStorageUploader}
                injectedSubmitRequester={injectedSubmitRequester}
              />
            </section>
          )}
        </section>
      )}

      {/* C. 영수증 관리 메뉴 직접 진입: 이용권별 요약 카드 + 탭 관리 */}
      {!isDirectSessionMode && (
        <>
          {selectedSessionId && (
            <section data-testid="active-upload-section" className="scroll-mt-4">
              <ReceiptUploadForm
                accessSessionId={selectedSessionId}
                partnerName={activeSessionForUpload?.partnerName}
                restroomName={activeSessionForUpload?.restroomName}
                onSuccess={handleUploadSuccess}
                onCancel={() => setSelectedSessionId(null)}
                injectedUploadIntentRequester={injectedUploadIntentRequester}
                injectedStorageUploader={injectedStorageUploader}
                injectedSubmitRequester={injectedSubmitRequester}
              />
            </section>
          )}

          <nav
            aria-label="영수증 관리 탭"
            className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800"
          >
            <button
              type="button"
              data-testid="tab-submitted-receipts"
              onClick={() => {
                setActiveTab("submitted");
                setSelectedSessionId(null);
              }}
              className={`flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg text-xs font-bold transition ${
                activeTab === "submitted"
                  ? "bg-white text-slate-900 shadow-sm dark:bg-slate-900 dark:text-white"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
              }`}
            >
              <span>제출 내역 ({groupedReceipts.length})</span>
              {pendingCount > 0 && (
                <span
                  data-testid="pending-badge-count"
                  className="rounded-full bg-amber-500 px-1.5 py-0.2 text-[10px] font-bold text-white"
                >
                  검토 {pendingCount}
                </span>
              )}
            </button>

            <button
              type="button"
              data-testid="tab-eligible-sessions"
              onClick={() => setActiveTab("eligible")}
              className={`flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg text-xs font-bold transition ${
                activeTab === "eligible"
                  ? "bg-white text-slate-900 shadow-sm dark:bg-slate-900 dark:text-white"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
              }`}
            >
              <span>제출 가능 이용권 ({eligibleSessions.length})</span>
            </button>
          </nav>

          {/* 탭 1: 이용권별 영수증 요약 카드 */}
          {!isLoading && activeTab === "submitted" && (
            <section
              data-testid="submitted-receipts-section"
              className="flex flex-col gap-3"
            >
              {groupedReceipts.length === 0 ? (
                <div
                  data-testid="empty-receipts-box"
                  className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center dark:border-slate-800 dark:bg-slate-900"
                >
                  <span className="text-3xl">🧾</span>
                  <h4 className="mt-2 text-sm font-bold text-slate-800 dark:text-slate-200">
                    제출된 영수증이 없습니다
                  </h4>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                    제휴 화장실 이용 후 매장 영수증 사진을 제출하시면 관리자 확인을 거쳐
                    보증금이 환급됩니다.
                  </p>
                  {eligibleSessions.length > 0 && (
                    <button
                      type="button"
                      data-testid="go-to-eligible-tab-btn"
                      onClick={() => setActiveTab("eligible")}
                      className="mt-4 inline-flex min-h-[44px] items-center justify-center rounded-xl bg-purple-600 px-4 py-2 text-xs font-bold text-white hover:bg-purple-700"
                    >
                      제출 가능한 이용권 보기 ({eligibleSessions.length}건)
                    </button>
                  )}
                </div>
              ) : (
                groupedReceipts.map(({ accessSessionId, latest, previous }) => {
                  const linkedSession = sessionMap.get(accessSessionId);
                  const canResubmit =
                    latest.submissionStatus === "resubmission_requested" &&
                    !(linkedSession?.isWindowExpired || linkedSession?.isRefunded);

                  return (
                    <ReceiptItemCard
                      key={accessSessionId}
                      receipt={latest}
                      previousReceipts={previous}
                      enableImagePreview={false}
                      canResubmit={canResubmit}
                      onResubmit={(sessId) => {
                        setSelectedSessionId(sessId);
                        if (typeof window !== "undefined") {
                          window.scrollTo({ top: 0, behavior: "smooth" });
                        }
                      }}
                    />
                  );
                })
              )}
            </section>
          )}

          {/* 탭 2: 영수증 제출 가능한 이용권 목록 */}
          {!isLoading && activeTab === "eligible" && (
            <section
              data-testid="eligible-sessions-section"
              className="flex flex-col gap-3"
            >
              {eligibleSessions.length === 0 ? (
                <div
                  data-testid="empty-eligible-sessions-box"
                  className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center dark:border-slate-800 dark:bg-slate-900"
                >
                  <span className="text-3xl">🎫</span>
                  <h4 className="mt-2 text-sm font-bold text-slate-800 dark:text-slate-200">
                    영수증을 제출할 이용권이 없습니다
                  </h4>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                    결제 승인된 제휴 화장실 이용권이 있을 때 영수증 사진을 제출할 수
                    있습니다.
                  </p>
                  <Link
                    href="/map"
                    className="mt-4 inline-flex min-h-[44px] items-center justify-center rounded-xl bg-purple-600 px-4 py-2 text-xs font-bold text-white hover:bg-purple-700"
                  >
                    화장실 찾기
                  </Link>
                </div>
              ) : (
                eligibleSessions.map((session) => {
                  const cannotSubmitReason = getSessionDisableReason(session);
                  const canSubmit = !cannotSubmitReason;

                  return (
                    <div
                      key={session.accessSessionId}
                      data-testid="eligible-session-card"
                      data-session-id={session.accessSessionId}
                      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 flex flex-col gap-2.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-bold text-purple-700 dark:text-purple-400">
                          🏬 {session.partnerName}
                        </p>
                        <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">
                          보증금 {session.depositAmountKrw.toLocaleString()}원
                        </span>
                      </div>

                      <div>
                        <h4 className="text-sm font-bold text-slate-900 dark:text-white">
                          {session.restroomName}
                        </h4>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                          📍 {session.roadAddress}
                        </p>
                      </div>

                      <div className="rounded-xl bg-slate-50 p-2.5 text-[11px] space-y-1 dark:bg-slate-800/60 text-slate-600 dark:text-slate-300">
                        <div className="flex justify-between">
                          <span className="text-slate-500">결제 시각:</span>
                          <span>
                            {new Date(session.authorizedAt).toLocaleDateString("ko-KR", {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-500">제출 기한:</span>
                          <span className={session.isWindowExpired ? "text-rose-600 font-bold" : ""}>
                            {new Date(session.receiptWindowDeadline).toLocaleDateString("ko-KR", {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}{" "}
                            ({session.receiptWindowHours}시간)
                          </span>
                        </div>
                      </div>

                      {canSubmit ? (
                        <button
                          type="button"
                          data-testid="open-upload-form-btn"
                          onClick={() => {
                            setSelectedSessionId(session.accessSessionId);
                            if (typeof window !== "undefined") {
                              window.scrollTo({ top: 0, behavior: "smooth" });
                            }
                          }}
                          className="mt-1 flex min-h-[44px] w-full items-center justify-center rounded-xl bg-purple-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-purple-700"
                        >
                          🧾 영수증 사진 등록하기
                        </button>
                      ) : (
                        <div
                          data-testid="session-submit-disabled-msg"
                          className="rounded-xl border border-slate-200 bg-slate-100 p-2.5 text-center text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-800 dark:text-slate-400"
                        >
                          {cannotSubmitReason}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

export default ReceiptListClient;
