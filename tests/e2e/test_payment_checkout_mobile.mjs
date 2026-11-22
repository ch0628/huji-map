/**
 * TASK 22: Mobile Chrome (360x740) E2E Checkout Flow & Security Verification
 * Tests the complete mobile payment UI, partner vs public restrooms,
 * login requirement, checkout modal, success/fail pages, and 360px responsive layout.
 *
 * Scenarios:
 * 1. Public restroom has NO payment button (directions only).
 * 2. Unauthenticated user on partner restroom shows login modal with returnTo.
 * 3. Authenticated customer on partner restroom displays checkout modal, 1000 KRW deposit, terms agreement.
 * 4. Full payment checkout & success flow (10 steps):
 *    - Order creation (POST /api/v1/payments/orders)
 *    - Toss SDK V2 requestPayment() call with server amount { currency: "KRW", value: 1000 }
 *    - Auth redirect to /payment/success
 *    - Server confirmation (POST /api/v1/payments/confirm)
 *    - Confirmed view with authorized access session
 *    - DOM security check: no paymentKey or idempotencyKey leaked
 * 5. Confirm failure: failed view displayed, NO confirmed view.
 * 6. Uncertain state (504/409): uncertain view displayed, status recheck via GET /api/v1/payments/orders/:id recovers confirmed view.
 * 7. Duplicate confirm prevention: StrictMode / re-entry single execution.
 * 8. Missing / tampered parameters handling on /payment/success.
 * 9. User cancellation handling on /payment/fail.
 * 10. Card rejection & fail view order recheck.
 */

import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { chromium } from "playwright";

