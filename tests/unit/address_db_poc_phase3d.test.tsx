/**
 * @vitest-environment jsdom
 */

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import PublicRestroomCard from "@/components/restroom/PublicRestroomCard";
import PublicRestroomDetailView from "@/components/restroom/PublicRestroomDetailView";
import MapDirectionsModal from "@/components/map/MapDirectionsModal";
import type { PublicRestroomDetail, PublicRestroomSummary } from "@/lib/restrooms/types";
import type { SeoulOaRawRecord } from "../../scripts/address-db-poc/phase3b-lib";
import {
  createInitialCanaryReviewDecisions,
  SEOUL_OA22586_KOGL1_SOURCE_CONFIG,
  type Phase3cLoadPackage,
} from "../../scripts/address-db-poc/phase3c-lib";
import { evaluatePhase3dCanaryCandidates } from "../../scripts/address-db-poc/phase3d-lib";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/events/hooks", () => ({
  useEventTracker: () => ({
    trackDetailOpened: vi.fn(),
    trackDirectionsClicked: vi.fn(),
  }),
}));

describe("Phase 3-D Official-Data Policy Gate & Truthful Guidance UI", () => {
  it("distinguishes FIELD_VERIFIED, OFFICIAL_SOURCE_VALIDATED, and REVIEW_REQUIRED without faking field PASS", () => {
    const basePkg: Phase3cLoadPackage = {
      generatedAt: "2026-11-22T00:00:00Z",
      pilotTarget: "seoul_oa22586",
      tier: "canary_10",
      moisDependencyRemoved: true,
      sourceVersion: "2026-11-20",
      sourceFileSha256: "abc",
      publicDataSource: SEOUL_OA22586_KOGL1_SOURCE_CONFIG,
      counts: { restrooms: 4, policies: 4, candidates: 4, distinctGus: 4 },
      restrooms: [
        {
          id: "r1",
          source_record_id: "S1",
          type: "public",
          name: "일원본동주민센터",
          description:
            "개방시간: 정시(09:00~18:00,평일) / 출처: 서울특별시(2026년) · '서울시 공중화장실 위치정보(OA-22586)' · 공공누리 제1유형 (서울 열린데이터광장)",
          road_address: "서울특별시 강남구 광평로 126",
          address_detail: null,
          latitude: 37.4833791,
          longitude: 127.08648282,
          gender_type: "separate",
          wheelchair_accessible: true,
          baby_changing_available: false,
          sanitary_products_available: null,
          access_method: "open",
          publication_status: "published",
          last_verified_at: "2026-11-20T00:00:00Z",
          coordinate_source: "seoul_public_toilet_info",
          coordinate_source_record_id: "SEOUL-LOC-1",
          coordinate_type: "facility_official",
          coordinate_verification_status: "VERIFIED",
          coordinate_verification_basis: "oa22586_self",
          coordinate_source_version: "2026-11-20",
          gu_name: "강남구",
          oa_category_type: "공공개방|",
          landmark_category: "community_center",
          canary_tier: "canary_10",
        },
        {
          id: "r2",
          source_record_id: "S2",
          type: "public",
          name: "번1동주민센터 화장실",
          description:
            "개방시간: 정시(09:00~18:00) / 출처: 서울특별시(2026년) · '서울시 공중화장실 위치정보(OA-22586)' · 공공누리 제1유형 (서울 열린데이터광장)",
          road_address: "서울특별시 강북구 한천로 996",
          address_detail: null,
          latitude: 37.6377612,
          longitude: 127.03058315,
          gender_type: "separate",
          wheelchair_accessible: null,
          baby_changing_available: true,
          sanitary_products_available: null,
          access_method: "open",
          publication_status: "published",
          last_verified_at: "2026-11-20T00:00:00Z",
          coordinate_source: "seoul_public_toilet_info",
          coordinate_source_record_id: "SEOUL-LOC-2",
          coordinate_type: "facility_official",
          coordinate_verification_status: "VERIFIED",
          coordinate_verification_basis: "oa22586_self",
          coordinate_source_version: "2026-11-20",
          gu_name: "강북구",
          oa_category_type: "공공개방|",
          landmark_category: "community_center",
          canary_tier: "canary_10",
        },
        {
          id: "r3",
          source_record_id: "S3",
          type: "public",
          name: "민간건물 모호 화장실",
          description: "개방시간: 미정 / 공공누리 제1유형",
          road_address: "서울특별시 마포구 양화로 일대",
          address_detail: null,
          latitude: 37.55,
          longitude: 126.92,
          gender_type: "unknown",
          wheelchair_accessible: null,
          baby_changing_available: false,
          sanitary_products_available: null,
          access_method: "open",
          publication_status: "published",
          last_verified_at: "2026-11-20T00:00:00Z",
          coordinate_source: "mois_address_nav_db" as any,
          coordinate_source_record_id: "SEOUL-LOC-3",
          coordinate_type: "facility_official",
          coordinate_verification_status: "VERIFIED",
          coordinate_verification_basis: "mois_1to1",
          coordinate_source_version: "2026-11-20",
          gu_name: "마포구",
          oa_category_type: "민간개방|",
          landmark_category: "other_public",
          canary_tier: "canary_10",
        },
        {
          id: "r4",
          source_record_id: "S4",
          type: "public",
          name: "사람FAIL보류주민센터",
          description:
            "개방시간: 정시(09:00~18:00) / 출처: 서울특별시(2026년) · '서울시 공중화장실 위치정보(OA-22586)' · 공공누리 제1유형 (서울 열린데이터광장)",
          road_address: "서울특별시 송파구 올림픽로 326",
          address_detail: null,
          latitude: 37.5145,
          longitude: 127.1059,
          gender_type: "separate",
          wheelchair_accessible: true,
          baby_changing_available: false,
          sanitary_products_available: null,
          access_method: "open",
          publication_status: "published",
          last_verified_at: "2026-11-20T00:00:00Z",
          coordinate_source: "seoul_public_toilet_info",
          coordinate_source_record_id: "SEOUL-LOC-4",
          coordinate_type: "facility_official",
          coordinate_verification_status: "VERIFIED",
          coordinate_verification_basis: "oa22586_self",
          coordinate_source_version: "2026-11-20",
          gu_name: "송파구",
          oa_category_type: "공공개방|",
          landmark_category: "community_center",
          canary_tier: "canary_10",
        },
      ],
      restroomAccessPolicies: [
        { restroom_id: "r1", version: 1, access_mode: "free", deposit_amount_krw: 0, refund_eligible: false, receipt_window_hours: null, min_purchase_krw: 0, is_active: true },
        { restroom_id: "r2", version: 1, access_mode: "free", deposit_amount_krw: 0, refund_eligible: false, receipt_window_hours: null, min_purchase_krw: 0, is_active: true },
        { restroom_id: "r3", version: 1, access_mode: "free", deposit_amount_krw: 0, refund_eligible: false, receipt_window_hours: null, min_purchase_krw: 0, is_active: true },
        { restroom_id: "r4", version: 1, access_mode: "free", deposit_amount_krw: 0, refund_eligible: false, receipt_window_hours: null, min_purchase_krw: 0, is_active: true },
      ],
      restroomCoordinateCandidates: [
        { restroom_id: "r1", candidate_source: "seoul_public_toilet_info", candidate_source_record_id: "SEOUL-LOC-1", candidate_coord_type: "facility_official", source_version: "2026-11-20", latitude: 37.4833791, longitude: 127.08648282, verification_status: "VERIFIED", verification_basis: "oa22586", review_reasons: [], is_selected: true },
        { restroom_id: "r2", candidate_source: "seoul_public_toilet_info", candidate_source_record_id: "SEOUL-LOC-2", candidate_coord_type: "facility_official", source_version: "2026-11-20", latitude: 37.6377612, longitude: 127.03058315, verification_status: "VERIFIED", verification_basis: "oa22586", review_reasons: [], is_selected: true },
        { restroom_id: "r3", candidate_source: "seoul_public_toilet_info", candidate_source_record_id: "SEOUL-LOC-3", candidate_coord_type: "facility_official", source_version: "2026-11-20", latitude: 37.55, longitude: 126.92, verification_status: "VERIFIED", verification_basis: "mois_1to1", review_reasons: [], is_selected: true },
        { restroom_id: "r4", candidate_source: "seoul_public_toilet_info", candidate_source_record_id: "SEOUL-LOC-4", candidate_coord_type: "facility_official", source_version: "2026-11-20", latitude: 37.5145, longitude: 127.1059, verification_status: "VERIFIED", verification_basis: "oa22586", review_reasons: [], is_selected: true },
      ],
    };

    const oaRecords: SeoulOaRawRecord[] = [
      { seq: "1", roadAddress: "서울특별시 강남구 광평로 126", jibunAddress: "", lat: 37.4833791, lng: 127.08648282, buildingName: "일원본동주민센터", guName: "강남구", phone: "02-3423-5964", categoryType: "공공개방|", openHours: "정시(09:00~18:00,평일)", siteUse: "토요일|일요일|", toiletInfo: "남자|여자|", disabledInfo: "남자|여자|", extraFacilities: "", signage: "", siteType: "공공시설|", notes: "강남구" },
      { seq: "2", roadAddress: "서울특별시 강북구 한천로 996", jibunAddress: "", lat: 37.6377612, lng: 127.03058315, buildingName: "번1동주민센터 화장실", guName: "강북구", phone: "02-3778-4252", categoryType: "공공개방|", openHours: "정시(09:00~18:00)", siteUse: "", toiletInfo: "남자|여자|", disabledInfo: "", extraFacilities: "", signage: "", siteType: "공공시설|", notes: "번1동" },
      { seq: "3", roadAddress: "서울특별시 마포구 양화로 일대", jibunAddress: "", lat: 37.55, lng: 126.92, buildingName: "민간건물 모호 화장실", guName: "마포구", phone: "", categoryType: "민간개방|", openHours: "미정", siteUse: "", toiletInfo: "", disabledInfo: "", extraFacilities: "", signage: "", siteType: "민간시설|", notes: "" },
      { seq: "4", roadAddress: "서울특별시 송파구 올림픽로 326", jibunAddress: "", lat: 37.5145, lng: 127.1059, buildingName: "사람FAIL보류주민센터", guName: "송파구", phone: "02-2147-2000", categoryType: "공공개방|", openHours: "정시(09:00~18:00)", siteUse: "", toiletInfo: "남자|여자|", disabledInfo: "", extraFacilities: "", signage: "", siteType: "공공시설|", notes: "송파구" },
    ];

    const decisions = createInitialCanaryReviewDecisions(basePkg);
    // r1: human PASS+PASS -> FIELD_VERIFIED
    decisions[0].buildingLocationResult = "PASS";
    decisions[0].restroomExistenceOpenResult = "PASS";
    // r2: human PENDING -> OFFICIAL_SOURCE_VALIDATED with fieldVerified=false
    // r3: fails MOIS exclusion, 민간개방|, missing number/hours -> REVIEW_REQUIRED
    // r4: official checks pass, but human explicitly marked FAIL -> REVIEW_REQUIRED
    decisions[3].buildingLocationResult = "FAIL";

    const { evaluated, finalPackage } = evaluatePhase3dCanaryCandidates({
      pkg: basePkg,
      oaRecords,
      remoteRows: [],
      humanDecisions: decisions,
      sourceVersion: "2026-11-20",
    });

    expect(evaluated[0].validationStatus).toBe("FIELD_VERIFIED");
    expect(evaluated[0].fieldVerified).toBe(true);
    expect(evaluated[0].approvedForPilot).toBe(true);

    expect(evaluated[1].validationStatus).toBe("OFFICIAL_SOURCE_VALIDATED");
    expect(evaluated[1].fieldVerified).toBe(false);
    expect(evaluated[1].approvedForPilot).toBe(true);
    expect(evaluated[1].officialDescription).toContain("현장 직접 확인 미완료");
    expect(evaluated[1].officialValidationBasis).toContain("FIELD_VERIFIED=false");

    expect(evaluated[2].validationStatus).toBe("REVIEW_REQUIRED");
    expect(evaluated[2].approvedForPilot).toBe(false);
    expect(evaluated[2].checks.excludesMoisAndKakao).toBe(false);
    expect(evaluated[2].checks.isPublicOpenCategory).toBe(false);

    expect(evaluated[3].validationStatus).toBe("REVIEW_REQUIRED");
    expect(evaluated[3].approvedForPilot).toBe(false);

    expect(finalPackage.counts.approvedTotal).toBe(2);
    expect(finalPackage.counts.fieldVerifiedCount).toBe(1);
    expect(finalPackage.counts.officialSourceValidatedCount).toBe(1);
    expect(finalPackage.counts.reviewRequiredExcludedCount).toBe(2);
    expect(finalPackage.restrooms.map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("renders truthful guidance on PublicRestroomCard, PublicRestroomDetailView, and MapDirectionsModal", () => {
    const summary: PublicRestroomSummary = {
      id: "224ff8f3-de19-4906-bc2b-69882ba0f363",
      type: "public",
      name: "일원본동주민센터",
      road_address: "서울특별시 강남구 광평로 126",
      address_detail: "(지번) 서울특별시 강남구 일원동 735-3",
      latitude: 37.4833791,
      longitude: 127.08648282,
      access_method: "open",
      gender_type: "separate",
      wheelchair_accessible: true,
      baby_changing_available: false,
      sanitary_products_available: null,
      last_verified_at: "2026-11-20T00:00:00Z",
      business_id: null,
      access_mode: "free",
    };

    const detail: PublicRestroomDetail = {
      ...summary,
      description:
        "개방시간: 정시(09:00~18:00,평일) / 관리: 강남구 자원순환과 / 전화: 02-3423-5964 / 출처: 서울특별시(2026년) · '서울시 공중화장실 위치정보(OA-22586)' · 공공누리 제1유형 (서울 열린데이터광장) / 기준일: 2026-11-20 / 안내: 공식 공공데이터 기준 · 현장 직접 확인 미완료",
      floor: null,
      entrance_instructions: null,
      business: null,
      hours: [],
      hour_exceptions: [],
      active_policy: {
        id: "pol-1",
        version: 1,
        access_mode: "free",
        deposit_amount_krw: 0,
        refund_eligible: false,
        receipt_window_hours: null,
        min_purchase_krw: 0,
        effective_from: "2026-11-22T00:00:00Z",
      },
      photos: [],
      created_at: "2026-11-22T00:00:00Z",
      updated_at: "2026-11-22T00:00:00Z",
    };

    const { unmount } = render(<PublicRestroomCard restroom={summary} />);
    expect(screen.getByText(/개방형 출입/)).toBeDefined();
    expect(screen.queryByText(/상시 개방/)).toBeNull();
    expect(screen.getByTestId("public-official-guidance-note").textContent).toContain(
      "현장 확인 미완료"
    );
    expect(screen.getByTestId("public-official-guidance-note").textContent).toContain(
      "2026-11-20"
    );
    unmount();

    const { unmount: unmountDetail } = render(
      <PublicRestroomDetailView restroom={detail} />
    );
    expect(screen.getByTestId("detail-operating-status-badge").textContent).toBe(
      "운영시간 확인"
    );
    expect(screen.queryByText("현재 이용 가능")).toBeNull();
    expect(screen.getByTestId("public-official-disclosure").textContent).toContain(
      "현장 직접 확인 미완료"
    );
    expect(screen.getByTestId("public-official-disclosure").textContent).toContain(
      "2026-11-20"
    );
    expect(screen.getAllByText(/공공누리 제1유형/).length).toBeGreaterThanOrEqual(1);
    unmountDetail();

    render(
      <MapDirectionsModal
        isOpen={true}
        onClose={vi.fn()}
        target={{
          id: summary.id,
          name: summary.name,
          type: "public",
          address: summary.road_address,
          coords: { lat: summary.latitude, lng: summary.longitude },
        }}
      />
    );
    expect(screen.getByTestId("directions-public-coord-notice").textContent).toContain(
      "실제 화장실 출입구 위치와 다를 수 있습니다"
    );
  });
});
