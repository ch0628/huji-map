import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as analyticsModule from "@/lib/analytics";
import {
  computeH1Metrics,
  computeH2Metrics,
  computeH5Metrics,
  computeEventBreakdown,
  getPmfReport,
  pmfQuerySchema,
  DEFAULT_STARTS_AT,
  DEFAULT_ENDS_AT,
  PROVISIONAL_NOTICE,
  type PmfReportData,
} from "@/lib/analytics";
import { GET as pmfGet } from "@/app/api/v1/admin/analytics/pmf/route";

describe("TASK 19: PMF Analytics - H1, H2, H5 Hypothesis Verification & Audit Reporting", () => {
  const WINDOW = {
    startsAt: "2026-11-05T00:00:00.000Z",
    endsAt: "2026-11-18T14:59:59.999Z",
  };

  describe("1. H1 점주 제휴 전환 가설 (computeH1Metrics)", () => {
    it("연락 시도가 있는 고유 리드를 분모로 하고, 승인된 등록 점포를 분자로 계산한다", () => {
      const mockLeads = [
        { id: "lead-1", converted_business_id: "biz-1" },
        { id: "lead-2", converted_business_id: "biz-2" },
        { id: "lead-3", converted_business_id: "biz-3" },
        { id: "lead-4", converted_business_id: null },
        { id: "lead-5", converted_business_id: null },
      ];

      // lead-1: 3 attempts, lead-2: 1 attempt, lead-3: 1 attempt, lead-4: 2 attempts, lead-5: 0 attempts
      const mockAttempts = [
        { lead_id: "lead-1" },
        { lead_id: "lead-1" },
        { lead_id: "lead-1" },
        { lead_id: "lead-2" },
        { lead_id: "lead-3" },
        { lead_id: "lead-4" },
        { lead_id: "lead-4" },
      ];

      const mockBusinesses = [
        { id: "biz-1", status: "approved" },
        { id: "biz-2", status: "pending" }, // 아직 미승인
        { id: "biz-3", status: "approved" },
      ];

      const res = computeH1Metrics(mockLeads, mockAttempts, mockBusinesses);

      // Denominator: lead-1, lead-2, lead-3, lead-4 (lead-5 has no attempts, so 4 distinct contacted)
      expect(res.denominatorCount).toBe(4);
      expect(res.targetDenominator).toBe(50);

      // Numerator: lead-1 (biz-1 approved) and lead-3 (biz-3 approved) -> 2
      // lead-2 has biz-2 which is pending, so not counted
      expect(res.numeratorCount).toBe(2);
      expect(res.targetNumerator).toBe(5);

      // Conversion rate: 2 / 4 = 50.0%
      expect(res.conversionRatePercent).toBe(50.0);
      expect(res.isSufficientData).toBe(false); // 4 < 50
      expect(res.status).toBe("insufficient_data");
    });

    it("동일 리드에 여러 번의 연락 시도가 있어도 분모는 1곳으로 중복 제거된다", () => {
      const mockLeads = [{ id: "lead-1", converted_business_id: "biz-1" }];
      const mockAttempts = [
        { lead_id: "lead-1" },
        { lead_id: "lead-1" },
        { lead_id: "lead-1" },
      ];
      const mockBusinesses = [{ id: "biz-1", status: "approved" }];

      const res = computeH1Metrics(mockLeads, mockAttempts, mockBusinesses);
      expect(res.denominatorCount).toBe(1);
      expect(res.numeratorCount).toBe(1);
      expect(res.conversionRatePercent).toBe(100.0);
    });

    it("미접촉 리드가 제휴 신청했더라도 H1 접촉 분모 및 전환 분자에 포함하지 않는다", () => {
      const mockLeads = [{ id: "lead-uncontacted", converted_business_id: "biz-uncontacted" }];
      const mockAttempts: Array<{ lead_id: string }> = [];
      const mockBusinesses = [{ id: "biz-uncontacted", status: "approved" }];

      const res = computeH1Metrics(mockLeads, mockAttempts, mockBusinesses);
      expect(res.denominatorCount).toBe(0);
      expect(res.numeratorCount).toBe(0);
      expect(res.conversionRatePercent).toBe(0);
    });
  });

  describe("2. H2 광고 유입 + 여행자 길찾기 전환 가설 (computeH2Metrics)", () => {
    it("광고 유입 + 여행 중(travelingNow=true) 고유 브라우저만 분모에 포함하고, 그 중 길찾기를 실행한 브라우저를 분자로 계산한다", () => {
      const mockSessions = [
        // Qualified: Ad + Traveling
        {
          id: "sess-1",
          browser_id: "browser-ad-traveler-1",
          started_at: "2026-11-06T10:00:00Z",
          utm_source: "kakao_ad",
          traveling_now: true,
          is_test: false,
        },
        // Qualified: Ad + Traveling
        {
          id: "sess-2",
          browser_id: "browser-ad-traveler-2",
          started_at: "2026-11-06T11:00:00Z",
          utm_source: "google_ad",
          traveling_now: true,
          is_test: false,
        },
        // Excluded: Organic (no utm_source) even if travelingNow=true
        {
          id: "sess-3",
          browser_id: "browser-organic-traveler",
          started_at: "2026-11-06T12:00:00Z",
          utm_source: null,
          traveling_now: true,
          is_test: false,
        },
        // Excluded: Ad, but travelingNow=false
        {
          id: "sess-4",
          browser_id: "browser-ad-local",
          started_at: "2026-11-06T13:00:00Z",
          utm_source: "kakao_ad",
          traveling_now: false,
          is_test: false,
        },
        // Excluded: Test traffic
        {
          id: "sess-5",
          browser_id: "browser-test-qa",
          started_at: "2026-11-06T14:00:00Z",
          utm_source: "test_ad",
          traveling_now: true,
          is_test: true,
        },
      ];

      const mockEvents = [
        // traveler 1 did directions_clicked
        {
          event_name: "directions_clicked",
          browser_id: "browser-ad-traveler-1",
          occurred_at: "2026-11-06T10:05:00Z",
          is_test: false,
        },
        // organic traveler also did directions_clicked (MUST NOT count towards H2 numerator)
        {
          event_name: "directions_clicked",
          browser_id: "browser-organic-traveler",
          occurred_at: "2026-11-06T12:05:00Z",
          is_test: false,
        },
        // test traveler did directions (MUST NOT count)
        {
          event_name: "directions_clicked",
          browser_id: "browser-test-qa",
          occurred_at: "2026-11-06T14:05:00Z",
          is_test: true,
        },
      ];

      const res = computeH2Metrics(mockSessions, mockEvents, WINDOW, false);

      // Denominator: browser-ad-traveler-1, browser-ad-traveler-2 -> 2
      expect(res.denominatorCount).toBe(2);
      expect(res.targetDenominator).toBe(50);

      // Numerator: browser-ad-traveler-1 -> 1
      expect(res.numeratorCount).toBe(1);
      expect(res.targetNumerator).toBe(5);

      // Conversion rate: 1 / 2 = 50.0%
      expect(res.conversionRatePercent).toBe(50.0);

      // Exclusions
      expect(res.excludedOrganicCount).toBe(1);
      expect(res.excludedNonTravelingCount).toBe(1);
    });

    it("travel_answer_submitted 권위적 서버 이벤트를 통해 traveling_now가 true로 입증된 세션도 정상 인정한다", () => {
      const mockSessions = [
        {
          id: "sess-delayed-answer",
          browser_id: "browser-delayed",
          started_at: "2026-11-07T09:00:00Z",
          utm_source: "instagram_ad",
          traveling_now: null, // 초기 null이었으나 서버 이벤트로 확정된 경우
          is_test: false,
        },
      ];

      const mockEvents = [
        {
          session_id: "sess-delayed-answer",
          browser_id: "browser-delayed",
          event_name: "travel_answer_submitted",
          properties: { traveling_now: true, server_verified: true },
          occurred_at: "2026-11-07T09:01:00Z",
          is_test: false,
        },
        {
          browser_id: "browser-delayed",
          event_name: "directions_clicked",
          occurred_at: "2026-11-07T09:05:00Z",
          is_test: false,
        },
      ];

      const res = computeH2Metrics(mockSessions, mockEvents, WINDOW, false);
      expect(res.denominatorCount).toBe(1);
      expect(res.numeratorCount).toBe(1);
      expect(res.conversionRatePercent).toBe(100.0);
    });
  });

  describe("3. H5 제휴 화장실 카드 노출 대비 동일 화장실 길찾기 전환 가설 (computeH5Metrics)", () => {
    const mockRestrooms = [
      { id: "partner-restroom-A", type: "partner" as const },
      { id: "partner-restroom-B", type: "partner" as const },
      { id: "public-restroom-C", type: "public" as const },
    ];

    it("제휴 화장실 카드가 노출된 브라우저가 '동일한' 제휴 화장실의 길찾기를 실행했을 때만 전환으로 인정한다", () => {
      const mockEvents = [
        // Browser 1: Exposed to Partner A -> Clicked Directions to Partner A (MATCH -> Valid H5 conversion)
        {
          browser_id: "browser-1",
          restroom_id: "partner-restroom-A",
          event_name: "restroom_card_viewed",
          properties: { card_type: "partner", restroom_id: "partner-restroom-A" },
          occurred_at: "2026-11-08T10:00:00Z",
          is_test: false,
        },
        {
          browser_id: "browser-1",
          restroom_id: "partner-restroom-A",
          event_name: "directions_clicked",
          properties: { type: "partner", restroom_id: "partner-restroom-A" },
          occurred_at: "2026-11-08T10:02:00Z",
          is_test: false,
        },

        // Browser 2: Exposed to Partner A -> Clicked Directions to Public Restroom C (MISMATCH -> Excluded from H5)
        {
          browser_id: "browser-2",
          restroom_id: "partner-restroom-A",
          event_name: "restroom_card_viewed",
          properties: { card_type: "partner", restroom_id: "partner-restroom-A" },
          occurred_at: "2026-11-08T11:00:00Z",
          is_test: false,
        },
        {
          browser_id: "browser-2",
          restroom_id: "public-restroom-C",
          event_name: "directions_clicked",
          properties: { type: "public", restroom_id: "public-restroom-C" },
          occurred_at: "2026-11-08T11:05:00Z",
          is_test: false,
        },

        // Browser 3: Exposed to Partner A -> Clicked Directions to Partner B (DIFFERENT PARTNER -> Excluded from H5)
        {
          browser_id: "browser-3",
          restroom_id: "partner-restroom-A",
          event_name: "restroom_card_viewed",
          properties: { card_type: "partner", restroom_id: "partner-restroom-A" },
          occurred_at: "2026-11-08T12:00:00Z",
          is_test: false,
        },
        {
          browser_id: "browser-3",
          restroom_id: "partner-restroom-B",
          event_name: "directions_clicked",
          properties: { type: "partner", restroom_id: "partner-restroom-B" },
          occurred_at: "2026-11-08T12:05:00Z",
          is_test: false,
        },

        // Browser 4: Exposed ONLY to Public C -> Clicked directions to Public C (NOT H5 denominator)
        {
          browser_id: "browser-4",
          restroom_id: "public-restroom-C",
          event_name: "restroom_card_viewed",
          properties: { card_type: "public", restroom_id: "public-restroom-C" },
          occurred_at: "2026-11-08T13:00:00Z",
          is_test: false,
        },
        {
          browser_id: "browser-4",
          restroom_id: "public-restroom-C",
          event_name: "directions_clicked",
          properties: { type: "public", restroom_id: "public-restroom-C" },
          occurred_at: "2026-11-08T13:05:00Z",
          is_test: false,
        },
      ];

      const res = computeH5Metrics(mockEvents, mockRestrooms, WINDOW, false);

      // Denominator: browser-1, browser-2, browser-3 (exposed to partner A) -> 3
      // browser-4 was only exposed to public restroom, so excluded from denominator
      expect(res.denominatorCount).toBe(3);

      // Numerator: browser-1 only (clicked directions to partner A, the same restroom) -> 1
      expect(res.numeratorCount).toBe(1);

      // Exclusions
      expect(res.excludedPublicDirectionsCount).toBe(2); // browser-2 and browser-4
      expect(res.excludedMismatchedPartnerDirectionsCount).toBe(1); // browser-3

      // Conversion rate: 1 / 3 = 33.3%
      expect(res.conversionRatePercent).toBe(33.3);
    });

    it("동일 브라우저가 제휴 화장실 카드를 여러 번 중복 조회해도 분모는 1명으로 집계된다", () => {
      const mockEvents = [
        {
          browser_id: "browser-repeat",
          restroom_id: "partner-restroom-A",
          event_name: "restroom_card_viewed",
          properties: { card_type: "partner", restroom_id: "partner-restroom-A" },
          occurred_at: "2026-11-09T10:00:00Z",
          is_test: false,
        },
        {
          browser_id: "browser-repeat",
          restroom_id: "partner-restroom-A",
          event_name: "restroom_card_viewed",
          properties: { card_type: "partner", restroom_id: "partner-restroom-A" },
          occurred_at: "2026-11-09T10:01:00Z",
          is_test: false,
        },
      ];

      const res = computeH5Metrics(mockEvents, mockRestrooms, WINDOW, false);
      expect(res.denominatorCount).toBe(1);
      expect(res.numeratorCount).toBe(0);
    });
  });

  describe("4. 관찰 기간 및 테스트 트래픽 필터링 (computeEventBreakdown & Windows)", () => {
    it("관찰 기간 밖의 이벤트는 집계에서 완전 제외된다", () => {
      const mockEvents = [
        {
          event_name: "landing_view",
          browser_id: "browser-early",
          occurred_at: "2026-11-04T23:59:59Z", // Before start
          is_test: false,
        },
        {
          event_name: "landing_view",
          browser_id: "browser-valid",
          occurred_at: "2026-11-06T12:00:00Z", // Inside window
          is_test: false,
        },
        {
          event_name: "landing_view",
          browser_id: "browser-late",
          occurred_at: "2026-11-19T00:00:00Z", // After end
          is_test: false,
        },
      ];

      const breakdown = computeEventBreakdown(mockEvents, WINDOW, false);
      const landingRow = breakdown.find((r) => r.eventName === "landing_view");

      expect(landingRow?.rawEventCount).toBe(1);
      expect(landingRow?.distinctBrowserCount).toBe(1);
    });

    it("is_test=true인 QA 이벤트는 includeTest가 false일 때 기본 제외된다", () => {
      const mockEvents = [
        {
          event_name: "map_loaded",
          browser_id: "browser-qa",
          occurred_at: "2026-11-06T12:00:00Z",
          is_test: true,
        },
        {
          event_name: "map_loaded",
          browser_id: "browser-real",
          occurred_at: "2026-11-06T12:01:00Z",
          is_test: false,
        },
      ];

      const breakdownNoTest = computeEventBreakdown(mockEvents, WINDOW, false);
      expect(breakdownNoTest.find((r) => r.eventName === "map_loaded")?.rawEventCount).toBe(1);

      const breakdownWithTest = computeEventBreakdown(mockEvents, WINDOW, true);
      expect(breakdownWithTest.find((r) => r.eventName === "map_loaded")?.rawEventCount).toBe(2);
    });
  });

  describe("5. 0건 데이터 처리 및 안전성 (getPmfReport with zero data)", () => {
    it("수집된 데이터가 0건일 때 크래시 없이 0건 리포트와 모수 부족 상태를 안전하게 반환한다", async () => {
      const mockSupabase = {
        from: vi.fn((table: string) => ({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null }),
            }),
            data: [],
          }),
        })),
      } as any;

      const report = await getPmfReport(mockSupabase, {
        experimentKey: "pmf_r1",
        includeTest: false,
      });

      expect(report.experiment.rulesComplete).toBe(false);
      expect(report.experiment.provisionalNotice).toBe(PROVISIONAL_NOTICE);
      expect(report.summary.totalEvents).toBe(0);
      expect(report.summary.distinctBrowsers).toBe(0);

      expect(report.hypotheses.h1.denominatorCount).toBe(0);
      expect(report.hypotheses.h1.numeratorCount).toBe(0);
      expect(report.hypotheses.h1.conversionRatePercent).toBe(0);
      expect(report.hypotheses.h1.isSufficientData).toBe(false);

      expect(report.hypotheses.h2.denominatorCount).toBe(0);
      expect(report.hypotheses.h2.numeratorCount).toBe(0);
      expect(report.hypotheses.h2.conversionRatePercent).toBe(0);
      expect(report.hypotheses.h2.isSufficientData).toBe(false);

      expect(report.hypotheses.h5.denominatorCount).toBe(0);
      expect(report.hypotheses.h5.numeratorCount).toBe(0);
      expect(report.hypotheses.h5.conversionRatePercent).toBe(0);
      expect(report.hypotheses.h5.isSufficientData).toBe(false);
    });
  });

  describe("6. Zod 쿼리 파라미터 검증 (pmfQuerySchema)", () => {
    it("기본 파라미터가 누락되어도 올바른 기본값(experimentKey: pmf_r1, includeTest: false)을 설정한다", () => {
      const parsed = pmfQuerySchema.safeParse({});
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.experimentKey).toBe("pmf_r1");
        expect(parsed.data.includeTest).toBe(false);
        expect(parsed.data.startsAt).toBeUndefined();
        expect(parsed.data.endsAt).toBeUndefined();
      }
    });

    it("유효하지 않은 날짜 포맷이 전달되면 검증 오류를 반환한다", () => {
      const parsed = pmfQuerySchema.safeParse({
        startsAt: "invalid-date-string",
      });
      expect(parsed.success).toBe(false);
    });

    it("includeTest가 문자열 'true'로 들어와도 boolean true로 파싱한다", () => {
      const parsed = pmfQuerySchema.safeParse({
        includeTest: "true",
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.includeTest).toBe(true);
      }
    });
  });

  describe("7. 관리자 PMF API 엔드포인트 보안 및 응답 형태 검증 (GET /api/v1/admin/analytics/pmf)", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = {
        ...originalEnv,
        ALLOW_E2E_MOCK: "1",
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "dummy-key",
      };
    });

    afterEach(() => {
      process.env = originalEnv;
      vi.restoreAllMocks();
    });

    it("환경변수 및 모킹이 없으면 503 CONFIG_REQUIRED를 반환한다", async () => {
      delete process.env.ALLOW_E2E_MOCK;
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

      const req = new Request("http://localhost:3000/api/v1/admin/analytics/pmf");
      const res = await pmfGet(req);
      expect(res.status).toBe(503);

      const body = await res.json();
      expect(body.error.code).toBe("CONFIG_REQUIRED");
    });

    it("비인증 사용자의 API 요청은 401 UNAUTHORIZED로 차단된다", async () => {
      const req = new Request("http://localhost:3000/api/v1/admin/analytics/pmf");
      const res = await pmfGet(req);
      expect(res.status).toBe(401);

      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("일반 회원(customer) 쿠키를 가진 요청은 403 FORBIDDEN으로 차단된다", async () => {
      const req = new Request("http://localhost:3000/api/v1/admin/analytics/pmf", {
        headers: {
          cookie: "e2e_mock_customer=1",
        },
      });
      const res = await pmfGet(req);
      expect(res.status).toBe(403);

      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("관리자(admin) 쿠키를 가진 요청은 200 OK와 올바른 PMF 리포트를 반환한다", async () => {
      const mockReport: PmfReportData = {
        experiment: {
          experimentKey: "pmf_r1",
          name: "1차 PMF 가설 검증 실험 (pmf_r1)",
          rulesVersion: "2026-11-04_agreed_metrics",
          startsAt: DEFAULT_STARTS_AT,
          endsAt: DEFAULT_ENDS_AT,
          status: "running",
          rulesComplete: false,
          provisionalNotice: PROVISIONAL_NOTICE,
        },
        observationWindow: {
          startsAt: DEFAULT_STARTS_AT,
          endsAt: DEFAULT_ENDS_AT,
          isOngoing: true,
        },
        summary: {
          totalEvents: 10,
          distinctBrowsers: 5,
          distinctSessions: 5,
          excludedTestEvents: 0,
          excludedTestSessions: 0,
        },
        hypotheses: {
          h1: {
            hypothesisKey: "H1",
            name: "H1. 점주 제휴 전환",
            definition: "접촉 대상 점포 50곳 중 정식 승인 5곳 이상",
            denominatorCount: 50,
            targetDenominator: 50,
            numeratorCount: 5,
            targetNumerator: 5,
            conversionRatePercent: 10.0,
            isTargetMet: true,
            isSufficientData: true,
            status: "provisional",
          },
          h2: {
            hypothesisKey: "H2",
            name: "H2. 여행자 길찾기 전환",
            definition: "광고 유입 + 여행 중 50명 중 길찾기 5명 이상",
            denominatorCount: 50,
            targetDenominator: 50,
            numeratorCount: 5,
            targetNumerator: 5,
            conversionRatePercent: 10.0,
            isTargetMet: true,
            isSufficientData: true,
            status: "provisional",
            excludedOrganicCount: 10,
            excludedNonTravelingCount: 5,
          },
          h5: {
            hypothesisKey: "H5",
            name: "H5. 제휴 화장실 이용 의향",
            definition: "제휴 카드 노출 50명 중 동일 제휴 화장실 길찾기 5명 이상",
            denominatorCount: 50,
            targetDenominator: 50,
            numeratorCount: 5,
            targetNumerator: 5,
            conversionRatePercent: 10.0,
            isTargetMet: true,
            isSufficientData: true,
            status: "provisional",
            excludedPublicDirectionsCount: 3,
            excludedMismatchedPartnerDirectionsCount: 2,
          },
        },
        eventBreakdown: [
          {
            eventName: "landing_view",
            rawEventCount: 10,
            distinctBrowserCount: 5,
          },
        ],
        generatedAt: new Date().toISOString(),
      };

      vi.spyOn(analyticsModule, "getPmfReport").mockResolvedValueOnce(mockReport);

      const req = new Request("http://localhost:3000/api/v1/admin/analytics/pmf?experimentKey=pmf_r1", {
        headers: {
          cookie: "e2e_mock_admin=1",
        },
      });
      const res = await pmfGet(req);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data).toBeDefined();

      const report = body.data;
      expect(report.experiment.experimentKey).toBe("pmf_r1");
      expect(report.experiment.rulesComplete).toBe(false);
      expect(report.hypotheses.h1).toBeDefined();
      expect(report.hypotheses.h2).toBeDefined();
      expect(report.hypotheses.h5).toBeDefined();
      expect(report.eventBreakdown).toBeDefined();

      // 응답 데이터 내 민감정보(PIN, 키, 비밀번호) 부재 검증
      const responseText = JSON.stringify(body);
      const FORBIDDEN_WORDS = ["pin", "password", "secret", "sessionToken", "token"];
      for (const word of FORBIDDEN_WORDS) {
        expect(responseText.toLowerCase()).not.toContain(`"${word}"`);
      }
    });
  });
});
