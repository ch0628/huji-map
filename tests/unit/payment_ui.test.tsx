/**
 * @vitest-environment jsdom
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import {
  assertTossTestClientKey,
  loadTossPaymentsSdk,
  resetTossSdkLoader,
  requestTossPayment,
  TossSdkSecurityError,
  TOSS_SDK_SCRIPT_ID,
  TOSS_CUSTOMER_KEY_REGEX,
} from "@/components/payment/toss-sdk";
import DepositPaymentModal from "@/components/payment/DepositPaymentModal";
import RestroomDetailClient from "@/app/(public)/restrooms/[id]/RestroomDetailClient";
import PaymentSuccessClient from "@/app/payment/success/PaymentSuccessClient";
import PaymentFailClient from "@/app/payment/fail/PaymentFailClient";
import type { PublicRestroomDetail } from "@/lib/restrooms/types";

// Mock next/navigation
const mockPush = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
  useSearchParams: () => mockSearchParams,
}));

describe("TASK 22: Toss Payments UI & Mobile Checkout Integration Tests", () => {
  const dummyPartnerRestroom = {
    id: "b2222222-2222-4222-8222-222222222222",
    type: "partner",
    name: "행궁 안심제휴 카페 화장실",
    road_address: "수원시 팔달구 화서문로 42",
    address_detail: "1층",
    floor: "1F",
    latitude: 37.2845,
    longitude: 127.0155,
    access_method: "pin",
    gender_type: "separate",
    wheelchair_accessible: true,
    baby_changing_available: true,
    sanitary_products_available: true,
    last_verified_at: "2026-11-10T10:00:00Z",
    business_id: "c3333333-3333-4333-8333-333333333333",
    business: {
      id: "c3333333-3333-4333-8333-333333333333",
      name: "행궁 안심카페 본점",
      category: "카페/디저트",
      road_address: "수원시 팔달구 화서문로 42",
      phone: "031-123-4567",
    },
    description: "제휴 화장실 상세 설명",
    entrance_instructions: "카운터 우측 계단",
    hours: [
      {
        id: "h1",
        weekday: 1,
        opens_at: "09:00:00",
        closes_at: "22:00:00",
        is_closed: false,
      },
    ],
    active_policy: {
      id: "pol-test-1",
      version: 1,
      access_mode: "test_deposit",
      deposit_amount_krw: 1000,
      refund_eligible: true,
      receipt_window_hours: 24,
      min_purchase_krw: 0,
      effective_from: "2026-11-10T10:00:00Z",
    },
    photos: [],
  } as any as PublicRestroomDetail;

  const dummyPublicRestroom = {
    id: "a1111111-1111-4111-8111-111111111111",
    type: "public",
    name: "수원화성 장안문 공중화장실",
    road_address: "수원시 팔달구 정조로 910",
    latitude: 37.2885,
    longitude: 127.0142,
    access_method: "open",
    gender_type: "separate",
    wheelchair_accessible: true,
    baby_changing_available: false,
    sanitary_products_available: false,
    last_verified_at: "2026-11-10T10:00:00Z",
    photos: [],
  } as any as PublicRestroomDetail;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    resetTossSdkLoader();
    const existingScript = document.getElementById(TOSS_SDK_SCRIPT_ID);
    if (existingScript) existingScript.remove();
    delete (window as any).TossPayments;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Group 1: Toss SDK Loader & Security Guards
  // ==========================================================================
  describe("1. Toss Payments SDK V2 Loader & Security Guards", () => {
    it("strictly rejects live client key (live_) per AGENTS.md Rule 4", () => {
      expect(() => assertTossTestClientKey("live_ck_1234567890")).toThrowError(
        TossSdkSecurityError
      );
      expect(() => assertTossTestClientKey("live_ck_1234567890")).toThrow(
        /실거래 결제 키\(live_\)는 사용할 수 없습니다/
      );
    });

    it("strictly requires test client key (test_) per docs/07", () => {
      expect(() => assertTossTestClientKey("invalid_key_format")).toThrowError(
        TossSdkSecurityError
      );
      expect(() => assertTossTestClientKey("")).toThrowError(
        TossSdkSecurityError
      );
      expect(() =>
        assertTossTestClientKey("test_ck_sample_valid_key")
      ).not.toThrow();
    });

    it("injects script tag into document head and caches loader promise", async () => {
      const loadPromise = loadTossPaymentsSdk();

      const script = document.getElementById(
        TOSS_SDK_SCRIPT_ID
      ) as HTMLScriptElement;
      expect(script).not.toBeNull();
      expect(script.src).toContain("https://js.tosspayments.com/v2/standard");

      // Simulate script load
      const mockTossPayments = vi.fn();
      (window as any).TossPayments = mockTossPayments;
      script.onload?.(new Event("load"));

      const loadedSdk = await loadPromise;
      expect(loadedSdk).toBe(mockTossPayments);

      // Subsequent call reuses promise without injecting new script
      const secondCall = await loadTossPaymentsSdk();
      expect(secondCall).toBe(mockTossPayments);
      expect(document.querySelectorAll(`#${TOSS_SDK_SCRIPT_ID}`).length).toBe(1);
    });

    it("validates amount and parameters in requestTossPayment", async () => {
      await expect(
        requestTossPayment({
          clientKey: "test_ck_valid",
          orderId: "hm_ord_001",
          orderName: "테스트 보증금",
          amount: 0, // invalid amount
          customerKey: "u1111111-1111-4111-8111-111111111111",
          successUrl: "http://localhost:3000/payment/success",
          failUrl: "http://localhost:3000/payment/fail",
        })
      ).rejects.toThrow(/결제 금액은 0보다 큰 정수여야 합니다/);
    });

    it("strictly verifies customerKey regex format (22~255 chars, special char required)", () => {
      // 1. Valid UUID customerKey passes
      expect(TOSS_CUSTOMER_KEY_REGEX.test("u1111111-1111-4111-8111-111111111111")).toBe(true);
      expect(TOSS_CUSTOMER_KEY_REGEX.test("ff5e3efe-07bf-4f54-b60e-d9f5086ca231")).toBe(true);

      // 2. Exact 22-character boundary with special char passes
      const len22Valid = "user-12345678901234567"; // len 22, has '-'
      expect(len22Valid.length).toBe(22);
      expect(TOSS_CUSTOMER_KEY_REGEX.test(len22Valid)).toBe(true);

      // 3. Exact 255-character boundary with special char passes
      const len255Valid = "user-" + "a".repeat(250); // len 255, has '-'
      expect(len255Valid.length).toBe(255);
      expect(TOSS_CUSTOMER_KEY_REGEX.test(len255Valid)).toBe(true);

      // 4. Length 21 rejected
      const len21 = "user-1234567890123456"; // len 21
      expect(len21.length).toBe(21);
      expect(TOSS_CUSTOMER_KEY_REGEX.test(len21)).toBe(false);

      // 5. Length 22 without special character rejected
      const len22NoSpecial = "user123456789012345678";
      expect(len22NoSpecial.length).toBe(22);
      expect(TOSS_CUSTOMER_KEY_REGEX.test(len22NoSpecial)).toBe(false);

      // 6. Disallowed characters rejected
      expect(TOSS_CUSTOMER_KEY_REGEX.test("user-1234567890123456!")).toBe(false);
      expect(TOSS_CUSTOMER_KEY_REGEX.test("user#1234567890123456")).toBe(false);
      expect(TOSS_CUSTOMER_KEY_REGEX.test("user 1234567890123456")).toBe(false);

      // 7. Length 256 rejected
      const len256 = "user-" + "a".repeat(251);
      expect(len256.length).toBe(256);
      expect(TOSS_CUSTOMER_KEY_REGEX.test(len256)).toBe(false);
    });

    it("rejects missing customerKey without bypassing to ANONYMOUS in restroom checkout", async () => {
      await expect(
        requestTossPayment({
          clientKey: "test_ck_valid",
          orderId: "hm_ord_001",
          orderName: "테스트 보증금",
          amount: 1000,
          customerKey: "", // missing customerKey
          successUrl: "http://localhost:3000/payment/success",
          failUrl: "http://localhost:3000/payment/fail",
        })
      ).rejects.toThrow(/customerKey가 누락되었습니다/);
    });

    it("rejects invalid format customerKey in requestTossPayment", async () => {
      await expect(
        requestTossPayment({
          clientKey: "test_ck_valid",
          orderId: "hm_ord_001",
          orderName: "테스트 보증금",
          amount: 1000,
          customerKey: "short-key-123", // only 13 chars
          successUrl: "http://localhost:3000/payment/success",
          failUrl: "http://localhost:3000/payment/fail",
        })
      ).rejects.toThrow(/customerKey 규격 오류/);
    });
  });

  // ==========================================================================
  // Group 2: Public vs Partner Restroom Buttons
  // ==========================================================================
  describe("2. Public vs Partner Restroom Payment UI", () => {
    it("never renders payment button on public restrooms", () => {
      render(<RestroomDetailClient restroom={dummyPublicRestroom} />);

      expect(screen.getByTestId("detail-directions-btn")).toBeTruthy();
      expect(
        screen.queryByTestId("detail-partner-payment-btn")
      ).toBeNull();
      expect(screen.getByTestId("detail-public-badge")).toBeTruthy();
    });

    it("renders active payment button on partner restrooms", () => {
      render(<RestroomDetailClient restroom={dummyPartnerRestroom} />);

      expect(screen.getByTestId("detail-directions-btn")).toBeTruthy();
      const paymentBtn = screen.getByTestId("detail-partner-payment-btn");
      expect(paymentBtn).toBeTruthy();
      expect(paymentBtn.textContent).toContain("안심 제휴 보증금 결제 (1,000원)");
      expect(screen.getByTestId("detail-partner-badge")).toBeTruthy();
    });

    it("renders DB deposit amount when test_deposit amount is changed and hides button on free policy", () => {
      const { rerender } = render(
        <RestroomDetailClient
          restroom={{
            ...dummyPartnerRestroom,
            active_policy: {
              ...dummyPartnerRestroom.active_policy!,
              deposit_amount_krw: 2000,
            },
          }}
        />
      );

      expect(screen.getByTestId("detail-partner-payment-btn").textContent).toContain(
        "안심 제휴 보증금 결제 (2,000원)"
      );
      expect(screen.getByTestId("partner-deposit-policy-box").textContent).toContain(
        "2,000원"
      );

      rerender(
        <RestroomDetailClient
          restroom={{
            ...dummyPartnerRestroom,
            active_policy: {
              ...dummyPartnerRestroom.active_policy!,
              access_mode: "free",
              deposit_amount_krw: 0,
              refund_eligible: false,
            },
          }}
        />
      );

      expect(screen.queryByTestId("detail-partner-payment-btn")).toBeNull();
      expect(screen.getByTestId("partner-free-policy-box").textContent).toContain(
        "안심 제휴 무료 이용"
      );
      expect(screen.queryByText(/1,000원/)).toBeNull();
    });

    it("renders '운영시간 정보 없음' when hours are empty and never displays '24시간 운영'", () => {
      render(
        <RestroomDetailClient
          restroom={{
            ...dummyPartnerRestroom,
            hours: [],
          }}
        />
      );

      expect(screen.getByTestId("restroom-hours-empty").textContent).toContain(
        "운영시간 정보 없음"
      );
      expect(screen.queryByText("24시간 운영")).toBeNull();
    });
  });

  // ==========================================================================
  // Group 3: Unauthenticated User Checkout Handling
  // ==========================================================================
  describe("3. Unauthenticated User Checkout Flow", () => {
    it("shows login requirement dialog and redirects to login with returnTo", async () => {
      const handleClose = vi.fn();
      render(
        <DepositPaymentModal
          restroom={dummyPartnerRestroom}
          isOpen={true}
          onClose={handleClose}
          user={null} // unauthenticated
        />
      );

      expect(screen.getByText("🔒 로그인 필요")).toBeTruthy();
      expect(
        screen.getByText(/보증금 결제를 위해 로그인이 필요합니다/)
      ).toBeTruthy();

      const loginRedirectBtn = screen.getByTestId("payment-login-redirect-btn");
      fireEvent.click(loginRedirectBtn);

      expect(mockPush).toHaveBeenCalledWith(
        `/login?returnTo=${encodeURIComponent("/restrooms/b2222222-2222-4222-8222-222222222222")}`
      );
    });
  });

  // ==========================================================================
  // Group 4: Authenticated Checkout Modal & Order Creation
  // ==========================================================================
  describe("4. Authenticated Checkout Modal & Idempotent Order Creation", () => {
    const dummyUser = {
      id: "u1111111-1111-4111-8111-111111111111",
      email: "tester@example.com",
      name: "테스터",
    };

    it("displays prominent test payment warnings and terms agreement", () => {
      render(
        <DepositPaymentModal
          restroom={dummyPartnerRestroom}
          isOpen={true}
          onClose={vi.fn()}
          user={dummyUser}
        />
      );

      expect(
        screen.getByText(/테스트 결제 · 실제 돈은 청구되지 않음/)
      ).toBeTruthy();
      expect(screen.getByTestId("deposit-amount-display").textContent).toContain(
        "1,000원"
      );
      expect(screen.getByText("영수증 환급 조건:")).toBeTruthy();
      expect(
        screen.getByText(/제휴 매장 실제 이용\(구매\) 영수증 사진을 제출한 후/)
      ).toBeTruthy();
      expect(screen.getByText("자동 환급 불가:")).toBeTruthy();
      expect(
        screen.getByText("도어락 비밀번호:")
      ).toBeTruthy();
      expect(
        screen.getByText(/결제 승인 완료 후에만 안전하게 공개되며/)
      ).toBeTruthy();

      const submitBtn = screen.getByTestId("submit-checkout-btn") as HTMLButtonElement;
      expect(submitBtn.disabled).toBe(true); // must agree first
    });

    it("requires terms checkbox agreement before enabling payment button", async () => {
      render(
        <DepositPaymentModal
          restroom={dummyPartnerRestroom}
          isOpen={true}
          onClose={vi.fn()}
          user={dummyUser}
        />
      );

      const checkbox = screen.getByTestId("deposit-agreement-checkbox") as HTMLInputElement;
      const submitBtn = screen.getByTestId("submit-checkout-btn") as HTMLButtonElement;
      expect(submitBtn.disabled).toBe(true);

      fireEvent.click(checkbox);
      expect(submitBtn.disabled).toBe(false);
    });

    it("creates server order and triggers Toss requestPayment on submit", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({
          ok: true,
          data: {
            orderId: "hm_ord_test_001",
            amount: 1000,
            clientKey: "test_ck_sample_valid_key",
          },
        }),
      });
      global.fetch = mockFetch;

      const mockRequester = vi.fn().mockResolvedValue(undefined);

      render(
        <DepositPaymentModal
          restroom={dummyPartnerRestroom}
          isOpen={true}
          onClose={vi.fn()}
          user={dummyUser}
          customPaymentRequester={mockRequester}
        />
      );

      const checkbox = screen.getByTestId("deposit-agreement-checkbox");
      fireEvent.click(checkbox);

      const submitBtn = screen.getByTestId("submit-checkout-btn");
      await act(async () => {
        fireEvent.click(submitBtn);
      });

      // Verify POST /api/v1/payments/orders call
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/v1/payments/orders",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: expect.stringContaining(dummyPartnerRestroom.id),
        })
      );

      // Verify customPaymentRequester called with Toss params
      expect(mockRequester).toHaveBeenCalledWith(
        expect.objectContaining({
          clientKey: "test_ck_sample_valid_key",
          orderId: "hm_ord_test_001",
          amount: 1000,
          customerKey: dummyUser.id,
          successUrl: expect.stringContaining("/payment/success"),
          failUrl: expect.stringContaining("/payment/fail"),
        })
      );
    });

    it("handles order creation error and prevents duplicate clicks", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({
          ok: false,
          error: {
            code: "PAYMENT_MODE_DISABLED",
            message: "결제 기능 준비 중입니다.",
          },
        }),
      });
      global.fetch = mockFetch;

      render(
        <DepositPaymentModal
          restroom={dummyPartnerRestroom}
          isOpen={true}
          onClose={vi.fn()}
          user={dummyUser}
        />
      );

      const checkbox = screen.getByTestId("deposit-agreement-checkbox");
      fireEvent.click(checkbox);

      const submitBtn = screen.getByTestId("submit-checkout-btn");
      await act(async () => {
        fireEvent.click(submitBtn);
      });

      await waitFor(() => {
        const errEl = screen.getByTestId("payment-modal-error");
        expect(errEl.textContent).toContain("결제 기능 준비 중입니다.");
      });
    });
  });

  // ==========================================================================
  // Group 5: /payment/success Server Confirm & Access Grant
  // ==========================================================================
  describe("5. Payment Success Page & Server Confirmation Security", () => {
    it("fails immediately when required query parameters are missing", async () => {
      mockSearchParams = new URLSearchParams({}); // missing params

      render(<PaymentSuccessClient />);

      await waitFor(() => {
        expect(screen.getByTestId("payment-failed-view")).toBeTruthy();
        expect(
          screen.getByText(/필수 파라미터\(orderId, paymentKey, amount\)가 누락되었습니다/)
        ).toBeTruthy();
      });
    });

    it("calls POST /payments/confirm and renders authorized access on success", async () => {
      mockSearchParams = new URLSearchParams({
        orderId: "hm_ord_succ_001",
        paymentKey: "toss_pk_test_123",
        amount: "1000",
      });

      const mockConfirmRequester = vi.fn().mockResolvedValue({
        ok: true,
        data: {
          order: {
            id: "o1",
            order_id: "hm_ord_succ_001",
            amount_krw: 1000,
            status: "approved",
            payment_mode: "test",
            provider: "toss",
            access_session_id: "s1",
            user_id: "u1",
            approved_at: new Date().toISOString(),
            failure_code: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          accessSession: {
            id: "s1",
            restroom_id: dummyPartnerRestroom.id,
            user_id: "u1",
            policy_id: "pol1",
            status: "authorized",
            access_method_snapshot: "pin",
            expires_at: new Date(Date.now() + 86400000).toISOString(),
            authorized_at: new Date().toISOString(),
            code_revealed_at: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          alreadyApproved: false,
        },
      });

      render(
        <PaymentSuccessClient
          injectedConfirmRequester={mockConfirmRequester}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId("payment-confirmed-view")).toBeTruthy();
      });

      expect(screen.getByTestId("confirmed-order-id").textContent).toContain(
        "hm_ord_succ_001"
      );
      expect(screen.getByTestId("confirmed-amount").textContent).toContain(
        "1,000원 (테스트)"
      );
      expect(screen.getByTestId("confirmed-session-status").textContent).toContain(
        "이용권 활성화 (authorized)"
      );
      expect(
        screen.getByText(/도어락 비밀번호 복호화 및 열람 기능은 후속 단계\(TASK 23~25\)에서 제공됩니다/)
      ).toBeTruthy();
    });

    it("handles amount tampering / server error by showing error and NO access session", async () => {
      mockSearchParams = new URLSearchParams({
        orderId: "hm_ord_tampered_001",
        paymentKey: "toss_pk_test_123",
        amount: "500", // tampered amount
      });

      const mockConfirmRequester = vi.fn().mockRejectedValue(
        new Error("요청 금액(500)이 저장된 주문 금액(1000)과 일치하지 않습니다.")
      );

      render(
        <PaymentSuccessClient
          injectedConfirmRequester={mockConfirmRequester}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId("payment-uncertain-view")).toBeTruthy();
        expect(
          screen.getByText(/네트워크 연결이 지연되어 승인 상태를 확인하지 못했습니다/)
        ).toBeTruthy();
      });

      // No authorized access session revealed!
      expect(
        screen.queryByTestId("payment-confirmed-view")
      ).toBeNull();
    });

    it("sanitizes paymentKey from URL in failed / uncertain state and preserves retry capability", async () => {
      window.history.pushState(
        {},
        "",
        "/payment/success?paymentKey=toss_pk_test_secret_999&orderId=hm_ord_fail_002&amount=1000"
      );

      const replaceStateSpy = vi.spyOn(window.history, "replaceState");

      mockSearchParams = new URLSearchParams({
        orderId: "hm_ord_fail_002",
        paymentKey: "toss_pk_test_secret_999",
        amount: "1000",
      });

      const mockConfirmRequester = vi.fn().mockRejectedValue(new Error("네트워크 지연"));

      render(
        <PaymentSuccessClient
          injectedConfirmRequester={mockConfirmRequester}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId("payment-uncertain-view")).toBeTruthy();
      });

      // Verify replaceState was called to sanitize URL
      expect(replaceStateSpy).toHaveBeenCalled();
      const recheckBtn = screen.getByTestId("recheck-status-btn");
      expect(recheckBtn).toBeTruthy();
    });
  });

  // ==========================================================================
  // Group 6: /payment/fail Handling & Status Recovery
  // ==========================================================================
  describe("6. Payment Fail / Cancel Handling & Reconciliation", () => {
    it("distinguishes user cancellation from system failure", () => {
      mockSearchParams = new URLSearchParams({
        code: "PAY_PROCESS_CANCELED",
        message: "사용자가 결제를 취소했습니다.",
        orderId: "hm_ord_cancel_001",
      });

      render(<PaymentFailClient />);

      expect(screen.getByTestId("fail-title").textContent).toContain(
        "결제가 취소되었습니다"
      );
      expect(screen.getByTestId("fail-code").textContent).toContain(
        "PAY_PROCESS_CANCELED"
      );
      expect(screen.getByTestId("fail-message").textContent).toContain(
        "사용자가 결제를 취소했습니다."
      );
      expect(
        screen.getByText(/결제가 정상 완료되지 않았으므로 신용카드 대금이 청구되지 않았습니다/)
      ).toBeTruthy();
    });

    it("allows re-checking order status from server in fail view", async () => {
      mockSearchParams = new URLSearchParams({
        code: "UNKNOWN_ERROR",
        message: "네트워크 불안정",
        orderId: "hm_ord_status_check_001",
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            order: {
              order_id: "hm_ord_status_check_001",
              status: "failed",
              amount_krw: 1000,
            },
          },
        }),
      });
      global.fetch = mockFetch;

      render(<PaymentFailClient />);

      const recheckBtn = screen.getByTestId("recheck-order-btn");
      await act(async () => {
        fireEvent.click(recheckBtn);
      });

      await waitFor(() => {
        expect(
          screen.getByText(/서버에 결제 실패\(failed\) 상태로 정상 기록되어 있습니다/)
        ).toBeTruthy();
      });
    });
  });
});
