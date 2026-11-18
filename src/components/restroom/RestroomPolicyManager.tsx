"use client";

import React, { useState } from "react";
import type { RestroomAccessPolicy } from "@/lib/restrooms/types";

interface RestroomPolicyManagerProps {
  restroomId: string;
  policies: RestroomAccessPolicy[];
  onPolicyCreated?: (newPolicy: RestroomAccessPolicy) => void;
}

export default function RestroomPolicyManager({
  restroomId,
  policies: initialPolicies,
  onPolicyCreated,
}: RestroomPolicyManagerProps) {
  const [policies, setPolicies] = useState<RestroomAccessPolicy[]>(initialPolicies);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  // Active Policy
  const activePolicy = policies.find((p) => p.is_active) || policies[0];

  // Selected new policy mode
  const currentMode = activePolicy?.access_mode === "free" ? "free_with_ad" : "deposit_with_ad";
  const [selectedMode, setSelectedMode] = useState<"free_with_ad" | "deposit_with_ad">(
    currentMode === "free_with_ad" ? "deposit_with_ad" : "free_with_ad"
  );

  const handleCreatePolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    setServerError(null);
    setSuccessMessage(null);
    setIsSubmitting(true);

    const idempotencyKey = crypto.randomUUID();

    try {
      const payload = {
        policy_mode: selectedMode,
        is_active: true,
      };

      const res = await fetch(`/api/v1/merchant/restrooms/${restroomId}/policies`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.error?.message || "정책 변경에 실패했습니다.");
      }

      const createdPolicy = data.data as RestroomAccessPolicy;
      setPolicies((prev) => [
        createdPolicy,
        ...prev.map((p) => ({ ...p, is_active: false })),
      ]);
      setSuccessMessage(
        `이용 정책이 버전 ${createdPolicy.version}으로 변경 및 활성화되었습니다.`
      );

      // Auto update next toggle recommendation
      setSelectedMode(
        createdPolicy.access_mode === "free" ? "deposit_with_ad" : "free_with_ad"
      );

      if (onPolicyCreated) {
        onPolicyCreated(createdPolicy);
      }
    } catch (err: unknown) {
      setServerError(err instanceof Error ? err.message : "정책 변경 중 오류가 발생했습니다.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      data-testid="restroom-policy-manager"
      className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-slate-900 dark:text-white">이용 정책 관리</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            화장실 이용 시 적용되는 보증금 및 환급 정책
          </p>
        </div>
        {activePolicy && (
          <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-semibold text-blue-800 dark:bg-blue-950 dark:text-blue-300">
            버전 {activePolicy.version} 활성
          </span>
        )}
      </div>

      {/* 에러 및 성공 안내 */}
      {serverError && (
        <div
          role="alert"
          data-testid="policy-manager-error"
          className="rounded-xl border border-rose-300 bg-rose-50 p-3.5 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <p className="font-semibold">⚠️ {serverError}</p>
        </div>
      )}

      {successMessage && (
        <div
          role="status"
          data-testid="policy-manager-success"
          className="rounded-xl border border-emerald-300 bg-emerald-50 p-3.5 text-xs text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
        >
          <p className="font-semibold">✓ {successMessage}</p>
        </div>
      )}

      {/* 1. 현재 활성 정책 카드 */}
      <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 dark:border-slate-800 dark:bg-slate-800/40">
        <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
          현재 활성 정책
        </span>

        {activePolicy ? (
          <div className="mt-2 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold text-slate-900 dark:text-white">
                {activePolicy.access_mode === "free"
                  ? "무료 모드 (Free)"
                  : "테스트 보증금 모드 (1,000원)"}
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                시행일: {new Date(activePolicy.effective_from).toLocaleDateString("ko-KR")}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs text-slate-700 dark:text-slate-300 pt-1">
              <div>
                <span className="text-slate-400">보증금 금액:</span>{" "}
                <strong className="text-slate-900 dark:text-white">
                  {activePolicy.deposit_amount_krw
                    ? `${activePolicy.deposit_amount_krw.toLocaleString()}원`
                    : "0원 (무료)"}
                </strong>
              </div>
              <div>
                <span className="text-slate-400">환급 조건:</span>{" "}
                <strong>
                  {activePolicy.refund_eligible
                    ? `영수증 ${activePolicy.receipt_window_hours || 24}시간 내 제출 시 전액 환급`
                    : "환급 미대상 (무료)"}
                </strong>
              </div>
            </div>

            {activePolicy.access_mode !== "free" && (
              <div className="mt-2 rounded-lg bg-amber-50 p-2 text-[11px] text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
                💡 <strong>테스트 환경 고지:</strong> 실거래 결제는 비활성화되어 있으며, PG 테스트 모드로 결제 및 환급 테스트가 진행됩니다.
              </div>
            )}
          </div>
        ) : (
          <p className="mt-1 text-xs text-slate-500">설정된 활성 정책이 없습니다.</p>
        )}
      </div>

      {/* 2. 새 정책 변경 생성 폼 */}
      <form onSubmit={handleCreatePolicy} className="space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
        <div>
          <h3 className="text-xs font-bold text-slate-900 dark:text-white">새 이용 정책 버전 적용</h3>
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
            정책을 변경하면 기존 정책 이력은 안전하게 보존되며, 새 버전(v{(activePolicy?.version ?? 0) + 1})이 생성되어 즉시 활성화됩니다.
          </p>
        </div>

        <div className="space-y-2">
          <label
            className={`flex items-start gap-3 rounded-xl border p-3 cursor-pointer transition ${
              selectedMode === "free_with_ad"
                ? "border-blue-500 bg-blue-50/50 dark:border-blue-600 dark:bg-blue-950/30"
                : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
            }`}
          >
            <input
              type="radio"
              name="change_policy_mode"
              value="free_with_ad"
              checked={selectedMode === "free_with_ad"}
              onChange={() => setSelectedMode("free_with_ad")}
              className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500"
            />
            <div className="text-xs">
              <span className="font-bold text-slate-900 dark:text-white">무료 모드 (광고 기반)</span>
              <p className="mt-0.5 text-slate-500 dark:text-slate-400">
                보증금 0원, 환급 조건 없음, 이용자에게 무료 개방
              </p>
            </div>
          </label>

          <label
            className={`flex items-start gap-3 rounded-xl border p-3 cursor-pointer transition ${
              selectedMode === "deposit_with_ad"
                ? "border-blue-500 bg-blue-50/50 dark:border-blue-600 dark:bg-blue-950/30"
                : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
            }`}
          >
            <input
              type="radio"
              name="change_policy_mode"
              value="deposit_with_ad"
              checked={selectedMode === "deposit_with_ad"}
              onChange={() => setSelectedMode("deposit_with_ad")}
              className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500"
            />
            <div className="text-xs">
              <span className="font-bold text-slate-900 dark:text-white">테스트 보증금 모드 (환급형)</span>
              <p className="mt-0.5 text-slate-500 dark:text-slate-400">
                기본 보증금 1,000원, 영수증 24시간 내 제출 시 전액 환급 (테스트 전용)
              </p>
            </div>
          </label>
        </div>

        <button
          type="submit"
          disabled={isSubmitting}
          data-testid="create-policy-button"
          className="inline-flex min-h-[44px] w-full items-center justify-center rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-slate-800 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
        >
          {isSubmitting ? "새 정책 적용 중..." : "새 이용 정책 버전 적용"}
        </button>
      </form>

      {/* 3. 정책 이력 아코디언 */}
      {policies.length > 0 && (
        <div className="border-t border-slate-100 pt-3 dark:border-slate-800">
          <button
            type="button"
            onClick={() => setShowHistory(!showHistory)}
            className="flex w-full items-center justify-between text-xs font-semibold text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white py-1"
          >
            <span>📜 정책 버전 변경 이력 ({policies.length}건)</span>
            <span>{showHistory ? "접기 ▲" : "보기 ▼"}</span>
          </button>

          {showHistory && (
            <div className="mt-3 space-y-2">
              {policies.map((p) => (
                <div
                  key={p.id || p.version}
                  className="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-2.5 text-xs dark:border-slate-800 dark:bg-slate-950"
                >
                  <div>
                    <span className="font-bold text-slate-900 dark:text-white">
                      v{p.version} — {p.access_mode === "free" ? "무료" : "테스트 보증금(1,000원)"}
                    </span>
                    <span className="block text-[11px] text-slate-400">
                      시행일: {new Date(p.effective_from).toLocaleDateString("ko-KR")}
                    </span>
                  </div>

                  {p.is_active ? (
                    <span className="rounded bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                      현재 활성
                    </span>
                  ) : (
                    <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                      만료됨
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

