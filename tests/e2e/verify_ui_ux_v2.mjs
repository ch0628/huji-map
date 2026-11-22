/**
 * UI/UX 개선 2차(UI-09 ~ UI-16) 전후 비교 스크린샷 및 로컬 Chrome 검증 스크립트
 * Usage:
 *   node tests/e2e/verify_ui_ux_v2.mjs --mode=before
 *   node tests/e2e/verify_ui_ux_v2.mjs --mode=after
 */

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const modeArg = process.argv.find((a) => a.startsWith("--mode=")) || "--mode=after";
const MODE = modeArg.split("=")[1] === "before" ? "before" : "after";

const PORT = 3036;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const SCREENSHOT_DIR = path.resolve(`tests/e2e/screenshots/ui_ux_v2_${MODE}`);

// Synthetic 1x1 PNG data URL (zero real customer receipts or PII)
const DEMO_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAADklEQVR4nGP4jw9jYKAQAAD//xL7A2YAAAAASUVORK5CYII=";

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

async function assertNoOverflow(page, label, maxW) {
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  if (sw > maxW) {
    throw new Error(`[${label}] Horizontal overflow: scrollWidth=${sw} > ${maxW}`);
  }
  console.log(`  ✓ [${label}] width OK (${sw} <= ${maxW})`);
}

const mockPartnerItem = {
  id: "b2222222-2222-4222-8222-222222222222",
  type: "partner",
  name: "DEMO/TEST 행궁 안심제휴 카페 화장실",
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
  business_name: "DEMO/TEST 행궁 안심카페",
  deposit_amount_krw: 1000,
  access_mode: "test_deposit",
  distance_meters: 120,
};

