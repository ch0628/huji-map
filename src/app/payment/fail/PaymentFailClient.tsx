"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { PublicPaymentOrder } from "@/lib/payments/types";

export default function PaymentFailClient() {
  const searchParams = useSearchParams();

  const code = searchParams.get("code")?.trim() || "UNKNOWN_ERROR";
  const message = searchParams.get("message")?.trim() || "결제 처리가 완료되지 않았습니다.";
  const orderId = searchParams.get("orderId")?.trim() || "";

  const [isCheckingOrder, setIsCheckingOrder] = useState<boolean>(false);
  const [recheckedOrder, setRecheckedOrder] = useState<PublicPaymentOrder | null>(null);
  const [recheckMessage, setRecheckMessage] = useState<string | null>(null);

  const isUserCancel =
    code === "PAY_PROCESS_CANCELED" ||
    code === "USER_CANCEL" ||
    message.includes("사용자가 결제를 취소") ||
    message.includes("취소되었습니다");

  const handleCheckOrderStatus = async () => {
    if (!orderId || isCheckingOrder) return;
    setIsCheckingOrder(true);
    setRecheckMessage(null);

    try {
      const res = await fetch(`/api/v1/payments/orders/${encodeURIComponent(orderId)}`);
      const data = await res.json();

      if (res.ok && data.ok && data.data) {
        const order = data.data.order as PublicPaymentOrder;
        setRecheckedOrder(order);

        if (order.status === "approved") {
          setRecheckMessage("⚠️ 해당 주문은 이미 서버에서 승인 완료되었습니다. 이용권을 확인하세요.");
        } else if (order.status === "failed") {
          setRecheckMessage("확인 결과: 서버에 결제 실패(failed) 상태로 정상 기록되어 있습니다.");
        } else if (order.status === "canceled") {
          setRecheckMessage("확인 결과: 서버에 결제 취소(canceled) 상태로 정상 기록되어 있습니다.");
        } else {
          setRecheckMessage(`확인 결과: 현재 주문 상태는 [${order.status}] 상태입니다.`);
        }
      } else {
        setRecheckMessage("주문 정보를 조회할 수 없습니다. (비로그인이거나 존재하지 않는 주문)");
      }
    } catch {
      setRecheckMessage("주문 조회 중 일시적인 네트워크 오류가 발생했습니다.");
    } finally {
      setIsCheckingOrder(false);
    }
  };

  return (
    <div
      data-testid="payment-fail-client"
      className="flex flex-col gap-5 pb-10 max-w-md mx-auto w-full"
    >
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        {/* 상단 아이콘 및 타이틀 */}
        <div className="text-center pb-4 border-b border-slate-100 dark:border-slate-800">
          <div className="mx-auto mb-2 text-4xl">
            {isUserCancel ? "↩️" : "⚠️"}
          </div>
          <h1 className="text-lg font-bold text-slate-900 dark:text-white" data-testid="fail-title">
            {isUserCancel ? "결제가 취소되었습니다" : "결제 승인 실패"}
          </h1>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {isUserCancel
              ? "결제창에서 사용자에 의해 결제가 취소되었습니다."
              : "결제 처리 중 오류가 발생했습니다."}
          </p>
        </div>

        {/* 테스트 모드 안전 안내 */}
        <div className="my-4 rounded-xl bg-slate-50 p-3.5 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
          <p className="font-semibold text-slate-800 dark:text-slate-200 mb-1">
            🛡️ 대금 청구 없음 안내
          </p>
          <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
            결제가 정상 완료되지 않았으므로 신용카드 대금이 청구되지 않았습니다. 테스트 모드 환경에서 안전하게 처리되었습니다.
          </p>
        </div>

        {/* 상세 실패 정보 */}
        <div className="rounded-xl border border-red-100 bg-red-50/60 p-3.5 text-xs text-red-800 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300 space-y-1">
          <div className="flex justify-between">
            <span className="font-bold">오류 코드:</span>
            <span className="font-mono text-[11px]" data-testid="fail-code">{code}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="font-bold">사유:</span>
            <span className="text-[11px] leading-relaxed" data-testid="fail-message">{message}</span>
          </div>
          {orderId && (
            <div className="flex justify-between pt-1 border-t border-red-200/50 dark:border-red-900/50">
              <span>주문 번호:</span>
              <span className="font-mono text-[11px]">{orderId}</span>
            </div>
          )}
        </div>

        {/* 서버 주문 상태 재확인 결과 */}
        {recheckMessage && (
          <div className="mt-3 rounded-xl bg-purple-50 p-3 text-xs text-purple-900 border border-purple-200 dark:bg-purple-950/50 dark:text-purple-200 dark:border-purple-900">
            {recheckMessage}
          </div>
        )}

        {/* 액션 버튼들 */}
        <div className="mt-6 flex flex-col gap-2.5">
          {orderId && (
            <button
              type="button"
              onClick={handleCheckOrderStatus}
              disabled={isCheckingOrder}
              data-testid="recheck-order-btn"
              className="flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-xl border border-purple-300 bg-purple-50 px-4 py-2.5 text-xs font-bold text-purple-700 hover:bg-purple-100 dark:border-purple-800 dark:bg-purple-950/60 dark:text-purple-300"
            >
              {isCheckingOrder ? "주문 상태 확인 중..." : "서버 주문 상태 확인하기"}
            </button>
          )}

          {recheckedOrder?.status === "approved" && (
            <Link
              href={`/payment/success?orderId=${encodeURIComponent(orderId)}`}
              className="flex min-h-[48px] w-full items-center justify-center rounded-xl bg-emerald-600 px-4 py-3 text-sm font-bold text-white shadow-md hover:bg-emerald-700 text-center"
            >
              승인된 이용권 화면으로 이동
            </Link>
          )}

          <Link
            href="/map"
            className="flex min-h-[48px] w-full items-center justify-center rounded-xl bg-purple-600 px-4 py-3 text-sm font-bold text-white shadow-md hover:bg-purple-700 active:scale-[0.99] transition text-center"
          >
            지도로 돌아가기
          </Link>
        </div>
      </div>
    </div>
  );
}

