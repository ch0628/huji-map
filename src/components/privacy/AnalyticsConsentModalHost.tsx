"use client";

import React, { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  ANALYTICS_CONSENT_CHANGED_EVENT,
  OPEN_ANALYTICS_SETTINGS_EVENT,
  getConsentState,
  syncAnalyticsAuthBoundary,
  syncConsentPrefCookie,
  updateAnalyticsConsent,
} from "@/lib/events/client";
import {
  PRIVACY_POLICY_VERSION,
  type AnalyticsConsentStatus,
} from "@/lib/events/types";
import ConsentDetailsAccordion from "./ConsentDetailsAccordion";
import PrivacySettingsClient from "./PrivacySettingsClient";

export interface AnalyticsConsentModalHostProps {
  readonly isAuthenticated: boolean;
  readonly initialConsentStatus?: AnalyticsConsentStatus;
}

export default function AnalyticsConsentModalHost({
  isAuthenticated,
  initialConsentStatus,
}: AnalyticsConsentModalHostProps) {
  const pathname = usePathname();
  const [consentStatus, setConsentStatus] = useState<AnalyticsConsentStatus>(
    () => initialConsentStatus ?? getConsentState().analyticsStatus
  );
  const [sessionDismissed, setSessionDismissed] = useState(false);
  const [expandDetails, setExpandDetails] = useState(false);
  const [isSavingPrompt, setIsSavingPrompt] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const syncConsentFromStorage = useCallback(() => {
    const state = getConsentState();
    setConsentStatus(state.analyticsStatus);
    syncConsentPrefCookie(state.analyticsStatus, state.policyVersion);
  }, []);

  useEffect(() => {
    const currentState = getConsentState();
    setConsentStatus(currentState.analyticsStatus);
    syncConsentPrefCookie(currentState.analyticsStatus, currentState.policyVersion);
    syncAnalyticsAuthBoundary(isAuthenticated);

    try {
      const sp = new URLSearchParams(window.location.search);
      const wantsSettings = sp.get("analyticsSettings") === "1";
      const wantsDetails = sp.get("analyticsDetails") === "1";

      if (wantsSettings || wantsDetails) {
        sp.delete("analyticsSettings");
        sp.delete("analyticsDetails");
        const remaining = sp.toString();
        const nextUrl = `${window.location.pathname}${remaining ? `?${remaining}` : ""}${window.location.hash}`;
        window.history.replaceState(null, "", nextUrl);
      }

      if (wantsDetails) {
        setExpandDetails(true);
        if (currentState.analyticsStatus === "undecided") {
          setSessionDismissed(false);
        } else {
          setIsSettingsOpen(true);
        }
      } else if (wantsSettings) {
        setIsSettingsOpen(true);
      }
    } catch {}
  }, [isAuthenticated]);

  useEffect(() => {
    const handleConsentChange = () => {
      syncConsentFromStorage();
    };
    const handleOpenSettings = () => {
      syncConsentFromStorage();
      setIsSettingsOpen(true);
    };
    window.addEventListener(ANALYTICS_CONSENT_CHANGED_EVENT, handleConsentChange);
    window.addEventListener("storage", handleConsentChange);
    window.addEventListener(OPEN_ANALYTICS_SETTINGS_EVENT, handleOpenSettings);
    return () => {
      window.removeEventListener(ANALYTICS_CONSENT_CHANGED_EVENT, handleConsentChange);
      window.removeEventListener("storage", handleConsentChange);
      window.removeEventListener(OPEN_ANALYTICS_SETTINGS_EVENT, handleOpenSettings);
    };
  }, [syncConsentFromStorage]);

  const isPublicConsentRoute =
    pathname === null ||
    pathname === "/" ||
    pathname === "/map" ||
    pathname.startsWith("/restrooms");

  const showFirstVisitScreen =
    consentStatus === "undecided" &&
    !sessionDismissed &&
    !isSettingsOpen &&
    isPublicConsentRoute;

  useEffect(() => {
    if (!showFirstVisitScreen && !isSettingsOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isSettingsOpen) {
          setIsSettingsOpen(false);
        } else if (showFirstVisitScreen && !isSavingPrompt) {
          // ESC 닫기는 동의로 처리하지 않고 현재 화면에서만 닫는다 (상태는 undecided 유지)
          setSessionDismissed(true);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showFirstVisitScreen, isSettingsOpen, isSavingPrompt]);

  const handleFirstVisitDecision = async (accepted: boolean) => {
    if (isSavingPrompt) return;
    setIsSavingPrompt(true);
    try {
      const result = await updateAnalyticsConsent(accepted);
      setConsentStatus(result.analyticsStatus);
      setSessionDismissed(true);
    } finally {
      setIsSavingPrompt(false);
    }
  };

  if (isSettingsOpen) {
    return (
      <div
        data-testid="analytics-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="analytics-settings-modal-title"
        className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-950/50 p-3 sm:items-center"
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            setIsSettingsOpen(false);
          }
        }}
      >
        <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl dark:border-slate-800 dark:bg-slate-900">
          <PrivacySettingsClient
            embeddedInModal
            defaultExpandDetails={expandDetails}
            onClose={() => setIsSettingsOpen(false)}
          />
        </div>
      </div>
    );
  }

  if (!showFirstVisitScreen) {
    return null;
  }

  return (
    <div
      data-testid="first-visit-consent-modal"
      role="dialog"
      aria-modal="false"
      aria-labelledby="first-visit-consent-title"
      aria-describedby="first-visit-consent-desc"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex justify-center px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <div className="pointer-events-auto flex max-h-[68vh] w-full max-w-md flex-col justify-between overflow-y-auto rounded-2xl border border-slate-200 bg-white/95 px-4 pt-4 pb-0 shadow-2xl backdrop-blur dark:border-slate-800 dark:bg-slate-900/95 break-keep">
        <div className="space-y-4">
          <header className="space-y-1.5">
            <div className="flex items-start justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2.5 py-0.5 text-[11px] font-semibold text-blue-700 dark:bg-blue-950/60 dark:text-blue-200">
                <span aria-hidden="true">🧻</span>
                <span>휴지맵 · 선택 이용 통계 안내</span>
              </span>
              <button
                type="button"
                disabled={isSavingPrompt}
                onClick={() => setSessionDismissed(true)}
                data-testid="consent-dismiss-btn"
                aria-label="나중에 결정하고 닫기"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-xs font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
              >
                ✕
              </button>
            </div>
            <h1
              id="first-visit-consent-title"
              className="text-lg font-bold tracking-tight text-slate-900 dark:text-white"
            >
              휴지맵 시작하기
            </h1>
            <p
              id="first-visit-consent-desc"
              className="text-xs leading-relaxed text-slate-600 dark:text-slate-300"
            >
              더 편리한 화장실 지도를 만들 수 있도록 서비스 이용 통계 수집에
              참여해 주세요. 동의하지 않아도 지도와 검색을 바로 사용할 수 있습니다.
            </p>
          </header>

          <ConsentDetailsAccordion
            compact
            key={expandDetails ? "expanded" : "collapsed"}
            defaultExpandedId={expandDetails ? "privacy" : null}
            defaultExpandPrivacyDetails={expandDetails}
            policyVersion={PRIVACY_POLICY_VERSION}
          />
        </div>

        <footer className="sticky bottom-0 mt-4 border-t border-slate-100 bg-white/95 py-3 backdrop-blur dark:border-slate-800/80 dark:bg-slate-900/95">
          <div className="flex flex-col gap-2">
            <button
              type="button"
              disabled={isSavingPrompt}
              onClick={() => handleFirstVisitDecision(true)}
              data-testid="consent-accept-btn"
              className="flex min-h-[44px] w-full items-center justify-center rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50"
            >
              동의하고 시작하기
            </button>
            <button
              type="button"
              disabled={isSavingPrompt}
              onClick={() => handleFirstVisitDecision(false)}
              data-testid="consent-decline-btn"
              className="flex min-h-[44px] w-full items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-slate-800 transition hover:bg-slate-50 active:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
            >
              동의 없이 시작하기
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
