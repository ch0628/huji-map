"use client";

import React, { useState, useEffect } from "react";
import type { PublicRestroomDetail } from "@/lib/restrooms/types";
import DepositPaymentModal from "./DepositPaymentModal";
import { useEventTracker } from "@/lib/events/hooks";

export interface DepositPaymentButtonProps {
  readonly restroom: PublicRestroomDetail;
  readonly defaultAmount?: number;
  readonly initialUser?: { id: string; email?: string | null; name?: string | null } | null;
  readonly customPaymentRequester?: (options: any) => Promise<void>;
}

export default function DepositPaymentButton({
  restroom,
  defaultAmount = 1000,
  initialUser = null,
  customPaymentRequester,
}: DepositPaymentButtonProps) {
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [currentUser, setCurrentUser] = useState<{ id: string; email?: string | null; name?: string | null } | null>(
    initialUser
  );
  const [authChecked, setAuthChecked] = useState<boolean>(Boolean(initialUser));

  const { trackPaymentButtonClicked } = useEventTracker();

  // If initialUser was not passed, probe current session
  useEffect(() => {
    if (initialUser) {
      setCurrentUser(initialUser);
      setAuthChecked(true);
      return;
    }

    let isMounted = true;
    fetch("/api/v1/auth/session")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!isMounted) return;
        if (data && data.authenticated && data.user) {
          setCurrentUser({
            id: data.user.id,
            email: data.user.email,
            name: data.user.name,
          });
        } else {
          setCurrentUser(null);
        }
        setAuthChecked(true);
      })
      .catch(() => {
        if (isMounted) {
          setCurrentUser(null);
          setAuthChecked(true);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [initialUser]);

  // NEVER render payment button for public restrooms!
  if (restroom.type === "public") {
    return null;
  }

  const handleClick = () => {
    trackPaymentButtonClicked({
      restroom,
      depositAmountKrw: defaultAmount,
    });
    setIsModalOpen(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        data-testid="detail-partner-payment-btn"
        className="flex min-h-[48px] w-full flex-1 items-center justify-center gap-2 rounded-xl bg-purple-600 px-4 py-3 text-sm font-bold text-white shadow-md hover:bg-purple-700 active:scale-[0.99] transition"
      >
        <span>💳</span>
        <span>안심 제휴 보증금 결제 ({defaultAmount.toLocaleString()}원)</span>
      </button>

      {isModalOpen && (
        <DepositPaymentModal
          restroom={restroom}
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          user={currentUser}
          defaultDepositAmount={defaultAmount}
          customPaymentRequester={customPaymentRequester}
        />
      )}
    </>
  );
}

