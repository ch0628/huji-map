/**
 * TASK 19: Mobile Chrome (360x740) E2E User Flow Verification
 * Tests the admin PMF analytics dashboard, provisional state notice (rulesComplete=false),
 * H1/H2/H5 hypothesis metrics, exclusions breakdown, event tables, and role-based access control.
 */

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const PORT = 3019;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const SCREENSHOT_DIR = path.resolve("tests/e2e/screenshots");

function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {}
}

async function startNextServer() {
  console.log(">>> 1. Starting Next.js Production Server on port", PORT, "...");
  const server = spawn("cmd.exe", ["/c", `npx next start -p ${PORT} -H 127.0.0.1`], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    env: { ...process.env, PORT: String(PORT), ALLOW_E2E_MOCK: "1" },
  });

  server.stdout.on("data", (d) => {
    console.log("[server out]", d.toString().trim());
  });

  server.stderr.on("data", (d) => {
    const s = d.toString();
    if (!s.includes("DeprecationWarning")) {
      console.error("[server err]", s.trim());
    }
  });

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`${BASE_URL}/map`);
      if (res.status >= 200 && res.status < 400) {
        console.log("✓ Next.js server ready at", BASE_URL, `(status: ${res.status})`);
        return server;
      }
    } catch {}
  }
  killProcessTree(server.pid);
  throw new Error("Failed to start Next.js server within 30s");
}

