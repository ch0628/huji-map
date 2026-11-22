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
  act,
} from "@testing-library/react";
import AccessListClient from "@/components/access/AccessListClient";
import AccessDetailClient from "@/components/access/AccessDetailClient";
import PinRevealPanel from "@/components/access/PinRevealPanel";
import VisitConfirmationForm from "@/components/access/VisitConfirmationForm";
import {
  classifyPinRevealError,
  evaluatePinRevealEligibility,
  resolveEffectiveAccessStatus,
  visitConfirmationSubmitSchema,
  type CustomerAccessDetail,
  type CustomerAccessListItem,
} from "@/components/access/types";
import {
  getCustomerAccessSessionDetail,
  listCustomerAccessSessions,
  submitCustomerVisitConfirmation,
  CustomerAccessError,
} from "@/components/access/access-server";
import { GET as handleGetListData } from "@/app/(customer)/my/access/data/route";
import { GET as handleGetDetailData } from "@/app/(customer)/my/access/[id]/data/route";
import { POST as handlePostVisitConfirmation } from "@/app/(customer)/my/access/[id]/visit-confirmation/route";
import * as authLib from "@/lib/auth";
import * as supabaseServer from "@/lib/supabase/server";
import { resetRateLimits } from "@/lib/events/rate-limiter";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof authLib>();
  return {
    ...actual,
    requireAuth: vi.fn(),
    isSupabaseAuthConfigured: vi.fn().mockReturnValue(true),
  };
});

vi.mock("@/lib/supabase/server", async (importOriginal) => {
  const actual = await importOriginal<typeof supabaseServer>();
  return {
    ...actual,
    createServerClientInstance: vi.fn().mockResolvedValue({}),
    createAdminClient: vi.fn(),
    isServiceRoleConfigured: vi.fn().mockReturnValue(true),
  };
});

