"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { ReceiptItemCard } from "./ReceiptItemCard";
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

export function ReceiptListClient({
  initialData = null,
  initialSelectedSessionId = null,
  autoFetchOnMount = false,
  injectedUploadIntentRequester,
  injectedStorageUploader,
  injectedSubmitRequester,
}: ReceiptListClientProps) {
  const [data, setData] = useState<CustomerReceiptsData | null>(initialData);
  const [activeTab, setActiveTab] = useState<TabType>(
    initialSelectedSessionId ? "eligible" : "submitted"
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    initialSelectedSessionId
  );
  const [isLoading, setIsLoading] = useState<boolean>(
    autoFetchOnMount && !initialData
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/my/receipts/data", {
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
      } else {
        setErrorMessage(
          body?.error?.message || "영수증 정보를 불러오지 못했습니다."
        );
      }
    } catch {
      setErrorMessage("네트워크 오류로 영수증 정보를 불러오지 못했습니다.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (autoFetchOnMount) {
      fetchData();
    }
  }, [autoFetchOnMount, fetchData]);

  const receipts = useMemo(() => data?.receipts || [], [data]);
  const eligibleSessions = useMemo(() => data?.eligibleSessions || [], [data]);

  // Find currently selected session details for the upload form
  const activeSessionForUpload = useMemo(() => {
    if (!selectedSessionId) return null;
    return (
      eligibleSessions.find((s) => s.accessSessionId === selectedSessionId) ||
      null
    );
  }, [selectedSessionId, eligibleSessions]);

  const handleUploadSuccess = (_newReceipt: PublicReceiptSubmission) => {
    setSelectedSessionId(null);
    setActiveTab("submitted");
    fetchData();
  };

  const pendingCount = receipts.filter(
    (r) =>
      r.submissionStatus === "submitted" ||
      r.submissionStatus === "review_required"
  ).length;

  return (
    <div
      data-testid="receipt-list-client"
      className="flex flex-col gap-4 pb-12 w-full max-w-md mx-auto"
    >
      {/* 상단 네비게이션 */}
      <div className="flex items-center justify-between gap-2">
        <Link
          href="/my/access"
          data-testid="back-to-access-link"
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-slate-100 px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300"
        >
          <span>←</span>
          <span>내 이용권 목록</span>
        </Link>
        <Link
          href="/map"
          data-testid="go-to-map-link"
          className="inline-flex min-h-[44px] items-center rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
        >
          화장실 지도
        </Link>
      </div>

      {/* 테스트 모드 고지 워터마크 배너 (docs/05_SCREEN_SPEC.md) */}
      <div
        data-testid="receipt-test-mode-watermark"
        className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200"
      >
        <span className="font-bold">⚠️ 테스트 결제 · 실제 돈은 청구되지 않음:</span>{" "}
        제휴 매장 이용 영수증 사진을 제출하면 관리자 수동 심사 후 결제 보증금이
        환급(테스트 결제 취소)됩니다. (OCR 자동 승인 없음)
      </div>

      {/* 영수증 업로드 모달/폼 활성화 상태인 경우 */}
      {selectedSessionId && (
        <section
          data-testid="active-upload-section"
          className="scroll-mt-4"
        >
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

      {/* 탭 전환 헤더 */}
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
              ? "bg-white text-purple-700 shadow-sm dark:bg-slate-900 dark:text-purple-400"
              : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
          }`}
        >
          <span>제출 내역 ({receipts.length})</span>
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
              ? "bg-white text-purple-700 shadow-sm dark:bg-slate-900 dark:text-purple-400"
              : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
          }`}
        >
          <span>제출 가능 이용권 ({eligibleSessions.length})</span>
        </button>
      </nav>

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
            onClick={fetchData}
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

      {/* 탭 1: 제출된 영수증 내역 */}
      {!isLoading && activeTab === "submitted" && (
        <section
          data-testid="submitted-receipts-section"
          className="flex flex-col gap-3"
        >
          {receipts.length === 0 ? (
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
            receipts.map((receipt) => (
              <ReceiptItemCard
                key={receipt.id}
                receipt={receipt}
                onResubmit={(sessId) => {
                  setSelectedSessionId(sessId);
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
              />
            ))
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
              const cannotSubmitReason = session.hasApprovedReceipt
                ? "이미 영수증이 승인되었습니다."
                : session.hasPendingReceipt
                ? "이미 제출된 영수증이 검토 중입니다."
                : session.isWindowExpired
                ? "영수증 제출 기한이 만료되었습니다."
                : null;

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
                        window.scrollTo({ top: 0, behavior: "smooth" });
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
    </div>
  );
}

export default ReceiptListClient;

