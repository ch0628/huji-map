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
      aria-modal="true"
      aria-labelledby="first-visit-consent-title"
      aria-describedby="first-visit-consent-desc"
      className="fixed inset-0 z-[70] overflow-y-auto bg-white dark:bg-slate-950"
    >
      <div className="mx-auto flex min-h-full w-full max-w-md flex-col justify-between px-5 pt-7 pb-0 break-keep">
        <div className="space-y-6">
          <header className="space-y-2.5 pt-1">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700 dark:bg-blue-950/60 dark:text-blue-200">
              <span aria-hidden="true">🧻</span>
              <span>휴지맵</span>
            </span>
            <h1
              id="first-visit-consent-title"
              className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white"
            >
              휴지맵 시작하기
            </h1>
            <p
              id="first-visit-consent-desc"
              className="text-sm leading-relaxed text-slate-600 dark:text-slate-300"
            >
              더 편리한 화장실 지도를 만들 수 있도록 서비스 이용 통계 수집에
              참여해 주세요.
            </p>
          </header>

          <ConsentDetailsAccordion
            key={expandDetails ? "expanded" : "collapsed"}
            defaultExpandedId={expandDetails ? "privacy" : null}
            defaultExpandPrivacyDetails={expandDetails}
            policyVersion={PRIVACY_POLICY_VERSION}
          />
        </div>

        <footer className="sticky bottom-0 mt-6 border-t border-slate-100 bg-white/95 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] backdrop-blur dark:border-slate-800/80 dark:bg-slate-950/95">
          <div className="flex flex-col gap-2.5">
            <button
              type="button"
              disabled={isSavingPrompt}
              onClick={() => handleFirstVisitDecision(true)}
              data-testid="consent-accept-btn"
              className="flex min-h-[48px] w-full items-center justify-center rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50"
            >
              동의하고 시작하기
            </button>
            <button
              type="button"
              disabled={isSavingPrompt}
              onClick={() => handleFirstVisitDecision(false)}
              data-testid="consent-decline-btn"
              className="flex min-h-[48px] w-full items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-bold text-slate-800 transition hover:bg-slate-50 active:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
            >
              동의 없이 시작하기
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
