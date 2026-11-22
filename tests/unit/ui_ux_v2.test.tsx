// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import MapBottomSheet from "@/components/map/MapBottomSheet";
import BusinessesListClient from "@/app/merchant/businesses/BusinessesListClient";
import PinRevealPanel from "@/components/access/PinRevealPanel";
import AccessDetailClient from "@/components/access/AccessDetailClient";
import { ReceiptUploadForm, ReceiptItemCard } from "@/components/receipt";
import RestroomForm from "@/components/restroom/RestroomForm";
import RestroomPolicyManager from "@/components/restroom/RestroomPolicyManager";
import RestroomDetailClient from "@/app/merchant/restrooms/[id]/RestroomDetailClient";
import { computeServiceUsageMetrics } from "@/lib/analytics/service";
import type { CustomerAccessDetail } from "@/components/access/types";
import type { CustomerReceiptItem } from "@/components/receipt/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
  usePathname: () => "/merchant/restrooms",
}));

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SAMPLE_RESTROOM = {
  id: "r1111111-1111-4111-8111-111111111111",
  type: "partner" as const,
  name: "DEMO/TEST 카페 화장실",
  road_address: "수원시 팔달구 화서문로 42",
  address_detail: "1층",
  latitude: 37.2845,
  longitude: 127.0155,
  access_method: "pin" as const,
  gender_type: "separate" as const,
  wheelchair_accessible: true,
  baby_changing_available: false,
  sanitary_products_available: false,
  last_verified_at: null,
  business_id: "b1111111-1111-4111-8111-111111111111",
  business_name: "DEMO/TEST 행궁카페",
  deposit_amount_krw: 1000,
  access_mode: "test_deposit" as const,
};

function makeAccessDetail(overrides?: Partial<CustomerAccessDetail>): CustomerAccessDetail {
  return {
    session: {
      id: "acc-1111-2222-3333-444444444444",
      user_id: "usr-1",
      restroom_id: SAMPLE_RESTROOM.id,
      policy_id: "pol-1",
      status: "authorized",
      access_method_snapshot: "pin",
      authorized_at: "2026-11-21T10:00:00Z",
      code_revealed_at: "2026-11-21T10:05:00Z",
      expires_at: "2099-01-01T00:00:00Z",
      created_at: "2026-11-21T10:00:00Z",
      updated_at: "2026-11-21T10:05:00Z",
    },
    effectiveStatus: "authorized",
    restroom: {
      id: SAMPLE_RESTROOM.id,
      name: SAMPLE_RESTROOM.name,
      road_address: SAMPLE_RESTROOM.road_address,
      address_detail: "1층",
      floor: "1층",
      entrance_instructions: "왼쪽 복도",
      access_method: "pin",
      publication_status: "published",
      business_id: SAMPLE_RESTROOM.business_id,
      business_name: SAMPLE_RESTROOM.business_name,
      business_category: "카페",
      business_phone: "031-000-0000",
    },
    order: {
      id: "ord-1",
      user_id: "usr-1",
      access_session_id: "acc-1111-2222-3333-444444444444",
      order_id: "hm_ord_internal_hidden",
      provider: "toss",
      payment_mode: "test",
      amount_krw: 1000,
      status: "approved",
      approved_at: "2026-11-21T10:00:00Z",
      failure_code: null,
      created_at: "2026-11-21T10:00:00Z",
      updated_at: "2026-11-21T10:00:00Z",
    },
    refund: null,
    latestVisitConfirmation: null,
    visitConfirmations: [],
    eligibleForPinReveal: true,
    policy: {
      id: "pol-1",
      version: 1,
      access_mode: "test_deposit",
      deposit_amount_krw: 1000,
      refund_eligible: true,
      receipt_window_hours: 24,
      min_purchase_krw: 0,
    },
    latestReceipt: null,
    ...overrides,
  };
}

