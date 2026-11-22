"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { AccessMethodBadge, AccessStatusBadge } from "./AccessStatusBadge";
import PinRevealPanel, { type PinRevealPanelProps } from "./PinRevealPanel";
import VisitConfirmationForm, {
  type VisitConfirmationFormProps,
} from "./VisitConfirmationForm";
import {
  getRefundStatusBadgeLabel,
  resolveEffectiveAccessStatus,
  type CustomerAccessDetail,
} from "./types";

export interface AccessDetailClientProps {
  readonly accessSessionId: string;
  readonly initialDetail?: CustomerAccessDetail | null;
  readonly initialError?: {
    status: number;
    code: string;
    message: string;
  } | null;
  readonly autoFetchOnMount?: boolean;
  readonly injectedRevealRequester?: PinRevealPanelProps["injectedRevealRequester"];
  readonly injectedVisitSubmitRequester?: VisitConfirmationFormProps["injectedSubmitRequester"];
}

export default function AccessDetailClient({
  accessSessionId,
  initialDetail = null,
  initialError = null,
  autoFetchOnMount = false,
  injectedRevealRequester,
  injectedVisitSubmitRequester,
}: AccessDetailClientProps) {
  const [detail, setDetail] = useState<CustomerAccessDetail | null>(
    initialDetail
  );
  const [errorState, setErrorState] = useState<{
    status: number;
    code: string;
    message: string;
  } | null>(initialError);
  const [isLoading, setIsLoading] = useState<boolean>(
    autoFetchOnMount && !initialDetail && !initialError
  );

  const fetchDetail = useCallback(async () => {
    setIsLoading(true);
    setErrorState(null);
    try {
      const res = await fetch(
        `/my/access/${encodeURIComponent(accessSessionId)}/data`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            "Cache-Control": "no-store",
          },
          cache: "no-store",
        }
      );
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok && body.data?.detail) {
        setDetail(body.data.detail);
      } else {
        setDetail(null);
        setErrorState({
          status: res.status || 500,
          code: body?.error?.code || "FETCH_ERROR",
          message:
            body?.error?.message || "이용권 상세 정보를 불러오지 못했습니다.",
        });
      }
    } catch {
      setErrorState({
        status: 503,
        code: "NETWORK_ERROR",
        message: "네트워크 오류로 이용권 상세 정보를 불러오지 못했습니다.",
      });
    } finally {
      setIsLoading(false);
    }
  }, [accessSessionId]);

  useEffect(() => {
    if (autoFetchOnMount) {
      fetchDetail();
    }
  }, [autoFetchOnMount, fetchDetail]);

  // 1. 로딩 중
  if (isLoading && !detail) {
    return (
      <div
        data-testid="access-detail-loading"
        className="rounded-2xl border border-slate-200 bg-white p-8 text-center dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="mx-auto mb-3 h-7 w-7 animate-spin rounded-full border-3 border-purple-600 border-t-transparent" />
        <p className="text-xs text-slate-500">
          이용권 상세 정보를 불러오는 중입니다...
        </p>
      </div>
    );
  }

  // 2. 권한 차단(403 타인 이용권) / 미존재(404) / 비로그인(401) 오류 화면 (PIN 일체 비노출)
  if (errorState || !detail) {
    const status = errorState?.status || 404;
    const isForbidden = status === 403 || errorState?.code === "FORBIDDEN";
    const isUnauthorized =
      status === 401 ||
      errorState?.code === "UNAUTHORIZED" ||
      errorState?.code === "UNAUTHENTICATED";

    return (
      <div
        role="alert"
        data-testid={`access-detail-error-${status}`}
        data-error-code={errorState?.code || "NOT_FOUND"}
        className="flex flex-col gap-4 rounded-2xl border border-rose-200 bg-rose-50 p-5 text-xs text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
      >
        <div>
          <h1 className="text-base font-bold">
            {isUnauthorized
              ? "로그인이 필요한 화면입니다 (401)"
              : isForbidden
              ? "타인의 이용권은 조회할 수 없습니다 (403)"
              : status === 404
              ? "이용권을 찾을 수 없습니다 (404)"
              : "이용권 정보를 불러올 수 없습니다"}
          </h1>
          <p className="mt-1.5 leading-relaxed">
            {errorState?.message ||
              "본인이 결제한 유효한 이용권만 조회 및 PIN 확인이 가능합니다."}
          </p>
        </div>

        <div className="flex flex-col gap-2 pt-1">
          {isUnauthorized ? (
            <Link
              href={`/login?returnTo=${encodeURIComponent(
                `/my/access/${accessSessionId}`
              )}&reason=login_required`}
              data-testid="detail-error-login-link"
              className="flex min-h-[44px] items-center justify-center rounded-xl bg-purple-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-purple-700"
            >
              로그인하고 이용권 확인하기
            </Link>
          ) : (
            <Link
              href="/my/access"
              data-testid="detail-error-back-list-link"
              className="flex min-h-[44px] items-center justify-center rounded-xl bg-purple-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-purple-700"
            >
              내 이용권 목록으로 돌아가기
            </Link>
          )}
          <Link
            href="/map"
            className="flex min-h-[44px] items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
          >
            화장실 지도로 돌아가기
          </Link>
        </div>
      </div>
    );
  }

  const {
    session,
    restroom,
    policy,
    order,
    refund,
    visitConfirmations,
    latestReceipt,
  } = detail;
  const effectiveStatus = resolveEffectiveAccessStatus(session, refund);
  const partnerName =
    restroom?.business_name || restroom?.name || "제휴 매장 화장실";
  const restroomName = restroom?.name || "제휴 화장실";
  const refundBadge = getRefundStatusBadgeLabel(refund?.status);

  const isReceiptAlreadySubmitted =
    latestReceipt &&
    latestReceipt.submissionStatus !== "resubmission_requested";

  return (
    <div
      data-testid="access-detail-client"
      className="flex flex-col gap-4 pb-10 w-full max-w-md mx-auto"
    >
      {/* 상단 네비게이션 */}
      <div className="flex items-center justify-between gap-2">
        <Link
          href="/my/access"
          data-testid="back-to-access-list-link"
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-slate-100 px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300"
        >
          <span>←</span>
          <span>내 이용권 목록</span>
        </Link>

        {restroom?.id && (
          <Link
            href={`/restrooms/${restroom.id}`}
            data-testid="go-to-restroom-detail-link"
            className="inline-flex min-h-[44px] items-center rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
          >
            화장실 정보
          </Link>
        )}
      </div>

      {/* 1~3. 화장실 이름·주소, 현재 이용 상태, 이용권 유효기한 */}
      <section
        data-testid="access-qualification-card"
        className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <AccessStatusBadge
              status={effectiveStatus}
              testId="detail-access-status-badge"
            />
            <AccessMethodBadge method={session.access_method_snapshot} />
          </div>
          {refundBadge && (
            <span
              data-testid="detail-refund-badge"
              className="shrink-0 whitespace-nowrap rounded-md bg-rose-100 px-2 py-0.5 text-[11px] font-bold text-rose-800 dark:bg-rose-950/70 dark:text-rose-200"
            >
              {refundBadge}
            </span>
          )}
        </div>

        <p
          data-testid="detail-partner-name"
          className="text-xs font-semibold text-slate-600 dark:text-slate-300 break-keep"
        >
          🏬 {partnerName}
        </p>
        <h1
          data-testid="detail-restroom-name"
          className="mt-0.5 text-lg font-bold text-slate-900 dark:text-white break-keep break-words"
        >
          {restroomName}
        </h1>
        {restroom && (
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 break-keep break-words">
            📍 {restroom.road_address}
            {restroom.address_detail ? ` ${restroom.address_detail}` : ""}
            {restroom.floor ? ` (${restroom.floor})` : ""}
          </p>
        )}

        {/* 유효기한 및 1회성 테스트 결제 안내 */}
        <div className="mt-4 rounded-xl bg-slate-50 p-3 text-xs space-y-1.5 dark:bg-slate-800/60">
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-500 dark:text-slate-400 shrink-0">
              유효기한
            </span>
            <span
              data-testid="detail-expires-at"
              className="font-semibold text-slate-800 dark:text-slate-200 text-right"
            >
              {new Date(session.expires_at).toLocaleString("ko-KR")}
            </span>
          </div>
          <p
            data-testid="detail-test-mode-watermark"
            className="text-[11px] text-amber-800 dark:text-amber-300 pt-0.5 break-keep"
          >
            ⚠️ 테스트 결제 ({order ? `${order.amount_krw.toLocaleString()}원` : "보증금"}) · 실제 금액은 청구되지 않습니다.
          </p>
        </div>
      </section>

      {/* 2. 도어락 PIN 수동 공개 패널 & 직원 제시 안내 */}
      <PinRevealPanel
        session={{
          ...session,
          status: effectiveStatus,
        }}
        restroom={restroom}
        order={order}
        refund={refund}
        injectedRevealRequester={injectedRevealRequester}
        onSessionRevealed={({ expiresAt }) => {
          setDetail((prev) => {
            if (!prev) return prev;
            const nowIso = new Date().toISOString();
            return {
              ...prev,
              effectiveStatus: "code_revealed",
              session: {
                ...prev.session,
                status:
                  prev.session.status === "authorized"
                    ? "code_revealed"
                    : prev.session.status,
                code_revealed_at: prev.session.code_revealed_at || nowIso,
                expires_at: expiresAt || prev.session.expires_at,
              },
            };
          });
        }}
      />

      {/* 3. 방문 확인 기록 폼 (visit_confirmations) */}
      <VisitConfirmationForm
        accessSessionId={session.id}
        sessionStatus={effectiveStatus}
        order={order}
        initialConfirmations={visitConfirmations}
        injectedSubmitRequester={injectedVisitSubmitRequester}
        onConfirmationRecorded={(recorded) => {
          setDetail((prev) => {
            if (!prev) return prev;
            const existing = prev.visitConfirmations.filter(
              (c) => c.id !== recorded.id
            );
            return {
              ...prev,
              latestVisitConfirmation: recorded,
              visitConfirmations: [recorded, ...existing],
            };
          });
        }}
      />

      {/* 6. 영수증 제출 및 환급 상태 */}
      <section
        data-testid="detail-refund-policy-box"
        className="rounded-2xl border border-slate-200 bg-white p-5 text-xs text-slate-700 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 space-y-3"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white break-keep">
            🧾 영수증 제출 및 보증금 환급
          </h2>
        </div>

        {refund?.status === "succeeded" ? (
          <p className="rounded-xl bg-emerald-50 p-3 font-semibold text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
            ✓ 보증금 {refund.amount_krw.toLocaleString()}원 환급이 완료되었습니다.
          </p>
        ) : isReceiptAlreadySubmitted ? (
          <div className="space-y-2.5">
            <div className="rounded-xl bg-blue-50 p-3 text-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
              <p className="font-semibold">
                {latestReceipt?.submissionStatus === "approved"
                  ? "✓ 영수증이 승인되어 환급이 진행 중입니다."
                  : latestReceipt?.submissionStatus === "rejected"
                  ? "영수증이 반려되었습니다."
                  : "영수증을 확인하고 있습니다."}
              </p>
            </div>
            <Link
              href="/my/receipts"
              data-testid="access-detail-receipts-link"
              className="flex min-h-[44px] w-full items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-bold text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            >
              제출한 영수증 확인하기
            </Link>
          </div>
        ) : order?.status === "approved" ? (
          <div className="space-y-2.5">
            <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-400 break-keep">
              {latestReceipt?.submissionStatus === "resubmission_requested"
                ? "영수증 재제출이 요청되었습니다. 새로운 영수증 사진을 올려주세요."
                : `매장에서 구매한 영수증 사진을 제출하고 승인되면 보증금이 환급됩니다. (${
                    policy?.receipt_window_hours ?? 24
                  }시간 이내)`}
            </p>
            <Link
              href={`/my/receipts?accessSessionId=${encodeURIComponent(session.id)}`}
              data-testid="access-detail-receipts-link"
              className="flex min-h-[44px] w-full items-center justify-center rounded-xl bg-purple-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-purple-700"
            >
              {latestReceipt?.submissionStatus === "resubmission_requested"
                ? "영수증 다시 제출하기"
                : "영수증 제출하러 가기"}
            </Link>
          </div>
        ) : (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            결제 완료 후 영수증을 제출해 보증금을 환급받을 수 있습니다.
          </p>
        )}
      </section>
    </div>
  );
}

