"use client";

import React, { useState, useEffect, useCallback } from "react";
import type { PmfReportData } from "@/lib/analytics/types";

const EVENT_NAME_LABELS: Record<string, string> = {
  landing_view: "랜딩 페이지 조회 (landing_view)",
  map_loaded: "지도 타일 로드 (map_loaded)",
  restroom_marker_clicked: "화장실 마커 클릭 (restroom_marker_clicked)",
  restroom_card_viewed: "화장실 카드 노출 (restroom_card_viewed)",
  restroom_detail_opened: "화장실 상세 열람 (restroom_detail_opened)",
  directions_clicked: "길찾기 실행 (directions_clicked)",
  travel_answer_submitted: "여행 여부 응답 (travel_answer_submitted)",
  payment_button_clicked: "보증금 결제 버튼 클릭 (payment_button_clicked)",
  payment_unavailable_shown: "결제 준비 중 안내 노출 (payment_unavailable_shown)",
};

export default function PmfDashboardClient() {
  const [report, setReport] = useState<PmfReportData | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [experimentKey, setExperimentKey] = useState<string>("pmf_r1");
  const [includeTest, setIncludeTest] = useState<boolean>(false);

  const fetchReport = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const sp = new URLSearchParams();
      sp.set("experimentKey", experimentKey);
      if (includeTest) {
        sp.set("includeTest", "true");
      }

      const res = await fetch(`/api/v1/admin/analytics/pmf?${sp.toString()}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });

      const body = await res.json();
      if (!res.ok) {
        throw new Error(body?.error?.message || `조회 실패 (${res.status})`);
      }

      setReport(body.data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "지표 데이터를 불러올 수 없습니다."
      );
    } finally {
      setIsLoading(false);
    }
  }, [experimentKey, includeTest]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  const formatDateKst = (isoString?: string | null) => {
    if (!isoString) return "-";
    try {
      const d = new Date(isoString);
      return new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Seoul",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(d);
    } catch {
      return isoString;
    }
  };

  return (
    <div
      data-testid="pmf-dashboard-container"
      className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-3 py-4 sm:px-6"
    >
      {/* 1. 상단 안내: rulesComplete = false 잠정 집계 경고 배너 */}
      <section
        data-testid="pmf-provisional-warning-banner"
        role="alert"
        className="rounded-2xl border-2 border-amber-400 bg-amber-50 p-4 text-amber-950 shadow-sm dark:border-amber-600 dark:bg-amber-950/60 dark:text-amber-100"
      >
        <div className="flex items-start gap-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-400 text-xs font-black text-amber-950 dark:bg-amber-500">
            !
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-bold sm:text-base">
                PMF 가설 잠정 집계 상태 (rulesComplete = false)
              </h2>
              <span className="inline-flex items-center rounded-md bg-amber-200 px-2 py-0.5 text-[11px] font-bold text-amber-900 dark:bg-amber-800 dark:text-amber-200">
                판정 보류
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-amber-900/90 dark:text-amber-200/90">
              판정 원문의 19개 세부 규칙이 시스템에 아직 최종 수록되지 않았습니다.
              따라서 PMF 최종 PASS/FAIL 판정을 확정하지 않으며, 현재 관찰 기간 내의
              순수 수집 데이터와 잠정 전환율만 표기합니다.
            </p>
          </div>
        </div>
      </section>

      {/* 2. 실험 메타데이터 및 필터 바 */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                실험 코드:
              </span>
              <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-mono font-bold text-slate-800 dark:bg-slate-800 dark:text-slate-200">
                {report?.experiment.experimentKey ?? experimentKey}
              </span>
              <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-bold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                {report?.experiment.status === "running" ? "관찰 진행 중" : "초안/준비"}
              </span>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              <span className="font-semibold">관찰 기간:</span>{" "}
              {formatDateKst(report?.observationWindow.startsAt ?? "2026-11-05T00:00:00Z")} ~{" "}
              {formatDateKst(report?.observationWindow.endsAt ?? "2026-11-18T14:59:59Z")} (KST)
            </p>
            <p className="text-[11px] text-slate-500 dark:text-slate-500">
              적용 규칙 버전: {report?.experiment.rulesVersion ?? "2026-11-04_agreed_metrics"}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-2 sm:pt-0">
            <label className="flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={includeTest}
                onChange={(e) => setIncludeTest(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800"
              />
              <span>테스트 데이터(is_test) 포함</span>
            </label>

            <button
              type="button"
              onClick={fetchReport}
              disabled={isLoading}
              data-testid="pmf-refresh-btn"
              className="flex min-h-[38px] items-center justify-center rounded-xl bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-200 active:scale-95 disabled:opacity-50 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              {isLoading ? "새로고침 중..." : "새로고침"}
            </button>
          </div>
        </div>
      </section>

      {/* 에러 상태 */}
      {error && (
        <div
          role="alert"
          className="rounded-2xl border border-rose-300 bg-rose-50 p-4 text-xs font-medium text-rose-800 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-200"
        >
          {error}
        </div>
      )}

      {/* 로딩 상태 */}
      {isLoading && !report && (
        <div className="flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white p-8 text-center text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
          <p>PMF 실험 지표를 집계하고 있습니다...</p>
        </div>
      )}

      {/* 3. 핵심 가설 지표 카드 (H1, H2, H5) */}
      {report && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {/* Card H1 */}
          <div
            data-testid="hypothesis-card-h1"
            className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
          >
            <div>
              <div className="flex items-center justify-between">
                <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-bold text-blue-800 dark:bg-blue-950 dark:text-blue-300">
                  {report.hypotheses.h1.hypothesisKey}
                </span>
                <span
                  data-testid="hypothesis-h1-status"
                  className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                    report.hypotheses.h1.isSufficientData
                      ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                      : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
                  }`}
                >
                  {report.hypotheses.h1.isSufficientData
                    ? "잠정 집계 (판정 보류)"
                    : "모수 부족 (0/50)"}
                </span>
              </div>

              <h3 className="mt-2 text-sm font-bold text-slate-900 dark:text-slate-100">
                {report.hypotheses.h1.name}
              </h3>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {report.hypotheses.h1.definition}
              </p>

              <div className="mt-4">
                <div className="flex items-baseline justify-between">
                  <span className="text-2xl font-black text-slate-900 dark:text-white">
                    {report.hypotheses.h1.numeratorCount}{" "}
                    <span className="text-xs font-normal text-slate-500">
                      / {report.hypotheses.h1.denominatorCount}곳 접촉
                    </span>
                  </span>
                  <span className="text-sm font-bold text-blue-600 dark:text-blue-400">
                    {report.hypotheses.h1.conversionRatePercent}%
                  </span>
                </div>

                {/* Progress bar */}
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div
                    className="h-full bg-blue-600 transition-all duration-300"
                    style={{
                      width: `${Math.min(
                        100,
                        (report.hypotheses.h1.numeratorCount /
                          report.hypotheses.h1.targetNumerator) *
                          100
                      )}%`,
                    }}
                  />
                </div>
                <div className="mt-1 flex justify-between text-[11px] text-slate-400">
                  <span>현재: {report.hypotheses.h1.numeratorCount}곳 승인</span>
                  <span>목표: {report.hypotheses.h1.targetNumerator}곳 (10%)</span>
                </div>
              </div>
            </div>

            <div className="mt-4 border-t border-slate-100 pt-3 text-[11px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
              분모: 연락 시도 1회 이상 고유 리드
              <br />
              분자: 정식 검수 완료된 승인 가게
            </div>
          </div>

          {/* Card H2 */}
          <div
            data-testid="hypothesis-card-h2"
            className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
          >
            <div>
              <div className="flex items-center justify-between">
                <span className="rounded bg-indigo-100 px-2 py-0.5 text-xs font-bold text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300">
                  {report.hypotheses.h2.hypothesisKey}
                </span>
                <span
                  data-testid="hypothesis-h2-status"
                  className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                    report.hypotheses.h2.isSufficientData
                      ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                      : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
                  }`}
                >
                  {report.hypotheses.h2.isSufficientData
                    ? "잠정 집계 (판정 보류)"
                    : "모수 부족 (0/50)"}
                </span>
              </div>

              <h3 className="mt-2 text-sm font-bold text-slate-900 dark:text-slate-100">
                {report.hypotheses.h2.name}
              </h3>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {report.hypotheses.h2.definition}
              </p>

              <div className="mt-4">
                <div className="flex items-baseline justify-between">
                  <span className="text-2xl font-black text-slate-900 dark:text-white">
                    {report.hypotheses.h2.numeratorCount}{" "}
                    <span className="text-xs font-normal text-slate-500">
                      / {report.hypotheses.h2.denominatorCount}명 대상
                    </span>
                  </span>
                  <span className="text-sm font-bold text-indigo-600 dark:text-indigo-400">
                    {report.hypotheses.h2.conversionRatePercent}%
                  </span>
                </div>

                {/* Progress bar */}
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div
                    className="h-full bg-indigo-600 transition-all duration-300"
                    style={{
                      width: `${Math.min(
                        100,
                        (report.hypotheses.h2.numeratorCount /
                          report.hypotheses.h2.targetNumerator) *
                          100
                      )}%`,
                    }}
                  />
                </div>
                <div className="mt-1 flex justify-between text-[11px] text-slate-400">
                  <span>현재: {report.hypotheses.h2.numeratorCount}명 실행</span>
                  <span>목표: {report.hypotheses.h2.targetNumerator}명 (10%)</span>
                </div>
              </div>
            </div>

            <div
              data-testid="hypothesis-h2-exclusions"
              className="mt-4 border-t border-slate-100 pt-3 text-[11px] text-slate-500 dark:border-slate-800 dark:text-slate-400"
            >
              자연 유입(비광고) 제외: {report.hypotheses.h2.excludedOrganicCount}명
              <br />
              비여행자 제외: {report.hypotheses.h2.excludedNonTravelingCount}명
            </div>
          </div>

          {/* Card H5 */}
          <div
            data-testid="hypothesis-card-h5"
            className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
          >
            <div>
              <div className="flex items-center justify-between">
                <span className="rounded bg-teal-100 px-2 py-0.5 text-xs font-bold text-teal-800 dark:bg-teal-950 dark:text-teal-300">
                  {report.hypotheses.h5.hypothesisKey}
                </span>
                <span
                  data-testid="hypothesis-h5-status"
                  className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                    report.hypotheses.h5.isSufficientData
                      ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                      : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
                  }`}
                >
                  {report.hypotheses.h5.isSufficientData
                    ? "잠정 집계 (판정 보류)"
                    : "모수 부족 (0/50)"}
                </span>
              </div>

              <h3 className="mt-2 text-sm font-bold text-slate-900 dark:text-slate-100">
                {report.hypotheses.h5.name}
              </h3>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {report.hypotheses.h5.definition}
              </p>

              <div className="mt-4">
                <div className="flex items-baseline justify-between">
                  <span className="text-2xl font-black text-slate-900 dark:text-white">
                    {report.hypotheses.h5.numeratorCount}{" "}
                    <span className="text-xs font-normal text-slate-500">
                      / {report.hypotheses.h5.denominatorCount}명 노출
                    </span>
                  </span>
                  <span className="text-sm font-bold text-teal-600 dark:text-teal-400">
                    {report.hypotheses.h5.conversionRatePercent}%
                  </span>
                </div>

                {/* Progress bar */}
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div
                    className="h-full bg-teal-600 transition-all duration-300"
                    style={{
                      width: `${Math.min(
                        100,
                        (report.hypotheses.h5.numeratorCount /
                          report.hypotheses.h5.targetNumerator) *
                          100
                      )}%`,
                    }}
                  />
                </div>
                <div className="mt-1 flex justify-between text-[11px] text-slate-400">
                  <span>현재: {report.hypotheses.h5.numeratorCount}명 실행</span>
                  <span>목표: {report.hypotheses.h5.targetNumerator}명 (10%)</span>
                </div>
              </div>
            </div>

            <div
              data-testid="hypothesis-h5-exclusions"
              className="mt-4 border-t border-slate-100 pt-3 text-[11px] text-slate-500 dark:border-slate-800 dark:text-slate-400"
            >
              공공 화장실 길찾기 제외: {report.hypotheses.h5.excludedPublicDirectionsCount}건
              <br />
              타 제휴 화장실 길찾기 제외: {report.hypotheses.h5.excludedMismatchedPartnerDirectionsCount}건
            </div>
          </div>
        </div>
      )}

      {/* 4. 데이터 0건 안내 (Empty State) */}
      {report && report.summary.totalEvents === 0 && (
        <div
          data-testid="pmf-empty-state"
          className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center dark:border-slate-700 dark:bg-slate-900/50"
        >
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-slate-200 text-xl text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            📊
          </div>
          <h4 className="mt-3 text-sm font-bold text-slate-800 dark:text-slate-200">
            수집된 실험 데이터가 없습니다
          </h4>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            실험 관찰 기간 동안 방문자 트래픽이 유입되거나 제휴 활동이 기록되면
            자동으로 집계됩니다.
          </p>
        </div>
      )}

      {/* 5. 이벤트별 집계 및 전환 흐름 테이블 */}
      {report && (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                관찰 이벤트별 집계 현황
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                총 이벤트 수: {report.summary.totalEvents}건 | 고유 브라우저:{" "}
                {report.summary.distinctBrowsers}명 | 세션:{" "}
                {report.summary.distinctSessions}건 (제외된 테스트 이벤트:{" "}
                {report.summary.excludedTestEvents}건)
              </p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table
              data-testid="pmf-event-breakdown-table"
              className="w-full text-left text-xs"
            >
              <thead className="border-b border-slate-200 text-slate-500 dark:border-slate-800 dark:text-slate-400">
                <tr>
                  <th className="py-2.5 pr-4 font-semibold">이벤트 구분</th>
                  <th className="py-2.5 px-4 text-right font-semibold">
                    총 발생 횟수 (Raw)
                  </th>
                  <th className="py-2.5 pl-4 text-right font-semibold">
                    고유 브라우저 수 (Unique)
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/50">
                {report.eventBreakdown.map((row) => (
                  <tr
                    key={row.eventName}
                    className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40"
                  >
                    <td className="py-2.5 pr-4 font-medium text-slate-800 dark:text-slate-200">
                      {EVENT_NAME_LABELS[row.eventName] ?? row.eventName}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono font-bold text-slate-900 dark:text-slate-100">
                      {row.rawEventCount.toLocaleString()}
                    </td>
                    <td className="py-2.5 pl-4 text-right font-mono text-slate-600 dark:text-slate-400">
                      {row.distinctBrowserCount.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

