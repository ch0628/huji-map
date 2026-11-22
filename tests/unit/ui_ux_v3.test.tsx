/**
 * @vitest-environment jsdom
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const mockRouterPush = vi.fn();
const mockRouterRefresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockRouterPush,
    refresh: mockRouterRefresh,
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
}));

vi.mock("@/lib/events/hooks", () => ({
  useVisitorSession: () => ({
    sessionId: null,
    browserId: "",
    isReady: true,
    error: null,
  }),
  useEventTracker: () => ({
    trackDetailOpened: vi.fn(),
    trackDirectionsClicked: vi.fn(),
    trackPaymentButtonClicked: vi.fn(),
    trackPaymentUnavailableShown: vi.fn(),
  }),
}));

import MapBottomSheet from "@/components/map/MapBottomSheet";
import BusinessForm from "@/components/business/BusinessForm";
import RestroomPinManager from "@/components/restroom/RestroomPinManager";
import RestroomReviewSubmit from "@/components/restroom/RestroomReviewSubmit";
import RestroomDetailClient from "@/app/(public)/restrooms/[id]/RestroomDetailClient";
import DepositPaymentModal from "@/components/payment/DepositPaymentModal";
import ReceiptListClient from "@/components/receipt/ReceiptListClient";
import ReceiptUploadForm from "@/components/receipt/ReceiptUploadForm";
import AdminReceiptDecisionForm from "@/components/receipt/AdminReceiptDecisionForm";

describe("UI/UX Phase 3 Fixes (FIX-01 ~ FIX-07)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    window.HTMLElement.prototype.scrollTo = vi.fn();
  });

  it("FIX-01: MapBottomSheet selected mode renders single sky-blue card without outer white border", () => {
    const { container } = render(
      <MapBottomSheet
        selectedRestroom={{
          id: "r-1",
          type: "public",
          name: "테스트 화장실",
          road_address: "경기도 수원시 팔달구 화서문로 42",
          address_detail: "1층",
          latitude: 37.2845,
          longitude: 127.0155,
          gender_type: "separate",
          wheelchair_accessible: false,
          baby_changing_available: false,
          sanitary_products_available: false,
          access_method: "open",
          access_mode: "free",
          deposit_amount_krw: 0,
          business_id: null,
          business_name: null,
          primary_photo_url: null,
          last_verified_at: null,
        }}
        restrooms={[]}
        onSelectRestroom={vi.fn()}
        onCloseSelected={vi.fn()}
        onDirectionsClick={vi.fn()}
        isExpanded={false}
        onToggleExpand={vi.fn()}
      />
    );

    const sheet = screen.getByTestId("map-bottom-sheet-selected");
    expect(sheet.className).not.toContain("bg-white");
    expect(sheet.className).not.toContain("border-blue-500");
    expect(screen.getByTestId("public-restroom-card-r-1").className).toContain("bg-blue-50");
    expect(container.querySelectorAll('[data-testid="bottom-sheet-close-btn"]')).toHaveLength(1);
  });

  it("FIX-02 & FIX-07: BusinessForm disables text input for presets, enables for '기타', preserves custom edit, and validates with focus/red border", () => {
    const { rerender } = render(<BusinessForm mode="create" />);

    const select = screen.getByLabelText("업종 분류 선택") as HTMLSelectElement;
    const categoryInput = screen.getByLabelText("직접 입력 업종명") as HTMLInputElement;

    // Default preset '카페' -> input disabled
    expect(select.value).toBe("카페");
    expect(categoryInput.disabled).toBe(true);
    expect(categoryInput.value).toBe("카페");

    // Switch to '기타' -> input enabled & free typing
    fireEvent.change(select, { target: { value: "기타" } });
    expect(select.value).toBe("기타");
    expect(categoryInput.disabled).toBe(false);
    expect(categoryInput.value).toBe("");

    // Submit empty name + empty custom category -> red border + inline error + focus first error
    const nameInput = screen.getByLabelText(/상호명/) as HTMLInputElement;
    const focusSpy = vi.spyOn(nameInput, "focus");
    fireEvent.submit(screen.getByTestId("business-form"));

    expect(screen.getByText("가게 이름을 입력해 주세요.")).toBeDefined();
    expect(screen.getByText("업종을 선택하거나 직접 입력해 주세요.")).toBeDefined();
    expect(nameInput.getAttribute("aria-invalid")).toBe("true");
    expect(categoryInput.getAttribute("aria-invalid")).toBe("true");
    expect(focusSpy).toHaveBeenCalled();

    // Type custom category then switch to preset '음식점' -> applies '음식점' and disables input
    fireEvent.change(categoryInput, { target: { value: "베이커리" } });
    expect(categoryInput.value).toBe("베이커리");
    fireEvent.change(select, { target: { value: "음식점" } });
    expect(categoryInput.disabled).toBe(true);
    expect(categoryInput.value).toBe("음식점");

    // Edit mode with existing custom category -> selects '기타' & enables input with custom value
    rerender(
      <BusinessForm
        key="edit-custom"
        mode="edit"
        initialData={{
          id: "biz-1",
          name: "베이커리 가게",
          category: "수제 베이커리",
          description: null,
          road_address: "경기도 수원시 팔달구 화서문로 42",
          jibun_address: null,
          address_detail: null,
          latitude: 37.2845,
          longitude: 127.0155,
          phone: null,
          website_url: null,
          registration_status: "draft",
          rejection_reason: null,
          approved_by: null,
          approved_at: null,
          created_by: "u-1",
          created_at: "2026-11-20T00:00:00Z",
          updated_at: "2026-11-20T00:00:00Z",
        }}
      />
    );
    expect((screen.getByLabelText("업종 분류 선택") as HTMLSelectElement).value).toBe("기타");
    const editCatInput = screen.getByLabelText("직접 입력 업종명") as HTMLInputElement;
    expect(editCatInput.disabled).toBe(false);
    expect(editCatInput.value).toBe("수제 베이커리");
  });

  it("FIX-03 / TASK-01: Auto-displays current PIN on entry without extra view button or technical copy, opens change form only on button click, wipes PIN on pagehide, and validates empty PIN", async () => {
    render(
      <RestroomReviewSubmit
        restroom={{ id: "r-1", publication_status: "pending" }}
      />
    );
    expect(screen.getByTestId("restroom-pending-notice").textContent).toContain(
      "관리자 심사 대기 중입니다. 승인되면 지도에 공개됩니다."
    );

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        pin: "4321*",
        codeVersion: 1,
        updatedAt: "2026-11-21T10:00:00Z",
        requestId: "req-1",
      }),
    } as Response);

    const { unmount } = render(
      <RestroomPinManager
        restroomId="11111111-1111-4111-8111-111111111111"
        accessMethod="pin"
        pinStatus={{
          hasActivePin: true,
          codeVersion: 1,
          updatedAt: "2026-11-21T10:00:00Z",
          encryptionConfigured: true,
        }}
      />
    );

    expect(screen.queryByText(/AES-256-GCM/)).toBeNull();
    expect(screen.queryByText(/도어락 비밀번호는 안전하게 보관됩니다\./)).toBeNull();
    expect(screen.queryByTestId("merchant-view-current-pin-btn")).toBeNull();
    expect(screen.queryByTestId("restroom-pin-form")).toBeNull();

    // Auto-fetches and displays current PIN immediately
    await waitFor(() => {
      expect(screen.getByTestId("merchant-current-pin-value").textContent).toBe("4321*");
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/merchant/restrooms/11111111-1111-4111-8111-111111111111/pin",
      expect.objectContaining({ method: "GET", cache: "no-store" })
    );

    // Clicking "비밀번호 변경하기" reveals change form
    fireEvent.click(screen.getByTestId("merchant-open-pin-change-btn"));
    expect(screen.getByTestId("restroom-pin-form")).toBeDefined();

    // Submit empty PIN form -> red border + exact message
    fireEvent.click(screen.getByTestId("pin-submit-button"));
    expect(screen.getByTestId("pin-manager-error").textContent).toContain(
      "도어락 비밀번호를 입력해 주세요."
    );
    expect(screen.getByTestId("pin-input").getAttribute("aria-invalid")).toBe("true");

    // Leaving/hiding page wipes PIN immediately
    fireEvent(window, new Event("pagehide"));
    await waitFor(() => {
      expect(screen.queryByTestId("merchant-current-pin-value")).toBeNull();
    });

    unmount();
  });

  it("FIX-04 & FIX-05: Places max-3 photo slider above basic info with counter/zoom and reduces excessive purple on partner detail/modal", () => {
    render(
      <RestroomDetailClient
        restroom={{
          id: "r-partner-1",
          type: "partner",
          name: "행궁 제휴 화장실",
          road_address: "경기도 수원시 팔달구 화서문로 42",
          address_detail: "1층",
          floor: "1층",
          latitude: 37.2845,
          longitude: 127.0155,
          gender_type: "separate",
          wheelchair_accessible: true,
          baby_changing_available: false,
          sanitary_products_available: false,
          access_method: "pin",
          business_id: "biz-1",
          business: {
            id: "biz-1",
            name: "행궁 카페",
            category: "카페",
            description: null,
            road_address: "경기도 수원시 팔달구 화서문로 42",
            jibun_address: null,
            address_detail: "1층",
            latitude: 37.2845,
            longitude: 127.0155,
            phone: "031-111-2222",
            website_url: null,
          },
          active_policy: {
            id: "pol-1",
            version: 1,
            access_mode: "test_deposit",
            deposit_amount_krw: 1000,
            refund_eligible: true,
            receipt_window_hours: 24,
            min_purchase_krw: 0,
            effective_from: "2026-11-20T00:00:00Z",
          },
          hours: [],
          hour_exceptions: [],
          photos: [
            { id: "p-1", storage_path: "restrooms/1.jpg", photo_type: "entrance", is_primary: true, image_url: "https://example.com/1.jpg" },
            { id: "p-2", storage_path: "restrooms/2.jpg", photo_type: "interior", is_primary: false, image_url: "https://example.com/2.jpg" },
            { id: "p-3", storage_path: "restrooms/3.jpg", photo_type: "signage", is_primary: false, image_url: "https://example.com/3.jpg" },
            { id: "p-4", storage_path: "restrooms/4.jpg", photo_type: "other", is_primary: false, image_url: "https://example.com/4.jpg" },
          ],
          description: null,
          entrance_instructions: null,
          last_verified_at: null,
          created_at: "2026-11-20T00:00:00Z",
          updated_at: "2026-11-20T00:00:00Z",
        }}
      />
    );

    const photoSection = screen.getByTestId("public-restroom-photos-section");
    const titleHeading = screen.getByRole("heading", { name: "행궁 제휴 화장실" });
    // Photo section appears BEFORE basic info title in DOM
    expect(
      photoSection.compareDocumentPosition(titleHeading) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    // Max 3 slides rendered
    expect(screen.getByTestId("restroom-photo-counter").textContent).toBe("1 / 3");
    expect(screen.queryByTestId("public-restroom-photo-p-4")).toBeNull();

    // Next button updates counter
    fireEvent.click(screen.getByTestId("restroom-photo-next-btn"));
    expect(screen.getByTestId("restroom-photo-counter").textContent).toBe("2 / 3");

    // Zoom opens modal
    fireEvent.click(screen.getByTestId("public-restroom-photo-zoom-btn-1"));
    expect(screen.getByTestId("restroom-photo-zoom-modal")).toBeDefined();
    fireEvent.click(screen.getByTestId("restroom-photo-zoom-close-btn"));
    expect(screen.queryByTestId("restroom-photo-zoom-modal")).toBeNull();

    // Payment button stays purple, partner badge has no heavy purple bg
    expect(screen.getByTestId("detail-partner-payment-btn").className).toContain("bg-purple-600");
    expect(screen.getByTestId("detail-partner-badge").className).not.toContain("bg-purple-");

    // Modal policy box avoids purple wash while keeping purple CTA
    render(
      <DepositPaymentModal
        restroom={{
          id: "r-partner-1",
          type: "partner",
          name: "행궁 제휴 화장실",
          road_address: "수원",
          address_detail: null,
          floor: null,
          latitude: 37.2845,
          longitude: 127.0155,
          gender_type: "separate",
          wheelchair_accessible: false,
          baby_changing_available: false,
          sanitary_products_available: false,
          access_method: "pin",
          business_id: "biz-1",
          business: {
            id: "biz-1",
            name: "행궁 카페",
            category: "카페",
            description: null,
            road_address: "수원",
            jibun_address: null,
            address_detail: null,
            latitude: 37.2845,
            longitude: 127.0155,
            phone: null,
            website_url: null,
          },
          active_policy: {
            id: "pol-1",
            version: 1,
            access_mode: "test_deposit",
            deposit_amount_krw: 1000,
            refund_eligible: true,
            receipt_window_hours: 24,
            min_purchase_krw: 0,
            effective_from: "2026-11-20T00:00:00Z",
          },
          hours: [],
          hour_exceptions: [],
          photos: [],
          description: null,
          entrance_instructions: null,
          last_verified_at: null,
          created_at: "2026-11-20T00:00:00Z",
          updated_at: "2026-11-20T00:00:00Z",
        }}
        isOpen={true}
        onClose={vi.fn()}
        user={{ id: "u-1", email: "c@test.com", name: "고객" }}
      />
    );
    expect(screen.getByTestId("submit-checkout-btn").className).toContain("bg-purple-600");
    expect(screen.getByTestId("modal-policy-details").parentElement?.className).not.toContain("bg-purple-");
  });

  it("FIX-06: ReceiptListClient with direct session entry hides tabs and eligible list, and ReceiptUploadForm simplifies upload/validation", async () => {
    render(
      <ReceiptListClient
        initialSelectedSessionId="sess-1"
        initialData={{
          receipts: [],
          eligibleSessions: [
            {
              accessSessionId: "sess-1",
              restroomId: "r-1",
              restroomName: "중복 숨김 화장실",
              partnerName: "중복 숨김 매장",
              roadAddress: "수원",
              depositAmountKrw: 1000,
              authorizedAt: "2026-11-21T00:00:00Z",
              expiresAt: "2026-11-22T00:00:00Z",
              receiptWindowHours: 24,
              receiptWindowDeadline: "2026-11-22T00:00:00Z",
              isWindowExpired: false,
              hasPendingReceipt: false,
              hasApprovedReceipt: false,
            },
          ],
        }}
      />
    );

    expect(screen.queryByTestId("tab-submitted-receipts")).toBeNull();
    expect(screen.queryByTestId("tab-eligible-sessions")).toBeNull();
    expect(screen.queryByTestId("eligible-sessions-section")).toBeNull();
    expect(screen.queryByText(/중복 숨김 매장/)).toBeNull();

    // Submitting without file shows error and highlights selector
    fireEvent.click(screen.getByTestId("receipt-upload-submit-btn"));
    expect(screen.getByTestId("receipt-upload-error-alert").textContent).toContain(
      "영수증 사진 파일을 선택해 주세요."
    );

    // During upload, displays simplified message
    global.URL.createObjectURL = vi.fn(() => "blob:mock");
    global.URL.revokeObjectURL = vi.fn();
    let resolveIntent!: (val: any) => void;
    const pendingIntent = new Promise<any>((res) => {
      resolveIntent = res;
    });

    render(
      <ReceiptUploadForm
        accessSessionId="sess-pending"
        injectedUploadIntentRequester={() => pendingIntent}
      />
    );
    const input = screen.getAllByTestId("receipt-file-input")[1] as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["img"], "r.jpg", { type: "image/jpeg" })] },
    });
    const submitBtns = screen.getAllByTestId("receipt-upload-submit-btn");
    fireEvent.click(submitBtns[submitBtns.length - 1]);

    await waitFor(() => {
      expect(screen.getByTestId("receipt-upload-progress").textContent).toBe(
        "업로드 중입니다. 잠시만 기다려 주세요."
      );
    });
    resolveIntent({ uploadUrl: "https://example.com", storagePath: "receipts/u/s/r.jpg" });
  });

  it("FIX-07: AdminReceiptDecisionForm highlights missing reason directly under textarea and focuses textarea", () => {
    render(
      <AdminReceiptDecisionForm
        receipt={{
          id: "rec-admin-1",
          accessSessionId: "sess-1",
          userId: "u-1",
          storagePath: "receipts/u-1/rec.png",
          mimeType: "image/png",
          fileSizeBytes: 1024,
          originalFilename: "rec.png",
          submissionStatus: "submitted",
          storeNameConfirmed: null,
          purchaseAtConfirmed: null,
          purchaseAmountKrw: null,
          receiptReference: null,
          reviewedAt: null,
          reviewReason: null,
          createdAt: "2026-11-21T10:00:00Z",
          updatedAt: "2026-11-21T10:00:00Z",
          restroomName: "테스트 화장실",
          businessId: "biz-1",
          businessName: "테스트 카페",
          businessRoadAddress: "수원",
          userDisplayName: "고객",
          accessAuthorizedAt: "2026-11-21T09:00:00Z",
          accessExpiresAt: "2026-11-22T09:00:00Z",
          accessStatus: "authorized",
          policyVersion: 1,
          depositAmountKrw: 1000,
          receiptWindowHours: 24,
          receiptWindowDeadline: "2026-11-22T09:00:00Z",
          minPurchaseKrw: 0,
          paymentOrderId: "po-1",
          paymentOrderNumber: "ORD-1",
          paymentAmountKrw: 1000,
          paymentStatus: "approved",
          paymentMode: "test",
          paymentApprovedAt: "2026-11-21T09:00:00Z",
          refundStatus: "none",
          refundAmountKrw: null,
          refundRequestedAt: null,
          refundCompletedAt: null,
        }}
        onDecisionSuccess={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId("decision-option-approved"));
    const reasonTextarea = screen.getByTestId("input-review-reason") as HTMLTextAreaElement;
    const focusSpy = vi.spyOn(reasonTextarea, "focus");

    fireEvent.click(screen.getByTestId("decision-review-submit-button"));

    expect(screen.getByTestId("decision-validation-error").textContent).toContain(
      "심사 사유를 입력해 주세요."
    );
    expect(reasonTextarea.getAttribute("aria-invalid")).toBe("true");
    expect(focusSpy).toHaveBeenCalled();

    // Typing valid reason clears error
    fireEvent.change(reasonTextarea, { target: { value: "영수증 확인 완료" } });
    expect(reasonTextarea.getAttribute("aria-invalid")).toBe("false");
  });
});