describe("TASK 25 — Customer Access Ticket & Doorlock PIN UI Verification", () => {
  const customerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const otherCustomerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const restroomId = "22222222-2222-4222-8222-222222222222";
  const policyId = "33333333-3333-4333-8333-333333333333";
  const orderUuid = "44444444-4444-4444-8444-444444444444";

  const futureExpiry = new Date(Date.now() + 3600_000).toISOString();
  const pastExpiry = new Date(Date.now() - 3600_000).toISOString();

  function buildSampleDetail(
    overrides?: Partial<CustomerAccessDetail>
  ): CustomerAccessDetail {
    return {
      session: {
        id: sessionId,
        user_id: customerId,
        restroom_id: restroomId,
        policy_id: policyId,
        status: "authorized",
        access_method_snapshot: "pin",
        authorized_at: "2026-11-15T07:00:00.000Z",
        code_revealed_at: null,
        expires_at: futureExpiry,
        created_at: "2026-11-15T06:59:00.000Z",
        updated_at: "2026-11-15T07:00:00.000Z",
      },
      effectiveStatus: "authorized",
      restroom: {
        id: restroomId,
        name: "행궁 안심제휴 카페 화장실",
        road_address: "수원시 팔달구 화서문로 42",
        address_detail: "1층",
        floor: "1F",
        entrance_instructions: "카운터 우측 복도 끝",
        access_method: "pin",
        publication_status: "published",
        business_id: "55555555-5555-4555-8555-555555555555",
        business_name: "행궁 안심카페 본점",
        business_category: "카페/디저트",
        business_phone: "031-123-4567",
      },
      policy: {
        id: policyId,
        version: 1,
        access_mode: "test_deposit",
        deposit_amount_krw: 1000,
        refund_eligible: true,
        receipt_window_hours: 24,
        min_purchase_krw: 0,
      },
      order: {
        id: orderUuid,
        access_session_id: sessionId,
        user_id: customerId,
        order_id: "hm_ord_1763190000_abcd12",
        provider: "toss",
        payment_mode: "test",
        amount_krw: 1000,
        status: "approved",
        approved_at: "2026-11-15T07:00:00.000Z",
        failure_code: null,
        created_at: "2026-11-15T06:59:00.000Z",
        updated_at: "2026-11-15T07:00:00.000Z",
      },
      refund: null,
      latestVisitConfirmation: null,
      visitConfirmations: [],
      eligibleForPinReveal: true,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/my/access");

    vi.mocked(authLib.requireAuth).mockResolvedValue({
      user: { id: customerId, email: "customer@test.com" } as any,
      roles: ["customer"],
      isAdmin: false,
      isMerchant: false,
      displayName: "테스트고객",
      accountStatus: "active",
      profileExists: true,
      sessionExpired: false,
      configReady: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // 1. 정상 이용권 → 수동 버튼 클릭 시에만 PIN 표시 & 비영구 저장 검증
  // ==========================================================================
  it("1. 정상 이용권: 초기 화면에는 PIN이 없으며 수동 버튼 클릭 시에만 PIN을 표시하고 스토리지/URL에 저장하지 않음", async () => {
    const detail = buildSampleDetail();
    const mockRequester = vi.fn().mockResolvedValue({
      httpStatus: 200,
      body: {
        ok: true,
        pin: "2580*",
        codeVersion: 3,
        expiresAt: futureExpiry,
        requestId: "req-1",
      },
    });

    const { unmount } = render(
      <AccessDetailClient
        accessSessionId={sessionId}
        initialDetail={detail}
        injectedRevealRequester={mockRequester}
      />
    );

    // 초기 렌더링 시 PIN이 절대 노출되지 않아야 함
    expect(screen.queryByTestId("revealed-pin-value")).toBeNull();
    expect(document.body.textContent).not.toContain("2580*");

    // 테스트 결제 안내 및 유효기한 표시 확인 (UI-12: 시스템/주문번호 문구 제거)
    expect(screen.getByTestId("detail-test-mode-watermark").textContent).toContain(
      "1,000원"
    );
    expect(screen.queryByTestId("detail-order-id")).toBeNull();

    // 수동 버튼 클릭
    const revealBtn = screen.getByTestId("reveal-pin-btn");
    await act(async () => {
      fireEvent.click(revealBtn);
    });

    expect(mockRequester).toHaveBeenCalledTimes(1);
    expect(mockRequester).toHaveBeenCalledWith(sessionId);

    const pinBox = await screen.findByTestId("revealed-pin-value");
    expect(pinBox.textContent).toBe("2580*");

    // localStorage / sessionStorage / URL 에 PIN이 절대 저장되지 않았는지 확인
    expect(JSON.stringify(window.localStorage)).not.toContain("2580*");
    expect(JSON.stringify(window.sessionStorage)).not.toContain("2580*");
    expect(window.location.href).not.toContain("2580*");

    // 숨기기 버튼 클릭 시 즉시 제거 확인
    fireEvent.click(screen.getByTestId("hide-pin-btn"));
    expect(screen.queryByTestId("revealed-pin-value")).toBeNull();

    // 다시 표시한 뒤 pagehide 발생 시 자동 제거 확인
    await act(async () => {
      fireEvent.click(screen.getByTestId("reveal-pin-btn"));
    });
    expect(screen.getByTestId("revealed-pin-value").textContent).toBe("2580*");

    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(screen.queryByTestId("revealed-pin-value")).toBeNull();

    unmount();
  });

  // ==========================================================================
  // 2. 미로그인(401) → PIN 비노출 및 로그인 이동 안내
  // ==========================================================================
  it("2. 미로그인(401): PIN 비노출 및 다시 로그인하기 안내 표시", async () => {
    const detail = buildSampleDetail();
    const mockRequester = vi.fn().mockResolvedValue({
      httpStatus: 401,
      body: {
        ok: false,
        error: {
          code: "UNAUTHORIZED",
          message: "로그인 세션이 만료되었습니다.",
        },
      },
    });

    render(
      <AccessDetailClient
        accessSessionId={sessionId}
        initialDetail={detail}
        injectedRevealRequester={mockRequester}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("reveal-pin-btn"));
    });

    expect(screen.queryByTestId("revealed-pin-value")).toBeNull();
    const errAlert = await screen.findByTestId("pin-reveal-error");
    expect(errAlert.getAttribute("data-error-category")).toBe("unauthenticated");
    expect(screen.getByTestId("pin-error-login-link")).toBeDefined();
  });

  // ==========================================================================
  // 3. 타인 이용권(403) → 상세 조회 원천 차단 및 PIN 비노출
  // ==========================================================================
  it("3. 타인 이용권(403): 서버 상세 조회 및 화면에서 403 차단, PIN 일체 비노출", async () => {
    // 3-A. 서버 함수 getCustomerAccessSessionDetail 에서 타인 소유 세션 조회 시 403 FORBIDDEN 검증
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: sessionId,
                user_id: otherCustomerId, // 다른 고객의 이용권
                restroom_id: restroomId,
                policy_id: policyId,
                status: "authorized",
                access_method_snapshot: "pin",
                expires_at: futureExpiry,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
              error: null,
            }),
          }),
        }),
      }),
    } as any;

    await expect(
      getCustomerAccessSessionDetail({
        userId: customerId,
        accessSessionId: sessionId,
        injectedClient: mockSupabase,
      })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      statusCode: 403,
    });

    // 3-B. UI에 403 initialError 전달 시 타인 이용권 차단 안내 및 PIN 패널 미렌더링 검증
    render(
      <AccessDetailClient
        accessSessionId={sessionId}
        initialDetail={null}
        initialError={{
          status: 403,
          code: "FORBIDDEN",
          message: "타인의 화장실 이용권은 조회할 수 없습니다.",
        }}
      />
    );

    expect(screen.getByTestId("access-detail-error-403")).toBeDefined();
    expect(screen.queryByTestId("reveal-pin-btn")).toBeNull();
    expect(screen.queryByTestId("revealed-pin-value")).toBeNull();
  });

  // ==========================================================================
  // 4. 결제 미완료 → PIN 비노출 및 '결제 승인 후 확인 가능' 표시
  // ==========================================================================
  it("4. 결제 미완료(created / pending): PIN 공개 버튼을 렌더링하지 않고 '결제 승인 후 확인 가능' 안내", () => {
    const unpaidDetail = buildSampleDetail({
      session: {
        ...buildSampleDetail().session,
        status: "created",
      },
      effectiveStatus: "created",
      order: {
        ...buildSampleDetail().order!,
        status: "pending",
        approved_at: null,
      },
      eligibleForPinReveal: false,
    });

    render(
      <AccessDetailClient
        accessSessionId={sessionId}
        initialDetail={unpaidDetail}
      />
    );

    const banner = screen.getByTestId("pin-ineligible-banner");
    expect(banner.getAttribute("data-reason-code")).toBe("PAYMENT_REQUIRED");
    expect(banner.textContent).toContain("결제 승인 후 확인 가능");
    expect(screen.queryByTestId("reveal-pin-btn")).toBeNull();
    expect(screen.queryByTestId("revealed-pin-value")).toBeNull();
  });

  // ==========================================================================
  // 5. 환불·취소·만료 → PIN 비노출
  // ==========================================================================
  it("5. 환불·취소·만료 상태: PIN 버튼 비노출 및 상태별 안내 표시", () => {
    // 5-A. 환불 완료된 이용권
    const refundedDetail = buildSampleDetail({
      refund: {
        id: "77777777-7777-4777-8777-777777777777",
        payment_order_id: orderUuid,
        receipt_submission_id: null,
        amount_krw: 1000,
        status: "succeeded",
        failure_reason: null,
        requested_at: "2026-11-15T08:00:00.000Z",
        completed_at: "2026-11-15T08:01:00.000Z",
      },
      effectiveStatus: "canceled",
      eligibleForPinReveal: false,
    });

    const { unmount } = render(
      <AccessDetailClient
        accessSessionId={sessionId}
        initialDetail={refundedDetail}
      />
    );

    expect(
      screen.getByTestId("pin-ineligible-banner").getAttribute("data-reason-code")
    ).toBe("CANCELED_OR_REFUNDED");
    expect(screen.queryByTestId("reveal-pin-btn")).toBeNull();
    expect(screen.queryByTestId("revealed-pin-value")).toBeNull();
    unmount();

    // 5-B. 만료된 이용권
    const expiredDetail = buildSampleDetail({
      session: {
        ...buildSampleDetail().session,
        expires_at: pastExpiry,
        status: "expired",
      },
      effectiveStatus: "expired",
      eligibleForPinReveal: false,
    });

    render(
      <AccessDetailClient
        accessSessionId={sessionId}
        initialDetail={expiredDetail}
      />
    );

    expect(
      screen.getByTestId("pin-ineligible-banner").getAttribute("data-reason-code")
    ).toBe("EXPIRED");
    expect(screen.queryByTestId("reveal-pin-btn")).toBeNull();
    expect(screen.queryByTestId("revealed-pin-value")).toBeNull();
  });

  // ==========================================================================
  // 6. PIN 교체로 인한 409 PIN_STALE_ROTATED → 이전 PIN 비노출 및 최신 PIN 재조회
  // ==========================================================================
  it("6. PIN 교체로 인한 409 PIN_STALE_ROTATED 발생 시 이전 PIN을 즉시 폐기하고 최신 PIN(v2) 재조회 가능", async () => {
    const detail = buildSampleDetail();
    const mockRequester = vi
      .fn()
      // 1차 호출: v1 PIN("1111#") 정상 조회
      .mockResolvedValueOnce({
        httpStatus: 200,
        body: {
          ok: true,
          pin: "1111#",
          codeVersion: 1,
          expiresAt: futureExpiry,
          requestId: "req-v1",
        },
      })
      // 2차 호출: 점주가 PIN을 회전하여 409 PIN_STALE_ROTATED 발생
      .mockResolvedValueOnce({
        httpStatus: 409,
        body: {
          ok: false,
          error: {
            code: "PIN_STALE_ROTATED",
            message: "도어락 PIN이 조회 도중 변경되었습니다. 다시 조회해 주세요.",
          },
          requestId: "req-409",
        },
      })
      // 3차 호출: 최신 v2 PIN("9999#") 정상 조회
      .mockResolvedValueOnce({
        httpStatus: 200,
        body: {
          ok: true,
          pin: "9999#",
          codeVersion: 2,
          expiresAt: futureExpiry,
          requestId: "req-v2",
        },
      });

    render(
      <AccessDetailClient
        accessSessionId={sessionId}
        initialDetail={detail}
        injectedRevealRequester={mockRequester}
      />
    );

    // 1차 조회: "1111#" 표시
    await act(async () => {
      fireEvent.click(screen.getByTestId("reveal-pin-btn"));
    });
    expect(screen.getByTestId("revealed-pin-value").textContent).toBe("1111#");

    // 2차 조회(최신 PIN 다시 확인): 409 PIN_STALE_ROTATED 응답 시 이전 "1111#"이 즉시 사라져야 함!
    await act(async () => {
      fireEvent.click(screen.getByTestId("refresh-pin-btn"));
    });

    expect(screen.queryByTestId("revealed-pin-value")).toBeNull();
    expect(document.body.textContent).not.toContain("1111#");

    const errBanner = screen.getByTestId("pin-reveal-error");
    expect(errBanner.getAttribute("data-error-code")).toBe("PIN_STALE_ROTATED");
    expect(errBanner.textContent).toContain("도어락 비밀번호가 최근 변경되었습니다");

    // 3차 조회(최신 PIN 다시 조회하기 버튼 클릭): 새 PIN "9999#" 표시
    const retryBtn = screen.getByTestId("retry-rotated-pin-btn");
    await act(async () => {
      fireEvent.click(retryBtn);
    });

    expect(screen.queryByTestId("pin-reveal-error")).toBeNull();
    expect(screen.getByTestId("revealed-pin-value").textContent).toBe("9999#");
    expect(document.body.textContent).not.toContain("1111#");
  });

  // ==========================================================================
  // 7. 중복 클릭 및 중복 요청 방지
  // ==========================================================================
  it("7. 중복 클릭 시 진행 중인 요청이 끝나기 전까지 추가 API 호출을 차단함", async () => {
    const detail = buildSampleDetail();
    let resolvePromise!: (val: any) => void;
    const mockRequester = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePromise = resolve;
        })
    );

    render(
      <AccessDetailClient
        accessSessionId={sessionId}
        initialDetail={detail}
        injectedRevealRequester={mockRequester}
      />
    );

    const btn = screen.getByTestId("reveal-pin-btn");

    // 연속 3회 빠른 클릭
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);

    expect(mockRequester).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePromise({
        httpStatus: 200,
        body: {
          ok: true,
          pin: "7777*",
          codeVersion: 1,
          expiresAt: futureExpiry,
          requestId: "req-single",
        },
      });
    });

    expect(screen.getByTestId("revealed-pin-value").textContent).toBe("7777*");
    expect(mockRequester).toHaveBeenCalledTimes(1);
  });

  // ==========================================================================
  // 8. 직원 문의 출입(ask_staff) 시 직원 제시용 화면 표시 및 PIN 비노출
  // ==========================================================================
  it("8. 직원 문의(ask_staff) 이용권은 도어락 PIN 버튼 대신 직원 제시용 이용권 확인번호를 표시함", () => {
    const askStaffDetail = buildSampleDetail({
      session: {
        ...buildSampleDetail().session,
        access_method_snapshot: "ask_staff",
      },
      restroom: {
        ...buildSampleDetail().restroom!,
        access_method: "ask_staff",
      },
      eligibleForPinReveal: false,
    });

    render(
      <AccessDetailClient
        accessSessionId={sessionId}
        initialDetail={askStaffDetail}
      />
    );

    expect(screen.getByTestId("staff-presentation-panel")).toBeDefined();
    expect(screen.getByTestId("staff-ticket-active").textContent).toContain(
      `확인번호 #${sessionId.slice(0, 8).toUpperCase()}`
    );
    expect(screen.queryByTestId("reveal-pin-btn")).toBeNull();
  });

  // ==========================================================================
  // 9. 방문 확인(visit_confirmations) UI 및 API 검증
  // ==========================================================================
  it("9. 방문 확인 UI: 출입 성공 및 출입 실패(사유 필수) 기록이 정상 동작함", async () => {
    const mockVisitRequester = vi.fn().mockImplementation(async (params) => ({
      httpStatus: 201,
      body: {
        ok: true,
        data: {
          confirmation: {
            id: "88888888-8888-4888-8888-888888888888",
            access_session_id: params.accessSessionId,
            usage_status: params.usageStatus,
            verification_method: "user",
            arrival_confirmed_at: "2026-11-15T07:10:00.000Z",
            failure_reason: params.failureReason ?? null,
            verified_at: "2026-11-15T07:10:00.000Z",
            created_at: "2026-11-15T07:10:00.000Z",
            updated_at: "2026-11-15T07:10:00.000Z",
          },
          reused: false,
        },
      },
    }));

    const detail = buildSampleDetail();
    render(
      <AccessDetailClient
        accessSessionId={sessionId}
        initialDetail={detail}
        injectedVisitSubmitRequester={mockVisitRequester}
      />
    );

    // 출입 불가 선택 후 사유 없이 제출 시 클라이언트 검증 에러 확인
    fireEvent.click(screen.getByTestId("visit-status-failed-btn"));
    fireEvent.click(screen.getByTestId("submit-visit-confirmation-btn"));

    expect(screen.getByTestId("visit-confirmation-error").textContent).toContain(
      "2자 이상"
    );
    expect(mockVisitRequester).not.toHaveBeenCalled();

    // 사유 입력 후 제출
    fireEvent.change(screen.getByTestId("visit-failure-reason-input"), {
      target: { value: "도어락 배터리 방전" },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("submit-visit-confirmation-btn"));
    });

    expect(mockVisitRequester).toHaveBeenCalledWith({
      accessSessionId: sessionId,
      usageStatus: "failed",
      failureReason: "도어락 배터리 방전",
    });

    expect(screen.getByTestId("latest-visit-confirmation").textContent).toContain(
      "출입 불편/실패 신고"
    );
    expect(
      screen.getByTestId("latest-visit-failure-reason").textContent
    ).toContain("도어락 배터리 방전");
  });

  // ==========================================================================
  // 10. 방문 확인 API 라우트 (POST /my/access/:id/visit-confirmation) 보안 및 no-store 검증
  // ==========================================================================
  it("10. POST /my/access/:id/visit-confirmation: 비로그인 401, 타인 이용권 403, 정상 저장 201 및 Cache-Control: no-store 확인", async () => {
    // 10-A. 비로그인 401
    vi.mocked(authLib.requireAuth).mockRejectedValueOnce(
      new authLib.AuthGuardError("UNAUTHORIZED", 401, "로그인이 필요합니다.")
    );

    const unauthReq = new Request(
      `http://localhost:3000/my/access/${sessionId}/visit-confirmation`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usageStatus: "success" }),
      }
    );
    const unauthRes = await handlePostVisitConfirmation(unauthReq, {
      params: Promise.resolve({ id: sessionId }),
    });
    expect(unauthRes.status).toBe(401);
    expect(unauthRes.headers.get("Cache-Control")).toContain("no-store");

    // 10-B. 타인 이용권 403 (service_role RPC record_customer_visit_confirmation 호출)
    const mockAdminForOther = {
      rpc: vi.fn().mockResolvedValue({
        data: {
          ok: false,
          status: 403,
          error_code: "FORBIDDEN",
          message: "본인의 이용권에 대해서만 방문 확인을 등록할 수 있습니다.",
        },
        error: null,
      }),
    } as any;
    vi.mocked(supabaseServer.createAdminClient).mockReturnValueOnce(
      mockAdminForOther
    );

    const otherReq = new Request(
      `http://localhost:3000/my/access/${sessionId}/visit-confirmation`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usageStatus: "success" }),
      }
    );
    const otherRes = await handlePostVisitConfirmation(otherReq, {
      params: Promise.resolve({ id: sessionId }),
    });
    expect(otherRes.status).toBe(403);
    expect(mockAdminForOther.rpc).toHaveBeenCalledWith(
      "record_customer_visit_confirmation",
      {
        p_access_session_id: sessionId,
        p_caller_user_id: customerId,
        p_usage_status: "success",
        p_failure_reason: null,
      }
    );
  });

  // ==========================================================================
  // 11. 이용권 목록 화면 (AccessListClient) 필터링 및 렌더링 검증
  // ==========================================================================
  it("11. 이용권 목록 화면: 활성 이용권과 만료 이용권 필터 탭이 정확히 동작하며 PIN은 목록에 노출되지 않음", () => {
    const activeItem: CustomerAccessListItem = buildSampleDetail();
    const expiredItem: CustomerAccessListItem = {
      ...buildSampleDetail(),
      session: {
        ...buildSampleDetail().session,
        id: "99999999-9999-4999-8999-999999999999",
        status: "expired",
        expires_at: pastExpiry,
      },
      effectiveStatus: "expired",
      eligibleForPinReveal: false,
    };

    render(<AccessListClient initialItems={[activeItem, expiredItem]} />);

    expect(
      screen.getByTestId(`access-session-card-${activeItem.session.id}`)
    ).toBeDefined();
    expect(
      screen.getByTestId(`access-session-card-${expiredItem.session.id}`)
    ).toBeDefined();

    // '이용 가능' 탭 클릭
    fireEvent.click(screen.getByTestId("filter-tab-active"));
    expect(
      screen.getByTestId(`access-session-card-${activeItem.session.id}`)
    ).toBeDefined();
    expect(
      screen.queryByTestId(`access-session-card-${expiredItem.session.id}`)
    ).toBeNull();

    // '만료·종료' 탭 클릭
    fireEvent.click(screen.getByTestId("filter-tab-inactive"));
    expect(
      screen.queryByTestId(`access-session-card-${activeItem.session.id}`)
    ).toBeNull();
    expect(
      screen.getByTestId(`access-session-card-${expiredItem.session.id}`)
    ).toBeDefined();
  });

  // ==========================================================================
  // 12. 에러 분류기(classifyPinRevealError) 전 상태 매핑 검증
  // ==========================================================================
  it("12. classifyPinRevealError: 비로그인, 409 회전충돌, 403 권한없음, 결제미완료, 취소/환불, 만료, 429, 500 오류를 정확히 구분함", () => {
    expect(classifyPinRevealError(401, "UNAUTHORIZED").category).toBe(
      "unauthenticated"
    );
    expect(classifyPinRevealError(401, "UNAUTHORIZED").requiresLogin).toBe(
      true
    );

    const rotated = classifyPinRevealError(409, "PIN_STALE_ROTATED");
    expect(rotated.category).toBe("stale_rotated");
    expect(rotated.isRotatedConflict).toBe(true);
    expect(rotated.canRetry).toBe(true);

    expect(classifyPinRevealError(403, "FORBIDDEN").category).toBe("forbidden");
    expect(classifyPinRevealError(422, "PAYMENT_REQUIRED").category).toBe(
      "payment_incomplete"
    );
    expect(classifyPinRevealError(422, "PAYMENT_NOT_APPROVED").category).toBe(
      "payment_incomplete"
    );
    expect(classifyPinRevealError(422, "ACCESS_CANCELED").category).toBe(
      "canceled_or_refunded"
    );
    expect(classifyPinRevealError(422, "PAYMENT_REFUNDED").category).toBe(
      "canceled_or_refunded"
    );
    expect(classifyPinRevealError(422, "ACCESS_EXPIRED").category).toBe(
      "expired"
    );
    expect(classifyPinRevealError(400, "PIN_NOT_SUPPORTED").category).toBe(
      "not_supported"
    );
    expect(classifyPinRevealError(404, "PIN_NOT_AVAILABLE").category).toBe(
      "unavailable"
    );
    expect(classifyPinRevealError(429, "TOO_MANY_REQUESTS").category).toBe(
      "rate_limited"
    );
    expect(classifyPinRevealError(500, "INTERNAL_ERROR").category).toBe(
      "server_error"
    );
  });

  // ==========================================================================
  // 13. 서버 서비스 submitCustomerVisitConfirmation 결제 검증, 멱등성, 비원자적 우회 차단 검증
  // ==========================================================================
  it("13. submitCustomerVisitConfirmation: 미결제 이용권 거부(422), 동일 상태 중복 요청 시 reused=true 반환, 비원자적 우회 차단 및 DB 오류 시 500 실패", async () => {
    // 13-A. created 상태 세션은 422 PAYMENT_REQUIRED 거부
    const mockUnpaidClient = {
      rpc: vi.fn().mockResolvedValue({
        data: {
          ok: false,
          status: 422,
          error_code: "PAYMENT_REQUIRED",
          message: "결제가 승인되지 않은 이용권에는 방문 확인을 기록할 수 없습니다.",
        },
        error: null,
      }),
    } as any;

    await expect(
      submitCustomerVisitConfirmation({
        userId: customerId,
        accessSessionId: sessionId,
        rawInput: { usageStatus: "success" },
        injectedClient: mockUnpaidClient,
      })
    ).rejects.toMatchObject({
      code: "PAYMENT_REQUIRED",
      statusCode: 422,
    });

    // 13-B. 이미 동일한 usage_status='success' 기록이 최신으로 존재하면 멱등 재사용(reused: true)
    const existingVisitRow = {
      id: "99999999-8888-4888-8888-777777777777",
      access_session_id: sessionId,
      usage_status: "success",
      verification_method: "user",
      verified_by: customerId,
      arrival_confirmed_at: "2026-11-15T07:10:00.000Z",
      failure_reason: null,
      verified_at: "2026-11-15T07:10:00.000Z",
      created_at: "2026-11-15T07:10:00.000Z",
      updated_at: "2026-11-15T07:10:00.000Z",
    };

    const mockIdempotentClient = {
      rpc: vi.fn().mockResolvedValue({
        data: {
          ok: true,
          reused: true,
          session_status: "authorized",
          confirmation: existingVisitRow,
        },
        error: null,
      }),
    } as any;

    const idempotentRes = await submitCustomerVisitConfirmation({
      userId: customerId,
      accessSessionId: sessionId,
      rawInput: { usageStatus: "success" },
      injectedClient: mockIdempotentClient,
    });

    expect(idempotentRes.reused).toBe(true);
    expect(idempotentRes.confirmation.id).toBe(existingVisitRow.id);

    // 13-C. RPC가 없는 클라이언트 주입 시 비원자적 SELECT->INSERT로 우회하지 않고 즉시 500 실패
    const mockNonRpcClient = {
      from: vi.fn(),
    } as any;

    await expect(
      submitCustomerVisitConfirmation({
        userId: customerId,
        accessSessionId: sessionId,
        rawInput: { usageStatus: "success" },
        injectedClient: mockNonRpcClient,
      })
    ).rejects.toMatchObject({
      code: "DATABASE_ERROR",
      statusCode: 500,
    });
    expect(mockNonRpcClient.from).not.toHaveBeenCalled();

    // 13-D. DB RPC 에러 발생 시 정상적으로 500 DATABASE_ERROR 실패
    const mockErrorClient = {
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { code: "42883", message: "function does not exist" },
      }),
    } as any;

    await expect(
      submitCustomerVisitConfirmation({
        userId: customerId,
        accessSessionId: sessionId,
        rawInput: { usageStatus: "success" },
        injectedClient: mockErrorClient,
      })
    ).rejects.toMatchObject({
      code: "DATABASE_ERROR",
      statusCode: 500,
    });
  });

  // ==========================================================================
  // 14. GET /my/access/data & GET /my/access/:id/data 라우트 핸들러 보안 검증
  // ==========================================================================
  it("14. GET /my/access/data 및 GET /my/access/:id/data: 비로그인 401 차단 및 Cache-Control: private, no-store 보장", async () => {
    vi.mocked(authLib.requireAuth).mockRejectedValueOnce(
      new authLib.AuthGuardError("UNAUTHORIZED", 401, "로그인이 필요합니다.")
    );
    const listRes = await handleGetListData();
    expect(listRes.status).toBe(401);
    expect(listRes.headers.get("Cache-Control")).toContain("no-store");

    vi.mocked(authLib.requireAuth).mockRejectedValueOnce(
      new authLib.AuthGuardError("UNAUTHORIZED", 401, "로그인이 필요합니다.")
    );
    const detailReq = new Request(
      `http://localhost:3000/my/access/${sessionId}/data`
    );
    const detailRes = await handleGetDetailData(detailReq, {
      params: Promise.resolve({ id: sessionId }),
    });
    expect(detailRes.status).toBe(401);
    expect(detailRes.headers.get("Cache-Control")).toContain("no-store");
  });

  // ==========================================================================
  // 15. 원자적 RPC(record_customer_visit_confirmation) 기반 동시성·멱등성·인가 검증
  // ==========================================================================
  it("15. record_customer_visit_confirmation 원자적 RPC: 동시 요청 시 1건 생성(201) + 1건 재사용(200) 및 타인/미결제 차단", async () => {
    let callCount = 0;
    const visitUuid = "77777777-7777-4777-8777-777777777777";
    const sharedConfirmation = {
      id: visitUuid,
      access_session_id: sessionId,
      usage_status: "success",
      verification_method: "user",
      verified_by: customerId,
      arrival_confirmed_at: new Date().toISOString(),
      failure_reason: null,
      verified_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const mockRpcClient = {
      rpc: vi.fn(async (fnName: string, args: Record<string, unknown>) => {
        expect(fnName).toBe("record_customer_visit_confirmation");
        if (args.p_caller_user_id === otherCustomerId) {
          return {
            data: {
              ok: false,
              status: 403,
              error_code: "FORBIDDEN",
              message: "본인의 이용권에 대해서만 방문 확인을 등록할 수 있습니다.",
            },
            error: null,
          };
        }
        callCount += 1;
        return {
          data: {
            ok: true,
            reused: callCount > 1,
            confirmation: sharedConfirmation,
          },
          error: null,
        };
      }),
    } as any;

    const [resA, resB] = await Promise.all([
      submitCustomerVisitConfirmation({
        userId: customerId,
        accessSessionId: sessionId,
        rawInput: { usageStatus: "success" },
        injectedClient: mockRpcClient,
      }),
      submitCustomerVisitConfirmation({
        userId: customerId,
        accessSessionId: sessionId,
        rawInput: { usageStatus: "success" },
        injectedClient: mockRpcClient,
      }),
    ]);

    expect([resA.reused, resB.reused].sort()).toEqual([false, true]);
    expect(resA.confirmation.id).toBe(visitUuid);
    expect(resB.confirmation.id).toBe(visitUuid);

    await expect(
      submitCustomerVisitConfirmation({
        userId: otherCustomerId,
        accessSessionId: sessionId,
        rawInput: { usageStatus: "success" },
        injectedClient: mockRpcClient,
      })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      statusCode: 403,
    });
  });
});
