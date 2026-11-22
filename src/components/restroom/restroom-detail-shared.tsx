"use client";

import React from "react";
import type {
  AccessMethod,
  GenderType,
  PublicRestroomDetail,
  PublicRestroomHour,
  PublicRestroomHourException,
} from "@/lib/restrooms/types";

export const GENDER_LABELS: Record<GenderType, string> = {
  separate: "남녀 분리",
  unisex: "남녀 공용",
  male: "남성 전용",
  female: "여성 전용",
  unknown: "미확인",
};

export const ACCESS_METHOD_LABELS: Record<AccessMethod, string> = {
  open: "상시 개방",
  ask_staff: "직원 문의 후 출입",
  pin: "도어락 비밀번호",
};

export const WEEKDAY_NAMES = [
  "일요일",
  "월요일",
  "화요일",
  "수요일",
  "목요일",
  "금요일",
  "토요일",
];

export type OperatingStatusState = "open" | "closed" | "unknown";

export interface OperatingStatusResult {
  readonly state: OperatingStatusState;
  readonly label: string;
  readonly todayText: string;
}

const WEEKDAY_SHORT_TO_NUM: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function parseMinutes(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null;
  const match = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return null;
  }
  return h * 60 + m;
}

function getKstParts(now: Date): {
  dateStr: string;
  weekday: number;
  minutes: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const map: Record<string, string> = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }
  const hour = Number(map.hour === "24" ? "0" : map.hour);
  const minute = Number(map.minute);
  return {
    dateStr: `${map.year}-${map.month}-${map.day}`,
    weekday: WEEKDAY_SHORT_TO_NUM[map.weekday] ?? now.getDay(),
    minutes: hour * 60 + minute,
  };
}

/**
 * Evaluates current restroom availability strictly from verified operating hours/exceptions.
 * Never claims "현재 이용 가능" unless verified against today's schedule.
 */
export function evaluateOperatingStatus(
  hours: readonly PublicRestroomHour[] | undefined | null,
  hourExceptions?: readonly PublicRestroomHourException[] | undefined | null,
  now: Date = new Date()
): OperatingStatusResult {
  const safeHours = hours ?? [];
  const safeExceptions = hourExceptions ?? [];
  const { dateStr, weekday, minutes } = getKstParts(now);

  const todayException = safeExceptions.find((ex) => ex.exception_date === dateStr);
  if (todayException) {
    if (todayException.is_closed) {
      return {
        state: "closed",
        label: "오늘 휴무",
        todayText: todayException.reason
          ? `오늘 휴무 (${todayException.reason})`
          : "오늘 휴무",
      };
    }
    const openMin = parseMinutes(todayException.opens_at);
    const closeMin = parseMinutes(todayException.closes_at);
    if (openMin === null || closeMin === null) {
      return {
        state: "unknown",
        label: "운영시간 확인",
        todayText: "운영시간 확인 필요",
      };
    }
    const rangeText = `${todayException.opens_at!.slice(0, 5)} ~ ${todayException.closes_at!.slice(0, 5)}`;
    const isOpen =
      closeMin <= openMin
        ? minutes >= openMin
        : minutes >= openMin && minutes < closeMin;
    return {
      state: isOpen ? "open" : "closed",
      label: isOpen ? "현재 이용 가능" : "현재 운영 시간 외",
      todayText: `오늘 ${rangeText}`,
    };
  }

  if (safeHours.length === 0) {
    return {
      state: "unknown",
      label: "운영시간 확인",
      todayText: "운영시간 정보 없음",
    };
  }

  // Check if yesterday's overnight shift carries into today
  const yesterdayWeekday = (weekday + 6) % 7;
  const yesterdayHour = safeHours.find((h) => h.weekday === yesterdayWeekday);
  if (
    yesterdayHour &&
    !yesterdayHour.is_closed &&
    yesterdayHour.crosses_midnight
  ) {
    const yClose = parseMinutes(yesterdayHour.closes_at);
    if (yClose !== null && minutes < yClose) {
      const yRange = `${yesterdayHour.opens_at?.slice(0, 5) ?? ""} ~ 익일 ${yesterdayHour.closes_at?.slice(0, 5) ?? ""}`;
      return {
        state: "open",
        label: "현재 이용 가능",
        todayText: yRange.trim() ? `심야 운영 중 (${yRange})` : "운영 중",
      };
    }
  }

  const todayHour = safeHours.find((h) => h.weekday === weekday);
  if (!todayHour) {
    return {
      state: "unknown",
      label: "운영시간 확인",
      todayText: "오늘 운영시간 정보 없음",
    };
  }

  if (todayHour.is_closed) {
    return {
      state: "closed",
      label: "오늘 휴무",
      todayText: "오늘 휴무",
    };
  }

  const openMin = parseMinutes(todayHour.opens_at);
  const closeMin = parseMinutes(todayHour.closes_at);
  if (openMin === null || closeMin === null) {
    return {
      state: "unknown",
      label: "운영시간 확인",
      todayText: "운영시간 정보 없음",
    };
  }

  const rangeText = `${todayHour.opens_at!.slice(0, 5)} ~ ${
    todayHour.crosses_midnight ? "익일 " : ""
  }${todayHour.closes_at!.slice(0, 5)}`;

  const isOpen = todayHour.crosses_midnight
    ? minutes >= openMin
    : minutes >= openMin && minutes < closeMin;

  return {
    state: isOpen ? "open" : "closed",
    label: isOpen ? "현재 이용 가능" : "현재 운영 시간 외",
    todayText: `오늘 ${rangeText}`,
  };
}

