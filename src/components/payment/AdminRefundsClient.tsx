"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { AdminReceiptListItem } from "@/lib/receipts/types";
import type { AdminRefundListItem } from "@/lib/payments/refunds/types";
import type { PaymentRefundStatus } from "@/lib/payments/types";

export type AdminRefundTabKey =
  | "eligible"
  | "all"
  | "processing"
  | "requested"
  | "failed"
  | "succeeded";

interface AdminReceiptsResponse {
  ok: boolean;
  items?: AdminReceiptListItem[];
  error?: { code?: string; message?: string };
}

interface AdminRefundsListResponse {
  ok: boolean;
  items?: AdminRefundListItem[];
  pagination?: { page: number; limit: number; total: number; totalPages: number };
  error?: { code?: string; message?: string };
}

interface RefundActionNotice {
  readonly tone: "success" | "error" | "warning";
  readonly title: string;
  readonly detail: string;
  readonly requestId?: string;
}

const REFUND_TABS: readonly { readonly key: AdminRefundTabKey; readonly label: string }[] = [
  { key: "eligible", label: "환급 요청 가능" },
  { key: "all", label: "전체 환급 이력" },
  { key: "processing", label: "처리중·불확실" },
  { key: "failed", label: "실패" },
  { key: "succeeded", label: "환급 완료" },
  { key: "requested", label: "요청됨" },
];

const STATUS_BADGE_MAP: Record<
  PaymentRefundStatus,
  { readonly label: string; readonly className: string }
> = {
  requested: {
    label: "환급 요청됨",
    className:
      "border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950/60 dark:text-blue-200",
  },
  processing: {
    label: "처리중·불확실",
    className:
      "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200",
  },
  failed: {
    label: "환급 실패",
    className:
      "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200",
  },
  succeeded: {
    label: "테스트 환급 완료",
    className:
      "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200",
  },
};

function formatDateTime(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatKrw(amount?: number | null): string {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return "—";
  return `${amount.toLocaleString("ko-KR")}원`;
}

function buildIdempotencyKey(paymentOrderId: string): string {
  const compact = paymentOrderId.replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 10)
      : Math.random().toString(36).slice(2, 12);
  return `hm_refund_${compact}_${Date.now()}_${rand}`;
}

function isReceiptRefundEligible(item: AdminReceiptListItem): {
  readonly eligible: boolean;
  readonly reason: string | null;
} {
  if (item.submissionStatus !== "approved") {
    return { eligible: false, reason: "영수증이 승인(approved) 상태가 아닙니다." };
  }
  if (!item.paymentOrderId) {
    return { eligible: false, reason: "연결된 테스트 보증금 결제 주문이 없습니다." };
  }
  if (item.paymentMode && item.paymentMode !== "test") {
    return { eligible: false, reason: "테스트 결제(payment_mode=test) 주문만 환급 가능합니다." };
  }
  if (item.paymentStatus !== "approved") {
    return {
      eligible: false,
      reason: `결제 주문 상태(${item.paymentStatus ?? "없음"})가 승인 완료(approved)가 아닙니다.`,
    };
  }
  if (item.refundStatus && item.refundStatus !== "none") {
    return {
      eligible: false,
      reason: `이미 환급 이력(${item.refundStatus})이 존재합니다.`,
    };
  }
  return { eligible: true, reason: null };
}

export interface AdminRefundsClientProps {
  readonly initialTab?: AdminRefundTabKey;
}