async function run() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  let server = null;
  let browser = null;

  try {
    server = await startNextServer();
    browser = await chromium.launch({
      executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
      headless: true,
      args: ["--no-sandbox", "--disable-gpu"],
    });

    // =========================================================================
    // 1. UI-09: Map bottom card (360px / 390px / 1280px)
    // =========================================================================
    for (const vp of [
      { name: "360", w: 360, h: 740 },
      { name: "390", w: 390, h: 844 },
      { name: "desktop", w: 1280, h: 800 },
    ]) {
      const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
      const page = await ctx.newPage();
      await page.route("**/api/v1/restrooms?*", async (route) => {
        const url = route.request().url();
        if (url.includes("/search")) return route.continue();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            data: { items: [mockPartnerItem], total: 1, limit: 100, offset: 0 },
          }),
        });
      });

      await page.goto(`${BASE_URL}/map`, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-testid="bottom-sheet-toggle-btn"]');
      await page.click('[data-testid="bottom-sheet-toggle-btn"]');
      await page.waitForSelector(`[data-testid="public-restroom-card-${mockPartnerItem.id}"]`);
      await page.click(`[data-testid="public-restroom-card-${mockPartnerItem.id}"]`);
      await page.waitForSelector('[data-testid="bottom-sheet-close-btn"]');

      const sheetCheck = await page.evaluate(() => {
        const sheet = document.querySelector('[data-testid="map-bottom-sheet-selected"]');
        const btns = document.querySelectorAll('[data-testid="bottom-sheet-close-btn"]');
        const sheetRect = sheet.getBoundingClientRect();
        const btnRect = btns[0].getBoundingClientRect();
        return {
          closeCount: btns.length,
          hasLegacyHeader: sheet.textContent?.includes("선택한 화장실") ?? false,
          btnInsideSheet:
            btnRect.top >= sheetRect.top - 1 &&
            btnRect.right <= sheetRect.right + 1 &&
            btnRect.left >= sheetRect.left,
          btnW: btnRect.width,
          btnH: btnRect.height,
        };
      });

      await assertNoOverflow(page, `map-${vp.name}`, vp.w);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `01_map_selected_${vp.name}.png`) });

      if (MODE === "after") {
        if (sheetCheck.closeCount !== 1 || sheetCheck.hasLegacyHeader || !sheetCheck.btnInsideSheet) {
          throw new Error(`[UI-09 ${vp.name}] Invalid close button / header: ${JSON.stringify(sheetCheck)}`);
        }
        console.log(`  ✓ [UI-09 ${vp.name}] Single compact X button, no '선택한 화장실' header`);
      }
      await ctx.close();
    }

    // =========================================================================
    // 2. Customer context (360px): UI-11 Receipts + UI-12 Access Detail (PIN & Ask Staff)
    // =========================================================================
    const custCtx = await browser.newContext({ viewport: { width: 360, height: 740 } });
    await custCtx.addCookies([
      { name: "e2e_mock_customer", value: "1", domain: "127.0.0.1", path: "/" },
    ]);
    const custPage = await custCtx.newPage();

    const sessPinId = "11111111-1111-4111-8111-111111111111";
    const sessStaffId = "22222222-2222-4222-8222-222222222222";
    const receiptId = "33333333-3333-4333-8333-333333333333";

    await custPage.route(`**/my/access/${sessPinId}/data`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            detail: {
              session: {
                id: sessPinId,
                user_id: "usr-cust-1",
                restroom_id: mockPartnerItem.id,
                policy_id: "pol-1",
                status: "authorized",
                access_method_snapshot: "pin",
                authorized_at: "2026-11-21T10:00:00Z",
                code_revealed_at: "2026-11-21T10:05:00Z",
                expires_at: "2099-01-01T00:00:00Z",
                created_at: "2026-11-21T10:00:00Z",
                updated_at: "2026-11-21T10:05:00Z",
              },
              effectiveStatus: "authorized",
              restroom: {
                id: mockPartnerItem.id,
                name: mockPartnerItem.name,
                road_address: mockPartnerItem.road_address,
                address_detail: "1층",
                floor: "1F",
                entrance_instructions: "카운터 왼쪽 복도 끝",
                access_method: "pin",
                publication_status: "published",
                business_id: mockPartnerItem.business_id,
                business_name: mockPartnerItem.business_name,
                business_category: "카페",
                business_phone: "031-000-0000",
              },
              order: {
                id: "ord-1",
                access_session_id: sessPinId,
                user_id: "usr-cust-1",
                order_id: "hm_ord_secret_internal_001",
                provider: "toss",
                payment_mode: "test",
                amount_krw: 1000,
                status: "approved",
                approved_at: "2026-11-21T10:00:00Z",
                failure_code: null,
                created_at: "2026-11-21T10:00:00Z",
                updated_at: "2026-11-21T10:00:00Z",
              },
              policy: {
                id: "pol-1",
                version: 1,
                access_mode: "test_deposit",
                deposit_amount_krw: 1000,
                refund_eligible: true,
                receipt_window_hours: 24,
                min_purchase_krw: 0,
              },
              refund: null,
              latestVisitConfirmation: null,
              visitConfirmations: [],
              eligibleForPinReveal: true,
            },
          },
        }),
      });
    });

    await custPage.route(`**/api/v1/access/${sessPinId}/reveal-pin`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          pin: "0000*",
          codeVersion: 1,
          expiresAt: "2099-01-01T00:00:00Z",
          requestId: "req-pin-v2",
        }),
      });
    });

    await custPage.route(`**/my/access/${sessStaffId}/data`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            detail: {
              session: {
                id: sessStaffId,
                user_id: "usr-cust-1",
                restroom_id: mockPartnerItem.id,
                policy_id: "pol-1",
                status: "authorized",
                access_method_snapshot: "ask_staff",
                authorized_at: "2026-11-21T10:00:00Z",
                code_revealed_at: null,
                expires_at: "2099-01-01T00:00:00Z",
                created_at: "2026-11-21T10:00:00Z",
                updated_at: "2026-11-21T10:00:00Z",
              },
              effectiveStatus: "authorized",
              restroom: {
                id: mockPartnerItem.id,
                name: "DEMO/TEST 직원확인 화장실",
                road_address: mockPartnerItem.road_address,
                address_detail: "1층",
                floor: "1F",
                entrance_instructions: "카운터 문의",
                access_method: "ask_staff",
                publication_status: "published",
                business_id: mockPartnerItem.business_id,
                business_name: mockPartnerItem.business_name,
                business_category: "카페",
                business_phone: "031-000-0000",
              },
              order: {
                id: "ord-2",
                access_session_id: sessStaffId,
                user_id: "usr-cust-1",
                order_id: "hm_ord_staff_002",
                provider: "toss",
                payment_mode: "test",
                amount_krw: 1000,
                status: "approved",
                approved_at: "2026-11-21T10:00:00Z",
                failure_code: null,
                created_at: "2026-11-21T10:00:00Z",
                updated_at: "2026-11-21T10:00:00Z",
              },
              policy: null,
              refund: null,
              latestVisitConfirmation: null,
              visitConfirmations: [],
              eligibleForPinReveal: false,
            },
          },
        }),
      });
    });

    await custPage.route("**/my/receipts/data", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            receipts: [
              {
                id: receiptId,
                accessSessionId: sessPinId,
                userId: "usr-cust-1",
                storagePath: "receipts/usr-cust-1/demo.png",
                mimeType: "image/png",
                fileSizeBytes: 12000,
                originalFilename: "internal_raw_receipt_filename.png",
                submissionStatus: "submitted",
                storeNameConfirmed: null,
                purchaseAtConfirmed: null,
                purchaseAmountKrw: null,
                reviewReason: null,
                reviewedAt: null,
                createdAt: "2026-11-21T11:00:00Z",
                restroomName: mockPartnerItem.name,
                partnerName: mockPartnerItem.business_name,
                roadAddress: mockPartnerItem.road_address,
                depositAmountKrw: 1000,
                refundStatus: "none",
                refundAmountKrw: null,
                refundCompletedAt: null,
              },
            ],
            eligibleSessions: [
              {
                accessSessionId: sessPinId,
                restroomId: mockPartnerItem.id,
                restroomName: mockPartnerItem.name,
                partnerName: mockPartnerItem.business_name,
                roadAddress: mockPartnerItem.road_address,
                depositAmountKrw: 1000,
                authorizedAt: "2026-11-21T10:00:00Z",
                expiresAt: "2099-01-01T00:00:00Z",
                receiptWindowHours: 24,
                receiptWindowDeadline: "2099-01-01T00:00:00Z",
                isWindowExpired: false,
                hasPendingReceipt: false,
                hasApprovedReceipt: false,
              },
            ],
          },
        }),
      });
    });

    await custPage.route(`**/api/v1/receipts/${receiptId}/image`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          signedUrl: DEMO_PNG_DATA_URL,
          expiresIn: 300,
        }),
      });
    });

    // Access detail PIN
    await custPage.goto(`${BASE_URL}/my/access/${sessPinId}`, { waitUntil: "networkidle" });
    await custPage.waitForSelector('[data-testid="access-detail-client"]');
    await assertNoOverflow(custPage, "access-detail-360", 360);
    await custPage.screenshot({ path: path.join(SCREENSHOT_DIR, "02_access_detail_360.png"), fullPage: true });

    await custPage.click('[data-testid="reveal-pin-btn"]');
    await custPage.waitForSelector('[data-testid="revealed-pin-value"]');
    await custPage.screenshot({ path: path.join(SCREENSHOT_DIR, "03_access_detail_pin_revealed_360.png"), fullPage: true });

    if (MODE === "after") {
      const accessText = await custPage.innerText("body");
      if (
        accessText.includes("hm_ord_secret_internal_001") ||
        accessText.includes("결제 후 자격 상태") ||
        accessText.includes("최초 PIN 열람 시각")
      ) {
        throw new Error("[UI-12] Technical details should be removed from customer access detail");
      }
      const hideBtnLabel = await custPage.getAttribute('[data-testid="hide-pin-btn"]', "aria-label");
      const hideBtnText = (await custPage.textContent('[data-testid="hide-pin-btn"]'))?.trim() || "";
      if (!hideBtnLabel || hideBtnText.includes("PIN 숨기기")) {
        throw new Error(`[UI-12] Expected icon-only hide PIN button with aria-label, got text="${hideBtnText}"`);
      }
      console.log("  ✓ [UI-12] Access detail cleaned & compact eye-off hide PIN button verified");
    }

    // Access detail ask_staff (UI-09 & UI-12)
    await custPage.goto(`${BASE_URL}/my/access/${sessStaffId}`, { waitUntil: "networkidle" });
    await custPage.waitForSelector('[data-testid="staff-presentation-panel"]');
    await assertNoOverflow(custPage, "access-staff-360", 360);
    await custPage.screenshot({ path: path.join(SCREENSHOT_DIR, "02b_access_staff_360.png"), fullPage: true });
    if (MODE === "after") {
      const staffText = await custPage.innerText('[data-testid="staff-presentation-panel"]');
      if (staffText.includes("도어락") || staffText.includes("PIN")) {
        throw new Error("[UI-09/12] Ask-staff panel must NOT contain '도어락' or 'PIN'");
      }
      console.log("  ✓ [UI-09/12] Ask-staff ticket copy is concise and PIN-free");
    }

    // Receipts (UI-11)
    await custPage.goto(`${BASE_URL}/my/receipts?accessSessionId=${sessPinId}`, { waitUntil: "networkidle" });
    await custPage.waitForSelector('[data-testid="receipt-list-client"]');
    await assertNoOverflow(custPage, "receipts-upload-360", 360);
    await custPage.screenshot({ path: path.join(SCREENSHOT_DIR, "05_receipts_upload_360.png"), fullPage: true });

    await custPage.click('[data-testid="tab-submitted-receipts"]');
    await custPage.waitForSelector('[data-testid="customer-receipt-card"]');
    await custPage.screenshot({ path: path.join(SCREENSHOT_DIR, "05b_receipts_submitted_360.png"), fullPage: true });

    await custCtx.close();

    // =========================================================================
    // 3. Merchant context (360px): UI-10 Businesses + UI-14 New Restroom + UI-15 Detail Manage
    // =========================================================================
    const merchCtx = await browser.newContext({ viewport: { width: 360, height: 740 } });
    await merchCtx.addCookies([
      { name: "e2e_mock_customer", value: "1", domain: "127.0.0.1", path: "/" },
      { name: "e2e_mock_merchant", value: "1", domain: "127.0.0.1", path: "/" },
    ]);
    const merchPage = await merchCtx.newPage();

    const approvedBizId = "c3333333-3333-4333-8333-333333333333";
    const restroomEditId = "d4444444-4444-4444-8444-444444444444";

    await merchPage.route("**/api/v1/merchant/businesses", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, businesses: [], count: 0 }),
      });
    });

    await merchPage.goto(`${BASE_URL}/merchant/businesses`, { waitUntil: "networkidle" });
    await merchPage.waitForSelector('[data-testid="businesses-list-empty"]');
    await assertNoOverflow(merchPage, "merchant-businesses-empty-360", 360);
    await merchPage.screenshot({ path: path.join(SCREENSHOT_DIR, "04_merchant_businesses_empty_360.png"), fullPage: true });

    // Now mock approved business for UI-14 New Restroom
    await merchPage.unroute("**/api/v1/merchant/businesses");
    await merchPage.route("**/api/v1/merchant/businesses", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          businesses: [
            {
              id: approvedBizId,
              name: "DEMO/TEST 행궁카페",
              category: "카페/디저트",
              road_address: "경기도 수원시 팔달구 화서문로 42",
              registration_status: "approved",
              role: "owner",
              created_at: "2026-11-20T00:00:00Z",
              updated_at: "2026-11-20T00:00:00Z",
            },
          ],
          count: 1,
        }),
      });
    });
    await merchPage.route(`**/api/v1/merchant/businesses/${approvedBizId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          business: {
            id: approvedBizId,
            name: "DEMO/TEST 행궁카페",
            category: "카페/디저트",
            road_address: "경기도 수원시 팔달구 화서문로 42",
            address_detail: "1층 전체",
            latitude: 37.2845,
            longitude: 127.0155,
            registration_status: "approved",
          },
        }),
      });
    });

    await merchPage.goto(`${BASE_URL}/merchant/restrooms/new`, { waitUntil: "networkidle" });
    await merchPage.waitForSelector('#restroom-name');
    await assertNoOverflow(merchPage, "merchant-restroom-new-360", 360);
    await merchPage.screenshot({ path: path.join(SCREENSHOT_DIR, "07_merchant_restroom_new_360.png"), fullPage: true });

    if (MODE === "after") {
      const prefilledName = await merchPage.inputValue('#restroom-name');
      if (!prefilledName.includes("DEMO/TEST 행궁카페 화장실")) {
        throw new Error(`[UI-14] Expected auto-prefilled restroom name, got: ${prefilledName}`);
      }
      await merchPage.waitForSelector('[data-testid="restroom-form-submit-review-button"]');

      // Interactive UI-14 test: select PIN access method, verify PIN failure stops submit, then retry succeeds idempotently
      const apiSequence = [];
      let failPinOnce = true;
      await merchPage.route("**/api/v1/merchant/restrooms", async (route) => {
        if (route.request().method() === "POST") {
          apiSequence.push("POST /restrooms");
          return route.fulfill({
            status: 201,
            contentType: "application/json",
            body: JSON.stringify({
              ok: true,
              data: { id: restroomEditId, publication_status: "draft" },
            }),
          });
        }
        return route.fallback();
      });
      await merchPage.route(`**/api/v1/merchant/restrooms/${restroomEditId}`, async (route) => {
        if (route.request().method() === "PATCH") {
          apiSequence.push("PATCH /restrooms/:id");
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              ok: true,
              data: { id: restroomEditId, publication_status: "draft" },
            }),
          });
        }
        return route.fallback();
      });
      await merchPage.route(`**/api/v1/merchant/restrooms/${restroomEditId}/pin`, async (route) => {
        if (route.request().method() === "POST") {
          if (failPinOnce) {
            failPinOnce = false;
            apiSequence.push("POST /pin (400)");
            return route.fulfill({
              status: 400,
              contentType: "application/json",
              body: JSON.stringify({ ok: false, error: { message: "PIN 형식 오류 시뮬레이션" } }),
            });
          }
          apiSequence.push("POST /pin (201)");
          return route.fulfill({
            status: 201,
            contentType: "application/json",
            body: JSON.stringify({
              ok: true,
              pinStatus: { hasActivePin: true, codeVersion: 1, encryptionConfigured: true },
            }),
          });
        }
        return route.fallback();
      });
      await merchPage.route(`**/api/v1/merchant/restrooms/${restroomEditId}/submit`, async (route) => {
        if (route.request().method() === "POST") {
          apiSequence.push("POST /submit");
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true, data: { id: restroomEditId, publication_status: "pending" } }),
          });
        }
        return route.fallback();
      });

      await merchPage.selectOption("#restroom-access-method", "pin");
      await merchPage.waitForSelector('[data-testid="restroom-initial-pin-section"]');
      await merchPage.fill('[data-testid="restroom-initial-pin-input"]', "1357");
      await merchPage.fill('[data-testid="restroom-initial-pin-confirm-input"]', "1357");
      await merchPage.click('[data-testid="restroom-form-submit-review-button"]');
      await merchPage.waitForSelector('[data-testid="restroom-form-error"]');
      if (apiSequence.includes("POST /submit")) {
        throw new Error("[UI-14] /submit must NOT be called when PIN saving fails!");
      }
      // Retry without creating a duplicate POST /restrooms
      await merchPage.click('[data-testid="restroom-form-submit-review-button"]');
      await merchPage.waitForURL(`**/merchant/restrooms/${restroomEditId}**`, { timeout: 10000 });
      if (
        !apiSequence.includes("PATCH /restrooms/:id") ||
        !apiSequence.includes("POST /pin (201)") ||
        !apiSequence.includes("POST /submit")
      ) {
        throw new Error(`[UI-14] Expected idempotent PATCH -> POST /pin -> POST /submit, got: ${apiSequence.join(" -> ")}`);
      }
      console.log(`  ✓ [UI-14] Multi-step submit & PIN failure guard verified: ${apiSequence.join(" -> ")}`);
    }

    // UI-15 Restroom Detail Management
    await merchPage.unroute(`**/api/v1/merchant/restrooms/${restroomEditId}`).catch(() => {});
    await merchPage.route(`**/api/v1/merchant/restrooms/${restroomEditId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            id: restroomEditId,
            business_id: approvedBizId,
            businessId: approvedBizId,
            type: "partner",
            name: "DEMO/TEST 행궁카페 화장실",
            description: "카운터 왼쪽",
            road_address: "경기도 수원시 팔달구 화서문로 42",
            address_detail: "1층",
            latitude: 37.2845,
            longitude: 127.0155,
            floor: "1층",
            entrance_instructions: "왼쪽 복도",
            gender_type: "separate",
            wheelchair_accessible: true,
            baby_changing_available: false,
            sanitary_products_available: false,
            access_method: "pin",
            publication_status: "pending",
            created_at: "2026-11-20T00:00:00Z",
            updated_at: "2026-11-20T00:00:00Z",
            policies: [
              {
                id: "pol-1",
                restroom_id: restroomEditId,
                version: 1,
                access_mode: "test_deposit",
                deposit_amount_krw: 1000,
                refund_eligible: true,
                receipt_window_hours: 24,
                min_purchase_krw: 0,
                is_active: true,
                effective_from: "2026-11-20T00:00:00Z",
                created_at: "2026-11-20T00:00:00Z",
              },
            ],
            hours: [],
            photos: [],
            pinStatus: {
              hasActivePin: true,
              codeVersion: 1,
              updatedAt: "2026-11-20T00:00:00Z",
              encryptionConfigured: true,
            },
          },
        }),
      });
    });

    await merchPage.goto(`${BASE_URL}/merchant/restrooms/${restroomEditId}`, { waitUntil: "networkidle" });
    await merchPage.waitForSelector('[data-testid="restroom-detail-container"]');
    await assertNoOverflow(merchPage, "merchant-restroom-detail-360", 360);
    await merchPage.screenshot({ path: path.join(SCREENSHOT_DIR, "08_merchant_restroom_detail_360.png"), fullPage: true });
    if (MODE === "after") {
      const hiddenPolicy = await merchPage.$('[data-testid="restroom-policy-manager"]');
      if (hiddenPolicy) {
        throw new Error("[UI-15] Management panels should be collapsed by default");
      }
      await merchPage.click('[data-testid="toggle-manage-policy-btn"]');
      await merchPage.waitForSelector('[data-testid="restroom-policy-manager"]');
      await merchPage.click('input[name="change_policy_mode"][value="deposit_with_ad"]');
      await merchPage.waitForSelector('[data-testid="policy-identical-notice"]');
      const disabledSame = await merchPage.isDisabled('[data-testid="create-policy-button"]');
      if (!disabledSame) {
        throw new Error("[UI-15] Identical policy submit button must be disabled");
      }
      await merchPage.click('[data-testid="toggle-manage-pin-btn"]');
      await merchPage.waitForSelector('[data-testid="restroom-pin-manager"]');
      console.log("  ✓ [UI-15] Collapsed sections, toggle buttons, and identical-policy guard verified");
    }
    await merchCtx.close();

    // =========================================================================
    // 4. Admin context (360px & 1280px): UI-13 Receipts + UI-16 Admin Menu & Service Analytics
    // =========================================================================
    const adminCtx = await browser.newContext({ viewport: { width: 360, height: 740 } });
    await adminCtx.addCookies([
      { name: "e2e_mock_admin", value: "1", domain: "127.0.0.1", path: "/" },
    ]);
    const adminPage = await adminCtx.newPage();

    const adminReceiptId = "44444444-4444-4444-8444-444444444444";
    await adminPage.route("**/api/v1/admin/receipts?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          items: [
            {
              id: adminReceiptId,
              accessSessionId: sessPinId,
              userId: "usr-cust-1",
              storagePath: "receipts/usr-cust-1/demo.png",
              mimeType: "image/png",
              fileSizeBytes: 24500,
              originalFilename: "demo_coffee_receipt.png",
              submissionStatus: "submitted",
              storeNameConfirmed: null,
              purchaseAtConfirmed: null,
              purchaseAmountKrw: null,
              receiptReference: null,
              reviewedAt: null,
              reviewReason: null,
              createdAt: "2026-11-21T11:00:00Z",
              updatedAt: "2026-11-21T11:00:00Z",
              restroomName: mockPartnerItem.name,
              businessId: approvedBizId,
              businessName: "DEMO/TEST 행궁카페",
              businessRoadAddress: "경기도 수원시 팔달구 화서문로 42",
              userDisplayName: "테스트고객",
              accessAuthorizedAt: "2026-11-21T10:00:00Z",
              accessExpiresAt: "2026-11-22T10:00:00Z",
              accessStatus: "authorized",
              policyVersion: 1,
              depositAmountKrw: 1000,
              receiptWindowHours: 24,
              receiptWindowDeadline: "2026-11-22T10:00:00Z",
              minPurchaseKrw: 3000,
              paymentOrderId: "po-admin-1",
              paymentOrderNumber: "HM_ORD_ADMIN_1",
              paymentAmountKrw: 1000,
              paymentStatus: "approved",
              paymentMode: "test",
              paymentApprovedAt: "2026-11-21T10:00:00Z",
              refundStatus: "none",
              refundAmountKrw: null,
              refundRequestedAt: null,
              refundCompletedAt: null,
            },
          ],
          pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
        }),
      });
    });

    await adminPage.route(`**/api/v1/admin/receipts/${adminReceiptId}/image`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          signedUrl: DEMO_PNG_DATA_URL,
          expiresIn: 900,
          storagePath: "receipts/usr-cust-1/demo.png",
          receiptId: adminReceiptId,
        }),
      });
    });

    await adminPage.goto(`${BASE_URL}/admin/receipts`, { waitUntil: "networkidle" });
    await adminPage.waitForSelector(`[data-testid="inspect-receipt-${adminReceiptId}"]`);
    await adminPage.click(`[data-testid="inspect-receipt-${adminReceiptId}"]`);
    await adminPage.waitForSelector('[data-testid="admin-receipt-detail-view"]');
    await assertNoOverflow(adminPage, "admin-receipt-detail-360", 360);
    await adminPage.screenshot({ path: path.join(SCREENSHOT_DIR, "06_admin_receipts_detail_360.png"), fullPage: true });

    // Admin Dashboard (UI-16)
    await adminPage.goto(`${BASE_URL}/admin`, { waitUntil: "networkidle" });
    await adminPage.waitForSelector('[data-testid="admin-dashboard-page"]');
    await assertNoOverflow(adminPage, "admin-home-360", 360);
    await adminPage.screenshot({ path: path.join(SCREENSHOT_DIR, "09_admin_home_360.png"), fullPage: true });
    if (MODE === "after") {
      const leadsCard = await adminPage.$('[data-testid="admin-card-leads"]');
      if (leadsCard) {
        throw new Error("[UI-16] admin-card-leads must be removed from /admin menu");
      }
      console.log("  ✓ [UI-16] /admin removed leads card cleanly");
    }

    // Admin Service Analytics (UI-16)
    await adminPage.route("**/api/v1/admin/analytics/pmf?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            experiment: {
              experimentKey: "pmf_r1",
              name: "서비스 이용 현황",
              rulesVersion: "2026-11-04_agreed_metrics",
              startsAt: "2026-11-08T00:00:00.000Z",
              endsAt: "2026-11-22T14:59:59.999Z",
              status: "running",
              rulesComplete: false,
              provisionalNotice: "운영 집계 데이터",
            },
            observationWindow: {
              startsAt: "2026-11-08T00:00:00.000Z",
              endsAt: "2026-11-22T14:59:59.999Z",
              isOngoing: true,
            },
            summary: {
              totalEvents: 42,
              distinctBrowsers: 12,
              distinctSessions: 15,
              excludedTestEvents: 5,
              excludedTestSessions: 2,
            },
            hypotheses: {
              h1: { hypothesisKey: "H1", name: "H1", definition: "", denominatorCount: 0, targetDenominator: 50, numeratorCount: 0, targetNumerator: 5, conversionRatePercent: 0, isTargetMet: false, isSufficientData: false, status: "insufficient_data" },
              h2: { hypothesisKey: "H2", name: "H2", definition: "", denominatorCount: 0, targetDenominator: 50, numeratorCount: 0, targetNumerator: 5, conversionRatePercent: 0, isTargetMet: false, isSufficientData: false, status: "insufficient_data", excludedOrganicCount: 0, excludedNonTravelingCount: 0 },
              h5: { hypothesisKey: "H5", name: "H5", definition: "", denominatorCount: 5, targetDenominator: 50, numeratorCount: 2, targetNumerator: 5, conversionRatePercent: 40, isTargetMet: false, isSufficientData: false, status: "insufficient_data", excludedPublicDirectionsCount: 4, excludedMismatchedPartnerDirectionsCount: 0 },
            },
            eventBreakdown: [
              { eventName: "map_loaded", rawEventCount: 15, distinctBrowserCount: 12 },
              { eventName: "restroom_card_viewed", rawEventCount: 11, distinctBrowserCount: 8 },
              { eventName: "restroom_detail_opened", rawEventCount: 9, distinctBrowserCount: 7 },
              { eventName: "directions_clicked", rawEventCount: 7, distinctBrowserCount: 5 },
            ],
            serviceMetrics: {
              dateRange: { startsAt: "2026-11-08T00:00:00.000Z", endsAt: "2026-11-22T14:59:59.999Z" },
              overview: {
                visitingBrowsers: 12,
                mapViews: 15,
                cardClicks: 11,
                detailViews: 9,
                directionsClicks: 7,
                approvedPayments: 3,
                issuedTickets: 3,
                submittedReceipts: 2,
                approvedReceipts: 1,
                refundsSucceeded: 1,
              },
              byRestroomType: {
                public: { cardClicks: 6, detailViews: 5, directionsClicks: 4 },
                partner: { cardClicks: 5, detailViews: 4, directionsClicks: 3 },
              },
              dailyTrend: [
                {
                  date: "2026-11-20",
                  visitingBrowsers: 5,
                  mapViews: 6,
                  cardClicks: 4,
                  detailViews: 3,
                  directionsClicks: 2,
                  approvedPayments: 1,
                  submittedReceipts: 1,
                  refundsSucceeded: 0,
                },
                {
                  date: "2026-11-21",
                  visitingBrowsers: 7,
                  mapViews: 9,
                  cardClicks: 7,
                  detailViews: 6,
                  directionsClicks: 5,
                  approvedPayments: 2,
                  submittedReceipts: 1,
                  refundsSucceeded: 1,
                },
              ],
              analyticsConfig: {
                nextPublicAnalyticsEnabledEnv: "false",
                actuallyGatedByEnv: false,
                trackedClientEvents: ["map_loaded", "restroom_marker_clicked", "restroom_card_viewed", "restroom_detail_opened", "directions_clicked", "payment_button_clicked"],
                trackedServerEvents: ["payment_order_created", "payment_confirmed", "access_authorized"],
                untrackedEvents: ["login", "pin_reveal_ui_event", "receipt_upload_ui_event"],
              },
            },
            generatedAt: new Date().toISOString(),
          },
        }),
      });
    });

    await adminPage.goto(`${BASE_URL}/admin/analytics/pmf`, { waitUntil: "networkidle" });
    await adminPage.waitForSelector('[data-testid="pmf-dashboard-container"]');
    await assertNoOverflow(adminPage, "admin-analytics-360", 360);
    await adminPage.screenshot({ path: path.join(SCREENSHOT_DIR, "10b_admin_analytics_360.png"), fullPage: true });

    await adminPage.setViewportSize({ width: 1280, height: 800 });
    await assertNoOverflow(adminPage, "admin-analytics-desktop", 1280);
    await adminPage.screenshot({ path: path.join(SCREENSHOT_DIR, "10_admin_analytics_desktop.png"), fullPage: true });

    await adminCtx.close();
    console.log(`\n✅ verify_ui_ux_v2 (${MODE}) completed! Screenshots in ${SCREENSHOT_DIR}`);
  } finally {
    if (browser) await browser.close();
    if (server) killProcessTree(server.pid);
  }
}

run().catch((err) => {
  console.error("❌ verify_ui_ux_v2 failed:", err);
  process.exit(1);
});
