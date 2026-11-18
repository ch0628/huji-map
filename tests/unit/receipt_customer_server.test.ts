import { describe, it, expect, vi } from "vitest";
import {
  listCustomerReceiptsAndEligibleSessions,
  CustomerReceiptError,
} from "@/components/receipt/receipt-server";

describe("receipt-server: listCustomerReceiptsAndEligibleSessions", () => {
  it("userId가 제공되지 않으면 UNAUTHENTICATED 401 에러를 던진다", async () => {
    await expect(
      listCustomerReceiptsAndEligibleSessions({ userId: "" })
    ).rejects.toThrow(CustomerReceiptError);

    try {
      await listCustomerReceiptsAndEligibleSessions({ userId: "" });
    } catch (err: any) {
      expect(err.statusCode).toBe(401);
      expect(err.code).toBe("UNAUTHENTICATED");
    }
  });

  it("로그인된 사용자의 본인 영수증 및 승인된 세션만 조회하고 정합성을 매핑한다", async () => {
    const mockUserId = "user-customer-111";

    // Mock query client
    const mockReceiptRows = [
      {
        id: "sub-1",
        access_session_id: "sess-1",
        user_id: mockUserId,
        storage_path: `receipts/${mockUserId}/sess-1/1.jpg`,
        mime_type: "image/jpeg",
        file_size_bytes: 5000,
        original_filename: "receipt.jpg",
        submission_status: "approved",
        store_name_confirmed: "스타벅스 수원역점",
        purchase_at_confirmed: "2026-11-15T11:00:00Z",
        purchase_amount_krw: 4500,
        reviewed_at: "2026-11-15T11:30:00Z",
        review_reason: null,
        created_at: "2026-11-15T10:00:00Z",
        updated_at: "2026-11-15T11:30:00Z",
      },
    ];

    const mockSessionRows = [
      {
        id: "sess-1",
        restroom_id: "rest-1",
        policy_id: "pol-1",
        status: "authorized",
        authorized_at: "2026-11-15T09:30:00Z",
        expires_at: "2026-11-15T10:30:00Z",
        created_at: "2026-11-15T09:00:00Z",
      },
    ];

    const mockRestroomRows = [
      {
        id: "rest-1",
        name: "테스트 화장실",
        road_address: "경기 수원시 팔달구 매산로 1",
        business_id: "biz-1",
      },
    ];

    const mockBusinessRows = [
      {
        id: "biz-1",
        name: "스타벅스 수원역점",
      },
    ];

    const mockOrderRows = [
      {
        id: "ord-1",
        access_session_id: "sess-1",
        amount_krw: 1000,
        payment_mode: "test",
        status: "approved",
      },
    ];

    const mockRefundRows = [
      {
        id: "ref-1",
        receipt_submission_id: "sub-1",
        amount_krw: 1000,
        status: "succeeded",
        completed_at: "2026-11-15T12:00:00Z",
      },
    ];

    const mockPolicyRows = [
      {
        id: "pol-1",
        deposit_amount_krw: 1000,
        receipt_window_hours: 24,
        access_mode: "test_deposit",
      },
    ];

    const mockClient: any = {
      from: vi.fn((table: string) => {
        return {
          select: vi.fn(() => ({
            eq: vi.fn((col: string, val: any) => ({
              order: vi.fn(() => ({
                data: table === "receipt_submissions" ? mockReceiptRows : [],
                error: null,
                limit: vi.fn(() => ({
                  data: table === "access_sessions" ? mockSessionRows : [],
                  error: null,
                })),
              })),
              limit: vi.fn(() => ({
                data: table === "access_sessions" ? mockSessionRows : [],
                error: null,
              })),
              eq: vi.fn(() => ({
                data: table === "payment_orders" ? mockOrderRows : [],
                error: null,
              })),
            })),
            in: vi.fn((col: string, vals: any[]) => {
              if (table === "access_sessions") {
                return { data: mockSessionRows, error: null };
              }
              if (table === "restrooms") {
                return { data: mockRestroomRows, error: null };
              }
              if (table === "businesses") {
                return { data: mockBusinessRows, error: null };
              }
              if (table === "payment_orders") {
                const orderQuery: any = {
                  data: mockOrderRows,
                  error: null,
                };
                orderQuery.eq = vi.fn(() => orderQuery);
                return orderQuery;
              }
              if (table === "payment_refunds") {
                return { data: mockRefundRows, error: null };
              }
              if (table === "restroom_access_policies") {
                return { data: mockPolicyRows, error: null };
              }
              return { data: [], error: null };
            }),
          })),
        };
      }),
    };

    const result = await listCustomerReceiptsAndEligibleSessions({
      userId: mockUserId,
      injectedClient: mockClient,
    });

    expect(result.receipts).toHaveLength(1);
    const receipt = result.receipts[0];
    expect(receipt.id).toBe("sub-1");
    expect(receipt.submissionStatus).toBe("approved");
    expect(receipt.refundStatus).toBe("completed");
    expect(receipt.partnerName).toBe("스타벅스 수원역점");
    expect(receipt.restroomName).toBe("테스트 화장실");
    expect(receipt.depositAmountKrw).toBe(1000);
  });

  it("화장실 정책이 v2(48시간)로 변경되더라도 기존 이용권(v1, 12시간)은 발급 당시 정책 기한을 보존한다", async () => {
    const mockUserId = "user-customer-222";
    const authorizedAtIso = "2026-11-15T12:00:00.000Z";

    // 2개의 세션: 1개는 과거 정책 v1(12시간), 1개는 최신 정책 v2(48시간)
    const mockSessionRows = [
      {
        id: "sess-v1",
        restroom_id: "rest-1",
        policy_id: "pol-v1",
        status: "authorized",
        authorized_at: authorizedAtIso,
        expires_at: "2026-11-15T13:00:00.000Z",
        created_at: authorizedAtIso,
      },
      {
        id: "sess-v2",
        restroom_id: "rest-1",
        policy_id: "pol-v2",
        status: "authorized",
        authorized_at: authorizedAtIso,
        expires_at: "2026-11-15T13:00:00.000Z",
        created_at: authorizedAtIso,
      },
    ];

    const mockRestroomRows = [
      {
        id: "rest-1",
        name: "버전 관리 화장실",
        road_address: "경기 수원시 팔달구 매산로 10",
        business_id: "biz-1",
      },
    ];

    const mockBusinessRows = [
      {
        id: "biz-1",
        name: "버전 관리 카페",
      },
    ];

    const mockOrderRows = [
      {
        id: "ord-1",
        access_session_id: "sess-v1",
        amount_krw: 1000,
        payment_mode: "test",
        status: "approved",
      },
      {
        id: "ord-2",
        access_session_id: "sess-v2",
        amount_krw: 1000,
        payment_mode: "test",
        status: "approved",
      },
    ];

    // DB에 보존된 2개의 정책 버전 (v1: 12시간, v2: 48시간)
    const mockPolicyRows = [
      {
        id: "pol-v1",
        deposit_amount_krw: 1000,
        receipt_window_hours: 12,
        access_mode: "test_deposit",
      },
      {
        id: "pol-v2",
        deposit_amount_krw: 1000,
        receipt_window_hours: 48,
        access_mode: "test_deposit",
      },
    ];

    const mockClient: any = {
      from: vi.fn((table: string) => {
        return {
          select: vi.fn(() => ({
            eq: vi.fn((col: string, val: any) => ({
              order: vi.fn(() => ({
                data: [],
                error: null,
                limit: vi.fn(() => ({
                  data: mockSessionRows,
                  error: null,
                })),
              })),
              limit: vi.fn(() => ({
                data: mockSessionRows,
                error: null,
              })),
              eq: vi.fn(() => ({
                data: mockOrderRows,
                error: null,
              })),
            })),
            in: vi.fn((col: string, vals: any[]) => {
              if (table === "access_sessions") {
                return { data: mockSessionRows, error: null };
              }
              if (table === "restrooms") {
                return { data: mockRestroomRows, error: null };
              }
              if (table === "businesses") {
                return { data: mockBusinessRows, error: null };
              }
              if (table === "payment_orders") {
                const orderQuery: any = {
                  data: mockOrderRows,
                  error: null,
                };
                orderQuery.eq = vi.fn(() => orderQuery);
                return orderQuery;
              }
              if (table === "payment_refunds") {
                return { data: [], error: null };
              }
              if (table === "restroom_access_policies") {
                return { data: mockPolicyRows, error: null };
              }
              return { data: [], error: null };
            }),
          })),
        };
      }),
    };

    const result = await listCustomerReceiptsAndEligibleSessions({
      userId: mockUserId,
      injectedClient: mockClient,
    });

    expect(result.eligibleSessions).toHaveLength(2);

    const sessionV1 = result.eligibleSessions.find(
      (s) => s.accessSessionId === "sess-v1"
    );
    const sessionV2 = result.eligibleSessions.find(
      (s) => s.accessSessionId === "sess-v2"
    );

    expect(sessionV1).toBeDefined();
    expect(sessionV2).toBeDefined();

    // v1 이용권은 정책이 바뀌어도 발급 시점의 12시간을 엄격하게 유지
    expect(sessionV1?.receiptWindowHours).toBe(12);
    const expectedV1Deadline = new Date(
      new Date(authorizedAtIso).getTime() + 12 * 3600 * 1000
    ).toISOString();
    expect(sessionV1?.receiptWindowDeadline).toBe(expectedV1Deadline);

    // v2 이용권은 신규 정책인 48시간 적용
    expect(sessionV2?.receiptWindowHours).toBe(48);
    const expectedV2Deadline = new Date(
      new Date(authorizedAtIso).getTime() + 48 * 3600 * 1000
    ).toISOString();
    expect(sessionV2?.receiptWindowDeadline).toBe(expectedV2Deadline);
  });
});