async function runTests() {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }

  let server = null;
  let browser = null;

  try {
    server = await startNextServer();

    console.log(">>> 2. Launching Real Google Chrome (360x740 viewport) via Playwright...");
    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
    });

    const context = await browser.newContext({
      viewport: { width: 360, height: 740 },
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });

    const page = await context.newPage();

    async function checkNoHorizontalOverflow(stepName) {
      const overflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth;
      });
      if (overflow) {
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        throw new Error(
          `[${stepName}] Horizontal overflow detected! scrollWidth=${scrollWidth}px > 360px`
        );
      }
      console.log(`  ✓ [${stepName}] 360px viewport check passed: no horizontal overflow.`);
    }

    // =========================================================================
    // Step 1: 비로그인(Guest) 관리자 화면 접근 차단 (401 Unauthorized UI)
    // =========================================================================
    console.log("\n>>> Step 1: Guest Access Protection to /admin/analytics/pmf...");
    await page.goto(`${BASE_URL}/admin/analytics/pmf`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);

    const unauthorizedAlert = page.locator('[data-testid="admin-pmf-unauthorized-401"]');
    await unauthorizedAlert.waitFor({ state: "visible", timeout: 5000 });
    console.log("✓ Guest is blocked with 401 Unauthorized UI alert");
    await checkNoHorizontalOverflow("Step 1 Guest 401");

    // =========================================================================
    // Step 2: 일반 회원(Customer) 관리자 화면 접근 차단 (403 Forbidden UI)
    // =========================================================================
    console.log("\n>>> Step 2: Customer (Non-admin) Access Protection...");
    await context.addCookies([
      {
        name: "e2e_mock_customer",
        value: "1",
        domain: "127.0.0.1",
        path: "/",
      },
    ]);

    await page.goto(`${BASE_URL}/admin/analytics/pmf`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);

    const forbiddenAlert = page.locator('[data-testid="admin-pmf-forbidden-403"]');
    await forbiddenAlert.waitFor({ state: "visible", timeout: 5000 });
    console.log("✓ Customer is blocked with 403 Forbidden UI alert");
    await checkNoHorizontalOverflow("Step 2 Customer 403");

    // =========================================================================
    // Step 3: 관리자(Admin) 권한으로 PMF 대시보드 렌더링 및 지표 확인
    // =========================================================================
    console.log("\n>>> Step 3: Admin PMF Analytics Dashboard Rendering...");
    await context.clearCookies();
    await context.addCookies([
      {
        name: "e2e_mock_admin",
        value: "1",
        domain: "127.0.0.1",
        path: "/",
      },
    ]);

    // Mock API payload for deterministic dashboard verification
    const mockReportData = {
      experiment: {
        experimentKey: "pmf_r1",
        name: "1차 PMF 가설 검증 실험 (pmf_r1)",
        rulesVersion: "2026-11-04_agreed_metrics",
        startsAt: "2026-11-05T00:00:00.000Z",
        endsAt: "2026-11-18T14:59:59.999Z",
        status: "running",
        rulesComplete: false,
        provisionalNotice:
          "판정 원문 19개 상세 규칙이 아직 확정 수록되지 않았으므로 잠정 집계만 제공하며, 최종 PMF PASS/FAIL 판정은 보류됩니다.",
      },
      observationWindow: {
        startsAt: "2026-11-05T00:00:00.000Z",
        endsAt: "2026-11-18T14:59:59.999Z",
        isOngoing: true,
      },
      summary: {
        totalEvents: 142,
        distinctBrowsers: 65,
        distinctSessions: 78,
        excludedTestEvents: 12,
        excludedTestSessions: 4,
      },
      hypotheses: {
        h1: {
          hypothesisKey: "H1",
          name: "H1. 점주 제휴 전환",
          definition: "접촉 대상 점포 50곳 중 정식 승인 5곳 이상",
          denominatorCount: 50,
          targetDenominator: 50,
          numeratorCount: 6,
          targetNumerator: 5,
          conversionRatePercent: 12.0,
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
          numeratorCount: 7,
          targetNumerator: 5,
          conversionRatePercent: 14.0,
          isTargetMet: true,
          isSufficientData: true,
          status: "provisional",
          excludedOrganicCount: 24,
          excludedNonTravelingCount: 15,
        },
        h5: {
          hypothesisKey: "H5",
          name: "H5. 제휴 화장실 이용 의향",
          definition: "제휴 카드 노출 50명 중 동일 제휴 화장실 길찾기 5명 이상",
          denominatorCount: 50,
          targetDenominator: 50,
          numeratorCount: 8,
          targetNumerator: 5,
          conversionRatePercent: 16.0,
          isTargetMet: true,
          isSufficientData: true,
          status: "provisional",
          excludedPublicDirectionsCount: 18,
          excludedMismatchedPartnerDirectionsCount: 4,
        },
      },
      eventBreakdown: [
        { eventName: "landing_view", rawEventCount: 50, distinctBrowserCount: 35 },
        { eventName: "map_loaded", rawEventCount: 45, distinctBrowserCount: 32 },
        { eventName: "restroom_marker_clicked", rawEventCount: 38, distinctBrowserCount: 28 },
        { eventName: "restroom_card_viewed", rawEventCount: 30, distinctBrowserCount: 25 },
        { eventName: "restroom_detail_opened", rawEventCount: 15, distinctBrowserCount: 12 },
        { eventName: "directions_clicked", rawEventCount: 22, distinctBrowserCount: 18 },
        { eventName: "travel_answer_submitted", rawEventCount: 28, distinctBrowserCount: 24 },
        { eventName: "payment_button_clicked", rawEventCount: 8, distinctBrowserCount: 7 },
        { eventName: "payment_unavailable_shown", rawEventCount: 10, distinctBrowserCount: 9 },
      ],
      generatedAt: new Date().toISOString(),
    };

    let emptyStateMock = false;

    await page.route("**/api/v1/admin/analytics/pmf*", async (route) => {
      if (emptyStateMock) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            success: true,
            data: {
              ...mockReportData,
              summary: {
                totalEvents: 0,
                distinctBrowsers: 0,
                distinctSessions: 0,
                excludedTestEvents: 0,
                excludedTestSessions: 0,
              },
              hypotheses: {
                h1: { ...mockReportData.hypotheses.h1, denominatorCount: 0, numeratorCount: 0, conversionRatePercent: 0, isSufficientData: false },
                h2: { ...mockReportData.hypotheses.h2, denominatorCount: 0, numeratorCount: 0, conversionRatePercent: 0, isSufficientData: false },
                h5: { ...mockReportData.hypotheses.h5, denominatorCount: 0, numeratorCount: 0, conversionRatePercent: 0, isSufficientData: false },
              },
              eventBreakdown: mockReportData.eventBreakdown.map((e) => ({ ...e, rawEventCount: 0, distinctBrowserCount: 0 })),
            },
          }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          success: true,
          data: mockReportData,
        }),
      });
    });

    await page.goto(`${BASE_URL}/admin/analytics/pmf`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);

    const dashboardContainer = page.locator('[data-testid="pmf-dashboard-container"]');
    await dashboardContainer.waitFor({ state: "visible", timeout: 5000 });
    console.log("✓ Admin PMF Dashboard container is visible");

    // 1. Check rulesComplete = false Warning Banner
    const warningBanner = page.locator('[data-testid="pmf-provisional-warning-banner"]');
    await warningBanner.waitFor({ state: "visible" });
    const bannerText = await warningBanner.innerText();
    if (!bannerText.includes("rulesComplete = false") || !bannerText.includes("판정 보류")) {
      throw new Error("Provisional warning banner missing rulesComplete=false or 판정 보류 status");
    }
    console.log("✓ Provisional notice banner rendered prominently with rulesComplete=false");

    // 2. Check H1, H2, H5 Cards
    const cardH1 = page.locator('[data-testid="hypothesis-card-h1"]');
    await cardH1.waitFor({ state: "visible" });
    const h1Text = await cardH1.innerText();
    if (!h1Text.includes("H1. 점주 제휴 전환") || !h1Text.includes("6 / 50곳")) {
      throw new Error(`Card H1 text mismatch: ${h1Text}`);
    }
    console.log("✓ Card H1 rendered correctly (6 / 50곳 접촉, 12%)");

    const cardH2 = page.locator('[data-testid="hypothesis-card-h2"]');
    await cardH2.waitFor({ state: "visible" });
    const h2Exclusions = page.locator('[data-testid="hypothesis-h2-exclusions"]');
    const h2ExText = await h2Exclusions.innerText();
    if (!h2ExText.includes("자연 유입(비광고) 제외: 24명") || !h2ExText.includes("비여행자 제외: 15명")) {
      throw new Error(`Card H2 exclusions text mismatch: ${h2ExText}`);
    }
    console.log("✓ Card H2 rendered correctly with exclusions breakdown");

    const cardH5 = page.locator('[data-testid="hypothesis-card-h5"]');
    await cardH5.waitFor({ state: "visible" });
    const h5Exclusions = page.locator('[data-testid="hypothesis-h5-exclusions"]');
    const h5ExText = await h5Exclusions.innerText();
    if (!h5ExText.includes("공공 화장실 길찾기 제외: 18건") || !h5ExText.includes("타 제휴 화장실 길찾기 제외: 4건")) {
      throw new Error(`Card H5 exclusions text mismatch: ${h5ExText}`);
    }
    console.log("✓ Card H5 rendered correctly with exclusions breakdown");

    // 3. Check Event Breakdown Table
    const breakdownTable = page.locator('[data-testid="pmf-event-breakdown-table"]');
    await breakdownTable.waitFor({ state: "visible" });
    console.log("✓ Event breakdown table rendered");

    await checkNoHorizontalOverflow("Step 3 Admin Dashboard");

    // Screenshot capture
    const screenshotPath = path.join(SCREENSHOT_DIR, "task19_pmf_dashboard_mobile.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`✓ Screenshot captured: ${screenshotPath}`);

    // =========================================================================
    // Step 4: 0건 데이터 처리 (Empty state)
    // =========================================================================
    console.log("\n>>> Step 4: Testing 0-event empty state handling...");
    emptyStateMock = true;

    const refreshBtn = page.locator('[data-testid="pmf-refresh-btn"]');
    await refreshBtn.click();
    await page.waitForTimeout(600);

    const emptyNotice = page.locator('[data-testid="pmf-empty-state"]');
    await emptyNotice.waitFor({ state: "visible", timeout: 5000 });
    const emptyText = await emptyNotice.innerText();
    if (!emptyText.includes("수집된 실험 데이터가 없습니다")) {
      throw new Error(`Empty state text mismatch: ${emptyText}`);
    }
    console.log("✓ 0-data empty state banner rendered gracefully");

    await checkNoHorizontalOverflow("Step 4 Empty State");

    console.log("\n=======================================================");
    console.log(" 🎉 TASK 19 MOBILE CHROME E2E VERIFICATION PASSED (100%)");
    console.log("=======================================================\n");
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (server) {
      killProcessTree(server.pid);
    }
  }
}

runTests().catch((err) => {
  console.error("\n❌ E2E Verification Failed:", err);
  process.exit(1);
});