export default function AdminRefundsClient({
  initialTab = "eligible",
}: AdminRefundsClientProps) {
  const [activeTab, setActiveTab] = useState<AdminRefundTabKey>(initialTab);
  const [approvedReceipts, setApprovedReceipts] = useState<AdminReceiptListItem[]>([]);
  const [refundItems, setRefundItems] = useState<AdminRefundListItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorState, setErrorState] = useState<{
    status: number | null;
    code: string | null;
    message: string;
  } | null>(null);
  const [actionNotice, setActionNotice] = useState<RefundActionNotice | null>(null);
  const [confirmingOrderId, setConfirmingOrderId] = useState<string | null>(null);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);

  // Per-session duplicate mutex + stable idempotencyKey per paymentOrderId
  const inFlightOrdersRef = useRef<Set<string>>(new Set());
  const sessionIdempotencyKeysRef = useRef<Map<string, string>>(new Map());
  const [sessionKeyOrderIds, setSessionKeyOrderIds] = useState<Set<string>>(new Set());

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setErrorState(null);

    try {
      const [receiptsRes, refundsRes] = await Promise.all([
        fetch("/api/v1/admin/receipts?status=approved&limit=50", {
          method: "GET",
          cache: "no-store",
        }),
        fetch("/api/v1/admin/refunds?limit=50", {
          method: "GET",
          cache: "no-store",
        }),
      ]);

      const receiptsJson = (await receiptsRes.json().catch(() => null)) as
        | AdminReceiptsResponse
        | null;
      const refundsJson = (await refundsRes.json().catch(() => null)) as
        | AdminRefundsListResponse
        | null;

      if (!receiptsRes.ok || !receiptsJson?.ok) {
        const status = receiptsRes.status;
        setErrorState({
          status,
          code: receiptsJson?.error?.code ?? null,
          message:
            receiptsJson?.error?.message ||
            (status === 401
              ? "관리자 로그인이 필요합니다 (401)."
              : status === 403
                ? "관리자 권한이 필요합니다 (403)."
                : "승인된 영수증 목록을 불러오지 못했습니다."),
        });
        setApprovedReceipts([]);
        setRefundItems([]);
        return;
      }

      if (!refundsRes.ok || !refundsJson?.ok) {
        const status = refundsRes.status;
        setErrorState({
          status,
          code: refundsJson?.error?.code ?? null,
          message:
            refundsJson?.error?.message ||
            "환급 이력 목록을 불러오지 못했습니다.",
        });
        setApprovedReceipts(receiptsJson.items ?? []);
        setRefundItems([]);
        return;
      }

      setApprovedReceipts(receiptsJson.items ?? []);
      setRefundItems(refundsJson.items ?? []);
    } catch {
      setErrorState({
        status: null,
        code: "NETWORK_ERROR",
        message: "네트워크 오류로 환급 관리 데이터를 불러오지 못했습니다.",
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const refundByOrderId = useMemo(() => {
    const map = new Map<string, AdminRefundListItem>();
    for (const item of refundItems) {
      map.set(item.payment_order_id, item);
    }
    return map;
  }, [refundItems]);

  const eligibleCandidates = useMemo(() => {
    return approvedReceipts.filter((receipt) => {
      if (!receipt.paymentOrderId) return true;
      const existingRefund = refundByOrderId.get(receipt.paymentOrderId);
      if (existingRefund) return false;
      return !receipt.refundStatus || receipt.refundStatus === "none";
    });
  }, [approvedReceipts, refundByOrderId]);

  const filteredRefunds = useMemo(() => {
    if (activeTab === "eligible") return [];
    if (activeTab === "all") return refundItems;
    return refundItems.filter((item) => item.status === activeTab);
  }, [activeTab, refundItems]);

  const counts = useMemo(() => {
    const eligibleReady = approvedReceipts.filter((r) => {
      if (!r.paymentOrderId || refundByOrderId.has(r.paymentOrderId)) return false;
      return isReceiptRefundEligible(r).eligible;
    }).length;
    return {
      eligibleReady,
      all: refundItems.length,
      processing: refundItems.filter((i) => i.status === "processing").length,
      failed: refundItems.filter((i) => i.status === "failed").length,
      succeeded: refundItems.filter((i) => i.status === "succeeded").length,
      requested: refundItems.filter((i) => i.status === "requested").length,
    };
  }, [approvedReceipts, refundByOrderId, refundItems]);

  const handleRequestRefund = useCallback(
    async (paymentOrderId: string, receiptSubmissionId: string) => {
      if (inFlightOrdersRef.current.has(paymentOrderId)) return;

      inFlightOrdersRef.current.add(paymentOrderId);
      setBusyOrderId(paymentOrderId);
      setActionNotice(null);

      let idempotencyKey = sessionIdempotencyKeysRef.current.get(paymentOrderId);
      if (!idempotencyKey) {
        idempotencyKey = buildIdempotencyKey(paymentOrderId);
        sessionIdempotencyKeysRef.current.set(paymentOrderId, idempotencyKey);
        setSessionKeyOrderIds((prev) => {
          const next = new Set(prev);
          next.add(paymentOrderId);
          return next;
        });
      }

      try {
        const res = await fetch(
          `/api/v1/admin/refunds/${encodeURIComponent(paymentOrderId)}/request`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-idempotency-key": idempotencyKey,
            },
            body: JSON.stringify({
              receiptSubmissionId,
              idempotencyKey,
            }),
          }
        );

        const data = (await res.json().catch(() => null)) as {
          ok?: boolean;
          outcome?: string;
          reused?: boolean;
          refund?: { amount_krw?: number; status?: string };
          requestId?: string;
          error?: { code?: string; message?: string };
        } | null;

        if (!res.ok || !data?.ok) {
          const code = data?.error?.code || `HTTP_${res.status}`;
          const message =
            data?.error?.message || "테스트 환급 요청 처리 중 오류가 발생했습니다.";
          setActionNotice({
            tone: res.status === 504 || res.status === 409 ? "warning" : "error",
            title: `환급 요청 실패 (${code})`,
            detail: message,
            requestId: data?.requestId,
          });
          setConfirmingOrderId(null);
          await loadData();
          return;
        }

        const outcomeText =
          data.outcome === "already_succeeded"
            ? "이미 환급 완료된 주문의 기존 결과를 안전하게 반환했습니다."
            : data.outcome === "reconciled_succeeded"
              ? "Toss 결제 상태 재조회를 거쳐 테스트 전액 취소를 완료 처리했습니다."
              : "Toss 테스트 전액 취소 요청 및 환급 완료 기록이 저장되었습니다.";

        setActionNotice({
          tone: "success",
          title: `테스트 환급 완료 (${formatKrw(data.refund?.amount_krw)})`,
          detail: outcomeText,
          requestId: data.requestId,
        });
        setConfirmingOrderId(null);
        await loadData();
      } catch {
        setActionNotice({
          tone: "warning",
          title: "환급 요청 통신 오류",
          detail:
            "네트워크 오류로 응답을 받지 못했습니다. 중복 취소를 막기 위해 'Toss 상태 재조회'로 실제 상태를 먼저 확인하세요.",
        });
        await loadData();
      } finally {
        inFlightOrdersRef.current.delete(paymentOrderId);
        setBusyOrderId(null);
      }
    },
    [loadData]
  );

  const handleReconcileRefund = useCallback(
    async (paymentOrderId: string) => {
      if (inFlightOrdersRef.current.has(paymentOrderId)) return;

      inFlightOrdersRef.current.add(paymentOrderId);
      setBusyOrderId(paymentOrderId);
      setActionNotice(null);

      try {
        const res = await fetch(
          `/api/v1/admin/refunds/${encodeURIComponent(paymentOrderId)}/reconcile`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
          }
        );

        const data = (await res.json().catch(() => null)) as {
          ok?: boolean;
          reconciled?: boolean;
          pgStatus?: string;
          refund?: { amount_krw?: number; status?: string };
          requestId?: string;
          error?: { code?: string; message?: string };
        } | null;

        if (!res.ok || !data?.ok) {
          setActionNotice({
            tone: "error",
            title: `상태 재조회 실패 (${data?.error?.code || `HTTP_${res.status}`})`,
            detail:
              data?.error?.message || "Toss 결제 상태 재조회 중 오류가 발생했습니다.",
            requestId: data?.requestId,
          });
          await loadData();
          return;
        }

        if (data.reconciled) {
          setActionNotice({
            tone: "success",
            title: `상태 재조회 복구 완료 (${formatKrw(data.refund?.amount_krw)})`,
            detail: `Toss 실조회 상태(${data.pgStatus})가 취소 완료로 확인되어 DB 환급 상태를 succeeded로 복구했습니다.`,
            requestId: data.requestId,
          });
        } else {
          setActionNotice({
            tone: "warning",
            title: `Toss 현재 상태: ${data.pgStatus || "확인 완료"}`,
            detail:
              "아직 Toss에서 최종 취소 완료 상태가 아닙니다. 실패 사유를 확인한 뒤 필요 시 재시도하세요.",
            requestId: data.requestId,
          });
        }
        await loadData();
      } catch {
        setActionNotice({
          tone: "error",
          title: "상태 재조회 네트워크 오류",
          detail: "잠시 후 다시 상태 재조회를 시도해 주세요.",
        });
      } finally {
        inFlightOrdersRef.current.delete(paymentOrderId);
        setBusyOrderId(null);
      }
    },
    [loadData]
  );

  return (
    <div
      data-testid="admin-refunds-client"
      className="flex min-w-0 flex-col gap-4 pb-8"
    >
      {/* 상단 테스트 모드 경고 배너 */}
      <div
        data-testid="admin-refunds-test-banner"
        className="rounded-2xl border border-amber-300 bg-amber-50 p-3.5 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
      >
        <p className="font-bold">
          🧪 테스트 결제 환급 전용 화면 (실제 금전·계좌 이체 없음)
        </p>
        <p className="mt-1 leading-relaxed text-[11px] text-amber-900 dark:text-amber-200">
          관리자 수동 영수증 승인과 실제 PG 환급은 분리되어 있습니다.{" "}
          <strong>PAYMENT_MODE=test</strong> 환경에서만 Toss 테스트 전액 취소 API가
          호출되며, 실거래 키(`live_`) 및 부분 환급은 차단됩니다.
        </p>
      </div>

      {/* 상단 요약 + 새로고침 */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white p-3.5 shadow-xs dark:border-slate-800 dark:bg-slate-900">
        <div className="min-w-0">
          <h1 className="text-base font-bold text-slate-900 dark:text-white">
            보증금 테스트 환급 관리
          </h1>
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            대기 적격 {counts.eligibleReady}건 · 처리중 {counts.processing}건 · 실패{" "}
            {counts.failed}건 · 완료 {counts.succeeded}건
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/admin/receipts"
            className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
          >
            영수증 심사
          </Link>
          <button
            type="button"
            onClick={loadData}
            disabled={isLoading || Boolean(busyOrderId)}
            data-testid="admin-refunds-refresh-btn"
            className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-slate-900 px-3.5 py-2 text-xs font-bold text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
          >
            {isLoading ? "불러오는 중..." : "새로고침"}
          </button>
        </div>
      </div>

      {/* 액션 피드백 배너 */}
      {actionNotice && (
        <div
          role={actionNotice.tone === "error" ? "alert" : "status"}
          aria-live="polite"
          data-testid="admin-refunds-action-notice"
          className={`rounded-2xl border p-3.5 text-xs ${
            actionNotice.tone === "success"
              ? "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100"
              : actionNotice.tone === "warning"
                ? "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
                : "border-rose-300 bg-rose-50 text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-100"
          }`}
        >
          <p className="font-bold">{actionNotice.title}</p>
          <p className="mt-1 leading-relaxed break-words">{actionNotice.detail}</p>
          {actionNotice.requestId && (
            <p className="mt-1 font-mono text-[10px] opacity-75 break-all">
              requestId: {actionNotice.requestId}
            </p>
          )}
        </div>
      )}

      {/* 필터 탭 */}
      <div
        role="tablist"
        aria-label="환급 상태 필터"
        className="flex flex-wrap gap-1.5"
      >
        {REFUND_TABS.map((tab) => {
          const isActive = activeTab === tab.key;
          const badgeCount =
            tab.key === "eligible"
              ? counts.eligibleReady
              : tab.key === "all"
                ? counts.all
                : counts[tab.key];

          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              data-testid={`refund-tab-${tab.key}`}
              onClick={() => setActiveTab(tab.key)}
              className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition ${
                isActive
                  ? "border-blue-600 bg-blue-600 text-white"
                  : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
              }`}
            >
              <span>{tab.label}</span>
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                  isActive
                    ? "bg-white/20 text-white"
                    : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                }`}
              >
                {badgeCount}
              </span>
            </button>
          );
        })}
      </div>

      {/* 로딩 / 오류 상태 */}
      {isLoading ? (
        <div
          data-testid="admin-refunds-loading"
          className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400"
        >
          환급 대상 및 이력을 조회하는 중입니다...
        </div>
      ) : errorState ? (
        <div
          role="alert"
          data-testid="admin-refunds-error"
          className="space-y-2.5 rounded-2xl border border-rose-300 bg-rose-50 p-4 text-xs text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-100"
        >
          <p className="font-bold">조회 오류 ({errorState.status ?? "NETWORK"})</p>
          <p className="leading-relaxed">{errorState.message}</p>
          <button
            type="button"
            onClick={loadData}
            className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-rose-700 px-4 py-2 text-xs font-bold text-white hover:bg-rose-800"
          >
            다시 시도
          </button>
        </div>
      ) : activeTab === "eligible" ? (
        eligibleCandidates.length === 0 ? (
          <div
            data-testid="admin-refunds-empty-eligible"
            className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400"
          >
            <p className="font-semibold text-slate-700 dark:text-slate-200">
              새로 환급을 요청할 승인 영수증 주문이 없습니다.
            </p>
            <p className="mt-1">
              이미 환급이 진행 중이거나 완료된 건은 &quot;전체 환급 이력&quot; 탭에서 확인할 수 있습니다.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3" data-testid="admin-refunds-eligible-list">
            {eligibleCandidates.map((receipt) => {
              const eligibility = isReceiptRefundEligible(receipt);
              const paymentOrderId = receipt.paymentOrderId ?? "";
              const isBusy = Boolean(paymentOrderId && busyOrderId === paymentOrderId);
              const isConfirming = Boolean(
                paymentOrderId && confirmingOrderId === paymentOrderId
              );

              return (
                <article
                  key={receipt.id}
                  data-testid={`eligible-refund-card-${receipt.id}`}
                  className="flex min-w-0 flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs dark:border-slate-800 dark:bg-slate-900"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-slate-900 dark:text-white break-words">
                        {receipt.businessName || receipt.restroomName || "제휴 매장"}
                      </p>
                      <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 break-words">
                        {receipt.restroomName || "화장실"} · 주문번호{" "}
                        <span className="font-mono">
                          {receipt.paymentOrderNumber || "없음"}
                        </span>
                      </p>
                    </div>
                    <span
                      className={`inline-flex shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-bold ${
                        eligibility.eligible
                          ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200"
                          : "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                      }`}
                    >
                      {eligibility.eligible ? "환급 요청 가능" : "환급 대상 제외"}
                    </span>
                  </div>

                  <dl className="grid grid-cols-1 gap-1.5 rounded-xl bg-slate-50 p-3 text-xs dark:bg-slate-800/60">
                    <div className="flex justify-between gap-2">
                      <dt className="text-slate-500 dark:text-slate-400">영수증 심사</dt>
                      <dd className="font-semibold text-emerald-700 dark:text-emerald-300">
                        승인 완료 ({formatDateTime(receipt.reviewedAt)})
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-slate-500 dark:text-slate-400">결제 보증금</dt>
                      <dd className="font-bold text-slate-900 dark:text-white">
                        {formatKrw(receipt.paymentAmountKrw ?? receipt.depositAmountKrw)} (
                        {receipt.paymentStatus || "미결제"})
                      </dd>
                    </div>
                    {receipt.reviewReason && (
                      <div className="flex flex-col gap-0.5 pt-1 border-t border-slate-200/70 dark:border-slate-700">
                        <dt className="text-[11px] text-slate-500 dark:text-slate-400">
                          심사 메모
                        </dt>
                        <dd className="text-[11px] text-slate-700 dark:text-slate-200 break-words">
                          {receipt.reviewReason}
                        </dd>
                      </div>
                    )}
                  </dl>

                  {!eligibility.eligible ? (
                    <p
                      data-testid={`ineligible-reason-${receipt.id}`}
                      className="rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-[11px] text-slate-600 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-300"
                    >
                      {eligibility.reason}
                    </p>
                  ) : isConfirming ? (
                    <div
                      data-testid={`confirm-refund-box-${paymentOrderId}`}
                      className="space-y-2.5 rounded-xl border border-purple-300 bg-purple-50 p-3 text-xs text-purple-950 dark:border-purple-800 dark:bg-purple-950/40 dark:text-purple-100"
                    >
                      <p className="font-bold">
                        테스트 보증금 {formatKrw(receipt.paymentAmountKrw)} 전액 취소를
                        실행할까요?
                      </p>
                      <p className="text-[11px] leading-relaxed">
                        승인된 영수증 기준으로 Toss 테스트 취소 API가 1회 호출되며 부분
                        환급은 지원하지 않습니다.
                      </p>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <button
                          type="button"
                          disabled={isBusy || Boolean(busyOrderId)}
                          data-testid={`confirm-refund-submit-${paymentOrderId}`}
                          onClick={() => handleRequestRefund(paymentOrderId, receipt.id)}
                          className="flex min-h-[44px] flex-1 items-center justify-center rounded-xl bg-purple-600 px-3 py-2.5 text-xs font-bold text-white hover:bg-purple-700 disabled:opacity-50"
                        >
                          {isBusy ? "환급 처리 중..." : "전액 취소 요청 확인"}
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => setConfirmingOrderId(null)}
                          className="flex min-h-[44px] items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                        >
                          취소
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={Boolean(busyOrderId)}
                      data-testid={`request-refund-btn-${paymentOrderId}`}
                      onClick={() => setConfirmingOrderId(paymentOrderId)}
                      className="flex min-h-[44px] w-full items-center justify-center rounded-xl bg-purple-600 px-4 py-2.5 text-xs font-bold text-white shadow-xs hover:bg-purple-700 disabled:opacity-50"
                    >
                      테스트 전액 환급 요청 ({formatKrw(receipt.paymentAmountKrw)})
                    </button>
                  )}
                </article>
              );
            })}
          </div>
        )
      ) : filteredRefunds.length === 0 ? (
        <div
          data-testid="admin-refunds-empty-history"
          className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400"
        >
          해당 상태의 환급 이력이 없습니다.
        </div>
      ) : (
        <div className="flex flex-col gap-3" data-testid="admin-refunds-history-list">
          {filteredRefunds.map((refund) => {
            const badge = STATUS_BADGE_MAP[refund.status];
            const isBusy = busyOrderId === refund.payment_order_id;
            const hasSessionKey = sessionKeyOrderIds.has(refund.payment_order_id);

            return (
              <article
                key={refund.id}
                data-testid={`refund-history-card-${refund.payment_order_id}`}
                className="flex min-w-0 flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs dark:border-slate-800 dark:bg-slate-900"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-slate-900 dark:text-white break-all">
                      주문번호 {refund.orderNumber || refund.payment_order_id}
                    </p>
                    <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                      결제상태: {refund.orderStatus || "—"} · 영수증:{" "}
                      {refund.receiptStatus || "—"} · 모드: {refund.paymentMode || "test"}
                    </p>
                  </div>
                  <span
                    data-testid={`refund-status-badge-${refund.payment_order_id}`}
                    className={`inline-flex shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-bold ${badge.className}`}
                  >
                    {badge.label}
                  </span>
                </div>

                <dl className="grid grid-cols-1 gap-1.5 rounded-xl bg-slate-50 p-3 text-xs dark:bg-slate-800/60">
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-500 dark:text-slate-400">환급 금액</dt>
                    <dd className="font-bold text-slate-900 dark:text-white">
                      {formatKrw(refund.amount_krw)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-500 dark:text-slate-400">요청 시각</dt>
                    <dd className="text-slate-700 dark:text-slate-200">
                      {formatDateTime(refund.requested_at)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-500 dark:text-slate-400">완료 시각</dt>
                    <dd className="text-slate-700 dark:text-slate-200">
                      {formatDateTime(refund.completed_at)}
                    </dd>
                  </div>
                </dl>

                {refund.failure_reason && (
                  <div
                    role="alert"
                    data-testid={`refund-failure-reason-${refund.payment_order_id}`}
                    className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-[11px] text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-200 break-words"
                  >
                    <span className="font-bold">실패·보류 사유:</span> {refund.failure_reason}
                  </div>
                )}

                {refund.manualCheckRequired && (
                  <div
                    data-testid={`refund-manual-check-${refund.payment_order_id}`}
                    className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-[11px] text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
                  >
                    ⚠️ 15일 멱등키 유효기간 경과 또는 PG 상태 불일치로 자동 재취소가
                    차단되었습니다. 토스 상점관리자에서 직접 확인 후 재조회를 실행하세요.
                  </div>
                )}

                {refund.status !== "succeeded" && (
                  <div className="flex flex-col gap-2">
                    <button
                      type="button"
                      disabled={isBusy || Boolean(busyOrderId)}
                      data-testid={`reconcile-refund-btn-${refund.payment_order_id}`}
                      onClick={() => handleReconcileRefund(refund.payment_order_id)}
                      className="flex min-h-[44px] w-full items-center justify-center rounded-xl border border-blue-300 bg-blue-50 px-4 py-2.5 text-xs font-bold text-blue-800 hover:bg-blue-100 disabled:opacity-50 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-200"
                    >
                      {isBusy ? "Toss 상태 조회 중..." : "Toss 상태 재조회 (중복 취소 없음)"}
                    </button>

                    {refund.canRetry &&
                      refund.receipt_submission_id &&
                      hasSessionKey && (
                        <button
                          type="button"
                          disabled={isBusy || Boolean(busyOrderId)}
                          data-testid={`retry-refund-btn-${refund.payment_order_id}`}
                          onClick={() =>
                            handleRequestRefund(
                              refund.payment_order_id,
                              refund.receipt_submission_id as string
                            )
                          }
                          className="flex min-h-[44px] w-full items-center justify-center rounded-xl bg-purple-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-purple-700 disabled:opacity-50"
                        >
                          {isBusy ? "재시도 중..." : "동일 멱등키로 환급 재시도"}
                        </button>
                      )}

                    {refund.canRetry && !hasSessionKey && (
                      <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                        안내: 이전 요청의 멱등키는 서버에 격리 보관되므로 새 요청 시 중복
                        방지 충돌(409)이 발생할 수 있습니다. 먼저{" "}
                        <strong>Toss 상태 재조회</strong>로 PG 취소 여부를 확인하세요.
                      </p>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
