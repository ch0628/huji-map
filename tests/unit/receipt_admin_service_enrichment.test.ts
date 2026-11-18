import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listAdminReceipts,
  getAdminReceiptById,
} from "@/lib/receipts/service";

interface MockDb {
  receipt_submissions: any[];
  access_sessions: any[];
  restrooms: any[];
  businesses: any[];
  restroom_access_policies: any[];
  payment_orders: any[];
  payment_refunds: any[];
  profiles: any[];
}

let mockDb: MockDb;
let selectedColumnsLog: Array<{ table: string; columns: string }> = [];

function createMockQueryBuilder(table: keyof MockDb) {
  let filters: Array<(row: any) => boolean> = [];
  let orderBy: { col: string; ascending: boolean } | null = null;
  let rangeSlice: [number, number] | null = null;

  const execute = () => {
    let rows = [...(mockDb[table] ?? [])];
    for (const fn of filters) {
      rows = rows.filter(fn);
    }
    if (orderBy) {
      const { col, ascending } = orderBy;
      rows.sort((a, b) => {
        const av = a[col] ?? "";
        const bv = b[col] ?? "";
        return ascending
          ? String(av).localeCompare(String(bv))
          : String(bv).localeCompare(String(av));
      });
    }
    const count = rows.length;
    if (rangeSlice) {
      rows = rows.slice(rangeSlice[0], rangeSlice[1] + 1);
    }
    return { data: rows, error: null, count };
  };

  const builder: any = {
    select(columns: string) {
      selectedColumnsLog.push({ table, columns });
      return builder;
    },
    eq(col: string, val: unknown) {
      filters.push((r) => r[col] === val);
      return builder;
    },
    in(col: string, vals: unknown[]) {
      filters.push((r) => vals.includes(r[col]));
      return builder;
    },
    order(col: string, opts?: { ascending?: boolean }) {
      orderBy = { col, ascending: opts?.ascending ?? true };
      return builder;
    },
    range(from: number, to: number) {
      rangeSlice = [from, to];
      return builder;
    },
    maybeSingle() {
      const res = execute();
      return Promise.resolve({
        data: res.data[0] ?? null,
        error: null,
      });
    },
    then(resolve: (val: any) => void, reject?: (err: any) => void) {
      return Promise.resolve(execute()).then(resolve, reject);
    },
  };

  return builder;
}

vi.mock("@/lib/supabase/server", () => ({
  isServiceRoleConfigured: vi.fn(() => true),
  createAdminClient: vi.fn(() => ({
    from: vi.fn((table: keyof MockDb) => createMockQueryBuilder(table)),
  })),
}));

