"use client";

import React, { useId, useState } from "react";
import type {
  H1LeadMetricsSummary,
  LeadChannel,
  LeadContactAttempt,
  LeadContactResult,
  LeadFilterChannel,
  LeadFilterResult,
  LeadSummaryItem,
} from "@/lib/leads/types";

export interface LeadsAdminClientProps {
  initialItems: LeadSummaryItem[];
  initialMetrics: H1LeadMetricsSummary;
  initialError?: string | null;
}

const CHANNEL_LABELS: Record<LeadChannel, string> = {
  visit: "방문",
  phone: "전화",
  message: "메시지",
  email: "이메일",
};

const RESULT_LABELS: Record<LeadContactResult, string> = {
  no_answer: "응답 없음",
  rejected: "거절",
  interested: "관심 보임",
  agreed: "제휴 동의",
  follow_up: "추후 연락",
};

const RESULT_BADGE_CLASSES: Record<LeadContactResult, string> = {
  no_answer: "bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-200",
  rejected: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  interested: "bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300",
  agreed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  follow_up: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
};

export default function LeadsAdminClient({
  initialItems,
  initialMetrics,
  initialError = null,
}: LeadsAdminClientProps) {
  const searchInputId = useId();
  const resultFilterId = useId();
  const channelFilterId = useId();

  const [items, setItems] = useState<LeadSummaryItem[]>(initialItems);
  const [metrics, setMetrics] = useState<H1LeadMetricsSummary>(initialMetrics);
  const [bannerError, setBannerError] = useState<string | null>(initialError);
  const [bannerNotice, setBannerNotice] = useState<string | null>(null);

  // Filter states
  const [filterResult, setFilterResult] = useState<LeadFilterResult>("all");
  const [filterChannel, setFilterChannel] = useState<LeadFilterChannel>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoadingList, setIsLoadingList] = useState(false);

  // New lead form states
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [businessName, setBusinessName] = useState("");
  const [category, setCategory] = useState("");
  const [roadAddress, setRoadAddress] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [leadSource, setLeadSource] = useState("");
  const [isCreatingLead, setIsCreatingLead] = useState(false);

  // Contact attempt form states
  const [activeContactLeadId, setActiveContactLeadId] = useState<string | null>(
    null
  );
  const [contactChannel, setContactChannel] = useState<LeadChannel>("visit");
  const [contactResult, setContactResult] =
    useState<LeadContactResult>("interested");
  const [contactNotes, setContactNotes] = useState("");
  const [isSubmittingContact, setIsSubmittingContact] = useState(false);

  // Lead detail history states
  const [expandedDetailLeadId, setExpandedDetailLeadId] = useState<string | null>(
    null
  );
  const [detailAttempts, setDetailAttempts] = useState<LeadContactAttempt[]>([]);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);

  const fetchFilteredLeads = async (opts?: {
    result?: LeadFilterResult;
    channel?: LeadFilterChannel;
    q?: string;
  }) => {
    setIsLoadingList(true);
    setBannerError(null);
    try {
      const params = new URLSearchParams();
      const r = opts?.result ?? filterResult;
      const c = opts?.channel ?? filterChannel;
      const q = opts?.q ?? searchQuery;
      if (r !== "all") params.set("result", r);
      if (c !== "all") params.set("channel", c);
      if (q.trim().length > 0) params.set("q", q.trim());

      const response = await fetch(`/api/v1/admin/leads?${params.toString()}`, {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        setBannerError(
          payload?.error?.message ?? "리드 목록을 불러오지 못했습니다."
        );
        return;
      }
      setItems(payload.items ?? []);
      if (payload.metrics) {
        setMetrics(payload.metrics);
      }
    } catch {
      setBannerError("네트워크 오류로 리드 목록을 갱신하지 못했습니다.");
    } finally {
      setIsLoadingList(false);
    }
  };

  const handleCreateLead = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBannerError(null);
    setBannerNotice(null);

    if (!businessName.trim()) {
      setBannerError("가게명을 입력해 주세요.");
      return;
    }

    setIsCreatingLead(true);
    try {
      const response = await fetch("/api/v1/admin/leads", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": `lead-create-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`,
        },
        body: JSON.stringify({
          businessName: businessName.trim(),
          category: category.trim() || null,
          roadAddress: roadAddress.trim() || null,
          contactPhone: contactPhone.trim() || null,
          leadSource: leadSource.trim() || null,
        }),
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        setBannerError(
          payload?.error?.message ?? "가게 리드 등록에 실패했습니다."
        );
        return;
      }

      setBusinessName("");
      setCategory("");
      setRoadAddress("");
      setContactPhone("");
      setLeadSource("");
      setIsCreateOpen(false);
      setBannerNotice("신규 가게 리드가 등록되었습니다.");
      await fetchFilteredLeads();
    } catch {
      setBannerError("네트워크 오류로 리드를 등록하지 못했습니다.");
    } finally {
      setIsCreatingLead(false);
    }
  };

  const handleCreateContactAttempt = async (
    e: React.FormEvent<HTMLFormElement>,
    leadId: string
  ) => {
    e.preventDefault();
    setBannerError(null);
    setBannerNotice(null);
    setIsSubmittingContact(true);

    try {
      const response = await fetch(`/api/v1/admin/leads/${leadId}/contacts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": `lead-contact-${leadId}-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`,
        },
        body: JSON.stringify({
          channel: contactChannel,
          result: contactResult,
          notes: contactNotes.trim() || null,
        }),
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        setBannerError(
          payload?.error?.message ?? "연락 시도 기록 저장에 실패했습니다."
        );
        return;
      }

      setContactNotes("");
      setActiveContactLeadId(null);
      setBannerNotice(
        "연락 시도가 기록되었습니다. (동일 리드 중복 연락은 H1 고유 접촉 분모에 1곳으로만 집계됩니다.)"
      );
      await fetchFilteredLeads();
      if (expandedDetailLeadId === leadId) {
        await handleToggleDetail(leadId, true);
      }
    } catch {
      setBannerError("네트워크 오류로 연락 시도를 저장하지 못했습니다.");
    } finally {
      setIsSubmittingContact(false);
    }
  };

  const handleToggleDetail = async (leadId: string, forceReload = false) => {
    if (!forceReload && expandedDetailLeadId === leadId) {
      setExpandedDetailLeadId(null);
      setDetailAttempts([]);
      return;
    }

    setExpandedDetailLeadId(leadId);
    setIsLoadingDetail(true);
    try {
      const response = await fetch(`/api/v1/admin/leads/${leadId}`, {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.ok) {
        setDetailAttempts(payload.attempts ?? []);
      }
    } finally {
      setIsLoadingDetail(false);
    }
  };

  return (
    <div className="flex flex-col space-y-4">
      {/* H1 분모 및 리드 현황 요약 */}
      <section
        aria-label="H1 가게 접촉 모수 현황"
        className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">
            H1 가게 접촉 모수 현황 (관리자 전용)
          </h2>
          <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-[11px] font-semibold text-blue-800 dark:bg-blue-950/60 dark:text-blue-300">
            목표 모수 {metrics.targetDenominator}곳
          </span>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl bg-blue-50/80 p-2.5 dark:bg-blue-950/40">
            <p className="text-[11px] font-medium text-blue-800 dark:text-blue-300">
              고유 접촉 가게 (H1 분모)
            </p>
            <p
              data-testid="h1-distinct-contacted-count"
              className="mt-1 text-lg font-extrabold text-blue-700 dark:text-blue-300"
            >
              {metrics.distinctContactedLeadCount} / {metrics.targetDenominator}
            </p>
          </div>

          <div className="rounded-xl bg-slate-100 p-2.5 dark:bg-slate-800">
            <p className="text-[11px] font-medium text-slate-600 dark:text-slate-400">
              전체 등록 리드
            </p>
            <p
              data-testid="total-leads-count"
              className="mt-1 text-lg font-bold text-slate-900 dark:text-slate-100"
            >
              {metrics.totalLeadsCount}곳
            </p>
          </div>

          <div className="rounded-xl bg-slate-100 p-2.5 dark:bg-slate-800">
            <p className="text-[11px] font-medium text-slate-600 dark:text-slate-400">
              누적 연락 시도
            </p>
            <p
              data-testid="total-attempts-count"
              className="mt-1 text-lg font-bold text-slate-900 dark:text-slate-100"
            >
              {metrics.totalContactAttemptCount}회
            </p>
          </div>
        </div>

        <p className="mt-2.5 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
          * H1 최초 분모는 연락 시도가 1회 이상 존재하는 <strong>고유 가게 리드 수</strong>입니다. 동일 가게에 여러 번 연락해도 분모에는 1곳으로만 집계됩니다.
        </p>
      </section>

      {bannerError && (
        <div
          role="alert"
          className="rounded-xl border border-rose-300 bg-rose-50 p-3 text-xs font-medium text-rose-900 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-200"
        >
          {bannerError}
        </div>
      )}

      {bannerNotice && (
        <div
          role="status"
          className="rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-xs font-medium text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200"
        >
          {bannerNotice}
        </div>
      )}

      {/* 신규 리드 추가 토글 및 폼 */}
      <div>
        <button
          type="button"
          onClick={() => setIsCreateOpen((prev) => !prev)}
          className="flex min-h-[44px] w-full items-center justify-center rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-semibold text-white shadow-sm hover:bg-blue-700"
        >
          {isCreateOpen ? "▲ 신규 가게 리드 등록 닫기" : "+ 신규 가게 리드 추가"}
        </button>

        {isCreateOpen && (
          <form
            onSubmit={handleCreateLead}
            className="mt-2 space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
          >
            <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100">
              접촉 대상 가게 리드 등록 (비공개 연락처 보호)
            </h3>

            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700 dark:text-slate-300">
                가게명 <span className="text-rose-600">*</span>
              </label>
              <input
                name="businessName"
                type="text"
                required
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                placeholder="예: 행궁 커피공방"
                className="min-h-[44px] w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700 dark:text-slate-300">
                  업종
                </label>
                <input
                  name="category"
                  type="text"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="카페 / 음식점"
                  className="min-h-[44px] w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700 dark:text-slate-300">
                  확보 경로
                </label>
                <input
                  name="leadSource"
                  type="text"
                  value={leadSource}
                  onChange={(e) => setLeadSource(e.target.value)}
                  placeholder="현장 답사 / 지도 검색"
                  className="min-h-[44px] w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800"
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700 dark:text-slate-300">
                도로명주소
              </label>
              <input
                name="roadAddress"
                type="text"
                value={roadAddress}
                onChange={(e) => setRoadAddress(e.target.value)}
                placeholder="경기도 수원시 팔달구 ..."
                className="min-h-[44px] w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700 dark:text-slate-300">
                문의 연락처 (관리자 전용 비공개)
              </label>
              <input
                name="contactPhone"
                type="tel"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                placeholder="031-000-0000"
                className="min-h-[44px] w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800"
              />
            </div>

            <button
              type="submit"
              disabled={isCreatingLead}
              className="flex min-h-[44px] w-full items-center justify-center rounded-lg bg-emerald-700 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              {isCreatingLead ? "등록 중..." : "리드 저장"}
            </button>
          </form>
        )}
      </div>

      {/* 필터 바 */}
      <section
        aria-label="리드 목록 필터"
        className="space-y-2.5 rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label
              htmlFor={resultFilterId}
              className="mb-1 block text-[11px] font-semibold text-slate-600 dark:text-slate-400"
            >
              최근 연락 결과
            </label>
            <select
              id={resultFilterId}
              value={filterResult}
              onChange={(e) => {
                const next = e.target.value as LeadFilterResult;
                setFilterResult(next);
                void fetchFilteredLeads({ result: next });
              }}
              className="min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs dark:border-slate-700 dark:bg-slate-800"
            >
              <option value="all">전체 상태</option>
              <option value="uncontacted">미접촉 (시도 0건)</option>
              <option value="no_answer">응답 없음</option>
              <option value="rejected">거절</option>
              <option value="interested">관심 보임</option>
              <option value="agreed">제휴 동의</option>
              <option value="follow_up">추후 연락</option>
            </select>
          </div>

          <div>
            <label
              htmlFor={channelFilterId}
              className="mb-1 block text-[11px] font-semibold text-slate-600 dark:text-slate-400"
            >
              연락 채널
            </label>
            <select
              id={channelFilterId}
              value={filterChannel}
              onChange={(e) => {
                const next = e.target.value as LeadFilterChannel;
                setFilterChannel(next);
                void fetchFilteredLeads({ channel: next });
              }}
              className="min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs dark:border-slate-700 dark:bg-slate-800"
            >
              <option value="all">전체 채널</option>
              <option value="visit">방문</option>
              <option value="phone">전화</option>
              <option value="message">메시지</option>
              <option value="email">이메일</option>
            </select>
          </div>
        </div>

        <div className="flex gap-2">
          <label htmlFor={searchInputId} className="sr-only">
            가게명 또는 주소 검색
          </label>
          <input
            id={searchInputId}
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="가게명, 업종, 주소 검색"
            className="min-h-[44px] flex-1 rounded-lg border border-slate-300 px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-800"
          />
          <button
            type="button"
            onClick={() => void fetchFilteredLeads()}
            disabled={isLoadingList}
            className="min-h-[44px] rounded-lg bg-slate-800 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-900 disabled:opacity-50 dark:bg-slate-700"
          >
            {isLoadingList ? "조회 중..." : "검색"}
          </button>
        </div>
      </section>

      {/* 리드 목록 */}
      <section aria-label="가게 리드 목록" className="space-y-2.5">
        {items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-center text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
            조건에 해당하는 가게 리드가 없습니다. (가짜 시드 데이터를 사용하지 않으며 실제 접촉 대상을 등록해 관리합니다.)
          </div>
        ) : (
          items.map((lead) => {
            const latest = lead.latest_attempt;
            const isContactFormOpen = activeContactLeadId === lead.id;
            const isDetailOpen = expandedDetailLeadId === lead.id;

            return (
              <article
                key={lead.id}
                className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                      {lead.business_name}
                    </h3>
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      {lead.category || "업종 미지정"} ·{" "}
                      {lead.road_address || "주소 미입력"}
                    </p>
                    {lead.contact_phone && (
                      <p className="mt-1 text-[11px] text-slate-600 dark:text-slate-400">
                        🔒 비공개 연락처: {lead.contact_phone}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-col items-end gap-1">
                    {latest ? (
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                          RESULT_BADGE_CLASSES[latest.result]
                        }`}
                      >
                        {RESULT_LABELS[latest.result]} (
                        {CHANNEL_LABELS[latest.channel]})
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                        미접촉
                      </span>
                    )}
                    <span className="text-[11px] text-slate-500">
                      연락 시도 {lead.attempt_count}회
                      {lead.has_contact_attempt ? " (H1 모수 1곳 반영)" : ""}
                    </span>
                  </div>
                </div>

                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setActiveContactLeadId(isContactFormOpen ? null : lead.id)
                    }
                    className="flex min-h-[44px] flex-1 items-center justify-center rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-800 hover:bg-blue-100 dark:border-blue-900 dark:bg-blue-950/50 dark:text-blue-300"
                  >
                    {isContactFormOpen ? "연락 기록 닫기" : "📞 연락 시도 기록"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleToggleDetail(lead.id)}
                    className="flex min-h-[44px] items-center justify-center rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                  >
                    {isDetailOpen ? "이력 접기" : `이력 (${lead.attempt_count})`}
                  </button>
                </div>

                {isContactFormOpen && (
                  <form
                    onSubmit={(e) => handleCreateContactAttempt(e, lead.id)}
                    className="mt-3 space-y-2.5 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/60"
                  >
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="mb-1 block text-[11px] font-semibold text-slate-700 dark:text-slate-300">
                          채널
                        </label>
                        <select
                          value={contactChannel}
                          onChange={(e) =>
                            setContactChannel(e.target.value as LeadChannel)
                          }
                          className="min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs dark:border-slate-700 dark:bg-slate-900"
                        >
                          <option value="visit">방문</option>
                          <option value="phone">전화</option>
                          <option value="message">메시지</option>
                          <option value="email">이메일</option>
                        </select>
                      </div>

                      <div>
                        <label className="mb-1 block text-[11px] font-semibold text-slate-700 dark:text-slate-300">
                          결과
                        </label>
                        <select
                          value={contactResult}
                          onChange={(e) =>
                            setContactResult(e.target.value as LeadContactResult)
                          }
                          className="min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs dark:border-slate-700 dark:bg-slate-900"
                        >
                          <option value="interested">관심 보임</option>
                          <option value="agreed">제휴 동의</option>
                          <option value="follow_up">추후 연락</option>
                          <option value="no_answer">응답 없음</option>
                          <option value="rejected">거절</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="mb-1 block text-[11px] font-semibold text-slate-700 dark:text-slate-300">
                        비공개 상담 메모 (관리자 전용)
                      </label>
                      <input
                        type="text"
                        value={contactNotes}
                        onChange={(e) => setContactNotes(e.target.value)}
                        placeholder="담당자 반응 및 재방문 일정 메모"
                        className="min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-900"
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={isSubmittingContact}
                      className="flex min-h-[44px] w-full items-center justify-center rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {isSubmittingContact
                        ? "저장 중..."
                        : "연락 시도 결과 저장"}
                    </button>
                  </form>
                )}

                {isDetailOpen && (
                  <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs dark:border-slate-700 dark:bg-slate-800/50">
                    <p className="font-semibold text-slate-800 dark:text-slate-200">
                      연락 시도 상세 이력
                    </p>
                    {isLoadingDetail ? (
                      <p className="mt-1 text-slate-500">불러오는 중...</p>
                    ) : detailAttempts.length === 0 ? (
                      <p className="mt-1 text-slate-500">
                        아직 기록된 연락 시도가 없습니다.
                      </p>
                    ) : (
                      <ul className="mt-2 space-y-1.5">
                        {detailAttempts.map((att) => (
                          <li
                            key={att.id}
                            className="rounded-lg border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-900"
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-semibold">
                                [{CHANNEL_LABELS[att.channel]}]{" "}
                                {RESULT_LABELS[att.result]}
                              </span>
                              <span className="text-[11px] text-slate-500">
                                {new Date(att.contacted_at).toLocaleString(
                                  "ko-KR"
                                )}
                              </span>
                            </div>
                            {att.notes && (
                              <p className="mt-1 text-[11px] text-slate-600 dark:text-slate-400">
                                메모: {att.notes}
                              </p>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </article>
            );
          })
        )}
      </section>
    </div>
  );
}