const PORT = 3022;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const SCREENSHOT_PATH = path.resolve("tests/e2e/screenshots/task22_payment_checkout_mobile.png");

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
    env: {
      ...process.env,
      PORT: String(PORT),
      ALLOW_E2E_MOCK: "1",
      NEXT_PUBLIC_TOSS_TEST_CLIENT_KEY: "test_ck_sample_valid_key",
    },
  });

  server.stdout.on("data", (d) => {
    const s = d.toString().trim();
    if (s.includes("Ready")) console.log("[server out]", s);
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
    // Step 1: 무료 공공 화장실 상세 화면 — 결제 버튼 일체 비노출
    // =========================================================================
    console.log("\n>>> Step 1: Public Restroom Detail — NO payment button verification...");
    await page.goto(`${BASE_URL}/restrooms/a1111111-1111-4111-8111-111111111111`, {
      waitUntil: "networkidle",
    });
    const consentDecline = page.locator('[data-testid="consent-decline-btn"]');
    if (await consentDecline.isVisible().catch(() => false)) {
      await consentDecline.click();
      await page.locator('[data-testid="first-visit-consent-modal"]').waitFor({ state: "hidden" });
    }
    await page.waitForSelector('[data-testid="detail-directions-btn"]');
    await checkNoHorizontalOverflow("Step 1 - Public Restroom Detail");

    const publicPaymentBtn = await page.$('[data-testid="detail-partner-payment-btn"]');
    if (publicPaymentBtn) {
      throw new Error("Security Violation: Payment button found on a public restroom!");
    }
    console.log("  ✓ Verified: Public restroom has directions button and NO payment button.");

    // =========================================================================
    // Step 2: 비로그인 제휴 화장실 상세 화면 — 결제 버튼 클릭 시 로그인 안내
    // =========================================================================
    console.log("\n>>> Step 2: Unauthenticated Partner Restroom — Login Dialog...");
    await page.goto(`${BASE_URL}/restrooms/b2222222-2222-4222-8222-222222222222`);
    await page.waitForSelector('[data-testid="detail-partner-payment-btn"]');
    await checkNoHorizontalOverflow("Step 2 - Partner Restroom Detail (Guest)");

    // Click payment button as guest
    await page.click('[data-testid="detail-partner-payment-btn"]');
    await page.waitForSelector('[data-testid="payment-login-redirect-btn"]');
    console.log("  ✓ Verified: Guest clicking payment button displays login requirement modal.");

    // Close guest modal
    await page.click('[data-testid="payment-modal-close-btn"]');

    // =========================================================================
    // Step 3: 로그인(Customer) 제휴 화장실 — 보증금 결제 모달 검증
    // =========================================================================
    console.log("\n>>> Step 3: Authenticated Customer — Checkout Modal & Terms...");
    await context.addCookies([
      { name: "e2e_mock_customer", value: "1", domain: "127.0.0.1", path: "/" },
    ]);
    await page.reload();
    await page.waitForSelector('[data-testid="detail-partner-payment-btn"]');

    // Open checkout modal
    await page.click('[data-testid="detail-partner-payment-btn"]');
    await page.waitForSelector('[data-testid="submit-checkout-btn"]');
    await checkNoHorizontalOverflow("Step 3 - Checkout Modal");

    // Check test payment warning and deposit amount
    const modalContent = await page.textContent('[data-testid="deposit-amount-display"]');
    if (!modalContent.includes("1,000")) {
      throw new Error(`Expected 1,000 KRW deposit amount, got: ${modalContent}`);
    }

    const submitDisabledBefore = await page.$eval(
      '[data-testid="submit-checkout-btn"]',
      (el) => el.disabled
    );
    if (!submitDisabledBefore) {
      throw new Error("Submit button should be disabled before terms agreement!");
    }

    // Check terms agreement checkbox
    await page.click('[data-testid="deposit-agreement-checkbox"]');
    const submitDisabledAfter = await page.$eval(
      '[data-testid="submit-checkout-btn"]',
      (el) => el.disabled
    );
    if (submitDisabledAfter) {
      throw new Error("Submit button should be enabled after terms agreement!");
    }
    console.log("  ✓ Verified: Modal displays 1,000 KRW test deposit, terms checkbox required.");

    // Close checkout modal
    await page.click('[data-testid="cancel-checkout-btn"]');

    // =========================================================================
    // Step 4: 전체 결제 성공 흐름 E2E 검증 (10단계 전체 프로세스)
    // =========================================================================
    console.log("\n>>> Step 4: Full Payment Checkout & Success Flow (10 Steps)...");

    const TEST_ORDER_ID = `hm_ord_e2e_live_${Date.now()}`;
    const TEST_AMOUNT = 1000;
    let orderApiPayload = null;
    let confirmApiPayload = null;

    // 4.1 Mock window.TossPayments before navigation to intercept SDK V2 calls
    await page.addInitScript(() => {
      window.TossPayments = (clientKey) => {
        return {
          payment: ({ customerKey }) => ({
            requestPayment: async (params) => {
              const sdkData = { clientKey, customerKey, params };
              window.__e2e_sdk_params = sdkData;
              try {
                window.sessionStorage.setItem("__e2e_sdk_params", JSON.stringify(sdkData));
              } catch {}
              // Simulate Toss SDK redirection to successUrl with query params
              const target = new URL(params.successUrl);
              target.searchParams.set("paymentKey", "toss_pk_live_mock_secret_key_val");
              target.searchParams.set("orderId", params.orderId);
              target.searchParams.set("amount", String(params.amount.value));
              window.location.href = target.toString();
            },
          }),
        };
      };
    });

    // 4.2 Route POST /api/v1/payments/orders
    await page.route("**/api/v1/payments/orders", async (route) => {
      const req = route.request();
      if (req.method() === "POST") {
        orderApiPayload = req.postDataJSON();
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            data: {
              orderId: TEST_ORDER_ID,
              amount: TEST_AMOUNT,
              clientKey: "test_ck_sample_valid_key",
              paymentMode: "test",
            },
          }),
        });
      } else {
        await route.continue();
      }
    });

    // 4.3 Route POST /api/v1/payments/confirm
    await page.route("**/api/v1/payments/confirm", async (route) => {
      const req = route.request();
      if (req.method() === "POST") {
        confirmApiPayload = req.postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            data: {
              order: {
                id: "po_e2e_test_uuid",
                order_id: TEST_ORDER_ID,
                amount_krw: TEST_AMOUNT,
                status: "approved",
                payment_mode: "test",
                access_session_id: "as_e2e_test_uuid",
                approved_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
              accessSession: {
                id: "as_e2e_test_uuid",
                restroom_id: "b2222222-2222-4222-8222-222222222222",
                status: "authorized",
                access_method_snapshot: "pin",
                authorized_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 86400000).toISOString(),
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
            },
          }),
        });
      } else {
        await route.continue();
      }
    });

    // 4.4 Start checkout from partner restroom
    await page.goto(`${BASE_URL}/restrooms/b2222222-2222-4222-8222-222222222222`);
    await page.waitForSelector('[data-testid="detail-partner-payment-btn"]');
    await page.click('[data-testid="detail-partner-payment-btn"]');
    await page.waitForSelector('[data-testid="deposit-agreement-checkbox"]');

    // 4.5 Agree to terms and submit payment
    await page.click('[data-testid="deposit-agreement-checkbox"]');
    await page.click('[data-testid="submit-checkout-btn"]');

    // 4.6 Wait for arrival at /payment/success and confirmed view
    await page.waitForSelector('[data-testid="payment-confirmed-view"]', { timeout: 10000 });
    await checkNoHorizontalOverflow("Step 4 - Payment Confirmed View");

    // 4.7 Verify order creation API contract & customerKey format
    const sdkParams = await page.evaluate(() => {
      if (window.__e2e_sdk_params) return window.__e2e_sdk_params;
      try {
        const raw = window.sessionStorage.getItem("__e2e_sdk_params");
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    });
    if (!sdkParams || !sdkParams.customerKey) {
      throw new Error("SDK params or customerKey missing!");
    }
    const TOSS_CUSTOMER_KEY_REGEX = /^(?=.{22,255}$)(?=.*[-_=.@])[A-Za-z0-9\-_=.@]+$/;
    if (!TOSS_CUSTOMER_KEY_REGEX.test(sdkParams.customerKey)) {
      throw new Error(`customerKey failed regex check: ${sdkParams.customerKey}`);
    }
    console.log("  ✓ (4.1) Verified customerKey format conforms to SDK V2 contract:", sdkParams.customerKey);

    if (!orderApiPayload || !orderApiPayload.restroomId || !orderApiPayload.idempotencyKey) {
      throw new Error(`Invalid order API payload: ${JSON.stringify(orderApiPayload)}`);
    }
    console.log("  ✓ (4.2) POST /api/v1/payments/orders payload verified with idempotencyKey.");

    // 4.8 Verify confirm API contract
    if (
      !confirmApiPayload ||
      confirmApiPayload.orderId !== TEST_ORDER_ID ||
      confirmApiPayload.amount !== TEST_AMOUNT
    ) {
      throw new Error(`Invalid confirm API payload: ${JSON.stringify(confirmApiPayload)}`);
    }
    console.log("  ✓ (4.3) POST /api/v1/payments/confirm payload verified with server orderId & amount.");

    // 4.9 Verify success UI elements
    const confirmedOrderIdText = await page.textContent('[data-testid="confirmed-order-id"]');
    if (!confirmedOrderIdText.includes(TEST_ORDER_ID)) {
      throw new Error(`Expected confirmed order id ${TEST_ORDER_ID}, got: ${confirmedOrderIdText}`);
    }

    const confirmedSessionStatus = await page.textContent('[data-testid="confirmed-session-status"]');
    if (!confirmedSessionStatus.includes("이용권 활성화")) {
      throw new Error(`Expected authorized session status, got: ${confirmedSessionStatus}`);
    }
    console.log("  ✓ (4.4) Success view renders approved order and authorized access session.");

    // 4.10 Security verification: no paymentKey or idempotencyKey on visible screen, and URL sanitized
    const visibleText = await page.innerText("body");
    if (visibleText.includes("toss_pk_live_mock_secret_key_val")) {
      throw new Error("Security Violation: provider_payment_key leaked in visible screen text!");
    }
    if (visibleText.includes(orderApiPayload.idempotencyKey)) {
      throw new Error("Security Violation: internal idempotencyKey leaked in visible screen text!");
    }
    const currentUrlSearch = await page.evaluate(() => window.location.search);
    if (currentUrlSearch.includes("paymentKey")) {
      throw new Error("Security Violation: paymentKey still present in browser URL bar after confirmation!");
    }
    console.log("  ✓ (4.5) Security check: provider_payment_key and idempotencyKey NOT displayed on screen; URL sanitized.");

    // Save screenshot of successful confirmation view
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    console.log("  ✓ (4.6) Mobile screenshot saved to:", SCREENSHOT_PATH);

    // =========================================================================
    // Step 5: confirm API 실패 시 성공 화면 미표시 검증
    // =========================================================================
    console.log("\n>>> Step 5: Confirm API Failure Scenario...");
    await page.route("**/api/v1/payments/confirm", async (route) => {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: {
            code: "REJECT_CARD_COMPANY",
            message: "카드사 한도 초과로 승인이 거절되었습니다.",
          },
        }),
      });
    });

    await page.goto(
      `${BASE_URL}/payment/success?paymentKey=pk_fail_scenario&orderId=hm_ord_fail_scenario&amount=1000`
    );
    await page.waitForSelector('[data-testid="payment-failed-view"]');
    await checkNoHorizontalOverflow("Step 5 - Confirm Failed View");

    const confirmedViewPresent = await page.$('[data-testid="payment-confirmed-view"]');
    if (confirmedViewPresent) {
      throw new Error("Security Violation: confirmed view rendered despite confirm failure!");
    }
    const failedContent = await page.textContent('[data-testid="payment-failed-view"]');
    if (!failedContent.includes("카드사 한도 초과")) {
      throw new Error(`Expected rejection message, got: ${failedContent}`);
    }

    const failedUrlSearch = await page.evaluate(() => window.location.search);
    if (failedUrlSearch.includes("paymentKey")) {
      throw new Error("Security Violation: paymentKey still present in browser URL bar on confirm failure!");
    }
    console.log("  ✓ (5.1) Verified: Confirm failure renders failed view and NEVER confirmed view.");
    console.log("  ✓ (5.2) Verified: paymentKey sanitized from URL bar on confirm failure.");

    // =========================================================================
    // Step 6: 504/409 불확실 상태 및 재조회(/orders/:id) 정상 복구 검증
    // =========================================================================
    console.log("\n>>> Step 6: Uncertain State (504 Timeout) & Recheck Recovery...");
    let recheckedOrderId = null;

    await page.route("**/api/v1/payments/confirm", async (route) => {
      await route.fulfill({
        status: 504,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: {
            code: "PAYMENT_PROCESSING",
            message: "카드사 응답 시간 초과로 승인 상태가 불확실합니다.",
          },
        }),
      });
    });

    await page.goto(
      `${BASE_URL}/payment/success?paymentKey=pk_uncertain_1&orderId=hm_ord_uncertain_1&amount=1000`
    );
    await page.waitForSelector('[data-testid="payment-uncertain-view"]');
    await checkNoHorizontalOverflow("Step 6 - Uncertain View");

    const uncertainConfirmedCheck = await page.$('[data-testid="payment-confirmed-view"]');
    if (uncertainConfirmedCheck) {
      throw new Error("Violation: confirmed view rendered during uncertain 504 state!");
    }

    const uncertainUrlSearch = await page.evaluate(() => window.location.search);
    if (uncertainUrlSearch.includes("paymentKey")) {
      throw new Error("Security Violation: paymentKey still present in browser URL bar on uncertain state!");
    }
    console.log("  ✓ (6.1) 504 timeout renders uncertain view, NOT confirmed view.");
    console.log("  ✓ (6.2) Verified: paymentKey sanitized from URL bar on uncertain 504 state.");

    // Route GET /api/v1/payments/orders/:id for reconciliation
    await page.route("**/api/v1/payments/orders/*", async (route) => {
      const req = route.request();
      if (req.method() === "GET") {
        const url = new URL(req.url());
        const segments = url.pathname.split("/");
        recheckedOrderId = segments[segments.length - 1];

        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            data: {
              order: {
                id: "po_rechecked_1",
                order_id: "hm_ord_uncertain_1",
                amount_krw: 1000,
                status: "approved",
                payment_mode: "test",
                access_session_id: "as_rechecked_1",
                approved_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
              accessSession: {
                id: "as_rechecked_1",
                restroom_id: "b2222222-2222-4222-8222-222222222222",
                status: "authorized",
                access_method_snapshot: "pin",
                authorized_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 86400000).toISOString(),
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
            },
          }),
        });
      } else {
        await route.continue();
      }
    });

    // Click recheck button
    await page.click('[data-testid="recheck-status-btn"]');
    await page.waitForSelector('[data-testid="payment-confirmed-view"]');

    if (recheckedOrderId !== "hm_ord_uncertain_1") {
      throw new Error(`Expected rechecked order id 'hm_ord_uncertain_1', got: ${recheckedOrderId}`);
    }
    console.log("  ✓ (6.2) Status recheck invoked GET /api/v1/payments/orders/:id and recovered confirmed view.");

    // =========================================================================
    // Step 7: 중복 승인 방지 (StrictMode / 재진입 시 1회만 confirm)
    // =========================================================================
    console.log("\n>>> Step 7: Single Execution / Duplicate Confirm Prevention...");
    let confirmCallCount = 0;

    await page.route("**/api/v1/payments/confirm", async (route) => {
      confirmCallCount++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            order: {
              order_id: "hm_ord_single_exec",
              amount_krw: 1000,
              status: "approved",
            },
            accessSession: {
              restroom_id: "b2222222-2222-4222-8222-222222222222",
              status: "authorized",
              expires_at: new Date(Date.now() + 86400000).toISOString(),
            },
          },
        }),
      });
    });

    await page.goto(
      `${BASE_URL}/payment/success?paymentKey=pk_single&orderId=hm_ord_single_exec&amount=1000`
    );
    await page.waitForSelector('[data-testid="payment-confirmed-view"]');

    if (confirmCallCount !== 1) {
      throw new Error(`Expected exactly 1 confirm API call, got: ${confirmCallCount}`);
    }
    console.log("  ✓ Verified: StrictMode / page mount triggers exactly 1 confirm request.");

    // =========================================================================
    // Step 8: /payment/success — 결제 실패 상태 (파라미터 누락 / 위변조)
    // =========================================================================
    console.log("\n>>> Step 8: /payment/success — Missing or tampered parameters...");
    await page.goto(`${BASE_URL}/payment/success`);
    await page.waitForSelector('[data-testid="payment-failed-view"]');
    await checkNoHorizontalOverflow("Step 8 - Success Missing Params View");
    console.log("  ✓ (8.1) Verified: /payment/success without valid params displays payment failure view.");

    // Also verify tampered parameters (invalid amount) sanitizes paymentKey
    await page.goto(
      `${BASE_URL}/payment/success?paymentKey=pk_tampered_test&orderId=hm_ord_tampered&amount=-1000`
    );
    await page.waitForSelector('[data-testid="payment-failed-view"]');
    const tamperedUrlSearch = await page.evaluate(() => window.location.search);
    if (tamperedUrlSearch.includes("paymentKey")) {
      throw new Error("Security Violation: paymentKey still exposed in URL bar on tampered parameters!");
    }
    console.log("  ✓ (8.2) Verified: paymentKey sanitized from URL bar on tampered parameters.");

    // =========================================================================
    // Step 9: /payment/fail — 사용자 결제 취소 화면
    // =========================================================================
    console.log("\n>>> Step 9: /payment/fail — User Cancellation Flow...");
    await page.goto(
      `${BASE_URL}/payment/fail?code=PAY_PROCESS_CANCELED&message=${encodeURIComponent(
        "사용자가 결제를 취소했습니다."
      )}&orderId=hm_ord_e2e_cancel`
    );
    await page.waitForSelector('[data-testid="payment-fail-client"]');
    await checkNoHorizontalOverflow("Step 9 - Fail User Cancel View");

    const failTitle = await page.textContent('[data-testid="fail-title"]');
    if (!failTitle.includes("결제가 취소되었습니다")) {
      throw new Error(`Expected cancellation title, got: ${failTitle}`);
    }
    const failCode = await page.textContent('[data-testid="fail-code"]');
    if (!failCode.includes("PAY_PROCESS_CANCELED")) {
      throw new Error(`Expected cancel code, got: ${failCode}`);
    }
    console.log("  ✓ Verified: User cancellation correctly identified and explained.");

    // =========================================================================
    // Step 10: /payment/fail — 시스템/카드사 거절 및 주문 상태 재조회 버튼
    // =========================================================================
    console.log("\n>>> Step 10: /payment/fail — System Error & Recheck...");
    await page.goto(
      `${BASE_URL}/payment/fail?code=REJECT_CARD_COMPANY&message=${encodeURIComponent(
        "카드 한도 초과 또는 잔액 부족"
      )}&orderId=hm_ord_e2e_reject`
    );
    await page.waitForSelector('[data-testid="recheck-order-btn"]');
    await checkNoHorizontalOverflow("Step 10 - Fail Recheck View");
    console.log("  ✓ Verified: Card rejection handled with recheck button.");

    console.log("\n=======================================================");
    console.log("🎉 ALL 10 MOBILE E2E PAYMENT SCENARIOS PASSED (100%)");
    console.log("=======================================================");
  } finally {
    if (browser) await browser.close();
    if (server) killProcessTree(server.pid);
  }
}

runTests().catch((err) => {
  console.error("\n❌ E2E Test Failed:", err);
  process.exit(1);
});
