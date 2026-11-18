"use client";

import React, { useState, useEffect } from "react";
import { submitTravelAnswer } from "@/lib/events/client";

export interface TravelSurveyBannerProps {
  readonly onAnswerSubmitted?: (travelingNow: boolean) => void;
  readonly onDismiss?: () => void;
  /** 테스트/스토리북용 강제 표시 플래그 */
  readonly forceVisible?: boolean;
}

const STORAGE_KEY_ANSWERED = "hm_travel_answered";
const STORAGE_KEY_DISMISSED = "hm_travel_survey_dismissed";

export default function TravelSurveyBanner({
  onAnswerSubmitted,
  onDismiss,
  forceVisible = false,
}: TravelSurveyBannerProps) {
  const [isVisible, setIsVisible] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [submitSuccess, setSubmitSuccess] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (forceVisible) {
      setIsVisible(true);
      return;
    }

    try {
      const answered = window.sessionStorage.getItem(STORAGE_KEY_ANSWERED);
      const dismissed = window.sessionStorage.getItem(STORAGE_KEY_DISMISSED);
      if (!answered && !dismissed) {
        setIsVisible(true);
      }
    } catch {
      setIsVisible(true);
    }
  }, [forceVisible]);

  if (!isVisible) {
    return null;
  }

  const handleAnswer = async (travelingNow: boolean) => {
    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      await submitTravelAnswer(travelingNow);
      setSubmitSuccess(true);
      try {
        window.sessionStorage.setItem(STORAGE_KEY_ANSWERED, "true");
      } catch {}
      onAnswerSubmitted?.(travelingNow);

      setTimeout(() => {
        setIsVisible(false);
      }, 2500);
    } catch (err: any) {
      setErrorMessage(err?.message || "전송에 실패했습니다. 다시 시도해 주세요.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDismiss = () => {
    try {
      window.sessionStorage.setItem(STORAGE_KEY_DISMISSED, "true");
    } catch {}
    setIsVisible(false);
    onDismiss?.();
  };

  return (
    <aside
      role="region"
      aria-label="수원 여행 여부 설문"
      data-testid="travel-survey-banner"
      className="mt-2 rounded-2xl border border-blue-200/90 bg-white/95 p-3.5 shadow-lg backdrop-blur-md dark:border-blue-900/60 dark:bg-slate-900/95 animate-in slide-in-from-top-2 duration-200"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-base">🧭</span>
            <span className="text-xs font-bold text-slate-900 dark:text-white">
              현재 수원 여행 중이신가요?
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            더 유용한 화장실 정보를 안내해 드릴게요.
          </p>
        </div>

        <button
          type="button"
          onClick={handleDismiss}
          data-testid="survey-dismiss-btn"
          aria-label="설문 닫기"
          className="flex h-6 w-6 items-center justify-center rounded-full text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          ✕
        </button>
      </div>

      {/* 성공 피드백 */}
      {submitSuccess && (
        <div
          data-testid="survey-success-notice"
          className="mt-2 rounded-xl bg-emerald-50 px-3 py-1.5 text-center text-xs font-semibold text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 animate-in fade-in"
        >
          답변이 등록되었습니다. 감사합니다! ✨
        </div>
      )}

      {/* 오류 피드백 */}
      {errorMessage && (
        <div
          data-testid="survey-error-notice"
          className="mt-2 flex items-center justify-between rounded-xl bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:bg-red-950/60 dark:text-red-300"
        >
          <span className="truncate">{errorMessage}</span>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            className="ml-2 rounded px-1.5 py-0.5 text-[10px] font-bold underline"
          >
            닫기
          </button>
        </div>
      )}

      {/* 선택 버튼 영역 */}
      {!submitSuccess && (
        <div className="mt-2.5 flex items-center gap-2">
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => handleAnswer(true)}
            data-testid="survey-answer-yes-btn"
            className="flex min-h-[40px] flex-1 items-center justify-center rounded-xl bg-blue-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm hover:bg-blue-700 active:scale-[0.98] disabled:opacity-50 transition"
          >
            {isSubmitting ? "전송 중..." : "네, 여행 중이에요"}
          </button>

          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => handleAnswer(false)}
            data-testid="survey-answer-no-btn"
            className="flex min-h-[40px] flex-1 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 active:scale-[0.98] disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-750 transition"
          >
            {isSubmitting ? "전송 중..." : "아니요"}
          </button>
        </div>
      )}
    </aside>
  );
}

