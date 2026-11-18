import React, { Suspense } from "react";
import AppShell from "@/components/layout/AppShell";
import PaymentFailClient from "./PaymentFailClient";

export const metadata = {
  title: "결제 실패/취소 | 휴지맵",
};

export default function PaymentFailPage() {
  return (
    <AppShell headerTitle="결제 결과">
      <Suspense
        fallback={
          <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
            <div className="h-8 w-8 animate-spin rounded-full border-3 border-purple-600 border-t-transparent" />
            <p className="mt-3 text-xs text-slate-500">결제 처리 결과를 확인하는 중입니다...</p>
          </div>
        }
      >
        <PaymentFailClient />
      </Suspense>
    </AppShell>
  );
}

