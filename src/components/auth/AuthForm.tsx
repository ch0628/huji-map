"use client";

import React, { useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { loginSchema, sanitizeReturnTo, signupSchema } from "@/lib/auth/validation";

export interface AuthFormProps {
  mode: "login" | "signup";
  configReady: boolean;
  returnTo?: string;
}

export default function AuthForm({
  mode,
  configReady,
  returnTo = "/map",
}: AuthFormProps) {
  const router = useRouter();
  const safeReturnTo = sanitizeReturnTo(returnTo);

  const emailId = useId();
  const passwordId = useId();
  const displayNameId = useId();
  const termsId = useId();
  const errorBannerId = useId();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);

  const [fieldErrors, setFieldErrors] = useState<{
    email?: string;
    password?: string;
    displayName?: string;
    termsAccepted?: string;
  }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [verificationMessage, setVerificationMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isLogin = mode === "login";

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFieldErrors({});
    setFormError(null);
    setVerificationMessage(null);

    if (!configReady) {
      setFormError("인증 서비스 설정이 필요합니다. 현재 로그인을 진행할 수 없습니다.");
      return;
    }

    if (isLogin) {
      const parsed = loginSchema.safeParse({
        email,
        password,
        returnTo: safeReturnTo,
      });
      if (!parsed.success) {
        const nextErrors: typeof fieldErrors = {};
        for (const issue of parsed.error.issues) {
          const key = issue.path[0];
          if (key === "email" || key === "password") {
            nextErrors[key] = issue.message;
          }
        }
        setFieldErrors(nextErrors);
        return;
      }
    } else {
      const parsed = signupSchema.safeParse({
        email,
        password,
        displayName: displayName.trim() || undefined,
        termsAccepted,
        returnTo: safeReturnTo,
      });
      if (!parsed.success) {
        const nextErrors: typeof fieldErrors = {};
        for (const issue of parsed.error.issues) {
          const key = issue.path[0];
          if (
            key === "email" ||
            key === "password" ||
            key === "displayName" ||
            key === "termsAccepted"
          ) {
            nextErrors[key] = issue.message;
          }
        }
        setFieldErrors(nextErrors);
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const endpoint = isLogin ? "/api/v1/auth/login" : "/api/v1/auth/signup";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": `${mode}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        },
        body: JSON.stringify(
          isLogin
            ? { email: email.trim(), password, returnTo: safeReturnTo }
            : {
                email: email.trim(),
                password,
                displayName: displayName.trim() || undefined,
                termsAccepted,
                returnTo: safeReturnTo,
              }
        ),
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload?.ok) {
        setFormError(
          payload?.error?.message ??
            (isLogin
              ? "로그인에 실패했습니다. 이메일과 비밀번호를 확인해 주세요."
              : "회원가입에 실패했습니다. 입력 정보를 다시 확인해 주세요.")
        );
        return;
      }

      if (!isLogin && payload.requiresEmailVerification) {
        setVerificationMessage(
          "가입 확인 메일이 발송되었습니다. 이메일 인증 완료 후 로그인해 주세요."
        );
        setPassword("");
        return;
      }

      router.push(payload.redirectTo || safeReturnTo);
      router.refresh();
    } catch {
      setFormError("네트워크 연결 상태를 확인한 뒤 다시 시도해 주세요.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col space-y-5">
      <form
        onSubmit={handleSubmit}
        noValidate
        aria-describedby={formError ? errorBannerId : undefined}
        className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
      >
        {formError && (
          <div
            id={errorBannerId}
            role="alert"
            aria-live="assertive"
            className="rounded-lg border border-rose-300 bg-rose-50 px-3.5 py-3 text-xs font-medium text-rose-900 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-200"
          >
            {formError}
          </div>
        )}

        {verificationMessage && (
          <div
            role="status"
            aria-live="polite"
            className="rounded-lg border border-emerald-300 bg-emerald-50 px-3.5 py-3 text-xs font-medium text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200"
          >
            {verificationMessage}
          </div>
        )}

        <div>
          <label
            htmlFor={emailId}
            className="mb-1.5 block text-xs font-semibold text-slate-700 dark:text-slate-200"
          >
            이메일 주소 <span className="text-rose-600">*</span>
          </label>
          <input
            id={emailId}
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            disabled={!configReady || isSubmitting}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={Boolean(fieldErrors.email)}
            aria-describedby={fieldErrors.email ? `${emailId}-error` : undefined}
            placeholder="example@domain.com"
            className="min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20 disabled:cursor-not-allowed disabled:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
          {fieldErrors.email && (
            <p
              id={`${emailId}-error`}
              role="alert"
              className="mt-1.5 text-xs text-rose-600 dark:text-rose-400"
            >
              {fieldErrors.email}
            </p>
          )}
        </div>

        <div>
          <label
            htmlFor={passwordId}
            className="mb-1.5 block text-xs font-semibold text-slate-700 dark:text-slate-200"
          >
            비밀번호 <span className="text-rose-600">*</span>
          </label>
          <input
            id={passwordId}
            name="password"
            type="password"
            autoComplete={isLogin ? "current-password" : "new-password"}
            required
            disabled={!configReady || isSubmitting}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={Boolean(fieldErrors.password)}
            aria-describedby={fieldErrors.password ? `${passwordId}-error` : undefined}
            placeholder="8자 이상 입력해 주세요"
            className="min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20 disabled:cursor-not-allowed disabled:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
          {fieldErrors.password && (
            <p
              id={`${passwordId}-error`}
              role="alert"
              className="mt-1.5 text-xs text-rose-600 dark:text-rose-400"
            >
              {fieldErrors.password}
            </p>
          )}
        </div>

        {!isLogin && (
          <>
            <div>
              <label
                htmlFor={displayNameId}
                className="mb-1.5 block text-xs font-semibold text-slate-700 dark:text-slate-200"
              >
                닉네임 (선택)
              </label>
              <input
                id={displayNameId}
                name="displayName"
                type="text"
                autoComplete="nickname"
                disabled={!configReady || isSubmitting}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                aria-invalid={Boolean(fieldErrors.displayName)}
                aria-describedby={
                  fieldErrors.displayName ? `${displayNameId}-error` : undefined
                }
                placeholder="화면에 표시할 이름 (최대 40자)"
                className="min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20 disabled:cursor-not-allowed disabled:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
              {fieldErrors.displayName && (
                <p
                  id={`${displayNameId}-error`}
                  role="alert"
                  className="mt-1.5 text-xs text-rose-600 dark:text-rose-400"
                >
                  {fieldErrors.displayName}
                </p>
              )}
            </div>

            <div className="pt-1">
              <label
                htmlFor={termsId}
                className="flex min-h-[44px] cursor-pointer items-start gap-2.5 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-300"
              >
                <input
                  id={termsId}
                  name="termsAccepted"
                  type="checkbox"
                  disabled={!configReady || isSubmitting}
                  checked={termsAccepted}
                  onChange={(e) => setTermsAccepted(e.target.checked)}
                  aria-invalid={Boolean(fieldErrors.termsAccepted)}
                  aria-describedby={
                    fieldErrors.termsAccepted ? `${termsId}-error` : undefined
                  }
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="leading-relaxed">
                  [필수] 서비스 이용약관 및 개인정보 수집·이용 안내(제휴 화장실 테스트 결제·환급 및 가게 관리 목적)에 동의합니다.
                </span>
              </label>
              {fieldErrors.termsAccepted && (
                <p
                  id={`${termsId}-error`}
                  role="alert"
                  className="mt-1.5 text-xs text-rose-600 dark:text-rose-400"
                >
                  {fieldErrors.termsAccepted}
                </p>
              )}
            </div>
          </>
        )}

        <button
          type="submit"
          disabled={!configReady || isSubmitting}
          className="flex min-h-[44px] w-full items-center justify-center rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 active:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500 dark:disabled:bg-slate-800 dark:disabled:text-slate-500"
        >
          {isSubmitting
            ? isLogin
              ? "로그인 확인 중..."
              : "가입 처리 중..."
            : isLogin
              ? "이메일로 로그인"
              : "이메일로 회원가입"}
        </button>
      </form>

      <div className="flex flex-col gap-2.5 text-center text-xs">
        {isLogin ? (
          <Link
            href={`/signup?returnTo=${encodeURIComponent(safeReturnTo)}`}
            className="flex min-h-[44px] items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-2.5 font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
          >
            계정이 없으신가요? 회원가입하기
          </Link>
        ) : (
          <Link
            href={`/login?returnTo=${encodeURIComponent(safeReturnTo)}`}
            className="flex min-h-[44px] items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-2.5 font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
          >
            이미 계정이 있으신가요? 로그인하기
          </Link>
        )}

        <Link
          href="/map"
          className="flex min-h-[44px] items-center justify-center rounded-xl border border-blue-200 bg-blue-50/70 px-4 py-2.5 font-semibold text-blue-700 hover:bg-blue-100/70 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-300"
        >
          🗺️ 로그인 없이 화장실 지도 바로 보기 (비회원 이용)
        </Link>
      </div>
    </div>
  );
}

