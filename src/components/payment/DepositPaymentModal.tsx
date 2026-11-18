"use client";

import React, { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { PublicRestroomDetail } from "@/lib/restrooms/types";
import { requestTossPayment } from "./toss-sdk";
import type { PaymentCheckoutState } from "./types";
import { useEventTracker } from "@/lib/events/hooks";
import { trackEventSafe } from "@/lib/events/client";

export interface DepositPaymentModalProps {
  readonly restroom: PublicRestroomDetail;
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly user: { id: string; email?: string | null; name?: string | null } | null;
  readonly defaultDepositAmount?: number;
  readonly customPaymentRequester?: (options: any) => Promise<void>;
}

export default function DepositPaymentModal({
  restroom,
  isOpen,
  onClose,
  user,
  defaultDepositAmount = 1000,
  customPaymentRequester,
}: DepositPaymentModalProps) {
  const router = useRouter();
  const [agreed, setAgreed] = useState<boolean>(false);
  const [checkoutState, setCheckoutState] = useState<PaymentCheckoutState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isSubmittingRef = useRef<boolean>(false);
  const idempotencyKeyRef = useRef<string>("");

  const { trackPaymentUnavailableShown } = useEventTracker();

  // Generate or reset idempotency key when modal opens
  useEffect(() => {
    if (isOpen) {
      setAgreed(false);
      setCheckoutState("idle");
      setErrorMessage(null);
      isSubmittingRef.current = false;
      // Client idempotency key unique per checkout attempt session
      idempotencyKeyRef.current = `hm_idem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

      trackEventSafe({
        eventName: "checkout_opened",
        context: {
          restroomId: restroom.id,
          businessId: restroom.business_id ?? null,
          pagePath: `/restrooms/${restroom.id}`,
          componentId: "deposit_payment_modal",
        },
        properties: {
          restroom_id: restroom.id,
          amount_krw: defaultDepositAmount,
        },
      });
    }
  }, [isOpen, restroom, defaultDepositAmount]);

  // Handle ESC key to close modal
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && checkoutState !== "creating_order" && checkoutState !== "redirecting") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, checkoutState, onClose]);

  if (!isOpen) return null;

  // Handle unauthenticated state
  if (!user) {
    const returnTo = `/restrooms/${restroom.id}`;
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="payment-login-title"
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
        onClick={onClose}
      >
        <div
          className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl dark:bg-slate-900 border border-slate-200 dark:border-slate-800"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
            <h3 id="payment-login-title" className="text-base font-bold text-slate-900 dark:text-white">
              🔒 로그인 필요
            </h3>
            <button
              type="button"
              onClick={onClose}
              data-testid="payment-modal-close-btn"
              className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
              aria-label="닫기"
            >
              ✕
            </button>
          </div>

          <div className="py-4 text-sm text-slate-600 dark:text-slate-300">
            <p className="font-semibold text-slate-800 dark:text-slate-100">
              안심 제휴 화장실 이용권 발급 및 보증금 결제를 위해 로그인이 필요합니다.
            </p>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              로그인 후 화장실 상세 페이지로 다시 돌아옵니다.
            </p>
          </div>

          <div className="mt-2 flex flex-col gap-2">
            <button
              type="button"
              onClick={() => router.push(`/login?returnTo=${encodeURIComponent(returnTo)}`)}
              data-testid="payment-login-redirect-btn"
              className="flex min-h-[48px] w-full items-center justify-center rounded-xl bg-purple-600 px-4 py-3 text-sm font-bold text-white shadow-md hover:bg-purple-700 active:scale-[0.99] transition"
            >
              로그인하러 가기
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex min-h-[44px] w-full items-center justify-center rounded-xl bg-slate-100 px-4 py-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300"
            >
              취소
            </button>
          </div>
        </div>
      </div>
    );
  }

  const handleStartCheckout = async () => {
    if (isSubmittingRef.current || checkoutState !== "idle") return;
    if (!agreed) {
      setErrorMessage("이용 및 환급 안내 약관에 동의해주세요.");
      return;
    }

    isSubmittingRef.current = true;
    setCheckoutState("creating_order");
    setErrorMessage(null);

    try {
      // 1. Create order on server
      const orderRes = await fetch("/api/v1/payments/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          restroomId: restroom.id,
          idempotencyKey: idempotencyKeyRef.current,
        }),
      });

      const orderData = await orderRes.json();

      if (!orderRes.ok || !orderData.ok) {
        const errorMsg =
          orderData?.error?.message || "주문 생성에 실패했습니다. 잠시 후 다시 시도해주세요.";
        const errorCode = orderData?.error?.code || "ORDER_CREATE_FAILED";

        if (errorCode === "PAYMENT_MODE_DISABLED" || errorCode === "TOSS_CONFIG_REQUIRED") {
          trackPaymentUnavailableShown({
            restroom,
            reason: errorCode,
          });
        }

        setErrorMessage(errorMsg);
        setCheckoutState("error");
        isSubmittingRef.current = false;
        return;
      }

      const { orderId, amount, clientKey } = orderData.data;

      // Validate server returned amount strictly (no client-side fallback)
      const serverAmount = Number(amount);
      if (!Number.isInteger(serverAmount) || serverAmount <= 0) {
        throw new Error("서버가 반환한 결제 금액 정보가 유효하지 않습니다.");
      }

      // 2. Client-side SDK request
      setCheckoutState("loading_sdk");

      const resolvedClientKey =
        clientKey || process.env.NEXT_PUBLIC_TOSS_TEST_CLIENT_KEY?.trim() || "";

      if (!resolvedClientKey) {
        setErrorMessage("토스페이먼츠 연동 설정이 필요합니다. 관리자에게 문의하세요.");
        setCheckoutState("error");
        isSubmittingRef.current = false;
        return;
      }

      setCheckoutState("requesting_payment");

      const checkoutOptions = {
        clientKey: resolvedClientKey,
        orderId,
        orderName: `${restroom.name} 테스트 이용 보증금`,
        amount: serverAmount,
        customerKey: user.id,
        customerEmail: user.email || undefined,
        customerName: user.name || "테스트고객",
        successUrl: `${window.location.origin}/payment/success`,
        failUrl: `${window.location.origin}/payment/fail`,
      };

      if (customPaymentRequester) {
        await customPaymentRequester(checkoutOptions);
      } else {
        await requestTossPayment(checkoutOptions);
      }

      setCheckoutState("redirecting");
    } catch (err: unknown) {
      console.error("[DepositPaymentModal] Checkout error:", err);
      const userMessage =
        err instanceof Error ? err.message : "결제창 호출 중 오류가 발생했습니다.";
      setErrorMessage(userMessage);
      setCheckoutState("error");
      isSubmittingRef.current = false;
    }
  };

  const isBusy =
    checkoutState === "creating_order" ||
    checkoutState === "loading_sdk" ||
    checkoutState === "requesting_payment" ||
    checkoutState === "redirecting";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="payment-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
      onClick={() => {
        if (!isBusy) onClose();
      }}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl dark:bg-slate-900 border border-slate-200 dark:border-slate-800 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 모달 헤더 */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <span className="text-xl">💳</span>
            <h3 id="payment-modal-title" className="text-base font-bold text-slate-900 dark:text-white">
              제휴 화장실 이용 보증금 결제
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isBusy}
            data-testid="payment-modal-close-btn"
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-50 dark:hover:bg-slate-800"
            aria-label="닫기"
          >
            ✕
          </button>
        </div>

        {/* 테스트 모드 강조 배너 */}
        <div className="mt-3 rounded-xl bg-amber-50 p-3 text-xs text-amber-900 border border-amber-200/80 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-900/60">
          <p className="font-bold flex items-center gap-1.5">
            <span>⚠️</span>
            <span>테스트 결제 · 실제 돈은 청구되지 않음</span>
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-amber-800 dark:text-amber-300">
            본 결제는 개발 및 QA 테스트 모드로 진행되며 토스페이먼츠 테스트 환경에서 실제 카드 대금이 청구되지 않습니다.
          </p>
        </div>

        {/* 결제 대상 및 금액 */}
        <div className="mt-4 rounded-xl bg-slate-50 p-4 dark:bg-slate-800/50 space-y-2 text-xs">
          <div className="flex justify-between items-center text-slate-600 dark:text-slate-400">
            <span>이용 화장실</span>
            <span className="font-bold text-slate-900 dark:text-slate-100">{restroom.name}</span>
          </div>
          {restroom.business?.name && (
            <div className="flex justify-between items-center text-slate-600 dark:text-slate-400">
              <span>제휴 매장</span>
              <span className="font-semibold text-slate-800 dark:text-slate-200">
                {restroom.business.name}
              </span>
            </div>
          )}
          <div className="flex justify-between items-center pt-2 border-t border-slate-200/70 dark:border-slate-700/70">
            <span className="font-medium text-slate-700 dark:text-slate-300">보증금 결제 금액</span>
            <span className="text-base font-extrabold text-purple-600 dark:text-purple-400" data-testid="deposit-amount-display">
              {defaultDepositAmount.toLocaleString()}원
            </span>
          </div>
        </div>

        {/* 환급 및 PIN 규정 안내 */}
        <div className="mt-4 rounded-xl border border-purple-100 bg-purple-50/60 p-3.5 text-xs text-purple-950 dark:border-purple-900/40 dark:bg-purple-950/30 dark:text-purple-200">
          <p className="font-bold mb-1.5 flex items-center gap-1">
            <span>📋</span>
            <span>보증금 및 이용권 규정</span>
          </p>
          <ul className="list-disc pl-4 space-y-1 text-[11px] leading-relaxed text-purple-900 dark:text-purple-300">
            <li>
              <strong>영수증 환급 조건:</strong> 제휴 매장 실제 이용(구매) 영수증 사진을 제출한 후, 관리자 수동 심사를 거쳐 승인 완료 시에만 보증금 전액이 환급(테스트 결제 취소)됩니다.
            </li>
            <li>
              <strong>자동 환급 불가:</strong> OCR 자동 승인이 없으며, 영수증 미제출·기한 초과·타 매장 영수증 또는 심사 반려 시 보증금이 자동 환급되지 않습니다.
            </li>
            <li>
              <strong>환급 신청 기한:</strong> 이용권 생성 시점부터 24시간 이내 (테스트 기본값)
            </li>
            <li>
              <strong>도어락 비밀번호:</strong> 결제 승인 완료 후에만 안전하게 공개되며 현재 화면에는 노출되지 않습니다.
            </li>
          </ul>
        </div>

        {/* 오류 메시지 영역 */}
        {errorMessage && (
          <div
            data-testid="payment-modal-error"
            className="mt-3 rounded-xl bg-red-50 p-3 text-xs text-red-700 border border-red-200 dark:bg-red-950/50 dark:text-red-300 dark:border-red-900"
          >
            ⚠️ {errorMessage}
          </div>
        )}

        {/* 약관 동의 체크박스 */}
        <div className="mt-4 flex items-start gap-2.5">
          <input
            type="checkbox"
            id="deposit-agreement-check"
            data-testid="deposit-agreement-checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            disabled={isBusy}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-purple-600 focus:ring-purple-500 disabled:opacity-50"
          />
          <label
            htmlFor="deposit-agreement-check"
            className="text-xs text-slate-700 dark:text-slate-300 select-none cursor-pointer"
          >
            위 테스트 보증금 결제 및 영수증 수동 심사 환급 조건에 동의합니다. (실제 청구 없음)
          </label>
        </div>

        {/* 버튼 액션 */}
        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            data-testid="submit-checkout-btn"
            onClick={handleStartCheckout}
            disabled={!agreed || isBusy}
            className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-purple-600 px-4 py-3 text-sm font-bold text-white shadow-md hover:bg-purple-700 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {isBusy ? (
              <>
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                <span>
                  {checkoutState === "creating_order"
                    ? "주문 생성 중..."
                    : checkoutState === "loading_sdk"
                    ? "토스 SDK 준비 중..."
                    : "토스 결제창 호출 중..."}
                </span>
              </>
            ) : (
              <span>{defaultDepositAmount.toLocaleString()}원 테스트 결제 진행</span>
            )}
          </button>

          <button
            type="button"
            onClick={onClose}
            disabled={isBusy}
            data-testid="cancel-checkout-btn"
            className="flex min-h-[44px] w-full items-center justify-center rounded-xl bg-slate-100 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-200 disabled:opacity-50 dark:bg-slate-800 dark:text-slate-300"
          >
            취소
          </button>
        </div>
      </div>
    </div>
  );
}
