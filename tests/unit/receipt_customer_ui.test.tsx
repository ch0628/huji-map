/**
 * @vitest-environment jsdom
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  ReceiptStatusBadge,
  ReceiptItemCard,
  ReceiptUploadForm,
  ReceiptListClient,
  type CustomerReceiptItem,
} from "@/components/receipt";
import type { PublicReceiptSubmission } from "@/lib/receipts/types";

describe("ReceiptStatusBadge", () => {
  it("submitted 또는 review_required 상태에서 '관리자 검토 중'을 올바르게 표시한다", () => {
    const { rerender } = render(<ReceiptStatusBadge status="submitted" />);
    expect(screen.getByTestId("receipt-status-badge").textContent).toContain("관리자 검토 중");

    rerender(<ReceiptStatusBadge status="review_required" />);
    expect(screen.getByTestId("receipt-status-badge").textContent).toContain("관리자 검토 중");
  });

  it("approved 상태에서 환급 완료 여부에 따라 '환급 승인'과 '테스트 환급 완료'를 명확히 구분한다", () => {
    const { rerender } = render(
      <ReceiptStatusBadge status="approved" refundStatus="none" />
    );
    expect(screen.getByTestId("receipt-status-badge").textContent).toContain("환급 승인 (환급 처리 대기)");

    rerender(<ReceiptStatusBadge status="approved" refundStatus="completed" />);
    expect(screen.getByTestId("receipt-status-badge").textContent).toContain("테스트 환급 완료");
  });

  it("rejected 및 resubmission_requested 상태 뱃지를 올바르게 표시한다", () => {
    const { rerender } = render(<ReceiptStatusBadge status="rejected" />);
    expect(screen.getByTestId("receipt-status-badge").textContent).toContain("심사 반려");

    rerender(<ReceiptStatusBadge status="resubmission_requested" />);
    expect(screen.getByTestId("receipt-status-badge").textContent).toContain("영수증 재제출 요청");
  });
});

describe("ReceiptItemCard", () => {
  const mockReceipt: CustomerReceiptItem = {
    id: "sub-1111-2222-3333",
    accessSessionId: "sess-1111-2222-3333",
    userId: "user-1111-2222-3333",
    storagePath: "receipts/user/sess/sub.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: 1024 * 1024 * 2, // 2MB
    originalFilename: "my_coffee_receipt.jpg",
    submissionStatus: "submitted",
    storeNameConfirmed: null,
    purchaseAtConfirmed: null,
    purchaseAmountKrw: null,
    reviewReason: null,
    reviewedAt: null,
    createdAt: "2026-11-15T12:00:00Z",
    restroomName: "테스트 1호 화장실",
    partnerName: "테스트 카페 수원점",
    roadAddress: "경기 수원시 팔달구 매산로 1",
    depositAmountKrw: 1000,
    refundStatus: "none",
    refundAmountKrw: null,
    refundCompletedAt: null,
  };

  it("영수증 카드 기본 정보(매장명, 화장실명, 파일명, 보증금)를 렌더링한다", () => {
    render(<ReceiptItemCard receipt={mockReceipt} />);

    expect(screen.getByText(/테스트 카페 수원점/)).toBeDefined();
    expect(screen.getByText("테스트 1호 화장실")).toBeDefined();
    expect(screen.getByText(/my_coffee_receipt.jpg/)).toBeDefined();
    expect(screen.getByText(/1,000원 \(테스트\)/)).toBeDefined();
    expect(screen.getByTestId("card-receipt-status-badge").textContent).toContain("관리자 검토 중");
  });

  it("반려된 영수증의 경우 반려 사유를 노출한다", () => {
    const rejectedReceipt: CustomerReceiptItem = {
      ...mockReceipt,
      submissionStatus: "rejected",
      reviewReason: "영수증 날짜가 화장실 이용 시간과 24시간 이상 차이납니다.",
    };

    render(<ReceiptItemCard receipt={rejectedReceipt} />);
    expect(screen.getByTestId("receipt-review-reason-box").textContent).toContain(
      "영수증 날짜가 화장실 이용 시간과 24시간 이상 차이납니다."
    );
  });

  it("재제출 요청 상태에서 재제출 버튼을 노출하고 클릭 이벤트를 트리거한다", () => {
    const onResubmitMock = vi.fn();
    const resubmitReceipt: CustomerReceiptItem = {
      ...mockReceipt,
      submissionStatus: "resubmission_requested",
      reviewReason: "사진이 흐려 결제 금액이 보이지 않습니다. 다시 찍어주세요.",
    };

    render(
      <ReceiptItemCard
        receipt={resubmitReceipt}
        onResubmit={onResubmitMock}
      />
    );

    const resubmitBtn = screen.getByTestId("resubmit-receipt-btn");
    expect(resubmitBtn).toBeDefined();
    fireEvent.click(resubmitBtn);

    expect(onResubmitMock).toHaveBeenCalledWith("sess-1111-2222-3333");
  });

  it("고객 화면에 관리자 승인 버튼 또는 자동 환급 실행 버튼이 일체 존재하지 않는다", () => {
    render(<ReceiptItemCard receipt={mockReceipt} />);

    expect(screen.queryByText(/승인하기/)).toBeNull();
    expect(screen.queryByText(/환급받기/)).toBeNull();
    expect(screen.queryByText(/강제 승인/)).toBeNull();
  });
});

describe("ReceiptUploadForm", () => {
  beforeEach(() => {
    // URL.createObjectURL 모킹
    global.URL.createObjectURL = vi.fn(() => "blob:mock-preview-url");
    global.URL.revokeObjectURL = vi.fn();
  });

  it("지원하지 않는 파일 형식(PDF, TXT 등) 선택 시 에러를 표시하고 업로드를 차단한다", () => {
    render(
      <ReceiptUploadForm accessSessionId="sess-1234-5678" />
    );

    const input = screen.getByTestId("receipt-file-input") as HTMLInputElement;
    const invalidFile = new File(["dummy"], "receipt.pdf", {
      type: "application/pdf",
    });

    fireEvent.change(input, { target: { files: [invalidFile] } });

    expect(screen.getByTestId("receipt-upload-error-alert").textContent).toContain(
      "지원하지 않는 파일 형식입니다."
    );
    expect(screen.queryByTestId("receipt-upload-submit-btn")).toBeNull();
  });

  it("10MB 초과 파일 선택 시 에러를 표시하고 업로드를 차단한다", () => {
    render(
      <ReceiptUploadForm accessSessionId="sess-1234-5678" />
    );

    const input = screen.getByTestId("receipt-file-input") as HTMLInputElement;
    const oversizedFile = new File(
      [new Uint8Array(10 * 1024 * 1024 + 100)],
      "huge_receipt.jpg",
      { type: "image/jpeg" }
    );

    fireEvent.change(input, { target: { files: [oversizedFile] } });

    expect(screen.getByTestId("receipt-upload-error-alert").textContent).toContain(
      "10MB 이하여야 합니다"
    );
  });

  it("유효한 이미지 선택 시 미리보기가 렌더링되고 제출 버튼이 활성화된다", () => {
    render(
      <ReceiptUploadForm accessSessionId="sess-1234-5678" />
    );

    const input = screen.getByTestId("receipt-file-input") as HTMLInputElement;
    const validFile = new File(["dummy-img-bytes"], "valid_receipt.png", {
      type: "image/png",
    });

    fireEvent.change(input, { target: { files: [validFile] } });

    expect(screen.getByTestId("receipt-preview-img")).toBeDefined();
    expect(screen.getByText(/valid_receipt.png/)).toBeDefined();
    expect((screen.getByTestId("receipt-upload-submit-btn") as HTMLButtonElement).disabled).toBe(false);
  });

  it("업로드 인텐트 발급 -> 스토리지 업로드 -> 최종 메타데이터 제출 흐름이 순서대로 동작한다", async () => {
    const mockIntentRequester = vi.fn().mockResolvedValue({
      uploadUrl: "https://storage.mock.supabase.co/upload/path",
      storagePath: "receipts/user123/sess123/sub123.jpg",
      token: "mock-upload-token",
    });

    const mockStorageUploader = vi.fn().mockResolvedValue(undefined);

    const mockSubmitReceipt: PublicReceiptSubmission = {
      id: "receipt-sub-123",
      accessSessionId: "sess-1234-5678",
      userId: "user-123",
      storagePath: "receipts/user123/sess123/sub123.jpg",
      mimeType: "image/jpeg",
      fileSizeBytes: 1024,
      originalFilename: "receipt.jpg",
      submissionStatus: "submitted",
      storeNameConfirmed: null,
      purchaseAtConfirmed: null,
      purchaseAmountKrw: null,
      reviewedAt: null,
      reviewReason: null,
      createdAt: "2026-11-15T12:00:00Z",
    };

    const mockSubmitRequester = vi.fn().mockResolvedValue({
      ok: true,
      receipt: mockSubmitReceipt,
      reused: false,
    });

    const onSuccessMock = vi.fn();

    render(
      <ReceiptUploadForm
        accessSessionId="sess-1234-5678"
        partnerName="수원 카페"
        restroomName="본관 화장실"
        onSuccess={onSuccessMock}
        injectedUploadIntentRequester={mockIntentRequester}
        injectedStorageUploader={mockStorageUploader}
        injectedSubmitRequester={mockSubmitRequester}
      />
    );

    const input = screen.getByTestId("receipt-file-input") as HTMLInputElement;
    const validFile = new File(["fake-jpeg-bytes"], "receipt.jpg", {
      type: "image/jpeg",
    });

    fireEvent.change(input, { target: { files: [validFile] } });

    const submitBtn = screen.getByTestId("receipt-upload-submit-btn");
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockIntentRequester).toHaveBeenCalledWith(
        expect.objectContaining({
          accessSessionId: "sess-1234-5678",
          mimeType: "image/jpeg",
        })
      );
      expect(mockStorageUploader).toHaveBeenCalled();
      expect(mockSubmitRequester).toHaveBeenCalledWith(
        expect.objectContaining({
          accessSessionId: "sess-1234-5678",
          storagePath: "receipts/user123/sess123/sub123.jpg",
          mimeType: "image/jpeg",
        })
      );
    });

    // 제출 완료 화면 표시 검증
    expect(screen.getByTestId("receipt-upload-completed")).toBeDefined();
    expect(screen.getByTestId("completed-receipt-status").textContent).toContain("관리자 검토 중 (OCR/자동 승인 없음)");

    // 확인 버튼 클릭 시 onSuccess 호출 검증
    fireEvent.click(screen.getByTestId("receipt-upload-done-btn"));
    expect(onSuccessMock).toHaveBeenCalledWith(mockSubmitReceipt);
  });

  it("업로드 중 오류 발생 시 에러 알림과 재시도 버튼이 제공된다", async () => {
    const mockFailingIntent = vi
      .fn()
      .mockRejectedValue(new Error("영수증 제출 기한이 만료되었습니다."));

    render(
      <ReceiptUploadForm
        accessSessionId="sess-expired"
        injectedUploadIntentRequester={mockFailingIntent}
      />
    );

    const input = screen.getByTestId("receipt-file-input") as HTMLInputElement;
    const validFile = new File(["fake-bytes"], "receipt.png", {
      type: "image/png",
    });

    fireEvent.change(input, { target: { files: [validFile] } });
    fireEvent.click(screen.getByTestId("receipt-upload-submit-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("receipt-upload-error-alert").textContent).toContain(
        "영수증 제출 기한이 만료되었습니다."
      );
    });

    expect(screen.getByTestId("receipt-upload-retry-btn")).toBeDefined();
  });
});

describe("ReceiptListClient", () => {
  const mockReceiptsData = {
    receipts: [
      {
        id: "rec-1",
        accessSessionId: "sess-1",
        userId: "user-1",
        storagePath: "receipts/user-1/sess-1/1.jpg",
        mimeType: "image/jpeg" as const,
        fileSizeBytes: 2048,
        originalFilename: "receipt1.jpg",
        submissionStatus: "submitted" as const,
        storeNameConfirmed: null,
        purchaseAtConfirmed: null,
        purchaseAmountKrw: null,
        reviewReason: null,
        reviewedAt: null,
        createdAt: "2026-11-15T10:00:00Z",
        restroomName: "1호 화장실",
        partnerName: "1호점",
        roadAddress: "수원시 팔달구",
        depositAmountKrw: 1000,
        refundStatus: "none" as const,
        refundAmountKrw: null,
        refundCompletedAt: null,
      },
    ],
    eligibleSessions: [
      {
        accessSessionId: "sess-2",
        restroomId: "rest-2",
        restroomName: "2호 화장실",
        partnerName: "2호점",
        roadAddress: "수원시 영통구",
        depositAmountKrw: 1000,
        authorizedAt: "2026-11-15T11:00:00Z",
        expiresAt: "2026-11-15T12:00:00Z",
        receiptWindowHours: 24,
        receiptWindowDeadline: "2026-11-16T11:00:00Z",
        isWindowExpired: false,
        hasPendingReceipt: false,
        hasApprovedReceipt: false,
      },
    ],
  };

  it("테스트 워터마크 배너와 기본 탭 네비게이션을 렌더링한다", () => {
    render(<ReceiptListClient initialData={mockReceiptsData} />);

    expect(screen.getByTestId("receipt-test-mode-watermark").textContent).toContain(
      "테스트 결제 · 실제 돈은 청구되지 않음"
    );
    expect(screen.getByTestId("tab-submitted-receipts").textContent).toContain("제출 내역 (1)");
    expect(screen.getByTestId("tab-eligible-sessions").textContent).toContain("제출 가능 이용권 (1)");
  });

  it("탭 전환 시 각각의 목록을 올바르게 표시한다", () => {
    render(<ReceiptListClient initialData={mockReceiptsData} />);

    // 기본: 제출 내역 탭
    expect(screen.getByTestId("submitted-receipts-section")).toBeDefined();
    expect(screen.getByText("1호 화장실")).toBeDefined();

    // 제출 가능 이용권 탭 클릭
    fireEvent.click(screen.getByTestId("tab-eligible-sessions"));
    expect(screen.getByTestId("eligible-sessions-section")).toBeDefined();
    expect(screen.getByText("2호 화장실")).toBeDefined();
  });

  it("제출 가능 이용권 카드에서 '영수증 사진 등록하기' 클릭 시 업로드 폼이 활성화된다", () => {
    render(<ReceiptListClient initialData={mockReceiptsData} />);

    fireEvent.click(screen.getByTestId("tab-eligible-sessions"));
    const openFormBtn = screen.getByTestId("open-upload-form-btn");
    fireEvent.click(openFormBtn);

    expect(screen.getByTestId("active-upload-section")).toBeDefined();
    expect(screen.getByTestId("receipt-upload-form")).toBeDefined();
  });

  it("빈 데이터일 때 적절한 안내 문구를 렌더링한다", () => {
    render(
      <ReceiptListClient
        initialData={{ receipts: [], eligibleSessions: [] }}
      />
    );

    expect(screen.getByTestId("empty-receipts-box").textContent).toContain(
      "제출된 영수증이 없습니다"
    );

    fireEvent.click(screen.getByTestId("tab-eligible-sessions"));
    expect(screen.getByTestId("empty-eligible-sessions-box").textContent).toContain(
      "영수증을 제출할 이용권이 없습니다"
    );
  });
});
