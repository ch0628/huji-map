/**
 * @vitest-environment jsdom
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";
import AdminReceiptsClient from "@/components/receipt/AdminReceiptsClient";
import AdminReceiptImageViewer from "@/components/receipt/AdminReceiptImageViewer";
import AdminReceiptComparisonCard from "@/components/receipt/AdminReceiptComparisonCard";
import AdminReceiptDecisionForm from "@/components/receipt/AdminReceiptDecisionForm";
import type { AdminReceiptListItem } from "@/lib/receipts/types";

const mockPendingItem: AdminReceiptListItem = {
  id: "11111111-1111-4111-8111-111111111111",
  accessSessionId: "aaaa1111-1111-4111-8111-111111111111",
  userId: "bbbb1111-1111-4111-8111-111111111111",
  storagePath:
    "receipts/bbbb1111-1111-4111-8111-111111111111/aaaa1111-1111-4111-8111-111111111111/photo.jpg",
  mimeType: "image/jpeg",
  fileSizeBytes: 204800,
  originalFilename: "coffee_receipt.jpg",
  submissionStatus: "submitted",
  storeNameConfirmed: null,
  purchaseAtConfirmed: null,
  purchaseAmountKrw: null,
  receiptReference: null,
  reviewedAt: null,
  reviewReason: null,
  createdAt: "2026-11-16T03:00:00.000Z",
  updatedAt: "2026-11-16T03:00:00.000Z",
  restroomName: "테스트 제휴 화장실 1호",
  businessId: "dddd1111-1111-4111-8111-111111111111",
  businessName: "테스트 카페 수원점",
  businessRoadAddress: "경기도 수원시 팔달구 효원로 1",
  userDisplayName: "김철수",
  accessAuthorizedAt: "2026-11-16T01:00:00.000Z",
  accessExpiresAt: "2026-11-16T02:00:00.000Z",
  accessStatus: "authorized",
  policyVersion: 1,
  depositAmountKrw: 1000,
  receiptWindowHours: 24,
  receiptWindowDeadline: "2026-11-17T01:00:00.000Z",
  minPurchaseKrw: 3000,
  paymentOrderId: "ord-1111",
  paymentOrderNumber: "HM_ORD_1001",
  paymentAmountKrw: 1000,
  paymentStatus: "approved",
  paymentMode: "test",
  paymentApprovedAt: "2026-11-16T01:00:00.000Z",
  refundStatus: "none",
  refundAmountKrw: null,
  refundRequestedAt: null,
  refundCompletedAt: null,
};

const mockApprovedItem: AdminReceiptListItem = {
  ...mockPendingItem,
  id: "22222222-2222-4222-8222-222222222222",
  submissionStatus: "approved",
  storeNameConfirmed: "테스트 카페 수원점",
  purchaseAtConfirmed: "2026-11-16T02:45:00.000Z",
  purchaseAmountKrw: 4500,
  receiptReference: "REC-4500",
  reviewedAt: "2026-11-16T03:10:00.000Z",
  reviewReason: "매장 상호 및 결제 시간 확인 완료",
};

describe("TASK 29: AdminReceiptComparisonCard", () => {
  afterEach(() => {
    cleanup();
  });

  it("가게·이용·버전정책·결제보증금·영수증 확인값과 출처를 구분하여 표시한다", () => {
    render(<AdminReceiptComparisonCard receipt={mockPendingItem} />);

    expect(screen.getByTestId("compare-business-name").textContent).toBe(
      "테스트 카페 수원점"
    );
    expect(screen.getByTestId("compare-business-address").textContent).toBe(
      "경기도 수원시 팔달구 효원로 1"
    );
    expect(screen.getByTestId("compare-restroom-name").textContent).toContain(
      "테스트 제휴 화장실 1호"
    );
    expect(screen.getByTestId("compare-access-authorized-at").textContent).toContain(
      "authorized"
    );
    expect(screen.getByTestId("compare-receipt-window").textContent).toContain(
      "24시간"
    );
    expect(screen.getByTestId("compare-payment-amount").textContent).toContain(
      "1,000원"
    );
    expect(screen.getByTestId("compare-payment-order-meta").textContent).toContain(
      "HM_ORD_1001"
    );
    expect(screen.getByTestId("compare-deposit-amount").textContent).toContain(
      "최소 구매 3,000원"
    );
    // Unreviewed receipt purchase fields remain unconfirmed (not fabricated)
    expect(screen.getByTestId("compare-confirmed-amount").textContent).toContain(
      "미확인"
    );
    expect(
      screen.getByTestId("verification-guidelines-section").textContent
    ).toContain("보증금과 구매금액 구분");
  });

  it("결제 주문이나 환급 기록이 없는 경우 임의 생성 없이 안전하게 표시한다", () => {
    const noOrderReceipt: AdminReceiptListItem = {
      ...mockPendingItem,
      paymentOrderId: null,
      paymentOrderNumber: null,
      paymentAmountKrw: null,
      paymentStatus: null,
      paymentMode: null,
      paymentApprovedAt: null,
      refundStatus: "none",
    };

    render(<AdminReceiptComparisonCard receipt={noOrderReceipt} />);

    expect(screen.getByTestId("compare-payment-amount").textContent).toBe(
      "결제 주문 기록 없음"
    );
    expect(screen.getByTestId("compare-payment-order-meta").textContent).toBe(
      "결제 주문 기록 없음"
    );
    expect(screen.getByTestId("admin-refund-status-label").textContent).toContain(
      "심사 대기 중 (환급 승인 전)"
    );
    expect(screen.getByTestId("compare-pg-refund-status").textContent).toBe(
      "none (환급 요청 없음)"
    );
  });

  it("submitted 상태와 approved 상태(환급 기록 없음)의 환급 상태 문구를 구분해 표시한다", () => {
    const { rerender } = render(
      <AdminReceiptComparisonCard receipt={mockPendingItem} />
    );

    expect(screen.getByTestId("admin-refund-status-label").textContent).toContain(
      "심사 대기 중 (환급 승인 전)"
    );
    expect(screen.getByTestId("compare-pg-refund-status").textContent).toBe(
      "none (환급 요청 없음)"
    );

    rerender(<AdminReceiptComparisonCard receipt={mockApprovedItem} />);

    expect(screen.getByTestId("admin-refund-status-label").textContent).toContain(
      "환급 승인 (환급 미요청 · PG 환급 미실행)"
    );
    expect(screen.getByTestId("compare-pg-refund-status").textContent).toBe(
      "none (payment_refunds 기록 없음)"
    );
  });

  it("영수증 심사 승인과 실제 PG 환급 상태를 명확히 분리하여 표시한다", () => {
    const { rerender } = render(
      <AdminReceiptComparisonCard receipt={mockApprovedItem} />
    );

    expect(screen.getByTestId("detail-receipt-status-badge").textContent).toContain(
      "환급 승인 (환급 처리 대기)"
    );
    expect(screen.getByTestId("admin-refund-status-label").textContent).toContain(
      "환급 승인 (환급 미요청 · PG 환급 미실행)"
    );
    expect(screen.getByTestId("compare-pg-refund-status").textContent).toBe(
      "none (payment_refunds 기록 없음)"
    );
    expect(screen.getByTestId("compare-confirmed-amount").textContent).toBe(
      "4,500원"
    );

    rerender(
      <AdminReceiptComparisonCard
        receipt={{
          ...mockApprovedItem,
          refundStatus: "succeeded",
          refundAmountKrw: 1000,
          refundRequestedAt: "2026-11-16T03:12:00.000Z",
          refundCompletedAt: "2026-11-16T03:13:00.000Z",
        }}
      />
    );
    expect(screen.getByTestId("detail-receipt-status-badge").textContent).toContain(
      "테스트 환급 완료"
    );
    expect(screen.getByTestId("compare-pg-refund-status").textContent).toBe(
      "succeeded (테스트 결제 취소 완료)"
    );
    expect(screen.getByTestId("compare-refund-amount").textContent).toBe(
      "1,000원"
    );
  });
});

describe("TASK 29: AdminReceiptImageViewer", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("비공개 서명 URL을 API로 조회해 원본 뷰어와 확대 기능을 제공하고 공개 URL을 쓰지 않는다", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        signedUrl:
          "https://private.supabase.co/storage/v1/object/sign/receipts/test.jpg?token=secret-signed",
        expiresIn: 900,
        storagePath: mockPendingItem.storagePath,
        receiptId: mockPendingItem.id,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AdminReceiptImageViewer
        receiptId={mockPendingItem.id}
        mimeType="image/jpeg"
        fileSizeBytes={204800}
        originalFilename="coffee_receipt.jpg"
      />
    );

    const previewImg = (await screen.findByTestId(
      "receipt-preview-img"
    )) as HTMLImageElement;
    expect(previewImg.src).toContain("object/sign/receipts/test.jpg?token=");
    expect(previewImg.src).not.toContain("/object/public/");
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/admin/receipts/${mockPendingItem.id}/image`,
      expect.objectContaining({ method: "GET", cache: "no-store" })
    );

    // Trigger onLoad with natural dimensions
    Object.defineProperty(previewImg, "naturalWidth", { value: 1200 });
    Object.defineProperty(previewImg, "naturalHeight", { value: 1600 });
    fireEvent.load(previewImg);

    // Open original full viewer
    fireEvent.click(screen.getByTestId("open-original-image-viewer"));
    const modal = screen.getByTestId("original-image-viewer-modal");
    expect(modal).toBeTruthy();

    fireEvent.click(screen.getByTestId("zoom-mode-100"));
    const fullImg = screen.getByTestId(
      "receipt-original-full-img"
    ) as HTMLImageElement;
    expect(fullImg.style.width).toBe("1200px");
    expect(fullImg.style.height).toBe("1600px");

    fireEvent.click(screen.getByTestId("close-original-image-viewer"));
    expect(screen.queryByTestId("original-image-viewer-modal")).toBeNull();
  });

  it("이미지 로드 오류 또는 URL 만료 시 만료 안내와 새 열람 URL 발급 버튼을 제공한다", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          signedUrl: "https://private.supabase.co/signed-expired?token=old",
          expiresIn: 900,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          signedUrl: "https://private.supabase.co/signed-fresh?token=new",
          expiresIn: 900,
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AdminReceiptImageViewer
        receiptId={mockPendingItem.id}
        mimeType="image/jpeg"
        fileSizeBytes={204800}
        originalFilename="coffee_receipt.jpg"
      />
    );

    const img = await screen.findByTestId("receipt-preview-img");
    fireEvent.error(img);

    expect(screen.getByTestId("receipt-image-expired-warning")).toBeTruthy();

    fireEvent.click(screen.getByTestId("receipt-image-refresh-button"));
    const refreshedImg = (await screen.findByTestId(
      "receipt-preview-img"
    )) as HTMLImageElement;
    expect(refreshedImg.src).toContain("signed-fresh");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("expiresIn 타이머가 만료되면 자동으로 만료 상태로 전환한다", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        signedUrl: "https://private.supabase.co/signed-short?token=short",
        expiresIn: 2,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AdminReceiptImageViewer
        receiptId={mockPendingItem.id}
        mimeType="image/jpeg"
        fileSizeBytes={204800}
        originalFilename="coffee_receipt.jpg"
      />
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("receipt-preview-img")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.getByTestId("receipt-image-expired-warning")).toBeTruthy();
  });
});

describe("TASK 29: AdminReceiptDecisionForm", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("필수 사유(2자 이상) 미입력 시 제출을 차단하고 API를 호출하지 않는다", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AdminReceiptDecisionForm
        receipt={mockPendingItem}
        onDecisionSuccess={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId("decision-option-rejected"));
    fireEvent.change(screen.getByTestId("input-review-reason"), {
      target: { value: "가" },
    });
    fireEvent.click(screen.getByTestId("decision-review-submit-button"));

    expect(screen.getByTestId("decision-validation-error").textContent).toContain(
      "최소 2자 이상"
    );
    expect(screen.queryByTestId("decision-confirm-panel")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("최종 제출 전 확인 단계 후 승인 요청 시 x-idempotency-key를 전송하며 PG 환급 API는 호출하지 않는다", async () => {
    const onDecisionSuccess = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        receipt: {
          ...mockPendingItem,
          submissionStatus: "approved",
          reviewedAt: "2026-11-16T04:00:00.000Z",
          reviewReason: "매장 영수증 확인 완료",
          storeNameConfirmed: "테스트 카페 수원점",
          purchaseAmountKrw: 4500,
        },
        auditId: "audit-1111",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <AdminReceiptDecisionForm
        receipt={mockPendingItem}
        onDecisionSuccess={onDecisionSuccess}
      />
    );

    fireEvent.click(screen.getByTestId("decision-option-approved"));
    fireEvent.change(screen.getByTestId("input-confirmed-amount"), {
      target: { value: "4500" },
    });
    fireEvent.change(screen.getByTestId("input-review-reason"), {
      target: { value: "매장 영수증 확인 완료" },
    });

    // Step 1: Pre-submit review
    fireEvent.click(screen.getByTestId("decision-review-submit-button"));
    expect(screen.getByTestId("decision-confirm-panel")).toBeTruthy();
    expect(
      screen.getByTestId("confirm-no-pg-refund-notice").textContent
    ).toContain("PG 결제 취소 및 실제 환급은 실행되지 않습니다");
    expect(fetchMock).not.toHaveBeenCalled();

    // Step 2: Rapid double-click on final confirm button -> only 1 POST call
    const finalBtn = screen.getByTestId("decision-final-submit-button");
    fireEvent.click(finalBtn);
    fireEvent.click(finalBtn);

    await waitFor(() => {
      expect(onDecisionSuccess).toHaveBeenCalledTimes(1);
    });

    const updatedReceipt = onDecisionSuccess.mock.calls[0][0];
    rerender(
      <AdminReceiptDecisionForm
        receipt={updatedReceipt}
        onDecisionSuccess={onDecisionSuccess}
      />
    );
    expect(screen.getByTestId("decision-success-banner").textContent).toContain(
      "PG 결제 취소(실제 환급)는 아직 실행되지 않았습니다"
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/v1/admin/receipts/${mockPendingItem.id}/decision`);
    expect(init.method).toBe("POST");
    expect(init.headers["x-idempotency-key"]).toBeTruthy();
    const sentBody = JSON.parse(init.body);
    expect(sentBody).toMatchObject({
      decision: "approved",
      reason: "매장 영수증 확인 완료",
      confirmedAmount: 4500,
    });
    // Ensure no PG refund call was made
    expect(
      fetchMock.mock.calls.some(([calledUrl]) =>
        String(calledUrl).includes("refund") || String(calledUrl).includes("cancel")
      )
    ).toBe(false);
  });

  it("네트워크 실패 후 동일 내용 재시도 시 동일한 x-idempotency-key를 재사용한다", async () => {
    const onDecisionSuccess = vi.fn();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network down"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          receipt: {
            ...mockPendingItem,
            submissionStatus: "resubmission_requested",
            reviewReason: "영수증 하단 금액 부분이 잘려 재제출 요청",
          },
          auditId: "audit-2222",
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <AdminReceiptDecisionForm
        receipt={mockPendingItem}
        onDecisionSuccess={onDecisionSuccess}
      />
    );

    fireEvent.click(
      screen.getByTestId("decision-option-resubmission_requested")
    );
    fireEvent.change(screen.getByTestId("input-review-reason"), {
      target: { value: "영수증 하단 금액 부분이 잘려 재제출 요청" },
    });
    fireEvent.click(screen.getByTestId("decision-review-submit-button"));
    fireEvent.click(screen.getByTestId("decision-final-submit-button"));

    await screen.findByTestId("decision-api-error");
    fireEvent.click(screen.getByTestId("decision-final-submit-button"));

    await waitFor(() => {
      expect(onDecisionSuccess).toHaveBeenCalledTimes(1);
    });

    const updatedResubmitReceipt = onDecisionSuccess.mock.calls[0][0];
    rerender(
      <AdminReceiptDecisionForm
        receipt={updatedResubmitReceipt}
        onDecisionSuccess={onDecisionSuccess}
      />
    );
    expect(screen.getByTestId("decision-success-banner").textContent).toContain(
      "재제출 요청 처리가 저장되었습니다"
    );

    const firstKey = fetchMock.mock.calls[0][1].headers["x-idempotency-key"];
    const secondKey = fetchMock.mock.calls[1][1].headers["x-idempotency-key"];
    expect(firstKey).toBe(secondKey);
  });

  it("409 충돌 응답 시 오류 메시지와 최신 목록 새로고침 버튼을 표시한다", async () => {
    const onRefreshRequested = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        ok: false,
        error: {
          code: "STATUS_CONFLICT",
          message: "이미 승인 완료된 영수증입니다.",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AdminReceiptDecisionForm
        receipt={mockPendingItem}
        onDecisionSuccess={vi.fn()}
        onRefreshRequested={onRefreshRequested}
      />
    );

    fireEvent.click(screen.getByTestId("decision-option-rejected"));
    fireEvent.change(screen.getByTestId("input-review-reason"), {
      target: { value: "다른 가게 영수증입니다." },
    });
    fireEvent.click(screen.getByTestId("decision-review-submit-button"));
    fireEvent.click(screen.getByTestId("decision-final-submit-button"));

    const errBox = await screen.findByTestId("decision-api-error");
    expect(errBox.textContent).toContain("HTTP 409");
    expect(errBox.textContent).toContain("이미 승인 완료된 영수증입니다.");

    fireEvent.click(screen.getByTestId("decision-conflict-refresh-button"));
    expect(onRefreshRequested).toHaveBeenCalledTimes(1);
  });

  it("이미 처리 완료된 영수증은 판정 입력 UI를 비활성화하고 완료 요약만 표시한다", () => {
    render(
      <AdminReceiptDecisionForm
        receipt={mockApprovedItem}
        onDecisionSuccess={vi.fn()}
      />
    );

    expect(screen.getByTestId("receipt-decision-finalized")).toBeTruthy();
    expect(screen.queryByTestId("decision-option-approved")).toBeNull();
    expect(screen.getByTestId("finalized-review-reason").textContent).toBe(
      "매장 상호 및 결제 시간 확인 완료"
    );
  });
});

describe("TASK 29: AdminReceiptsClient Queue & Integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("심사 대기열 목록, 필터 탭, 페이지네이션 및 빈 목록 상태를 정상 처리한다", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          items: [mockPendingItem],
          pagination: { page: 1, limit: 20, total: 25, totalPages: 2 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          items: [],
          pagination: { page: 2, limit: 20, total: 25, totalPages: 2 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          items: [mockApprovedItem],
          pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminReceiptsClient />);

    await screen.findByTestId(`admin-receipt-card-${mockPendingItem.id}`);
    expect(screen.getByTestId("pagination-summary").textContent).toContain(
      "1 / 2 페이지 (총 25건)"
    );

    // Next page -> empty
    fireEvent.click(screen.getByTestId("pagination-next-button"));
    await screen.findByTestId("admin-receipts-empty");

    // Approved filter tab
    fireEvent.click(screen.getByTestId("receipt-filter-tab-approved"));
    await screen.findByTestId(`admin-receipt-card-${mockApprovedItem.id}`);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/v1/admin/receipts?status=approved&page=1&limit=20",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("API 403/401 오류 시 권한 오류 배너를 표시한다", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: "관리자 권한이 필요합니다.",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminReceiptsClient />);

    const err = await screen.findByTestId("admin-receipts-error");
    expect(err.textContent).toContain("HTTP 403");
    expect(err.textContent).toContain("관리자 권한이 필요합니다.");
  });
});

