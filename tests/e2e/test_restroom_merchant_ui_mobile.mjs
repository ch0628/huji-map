/**
 * TASK 13: Mobile Chrome (360x740) E2E User Flow Verification
 * Tests the merchant restroom list, new registration, detail & editing,
 * policy versioning, published location locking, and review submission flows.
 */

import { spawn, execSync } from "node:child_process";
import { chromium } from "playwright";

const PORT = 3014;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const GLOBAL_TIMEOUT_MS = 60000;

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
      } else {
        console.log(`[probe attempt ${i}] unexpected status:`, res.status);
      }
    } catch (e) {
      if (i % 10 === 0) console.log(`[probe attempt ${i}]`, e?.message || e);
    }
  }
  killProcessTree(server.pid);
  throw new Error("Failed to start Next.js server within 30s");
}

async function runTests() {
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
    // Step 1: 비로그인 접근 차단 검증 (401 Unauthorized UI)
    // =========================================================================
    console.log("\n>>> Step 1: Guest (Unauthenticated) Access Protection...");
    await page.goto(`${BASE_URL}/merchant/restrooms`);
    await page.waitForSelector('[data-testid="merchant-unauthorized-401"]');
    await checkNoHorizontalOverflow("Step 1 - Guest 401");
    console.log("  ✓ Guest blocked with 401 UI and returnTo login link.");

    // =========================================================================
    // Step 2: 점주 권한 없는 일반 회원 접근 차단 (403 Forbidden UI)
    // =========================================================================
    console.log("\n>>> Step 2: Customer without Merchant Role Access Protection...");
    await context.addCookies([
      { name: "e2e_mock_customer", value: "1", domain: "127.0.0.1", path: "/" },
    ]);
    await page.goto(`${BASE_URL}/merchant/restrooms`);
    await page.waitForSelector('[data-testid="merchant-restroom-forbidden-403"]');
    await checkNoHorizontalOverflow("Step 2 - Customer 403");
    console.log("  ✓ Customer without merchant role blocked with 403 Forbidden UI.");

    // Clear customer cookie and set merchant mock cookie
    await context.clearCookies();
    await context.addCookies([
      { name: "e2e_mock_merchant", value: "1", domain: "127.0.0.1", path: "/" },
    ]);

    // Mock Business & Restroom Data Store
    const mockBusiness = {
      id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      name: "수원역 카페 휴지",
      category: "카페",
      registration_status: "approved",
      road_address: "경기도 수원시 팔달구 매산로 1",
      created_at: new Date().toISOString(),
    };

    let mockRestroom = {
      id: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380b22",
      business_id: mockBusiness.id,
      name: "1층 고객용 화장실",
      description: "매장 이용 고객 전용 화장실입니다.",
      road_address: "경기도 수원시 팔달구 매산로 1",
      address_detail: "101호 뒤편 복도",
      latitude: 37.2636,
      longitude: 127.0286,
      floor: "1층",
      entrance_instructions: "카운터 우측 복도 끝",
      gender_type: "separate",
      wheelchair_accessible: true,
      baby_changing_available: false,
      sanitary_products_available: true,
      access_method: "ask_staff",
      publication_status: "draft",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      policies: [
        {
          id: "policy-1111-2222-3333-4444",
          restroom_id: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380b22",
          version: 1,
          access_mode: "test_deposit",
          deposit_amount_krw: 1000,
          refund_eligible: true,
          receipt_window_hours: 24,
          min_purchase_krw: 0,
          is_active: true,
          effective_from: new Date().toISOString(),
          created_at: new Date().toISOString(),
        },
      ],
      hours: [],
      photos: [],
    };

    // Route interceptor for API calls
    await page.route("**/api/v1/merchant/businesses", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, businesses: [mockBusiness] }),
      });
    });

    await page.route(`**/api/v1/merchant/businesses/${mockBusiness.id}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          business: {
            ...mockBusiness,
            address_detail: "1층 전체",
            latitude: 37.2636,
            longitude: 127.0286,
          },
        }),
      });
    });

    await page.route("**/api/v1/merchant/restrooms?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: [mockRestroom],
          count: 1,
        }),
      });
    });

    await page.route("**/api/v1/merchant/restrooms", async (route) => {
      if (route.request().method() === "POST") {
        const postData = JSON.parse(route.request().postData() || "{}");
        const idempotencyKey = route.request().headers()["x-idempotency-key"];
        if (!idempotencyKey) {
          return route.fulfill({ status: 400, body: JSON.stringify({ ok: false, error: { message: "Missing idempotency key" } }) });
        }
        mockRestroom = {
          ...mockRestroom,
          ...postData,
          publication_status: "draft",
        };
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, data: mockRestroom }),
        });
      }
      return route.fallback();
    });

    await page.route("**/api/v1/merchant/restrooms/**", async (route) => {
      const url = route.request().url();
      const method = route.request().method();

      if (url.includes("/submit") && method === "POST") {
        mockRestroom.publication_status = "pending";
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, data: mockRestroom }),
        });
      }

      if (url.includes("/policies") && method === "POST") {
        const postData = JSON.parse(route.request().postData() || "{}");
        const newPolicy = {
          id: "policy-2",
          restroom_id: mockRestroom.id,
          version: 2,
          access_mode: postData.policy_mode === "free_with_ad" ? "free" : "test_deposit",
          deposit_amount_krw: postData.policy_mode === "free_with_ad" ? 0 : 1000,
          refund_eligible: postData.policy_mode !== "free_with_ad",
          receipt_window_hours: 24,
          min_purchase_krw: 0,
          is_active: true,
          effective_from: new Date().toISOString(),
          created_at: new Date().toISOString(),
        };
        mockRestroom.policies = [
          newPolicy,
          ...mockRestroom.policies.map((p) => ({ ...p, is_active: false })),
        ];
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, data: newPolicy }),
        });
      }

      if (method === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, data: mockRestroom }),
        });
      }

      if (method === "PATCH") {
        const patchData = JSON.parse(route.request().postData() || "{}");
        mockRestroom = { ...mockRestroom, ...patchData };
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, data: mockRestroom }),
        });
      }

      return route.fallback();
    });

    // =========================================================================
    // Step 3: 점주 화장실 목록 화면 렌더링 및 360px 확인
    // =========================================================================
    console.log("\n>>> Step 3: Merchant Restrooms List Page...");
    await page.goto(`${BASE_URL}/merchant/restrooms`);
    await page.waitForSelector('[data-testid="restrooms-list-container"]');
    await page.waitForSelector(`[data-testid="restroom-card-${mockRestroom.id}"]`);
    await checkNoHorizontalOverflow("Step 3 - Restrooms List");
    console.log("  ✓ Restrooms list displayed with restroom card and 360px layout.");

    // =========================================================================
    // Step 4: 신규 화장실 등록 화면 및 폼 제출 검증
    // =========================================================================
    console.log("\n>>> Step 4: New Restroom Registration Flow...");
    await page.click('[data-testid="new-restroom-button"]');
    await page.waitForSelector('[data-testid="merchant-restroom-form"]');
    await checkNoHorizontalOverflow("Step 4 - New Restroom Form");

    // Fill form (address/coords pre-filled automatically from approved business)
    await page.waitForFunction(() => {
      const addr = document.querySelector("#restroom-road-address");
      return Boolean(addr && addr.value && addr.value.includes("수원시"));
    });
    await page.fill("#restroom-name", "신규 등록 화장실");
    await page.fill("#restroom-floor", "2층");

    await page.click('[data-testid="restroom-form-submit-button"]');
    await page.waitForURL(`**/merchant/restrooms/${mockRestroom.id}`, {
      timeout: 15000,
      waitUntil: "domcontentloaded",
    });
    console.log("  ✓ Form submitted and navigated to detail page.");

    // =========================================================================
    // Step 5: 화장실 상세, 정책 관리, 심사 요청 흐름 검증
    // =========================================================================
    console.log("\n>>> Step 5: Restroom Detail, Policy Manager & Review Submission...");
    await page.waitForSelector('[data-testid="restroom-detail-container"]');
    await page.waitForSelector('[data-testid="restroom-status-badge"]');
    await checkNoHorizontalOverflow("Step 5 - Restroom Detail");

    // 1. Check Policy Manager (collapsed by default in UI-15)
    await page.click('[data-testid="toggle-manage-policy-btn"]');
    await page.waitForSelector('[data-testid="restroom-policy-manager"]');
    console.log("  ✓ Policy manager opened and visible.");

    // Change policy to free mode
    await page.click('input[name="change_policy_mode"][value="free_with_ad"]');
    await page.click('[data-testid="create-policy-button"]');
    await page.waitForSelector('[data-testid="policy-manager-success"]');
    console.log("  ✓ Policy version changed successfully to free mode.");

    // 2. Submit Review (draft -> pending)
    await page.waitForSelector('[data-testid="submit-restroom-review-button"]');
    await page.click('[data-testid="submit-restroom-review-button"]');
    await page.waitForSelector('[data-testid="restroom-submit-success"]');
    console.log("  ✓ Review requested: draft -> pending successfully.");

    // =========================================================================
    // Step 6: 공개된 화장실 위치 수정 잠금 검증
    // =========================================================================
    console.log("\n>>> Step 6: Published Restroom Location Locking Check...");
    mockRestroom.publication_status = "published";
    await page.reload();
    await page.click('[data-testid="toggle-manage-edit-btn"]');
    await page.waitForSelector('[data-testid="restroom-location-locked-alert"]');
    await checkNoHorizontalOverflow("Step 6 - Published Locked Alert");

    const isRoadAddrDisabled = await page.isDisabled("#restroom-road-address");
    const searchInputWhenLocked = await page.$('[data-testid="address-search-input"]');

    if (!isRoadAddrDisabled || searchInputWhenLocked !== null) {
      throw new Error("Published restroom location fields must be disabled and address search hidden!");
    }
    console.log("  ✓ Published restroom location fields (road_address) locked and address search hidden.");

    console.log("\n============================================================");
    console.log("✓ ALL TASK 13 MOBILE CHROME E2E TESTS PASSED (100%)");
    console.log("============================================================\n");
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
    if (server && server.pid) {
      killProcessTree(server.pid);
    }
  }
}

const timer = setTimeout(() => {
  console.error(`\n❌ Global E2E timeout exceeded (${GLOBAL_TIMEOUT_MS / 1000}s)! Force exiting.`);
  process.exit(1);
}, GLOBAL_TIMEOUT_MS);
timer.unref();

runTests()
  .then(() => {
    clearTimeout(timer);
    console.log("✓ E2E process finished and cleanly exiting.");
    process.exit(0);
  })
  .catch((err) => {
    clearTimeout(timer);
    console.error("\n❌ E2E Test Failed:", err);
    process.exit(1);
  });
