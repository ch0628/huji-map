"use client";

import React, { useState, useEffect, useCallback } from "react";
import type { AnalyticsAuthFilter, PmfReportData } from "@/lib/analytics/types";

const AUTH_FILTER_LABELS: Record<AnalyticsAuthFilter, string> = {
  all: "전체",
  guest: "비로그인",
  authenticated: "로그인",
};

const EVENT_NAME_LABELS: Record<string, string> = {
  map_loaded: "지도 로딩 성공 (map_loaded)",
  restroom_marker_clicked: "화장실 핀 클릭 (restroom_marker_clicked)",
  restroom_card_viewed: "화장실 카드 노출 (restroom_card_viewed)",
  restroom_detail_opened: "화장실 상세 조회 (restroom_detail_opened)",
  directions_clicked: "길찾기 버튼 클릭 (directions_clicked)",
  payment_button_clicked: "보증금 결제 버튼 클릭 (payment_button_clicked)",
};

function getKstTodayDateString(): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function addDaysToYmd(ymd: string, deltaDays: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const utcMs = Date.UTC(y, (m || 1) - 1, (d || 1) + deltaDays);
  return new Date(utcMs).toISOString().slice(0, 10);
}

function kstStartToIso(ymd: string): string {
  return `${ymd}T00:00:00+09:00`;
}

function kstEndToIso(ymd: string): string {
  return `${ymd}T23:59:59+09:00`;
}

function formatRateOrInsufficient(
  ratePercent: number | null | undefined,
  num?: number,
  den?: number
): string {
  if (typeof ratePercent === "number" && Number.isFinite(ratePercent)) {
    return `${ratePercent.toFixed(1)}%`;
  }
  if (typeof num === "number" && typeof den === "number" && den > 0) {
    return `${((num / den) * 100).toFixed(1)}%`;
  }
  return "데이터 부족";
}