describe("HUJIMAP UI/UX 2차(UI-09 ~ UI-16) 검증", () => {
  it("UI-09: MapBottomSheet 선택 카드에 '선택한 화장실' 헤더 없이 우상단 검정 X 닫기 버튼 1개만 표시되고 직원 확인 이용권은 PIN 문구를 쓰지 않는다", () => {
    render(
      <MapBottomSheet
        selectedRestroom={SAMPLE_RESTROOM}
        restrooms={[]}
        onSelectRestroom={vi.fn()}
        onCloseSelected={vi.fn()}
        onDirectionsClick={vi.fn()}
        isExpanded={false}
        onToggleExpand={vi.fn()}
      />
    );

    expect(screen.queryByText("선택한 화장실")).toBeNull();
    const closeBtns = screen.getAllByTestId("bottom-sheet-close-btn");
    expect(closeBtns).toHaveLength(1);
    expect(closeBtns[0].className).not.toMatch(/(?:^|\s)bg-white(?:\s|$)/);
    expect(closeBtns[0].className).not.toContain("rounded-full");

    const staffDetail = makeAccessDetail({
      session: {
        ...makeAccessDetail().session,
        access_method_snapshot: "ask_staff",
      },
    });
    render(
      <PinRevealPanel
        session={staffDetail.session}
        restroom={staffDetail.restroom}
        order={staffDetail.order}
        refund={null}
      />
    );
    const staffPanel = screen.getByTestId("staff-presentation-panel");
    expect(staffPanel.textContent).toContain("직원에게 보여주세요");
    expect(staffPanel.textContent).toContain("직원 확인 후 이용");
    expect(staffPanel.textContent).not.toContain("PIN");
    expect(staffPanel.textContent).not.toContain("도어락");
  });

  it("UI-10: 가게 목록 빈 상태 및 안내 4문장이 명세대로 표시된다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, businesses: [] }),
      })
    );
    render(<BusinessesListClient initialBusinesses={[]} />);

    await waitFor(() => {
      expect(screen.getByTestId("businesses-list-empty")).toBeDefined();
    });
    expect(screen.queryByText(/등록비는 무료입니다/)).toBeNull();
    expect(
      screen.getByText(
        "휴지맵에 내 가게를 등록하고, 손님들에게 안심 화장실을 제공해 보세요."
      )
    ).toBeDefined();
    expect(screen.getByText("가게 등록 신청은 무료입니다.")).toBeDefined();
    expect(screen.getByText("가게 정보를 작성하면 작성 중으로 저장됩니다.")).toBeDefined();
    expect(
      screen.getByText(
        "정보 입력을 마친 뒤 심사 요청을 누르면 관리자 검토가 진행됩니다."
      )
    ).toBeDefined();
    expect(
      screen.getByText(
        "관리자 승인 완료 후에는 제휴 화장실 등록 및 운영 권한이 활성화됩니다."
      )
    ).toBeDefined();
  });

  it("UI-11: 고객 영수증 업로드는 간소화되고 재방문 카드는 비공개 서명 URL 이미지 조회와 오류 대체를 지원한다", async () => {
    render(<ReceiptUploadForm accessSessionId="sess-1" />);
    expect(
      screen.getByText(/매장에서 구매한 영수증 사진을 제출해 주세요\./)
    ).toBeDefined();
    expect(screen.getByText("JPG, PNG, WebP · 최대 10MB")).toBeDefined();
    expect(screen.queryByText(/OCR/)).toBeNull();
    cleanup();

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ ok: false }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const mockReceipt: CustomerReceiptItem = {
      id: "rec-1",
      accessSessionId: "sess-1",
      userId: "usr-1",
      storagePath: "receipts/usr-1/sess-1/1.png",
      mimeType: "image/png",
      fileSizeBytes: 1024,
      originalFilename: "hidden_name.png",
      submissionStatus: "submitted",
      storeNameConfirmed: null,
      purchaseAtConfirmed: null,
      purchaseAmountKrw: null,
      reviewReason: null,
      reviewedAt: null,
      createdAt: "2026-11-21T10:00:00Z",
      restroomName: "테스트 화장실",
      partnerName: "테스트 가게",
      roadAddress: "수원시 팔달구",
      depositAmountKrw: 1000,
      refundStatus: "none",
      refundAmountKrw: null,
      refundCompletedAt: null,
    };

    render(<ReceiptItemCard receipt={mockReceipt} enableImagePreview={true} />);
    await waitFor(() => {
      expect(screen.getByTestId("customer-receipt-image-error").textContent).toContain(
        "영수증 이미지를 불러오지 못했습니다."
      );
    });
  });

  it("UI-12: 이용권 상세는 내부 주문번호·자격상태를 제거하고 이미 제출된 영수증 시 중복 제출을 유도하지 않는다", () => {
    const detailWithReceipt = makeAccessDetail({
      latestReceipt: {
        id: "rec-1",
        submissionStatus: "submitted",
        createdAt: "2026-11-21T11:00:00Z",
        reviewReason: null,
      },
    });
    render(
      <AccessDetailClient
        accessSessionId={detailWithReceipt.session.id}
        initialDetail={detailWithReceipt}
      />
    );

    expect(screen.queryByText("hm_ord_internal_hidden")).toBeNull();
    expect(screen.queryByText(/결제 후 자격 상태/)).toBeNull();
    expect(screen.queryByText(/최초 PIN 열람 시각/)).toBeNull();
    expect(screen.getByTestId("access-detail-receipts-link").textContent).toContain(
      "제출한 영수증 확인하기"
    );
  });

  it("UI-14: 승인 가게 정보 자동 적용 후 PIN 입력·등록하고 심사 요청하기를 순서대로 처리하고 PIN 실패 시 심사를 호출하지 않는다", async () => {
    const fetchMock = vi
      .fn()
      // 1. POST /api/v1/merchant/restrooms
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: { id: "new-rr-1", publication_status: "draft" } }),
      })
      // 2. POST /api/v1/merchant/restrooms/new-rr-1/pin -> fail
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ ok: false, error: { message: "PIN 암호화 실패" } }),
      });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <RestroomForm
        businessId="11111111-1111-4111-8111-111111111111"
        businessName="DEMO/TEST 카페"
        businessDefaults={{
          name: "DEMO/TEST 카페",
          roadAddress: "경기도 수원시 팔달구 행궁로 1",
          addressDetail: "1층",
          latitude: 37.2835,
          longitude: 127.0158,
        }}
        mode="create"
      />
    );

    expect((screen.getByLabelText(/화장실 이름/) as HTMLInputElement).value).toBe(
      "DEMO/TEST 카페 화장실"
    );
    expect(screen.queryByTestId("restroom-initial-pin-section")).toBeNull();

    // 도어락 선택 시 PIN 입력란 노출
    fireEvent.change(screen.getByLabelText(/출입 방식/), {
      target: { value: "pin" },
    });
    expect(screen.getByTestId("restroom-initial-pin-section")).toBeDefined();

    fireEvent.change(screen.getByTestId("restroom-initial-pin-input"), {
      target: { value: "1234*" },
    });
    fireEvent.change(screen.getByTestId("restroom-initial-pin-confirm-input"), {
      target: { value: "1234*" },
    });

    fireEvent.click(screen.getByTestId("restroom-form-submit-review-button"));

    await waitFor(() => {
      expect(screen.getByTestId("restroom-form-error").textContent).toContain(
        "PIN 암호화 실패"
      );
    });
    // PIN 실패 시 /submit 호출되지 않아야 함 (총 2회: create + pin)
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("/pin");
  });

  it("UI-15: 점주 화장실 상세는 입력 폼을 기본 접힘으로 유지하고 동일 정책 재적용을 차단한다", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        data: {
          id: "rr-1",
          business_id: "biz-1",
          businessId: "biz-1",
          type: "partner",
          name: "DEMO/TEST 카페 화장실",
          road_address: "수원시 팔달구 화서문로 42",
          access_method: "pin",
          publication_status: "pending",
          created_at: "2026-11-20T00:00:00Z",
          updated_at: "2026-11-20T00:00:00Z",
          policies: [
            {
              id: "pol-1",
              restroom_id: "rr-1",
              version: 1,
              access_mode: "free",
              deposit_amount_krw: 0,
              refund_eligible: false,
              receipt_window_hours: null,
              min_purchase_krw: 0,
              is_active: true,
              effective_from: "2026-11-20T00:00:00Z",
              created_at: "2026-11-20T00:00:00Z",
            },
          ],
          hours: [],
          photos: [],
          pinStatus: { hasActivePin: true, codeVersion: 1, updatedAt: null, encryptionConfigured: true },
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RestroomDetailClient restroomId="rr-1" />);
    await waitFor(() => {
      expect(screen.getByTestId("restroom-summary-overview")).toBeDefined();
    });

    // 기본 화면에서는 수정/정책/PIN/사진 폼이 모두 접혀 있어야 함
    expect(screen.queryByTestId("manage-panel-edit")).toBeNull();
    expect(screen.queryByTestId("manage-panel-policy")).toBeNull();
    expect(screen.queryByTestId("manage-panel-pin")).toBeNull();
    expect(screen.queryByTestId("manage-panel-photos")).toBeNull();

    // 수정 버튼 클릭 시에만 열림
    fireEvent.click(screen.getByTestId("toggle-manage-edit-btn"));
    expect(screen.getByTestId("manage-panel-edit")).toBeDefined();

    cleanup();

    // 동일 정책 재적용 차단 확인
    render(
      <RestroomPolicyManager
        restroomId="rr-1"
        policies={[
          {
            id: "pol-1",
            restroom_id: "rr-1",
            version: 1,
            access_mode: "free",
            deposit_amount_krw: 0,
            refund_eligible: false,
            receipt_window_hours: null,
            min_purchase_krw: 0,
            is_active: true,
            effective_from: "2026-11-20T00:00:00Z",
            created_by: null,
            created_at: "2026-11-20T00:00:00Z",
          },
        ]}
      />
    );
    const freeRadio = screen.getByDisplayValue("free_with_ad");
    fireEvent.click(freeRadio);
    expect(screen.getByTestId("policy-identical-notice")).toBeDefined();
    expect((screen.getByTestId("create-policy-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("UI-16: computeServiceUsageMetrics는 실제·테스트 데이터를 구분하고 0건 시 허위 수치를 만들지 않는다", () => {
    const empty = computeServiceUsageMetrics({
      sessions: [],
      events: [],
      restrooms: [],
      orders: [],
      accessSessions: [],
      receipts: [],
      refunds: [],
      window: { startsAt: "2026-11-01T00:00:00Z", endsAt: "2026-11-22T00:00:00Z" },
      includeTest: false,
    });
    expect(empty.overview.visitingBrowsers).toBe(0);
    expect(empty.overview.directionsClicks).toBe(0);
    expect(empty.dailyTrend).toHaveLength(0);
    expect(empty.analyticsConfig.actuallyGatedByEnv).toBe(true);

    const active = computeServiceUsageMetrics({
      sessions: [
        { id: "s1", browser_id: "b1", started_at: "2026-11-21T05:00:00Z", is_test: false },
        { id: "s2", browser_id: "b2", started_at: "2026-11-21T05:00:00Z", is_test: true },
      ],
      events: [
        {
          browser_id: "b1",
          restroom_id: "r1",
          event_name: "directions_clicked",
          properties: { type: "partner" },
          occurred_at: "2026-11-21T05:05:00Z",
          is_test: false,
        },
        {
          browser_id: "b2",
          restroom_id: "r1",
          event_name: "map_loaded",
          occurred_at: "2026-11-21T05:06:00Z",
          is_test: true,
        },
      ],
      restrooms: [{ id: "r1", type: "partner" }],
      orders: [
        {
          id: "o1",
          status: "approved",
          payment_mode: "test",
          approved_at: "2026-11-21T06:00:00Z",
          created_at: "2026-11-21T06:00:00Z",
        },
      ],
      accessSessions: [
        {
          id: "a1",
          status: "authorized",
          authorized_at: "2026-11-21T06:00:00Z",
          created_at: "2026-11-21T06:00:00Z",
        },
      ],
      receipts: [
        { id: "rec1", submission_status: "approved", created_at: "2026-11-21T07:00:00Z" },
      ],
      refunds: [
        { id: "ref1", status: "succeeded", completed_at: "2026-11-21T08:00:00Z" },
      ],
      window: { startsAt: "2026-11-20T00:00:00Z", endsAt: "2026-11-22T00:00:00Z" },
      includeTest: false,
    });

    // includeTest=false excludes b2 session/event and counts test payment separately
    expect(active.overview.visitingBrowsers).toBe(1);
    expect(active.overview.directionsClicks).toBe(1);
    expect(active.overview.approvedPayments).toBe(0);
    expect(active.overview.testModePayments).toBe(1);
    expect(active.byRestroomType.partner.directionsClicks).toBe(1);
    expect(active.overview.submittedReceipts).toBe(1);
    expect(active.overview.refundsSucceeded).toBe(1);
    expect(active.dailyTrend).toHaveLength(1);
  });
});
