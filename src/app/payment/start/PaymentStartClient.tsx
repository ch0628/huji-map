"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import type { PublicRestroomDetail } from "@/lib/restrooms/types";
import DepositPaymentModal from "@/components/payment/DepositPaymentModal";

export interface PaymentStartClientProps {
  readonly initialUser?: { id: string; email?: string | null; name?: string | null } | null;
}

export default function PaymentStartClient({
  initialUser = null,
}: PaymentStartClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const restroomId = searchParams.get("restroomId")?.trim() || "";

  const [restroom, setRestroom] = useState<PublicRestroomDetail | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!restroomId) {
      setError("화장실 식별자(restroomId)가 지정되지 않았습니다.");
      setIsLoading(false);
      return;
    }

    let isMounted = true;
    fetch(`/api/v1/restrooms/${encodeURIComponent(restroomId)}`)
      .then((res) => res.json())
      .then((data) => {
        if (!isMounted) return;
        if (data.ok && data.data) {
          if (data.data.type !== "partner") {
            setError("공공 화장실은 무료 이용 대상이며 보증금 결제가 필요하지 않습니다.");
          } else {
            setRestroom(data.data);
          }
        } else {
          setError(data?.error?.message || "화장실 정보를 찾을 수 없습니다.");
        }
      })
      .catch(() => {
        if (isMounted) setError("화장실 정보를 조회하는 중 네트워크 오류가 발생했습니다.");
      })
      .finally(() => {
        if (isMounted) setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [restroomId]);

  if (isLoading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
        <div className="h-8 w-8 animate-spin rounded-full border-3 border-purple-600 border-t-transparent" />
        <p className="mt-3 text-xs text-slate-500">제휴 화장실 결제 정보를 확인하는 중입니다...</p>
      </div>
    );
  }

  if (error || !restroom) {
    return (
      <div className="rounded-2xl border border-red-200 bg-white p-6 shadow-sm dark:border-red-900/60 dark:bg-slate-900 text-center max-w-md mx-auto">
        <div className="mx-auto mb-2 text-3xl">⚠️</div>
        <h2 className="text-base font-bold text-slate-900 dark:text-white">결제 시작 불가</h2>
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error || "화장실 정보를 불러올 수 없습니다."}</p>
        <Link
          href="/map"
          className="mt-4 inline-flex min-h-[44px] items-center justify-center rounded-xl bg-purple-600 px-4 py-2.5 text-xs font-bold text-white shadow hover:bg-purple-700"
        >
          지도로 돌아가기
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 max-w-md mx-auto w-full">
      <DepositPaymentModal
        restroom={restroom}
        isOpen={true}
        onClose={() => router.push(`/restrooms/${restroom.id}`)}
        user={initialUser}
      />
    </div>
  );
}

