"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import Link from "next/link";
import type { PublicAccessSession, RevealPinResponse } from "@/lib/access/types";
import type { PublicPaymentOrder, PublicPaymentRefund } from "@/lib/payments/types";
import {
  classifyPinRevealError,
  evaluatePinRevealEligibility,
  type AccessRestroomSummary,
  type ClassifiedPinError,
} from "./types";

export interface PinRevealPanelProps {
  readonly session: PublicAccessSession;
  readonly restroom: AccessRestroomSummary | null;
  readonly order: PublicPaymentOrder | null;
  readonly refund: PublicPaymentRefund | null;
  readonly onSessionRevealed?: (meta: {
    codeVersion: number;
    expiresAt: string;
  }) => void;
  readonly injectedRevealRequester?: (
    accessSessionId: string
  ) => Promise<{
    httpStatus: number;
    body:
      | RevealPinResponse
      | {
          ok: false;
          error?: { code?: string; message?: string };
          requestId?: string;
        };
  }>;
}

interface VolatilePinState {
  pin: string;
  codeVersion: number;
  expiresAt: string;
  revealedAt: string;
}

export default function PinRevealPanel({
  session,
  restroom,
  order,
  refund,
  onSessionRevealed,
  injectedRevealRequester,
}: PinRevealPanelProps) {
  // CRITICAL SECURITY INVARIANT:
  // Plaintext PIN is held ONLY in volatile React state and NEVER persisted to
  // localStorage, sessionStorage, cookies, URL parameters, or analytics telemetry.
  const [revealedPinState, setRevealedPinState] =
    useState<VolatilePinState | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [pinError, setPinError] = useState<ClassifiedPinError | null>(null);

  // Synchronous mutex to prevent duplicate concurrent requests on rapid double-click
  const inFlightRef = useRef<boolean>(false);
  const isMountedRef = useRef<boolean>(true);

  const clearVolatilePin = useCallback(() => {
    setRevealedPinState(null);
  }, []);

  // Wipe PIN immediately on unmount, pagehide, or tab backgrounding
  useEffect(() => {
    isMountedRef.current = true;

    const handlePageHide = () => {
      setRevealedPinState(null);
    };

    const handleVisibilityChange = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        setRevealedPinState(null);
      }
    };

    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", handlePageHide);
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    return () => {
      isMountedRef.current = false;
      setRevealedPinState(null);
      if (typeof window !== "undefined") {
        window.removeEventListener("pagehide", handlePageHide);
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
    };
  }, []);

  // Auto-wipe PIN if expiration time is reached while viewing
  useEffect(() => {
    if (!revealedPinState) return;
    const expiryMs = new Date(
      revealedPinState.expiresAt || session.expires_at
    ).getTime();
    const remainingMs = expiryMs - Date.now();

    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      setRevealedPinState(null);
      setPinError(
        classifyPinRevealError(
          422,
          "ACCESS_EXPIRED",
          "화장실 이용권의 유효 시간이 만료되어 표시된 PIN이 자동으로 닫혔습니다."
        )
      );
      return;
    }

    const timer = setTimeout(() => {
      if (!isMountedRef.current) return;
      setRevealedPinState(null);
      setPinError(
        classifyPinRevealError(
          422,
          "ACCESS_EXPIRED",
          "화장실 이용권의 유효 시간이 만료되어 표시된 PIN이 자동으로 닫혔습니다."
        )
      );
    }, Math.min(remainingMs, 2_147_483_647));

    return () => clearTimeout(timer);
  }, [revealedPinState, session.expires_at]);

  const eligibility = evaluatePinRevealEligibility({
    session,
    order,
    refund,
    restroom,
  });

  const handleRevealPin = useCallback(async () => {
    // Prevent duplicate click / concurrent request
    if (inFlightRef.current || isLoading) {
      return;
    }

    // Always clear any previously shown PIN before starting a new request
    // (Especially critical so stale PIN never lingers if 409 PIN_STALE_ROTATED occurs)
    setRevealedPinState(null);
    setPinError(null);
    inFlightRef.current = true;
    setIsLoading(true);

    try {
      let httpStatus: number;
      let body: any;

      if (injectedRevealRequester) {
        const res = await injectedRevealRequester(session.id);
        httpStatus = res.httpStatus;
        body = res.body;
      } else {
        const response = await fetch(
          `/api/v1/access/${encodeURIComponent(session.id)}/reveal-pin`,
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Cache-Control": "no-store",
            },
            cache: "no-store",
            credentials: "same-origin",
          }
        );
        httpStatus = response.status;
        body = await response.json().catch(() => null);
      }

      if (!isMountedRef.current) return;

      if (
        httpStatus === 200 &&
        body &&
        body.ok === true &&
        typeof body.pin === "string" &&
        body.pin.length > 0
      ) {
        const codeVersion =
          typeof body.codeVersion === "number" ? body.codeVersion : 1;
        const expiresAt =
          typeof body.expiresAt === "string"
            ? body.expiresAt
            : session.expires_at;

        setRevealedPinState({
          pin: body.pin,
          codeVersion,
          expiresAt,
          revealedAt: new Date().toISOString(),
        });
        setPinError(null);
        onSessionRevealed?.({ codeVersion, expiresAt });
        return;
      }

      // Error handling: ensure PIN is wiped and classify the exact error reason
      setRevealedPinState(null);
      const errCode = body?.error?.code || null;
      const errMsg = body?.error?.message || null;
      setPinError(classifyPinRevealError(httpStatus, errCode, errMsg));
    } catch {
      if (!isMountedRef.current) return;
      setRevealedPinState(null);
      setPinError(
        classifyPinRevealError(
          503,
          "NETWORK_ERROR",
          "네트워크 연결 상태가 불안정하여 도어락 PIN을 조회하지 못했습니다. 잠시 후 다시 시도해 주세요."
        )
      );
    } finally {
      inFlightRef.current = false;
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [
    injectedRevealRequester,
    isLoading,
    onSessionRevealed,
    session.expires_at,
    session.id,
  ]);

  const partnerName =
    restroom?.business_name || restroom?.name || "제휴 매장";
  const verificationTicketCode = session.id.slice(0, 8).toUpperCase();

  // Case A: Non-PIN restroom (ask_staff or open)
  if (session.access_method_snapshot !== "pin") {
    const isAskStaff = session.access_method_snapshot === "ask_staff";
    const isTicketValid =
      (session.status === "authorized" || session.status === "code_revealed") &&
      order?.status === "approved" &&
      !refund &&
      new Date(session.expires_at).getTime() > Date.now();

    return (
      <section
        data-testid="staff-presentation-panel"
        aria-label="직원 제시용 이용권 안내"
        className="rounded-2xl border border-blue-200 bg-white p-5 shadow-sm dark:border-blue-900/60 dark:bg-slate-900"
      >
        <div className="flex items-center justify-between gap-2 mb-3">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white">
            {isAskStaff
              ? "🙋 직원 문의 출입 · 직원 제시용 이용권"
              : "🚪 개방형 제휴 화장실 출입 안내"}
          </h2>
          <span className="rounded-md bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-800 dark:bg-blue-950/60 dark:text-blue-300">
            도어락 PIN 미사용
          </span>
        </div>

        {isTicketValid ? (
          <div
            data-testid="staff-ticket-active"
            className="rounded-xl border-2 border-dashed border-blue-300 bg-blue-50/70 p-4 text-center dark:border-blue-800 dark:bg-blue-950/30"
          >
            <p className="text-xs font-semibold text-blue-800 dark:text-blue-300">
              매장 직원에게 이 화면을 제시해 주세요
            </p>
            <p className="mt-1 text-base font-bold text-slate-900 dark:text-white">
              {partnerName}
            </p>
            <div className="my-3 inline-block rounded-lg bg-white px-4 py-2 font-mono text-lg font-extrabold tracking-widest text-blue-700 shadow-xs border border-blue-200 dark:bg-slate-900 dark:text-blue-300 dark:border-blue-800">
              확인번호 #{verificationTicketCode}
            </div>
            <p className="text-[11px] text-slate-600 dark:text-slate-400">
              유효기한: {new Date(session.expires_at).toLocaleString("ko-KR")}까지
            </p>
            {restroom?.entrance_instructions && (
              <p className="mt-2 rounded-lg bg-white/80 p-2 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                출입 안내: {restroom.entrance_instructions}
              </p>
            )}
          </div>
        ) : (
          <div
            data-testid="staff-ticket-inactive"
            className="rounded-xl bg-slate-100 p-4 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300"
          >
            <p className="font-bold">현재 유효한 출입 자격이 없습니다.</p>
            <p className="mt-1">{eligibility.reasonLabel}</p>
          </div>
        )}
      </section>
    );
  }

  // Case B: Doorlock PIN restroom
  return (
    <section
      data-testid="pin-reveal-panel"
      aria-label="도어락 비밀번호 확인"
      className="rounded-2xl border border-purple-200 bg-white p-5 shadow-sm dark:border-purple-900/60 dark:bg-slate-900"
    >
      <div className="flex items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-bold text-slate-900 dark:text-white">
          🔐 도어락 비밀번호 (PIN) 확인
        </h2>
        <span className="rounded-md bg-purple-100 px-2 py-0.5 text-[11px] font-bold text-purple-800 dark:bg-purple-950/70 dark:text-purple-300">
          보안 열람
        </span>
      </div>

      {/* 보안 안내 문구 */}
      <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-400 mb-4">
        도어락 비밀번호는 보안을 위해 자동으로 표시되지 않으며, 화장실 앞 도착 후{" "}
        <strong className="text-slate-800 dark:text-slate-200">
          수동 공개 버튼
        </strong>
        을 누를 때만 일시적으로 표시됩니다. 화면을 벗어나거나 새로고침하면 즉시
        사라집니다.
      </p>

      {/* 1. 자격 미충족 상태 (결제 미완료, 만료, 취소/환불 등) */}
      {!eligibility.eligible && !pinError && (
        <div
          role="status"
          data-testid="pin-ineligible-banner"
          data-reason-code={eligibility.reasonCode}
          className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <p className="font-bold text-sm mb-1">
            {eligibility.reasonCode === "PAYMENT_REQUIRED"
              ? "🔒 결제 승인 후 확인 가능"
              : eligibility.reasonCode === "EXPIRED"
              ? "⏰ 이용권 유효기한 만료"
              : eligibility.reasonCode === "CANCELED_OR_REFUNDED"
              ? "🚫 취소·환불된 이용권"
              : "🔒 현재 도어락 PIN을 조회할 수 없습니다"}
          </p>
          <p className="leading-relaxed">{eligibility.reasonLabel}</p>
        </div>
      )}

      {/* 2. 서버 PIN 조회 오류 / 상태별 안내 */}
      {pinError && (
        <div
          role="alert"
          data-testid="pin-reveal-error"
          data-error-code={pinError.code}
          data-error-category={pinError.category}
          className={`mb-4 rounded-xl border p-4 text-xs ${
            pinError.isRotatedConflict
              ? "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
              : "border-rose-300 bg-rose-50 text-rose-950 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-200"
          }`}
        >
          <p className="text-sm font-bold mb-1">
            {pinError.isRotatedConflict ? "🔄 " : "⚠️ "}
            {pinError.title}
          </p>
          <p className="leading-relaxed">{pinError.message}</p>

          {pinError.requiresLogin && (
            <div className="mt-3">
              <Link
                href={`/login?returnTo=${encodeURIComponent(
                  `/my/access/${session.id}`
                )}&reason=login_required`}
                data-testid="pin-error-login-link"
                className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-purple-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-purple-700"
              >
                다시 로그인하기
              </Link>
            </div>
          )}
        </div>
      )}

      {/* 3. PIN 표시 영역 (조회 성공 시에만 일시 렌더링, 오류 발생 시 즉시 비노출) */}
      {revealedPinState && !pinError && (
        <div
          data-testid="pin-revealed-box"
          className="mb-4 rounded-2xl border-2 border-purple-500 bg-purple-50/80 p-5 text-center shadow-xs dark:border-purple-500 dark:bg-purple-950/50"
        >
          <p className="text-xs font-bold text-purple-800 dark:text-purple-300">
            도어락 비밀번호 (버전 v{revealedPinState.codeVersion})
          </p>
          <div
            data-testid="revealed-pin-value"
            aria-live="polite"
            className="my-3 select-all rounded-xl bg-white py-3.5 px-4 font-mono text-3xl font-extrabold tracking-[0.25em] text-slate-900 shadow-inner border border-purple-200 dark:bg-slate-900 dark:text-white dark:border-purple-800"
          >
            {revealedPinState.pin}
          </div>
          <p className="text-[11px] text-slate-600 dark:text-slate-400">
            유효기한:{" "}
            {new Date(revealedPinState.expiresAt).toLocaleString("ko-KR")}까지
          </p>
          <p className="mt-1 text-[11px] font-medium text-rose-700 dark:text-rose-300">
            ※ 타인에게 공유하지 마세요. 페이지를 이동하거나 새로고침하면 다시 숨겨집니다.
          </p>

          <div className="mt-3 flex flex-col sm:flex-row gap-2">
            <button
              type="button"
              onClick={clearVolatilePin}
              data-testid="hide-pin-btn"
              className="flex min-h-[44px] flex-1 items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              🙈 PIN 숨기기
            </button>
            <button
              type="button"
              onClick={handleRevealPin}
              disabled={isLoading}
              data-testid="refresh-pin-btn"
              className="flex min-h-[44px] flex-1 items-center justify-center rounded-xl bg-purple-600 px-4 py-2 text-xs font-bold text-white hover:bg-purple-700 disabled:opacity-50"
            >
              {isLoading ? "조회 중..." : "🔄 최신 PIN 다시 확인"}
            </button>
          </div>
        </div>
      )}

      {/* 4. 수동 PIN 공개 / 재조회 버튼 */}
      {!revealedPinState && (eligibility.eligible || pinError?.canRetry) && (
        <button
          type="button"
          onClick={handleRevealPin}
          disabled={isLoading}
          data-testid={
            pinError?.isRotatedConflict
              ? "retry-rotated-pin-btn"
              : "reveal-pin-btn"
          }
          className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-purple-600 px-4 py-3 text-sm font-bold text-white shadow-md hover:bg-purple-700 active:scale-[0.99] transition disabled:opacity-50"
        >
          {isLoading ? (
            <>
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              <span>도어락 PIN 보안 확인 중...</span>
            </>
          ) : pinError?.isRotatedConflict ? (
            <span>🔄 최신 PIN 다시 조회하기</span>
          ) : pinError?.canRetry ? (
            <span>🔄 도어락 PIN 다시 조회하기</span>
          ) : (
            <span>🔐 도어락 PIN 확인하기</span>
          )}
        </button>
      )}

      {/* 5. 직원 제시 및 현장 출입 안내 */}
      <div
        data-testid="staff-guidance-box"
        className="mt-4 rounded-xl bg-slate-50 p-3.5 text-xs text-slate-700 dark:bg-slate-800/60 dark:text-slate-300 space-y-1.5"
      >
        <p className="font-bold text-slate-900 dark:text-white">
          💁 매장 직원 제시 및 현장 안내
        </p>
        <p className="leading-relaxed text-[11px]">
          도어락 입력이 어렵거나 매장 직원이 이용권 확인을 요청할 경우, 이 화면의{" "}
          <strong>
            이용권 확인번호(#{verificationTicketCode}) 및 결제 승인 상태
          </strong>
          를 직원에게 보여주세요.
        </p>
        {restroom?.entrance_instructions && (
          <p className="text-[11px] font-medium text-purple-900 dark:text-purple-300 bg-purple-50/70 dark:bg-purple-950/40 p-2 rounded-lg">
            🚪 출입구 안내: {restroom.entrance_instructions}
          </p>
        )}
      </div>
    </section>
  );
}