describe("TASK 29 보완: listAdminReceipts & getAdminReceiptById 비교 데이터 보강", () => {
  const sub1Id = "11111111-1111-4111-8111-111111111111";
  const sub2Id = "22222222-2222-4222-8222-222222222222";
  const sess1Id = "aaaa1111-1111-4111-8111-111111111111";
  const sess2Id = "aaaa2222-2222-4222-8222-222222222222";
  const user1Id = "bbbb1111-1111-4111-8111-111111111111";
  const restroom1Id = "cccc1111-1111-4111-8111-111111111111";
  const business1Id = "dddd1111-1111-4111-8111-111111111111";
  const policyV1Id = "eeee1111-1111-4111-8111-111111111111";
  const policyV2Id = "eeee2222-2222-4222-8222-222222222222";

  beforeEach(() => {
    selectedColumnsLog = [];
    mockDb = {
      receipt_submissions: [
        {
          id: sub1Id,
          access_session_id: sess1Id,
          user_id: user1Id,
          storage_path: `receipts/${user1Id}/${sess1Id}/1.jpg`,
          mime_type: "image/jpeg",
          file_size_bytes: 120000,
          original_filename: "r1.jpg",
          submission_status: "submitted",
          store_name_confirmed: null,
          purchase_at_confirmed: null,
          purchase_amount_krw: null,
          receipt_reference: null,
          reviewed_by: null,
          reviewed_at: null,
          review_reason: null,
          created_at: "2026-11-16T04:00:00.000Z",
          updated_at: "2026-11-16T04:00:00.000Z",
        },
        {
          id: sub2Id,
          access_session_id: sess2Id,
          user_id: user1Id,
          storage_path: `receipts/${user1Id}/${sess2Id}/2.jpg`,
          mime_type: "image/png",
          file_size_bytes: 95000,
          original_filename: "r2.png",
          submission_status: "approved",
          store_name_confirmed: "DEMO 테스트 카페",
          purchase_at_confirmed: "2026-11-16T02:30:00.000Z",
          purchase_amount_krw: 4500,
          receipt_reference: "REC-9988",
          reviewed_by: "admin-1",
          reviewed_at: "2026-11-16T03:00:00.000Z",
          review_reason: "정상 영수증 확인",
          created_at: "2026-11-16T02:45:00.000Z",
          updated_at: "2026-11-16T03:00:00.000Z",
        },
      ],
      access_sessions: [
        {
          id: sess1Id,
          restroom_id: restroom1Id,
          policy_id: policyV1Id, // Bound to v1 (not current active v2)
          status: "authorized",
          authorized_at: "2026-11-16T01:00:00.000Z",
          expires_at: "2026-11-16T02:00:00.000Z",
        },
        {
          id: sess2Id,
          restroom_id: restroom1Id,
          policy_id: policyV2Id,
          status: "completed",
          authorized_at: "2026-11-16T02:00:00.000Z",
          expires_at: "2026-11-16T03:00:00.000Z",
        },
      ],
      restrooms: [
        {
          id: restroom1Id,
          name: "DEMO 제휴 화장실 1호",
          business_id: business1Id,
        },
      ],
      businesses: [
        {
          id: business1Id,
          name: "DEMO 테스트 카페",
          road_address: "경기도 수원시 팔달구 효원로 1",
          phone: "031-000-0000", // Should never be selected or returned
        },
      ],
      restroom_access_policies: [
        {
          id: policyV1Id,
          version: 1,
          deposit_amount_krw: 1000,
          receipt_window_hours: 12,
          min_purchase_krw: 3000,
          is_active: false,
        },
        {
          id: policyV2Id,
          version: 2,
          deposit_amount_krw: 2000,
          receipt_window_hours: 24,
          min_purchase_krw: 5000,
          is_active: true,
        },
      ],
      payment_orders: [
        // Earlier failed attempt on sess1
        {
          id: "ord-fail-1",
          access_session_id: sess1Id,
          user_id: user1Id,
          order_id: "HM_FAIL_1",
          amount_krw: 1000,
          status: "failed",
          payment_mode: "test",
          approved_at: null,
          created_at: "2026-11-16T00:55:00.000Z",
          provider_payment_key: "secret_pay_key_fail",
        },
        // Approved deposit payment on sess1 (snapshot 1000 KRW)
        {
          id: "ord-app-1",
          access_session_id: sess1Id,
          user_id: user1Id,
          order_id: "HM_ORD_1001",
          amount_krw: 1000,
          status: "approved",
          payment_mode: "test",
          approved_at: "2026-11-16T01:00:00.000Z",
          created_at: "2026-11-16T00:59:00.000Z",
          provider_payment_key: "secret_pay_key_1",
        },
        // NOTE: sess2 intentionally has NO payment_orders row to test missing order handling
      ],
      payment_refunds: [
        // Refund linked strictly to sub2Id
        {
          id: "ref-2",
          receipt_submission_id: sub2Id,
          amount_krw: 2000,
          status: "succeeded",
          requested_at: "2026-11-16T03:05:00.000Z",
          completed_at: "2026-11-16T03:06:00.000Z",
          provider_cancel_id: "secret_cancel_id_2",
        },
      ],
      profiles: [
        {
          id: user1Id,
          display_name: "테스터김",
        },
      ],
    };
  });

  it("목록(listAdminReceipts)과 상세(getAdminReceiptById)가 동일한 비교 필드를 반환하고 버전 정책(v1)·결제·환급을 정확히 연결한다", async () => {
    const listRes = await listAdminReceipts({ status: "pending" });
    const detailRes = await getAdminReceiptById(sub1Id);

    expect(listRes.items).toHaveLength(1);
    const listItem = listRes.items[0];
    expect(detailRes).toEqual(listItem);

    // A. 가게 정보
    expect(detailRes.businessId).toBe(business1Id);
    expect(detailRes.businessName).toBe("DEMO 테스트 카페");
    expect(detailRes.businessRoadAddress).toBe("경기도 수원시 팔달구 효원로 1");

    // B. 이용 정보
    expect(detailRes.accessAuthorizedAt).toBe("2026-11-16T01:00:00.000Z");
    expect(detailRes.accessExpiresAt).toBe("2026-11-16T02:00:00.000Z");
    expect(detailRes.accessStatus).toBe("authorized");

    // C. 세션 policy_id 기준 불변 정책 (v2가 active여도 sess1은 v1 사용)
    expect(detailRes.policyVersion).toBe(1);
    expect(detailRes.depositAmountKrw).toBe(1000);
    expect(detailRes.receiptWindowHours).toBe(12);
    expect(detailRes.receiptWindowDeadline).toBe("2026-11-16T13:00:00.000Z"); // 01:00 + 12h
    expect(detailRes.minPurchaseKrw).toBe(3000);

    // D. 보증금 결제 정보 (실패 주문이 아닌 approved 주문 선택)
    expect(detailRes.paymentOrderId).toBe("ord-app-1");
    expect(detailRes.paymentOrderNumber).toBe("HM_ORD_1001");
    expect(detailRes.paymentAmountKrw).toBe(1000);
    expect(detailRes.paymentStatus).toBe("approved");
    expect(detailRes.paymentMode).toBe("test");
    expect(detailRes.paymentApprovedAt).toBe("2026-11-16T01:00:00.000Z");

    // E. 미심사 영수증 구매 정보는 NULL 유지 (OCR/임의값 없음)
    expect(detailRes.storeNameConfirmed).toBeNull();
    expect(detailRes.purchaseAtConfirmed).toBeNull();
    expect(detailRes.purchaseAmountKrw).toBeNull();
    expect(detailRes.receiptReference).toBeNull();

    // F. 환급 레코드 부재 시 임의 생성 없이 'none' 반환
    expect(detailRes.refundStatus).toBe("none");
    expect(detailRes.refundAmountKrw).toBeNull();
    expect(detailRes.refundRequestedAt).toBeNull();
    expect(detailRes.refundCompletedAt).toBeNull();
  });

  it("주문 미존재 세션(userId가 같아도 다른 세션 주문 매칭 금지)과 환급 완료 건(sub2)을 정확히 처리한다", async () => {
    const detail2 = await getAdminReceiptById(sub2Id);

    // Same user_id as sess1, MUST NOT borrow sess1's payment_order
    expect(detail2.paymentOrderId).toBeNull();
    expect(detail2.paymentOrderNumber).toBeNull();
    expect(detail2.paymentAmountKrw).toBeNull();
    expect(detail2.paymentStatus).toBeNull();
    expect(detail2.paymentMode).toBeNull();
    expect(detail2.paymentApprovedAt).toBeNull();

    // Policy v2 (24h, min 5000, deposit 2000)
    expect(detail2.policyVersion).toBe(2);
    expect(detail2.receiptWindowHours).toBe(24);
    expect(detail2.receiptWindowDeadline).toBe("2026-11-17T02:00:00.000Z");
    expect(detail2.minPurchaseKrw).toBe(5000);

    // Receipt confirmed fields vs refund record
    expect(detail2.purchaseAmountKrw).toBe(4500);
    expect(detail2.receiptReference).toBe("REC-9988");
    expect(detail2.refundStatus).toBe("succeeded");
    expect(detail2.refundAmountKrw).toBe(2000);
    expect(detail2.refundRequestedAt).toBe("2026-11-16T03:05:00.000Z");
    expect(detail2.refundCompletedAt).toBe("2026-11-16T03:06:00.000Z");
  });

  it("비밀 컬럼 및 불필요 개인정보(provider_payment_key, provider_cancel_id, idempotency_key, 사업자번호, 전화번호, 이메일)를 조회·반환하지 않는다", async () => {
    const detail = await getAdminReceiptById(sub1Id);
    const jsonText = JSON.stringify(detail);

    expect(jsonText).not.toContain("secret_pay_key");
    expect(jsonText).not.toContain("secret_cancel_id");
    expect(jsonText).not.toContain("031-000-0000");

    expect((detail as any).providerPaymentKey).toBeUndefined();
    expect((detail as any).provider_payment_key).toBeUndefined();
    expect((detail as any).providerCancelId).toBeUndefined();
    expect((detail as any).provider_cancel_id).toBeUndefined();
    expect((detail as any).idempotencyKey).toBeUndefined();
    expect((detail as any).businessRegistrationNumber).toBeUndefined();

    const forbiddenCols = [
      "provider_payment_key",
      "provider_cancel_id",
      "idempotency_key",
      "registration_number",
      "phone",
      "email",
    ];
    for (const entry of selectedColumnsLog) {
      for (const col of forbiddenCols) {
        expect(entry.columns).not.toContain(col);
      }
    }
  });
});

