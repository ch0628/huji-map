"use client";

import React, { useState } from "react";

export type ConsentDetailItemId =
  | "collected"
  | "purpose"
  | "optional"
  | "privacy";

export interface ConsentDetailsAccordionProps {
  readonly defaultExpandedId?: ConsentDetailItemId | null;
  readonly defaultExpandPrivacyDetails?: boolean;
  readonly compact?: boolean;
  readonly policyVersion?: string;
}

interface AccordionItemConfig {
  readonly id: ConsentDetailItemId;
  readonly title: string;
  readonly testId: string;
}

const ACCORDION_ITEMS: readonly AccordionItemConfig[] = [
  {
    id: "collected",
    title: "어떤 정보를 수집하나요?",
    testId: "consent-accordion-collected",
  },
  {
    id: "purpose",
    title: "어디에 활용하나요?",
    testId: "consent-accordion-purpose",
  },
  {
    id: "optional",
    title: "동의하지 않아도 이용할 수 있나요?",
    testId: "consent-accordion-optional",
  },
  {
    id: "privacy",
    title: "개인정보 처리 안내",
    testId: "consent-accordion-privacy",
  },
];

export default function ConsentDetailsAccordion({
  defaultExpandedId = null,
  defaultExpandPrivacyDetails = false,
  compact = false,
  policyVersion,
}: ConsentDetailsAccordionProps) {
  const [expandedId, setExpandedId] = useState<ConsentDetailItemId | null>(
    defaultExpandedId
  );
  const [showFullPrivacyDetails, setShowFullPrivacyDetails] = useState<boolean>(
    defaultExpandPrivacyDetails
  );

  const renderItemBody = (id: ConsentDetailItemId) => {
    switch (id) {
      case "collected":
        return (
          <div className="space-y-1.5">
            <p>
              지도 방문, 화장실 조회, 길찾기, 결제 버튼 클릭 등의 이용 기록을
              수집합니다. 같은 브라우저의 이용 기록을 구분하기 위해 임의의
              식별자를 사용합니다.
            </p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              실시간 GPS 이동 경로, 도어락 비밀번호, 영수증 원본, 결제 비밀정보는
              수집하지 않습니다.
            </p>
          </div>
        );

      case "purpose":
        return (
          <p>
            어떤 화장실에 관심이 많은지, 길찾기를 얼마나 이용하는지 확인해
            화장실 정보와 지도 서비스를 개선합니다.
          </p>
        );

      case "optional":
        return (
          <p>
            네. 동의하지 않아도 지도와 길찾기 등 모든 기능을 이용할 수 있습니다.
            나중에 메뉴에서 언제든 동의하거나 철회할 수 있습니다.
          </p>
        );

      case "privacy":
        return (
          <div className="space-y-2.5">
            <p>
              휴지맵은 지도 탐색과 제휴 화장실 이용에 필요한 최소 정보만
              처리하며, 선택적 이용 통계는 동의하신 경우에만 수집합니다.
              동의하지 않거나 나중에 철회하면 통계 수집을 즉시 중단하고
              브라우저 식별자를 삭제합니다.
            </p>

            <button
              type="button"
              data-testid="consent-privacy-details-toggle"
              aria-expanded={showFullPrivacyDetails}
              aria-controls="consent-privacy-details-panel"
              onClick={() => setShowFullPrivacyDetails((prev) => !prev)}
              className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <span>
                {showFullPrivacyDetails
                  ? "상세 개인정보 처리 안내 닫기"
                  : "상세 개인정보 처리 안내 보기"}
              </span>
            </button>

            {showFullPrivacyDetails && (
              <div
                id="consent-privacy-details-panel"
                data-testid="consent-privacy-details-panel"
                className="space-y-2.5 rounded-xl border border-slate-200 bg-slate-50/80 p-3 text-[11px] leading-relaxed text-slate-600 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-300"
              >
                <div>
                  <p className="font-semibold text-slate-800 dark:text-slate-100">
                    1. 처리 목적 및 수집 항목
                  </p>
                  <ul className="mt-1 list-disc space-y-1 pl-4">
                    <li>
                      필수 서비스 제공(로그인·가게/화장실 등록·제휴 이용권·환급
                      이용 시): 계정 정보(이메일, 표시 이름), 가게·화장실 등록
                      정보, 테스트 결제·이용권·영수증 심사 및 환급 처리 내역
                    </li>
                    <li>
                      선택적 이용 통계(동의 시): 지도 방문, 화장실 핀 선택,
                      화장실 카드 조회, 화장실 상세 조회, 길찾기 실행, 결제 버튼
                      클릭 여부, 임의의 브라우저·방문 식별자, 유입 경로(이전
                      페이지·캠페인 정보), 기기 유형(모바일·태블릿·데스크톱)
                    </li>
                    <li>
                      비로그인 이용 통계와 로그인 이용 통계는 분리 집계하며,
                      로그인 전 이용 기록을 회원 계정에 자동으로 합치지 않습니다.
                    </li>
                  </ul>
                </div>

                <div>
                  <p className="font-semibold text-slate-800 dark:text-slate-100">
                    2. 보유 및 파기 기준
                  </p>
                  <ul className="mt-1 list-disc space-y-1 pl-4">
                    <li>
                      선택적 이용 통계 식별자: 동의를 철회하면 브라우저에 저장된
                      식별자를 즉시 삭제하고 이후 수집을 중단합니다.
                    </li>
                    <li>
                      회원·거래·심사 관련 기록: 서비스 운영, 분쟁 대응 및 관련
                      법령이 정한 기간 동안 보관한 뒤 지체 없이 파기합니다.
                    </li>
                  </ul>
                </div>

                <div>
                  <p className="font-semibold text-slate-800 dark:text-slate-100">
                    3. 외부 처리업체
                  </p>
                  <ul className="mt-1 list-disc space-y-1 pl-4">
                    <li>지도 및 길찾기 연동: 카카오(Kakao Maps)</li>
                    <li>결제·취소 연동(테스트 모드): 토스페이먼츠(Toss Payments)</li>
                    <li>
                      인증·데이터 보관 인프라: 클라우드 데이터베이스 및 호스팅
                      서비스(해외 리전 포함 가능)
                    </li>
                  </ul>
                </div>

                <div>
                  <p className="font-semibold text-slate-800 dark:text-slate-100">
                    4. 이용자 권리 및 문의 방법
                  </p>
                  <ul className="mt-1 list-disc space-y-1 pl-4">
                    <li>
                      화면 상단 <strong>메뉴 → 이용 통계 설정</strong>에서
                      언제든지 이용 통계 동의를 켜거나 끌 수 있습니다.
                    </li>
                    <li>
                      개인정보 열람·정정·삭제·처리정지 요청 및 문의는 서비스 내
                      안내된 운영 문의 채널을 통해 요청할 수 있습니다.
                      {policyVersion ? ` (기준 버전 ${policyVersion})` : ""}
                    </li>
                  </ul>
                </div>
              </div>
            )}
          </div>
        );
    }
  };

  return (
    <div
      data-testid="consent-details-accordion"
      className={`divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800 ${
        compact ? "rounded-xl border" : ""
      }`}
    >
      {ACCORDION_ITEMS.map((item) => {
        const isOpen = expandedId === item.id;
        const panelId = `${item.testId}-panel`;

        return (
          <div key={item.id}>
            <button
              type="button"
              data-testid={item.testId}
              aria-expanded={isOpen}
              aria-controls={panelId}
              onClick={() => setExpandedId(isOpen ? null : item.id)}
              className={`flex w-full items-center justify-between gap-3 text-left transition hover:bg-slate-50 dark:hover:bg-slate-900/60 ${
                compact ? "min-h-[44px] px-3 py-2.5" : "min-h-[50px] px-1 py-3"
              }`}
            >
              <span
                className={`font-semibold text-slate-900 dark:text-slate-100 ${
                  compact ? "text-xs" : "text-sm"
                }`}
              >
                {item.title}
              </span>
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                fill="none"
                className={`h-4 w-4 shrink-0 text-slate-400 transition-transform duration-200 ${
                  isOpen ? "rotate-90 text-slate-700 dark:text-slate-200" : ""
                }`}
              >
                <path
                  d="M7.5 4.5L13 10L7.5 15.5"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>

            {isOpen && (
              <div
                id={panelId}
                data-testid={`${item.testId}-content`}
                className={`text-xs leading-relaxed text-slate-600 dark:text-slate-300 ${
                  compact
                    ? "border-t border-slate-100 bg-slate-50/70 px-3 py-3 dark:border-slate-800 dark:bg-slate-900/40"
                    : "pb-4 pl-1 pr-2 pt-0.5"
                }`}
              >
                {renderItemBody(item.id)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
