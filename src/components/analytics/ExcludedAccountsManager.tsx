"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AccountCandidateItem,
  ExcludedAccountItem,
  ExcludedAccountsOverview,
} from "@/lib/analytics/exclusions";

interface ExcludedAccountsManagerProps {
  onExclusionsChanged?: () => void;
}

function formatKstDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "-";
  try {
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return iso.slice(0, 16);
  }
}

export default function ExcludedAccountsManager({
  onExclusionsChanged,
}: ExcludedAccountsManagerProps) {
  const [overview, setOverview] = useState<ExcludedAccountsOverview | null>(null);
  const [searchInput, setSearchInput] = useState<string>("");
  const [appliedQuery, setAppliedQuery] = useState<string>("");
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [noteInput, setNoteInput] = useState<string>("");

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [togglingUserId, setTogglingUserId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const fetchOverview = useCallback(async (queryText: string) => {
    setIsLoading(true);
    try {
      const sp = new URLSearchParams();
      if (queryText.trim()) {
        sp.set("q", queryText.trim());
      }
      sp.set("limit", "50");

      const res = await fetch(
        `/api/v1/admin/analytics/excluded-accounts?${sp.toString()}`,
        {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
        }
      );

      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        throw new Error(
          body?.error?.message || `제외 계정 설정을 불러오지 못했습니다 (${res.status})`
        );
      }

      setOverview(body.data);
    } catch (err) {
      setFeedback({
        type: "error",
        message:
          err instanceof Error
            ? err.message
            : "통계 제외 계정 목록을 불러오지 못했습니다.",
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchOverview(appliedQuery);
  }, [fetchOverview, appliedQuery]);

  const excludedAccounts = useMemo(
    () => overview?.excludedAccounts ?? [],
    [overview]
  );
  const activeExcludedAccounts = useMemo(
    () => excludedAccounts.filter((item) => item.isActive),
    [excludedAccounts]
  );
  const inactiveExcludedAccounts = useMemo(
    () => excludedAccounts.filter((item) => !item.isActive),
    [excludedAccounts]
  );
  const candidates = useMemo(() => overview?.candidates ?? [], [overview]);

  const toggleCandidateSelection = (userId: string) => {
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setAppliedQuery(searchInput.trim());
  };

  const handleRegisterSelected = async () => {
    const userIds = Array.from(selectedUserIds);
    if (userIds.length === 0 || isSubmitting) return;

    setIsSubmitting(true);
    setFeedback(null);

    try {
      const idempotencyKey =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `ex-reg-${Date.now()}`;

      const res = await fetch("/api/v1/admin/analytics/excluded-accounts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          userIds,
          note: noteInput.trim() ? noteInput.trim() : null,
        }),
      });

      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        throw new Error(
          body?.error?.message || `제외 계정 등록에 실패했습니다 (${res.status})`
        );
      }

      setSelectedUserIds(new Set());
      setNoteInput("");
      setFeedback({
        type: "success",
        message: `${body.data?.registeredCount ?? userIds.length}개 계정을 이용 통계 제외 대상으로 저장했습니다.`,
      });
      await fetchOverview(appliedQuery);
      onExclusionsChanged?.();
    } catch (err) {
      setFeedback({
        type: "error",
        message:
          err instanceof Error
            ? err.message
            : "제외 계정 저장 중 오류가 발생했습니다.",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggleAccountActive = async (
    item: ExcludedAccountItem,
    nextActive: boolean
  ) => {
    if (togglingUserId) return;
    setTogglingUserId(item.userId);
    setFeedback(null);

    try {
      const idempotencyKey =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `ex-upd-${Date.now()}`;

      const res = await fetch(
        `/api/v1/admin/analytics/excluded-accounts/${encodeURIComponent(item.userId)}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "x-idempotency-key": idempotencyKey,
          },
          body: JSON.stringify({ isActive: nextActive }),
        }
      );

      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        throw new Error(
          body?.error?.message || `제외 설정 변경에 실패했습니다 (${res.status})`
        );
      }

      setFeedback({
        type: "success",
        message: nextActive
          ? `${item.email || item.displayName || item.userId} 계정을 다시 통계에서 제외했습니다.`
          : `${item.email || item.displayName || item.userId} 계정의 통계 제외 설정을 해제했습니다.`,
      });
      await fetchOverview(appliedQuery);
      onExclusionsChanged?.();
    } catch (err) {
      setFeedback({
        type: "error",
        message:
          err instanceof Error
            ? err.message
            : "통계 제외 상태 변경 중 오류가 발생했습니다.",
      });
    } finally {
      setTogglingUserId(null);
    }
  };

  const renderCandidateLabel = (c: AccountCandidateItem) => {
    return c.email || c.displayName || c.userId;
  };

  return (
    <section
      data-testid="section-excluded-accounts"
      aria-label="관리자 테스트 계정 이용 통계 제외 설정"
      className="rounded-2xl border border-indigo-200 bg-white p-4 shadow-sm dark:border-indigo-900/60 dark:bg-slate-900 space-y-3 break-keep"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white">
            테스트 계정 이용 통계 제외 설정 (관리자 전용)
          </h2>
          <p className="mt-0.5 text-[11px] text-slate-600 dark:text-slate-400">
            운영·시연·QA에 사용하는 테스트 계정을 선택해 실제 이용 통계(A 및 B-1~B-4)에서 제외합니다.
            개수 제한 없이 추가·해제할 수 있습니다.
          </p>
        </div>
        <span
          data-testid="excluded-accounts-active-count"
          className="shrink-0 rounded-lg bg-indigo-50 px-2.5 py-1 text-[11px] font-bold text-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-200"
        >
          현재 제외 계정 {overview?.activeCount ?? activeExcludedAccounts.length}개
        </span>
      </div>

      {/* 필수 한계 및 동작 원칙 고지 */}
      <div
        data-testid="excluded-accounts-policy-notice"
        className="rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-[11px] leading-relaxed text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200 space-y-1"
      >
        <p>
          • <strong>과거 기본 이용 통계(A. 전체 이용량) 소급 제외 불가:</strong> 기본 통계는 계정
          식별자 없이 일별 합계만 저장하므로 과거 수치에서 특정 계정의 활동만 차감할 수 없습니다.
          제외 설정 저장 이후 <strong>로그인 상태</strong>에서 발생한 활동부터 집계 전 제외됩니다.
        </p>
        <p>
          • <strong>로그아웃 상태 활동은 자동 제외 불가:</strong> 로그아웃(비로그인) 상태에서 이용한
          활동은 계정을 판별할 수 없으므로 비회원 이용량으로 정상 집계됩니다.
        </p>
        <p>
          • <strong>상세 분석(B-1~B-3) 및 서버 거래(B-4):</strong> 계정과 실제로 연결된 과거·미래
          기록만 리포트에서 필터링되며, 로그인 전 익명 기록과 원본 결제·환급·감사 데이터는 보존됩니다.
        </p>
      </div>

      {feedback && (
        <div
          role={feedback.type === "error" ? "alert" : "status"}
          data-testid="excluded-accounts-feedback"
          className={`rounded-xl border px-3 py-2.5 text-xs font-medium ${
            feedback.type === "error"
              ? "border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
              : "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
          }`}
        >
          {feedback.message}
        </div>
      )}

      {/* 1. 현재 제외 중인 계정 목록 */}
      <div className="space-y-2">
        <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">
          현재 제외 설정된 계정 ({activeExcludedAccounts.length}개)
        </h3>

        {isLoading && !overview ? (
          <p className="rounded-xl border border-dashed border-slate-200 py-4 text-center text-[11px] text-slate-500 dark:border-slate-800">
            제외 계정 목록을 불러오는 중입니다...
          </p>
        ) : activeExcludedAccounts.length === 0 ? (
          <p
            data-testid="excluded-accounts-empty"
            className="rounded-xl border border-dashed border-slate-300 py-4 text-center text-[11px] text-slate-500 dark:border-slate-700 dark:text-slate-400"
          >
            현재 통계에서 제외 설정된 계정이 없습니다. 아래에서 회원을 검색해 추가하세요.
          </p>
        ) : (
          <ul
            data-testid="excluded-accounts-list"
            className="space-y-2"
          >
            {activeExcludedAccounts.map((item) => (
              <li
                key={item.userId}
                data-testid={`excluded-account-row-${item.userId}`}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-800/40"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-semibold text-slate-900 dark:text-white break-all">
                      {item.email || item.displayName || "이메일 미확인 계정"}
                    </span>
                    <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200">
                      제외 적용 중
                    </span>
                    {item.roles.map((r) => (
                      <span
                        key={r}
                        className="rounded bg-slate-200/80 px-1.5 py-0.5 text-[10px] font-medium text-slate-700 dark:bg-slate-700 dark:text-slate-200"
                      >
                        {r}
                      </span>
                    ))}
                  </div>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 break-all">
                    {item.displayName ? `닉네임: ${item.displayName} · ` : ""}
                    ID: <span className="font-mono">{item.userId}</span>
                  </p>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400">
                    변경 시각: {formatKstDateTime(item.updatedAt)} (KST)
                    {item.note ? ` · 메모: ${item.note}` : ""}
                  </p>
                </div>

                <button
                  type="button"
                  data-testid={`exclude-remove-btn-${item.userId}`}
                  onClick={() => handleToggleAccountActive(item, false)}
                  disabled={togglingUserId === item.userId}
                  className="min-h-[40px] shrink-0 rounded-xl border border-rose-300 bg-white px-3 py-1.5 text-[11px] font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-800 dark:bg-slate-900 dark:text-rose-300 dark:hover:bg-rose-950/40"
                >
                  {togglingUserId === item.userId ? "처리 중..." : "제외 해제"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 2. 회원 계정 검색 및 다중 선택 등록 */}
      <div className="border-t border-slate-100 pt-3 dark:border-slate-800 space-y-2.5">
        <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">
          회원 계정 검색 및 제외 등록
        </h3>

        <form
          onSubmit={handleSearchSubmit}
          className="flex flex-col sm:flex-row gap-2"
        >
          <label htmlFor="excluded-accounts-search" className="sr-only">
            회원 이메일, 닉네임 또는 사용자 ID 검색
          </label>
          <input
            id="excluded-accounts-search"
            data-testid="excluded-accounts-search-input"
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="이메일, 닉네임 또는 사용자 UUID로 검색"
            className="min-h-[40px] min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
          />
          <button
            type="submit"
            data-testid="excluded-accounts-search-btn"
            disabled={isLoading}
            className="min-h-[40px] shrink-0 rounded-xl border border-slate-300 bg-slate-50 px-3.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
          >
            {isLoading ? "검색 중..." : "회원 검색"}
          </button>
        </form>

        {candidates.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 py-3 text-center text-[11px] text-slate-500 dark:border-slate-800">
            검색 조건에 맞는 회원이 없습니다.
          </p>
        ) : (
          <div
            data-testid="excluded-accounts-candidates"
            className="max-h-60 overflow-y-auto rounded-xl border border-slate-200 divide-y divide-slate-100 dark:border-slate-800 dark:divide-slate-800"
          >
            {candidates.map((c) => {
              const checked = selectedUserIds.has(c.userId);
              return (
                <label
                  key={c.userId}
                  className="flex items-start gap-2.5 p-2.5 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40"
                >
                  <input
                    type="checkbox"
                    data-testid={`candidate-checkbox-${c.userId}`}
                    checked={checked}
                    disabled={c.isCurrentlyExcluded}
                    onChange={() => toggleCandidateSelection(c.userId)}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 disabled:opacity-40"
                  />
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-semibold text-slate-900 dark:text-white break-all">
                        {renderCandidateLabel(c)}
                      </span>
                      {c.isCurrentlyExcluded && (
                        <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-200">
                          이미 제외됨
                        </span>
                      )}
                      {c.roles.map((r) => (
                        <span
                          key={r}
                          className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                        >
                          {r}
                        </span>
                      ))}
                    </div>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 break-all">
                      {c.displayName ? `${c.displayName} · ` : ""}
                      <span className="font-mono">{c.userId}</span>
                    </p>
                  </div>
                </label>
              );
            })}
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-2 pt-1">
          <label htmlFor="excluded-accounts-note" className="sr-only">
            제외 사유 메모 (선택)
          </label>
          <input
            id="excluded-accounts-note"
            data-testid="excluded-accounts-note-input"
            type="text"
            maxLength={200}
            value={noteInput}
            onChange={(e) => setNoteInput(e.target.value)}
            placeholder="메모 (선택: 예) 시연용 테스트 계정)"
            className="min-h-[40px] min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
          />
          <button
            type="button"
            data-testid="excluded-accounts-register-btn"
            onClick={handleRegisterSelected}
            disabled={selectedUserIds.size === 0 || isSubmitting}
            className="min-h-[40px] shrink-0 rounded-xl bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {isSubmitting
              ? "저장 중..."
              : `선택한 계정 제외 등록 (${selectedUserIds.size}개)`}
          </button>
        </div>
      </div>

      {/* 3. 이전에 제외했다가 해제한 계정 이력 (재활성화 가능) */}
      {inactiveExcludedAccounts.length > 0 && (
        <details className="border-t border-slate-100 pt-2.5 dark:border-slate-800">
          <summary className="cursor-pointer text-[11px] font-semibold text-slate-600 dark:text-slate-400">
            제외 해제된 계정 이력 ({inactiveExcludedAccounts.length}개)
          </summary>
          <ul className="mt-2 space-y-1.5">
            {inactiveExcludedAccounts.map((item) => (
              <li
                key={item.userId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-100 bg-slate-50/50 px-3 py-2 dark:border-slate-800 dark:bg-slate-800/30"
              >
                <div className="min-w-0">
                  <p className="text-[11px] font-medium text-slate-700 dark:text-slate-300 break-all">
                    {item.email || item.displayName || item.userId}
                  </p>
                  <p className="text-[10px] text-slate-500">
                    해제 시각: {formatKstDateTime(item.updatedAt)}
                  </p>
                </div>
                <button
                  type="button"
                  data-testid={`exclude-reactivate-btn-${item.userId}`}
                  onClick={() => handleToggleAccountActive(item, true)}
                  disabled={togglingUserId === item.userId}
                  className="min-h-[36px] shrink-0 rounded-lg border border-indigo-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-50 dark:border-indigo-800 dark:bg-slate-900 dark:text-indigo-300"
                >
                  다시 제외
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