export function OperatingStatusBadge({
  status,
}: {
  readonly status: OperatingStatusResult;
}) {
  const styles =
    status.state === "open"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300"
      : status.state === "closed"
      ? "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
      : "bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300";

  return (
    <span
      data-testid="detail-operating-status-badge"
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold ${styles}`}
    >
      {status.label}
    </span>
  );
}

export function CompactOperatingHours({
  hours,
  todayText,
}: {
  readonly hours: readonly PublicRestroomHour[];
  readonly todayText: string;
}) {
  if (!hours || hours.length === 0) {
    return (
      <p
        data-testid="restroom-hours-empty"
        className="mt-1.5 flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400"
      >
        <span aria-hidden="true">🕒</span>
        <span>운영시간 정보 없음</span>
      </p>
    );
  }

  return (
    <details
      data-testid="restroom-hours-section"
      className="mt-2 rounded-xl bg-slate-50 px-3 py-2 text-xs dark:bg-slate-800/50"
    >
      <summary className="flex min-h-[32px] cursor-pointer list-none items-center justify-between gap-2 font-medium text-slate-700 dark:text-slate-300">
        <span>🕒 {todayText}</span>
        <span className="shrink-0 text-[11px] font-semibold text-blue-600 dark:text-blue-400">
          전체 시간 ▾
        </span>
      </summary>
      <div className="mt-2 divide-y divide-slate-200/70 border-t border-slate-200/70 pt-1.5 dark:divide-slate-700/70 dark:border-slate-700/70">
        {hours.map((h) => (
          <div
            key={h.id || h.weekday}
            className="flex items-center justify-between py-1.5"
          >
            <span className="font-medium text-slate-600 dark:text-slate-400">
              {WEEKDAY_NAMES[h.weekday] || `${h.weekday}요일`}
            </span>
            <span className="font-semibold text-slate-900 dark:text-slate-200">
              {h.is_closed
                ? "휴무"
                : h.opens_at && h.closes_at
                ? `${h.opens_at.slice(0, 5)} ~ ${
                    h.crosses_midnight ? "익일 " : ""
                  }${h.closes_at.slice(0, 5)}`
                : "운영시간 정보 없음"}
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}

export function RestroomFacilitiesCard({
  restroom,
}: {
  readonly restroom: PublicRestroomDetail;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <h2 className="mb-3 text-sm font-bold text-slate-900 dark:text-white">
        기타 시설 정보
      </h2>

      <div className="mb-3 space-y-2 text-xs">
        <div className="flex items-center justify-between border-b border-slate-100 py-1.5 dark:border-slate-800">
          <span className="text-slate-500 dark:text-slate-400">출입 방식</span>
          <span className="font-semibold text-slate-800 dark:text-slate-200">
            {ACCESS_METHOD_LABELS[restroom.access_method] || "출입 안내"}
          </span>
        </div>

        {restroom.entrance_instructions && (
          <div className="border-b border-slate-100 py-1.5 dark:border-slate-800">
            <span className="mb-1 block text-slate-500 dark:text-slate-400">
              출입구 위치
            </span>
            <p className="rounded-lg bg-slate-50 p-2 font-medium text-slate-800 dark:bg-slate-800 dark:text-slate-200">
              {restroom.entrance_instructions}
            </p>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="flex items-center justify-between rounded-xl bg-slate-50 p-2.5 dark:bg-slate-800/60">
          <span className="text-slate-500 dark:text-slate-400">성별 구분</span>
          <span className="font-semibold text-slate-800 dark:text-slate-200">
            {GENDER_LABELS[restroom.gender_type] || "미확인"}
          </span>
        </div>

        <div className="flex items-center justify-between rounded-xl bg-slate-50 p-2.5 dark:bg-slate-800/60">
          <span className="text-slate-500 dark:text-slate-400">휠체어</span>
          {restroom.wheelchair_accessible === true ? (
            <span className="font-semibold text-emerald-600 dark:text-emerald-400">
              이용 가능
            </span>
          ) : restroom.wheelchair_accessible === false ? (
            <span className="font-semibold text-slate-400">어려움</span>
          ) : (
            <span className="font-semibold text-amber-600 dark:text-amber-400">
              미확인
            </span>
          )}
        </div>

        <div className="flex items-center justify-between rounded-xl bg-slate-50 p-2.5 dark:bg-slate-800/60">
          <span className="text-slate-500 dark:text-slate-400">기저귀 교환대</span>
          <span className="font-semibold text-slate-800 dark:text-slate-200">
            {restroom.baby_changing_available ? "있음" : "없음"}
          </span>
        </div>

        <div className="flex items-center justify-between rounded-xl bg-slate-50 p-2.5 dark:bg-slate-800/60">
          <span className="text-slate-500 dark:text-slate-400">여성위생용품</span>
          <span className="font-semibold text-slate-800 dark:text-slate-200">
            {restroom.sanitary_products_available ? "비치됨" : "없음"}
          </span>
        </div>
      </div>
    </div>
  );
}
