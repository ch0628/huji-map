/**
 * UI/UX 개선 1차(UI-01 ~ UI-08) 전후 비교 스크린샷 및 로컬 Chrome 검증 스크립트
 * Usage:
 *   node tests/e2e/verify_ui_ux_v1.mjs --mode=before
 *   node tests/e2e/verify_ui_ux_v1.mjs --mode=after
 */

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const modeArg = process.argv.find((a) => a.startsWith("--mode=")) || "--mode=after";
const MODE = modeArg.split("=")[1] === "before" ? "before" : "after";

const PORT = 3035;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const SCREENSHOT_DIR = path.resolve(
  `tests/e2e/screenshots/ui_ux_v1_${MODE}`
);

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
  console.log(`>>> Starting Next.js server on port ${PORT} (mode=${MODE})...`);
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
        console.log("✓ Next.js server ready at", BASE_URL);
        return server;
      }
    } catch {}
  }
  killProcessTree(server.pid);
  throw new Error("Server failed to start within 30s");
}

const mockPublicItem = {
  id: "a1111111-1111-4111-8111-111111111111",
  type: "public",
  name: "수원화성 장안문 공중화장실",
  road_address: "경기도 수원시 팔달구 정조로 900",
  address_detail: "매표소 옆",
  latitude: 37.2882,
  longitude: 127.0145,
  access_method: "open",
  gender_type: "separate",
  wheelchair_accessible: true,
  baby_changing_available: true,
  sanitary_products_available: false,
  last_verified_at: "2026-11-10T10:00:00Z",
  business_id: null,
};

const mockPartnerItem = {
  id: "b2222222-2222-4222-8222-222222222222",
  type: "partner",
  name: "행궁 안심제휴 카페 화장실",
  road_address: "수원시 팔달구 화서문로 42",
  address_detail: "1층",
  latitude: 37.2845,
  longitude: 127.0155,
  access_method: "pin",
  gender_type: "separate",
  wheelchair_accessible: true,
  baby_changing_available: true,
  sanitary_products_available: false,
  last_verified_at: "2026-11-10T10:00:00Z",
  business_id: "c3333333-3333-4333-8333-333333333333",
  business_name: "행궁 안심카페 본점",
  deposit_amount_krw: 1000,
  access_mode: "test_deposit",
};

