"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import type { PublicPaymentOrder } from "@/lib/payments/types";
import type { PublicAccessSession } from "@/lib/access/types";
import type { PaymentConfirmState, PaymentErrorDetails } from "@/components/payment/types";

export interface PaymentSuccessClientProps {
  readonly initialUser?: { id: string; email?: string | null } | null;
  readonly injectedConfirmRequester?: (params: {
    orderId: string;
    paymentKey: string;
    amount: number;
  }) => Promise<any>;
}

export default function PaymentSuccessClient({
  initialUser = null,
  injectedConfirmRequester,
}: PaymentSuccessClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const initialPaymentKey = searchParams.get("paymentKey")?.trim() || "";
  const initialOrderId = searchParams.get("orderId")?.trim() || "";
  const initialAmountStr = searchParams.get("amount")?.trim() || "";

  // Preserved in memory so retry / recheck works even after paymentKey is sanitized from URL
  const paymentKeyRef = useRef<string>(initialPaymentKey);
  const orderIdRef = useRef<string>(initialOrderId);
  const amountStrRef = useRef<string>(initialAmountStr);

  const [confirmState, setConfirmState] = useState<PaymentConfirmState>("idle");
  const [errorDetails, setErrorDetails] = useState<PaymentErrorDetails | null>(null);
  const [approvedOrder, setApprovedOrder] = useState<PublicPaymentOrder | null>(null);
  const [accessSession, setAccessSession] = useState<PublicAccessSession | null>(null);
  const [isCheckingStatus, setIsCheckingStatus] = useState<boolean>(false);

  // Prevent double invocation in React StrictMode
  const confirmAttemptedRef = useRef<boolean>(false);

  /**
   * Sanitizes the browser URL by removing sensitive paymentKey.
   * If preserveOrderId is true (failed/uncertain), preserves orderId and amount for status lookup.
   * If preserveOrderId is false (confirmed), cleans entire query string to pathname.
   */
  const sanitizeUrl = useCallback((preserveOrderId = false) => {
    if (typeof window === "undefined" || !window.history?.replaceState) return;
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has("paymentKey")) {
        url.searchParams.delete("paymentKey");
        if (preserveOrderId && orderIdRef.current) {
          window.history.replaceState({}, "", url.pathname + url.search);
        } else {
          window.history.replaceState({}, "", window.location.pathname);
        }
      } else if (!preserveOrderId && window.location.search) {
        window.history.replaceState({}, "", window.location.pathname);
      }
    } catch (e) {
      console.error("[PaymentSuccessClient] URL sanitization error:", e);
    }
  }, []);

  /**
   * Reconciles order status via GET /api/v1/payments/orders/:id
   * Used when state is uncertain or on manual retry
   */
  const handleRecheckStatus = useCallback(async () => {
    const curOrderId = orderIdRef.current;
    if (!curOrderId || isCheckingStatus) return;
    setIsCheckingStatus(true);

    try {
      const res = await fetch(`/api/v1/payments/orders/${encodeURIComponent(curOrderId)}`);
      const data = await res.json();

      if (res.ok && data.ok && data.data) {
        const order = data.data.order as PublicPaymentOrder;
        const session = data.data.accessSession as PublicAccessSession;

        if (order.status === "approved") {
          setApprovedOrder(order);
          setAccessSession(
            session || {
              id: order.access_session_id,
              user_id: order.user_id,
              restroom_id: "",
              policy_id: "",
              status: "authorized",
              access_method_snapshot: "pin",
              authorized_at: order.approved_at,
              code_revealed_at: null,
              expires_at: new Date(Date.now() + 86400000).toISOString(),
              created_at: order.created_at,
              updated_at: order.updated_at,
            }
          );
          setConfirmState("confirmed");
          setErrorDetails(null);
          sanitizeUrl(false);
        } else if (order.status === "failed" || order.status === "canceled") {
          setConfirmState("failed");
          setErrorDetails({
            code: `ORDER_${order.status.toUpperCase()}`,
            message: `해당 주문이 종료되었습니다 (${order.status}).`,
            isRetryable: false,
          });
          sanitizeUrl(true);
        } else {
          // Still pending/created, try confirming again if paymentKey is present
          if (paymentKeyRef.current) {
            await executeConfirm();
          } else {
            setConfirmState("uncertain");
            setErrorDetails({
              code: "ORDER_PENDING",
              message: "주문 승인 처리 대기 중입니다. 잠시 후 다시 확인해주세요.",
              isRetryable: true,
              isUncertain: true,
            });
            sanitizeUrl(true);
          }
        }
      } else {
        if (paymentKeyRef.current) {
          await executeConfirm();
        } else {
          sanitizeUrl(true);
        }
      }
    } catch (e) {
      console.error("[PaymentSuccessClient] Recheck error:", e);
      sanitizeUrl(true);
    } finally {
      setIsCheckingStatus(false);
    }
  }, [isCheckingStatus, sanitizeUrl]);

  const executeConfirm = useCallback(async () => {
    const curPaymentKey = paymentKeyRef.current;
    const curOrderId = orderIdRef.current;
    const curAmountStr = amountStrRef.current;

    // 1. If paymentKey is missing but orderId exists (e.g. page reload or already sanitized),
    // attempt reconciliation first via handleRecheckStatus
    if (!curPaymentKey && curOrderId) {
      await handleRecheckStatus();
      return;
    }

    // 2. Validate required URL parameters
    if (!curPaymentKey || !curOrderId || !curAmountStr) {
      sanitizeUrl(false);
      setConfirmState("failed");
      setErrorDetails({
        code: "MISSING_PARAMS",
        message: "결제 승인에 필요한 필수 파라미터(orderId, paymentKey, amount)가 누락되었습니다.",
        isRetryable: false,
      });
      return;
    }

    const amount = Number(curAmountStr);
    if (!Number.isInteger(amount) || amount <= 0) {
      sanitizeUrl(false);
      setConfirmState("failed");
      setErrorDetails({
        code: "INVALID_AMOUNT",
        message: "결제 승인 금액이 유효하지 않습니다.",
        isRetryable: false,
      });
      return;
    }

    setConfirmState("confirming");
    setErrorDetails(null);

    try {
      let resData;
      if (injectedConfirmRequester) {
        resData = await injectedConfirmRequester({
          orderId: curOrderId,
          paymentKey: curPaymentKey,
          amount,
        });
      } else {
        const response = await fetch("/api/v1/payments/confirm", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            orderId: curOrderId,
            paymentKey: curPaymentKey,
            amount,
          }),
        });

        resData = await response.json();

        if (response.status === 401) {
          setConfirmState("failed");
          setErrorDetails({
            code: "UNAUTHORIZED",
            message: "결제 승인을 완료하려면 로그인이 필요합니다.",
            isRetryable: false,
          });
          sanitizeUrl(true);
          return;
        }

        if (!response.ok || !resData.ok) {
          const errCode = resData?.error?.code || "CONFIRM_FAILED";
          const errMsg = resData?.error?.message || "결제 승인 처리에 실패했습니다.";
          const isTimeoutOrProcessing =
            errCode === "PAYMENT_PROCESSING" ||
            response.status === 504 ||
            response.status === 409;

          setConfirmState(isTimeoutOrProcessing ? "uncertain" : "failed");
          setErrorDetails({
            code: errCode,
            message: errMsg,
            isRetryable: true,
            isUncertain: isTimeoutOrProcessing,
          });
          sanitizeUrl(true);
          return;
        }
      }

      if (resData.ok && resData.data) {
        setApprovedOrder(resData.data.order);
        setAccessSession(resData.data.accessSession);
        setConfirmState("confirmed");
        // Clear entire query string on successful confirmation
        sanitizeUrl(false);
      } else {
        setConfirmState("failed");
        setErrorDetails({
          code: "UNKNOWN_RESPONSE",
          message: "서버로부터 비정상적인 응답을 수신했습니다.",
          isRetryable: true,
        });
        sanitizeUrl(true);
      }
    } catch (err: unknown) {
      console.error("[PaymentSuccessClient] Confirm network error:", err);
      setConfirmState("uncertain");
      setErrorDetails({
        code: "NETWORK_TIMEOUT",
        message:
          "네트워크 연결이 지연되어 승인 상태를 확인하지 못했습니다. 아래 버튼으로 주문 상태를 다시 확인하세요.",
        isRetryable: true,
        isUncertain: true,
      });
      sanitizeUrl(true);
    }
  }, [injectedConfirmRequester, sanitizeUrl, handleRecheckStatus]);

  useEffect(() => {
    if (confirmAttemptedRef.current) return;
    confirmAttemptedRef.current = true;
    executeConfirm();
  }, [executeConfirm]);

  return (
    <div
      data-testid="payment-success-client"
      className="flex flex-col gap-5 pb-10 max-w-md mx-auto w-full"
    >
      {/* 1. Confirming state */}
      {confirmState === "confirming" && (
        <div
          data-testid="payment-confirming-view"
          className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900"
        >
          <div className="mb-4 inline-block h-8 w-8 animate-spin rounded-full border-3 border-purple-600 border-t-transparent" />
          <h2 className="text-base font-bold text-slate-800 dark:text-slate-100">
            결제 승인 확인 중입니다
          </h2>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            토스페이먼츠 인증을 확인하고 안심 이용권을 활성화하고 있습니다. 잠시만 기다려주세요.
          </p>
        </div>
      )}

      {/* 2. Confirmed (Success) state */}
      {confirmState === "confirmed" && approvedOrder && accessSession && (
        <div
          data-testid="payment-confirmed-view"
          className="flex flex-col gap-4 rounded-2xl border border-emerald-200 bg-white p-6 shadow-sm dark:border-emerald-900/60 dark:bg-slate-900"
        >
          {/* 성공 헤더 */}
          <div className="text-center pb-3 border-b border-slate-100 dark:border-slate-800">
            <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-2xl dark:bg-emerald-950/80">
              🎉
            </div>
            <h1 className="text-lg font-bold text-slate-900 dark:text-white">
              보증금 결제 승인 완료
            </h1>
            <p className="mt-1 text-xs text-emerald-600 dark:text-emerald-400 font-semibold">
              화장실 이용권이 성공적으로 활성화되었습니다.
            </p>
          </div>

          {/* 테스트 모드 고지 */}
          <div className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900 border border-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-900/50">
            <span className="font-bold">⚠️ 테스트 결제 안내:</span> 실제 신용카드 대금은 청구되지 않으며 테스트 승인 완료되었습니다.
          </div>

          {/* 결제 및 이용권 정보 */}
          <div className="rounded-xl bg-slate-50 p-4 dark:bg-slate-800/60 space-y-2.5 text-xs">
            <div className="flex justify-between items-center text-slate-600 dark:text-slate-400">
              <span>주문 번호</span>
              <span className="font-mono text-[11px] text-slate-800 dark:text-slate-200" data-testid="confirmed-order-id">
                {approvedOrder.order_id}
              </span>
            </div>

            <div className="flex justify-between items-center text-slate-600 dark:text-slate-400">
              <span>결제 금액</span>
              <span className="font-bold text-slate-900 dark:text-slate-100" data-testid="confirmed-amount">
                {approvedOrder.amount_krw.toLocaleString()}원 (테스트)
              </span>
            </div>

            <div className="flex justify-between items-center text-slate-600 dark:text-slate-400">
              <span>이용권 상태</span>
              <span
                data-testid="confirmed-session-status"
                className="inline-flex items-center rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-800 dark:bg-emerald-950/80 dark:text-emerald-300"
              >
                ✓ {accessSession.status === "authorized" ? "이용권 활성화 (authorized)" : accessSession.status}
              </span>
            </div>

            <div className="flex justify-between items-center text-slate-600 dark:text-slate-400">
              <span>이용권 만료 일시</span>
              <span className="text-[11px] font-medium text-slate-800 dark:text-slate-200">
                {new Date(accessSession.expires_at).toLocaleString("ko-KR")}
              </span>
            </div>
          </div>

          {/* 도어락 PIN 안내 (TASK 23~25 연계) */}
          <div className="rounded-xl border border-purple-200 bg-purple-50 p-3.5 text-xs text-purple-900 dark:border-purple-900/50 dark:bg-purple-950/40 dark:text-purple-200">
            <p className="font-bold mb-1">🔐 도어락 비밀번호 안내</p>
            <p className="leading-relaxed text-[11px] text-purple-800 dark:text-purple-300">
              도어락 비밀번호 복호화 및 열람 기능은 후속 단계(TASK 23~25)에서 제공됩니다.
              현재 비밀번호는 서버에 암호화되어 안전하게 보호되고 있습니다.
            </p>
          </div>

          {/* 보증금 환급 심사 안내 */}
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-xs text-slate-800 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-200">
            <p className="font-bold mb-1">🧾 보증금 환급 심사 안내</p>
            <p className="leading-relaxed text-[11px] text-slate-600 dark:text-slate-300">
              제휴 매장 실제 이용(구매) 영수증 사진을 제출하시면 관리자 수동 검수를 거쳐 승인 완료 시 보증금이 전액 환급(테스트 결제 취소)됩니다. (OCR 자동 승인 없음, 심사 반려 시 미환급)
            </p>
          </div>

          {/* 액션 버튼 */}
          <div className="mt-2 flex flex-col gap-2 pt-2">
            <Link
              href={`/restrooms/${accessSession.restroom_id}`}
              className="flex min-h-[48px] w-full items-center justify-center rounded-xl bg-purple-600 px-4 py-3 text-sm font-bold text-white shadow-md hover:bg-purple-700 active:scale-[0.99] transition text-center"
            >
              화장실 상세 정보로 이동
            </Link>
            <Link
              href="/map"
              className="flex min-h-[44px] w-full items-center justify-center rounded-xl bg-slate-100 px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 text-center"
            >
              지도로 돌아가기
            </Link>
          </div>
        </div>
      )}

      {/* 3. Uncertain / Timeout state */}
      {confirmState === "uncertain" && (
        <div
          data-testid="payment-uncertain-view"
          className="rounded-2xl border border-amber-300 bg-white p-6 shadow-sm dark:border-amber-900/60 dark:bg-slate-900"
        >
          <div className="text-center pb-3 border-b border-slate-100 dark:border-slate-800">
            <div className="mx-auto mb-2 text-3xl">⏳</div>
            <h2 className="text-base font-bold text-slate-900 dark:text-white">
              결제 승인 처리 중 (상태 확인 필요)
            </h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              서버 또는 카드사 응답이 지연되고 있습니다. 결제가 실패한 것은 아닙니다.
            </p>
          </div>

          {errorDetails && (
            <p className="my-3 text-xs text-slate-600 dark:text-slate-300 leading-relaxed bg-slate-50 dark:bg-slate-800 p-3 rounded-xl">
              {errorDetails.message}
            </p>
          )}

          <div className="mt-4 flex flex-col gap-2">
            <button
              type="button"
              onClick={handleRecheckStatus}
              disabled={isCheckingStatus}
              data-testid="recheck-status-btn"
              className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-purple-600 px-4 py-3 text-sm font-bold text-white shadow-md hover:bg-purple-700 active:scale-[0.99] transition disabled:opacity-50"
            >
              {isCheckingStatus ? (
                <>
                  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  <span>상태 확인 중...</span>
                </>
              ) : (
                <span>결제 및 주문 상태 다시 확인</span>
              )}
            </button>
            <Link
              href="/map"
              className="flex min-h-[44px] w-full items-center justify-center rounded-xl bg-slate-100 px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 text-center"
            >
              지도로 돌아가기
            </Link>
          </div>
        </div>
      )}

      {/* 4. Failed state */}
      {confirmState === "failed" && (
        <div
          data-testid="payment-failed-view"
          className="rounded-2xl border border-red-200 bg-white p-6 shadow-sm dark:border-red-900/60 dark:bg-slate-900"
        >
          <div className="text-center pb-3 border-b border-slate-100 dark:border-slate-800">
            <div className="mx-auto mb-2 text-3xl">❌</div>
            <h2 className="text-base font-bold text-slate-900 dark:text-white">
              결제 승인 실패
            </h2>
            <p className="mt-1 text-xs text-red-600 dark:text-red-400 font-semibold">
              결제가 승인되지 않아 이용권이 활성화되지 않았습니다.
            </p>
          </div>

          <div className="my-4 rounded-xl bg-red-50 p-3 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300 border border-red-200 dark:border-red-900/50">
            <p className="font-bold mb-1">오류 내용:</p>
            <p className="leading-relaxed">{errorDetails?.message || "승인 요청 중 오류가 발생했습니다."}</p>
          </div>

          {errorDetails?.code === "UNAUTHORIZED" ? (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() =>
                  router.push(
                    `/login?returnTo=${encodeURIComponent(
                      `/payment/success?paymentKey=${paymentKeyRef.current}&orderId=${orderIdRef.current}&amount=${amountStrRef.current}`
                    )}`
                  )
                }
                className="flex min-h-[48px] w-full items-center justify-center rounded-xl bg-purple-600 px-4 py-3 text-sm font-bold text-white shadow-md hover:bg-purple-700 text-center"
              >
                로그인 후 승인 완료하기
              </button>
              <Link
                href="/map"
                className="flex min-h-[44px] w-full items-center justify-center rounded-xl bg-slate-100 px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 text-center"
              >
                지도로 돌아가기
              </Link>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {errorDetails?.isRetryable && (
                <button
                  type="button"
                  onClick={executeConfirm}
                  className="flex min-h-[48px] w-full items-center justify-center rounded-xl bg-purple-600 px-4 py-3 text-sm font-bold text-white shadow-md hover:bg-purple-700 active:scale-[0.99] transition text-center"
                >
                  승인 다시 시도
                </button>
              )}
              <Link
                href="/map"
                className="flex min-h-[44px] w-full items-center justify-center rounded-xl bg-slate-100 px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 text-center"
              >
                지도로 돌아가기
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

