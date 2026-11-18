import React, { Suspense } from "react";
import AppShell from "@/components/layout/AppShell";
import PaymentStartClient from "./PaymentStartClient";
import { createServerClientInstance } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "보증금 결제 시작 | 휴지맵",
};

export default async function PaymentStartPage() {
  let currentUser = null;
  try {
    const supabase = await createServerClientInstance();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      currentUser = {
        id: user.id,
        email: user.email,
      };
    }
  } catch (e) {
    console.error("[PaymentStartPage] Auth check error:", e);
  }

  return (
    <AppShell headerTitle="보증금 결제">
      <Suspense
        fallback={
          <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
            <div className="h-8 w-8 animate-spin rounded-full border-3 border-purple-600 border-t-transparent" />
            <p className="mt-3 text-xs text-slate-500">결제 정보를 불러오는 중입니다...</p>
          </div>
        }
      >
        <PaymentStartClient initialUser={currentUser} />
      </Suspense>
    </AppShell>
  );
}
