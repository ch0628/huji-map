"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { AccessMethod } from "@/lib/restrooms/types";
import type { MerchantRestroomPinStatus } from "@/lib/restrooms/merchant-service";
import { setRestroomPinSchema } from "@/lib/access/crypto/types";
import { focusFirstErrorField } from "@/lib/forms/validation-ux";

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
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Volatile state only for current PIN display (never persisted to storage/URL/logs)
  const [currentPin, setCurrentPin] = useState<string | null>(null);
  const [isLoadingCurrentPin, setIsLoadingCurrentPin] = useState(false);
  const [currentPinError, setCurrentPinError] = useState<string | null>(null);
  const [isChangeFormOpen, setIsChangeFormOpen] = useState(false);
  const [localPinStatus, setLocalPinStatus] = useState<MerchantRestroomPinStatus | undefined>(
    pinStatus
  );
  const isMountedRef = useRef(true);

  useEffect(() => {
    setLocalPinStatus(pinStatus);
  }, [pinStatus]);

  const effectivePinStatus = localPinStatus ?? pinStatus;
  const hasActivePin = Boolean(effectivePinStatus?.hasActivePin);
  const codeVersion = effectivePinStatus?.codeVersion ?? null;
  const encryptionConfigured = effectivePinStatus?.encryptionConfigured ?? true;

  const resetFormState = useCallback(() => {
    setPin("");
    setPinConfirm("");
    setShowPin(false);
    setErrorMessage(null);
    setFieldErrors({});
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    const handlePageHide = () => setCurrentPin(null);
    const handleVisibilityChange = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        setCurrentPin(null);
      }
    };
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", handlePageHide);
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }
    return () => {
      isMountedRef.current = false;
      setCurrentPin(null);
      if (typeof window !== "undefined") {
        window.removeEventListener("pagehide", handlePageHide);
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
    };
  }, []);

  // Automatically fetch current PIN once the PIN management panel is explicitly opened
  useEffect(() => {
    if (accessMethod !== "pin" || !hasActivePin || !encryptionConfigured) {
      setCurrentPin(null);
      setCurrentPinError(null);
      setIsLoadingCurrentPin(false);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    setIsLoadingCurrentPin(true);
    setCurrentPinError(null);
    setCurrentPin(null);

    (async () => {
      try {
        const res = await fetch(
          `/api/v1/merchant/restrooms/${encodeURIComponent(restroomId)}/pin`,
          {
            method: "GET",
            headers: {
              Accept: "application/json",
              "Cache-Control": "no-store",
            },
            cache: "no-store",
            credentials: "same-origin",
            signal: controller.signal,
          }
        );
        const data = await res.json().catch(() => null);
        if (cancelled || !isMountedRef.current) return;

        if (!res.ok || !data?.ok || typeof data.pin !== "string") {
          setCurrentPinError(
            data?.error?.message || "현재 비밀번호를 확인하지 못했습니다."
          );
          return;
        }

        setCurrentPin(data.pin);
      } catch (err: unknown) {
        if (
          cancelled ||
          !isMountedRef.current ||
          (err instanceof Error && err.name === "AbortError")
        ) {
          return;
        }
        setCurrentPinError("현재 비밀번호를 확인하지 못했습니다.");
      } finally {
        if (!cancelled && isMountedRef.current) {
          setIsLoadingCurrentPin(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      setCurrentPin(null);
    };
  }, [accessMethod, restroomId, hasActivePin, encryptionConfigured, codeVersion]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting || accessMethod !== "pin") return;

    setErrorMessage(null);
    setSuccessMessage(null);
    setFieldErrors({});

    const nextErrors: Record<string, string> = {};
    if (!pin.trim()) {
      nextErrors.pin = "도어락 비밀번호를 입력해 주세요.";
    } else {
      const parsed = setRestroomPinSchema.safeParse({ pin });
      if (!parsed.success) {
        nextErrors.pin =
          parsed.error.issues[0]?.message ||
          "숫자 및 *, # 기호로 4~20자리를 입력해 주세요.";
      } else if (!pinConfirm.trim()) {
        nextErrors.pinConfirm = "동일한 도어락 비밀번호를 한 번 더 입력해 주세요.";
      } else if (parsed.data.pin !== pinConfirm.trim()) {
        nextErrors.pinConfirm = "입력한 비밀번호와 확인 비밀번호가 일치하지 않습니다.";
      }
    }

    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors);
      setErrorMessage(nextErrors.pin || nextErrors.pinConfirm || "입력값을 확인해 주세요.");
      focusFirstErrorField(
        ["pin", "pinConfirm"],
        nextErrors,
        {
          pin: "restroom-pin-input",
          pinConfirm: "restroom-pin-confirm-input",
        }
      );
      return;
    }

    const parsed = setRestroomPinSchema.parse({ pin });

    setIsSubmitting(true);
    const idempotencyKey = crypto.randomUUID();

    try {
      const res = await fetch(`/api/v1/merchant/restrooms/${restroomId}/pin`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({ pin: parsed.pin }),
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

      resetFormState();
      setIsChangeFormOpen(false);
      setLocalPinStatus(nextStatus);
      setSuccessMessage(
        `도어락 비밀번호가 저장되었습니다. (v${data.codeVersion})`
      );
      onPinUpdated?.(nextStatus);
    } catch (err: unknown) {
      setErrorMessage(
        err instanceof Error ? err.message : "비밀번호 저장 중 오류가 발생했습니다."
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const shouldShowForm = !hasActivePin || isChangeFormOpen;

  return (
    <section
      data-testid="restroom-pin-manager"
      className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold text-slate-900 dark:text-white">
          도어락 비밀번호
        </h2>

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
              ? `등록됨 (v${effectivePinStatus?.codeVersion ?? 1})`
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
            도어락 비밀번호를 설정하려면 &lsquo;화장실 정보 수정&rsquo;에서
            출입 방식을 &lsquo;도어락 비밀번호 잠금&rsquo;으로 변경해 주세요.
          </p>
        </div>
      ) : (
        <>
          {!encryptionConfigured && (
            <div
              role="alert"
              data-testid="pin-encryption-missing-alert"
              className="rounded-xl border border-rose-300 bg-rose-50 p-3 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
            >
              ⚠️ 서버 보안 설정이 완료되지 않아 현재 비밀번호를 저장할 수 없습니다.
            </div>
          )}

          {hasActivePin && encryptionConfigured && (
            <div
              data-testid="merchant-current-pin-panel"
              className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 space-y-2 dark:border-slate-800 dark:bg-slate-800/40"
            >
              {isLoadingCurrentPin ? (
                <p
                  data-testid="merchant-current-pin-loading"
                  className="text-center text-xs font-medium text-slate-500 dark:text-slate-400 py-2"
                >
                  현재 비밀번호를 불러오는 중...
                </p>
              ) : currentPin !== null ? (
                <div className="rounded-xl border border-slate-300 bg-white px-4 py-3 text-center dark:border-slate-700 dark:bg-slate-900">
                  <p
                    data-testid="merchant-current-pin-value"
                    className="font-mono text-2xl font-extrabold tracking-[0.22em] text-slate-900 dark:text-white select-none"
                  >
                    {currentPin}
                  </p>
                </div>
              ) : currentPinError ? (
                <p
                  role="alert"
                  data-testid="merchant-current-pin-error"
                  className="text-xs font-medium text-rose-600 dark:text-rose-400"
                >
                  {currentPinError}
                </p>
              ) : (
                <p
                  data-testid="merchant-current-pin-hidden"
                  className="text-center text-xs text-slate-500 dark:text-slate-400 py-1"
                >
                  화면 전환으로 비밀번호가 가려졌습니다. 메뉴를 다시 열어 확인해 주세요.
                </p>
              )}

              {effectivePinStatus?.updatedAt && (
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  최근 변경일:{" "}
                  {new Date(effectivePinStatus.updatedAt).toLocaleString("ko-KR")}
                </p>
              )}
            </div>
          )}

          {!hasActivePin && (
            <p className="text-xs text-slate-600 dark:text-slate-400">
              등록된 도어락 비밀번호가 없습니다. 새 비밀번호를 등록해 주세요.
            </p>
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

          {hasActivePin && !isChangeFormOpen && (
            <button
              type="button"
              data-testid="merchant-open-pin-change-btn"
              disabled={!encryptionConfigured}
              onClick={() => {
                setSuccessMessage(null);
                setErrorMessage(null);
                setFieldErrors({});
                setIsChangeFormOpen(true);
              }}
              className="inline-flex min-h-[44px] w-full items-center justify-center rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-semibold text-white shadow-sm hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
            >
              비밀번호 변경하기
            </button>
          )}

          {shouldShowForm && (
            <form
              onSubmit={handleSubmit}
              noValidate
              data-testid="restroom-pin-form"
              className="space-y-3 border-t border-slate-100 pt-3 dark:border-slate-800"
            >
              <div>
                <div className="flex items-center justify-between">
                  <label
                    htmlFor="restroom-pin-input"
                    className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
                  >
                    새 비밀번호 <span className="text-rose-500">*</span>
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
                  inputMode="numeric"
                  value={pin}
                  aria-invalid={Boolean(fieldErrors.pin)}
                  aria-describedby={fieldErrors.pin ? "restroom-pin-error" : undefined}
                  onChange={(e) => {
                    setPin(e.target.value);
                    if (fieldErrors.pin) {
                      setFieldErrors((prev) => {
                        const next = { ...prev };
                        delete next.pin;
                        return next;
                      });
                    }
                  }}
                  disabled={isSubmitting || !encryptionConfigured}
                  placeholder="숫자 및 *, # (4~20자리)"
                  autoComplete="new-password"
                  minLength={4}
                  maxLength={20}
                  required
                  className={`mt-1 block min-h-[44px] w-full rounded-xl border bg-white px-3 py-2.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:bg-slate-800 dark:text-white ${
                    fieldErrors.pin
                      ? "border-rose-500 ring-1 ring-rose-500/30"
                      : "border-slate-300 dark:border-slate-700"
                  }`}
                />
                {fieldErrors.pin && (
                  <p
                    id="restroom-pin-error"
                    role="alert"
                    className="mt-1 text-xs font-medium text-rose-600 dark:text-rose-400"
                  >
                    {fieldErrors.pin}
                  </p>
                )}
              </div>

              <div>
                <label
                  htmlFor="restroom-pin-confirm-input"
                  className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
                >
                  새 비밀번호 확인 <span className="text-rose-500">*</span>
                </label>
                <input
                  id="restroom-pin-confirm-input"
                  data-testid="pin-confirm-input"
                  type={showPin ? "text" : "password"}
                  inputMode="numeric"
                  value={pinConfirm}
                  aria-invalid={Boolean(fieldErrors.pinConfirm)}
                  aria-describedby={fieldErrors.pinConfirm ? "restroom-pin-confirm-error" : undefined}
                  onChange={(e) => {
                    setPinConfirm(e.target.value);
                    if (fieldErrors.pinConfirm) {
                      setFieldErrors((prev) => {
                        const next = { ...prev };
                        delete next.pinConfirm;
                        return next;
                      });
                    }
                  }}
                  disabled={isSubmitting || !encryptionConfigured}
                  placeholder="동일한 비밀번호를 다시 입력해 주세요"
                  autoComplete="new-password"
                  minLength={4}
                  maxLength={20}
                  required
                  className={`mt-1 block min-h-[44px] w-full rounded-xl border bg-white px-3 py-2.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:bg-slate-800 dark:text-white ${
                    fieldErrors.pinConfirm
                      ? "border-rose-500 ring-1 ring-rose-500/30"
                      : "border-slate-300 dark:border-slate-700"
                  }`}
                />
                {fieldErrors.pinConfirm && (
                  <p
                    id="restroom-pin-confirm-error"
                    role="alert"
                    className="mt-1 text-xs font-medium text-rose-600 dark:text-rose-400"
                  >
                    {fieldErrors.pinConfirm}
                  </p>
                )}
              </div>

              <div className="flex gap-2">
                {hasActivePin && (
                  <button
                    type="button"
                    data-testid="merchant-cancel-pin-change-btn"
                    disabled={isSubmitting}
                    onClick={() => {
                      resetFormState();
                      setIsChangeFormOpen(false);
                    }}
                    className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                  >
                    취소
                  </button>
                )}
                <button
                  type="submit"
                  disabled={isSubmitting || !encryptionConfigured}
                  data-testid="pin-submit-button"
                  className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-semibold text-white shadow-sm hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
                >
                  {isSubmitting ? "저장 중..." : "변경 저장"}
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}
