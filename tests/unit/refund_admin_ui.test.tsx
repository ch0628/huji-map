/**
 * @vitest-environment jsdom
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";

const mockGetServerAuthSession = vi.fn();
const mockIsE2eMockSessionAllowed = vi.fn();
const mockCookies = vi.fn();

vi.mock("next/headers", () => ({
  cookies: () => mockCookies(),
}));

vi.mock("@/lib/auth", () => ({
  getServerAuthSession: () => mockGetServerAuthSession(),
  isE2eMockSessionAllowed: (v: string | undefined) =>
    mockIsE2eMockSessionAllowed(v),
}));

vi.mock("@/components/layout/AppShell", () => ({
  default: ({
    children,
    headerTitle,
  }: {
    children: React.ReactNode;
    headerTitle?: string;
  }) => (
    <div data-testid="app-shell" data-title={headerTitle}>
      {children}
    </div>
  ),
}));

import AdminRefundsPage from "@/app/admin/refunds/page";
import AdminRefundsClient from "@/components/payment/AdminRefundsClient";

const ORDER_ID_1 = "11111111-1111-4111-a111-111111111101";
const RECEIPT_ID_1 = "22222222-2222-4222-a222-222222222201";
const RECEIPT_ID_NO_ORDER = "22222222-2222-4222-a222-222222222202";
const ORDER_ID_FAILED = "11111111-1111-4111-a111-111111111103";
const RECEIPT_ID_FAILED = "22222222-2222-4222-a222-222222222203";
const ORDER_ID_EXPIRED = "11111111-1111-4111-a111-111111111104";
const ORDER_ID_SUCCEEDED = "11111111-1111-4111-a111-111111111105";

describe("TASK 31: 관리자 테스트 환급 화면 (/admin/refunds)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCookies.mockResolvedValue({ get: () => undefined });
    mockIsE2eMockSessionAllowed.mockReturnValue(false);
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
  });

  describe("1. /admin/refunds SSR 권한 가드", () => {
    it("설정 미완료 시 503 안내를 표시한다", async () => {
      mockGetServerAuthSession.mockResolvedValue({
        user: null,
        isAdmin: false,
        configReady: false,
      });

      const el = await AdminRefundsPage();
      render(el);
      expect(screen.getByTestId("admin-refunds-config-required-503")).toBeTruthy();
    });

    it("비로그인 사용자(비회원) 접근 시 401 안내와 로그인 링크를 반환한다", async () => {
      mockGetServerAuthSession.mockResolvedValue({
        user: null,
        isAdmin: false,
        configReady: true,
      });

      const el = await AdminRefundsPage();
      render(el);
      expect(screen.getByTestId("admin-refunds-unauthorized-401")).toBeTruthy();
      expect(
        screen.getByTestId("admin-refunds-login-link").getAttribute("href")
      ).toContain("/login?returnTo=%2Fadmin%2Frefunds");
    });

    it("일반 사용자(비관리자) 접근 시 403 차단 화면을 반환한다", async () => {
      mockGetServerAuthSession.mockResolvedValue({
        user: { id: "customer-1" },
        isAdmin: false,
        configReady: true,
      });

      const el = await AdminRefundsPage();
      render(el);
      expect(screen.getByTestId("admin-refunds-forbidden-403")).toBeTruthy();
      expect(screen.queryByTestId("admin-refunds-client")).toBeNull();
    });

    it("관리자 접근 시 AdminRefundsClient를 렌더링한다", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, items: [] }),
      }) as any;

      mockGetServerAuthSession.mockResolvedValue({
        user: { id: "admin-1" },
        isAdmin: true,
        configReady: true,
      });

      const el = await AdminRefundsPage();
      render(el);
      await waitFor(() => {
        expect(screen.getByTestId("admin-refunds-client")).toBeTruthy();
      });
    });
  });

  describe("2. AdminRefundsClient 환급 목록·요청·중복 방지·재조회·실패 사유", () => {
    it("테스트 모드 배너, 환급 적격 주문 및 제외 사유를 정확히 구분 표시한다", async () => {
      global.fetch = vi.fn(async (url: string) => {
        if (url.includes("/api/v1/admin/receipts")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              items: [
                {
                  id: RECEIPT_ID_1,
                  submissionStatus: "approved",
                  reviewedAt: "2026-11-20T12:00:00Z",
                  reviewReason: "실제 구매 영수증 확인",
                  businessName: "진미통닭",
                  restroomName: "진미 통닭",
                  paymentOrderId: ORDER_ID_1,
                  paymentOrderNumber: "hm_ord_1001",
                  paymentAmountKrw: 1000,
                  paymentStatus: "approved",
                  paymentMode: "test",
                  refundStatus: "none",
                },
                {
                  id: RECEIPT_ID_NO_ORDER,
                  submissionStatus: "approved",
                  reviewedAt: "2026-11-20T12:05:00Z",
                  businessName: "무료제휴점",
                  restroomName: "무료 화장실",
                  paymentOrderId: null,
                  paymentStatus: null,
                  refundStatus: "none",
                },
              ],
            }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, items: [] }),
        } as Response;
      }) as any;

      render(<AdminRefundsClient />);

      await waitFor(() => {
        expect(screen.getByTestId(`eligible-refund-card-${RECEIPT_ID_1}`)).toBeTruthy();
      });

      expect(screen.getByTestId("admin-refunds-test-banner").textContent).toContain(
        "PAYMENT_MODE=test"
      );
      expect(screen.getByTestId(`request-refund-btn-${ORDER_ID_1}`).textContent).toContain(
        "1,000원"
      );
      expect(screen.getByTestId(`ineligible-reason-${RECEIPT_ID_NO_ORDER}`).textContent).toContain(
        "연결된 테스트 보증금 결제 주문이 없습니다"
      );
    });

    it("환급 요청 버튼 클릭 -> 확인 -> POST /request 호출 및 더블클릭 중복 요청을 차단한다", async () => {
      let refundDone = false;
      let resolvePost: ((v: Response) => void) | null = null;
      let requestCallCount = 0;

      const mockFetch = vi.fn((url: string, init?: RequestInit) => {
        if (url.includes("/api/v1/admin/receipts")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              items: [
                {
                  id: RECEIPT_ID_1,
                  submissionStatus: "approved",
                  reviewedAt: "2026-11-20T12:00:00Z",
                  businessName: "진미통닭",
                  restroomName: "진미 통닭",
                  paymentOrderId: ORDER_ID_1,
                  paymentOrderNumber: "hm_ord_1001",
                  paymentAmountKrw: 1000,
                  paymentStatus: "approved",
                  paymentMode: "test",
                  refundStatus: refundDone ? "succeeded" : "none",
                },
              ],
            }),
          } as Response);
        }

        if (url.includes("/request")) {
          requestCallCount += 1;
          expect(init?.method).toBe("POST");
          const body = JSON.parse(String(init?.body || "{}"));
          expect(body.receiptSubmissionId).toBe(RECEIPT_ID_1);
          expect(body.idempotencyKey).toMatch(/^hm_refund_/);
          expect((init?.headers as Record<string, string>)["x-idempotency-key"]).toBe(
            body.idempotencyKey
          );

          return new Promise<Response>((resolve) => {
            resolvePost = resolve;
          });
        }

        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            items: refundDone
              ? [
                  {
                    id: "rf-1",
                    payment_order_id: ORDER_ID_1,
                    receipt_submission_id: RECEIPT_ID_1,
                    amount_krw: 1000,
                    status: "succeeded",
                    failure_reason: null,
                    requested_at: "2026-11-20T12:10:00Z",
                    completed_at: "2026-11-20T12:10:02Z",
                    orderNumber: "hm_ord_1001",
                    orderStatus: "approved",
                    paymentMode: "test",
                    receiptStatus: "approved",
                    manualCheckRequired: false,
                    canRetry: false,
                  },
                ]
              : [],
          }),
        } as Response);
      });

      global.fetch = mockFetch as any;

      render(<AdminRefundsClient />);

      await waitFor(() => {
        expect(screen.getByTestId(`request-refund-btn-${ORDER_ID_1}`)).toBeTruthy();
      });

      fireEvent.click(screen.getByTestId(`request-refund-btn-${ORDER_ID_1}`));
      const confirmBtn = screen.getByTestId(`confirm-refund-submit-${ORDER_ID_1}`);

      // Click twice rapidly -> inFlightOrdersRef prevents duplicate POST
      fireEvent.click(confirmBtn);
      fireEvent.click(confirmBtn);
      expect(requestCallCount).toBe(1);

      refundDone = true;
      await act(async () => {
        resolvePost?.({
          ok: true,
          status: 201,
          json: async () => ({
            ok: true,
            outcome: "succeeded",
            reused: false,
            requestId: "req-refund-001",
            refund: { id: "rf-1", amount_krw: 1000, status: "succeeded" },
          }),
        } as Response);
      });

      await waitFor(() => {
        expect(screen.getByTestId("admin-refunds-action-notice").textContent).toContain(
          "테스트 환급 완료 (1,000원)"
        );
      });

      // Switch to succeeded tab -> verified completed card has NO refund request button
      fireEvent.click(screen.getByTestId("refund-tab-succeeded"));
      await waitFor(() => {
        expect(screen.getByTestId(`refund-status-badge-${ORDER_ID_1}`).textContent).toContain(
          "테스트 환급 완료"
        );
      });
      expect(screen.queryByTestId(`request-refund-btn-${ORDER_ID_1}`)).toBeNull();
    });

    it("실패·불확실·15일 만료 환급의 사유 표시 및 상태 재조회(reconcile) 복구를 처리한다", async () => {
      let reconciledDone = false;

      global.fetch = vi.fn(async (url: string) => {
        if (url.includes("/api/v1/admin/receipts")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, items: [] }),
          } as Response;
        }
        if (url.includes(`/api/v1/admin/refunds/${ORDER_ID_FAILED}/reconcile`)) {
          reconciledDone = true;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              reconciled: true,
              pgStatus: "CANCELED",
              requestId: "req-rec-1",
              refund: { id: "rf-fail", amount_krw: 1000, status: "succeeded" },
            }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            items: [
              {
                id: "rf-fail",
                payment_order_id: ORDER_ID_FAILED,
                receipt_submission_id: RECEIPT_ID_FAILED,
                amount_krw: 1000,
                status: reconciledDone ? "succeeded" : "processing",
                failure_reason: reconciledDone
                  ? null
                  : "UNCERTAIN_TIMEOUT: 토스페이먼츠 취소 응답 시간 초과",
                requested_at: "2026-11-20T12:10:00Z",
                completed_at: reconciledDone ? "2026-11-20T12:12:00Z" : null,
                orderNumber: "hm_ord_fail_1",
                orderStatus: "approved",
                paymentMode: "test",
                receiptStatus: "approved",
                manualCheckRequired: false,
                canRetry: !reconciledDone,
              },
              {
                id: "rf-expired",
                payment_order_id: ORDER_ID_EXPIRED,
                receipt_submission_id: "22222222-2222-4222-a222-222222222204",
                amount_krw: 1000,
                status: "failed",
                failure_reason: "MANUAL_CHECK_REQUIRED: 15일 경과",
                requested_at: "2026-11-01T12:10:00Z",
                completed_at: null,
                orderNumber: "hm_ord_exp_1",
                orderStatus: "approved",
                paymentMode: "test",
                receiptStatus: "approved",
                manualCheckRequired: true,
                canRetry: false,
              },
              {
                id: "rf-done",
                payment_order_id: ORDER_ID_SUCCEEDED,
                receipt_submission_id: "22222222-2222-4222-a222-222222222205",
                amount_krw: 1000,
                status: "succeeded",
                failure_reason: null,
                requested_at: "2026-11-20T10:00:00Z",
                completed_at: "2026-11-20T10:00:02Z",
                orderNumber: "hm_ord_done_1",
                orderStatus: "approved",
                paymentMode: "test",
                receiptStatus: "approved",
                manualCheckRequired: false,
                canRetry: false,
              },
            ],
          }),
        } as Response;
      }) as any;

      render(<AdminRefundsClient initialTab="all" />);

      await waitFor(() => {
        expect(screen.getByTestId(`refund-failure-reason-${ORDER_ID_FAILED}`).textContent).toContain(
          "UNCERTAIN_TIMEOUT"
        );
      });

      expect(screen.getByTestId(`refund-manual-check-${ORDER_ID_EXPIRED}`).textContent).toContain(
        "15일 멱등키 유효기간 경과"
      );
      expect(screen.queryByTestId(`retry-refund-btn-${ORDER_ID_EXPIRED}`)).toBeNull();
      expect(screen.queryByTestId(`reconcile-refund-btn-${ORDER_ID_SUCCEEDED}`)).toBeNull();

      // Reconcile uncertain order -> becomes succeeded
      fireEvent.click(screen.getByTestId(`reconcile-refund-btn-${ORDER_ID_FAILED}`));

      await waitFor(() => {
        expect(screen.getByTestId("admin-refunds-action-notice").textContent).toContain(
          "상태 재조회 복구 완료"
        );
      });
      expect(screen.getByTestId(`refund-status-badge-${ORDER_ID_FAILED}`).textContent).toContain(
        "테스트 환급 완료"
      );
    });

    it("실패 시에도 동일 세션 내 재시도는 동일한 idempotencyKey를 재사용한다", async () => {
      let attempt = 0;
      const sentKeys: string[] = [];

      global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/api/v1/admin/receipts")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              items:
                attempt === 0
                  ? [
                      {
                        id: RECEIPT_ID_1,
                        submissionStatus: "approved",
                        reviewedAt: "2026-11-20T12:00:00Z",
                        businessName: "진미통닭",
                        restroomName: "진미 통닭",
                        paymentOrderId: ORDER_ID_1,
                        paymentOrderNumber: "hm_ord_1001",
                        paymentAmountKrw: 1000,
                        paymentStatus: "approved",
                        paymentMode: "test",
                        refundStatus: "none",
                      },
                    ]
                  : [],
            }),
          } as Response;
        }
        if (url.includes("/request")) {
          attempt += 1;
          const body = JSON.parse(String(init?.body || "{}"));
          sentKeys.push(body.idempotencyKey);
          if (attempt === 1) {
            return {
              ok: false,
              status: 502,
              json: async () => ({
                ok: false,
                requestId: "req-fail-1",
                error: { code: "PG_ERROR", message: "일시적 PG 통신 실패" },
              }),
            } as Response;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              outcome: "reconciled_succeeded",
              reused: true,
              requestId: "req-retry-2",
              refund: { id: "rf-1", amount_krw: 1000, status: "succeeded" },
            }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            items:
              attempt === 1
                ? [
                    {
                      id: "rf-1",
                      payment_order_id: ORDER_ID_1,
                      receipt_submission_id: RECEIPT_ID_1,
                      amount_krw: 1000,
                      status: "failed",
                      failure_reason: "PG_ERROR: 일시적 PG 통신 실패",
                      requested_at: "2026-11-20T12:10:00Z",
                      completed_at: null,
                      orderNumber: "hm_ord_1001",
                      orderStatus: "approved",
                      paymentMode: "test",
                      receiptStatus: "approved",
                      manualCheckRequired: false,
                      canRetry: true,
                    },
                  ]
                : [],
          }),
        } as Response;
      }) as any;

      render(<AdminRefundsClient />);

      await waitFor(() => {
        expect(screen.getByTestId(`request-refund-btn-${ORDER_ID_1}`)).toBeTruthy();
      });
      fireEvent.click(screen.getByTestId(`request-refund-btn-${ORDER_ID_1}`));
      fireEvent.click(screen.getByTestId(`confirm-refund-submit-${ORDER_ID_1}`));

      await waitFor(() => {
        expect(screen.getByTestId("admin-refunds-action-notice").textContent).toContain(
          "환급 요청 실패 (PG_ERROR)"
        );
      });

      fireEvent.click(screen.getByTestId("refund-tab-failed"));
      await waitFor(() => {
        expect(screen.getByTestId(`retry-refund-btn-${ORDER_ID_1}`)).toBeTruthy();
      });
      fireEvent.click(screen.getByTestId(`retry-refund-btn-${ORDER_ID_1}`));

      await waitFor(() => {
        expect(screen.getByTestId("admin-refunds-action-notice").textContent).toContain(
          "테스트 환급 완료"
        );
      });
      expect(sentKeys).toHaveLength(2);
      expect(sentKeys[0]).toBe(sentKeys[1]);
    });
  });
});
