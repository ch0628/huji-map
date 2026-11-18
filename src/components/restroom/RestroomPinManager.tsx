"use client";

import React, { useState } from "react";
import type { AccessMethod } from "@/lib/restrooms/types";
import type { MerchantRestroomPinStatus } from "@/lib/restrooms/merchant-service";
import { setRestroomPinSchema } from "@/lib/access/crypto/types";

interface RestroomPinManagerProps {
  restroomId: string;
  accessMethod: AccessMethod;
  pinStatus?: MerchantRestroomPinStatus;
  onPinUpdated?: (nextStatus: MerchantRestroomPinStatus) => void;
}

const ACCESS_METHOD_LABELS: Record<AccessMethod, string> = {
  open: "상시 개방",
  ask_staff: "직원 문의",
  pin: "도어락 비밀번호 잠금",
};

export default function RestroomPinManager({
  restroomId,
  accessMethod,
  pinStatus,
  onPinUpdated,
}: RestroomPinManagerProps) {
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [showPin, setShowPin] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const hasActivePin = Boolean(pinStatus?.hasActivePin);
  const encryptionConfigured = pinStatus?.encryptionConfigured ?? true;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting || accessMethod !== "pin") return;

    setErrorMessage(null);
    setSuccessMessage(null);

    const parsed = setRestroomPinSchema.safeParse({ pin });
    if (!parsed.success) {
      setErrorMessage(
        parsed.error.issues[0]?.message || "올바른 PIN 형식을 입력해 주세요."
      );
      return;
    }

    if (parsed.data.pin !== pinConfirm.trim()) {
      setErrorMessage("입력한 비밀번호와 확인 비밀번호가 일치하지 않습니다.");
      return;
    }

    setIsSubmitting(true);
    const idempotencyKey = crypto.randomUUID();

    try {
      const res = await fetch(`/api/v1/merchant/restrooms/${restroomId}/pin`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({ pin: parsed.data.pin }),
      });

      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(
          data.error?.message || "도어락 비밀번호 저장에 실패했습니다."
        );
      }

      const nextStatus: MerchantRestroomPinStatus = {
        hasActivePin: true,
        codeVersion: data.codeVersion,
        updatedAt: data.updatedAt,
        encryptionConfigured: true,
      };

      setPin("");
      setPinConfirm("");
      setShowPin(false);
      setSuccessMessage(
        `도어락 비밀번호가 암호화되어 저장되었습니다. (버전 v${data.codeVersion})`
      );
      onPinUpdated?.(nextStatus);
    } catch (err: unknown) {
      setErrorMessage(
        err instanceof Error ? err.message : "PIN 저장 중 오류가 발생했습니다."
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section
      data-testid="restroom-pin-manager"
      className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-bold text-slate-900 dark:text-white">
            도어락 비밀번호(PIN) 관리
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            결제 승인된 이용자에게만 안전하게 공개되는 출입 비밀번호
          </p>
        </div>

        {accessMethod === "pin" && (
          <span
            data-testid="pin-status-badge"
            className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
              hasActivePin
                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
            }`}
          >
            {hasActivePin
              ? `등록됨 (v${pinStatus?.codeVersion ?? 1})`
              : "미등록"}
          </span>
        )}
      </div>

      {accessMethod !== "pin" ? (
        <div
          data-testid="pin-method-notice"
          className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-xs text-slate-700 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-300"
        >
          <p className="font-semibold">
            현재 출입 방식: {ACCESS_METHOD_LABELS[accessMethod] || accessMethod}
          </p>
          <p className="mt-1 leading-relaxed text-[11px] text-slate-500 dark:text-slate-400">
            도어락 비밀번호(PIN)를 설정하려면 아래 &lsquo;화장실 정보 수정&rsquo;에서
            출입 방식을 &lsquo;도어락 비밀번호 잠금&rsquo;으로 변경해 저장해 주세요.
          </p>
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-blue-100 bg-blue-50/70 p-3 text-[11px] leading-relaxed text-blue-900 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-200">
            🔒 입력한 PIN은 서버에서 AES-256-GCM으로 암호화되어 저장되며 평문은
            DB와 API 응답에 보관·노출되지 않습니다. 기존 비밀번호 조회는 제공하지
            않으며, 변경 시 새 버전이 발급됩니다.
            {hasActivePin && pinStatus?.updatedAt && (
              <span className="mt-1 block font-semibold">
                최근 변경일:{" "}
                {new Date(pinStatus.updatedAt).toLocaleString("ko-KR")}
              </span>
            )}
          </div>

          {!encryptionConfigured && (
            <div
              role="alert"
              data-testid="pin-encryption-missing-alert"
              className="rounded-xl border border-rose-300 bg-rose-50 p-3 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
            >
              ⚠️ 서버 PIN 암호화 키가 설정되지 않아 현재 PIN을 저장할 수
              없습니다.
            </div>
          )}

          {errorMessage && (
            <div
              role="alert"
              data-testid="pin-manager-error"
              className="rounded-xl border border-rose-300 bg-rose-50 p-3 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
            >
              <p className="font-semibold">⚠️ {errorMessage}</p>
            </div>
          )}

          {successMessage && (
            <div
              role="status"
              data-testid="pin-manager-success"
              className="rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
            >
              <p className="font-semibold">✓ {successMessage}</p>
            </div>
          )}

          <form
            onSubmit={handleSubmit}
            data-testid="restroom-pin-form"
            className="space-y-3"
          >
            <div>
              <div className="flex items-center justify-between">
                <label
                  htmlFor="restroom-pin-input"
                  className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
                >
                  {hasActivePin ? "새 도어락 PIN" : "도어락 PIN"}{" "}
                  <span className="text-rose-500">*</span>
                </label>
                <button
                  type="button"
                  onClick={() => setShowPin((prev) => !prev)}
                  className="text-[11px] font-semibold text-blue-600 hover:underline dark:text-blue-400"
                >
                  {showPin ? "숨기기" : "입력값 보기"}
                </button>
              </div>
              <input
                id="restroom-pin-input"
                data-testid="pin-input"
                type={showPin ? "text" : "password"}
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                disabled={isSubmitting || !encryptionConfigured}
                placeholder="숫자 및 *, # (4~20자리)"
                autoComplete="new-password"
                minLength={4}
                maxLength={20}
                required
                className="mt-1 block min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
              />
            </div>

            <div>
              <label
                htmlFor="restroom-pin-confirm-input"
                className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
              >
                도어락 PIN 확인 <span className="text-rose-500">*</span>
              </label>
              <input
                id="restroom-pin-confirm-input"
                data-testid="pin-confirm-input"
                type={showPin ? "text" : "password"}
                value={pinConfirm}
                onChange={(e) => setPinConfirm(e.target.value)}
                disabled={isSubmitting || !encryptionConfigured}
                placeholder="동일한 PIN을 다시 입력해 주세요"
                autoComplete="new-password"
                minLength={4}
                maxLength={20}
                required
                className="mt-1 block min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
              />
            </div>

            <button
              type="submit"
              disabled={isSubmitting || !encryptionConfigured}
              data-testid="pin-submit-button"
              className="inline-flex min-h-[44px] w-full items-center justify-center rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-semibold text-white shadow-sm hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
            >
              {isSubmitting
                ? "암호화 저장 중..."
                : hasActivePin
                ? "도어락 PIN 변경하기"
                : "도어락 PIN 등록하기"}
            </button>
          </form>
        </>
      )}
    </section>
  );
}