export default function PmfDashboardClient() {
  const todayYmd = getKstTodayDateString();
  const [startDate, setStartDate] = useState<string>(() => addDaysToYmd(todayYmd, -13));
  const [endDate, setEndDate] = useState<string>(() => todayYmd);
  const [includeTest, setIncludeTest] = useState<boolean>(false);
  const [authFilter, setAuthFilter] = useState<AnalyticsAuthFilter>("all");

  const [report, setReport] = useState<PmfReportData | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);

  const applyPresetDays = (days: number) => {
    const end = getKstTodayDateString();
    setStartDate(addDaysToYmd(end, -(days - 1)));
    setEndDate(end);
  };

  const fetchReport = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setErrorStatus(null);

    try {
      const sp = new URLSearchParams();
      sp.set("experimentKey", "pmf_r1");
      if (startDate) {
        sp.set("startsAt", new Date(kstStartToIso(startDate)).toISOString());
      }
      if (endDate) {
        sp.set("endsAt", new Date(kstEndToIso(endDate)).toISOString());
      }
      if (includeTest) {
        sp.set("includeTest", "true");
      }
      sp.set("authFilter", authFilter);

      const res = await fetch(`/api/v1/admin/analytics/pmf?${sp.toString()}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });

      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        setErrorStatus(res.status);
        throw new Error(body?.error?.message || `조회 실패 (${res.status})`);
      }

      setReport(body.data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "서비스 이용 지표를 불러오지 못했습니다."
      );
    } finally {
      setIsLoading(false);
    }
  }, [startDate, endDate, includeTest, authFilter]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  const basic = report?.basicUsageMetrics;
  const basicTotals = basic?.totals;
  const basicDailyTrend = basic?.dailyTrend ?? [];

  const metrics = report?.serviceMetrics;
  const ov = metrics?.overview;
  const authSplit = metrics?.authSplit;
  const activeAuthFilter: AnalyticsAuthFilter = metrics?.authFilter ?? authFilter;
  const byType = metrics?.byRestroomType;
  const dailyTrend = metrics?.dailyTrend ?? [];
  const interestRanking = metrics?.restroomInterestRanking ?? [];
  const directionsRanking = metrics?.directionsRanking ?? [];
  const cfg = metrics?.analyticsConfig;

  return (
    <div
      data-testid="pmf-dashboard-container"
      className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-2 py-3 sm:px-4 text-xs"
    >
      {/* 1. 데이터 범위 및 신뢰성 고지 */}
      <section
        data-testid="service-analytics-notice"
        className="rounded-2xl border border-blue-200 bg-blue-50/70 p-4 text-blue-950 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-base font-bold">서비스 이용 분석</h1>
          <span className="rounded-md bg-white/80 px-2 py-0.5 text-[11px] font-semibold text-blue-800 dark:bg-slate-900 dark:text-blue-200">
            실제 DB 집계 기준 (KST)
          </span>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed opacity-90 break-keep">
          선택적 행동 분석에 <strong>동의한 브라우저</strong>만 집계되므로 집계된 브라우저 수는
          전체 서비스 방문자 수와 다를 수 있으며, 기기·브라우저 기준 익명 식별자 수이므로 실제 사람(이용자) 수와도 다릅니다.
          집계 데이터가 없는 항목은 추정하지 않고 <strong>데이터 부족</strong> 또는 0건으로 표시합니다.
        </p>
      </section>

      {/* 2. 기간 선택 및 필터 */}
      <section
        aria-label="조회 기간 및 데이터 필터"
        className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 space-y-3"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          {[
            { label: "최근 7일", days: 7 },
            { label: "최근 14일", days: 14 },
            { label: "최근 30일", days: 30 },
          ].map((preset) => (
            <button
              key={preset.days}
              type="button"
              onClick={() => applyPresetDays(preset.days)}
              className="min-h-[36px] rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <div>
            <label
              htmlFor="analytics-start-date"
              className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400"
            >
              시작일 (KST)
            </label>
            <input
              id="analytics-start-date"
              data-testid="analytics-start-date-input"
              type="date"
              value={startDate}
              max={endDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            />
          </div>
          <div>
            <label
              htmlFor="analytics-end-date"
              className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400"
            >
              종료일 (KST)
            </label>
            <input
              id="analytics-end-date"
              data-testid="analytics-end-date-input"
              type="date"
              value={endDate}
              min={startDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <label className="inline-flex min-h-[36px] cursor-pointer items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              data-testid="analytics-include-test-checkbox"
              checked={includeTest}
              onChange={(e) => setIncludeTest(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
            />
            <span>테스트/QA 표시 데이터 포함</span>
          </label>

          <button
            type="button"
            data-testid="analytics-refresh-btn"
            onClick={fetchReport}
            disabled={isLoading}
            className="min-h-[40px] rounded-xl bg-slate-900 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-blue-600 dark:hover:bg-blue-700"
          >
            {isLoading ? "조회 중..." : "새로고침"}
          </button>
        </div>

        {/* 비로그인 / 로그인 구분 필터 (행동 이벤트 전용) */}
        <div className="border-t border-slate-100 pt-2.5 dark:border-slate-800 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">
              이용자 로그인 구분 (동의 상세 분석 B-1~B-3 적용)
            </span>
            <div
              role="group"
              aria-label="이용자 로그인 구분 필터"
              className="inline-flex rounded-xl border border-slate-200 bg-slate-100 p-0.5 dark:border-slate-700 dark:bg-slate-800"
            >
              {(["all", "guest", "authenticated"] as const).map((opt) => {
                const active = authFilter === opt;
                return (
                  <button
                    key={opt}
                    type="button"
                    aria-pressed={active}
                    data-testid={`analytics-auth-filter-${opt}`}
                    onClick={() => setAuthFilter(opt)}
                    className={`min-h-[34px] rounded-lg px-3 py-1 text-[11px] font-semibold transition ${
                      active
                        ? "bg-white text-blue-700 shadow-sm dark:bg-slate-900 dark:text-blue-300"
                        : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
                    }`}
                  >
                    {AUTH_FILTER_LABELS[opt]}
                  </button>
                );
              })}
            </div>
          </div>
          {authSplit && (
            <p
              data-testid="analytics-auth-split-summary"
              className="text-[11px] text-slate-500 dark:text-slate-400"
            >
              기간 내 분포: 비로그인 {authSplit.guestEvents.toLocaleString()}회 (
              {authSplit.guestBrowsers.toLocaleString()}브라우저) · 로그인{" "}
              {authSplit.authenticatedEvents.toLocaleString()}회 (
              {authSplit.authenticatedBrowsers.toLocaleString()}브라우저) — 로그인 전후 익명
              행동을 회원 계정에 자동 결합하지 않습니다.
            </p>
          )}
          {activeAuthFilter !== "all" && (
            <p
              data-testid="analytics-auth-filter-active-notice"
              className="rounded-lg bg-blue-50 px-2.5 py-1.5 text-[11px] font-medium text-blue-900 dark:bg-blue-950/40 dark:text-blue-200"
            >
              현재 <strong>{AUTH_FILTER_LABELS[activeAuthFilter]}</strong> 행동 이벤트만 집계
              중입니다. 아래 B-4 영역(결제·이용권·영수증·환급) 서버 기록에는 이 필터가 적용되지
              않습니다.
            </p>
          )}
        </div>

        {report && !includeTest && (
          <p className="text-[11px] text-amber-700 dark:text-amber-300">
            * 테스트/QA 표시 이벤트 {report.summary.excludedTestEvents}건, 테스트 세션{" "}
            {report.summary.excludedTestSessions}건은 기본 통계에서 제외되었습니다.
          </p>
        )}
      </section>

      {error && (
        <div
          role="alert"
          data-testid="analytics-error-alert"
          className="rounded-2xl border border-rose-300 bg-rose-50 p-4 text-xs text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200 space-y-2"
        >
          <p className="font-bold">⚠️ {error}</p>
          {errorStatus === 401 && (
            <a
              href="/login?returnTo=%2Fadmin%2Fanalytics%2Fpmf&reason=session_expired"
              className="inline-flex min-h-[36px] items-center justify-center rounded-lg bg-blue-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-blue-700"
            >
              관리자 계정으로 다시 로그인
            </a>
          )}
        </div>
      )}

      {/* ================================================================ */}
      {/* A. 전체 이용량 (개인 식별 없이 수집한 단순 실행 횟수)              */}
      {/* ================================================================ */}
      <section
        data-testid="section-overall-usage"
        aria-label="A. 전체 이용량"
        className="rounded-2xl border border-emerald-200 bg-white p-4 shadow-sm dark:border-emerald-900/60 dark:bg-slate-900 space-y-3 break-keep"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">
              A. 전체 이용량 (개인 미식별 · 실행 횟수)
            </h2>
            <p className="mt-0.5 text-[11px] text-slate-600 dark:text-slate-400">
              동의 여부와 무관하게 날짜별·기능별 <strong>총 실행 횟수</strong>만 서버에서 합산합니다.{" "}
              <strong>고유 이용자 수(방문자 수)가 아닙니다.</strong>
            </p>
          </div>
          <span className="rounded bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200">
            개인 식별자·IP·검색어 미저장
          </span>
        </div>

        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          <div className="rounded-xl border border-slate-100 bg-slate-50/80 p-3 dark:border-slate-800 dark:bg-slate-800/40">
            <dt className="text-[11px] text-slate-500 dark:text-slate-400">지도 열림 횟수</dt>
            <dd
              data-testid="basic-metric-map-opened"
              className="mt-1 text-lg font-extrabold text-slate-900 dark:text-white"
            >
              {(basicTotals?.mapOpened ?? 0).toLocaleString()}회
            </dd>
          </div>
          <div className="rounded-xl border border-slate-100 bg-slate-50/80 p-3 dark:border-slate-800 dark:bg-slate-800/40">
            <dt className="text-[11px] text-slate-500 dark:text-slate-400">검색 실행 횟수</dt>
            <dd
              data-testid="basic-metric-search-executed"
              className="mt-1 text-lg font-extrabold text-slate-900 dark:text-white"
            >
              {(basicTotals?.searchExecuted ?? 0).toLocaleString()}회
            </dd>
          </div>
          <div className="rounded-xl border border-slate-100 bg-slate-50/80 p-3 dark:border-slate-800 dark:bg-slate-800/40">
            <dt className="text-[11px] text-slate-500 dark:text-slate-400">화장실 핀 클릭 횟수</dt>
            <dd
              data-testid="basic-metric-marker-clicks"
              className="mt-1 text-lg font-extrabold text-slate-900 dark:text-white"
            >
              {(basicTotals?.markerClicks ?? 0).toLocaleString()}회
            </dd>
          </div>
          <div className="rounded-xl border border-slate-100 bg-slate-50/80 p-3 dark:border-slate-800 dark:bg-slate-800/40">
            <dt className="text-[11px] text-slate-500 dark:text-slate-400">화장실 상세 조회 횟수</dt>
            <dd
              data-testid="basic-metric-detail-opened"
              className="mt-1 text-lg font-extrabold text-slate-900 dark:text-white"
            >
              {(basicTotals?.detailOpened ?? 0).toLocaleString()}회
            </dd>
          </div>
          <div className="rounded-xl border border-slate-100 bg-slate-50/80 p-3 dark:border-slate-800 dark:bg-slate-800/40">
            <dt className="text-[11px] text-slate-500 dark:text-slate-400">길찾기 버튼 클릭 횟수</dt>
            <dd
              data-testid="basic-metric-directions-clicks"
              className="mt-1 text-lg font-extrabold text-blue-700 dark:text-blue-300"
            >
              {(basicTotals?.directionsClicks ?? 0).toLocaleString()}회
            </dd>
          </div>
          <div className="rounded-xl border border-slate-100 bg-slate-50/80 p-3 dark:border-slate-800 dark:bg-slate-800/40">
            <dt className="text-[11px] text-slate-500 dark:text-slate-400">결제 버튼 클릭 횟수</dt>
            <dd
              data-testid="basic-metric-payment-button-clicks"
              className="mt-1 text-lg font-extrabold text-purple-700 dark:text-purple-300"
            >
              {(basicTotals?.paymentButtonClicks ?? 0).toLocaleString()}회
            </dd>
            <dd className="mt-0.5 text-[10px] text-slate-500">실제 결제 성공 아님</dd>
          </div>
        </dl>

        <div className="space-y-2">
          <h3
            id="basic-daily-trend-heading"
            className="text-xs font-bold text-slate-700 dark:text-slate-300"
          >
            날짜별 전체 이용 횟수 (KST · 실행 횟수)
          </h3>
          {basicDailyTrend.length === 0 ? (
            <p
              data-testid="basic-daily-trend-empty"
              className="rounded-xl border border-dashed border-slate-300 py-5 text-center text-[11px] text-slate-500 dark:border-slate-700 dark:text-slate-400"
            >
              선택한 기간에 집계된 기본 이용 횟수가 없습니다.
            </p>
          ) : (
            <div
              tabIndex={0}
              role="region"
              aria-labelledby="basic-daily-trend-heading"
              className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800"
            >
              <table className="w-full border-collapse text-left text-[11px]">
                <thead className="bg-slate-50 text-slate-600 dark:bg-slate-800/70 dark:text-slate-300">
                  <tr>
                    <th scope="col" className="whitespace-nowrap px-3 py-2 font-semibold">
                      날짜 (KST)
                    </th>
                    <th scope="col" className="whitespace-nowrap px-2.5 py-2 text-right font-semibold">
                      지도 열림
                    </th>
                    <th scope="col" className="whitespace-nowrap px-2.5 py-2 text-right font-semibold">
                      검색 실행
                    </th>
                    <th scope="col" className="whitespace-nowrap px-2.5 py-2 text-right font-semibold">
                      핀 클릭
                    </th>
                    <th scope="col" className="whitespace-nowrap px-2.5 py-2 text-right font-semibold">
                      상세 조회
                    </th>
                    <th scope="col" className="whitespace-nowrap px-2.5 py-2 text-right font-semibold">
                      길찾기
                    </th>
                    <th scope="col" className="whitespace-nowrap px-3 py-2 text-right font-semibold">
                      결제버튼
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {basicDailyTrend.map((row) => (
                    <tr key={row.date} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/30">
                      <th
                        scope="row"
                        className="whitespace-nowrap px-3 py-2 font-mono font-semibold text-slate-900 dark:text-slate-100"
                      >
                        {row.date}
                      </th>
                      <td className="whitespace-nowrap px-2.5 py-2 text-right">{row.mapOpened}</td>
                      <td className="whitespace-nowrap px-2.5 py-2 text-right">{row.searchExecuted}</td>
                      <td className="whitespace-nowrap px-2.5 py-2 text-right">{row.markerClicks}</td>
                      <td className="whitespace-nowrap px-2.5 py-2 text-right">{row.detailOpened}</td>
                      <td className="whitespace-nowrap px-2.5 py-2 text-right font-semibold text-blue-700 dark:text-blue-300">
                        {row.directionsClicks}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right text-purple-700 dark:text-purple-300">
                        {row.paymentButtonClicks}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[10px] leading-relaxed text-slate-500 dark:text-slate-400">
            * 반복 클릭이나 새로고침이 포함될 수 있으며, 위 A 영역의 실행 횟수는 아래 B 영역의
            고유 브라우저 수와 합산하지 않습니다. 로그인 구분 필터도 이 영역에는 적용되지 않습니다.
          </p>
        </div>
      </section>

      {/* ================================================================ */}
      {/* B. 동의한 이용자의 상세 분석 (연결 행동 및 서버 거래 분리)           */}
      {/* ================================================================ */}
      <div
        data-testid="section-consented-analytics"
        className="space-y-4 rounded-2xl border border-slate-200/90 bg-slate-50/50 p-3 sm:p-4 dark:border-slate-800 dark:bg-slate-900/40"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">
              B. 동의한 이용자의 상세 분석 (선택 동의 기반 · 연결 행동)
            </h2>
            <p className="mt-0.5 text-[11px] text-slate-600 dark:text-slate-400">
              상세 분석에 동의한 브라우저의 연속 행동(지도 → 선택 → 상세 → 길찾기/결제버튼)만 집계합니다.
              동의율에 따라 전체 이용량(A)보다 표본 수가 적을 수 있습니다.
            </p>
          </div>
          <span className="rounded bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-800 dark:bg-blue-950/60 dark:text-blue-200">
            동의 브라우저 한정
          </span>
        </div>

      {/* 1. 서비스 이용 규모 */}
      <section
        data-testid="section-scale"
        aria-label="1. 서비스 이용 규모"
        className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 space-y-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-slate-900 dark:text-white">
            B-1. 서비스 이용 규모 (동의 브라우저 기준)
          </h3>
          <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            실측 건수
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2.5 break-keep">
          <div className="min-w-0 rounded-xl border border-slate-100 bg-slate-50/80 p-3 dark:border-slate-800 dark:bg-slate-800/40">
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              방문 브라우저 (익명)
            </p>
            <p
              data-testid="metric-visiting-browsers"
              className="mt-1 text-xl font-extrabold text-slate-900 dark:text-white"
            >
              {(ov?.visitingBrowsers ?? 0).toLocaleString()}
            </p>
            <p className="mt-0.5 text-[10px] text-slate-500">
              지도 로딩 브라우저 {(ov?.mapBrowsers ?? ov?.visitingBrowsers ?? 0).toLocaleString()}개
            </p>
          </div>

          <div className="min-w-0 rounded-xl border border-slate-100 bg-slate-50/80 p-3 dark:border-slate-800 dark:bg-slate-800/40">
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              지도 로딩 · 카드 노출
            </p>
            <p
              data-testid="metric-map-and-cards"
              className="mt-1 text-xl font-extrabold text-slate-900 dark:text-white"
            >
              {(ov?.mapViews ?? 0).toLocaleString()}
              <span className="ml-1 text-xs font-semibold text-slate-500">
                / {(ov?.cardClicks ?? 0).toLocaleString()}
              </span>
            </p>
            <p className="mt-0.5 text-[10px] text-slate-500">
              분석 동의 및 플래그 활성 시만 수집
            </p>
          </div>
        </div>
      </section>

      {/* B-2. 화장실 관심도 */}
      <section
        data-testid="section-interest"
        aria-label="B-2. 화장실 관심도"
        className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 space-y-3 break-keep"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-slate-900 dark:text-white">
            B-2. 화장실 관심도
          </h3>
          <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            횟수 / 고유 브라우저 구분
          </span>
        </div>

        <dl className="grid grid-cols-3 gap-2 text-xs">
          <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/50">
            <dt className="text-[11px] text-slate-500">핀 클릭</dt>
            <dd
              data-testid="metric-marker-clicks"
              className="mt-1 text-base font-extrabold text-slate-900 dark:text-white"
            >
              {(ov?.markerClicks ?? 0).toLocaleString()}회
            </dd>
            <dd className="mt-0.5 text-[10px] text-slate-500">
              브라우저 {(ov?.markerClickBrowsers ?? 0).toLocaleString()}개
            </dd>
          </div>
          <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/50">
            <dt className="text-[11px] text-slate-500">카드 실제 노출</dt>
            <dd
              data-testid="metric-card-views"
              className="mt-1 text-base font-extrabold text-slate-900 dark:text-white"
            >
              {(ov?.cardClicks ?? 0).toLocaleString()}회
            </dd>
            <dd className="mt-0.5 text-[10px] text-slate-500">
              브라우저 {(ov?.cardViewBrowsers ?? 0).toLocaleString()}개
            </dd>
          </div>
          <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/50">
            <dt className="text-[11px] text-slate-500">상세 조회</dt>
            <dd
              data-testid="metric-detail-views"
              className="mt-1 text-base font-extrabold text-slate-900 dark:text-white"
            >
              {(ov?.detailViews ?? 0).toLocaleString()}회
            </dd>
            <dd className="mt-0.5 text-[10px] text-slate-500">
              브라우저 {(ov?.detailViewBrowsers ?? 0).toLocaleString()}개
            </dd>
          </div>
        </dl>

        {/* 공공 vs 제휴 비교 */}
        <div className="space-y-2">
          <h3 className="text-xs font-bold text-slate-700 dark:text-slate-300">
            공공 · 제휴 화장실 비교
          </h3>
          <dl className="space-y-2 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-blue-50/70 px-3 py-2.5 dark:bg-blue-950/30">
              <dt className="shrink-0 whitespace-nowrap font-semibold text-blue-900 dark:text-blue-200">
                🏛️ 무료 공공
              </dt>
              <dd className="font-bold text-blue-950 dark:text-blue-100">
                핀 {byType?.public.markerClicks ?? 0} · 카드 {byType?.public.cardClicks ?? 0} · 상세{" "}
                {byType?.public.detailViews ?? 0} · 길찾기 {byType?.public.directionsClicks ?? 0}
              </dd>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-purple-50/70 px-3 py-2.5 dark:bg-purple-950/30">
              <dt className="shrink-0 whitespace-nowrap font-semibold text-purple-900 dark:text-purple-200">
                🤝 안심 제휴
              </dt>
              <dd className="font-bold text-purple-950 dark:text-purple-100">
                핀 {byType?.partner.markerClicks ?? 0} · 카드 {byType?.partner.cardClicks ?? 0} · 상세{" "}
                {byType?.partner.detailViews ?? 0} · 길찾기 {byType?.partner.directionsClicks ?? 0} · 결제버튼{" "}
                {byType?.partner.paymentButtonClicks ?? 0}
              </dd>
            </div>
          </dl>
        </div>

        {/* 화장실별 관심도 */}
        <div className="space-y-2" data-testid="restroom-interest-ranking">
          <h3 className="text-xs font-bold text-slate-700 dark:text-slate-300">
            화장실별 관심도 (상위 15개)
          </h3>
          {interestRanking.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-300 py-4 text-center text-[11px] text-slate-500 dark:border-slate-700">
              데이터 부족 — 선택한 기간에 화장실별 관심 이벤트가 없습니다.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
              <table className="w-full border-collapse text-left text-[11px]">
                <thead className="bg-slate-50 text-slate-600 dark:bg-slate-800/70 dark:text-slate-300">
                  <tr>
                    <th className="px-2.5 py-2 font-semibold">화장실</th>
                    <th className="px-2 py-2 font-semibold">구분</th>
                    <th className="px-2 py-2 text-right font-semibold">핀</th>
                    <th className="px-2 py-2 text-right font-semibold">카드</th>
                    <th className="px-2 py-2 text-right font-semibold">상세</th>
                    <th className="px-2 py-2 text-right font-semibold">길찾기</th>
                    <th className="px-2 py-2 text-right font-semibold">결제버튼</th>
                    <th className="px-2.5 py-2 text-right font-semibold">브라우저</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {interestRanking.map((row) => (
                    <tr key={row.restroomId}>
                      <td className="max-w-[140px] truncate px-2.5 py-2 font-medium text-slate-900 dark:text-slate-100">
                        {row.restroomName}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2">
                        {row.restroomType === "partner"
                          ? "제휴"
                          : row.restroomType === "public"
                          ? "공공"
                          : "-"}
                      </td>
                      <td className="px-2 py-2 text-right">{row.markerClicks}</td>
                      <td className="px-2 py-2 text-right">{row.cardViews}</td>
                      <td className="px-2 py-2 text-right">{row.detailViews}</td>
                      <td className="px-2 py-2 text-right font-semibold text-blue-700 dark:text-blue-300">
                        {row.directionsClicks}
                      </td>
                      <td className="px-2 py-2 text-right text-purple-700 dark:text-purple-300">
                        {row.paymentButtonClicks}
                      </td>
                      <td className="px-2.5 py-2 text-right">{row.distinctBrowsers}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* B-3. 이용 의사 */}
      <section
        data-testid="section-intent"
        aria-label="B-3. 이용 의사"
        className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 space-y-3 break-keep"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-slate-900 dark:text-white">
            B-3. 이용 의사 (실측 건수 vs 계산된 전환율)
          </h3>
          <span className="rounded bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-800 dark:bg-blue-950/60 dark:text-blue-200">
            동일 화장실·발생 순서 기준
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          <div className="rounded-xl border border-slate-100 bg-slate-50/80 p-3 dark:border-slate-800 dark:bg-slate-800/40">
            <p className="text-[11px] text-slate-500">상세 조회 · 길찾기 (실측)</p>
            <p
              data-testid="metric-detail-and-directions"
              className="mt-1 text-xl font-extrabold text-blue-700 dark:text-blue-400"
            >
              {(ov?.detailViews ?? 0).toLocaleString()}
              <span className="ml-1 text-xs font-semibold text-slate-500">
                / {(ov?.directionsClicks ?? 0).toLocaleString()}
              </span>
            </p>
            <p className="mt-0.5 text-[10px] text-slate-500">
              길찾기 고유 브라우저 {(ov?.directionsClickBrowsers ?? 0).toLocaleString()}개
            </p>
          </div>

          <div className="rounded-xl border border-slate-100 bg-slate-50/80 p-3 dark:border-slate-800 dark:bg-slate-800/40">
            <p className="text-[11px] text-slate-500">
              카드 노출→길찾기 전환율 (계산)
            </p>
            <p
              data-testid="metric-card-to-directions-rate"
              className="mt-1 text-xl font-extrabold text-slate-900 dark:text-white"
            >
              {formatRateOrInsufficient(ov?.cardToDirectionsRatePercent)}
            </p>
            <p className="mt-0.5 text-[10px] text-slate-500">
              노출 브라우저 {ov?.cardToDirectionsExposedBrowsers ?? 0}개 중{" "}
              {ov?.cardToDirectionsConvertedBrowsers ?? 0}개 동일 화장실 길찾기
            </p>
          </div>

          <div className="rounded-xl border border-slate-100 bg-slate-50/80 p-3 dark:border-slate-800 dark:bg-slate-800/40">
            <p className="text-[11px] text-slate-500">
              제휴 상세→결제버튼 비율 (계산)
            </p>
            <p
              data-testid="metric-partner-detail-to-payment-rate"
              className="mt-1 text-xl font-extrabold text-purple-700 dark:text-purple-400"
            >
              {formatRateOrInsufficient(ov?.partnerDetailToPaymentRatePercent)}
            </p>
            <p className="mt-0.5 text-[10px] text-slate-500">
              제휴 상세 브라우저 {ov?.partnerDetailExposedBrowsers ?? 0}개 중{" "}
              {ov?.partnerDetailToPaymentBrowsers ?? 0}개 결제버튼 클릭 (실결제 아님)
            </p>
          </div>
        </div>

        <div className="space-y-2" data-testid="directions-ranking">
          <h3 className="text-xs font-bold text-slate-700 dark:text-slate-300">
            화장실별 길찾기 클릭 순위
          </h3>
          {directionsRanking.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-300 py-4 text-center text-[11px] text-slate-500 dark:border-slate-700">
              데이터 부족 — 선택한 기간에 길찾기 클릭 기록이 없습니다.
            </p>
          ) : (
            <ol className="space-y-1.5">
              {directionsRanking.map((row, idx) => (
                <li
                  key={row.restroomId}
                  className="flex items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2 text-xs dark:bg-slate-800/50"
                >
                  <div className="min-w-0 flex-1">
                    <span className="mr-1.5 font-bold text-slate-500">
                      {idx + 1}.
                    </span>
                    <span className="font-semibold text-slate-900 dark:text-white">
                      {row.restroomName}
                    </span>
                    <span className="ml-1.5 rounded bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-900 dark:text-slate-300">
                      {row.restroomType === "partner" ? "제휴" : "공공"}
                    </span>
                  </div>
                  <span className="shrink-0 font-bold text-blue-700 dark:text-blue-300">
                    {row.directionsClicks}회 ({row.distinctBrowsers}브라우저)
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>

      {/* B-4. 기존 서버 기록 */}
      <section
        data-testid="section-server-records"
        aria-label="B-4. 기존 서버 기록"
        className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 space-y-3 break-keep"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-slate-900 dark:text-white">
            B-4. 기존 서버 거래 · 이용권 기록 (테스트 모드 기준)
          </h3>
          <span
            data-testid="server-records-filter-notice"
            className="rounded bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-950/60 dark:text-amber-200"
          >
            행동 분석 동의·로그인 필터 미적용 (서버 DB 전체 기준)
          </span>
        </div>

        <div className="rounded-xl border border-slate-100 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-800/50">
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            결제·이용권 / 영수증·환급 요약
          </p>
          <p
            data-testid="metric-payments-and-refunds"
            className="mt-1 text-xl font-extrabold text-purple-700 dark:text-purple-400"
          >
            {(ov?.approvedPayments ?? 0).toLocaleString()}
            <span className="ml-1 text-xs font-semibold text-slate-500">
              / {(ov?.submittedReceipts ?? 0).toLocaleString()}·{(ov?.refundsSucceeded ?? 0).toLocaleString()}
            </span>
          </p>
          <p className="mt-0.5 text-[10px] text-amber-700 dark:text-amber-300">
            테스트 결제 승인 {ov?.testModePayments ?? 0}건 (실제 금전 청구 아님)
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-xl bg-slate-50 px-3 py-2.5 dark:bg-slate-800/50">
            <dt className="text-[11px] text-slate-500">테스트 결제 승인 건수</dt>
            <dd
              data-testid="metric-test-mode-payments"
              className="mt-0.5 font-bold text-slate-900 dark:text-white"
            >
              {(ov?.testModePayments ?? 0).toLocaleString()}건
            </dd>
          </div>
          <div className="rounded-xl bg-slate-50 px-3 py-2.5 dark:bg-slate-800/50">
            <dt className="text-[11px] text-slate-500">이용권 발급 건수</dt>
            <dd
              data-testid="metric-issued-tickets"
              className="mt-0.5 font-bold text-slate-900 dark:text-white"
            >
              {(ov?.issuedTickets ?? 0).toLocaleString()}건
            </dd>
          </div>
          <div className="rounded-xl bg-slate-50 px-3 py-2.5 dark:bg-slate-800/50">
            <dt className="text-[11px] text-slate-500">영수증 제출 · 승인</dt>
            <dd className="mt-0.5 font-bold text-slate-900 dark:text-white">
              {ov?.submittedReceipts ?? 0} / {ov?.approvedReceipts ?? 0}건
            </dd>
          </div>
          <div className="rounded-xl bg-slate-50 px-3 py-2.5 dark:bg-slate-800/50">
            <dt className="text-[11px] text-slate-500">테스트 환급 완료</dt>
            <dd className="mt-0.5 font-bold text-emerald-700 dark:text-emerald-400">
              {ov?.refundsSucceeded ?? 0}건 (승인 대비{" "}
              {formatRateOrInsufficient(null, ov?.refundsSucceeded ?? 0, ov?.approvedReceipts ?? 0)})
            </dd>
          </div>
        </dl>
      </section>

      {/* 5. 일자별 추이 테이블 (KST) */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h2
          id="daily-trend-heading"
          className="text-sm font-bold text-slate-900 dark:text-white mb-3"
        >
          일자별 서비스 이용 추이 (KST)
        </h2>

        {dailyTrend.length === 0 ? (
          <p
            data-testid="daily-trend-empty"
            className="rounded-xl border border-dashed border-slate-300 py-8 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400"
          >
            데이터 부족 — 선택한 기간에 기록된 이용 이벤트나 거래 내역이 없습니다.
          </p>
        ) : (
          <div
            tabIndex={0}
            role="region"
            aria-labelledby="daily-trend-heading"
            className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800"
          >
            <table className="w-full border-collapse text-left text-[11px]">
              <thead className="bg-slate-50 text-slate-600 dark:bg-slate-800/70 dark:text-slate-300">
                <tr>
                  <th scope="col" className="whitespace-nowrap px-3 py-2.5 font-semibold">
                    날짜 (KST)
                  </th>
                  <th scope="col" className="whitespace-nowrap px-3 py-2.5 font-semibold text-right">
                    지도 브라우저
                  </th>
                  <th scope="col" className="whitespace-nowrap px-3 py-2.5 font-semibold text-right">
                    지도
                  </th>
                  <th scope="col" className="whitespace-nowrap px-3 py-2.5 font-semibold text-right">
                    핀
                  </th>
                  <th scope="col" className="whitespace-nowrap px-3 py-2.5 font-semibold text-right">
                    카드
                  </th>
                  <th scope="col" className="whitespace-nowrap px-3 py-2.5 font-semibold text-right">
                    상세
                  </th>
                  <th scope="col" className="whitespace-nowrap px-3 py-2.5 font-semibold text-right">
                    길찾기
                  </th>
                  <th scope="col" className="whitespace-nowrap px-3 py-2.5 font-semibold text-right">
                    결제버튼
                  </th>
                  <th scope="col" className="whitespace-nowrap px-3 py-2.5 font-semibold text-right">
                    테스트결제
                  </th>
                  <th scope="col" className="whitespace-nowrap px-3 py-2.5 font-semibold text-right">
                    이용권
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {dailyTrend.map((row) => (
                  <tr key={row.date} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/30">
                    <th
                      scope="row"
                      className="whitespace-nowrap px-3 py-2 font-mono font-semibold text-slate-900 dark:text-slate-100"
                    >
                      {row.date}
                    </th>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {row.mapBrowsers ?? row.visitingBrowsers}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">{row.mapViews}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">{row.markerClicks ?? 0}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">{row.cardClicks}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">{row.detailViews}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-semibold text-blue-700 dark:text-blue-300">
                      {row.directionsClicks}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right text-purple-700 dark:text-purple-300">
                      {row.paymentButtonClicks ?? 0}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {row.testModePayments ?? row.approvedPayments}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">{row.issuedTickets ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 6. 수집 환경 및 이벤트 기록 점검 */}
      <details
        data-testid="analytics-config-audit-box"
        className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
      >
        <summary className="cursor-pointer text-xs font-bold text-slate-800 dark:text-slate-200">
          이벤트 수집 설정 및 항목별 기록 상태 확인
        </summary>
        <div className="mt-3 space-y-2 border-t border-slate-100 pt-3 text-[11px] text-slate-600 dark:border-slate-800 dark:text-slate-400">
          <p>
            <strong>NEXT_PUBLIC_ANALYTICS_ENABLED:</strong>{" "}
            <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono dark:bg-slate-800">
              {cfg?.nextPublicAnalyticsEnabledEnv ?? "false"}
            </code>{" "}
            (<code>true</code>이고 사용자가 첫 방문 팝업 또는 <code>이용 통계 설정</code>에서 명시적으로
            동의한 경우에만 6개 선택적 행동 이벤트를 전송합니다. 결제·이용권·영수증·환급·보안 감사 기록은 이 설정과 무관하게 서버에 기록됩니다.)
          </p>
          <p>
            <strong>수집 중인 선택적 이벤트 (6종):</strong>{" "}
            {(report?.eventBreakdown ?? [])
              .filter((e) => e.rawEventCount > 0)
              .map(
                (e) =>
                  `${EVENT_NAME_LABELS[e.eventName] ?? e.eventName}: ${e.rawEventCount}회 (${e.distinctBrowserCount}브라우저)`
              )
              .join(", ") || "기간 내 이벤트 없음"}
          </p>
          <p>
            <strong>미수집 안내:</strong> 로그인 UI 이벤트, 여행 여부 설문(A19), 실시간 GPS 이동 경로,
            도어락 PIN, 영수증 원문, 결제 비밀정보는 행동 분석 로그에 수집되지 않습니다.
          </p>
        </div>
      </details>
      </div>
    </div>
  );
}
