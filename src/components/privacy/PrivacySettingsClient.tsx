"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import {
  ANALYTICS_CONSENT_CHANGED_EVENT,
  getConsentState,
  isAnalyticsEnvEnabled,
  updateAnalyticsConsent,
} from "@/lib/events/client";
import { PRIVACY_POLICY_VERSION, type AnalyticsConsentStatus } from "@/lib/events/types";
import ConsentDetailsAccordion from "./ConsentDetailsAccordion";

export interface PrivacySettingsClientProps {
  readonly embeddedInModal?: boolean;
  readonly defaultExpandDetails?: boolean;
  readonly onClose?: () => void;
}

export default function PrivacySettingsClient({
  embeddedInModal = false,
  defaultExpandDetails = false,
  onClose,
}: PrivacySettingsClientProps) {
  const [analyticsStatus, setAnalyticsStatus] =
    useState<AnalyticsConsentStatus>("undecided");
  const [envEnabled, setEnvEnabled] = useState<boolean>(false);
  const [isLoaded, setIsLoaded] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [decidedAt, setDecidedAt] = useState<string | null>(null);
  const [withdrawnAt, setWithdrawnAt] = useState<string | null>(null);

  const syncFromStorage = () => {
    const state = getConsentState();
    setAnalyticsStatus(state.analyticsStatus);
    setDecidedAt(state.decidedAt ?? state.updatedAt ?? null);
    setWithdrawnAt(state.withdrawnAt ?? null);
    setEnvEnabled(isAnalyticsEnvEnabled());
    setIsLoaded(true);
  };

  useEffect(() => {
    syncFromStorage();
    window.addEventListener(ANALYTICS_CONSENT_CHANGED_EVENT, syncFromStorage);
    return () => {
      window.removeEventListener(ANALYTICS_CONSENT_CHANGED_EVENT, syncFromStorage);
    };
  }, []);

  const analyticsEnabled = analyticsStatus === "accepted";

  const handleToggle = async () => {
    if (isSaving) return;
    const nextValue = !analyticsEnabled;
    setIsSaving(true);
    setStatusMessage(null);

    try {
      const result = await updateAnalyticsConsent(nextValue);
      setAnalyticsStatus(result.analyticsStatus);
      const latest = getConsentState();
      setDecidedAt(latest.decidedAt ?? latest.updatedAt ?? null);
      setWithdrawnAt(latest.withdrawnAt ?? null);

      if (result.analytics) {
        setStatusMessage(
          envEnabled
            ? "이용 통계 수집에 동의했어요. 지금부터 6개 행동 통계가 수집됩니다."
            : "동의 설정(ON)이 저장되었어요. 현재 환경에서는 통계 전송이 꺼져 있습니다."
        );
      } else {
        setStatusMessage(
          "동의가 철회되어 이용 통계를 수집하지 않아요. 브라우저 식별자가 삭제되었습니다."
        );
      }
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      data-testid="privacy-settings-page"
      className="flex w-full flex-col gap-3.5 text-xs text-slate-700 dark:text-slate-300 break-keep"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2
            id={embeddedInModal ? "analytics-settings-modal-title" : undefined}
            className="text-base font-bold text-slate-900 dark:text-white"
          >
            이용 통계 설정
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
            서비스 개선을 위해 선택적으로 이용 통계를 수집합니다.
          </p>
        </div>

        {embeddedInModal && onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="이용 통계 설정 닫기"
            data-testid="analytics-settings-close-btn"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-sm font-bold text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
          >
            ✕
          </button>
        )}
      </div>

      <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 dark:border-slate-800 dark:bg-slate-800/50">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-0.5">
            <h3
              id="analytics-consent-label"
              className="text-sm font-bold text-slate-900 dark:text-white"
            >
              이용 통계 수집
            </h3>
            <p
              id="analytics-consent-desc"
              className="text-[11px] leading-relaxed text-slate-600 dark:text-slate-400"
            >
              동의하지 않아도 모든 기능을 이용할 수 있어요.
            </p>
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={analyticsEnabled}
            aria-labelledby="analytics-consent-label"
            aria-describedby="analytics-consent-desc"
            disabled={!isLoaded || isSaving}
            onClick={handleToggle}
            data-testid="analytics-consent-toggle"
            className={`relative inline-flex min-h-[44px] min-w-[68px] shrink-0 cursor-pointer items-center justify-center rounded-full px-3 text-xs font-bold transition focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 ${
              analyticsEnabled
                ? "bg-blue-600 text-white hover:bg-blue-700"
                : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            }`}
          >
            {isSaving ? "저장..." : analyticsEnabled ? "ON" : "OFF"}
          </button>
        </div>

        <div
          data-testid="analytics-consent-status-box"
          className={`rounded-xl px-3 py-2 text-[11px] font-medium ${
            analyticsEnabled
              ? "border border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-200"
              : "border border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
          }`}
        >
          {!isLoaded ? (
            <span>설정 상태를 불러오는 중...</span>
          ) : analyticsStatus === "accepted" ? (
            envEnabled ? (
              <span>
                현재 상태: <strong>동의 (수집 중)</strong>
              </span>
            ) : (
              <span>
                현재 상태: <strong>동의 (환경 비활성)</strong>
              </span>
            )
          ) : analyticsStatus === "declined" ? (
            <span>
              현재 상태: <strong>비동의 (수집 안 함)</strong>
            </span>
          ) : (
            <span>
              현재 상태: <strong>미결정 (수집 안 함)</strong>
            </span>
          )}
          {(decidedAt || withdrawnAt) && (
            <p className="mt-0.5 text-[10px] opacity-75">
              {withdrawnAt && analyticsStatus === "declined"
                ? `철회 시각: ${new Date(withdrawnAt).toLocaleString("ko-KR")}`
                : decidedAt
                  ? `결정 시각: ${new Date(decidedAt).toLocaleString("ko-KR")}`
                  : null}{" "}
              (버전 {PRIVACY_POLICY_VERSION})
            </p>
          )}
        </div>

        {statusMessage && (
          <div
            role="status"
            aria-live="polite"
            data-testid="analytics-consent-feedback"
            className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] font-medium text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200"
          >
            {statusMessage}
          </div>
        )}
      </div>

      <ConsentDetailsAccordion
        compact
        defaultExpandedId={defaultExpandDetails ? "privacy" : null}
        defaultExpandPrivacyDetails={defaultExpandDetails}
        policyVersion={PRIVACY_POLICY_VERSION}
      />

      <div className="pt-1">
        {embeddedInModal && onClose ? (
          <button
            type="button"
            onClick={onClose}
            data-testid="analytics-settings-done-btn"
            className="flex min-h-[44px] w-full items-center justify-center rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 dark:bg-blue-600 dark:hover:bg-blue-700"
          >
            확인
          </button>
        ) : (
          <Link
            href="/map"
            data-testid="privacy-back-to-map-link"
            className="flex min-h-[44px] w-full items-center justify-center rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 dark:bg-blue-600 dark:hover:bg-blue-700"
          >
            화장실 지도로 이동
          </Link>
        )}
      </div>
    </div>
  );
}
