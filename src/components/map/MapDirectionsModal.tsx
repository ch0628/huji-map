"use client";

import React, { useEffect, useRef } from "react";
import {
  LatLng,
  isValidLatLng,
} from "@/lib/maps/types";
import {
  buildKakaoMapDirectionsUrl,
  buildNaverMapDirectionsUrl,
  buildGoogleMapsDirectionsUrl,
  DirectionsTarget,
  DirectionsOrigin,
} from "@/lib/maps/directions";

import type {
  RestroomLocationKind,
  RestroomLocationPrecision,
} from "@/lib/restrooms/types";

export interface MapDirectionsModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly target: {
    readonly id?: string;
    readonly name: string;
    readonly type?: "public" | "partner";
    readonly businessId?: string | null;
    readonly address?: string;
    readonly coords: LatLng;
    readonly locationKind?: RestroomLocationKind;
    readonly locationPrecision?: RestroomLocationPrecision;
  } | null;
  readonly origin?: {
    readonly name?: string;
    readonly coords: LatLng;
  } | null;
  readonly onDirectionsClick?: (service: "kakao" | "naver" | "google") => void;
}

export default function MapDirectionsModal({
  isOpen,
  onClose,
  target,
  origin,
  onDirectionsClick,
}: MapDirectionsModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);

  // Esc 키 누를 때 모달 닫기
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !target || !isValidLatLng(target.coords)) {
    return null;
  }

  const dirTarget: DirectionsTarget = {
    name: target.name,
    coords: target.coords,
  };

  const dirOrigin: DirectionsOrigin | undefined =
    origin && isValidLatLng(origin.coords)
      ? {
          name: origin.name ?? "현재 위치",
          coords: origin.coords,
        }
      : undefined;

  const kakaoUrl = buildKakaoMapDirectionsUrl(dirTarget, dirOrigin);
  const naverUrl = buildNaverMapDirectionsUrl(dirTarget, dirOrigin);
  const googleUrl = buildGoogleMapsDirectionsUrl(dirTarget, dirOrigin);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="directions-modal-title"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      data-testid="map-directions-modal"
    >
      <div
        ref={modalRef}
        className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl dark:bg-slate-900 border border-slate-200 dark:border-slate-800"
      >
        <div className="flex items-start justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
          <div className="min-w-0 flex-1 pr-2">
            <h3
              id="directions-modal-title"
              className="text-base font-bold text-slate-900 dark:text-white truncate"
            >
              {target.name} 길찾기
            </h3>
            {target.address && (
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 truncate">
                {target.address}
              </p>
            )}
            {dirOrigin && (
              <p className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                <span>📍</span> 현재 위치 기준으로 경로를 탐색합니다
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            aria-label="닫기"
          >
            ✕
          </button>
        </div>

        <p className="py-3 text-xs text-slate-600 dark:text-slate-300">
          원하시는 지도 서비스를 선택하시면 길찾기 화면으로 바로 연결됩니다.
        </p>
        {target.locationKind === "candidate_reference" ? (
          <p
            data-testid="directions-candidate-coord-notice"
            className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900 dark:bg-amber-950/60 dark:text-amber-200"
          >
            {target.locationPrecision === "kakao_address"
              ? "주소 대표 지점 기반 참고 좌표이며, 실제 화장실 출입구 위치와 다를 수 있습니다."
              : "실시간 장소·주소 기반 참고 좌표이며, 실제 화장실 출입구 위치와 다를 수 있습니다."}
          </p>
        ) : target.type === "public" ? (
          <p
            data-testid="directions-public-coord-notice"
            className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-600 dark:bg-slate-800/70 dark:text-slate-300"
          >
            지자체 공식 데이터 좌표 기준 위치이며, 실제 화장실 출입구 위치와 다를 수 있습니다.
          </p>
        ) : null}

        <div className="space-y-2.5">
          {/* 카카오맵 */}
          <a
            href={kakaoUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => onDirectionsClick?.("kakao")}
            data-testid="directions-kakao-link"
            className="flex min-h-[44px] w-full items-center justify-between rounded-xl bg-[#FEE500] px-4 py-2.5 text-sm font-semibold text-[#191919] shadow-sm hover:brightness-95 active:scale-[0.98] transition"
          >
            <div className="flex items-center gap-2.5">
              <span className="text-base">🟡</span>
              <span>카카오맵 길찾기</span>
            </div>
            <span className="text-xs text-slate-700">바로가기 →</span>
          </a>

          {/* 네이버 지도 */}
          <a
            href={naverUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => onDirectionsClick?.("naver")}
            data-testid="directions-naver-link"
            className="flex min-h-[44px] w-full items-center justify-between rounded-xl bg-[#03C75A] px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:brightness-95 active:scale-[0.98] transition"
          >
            <div className="flex items-center gap-2.5">
              <span className="text-base">🟢</span>
              <span>네이버 지도 길찾기</span>
            </div>
            <span className="text-xs text-white/90">바로가기 →</span>
          </a>

          {/* 구글 지도 */}
          <a
            href={googleUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => onDirectionsClick?.("google")}
            data-testid="directions-google-link"
            className="flex min-h-[44px] w-full items-center justify-between rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 px-4 py-2.5 text-sm font-semibold text-slate-800 dark:text-slate-100 shadow-sm active:scale-[0.98] transition border border-slate-200 dark:border-slate-700"
          >
            <div className="flex items-center gap-2.5">
              <span className="text-base">🌐</span>
              <span>구글 지도 길찾기</span>
            </div>
            <span className="text-xs text-slate-500 dark:text-slate-400">바로가기 →</span>
          </a>
        </div>

        <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 text-center">
          <button
            type="button"
            onClick={onClose}
            className="w-full py-2 text-xs font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
          >
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}