async function run() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  let server = null;
  let browser = null;

  try {
    server = await startNextServer();
    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    });

    async function assertNoOverflow(page, label, maxWidth) {
      const dims = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      if (dims.scrollWidth > maxWidth) {
        throw new Error(`[${label}] Horizontal overflow: scrollWidth=${dims.scrollWidth} > ${maxWidth}`);
      }
      console.log(`  ✓ [${label}] width OK (${dims.scrollWidth} <= ${maxWidth})`);
    }

    // ------------------------------------------------------------------
    // 1. Mobile 360x740 & 390x844 & Desktop 1280x800 Map Bottom Sheet
    // ------------------------------------------------------------------
    for (const vp of [
      { name: "360", width: 360, height: 740, isMobile: true },
      { name: "390", width: 390, height: 844, isMobile: true },
      { name: "desktop", width: 1280, height: 800, isMobile: false },
    ]) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        isMobile: vp.isMobile,
        hasTouch: vp.isMobile,
      });
      const page = await context.newPage();

      await page.route("**/api/v1/restrooms?*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            data: { items: [mockPartnerItem, mockPublicItem], total: 2, limit: 100, offset: 0 },
          }),
        });
      });

      await page.goto(`${BASE_URL}/map`, { waitUntil: "networkidle" });
      const consentDecline = page.locator('[data-testid="consent-decline-btn"]');
      if (await consentDecline.isVisible().catch(() => false)) {
        await consentDecline.click();
        await page.locator('[data-testid="first-visit-consent-modal"]').waitFor({ state: "hidden" });
      }
      await page.click('[data-testid="bottom-sheet-toggle-btn"]');
      await page.waitForSelector(`[data-testid="public-restroom-card-${mockPartnerItem.id}"]`);

      if (vp.name === "360") {
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, "05_map_list_card_360.png") });
      }

      // Click partner card to open selected bottom sheet
      await page.click(`[data-testid="public-restroom-card-${mockPartnerItem.id}"]`);
      await page.waitForSelector('[data-testid="map-bottom-sheet-selected"]');
      await page.waitForSelector('[data-testid="bottom-sheet-close-btn"]');
      await page.waitForTimeout(250);

      const boxCheck = await page.evaluate(() => {
        const sheet = document.querySelector('[data-testid="map-bottom-sheet-selected"]');
        const btn = document.querySelector('[data-testid="bottom-sheet-close-btn"]');
        const sr = sheet.getBoundingClientRect();
        const br = btn.getBoundingClientRect();
        return {
          sheet: { top: sr.top, right: sr.right, left: sr.left, bottom: sr.bottom },
          btn: { top: br.top, right: br.right, left: br.left, bottom: br.bottom, width: br.width, height: br.height },
          clippedTop: br.top < sr.top,
          clippedRight: br.right > sr.right || br.right > window.innerWidth,
        };
      });
      console.log(`  [${vp.name}] close button rect check:`, JSON.stringify(boxCheck));

      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `01_map_selected_${vp.name}.png`) });
      await assertNoOverflow(page, `map-${vp.name}`, vp.width);

      if (MODE === "after") {
        if (boxCheck.clippedTop || boxCheck.clippedRight) {
          throw new Error(`[UI-01 ${vp.name}] Close button is clipped outside sheet/viewport: ${JSON.stringify(boxCheck)}`);
        }
        if (boxCheck.btn.width < 32 || boxCheck.btn.height < 32) {
          throw new Error(`[UI-01 ${vp.name}] Close button too small: ${boxCheck.btn.width}x${boxCheck.btn.height}`);
        }
        await page.click('[data-testid="bottom-sheet-close-btn"]');
        await page.waitForSelector('[data-testid="map-bottom-sheet-drawer"]');
        console.log(`  ✓ [UI-01 ${vp.name}] Close button visible & closes selected sheet`);
      }

      await context.close();
    }

    // ------------------------------------------------------------------
    // 2. Mobile 360x740 screens (Public detail, Partner detail, Modal, Merchant 401, Login, Payment success + PIN)
    // ------------------------------------------------------------------
    const mobileContext = await browser.newContext({
      viewport: { width: 360, height: 740 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await mobileContext.newPage();

    // 2.1 Public restroom detail (UI-02)
    await page.goto(`${BASE_URL}/restrooms/${mockPublicItem.id}`, { waitUntil: "networkidle" });
    const mobileConsentDecline = page.locator('[data-testid="consent-decline-btn"]');
    if (await mobileConsentDecline.isVisible().catch(() => false)) {
      await mobileConsentDecline.click();
      await page.locator('[data-testid="first-visit-consent-modal"]').waitFor({ state: "hidden" });
    }
    await page.waitForSelector('[data-testid="public-restroom-detail-view"]');
    await assertNoOverflow(page, "public-detail-360", 360);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "02_public_detail_360.png"), fullPage: true });
    if (MODE === "after") {
      const hasVerifiedLabel = await page.locator("text=정보 검증일").count();
      if (hasVerifiedLabel > 0) {
        throw new Error("[UI-02] '정보 검증일' text must not be visible on public detail");
      }
      console.log("  ✓ [UI-02] Public detail simplified and '정보 검증일' removed");
    }

    // 2.2 Merchant unauthenticated 401 (UI-03)
    await page.goto(`${BASE_URL}/merchant/businesses`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="merchant-unauthorized-401"]');
    await assertNoOverflow(page, "merchant-401-360", 360);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "03_merchant_401_360.png"), fullPage: true });
    if (MODE === "after") {
      const h1Text = await page.textContent('[data-testid="merchant-unauthorized-401"] h1');
      if (!h1Text?.includes("로그인이 필요합니다") || h1Text?.includes("401")) {
        throw new Error(`[UI-03] Unexpected heading: ${h1Text}`);
      }
      console.log("  ✓ [UI-03] Merchant 401 heading & concise notice verified");
    }

    // 2.3 Login screen with returnTo (UI-04)
    await page.goto(`${BASE_URL}/login?returnTo=%2Fmerchant%2Fbusinesses&reason=login_required`, {
      waitUntil: "networkidle",
    });
    await assertNoOverflow(page, "login-360", 360);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "04_login_360.png"), fullPage: true });
    if (MODE === "after") {
      const bodyText = await page.textContent("body");
      if (bodyText?.includes("공공 화장실 찾기와 길찾기는 로그인 없이")) {
        throw new Error("[UI-04] Redundant guidance text still present on /login");
      }
      console.log("  ✓ [UI-04] Login screen cleaned up");
    }

    // 2.4 Partner restroom detail & Deposit modal (UI-06 & UI-07)
    await mobileContext.addCookies([
      { name: "e2e_mock_customer", value: "1", domain: "127.0.0.1", path: "/" },
    ]);
    await page.goto(`${BASE_URL}/restrooms/${mockPartnerItem.id}`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="detail-directions-btn"]');
    await page.waitForSelector('[data-testid="detail-partner-payment-btn"]');
    await assertNoOverflow(page, "partner-detail-360", 360);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "06_partner_detail_360.png"), fullPage: true });

    if (MODE === "after") {
      const orderCheck = await page.evaluate(() => {
        const dir = document.querySelector('[data-testid="detail-directions-btn"]').getBoundingClientRect();
        const pay = document.querySelector('[data-testid="detail-partner-payment-btn"]').getBoundingClientRect();
        return {
          dirWidth: dir.width,
          payWidth: pay.width,
          payBelowDir: pay.top >= dir.bottom - 1,
          bodyHasLegacyBizSection: document.body.innerText.includes("제휴 매장 안내"),
        };
      });
      if (!orderCheck.payBelowDir || orderCheck.payWidth < 260) {
        throw new Error(`[UI-06] Directions/Payment button layout mismatch: ${JSON.stringify(orderCheck)}`);
      }
      if (orderCheck.bodyHasLegacyBizSection) {
        throw new Error("[UI-06] Legacy '제휴 매장 안내' section should be removed");
      }
      console.log("  ✓ [UI-06] Partner detail layout & full-width stacked buttons verified");
    }

    // Open Deposit Modal (UI-07)
    await page.click('[data-testid="detail-partner-payment-btn"]');
    await page.waitForSelector('[data-testid="submit-checkout-btn"]');
    await assertNoOverflow(page, "payment-modal-360", 360);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "07_payment_modal_360.png") });
    await page.click('[data-testid="cancel-checkout-btn"]');

    // 2.5 Payment Success + direct PIN reveal (UI-08)
    const mockOrderId = "hm_ord_ui_test_001";
    const mockSessionId = "11111111-1111-4111-8111-111111111111";
    await page.route("**/api/v1/payments/confirm", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            order: {
              id: "po-ui-1",
              order_id: mockOrderId,
              amount_krw: 1000,
              status: "approved",
              payment_mode: "test",
              provider: "toss",
              access_session_id: mockSessionId,
              user_id: "ff5e3efe-07bf-4f54-b60e-d9f5086ca231",
              approved_at: new Date().toISOString(),
              failure_code: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            accessSession: {
              id: mockSessionId,
              user_id: "ff5e3efe-07bf-4f54-b60e-d9f5086ca231",
              restroom_id: mockPartnerItem.id,
              policy_id: "mock-policy-1",
              status: "authorized",
              access_method_snapshot: "pin",
              authorized_at: new Date().toISOString(),
              code_revealed_at: null,
              expires_at: new Date(Date.now() + 86400000).toISOString(),
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            alreadyApproved: false,
          },
        }),
      });
    });

    await page.route(`**/api/v1/restrooms/${mockPartnerItem.id}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            id: mockPartnerItem.id,
            name: mockPartnerItem.name,
            road_address: mockPartnerItem.road_address,
            access_method: "pin",
            business: { name: "행궁 안심카페 본점" },
          },
        }),
      });
    });

    await page.route(`**/api/v1/access/${mockSessionId}/reveal-pin`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          pin: "4829*",
          codeVersion: 1,
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          requestId: "req-ui-pin-1",
        }),
      });
    });

    await page.goto(
      `${BASE_URL}/payment/success?paymentKey=pk_ui_test_1&orderId=${mockOrderId}&amount=1000`,
      { waitUntil: "networkidle" }
    );
    await page.waitForSelector('[data-testid="payment-confirmed-view"]');
    await assertNoOverflow(page, "payment-success-360", 360);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "08_payment_success_360.png"), fullPage: true });

    if (MODE === "after") {
      const titleText = await page.textContent('[data-testid="payment-confirmed-view"] h1');
      if (!titleText?.includes("결제가 완료됐어요")) {
        throw new Error(`[UI-08] Expected '결제가 완료됐어요', got: ${titleText}`);
      }
      // Verify PIN is NOT in DOM before clicking button
      const beforePin = await page.textContent("body");
      if (beforePin?.includes("4829*")) {
        throw new Error("[UI-08 SECURITY] PIN must NOT be present in DOM before reveal click!");
      }
      await page.click('[data-testid="reveal-pin-btn"]');
      await page.waitForSelector('[data-testid="revealed-pin-value"]');
      const pinVal = await page.textContent('[data-testid="revealed-pin-value"]');
      if (!pinVal?.includes("4829*")) {
        throw new Error(`[UI-08] Expected revealed PIN 4829*, got: ${pinVal}`);
      }
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "08b_payment_success_pin_revealed_360.png"), fullPage: true });
      console.log("  ✓ [UI-08] Direct PIN reveal from payment success verified cleanly");
    }

    await mobileContext.close();
    console.log(`\n✅ verify_ui_ux_v1 (${MODE}) completed successfully! Screenshots in ${SCREENSHOT_DIR}`);
  } finally {
    if (browser) await browser.close();
    if (server) killProcessTree(server.pid);
  }
}

run().catch((err) => {
  console.error("❌ verify_ui_ux_v1 failed:", err);
  process.exit(1);
});
